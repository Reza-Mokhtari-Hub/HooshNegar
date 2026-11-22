import { and, inArray, lt } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import { generationJobs, storedFiles } from '../../db/schema.ts';
import { getStorageAdapter } from '../storage/storageAdapter.ts';
import { refundFailedRequest } from './usageService.ts';
import {
  runSubscriptionExpirationSweep,
  runUpcomingRenewalReminders,
} from './subscriptionService.ts';

export interface MaintenanceRunSummary {
  expiredSubscriptions: number;
  expirationNotificationsSent: number;
  renewalRemindersSent: number;
  cleanedExpiredFiles: number;
  recoveredStaleJobs: number;
  executedAt: string;
}

/**
 * Idempotent scheduled maintenance runner invoked by Vercel Cron, Upstash QStash,
 * or manually by a super_admin from the System Settings page.
 */
export async function runScheduledMaintenance(nowOverride?: Date): Promise<MaintenanceRunSummary> {
  const now = nowOverride ?? new Date();
  const db = getDb();

  // 1. Expire overdue subscriptions & notify users
  const exp = await runSubscriptionExpirationSweep(now);

  // 2. Send deduplicated upcoming renewal reminders (<= 3 days)
  const rem = await runUpcomingRenewalReminders(now);

  // 3. Clean up expired stored files
  let cleanedExpiredFiles = 0;
  try {
    const expiredRows = await db
      .select({ id: storedFiles.id, objectKey: storedFiles.objectKey })
      .from(storedFiles)
      .where(and(lt(storedFiles.expiresAt, now)));

    if (expiredRows.length > 0) {
      const storage = getStorageAdapter();
      cleanedExpiredFiles = await storage.cleanupExpiredFiles();
    }
  } catch {
    cleanedExpiredFiles = 0;
  }

  // 4. Recover stale queued/running AI jobs older than 15 minutes and refund reserved credits
  const staleThreshold = new Date(now.getTime() - 15 * 60 * 1000);
  const staleJobs = await db
    .select({ id: generationJobs.id, requestId: generationJobs.requestId })
    .from(generationJobs)
    .where(
      and(
        inArray(generationJobs.status, ['queued', 'running']),
        lt(generationJobs.updatedAt, staleThreshold),
      ),
    );

  let recoveredStaleJobs = 0;
  for (const job of staleJobs) {
    await refundFailedRequest({
      requestId: job.requestId,
      jobId: job.id,
      errorCode: 'STALE_JOB_TIMEOUT',
      errorMessage: 'Job exceeded maximum processing time and reserved credits were refunded.',
    });
    recoveredStaleJobs += 1;
  }

  return {
    expiredSubscriptions: exp.expiredCount,
    expirationNotificationsSent: exp.notifiedCount,
    renewalRemindersSent: rem.remindedCount,
    cleanedExpiredFiles,
    recoveredStaleJobs,
    executedAt: now.toISOString(),
  };
}
