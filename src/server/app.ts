import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import { createAuthRouter } from './routes/authRoutes.ts';
import { createProviderRouter } from './routes/providerRoutes.ts';
import { createModelRouter } from './routes/modelRoutes.ts';
import { createPlatformRouter } from './routes/platformRoutes.ts';
import {
  createTelegramWebhookRouter,
  initBackgroundJobProcessor,
  type RawBodyRequest,
} from './routes/telegramWebhookRoutes.ts';
import { createTelegramAdminRouter } from './routes/telegramAdminRoutes.ts';
import { createMiniAppRouter } from './routes/miniAppRoutes.ts';
import { createMonitorRouter } from './routes/monitorRoutes.ts';
import { createBillingRouter } from './routes/billingRoutes.ts';
import { createFinanceRouter } from './routes/financeRoutes.ts';
import { createSupportNotificationRouter } from './routes/supportNotificationRoutes.ts';
import { createAiManagerRouter } from './routes/aiManagerRoutes.ts';
import {
  apiRateLimitMiddleware,
  securityHeadersMiddleware,
} from './middleware/auth.ts';
import { sql } from 'drizzle-orm';
import { ensurePlatformReady } from './services/bootstrap.ts';
import { getEnvValidationSummary } from './config/env.ts';
import {
  buildRuntimeDiagnostics,
  classifyDatabaseError,
  type DbProbeResult,
} from './config/diagnostics.ts';
import { getDb } from '../db/index.ts';
import { redactSecrets } from './security/crypto.ts';

function unwrapErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) {
    return `${err.message} (${cause.message})`;
  }
  if (cause && typeof cause === 'string') {
    return `${err.message} (${cause})`;
  }
  return err.message;
}

async function runLiveDbProbe(): Promise<DbProbeResult> {
  const started = Date.now();
  try {
    const db = getDb();
    await db.execute(sql`SELECT 1`);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1`);
    });
    return {
      ok: true,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    const rawMsg = unwrapErrorMessage(err);
    const { safeError, hint } = classifyDatabaseError(rawMsg);
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: safeError,
      hint,
    };
  }
}

export function createApiApp(): Express {
  const app = express();
  app.set('trust proxy', 1);

  initBackgroundJobProcessor();

  app.use(securityHeadersMiddleware);
  app.use(cookieParser());
  app.use(
    express.json({
      limit: '16mb',
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf.toString('utf8');
      },
    }),
  );
  app.use('/api', apiRateLimitMiddleware);

  // Public health & runtime readiness check (strictly no secrets exposed)
  app.get('/api/health', async (req: Request, res: Response) => {
    const env = getEnvValidationSummary();
    const cfBoundKeys = (globalThis as { _hooshnegarCfBoundKeys?: string[] })._hooshnegarCfBoundKeys;
    const probeRequested = req.query.db === '1' || req.query.probe === '1';
    const dbProbe = probeRequested ? await runLiveDbProbe() : undefined;
    const diagnostics = buildRuntimeDiagnostics({
      boundEnvKeys: cfBoundKeys ?? [],
      dbProbe,
    });

    res.json({
      status: diagnostics.ready ? 'ok' : 'degraded',
      ready: diagnostics.ready,
      phase: 3,
      runtime: env.isCloudflare ? 'cloudflare_workers' : 'nodejs',
      databaseMode: env.databaseMode,
      encryptionConfigured: env.encryptionConfigured,
      qstashConfigured: env.qstashConfigured,
      r2Configured: env.r2Configured,
      aiMockMode: env.aiMockMode,
      ...(env.isCloudflare ? { boundEnvKeys: cfBoundKeys ?? [] } : {}),
      diagnostics,
      timestamp: new Date().toISOString(),
    });
  });

  // Ensure DB migrations & bootstrap have completed before serving DB-backed API routes
  app.use('/api', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await ensurePlatformReady();
      next();
    } catch (err) {
      const rawMsg = unwrapErrorMessage(err);
      const { safeError, hint } = classifyDatabaseError(rawMsg);
      const cfBoundKeys = (globalThis as { _hooshnegarCfBoundKeys?: string[] })._hooshnegarCfBoundKeys;
      const diagnostics = buildRuntimeDiagnostics({
        boundEnvKeys: cfBoundKeys ?? [],
        rawError: rawMsg,
        dbProbe: {
          ok: false,
          latencyMs: 0,
          error: safeError,
          hint,
        },
      });
      console.error('[bootstrap]', safeError);
      res.status(503).json({
        error: hint,
        code: 'DB_UNAVAILABLE',
        diagnostics,
      });
    }
  });

  // External signed webhook, Cron & QStash worker routes (cryptographically authenticated, not admin-session)
  app.use('/api', createTelegramWebhookRouter());

  // Telegram Mini App API routes (authenticated via signed Telegram WebApp initData / Mini App token)
  app.use('/api/miniapp', createMiniAppRouter());

  // Admin-authenticated API routes
  app.use('/api/auth', createAuthRouter());
  app.use('/api', createTelegramAdminRouter());
  app.use('/api', createMonitorRouter());
  app.use('/api', createProviderRouter());
  app.use('/api', createModelRouter());
  app.use('/api', createPlatformRouter());
  app.use('/api', createBillingRouter());
  app.use('/api', createFinanceRouter());
  app.use('/api', createSupportNotificationRouter());
  app.use('/api', createAiManagerRouter());

  // 404 handler for unknown API routes
  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'مسیر API مورد نظر یافت نشد.', code: 'NOT_FOUND' });
  });

  // Safe error boundary with secret redaction
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const errObj = err as { type?: unknown; status?: unknown; statusCode?: unknown };
    if (errObj?.type === 'entity.too.large' || errObj?.status === 413 || errObj?.statusCode === 413) {
      if (!res.headersSent) {
        res.status(413).json({
          error: 'حجم فایل یا تصویر ارسالی بیش از حد مجاز است. لطفاً تصویر کم‌حجم‌تری انتخاب کنید.',
          code: 'PAYLOAD_TOO_LARGE',
        });
      }
      return;
    }
    const rawMsg = err instanceof Error ? err.message : 'Unexpected server error';
    console.error('[api:error]', redactSecrets(rawMsg));
    if (!res.headersSent) {
      res.status(500).json({ error: 'خطای داخلی سرور رخ داد.', code: 'INTERNAL_ERROR' });
    }
  });

  return app;
}

