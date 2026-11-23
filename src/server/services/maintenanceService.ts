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
 * Automatically recovers orphaned/stuck queued or running jobs (for example when a slow external
 * ZeroGPU Space exceeds runtime limits) and atomically refunds reserved credits.
 */
export async function reapStaleRunningJobs(options?: {
  nowOverride?: Date;
  maxAgeMs?: number;
  videoMaxAgeMs?: number;
}): Promise<number> {
  const now = options?.nowOverride ?? new Date();
  const maxAgeMs = options?.maxAgeMs ?? 3 * 60 * 1000; // 3 minutes for non-video jobs
  const videoMaxAgeMs = options?.videoMaxAgeMs ?? 15 * 60 * 1000; // 15 minutes for async video jobs
  const db = getDb();

  const oldestCheckThreshold = new Date(now.getTime() - Math.min(maxAgeMs, videoMaxAgeMs));
  const candidates = await db
    .select({
      id: generationJobs.id,
      requestId: generationJobs.requestId,
      capability: generationJobs.capability,
      updatedAt: generationJobs.updatedAt,
    })
    .from(generationJobs)
    .where(
      and(
        inArray(generationJobs.status, ['queued', 'running']),
        lt(generationJobs.updatedAt, oldestCheckThreshold),
      ),
    );

  let recovered = 0;
  for (const job of candidates) {
    const limitMs = job.capability === 'video_generation' ? videoMaxAgeMs : maxAgeMs;
    const ageMs = now.getTime() - new Date(job.updatedAt).getTime();
    if (ageMs < limitMs) continue;

    await refundFailedRequest({
      requestId: job.requestId,
      jobId: job.id,
      errorCode: 'STALE_JOB_TIMEOUT',
      errorMessage: 'Job exceeded maximum processing time and reserved credits were refunded.',
    });
    recovered += 1;
  }

  return recovered;
}

/**
 * Idempotent scheduled maintenance runner invoked by Cloudflare Workers Cron Triggers,
 * Upstash QStash, or manually by a super_admin from the System Settings page.
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

  // 4. Recover stale queued/running AI jobs and refund reserved credits
  const recoveredStaleJobs = await reapStaleRunningJobs({ nowOverride: now });

  return {
    expiredSubscriptions: exp.expiredCount,
    expirationNotificationsSent: exp.notifiedCount,
    renewalRemindersSent: rem.remindedCount,
    cleanedExpiredFiles,
    recoveredStaleJobs,
    executedAt: now.toISOString(),
  };
}
