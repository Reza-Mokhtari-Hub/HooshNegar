import { getDb } from '../../db/index.ts';
import { auditLogs } from '../../db/schema.ts';
import { sanitizeAuditDetails } from './crypto.ts';

export interface AuditEventInput {
  adminUserId?: string | null;
  actorEmail?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  severity?: 'info' | 'warning' | 'critical';
  status?: 'success' | 'failure' | 'denied';
  ipAddress?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown>;
  extraSecretsToRedact?: string[];
}

export async function recordAuditLog(input: AuditEventInput): Promise<void> {
  try {
    const db = getDb();
    await db.insert(auditLogs).values({
      adminUserId: input.adminUserId ?? null,
      actorEmail: input.actorEmail ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      severity: input.severity ?? 'info',
      status: input.status ?? 'success',
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ? input.userAgent.slice(0, 500) : null,
      details: sanitizeAuditDetails(input.details ?? {}, input.extraSecretsToRedact ?? []),
    });
  } catch (err) {
    console.error('[audit] Failed to persist audit log:', err instanceof Error ? err.message : 'unknown');
  }
}
