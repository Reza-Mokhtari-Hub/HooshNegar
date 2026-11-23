import { Router, type Response } from 'express';
import { z } from 'zod';
import {
  getClientIp,
  requireAdminAuth,
  requireRole,
  type AdminRequest,
} from '../middleware/auth.ts';
import {
  executeAdminCopilotAction,
  getAdminCopilotContext,
  runAdminCopilotChat,
  type CopilotWriteToolName,
} from '../services/aiAdminCopilotService.ts';

const copilotChatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(6000),
      }),
    )
    .min(1)
    .max(20),
  modelId: z.string().uuid().optional(),
  autoExecute: z.boolean().optional().default(false),
});

const copilotExecuteSchema = z.object({
  actionId: z.string().min(1).max(120),
  tool: z.enum([
    'update_plan',
    'update_model',
    'bulk_update_models',
    'prune_broken_models',
    'adjust_user_credits',
    'recover_stuck_jobs',
    'create_coupon',
    'update_bot_messages',
  ]),
  args: z.record(z.string(), z.unknown()).default({}),
});

export function createAiManagerRouter(): Router {
  const router = Router();
  router.use(requireAdminAuth);

  router.get('/ai-manager/context', async (_req: AdminRequest, res: Response) => {
    try {
      const ctx = await getAdminCopilotContext();
      res.json(ctx);
    } catch (err) {
      console.error('[ai-manager/context]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت وضعیت دستیار هوشمند مدیریت.' });
    }
  });

  router.post(
    '/ai-manager/chat',
    requireRole('operator'),
    async (req: AdminRequest, res: Response) => {
      try {
        const parsed = copilotChatSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: parsed.error.issues[0]?.message ?? 'ورودی گفتگوی دستیار هوشمند نامعتبر است.',
          });
          return;
        }

        const result = await runAdminCopilotChat({
          actor: {
            id: req.admin!.id,
            email: req.admin!.email,
            role: req.admin!.role,
            ipAddress: getClientIp(req),
            userAgent: req.headers['user-agent'] ?? '',
          },
          messages: parsed.data.messages,
          modelId: parsed.data.modelId,
          autoExecute: parsed.data.autoExecute,
        });

        res.json(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        console.error('[ai-manager/chat]', msg);
        res.status(502).json({
          error: `مدل انتخاب‌شده در اجرای دستیار هوشمند پاسخ نداد. می‌توانید مدل دیگری از منوی بالا انتخاب کنید. (${msg.slice(0, 120)})`,
        });
      }
    },
  );

  router.post(
    '/ai-manager/execute-action',
    requireRole('operator'),
    async (req: AdminRequest, res: Response) => {
      try {
        const parsed = copilotExecuteSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: parsed.error.issues[0]?.message ?? 'اطلاعات عملیات درخواستی نامعتبر است.',
          });
          return;
        }

        const result = await executeAdminCopilotAction({
          actor: {
            id: req.admin!.id,
            email: req.admin!.email,
            role: req.admin!.role,
            ipAddress: getClientIp(req),
            userAgent: req.headers['user-agent'] ?? '',
          },
          actionId: parsed.data.actionId,
          tool: parsed.data.tool as CopilotWriteToolName,
          args: parsed.data.args,
        });

        res.status(result.ok ? 200 : 400).json({ result });
      } catch (err) {
        console.error('[ai-manager/execute]', err instanceof Error ? err.message : 'unknown');
        res.status(500).json({ error: 'خطا در اجرای عملیات دستیار هوشمند.' });
      }
    },
  );

  return router;
}
