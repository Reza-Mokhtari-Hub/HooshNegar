import { Router, type Response } from 'express';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import {
  notificationLogs,
  notificationTemplates,
  payments,
  supportTickets,
  telegramAccounts,
  userProfiles,
} from '../../db/schema.ts';
import {
  notificationTemplateUpdateSchema,
  supportReplySchema,
  supportTicketUpdateSchema,
} from '../../shared/validation.ts';
import { recordAuditLog } from '../security/audit.ts';
import {
  getClientIp,
  requireAdminAuth,
  requireRole,
  type AdminRequest,
} from '../middleware/auth.ts';
import { sendDirectTelegramMessage } from '../services/notificationService.ts';
import { runScheduledMaintenance } from '../services/maintenanceService.ts';

export function createSupportNotificationRouter(): Router {
  const router = Router();
  router.use(requireAdminAuth);

  // =========================================================================
  // 1. CUSTOMER SUPPORT TICKETS
  // =========================================================================
  router.get('/support/tickets', async (req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const q = req.query as Record<string, unknown>;
      const conds: SQL[] = [];
      if (typeof q.status === 'string' && q.status.trim() && q.status !== 'all') {
        conds.push(eq(supportTickets.status, q.status as typeof supportTickets.$inferSelect.status));
      }
      if (typeof q.category === 'string' && q.category.trim() && q.category !== 'all') {
        conds.push(eq(supportTickets.category, q.category.trim()));
      }

      const rows = await db
        .select({
          id: supportTickets.id,
          userId: supportTickets.userId,
          userDisplayName: userProfiles.displayName,
          telegramUsername: telegramAccounts.username,
          telegramChatId: telegramAccounts.telegramChatId,
          category: supportTickets.category,
          relatedPaymentId: supportTickets.relatedPaymentId,
          relatedOrderNumber: payments.orderNumber,
          relatedRequestId: supportTickets.relatedRequestId,
          subject: supportTickets.subject,
          message: supportTickets.message,
          adminReply: supportTickets.adminReply,
          repliedAt: supportTickets.repliedAt,
          status: supportTickets.status,
          priority: supportTickets.priority,
          resolvedAt: supportTickets.resolvedAt,
          createdAt: supportTickets.createdAt,
          updatedAt: supportTickets.updatedAt,
        })
        .from(supportTickets)
        .leftJoin(userProfiles, eq(userProfiles.userId, supportTickets.userId))
        .leftJoin(telegramAccounts, eq(telegramAccounts.userId, supportTickets.userId))
        .leftJoin(payments, eq(supportTickets.relatedPaymentId, payments.id))
        .where(conds.length > 0 ? and(...conds) : undefined)
        .orderBy(desc(supportTickets.createdAt))
        .limit(150);

      res.json({ tickets: rows });
    } catch (err) {
      console.error('[support/tickets]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت تیکت‌های پشتیبانی.' });
    }
  });

  router.post(
    '/support/tickets/:id/reply',
    requireRole('operator'),
    async (req: AdminRequest, res: Response) => {
      const id = String(req.params.id ?? '');
      const ip = getClientIp(req);
      const ua = req.headers['user-agent'] ?? '';
      try {
        const parsed = supportReplySchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'متن پاسخ نامعتبر است.' });
          return;
        }
        const db = getDb();
        const now = new Date();
        const [ticket] = await db
          .select()
          .from(supportTickets)
          .where(eq(supportTickets.id, id))
          .limit(1);

        if (!ticket) {
          res.status(404).json({ error: 'تیکت پشتیبانی یافت نشد.' });
          return;
        }

        const [updated] = await db
          .update(supportTickets)
          .set({
            assignedAdminId: req.admin!.id,
            adminReply: parsed.data.reply,
            repliedAt: now,
            status: parsed.data.status,
            resolvedAt: parsed.data.status === 'resolved' || parsed.data.status === 'closed' ? now : null,
            updatedAt: now,
          })
          .where(eq(supportTickets.id, id))
          .returning();

        let telegramNotified = false;
        if (parsed.data.notifyTelegram) {
          const [tgAcc] = await db
            .select({
              telegramChatId: telegramAccounts.telegramChatId,
              telegramUserId: telegramAccounts.telegramUserId,
            })
            .from(telegramAccounts)
            .where(eq(telegramAccounts.userId, ticket.userId))
            .limit(1);

          const chatId = tgAcc?.telegramChatId ?? tgAcc?.telegramUserId;
          if (chatId) {
            telegramNotified = await sendDirectTelegramMessage(
              chatId,
              `📩 پاسخ پشتیبانی به تیکت #${ticket.id.slice(0, 8)}:\n\n${parsed.data.reply}`,
            );
          }
        }

        await recordAuditLog({
          adminUserId: req.admin!.id,
          actorEmail: req.admin!.email,
          action: 'support.ticket_replied',
          resourceType: 'support_ticket',
          resourceId: id,
          ipAddress: ip,
          userAgent: ua,
          details: { status: parsed.data.status, telegramNotified },
        });

        res.json({ ok: true, ticket: updated, telegramNotified });
      } catch {
        res.status(500).json({ error: 'خطا در ارسال پاسخ تیکت.' });
      }
    },
  );

  router.patch(
    '/support/tickets/:id',
    requireRole('operator'),
    async (req: AdminRequest, res: Response) => {
      const id = String(req.params.id ?? '');
      try {
        const parsed = supportTicketUpdateSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'اطلاعات وضعیت تیکت نامعتبر است.' });
          return;
        }
        const db = getDb();
        const now = new Date();
        const [updated] = await db
          .update(supportTickets)
          .set({
            status: parsed.data.status,
            priority: parsed.data.priority,
            resolvedAt:
              parsed.data.status === 'resolved' || parsed.data.status === 'closed' ? now : undefined,
            updatedAt: now,
          })
          .where(eq(supportTickets.id, id))
          .returning();
        if (!updated) {
          res.status(404).json({ error: 'تیکت یافت نشد.' });
          return;
        }
        res.json({ ok: true, ticket: updated });
      } catch {
        res.status(500).json({ error: 'خطا در به‌روزرسانی تیکت.' });
      }
    },
  );

  // =========================================================================
  // 2. CONFIGURABLE NOTIFICATION TEMPLATES & DELIVERY LOGS
  // =========================================================================
  router.get('/notifications/templates', async (_req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const templates = await db
        .select()
        .from(notificationTemplates)
        .orderBy(notificationTemplates.templateKey);
      res.json({ templates });
    } catch {
      res.status(500).json({ error: 'خطا در دریافت قالب‌های اعلان.' });
    }
  });

  router.put(
    '/notifications/templates/:key',
    requireRole('admin'),
    async (req: AdminRequest, res: Response) => {
      const key = String(req.params.key ?? '');
      const ip = getClientIp(req);
      const ua = req.headers['user-agent'] ?? '';
      try {
        const parsed = notificationTemplateUpdateSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'قالب اعلان نامعتبر است.' });
          return;
        }
        const db = getDb();
        const [updated] = await db
          .update(notificationTemplates)
          .set({
            ...parsed.data,
            updatedByAdminId: req.admin!.id,
            updatedAt: new Date(),
          })
          .where(eq(notificationTemplates.templateKey, key))
          .returning();
        if (!updated) {
          res.status(404).json({ error: 'قالب اعلان یافت نشد.' });
          return;
        }
        await recordAuditLog({
          adminUserId: req.admin!.id,
          actorEmail: req.admin!.email,
          action: 'notification.template_updated',
          resourceType: 'notification_template',
          resourceId: updated.id,
          ipAddress: ip,
          userAgent: ua,
          details: { templateKey: key, isEnabled: updated.isEnabled },
        });
        res.json({ ok: true, template: updated });
      } catch {
        res.status(500).json({ error: 'خطا در ذخیره قالب اعلان.' });
      }
    },
  );

  router.get('/notifications/logs', async (_req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const logs = await db
        .select({
          id: notificationLogs.id,
          userId: notificationLogs.userId,
          userDisplayName: userProfiles.displayName,
          templateKey: notificationLogs.templateKey,
          channel: notificationLogs.channel,
          status: notificationLogs.status,
          messageText: notificationLogs.messageText,
          errorMessage: notificationLogs.errorMessage,
          sentAt: notificationLogs.sentAt,
          createdAt: notificationLogs.createdAt,
        })
        .from(notificationLogs)
        .leftJoin(userProfiles, eq(userProfiles.userId, notificationLogs.userId))
        .orderBy(desc(notificationLogs.createdAt))
        .limit(100);
      res.json({ logs });
    } catch {
      res.status(500).json({ error: 'خطا در دریافت تاریخچه اعلان‌ها.' });
    }
  });

  // =========================================================================
  // 3. MANUAL SCHEDULED MAINTENANCE TRIGGER (Admin)
  // =========================================================================
  router.post(
    '/maintenance/run',
    requireRole('admin'),
    async (req: AdminRequest, res: Response) => {
      try {
        const summary = await runScheduledMaintenance();
        await recordAuditLog({
          adminUserId: req.admin!.id,
          actorEmail: req.admin!.email,
          action: 'system.maintenance_sweep',
          resourceType: 'system',
          details: summary as unknown as Record<string, unknown>,
        });
        res.json({ ok: true, summary });
      } catch {
        res.status(500).json({ error: 'خطا در اجرای عملیات نگهداری دوره‌ای.' });
      }
    },
  );

  return router;
}
