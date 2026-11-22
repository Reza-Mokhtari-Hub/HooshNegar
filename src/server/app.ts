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
import { createMonitorRouter } from './routes/monitorRoutes.ts';
import { createBillingRouter } from './routes/billingRoutes.ts';
import { createFinanceRouter } from './routes/financeRoutes.ts';
import { createSupportNotificationRouter } from './routes/supportNotificationRoutes.ts';
import {
  apiRateLimitMiddleware,
  securityHeadersMiddleware,
} from './middleware/auth.ts';
import { ensurePlatformReady } from './services/bootstrap.ts';
import { getEnvValidationSummary } from './config/env.ts';
import { redactSecrets } from './security/crypto.ts';

export function createApiApp(): Express {
  const app = express();
  app.set('trust proxy', 1);

  initBackgroundJobProcessor();

  app.use(securityHeadersMiddleware);
  app.use(cookieParser());
  app.use(
    express.json({
      limit: '5mb',
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf.toString('utf8');
      },
    }),
  );
  app.use('/api', apiRateLimitMiddleware);

  // Ensure DB migrations & bootstrap have completed before serving any API route
  app.use('/api', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await ensurePlatformReady();
      next();
    } catch (err) {
      console.error('[bootstrap]', err instanceof Error ? err.message : 'unknown');
      res.status(503).json({
        error: 'پایگاه‌داده در حال آماده‌سازی است یا اتصال برقرار نشد.',
        code: 'DB_UNAVAILABLE',
      });
    }
  });

  // Public health check (no secrets exposed)
  app.get('/api/health', (_req: Request, res: Response) => {
    const env = getEnvValidationSummary();
    res.json({
      status: 'ok',
      phase: 3,
      databaseMode: env.databaseMode,
      encryptionConfigured: env.encryptionConfigured,
      qstashConfigured: env.qstashConfigured,
      r2Configured: env.r2Configured,
      aiMockMode: env.aiMockMode,
      timestamp: new Date().toISOString(),
    });
  });

  // External signed webhook, Cron & QStash worker routes (cryptographically authenticated, not admin-session)
  app.use('/api', createTelegramWebhookRouter());

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

  // 404 handler for unknown API routes
  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'مسیر API مورد نظر یافت نشد.', code: 'NOT_FOUND' });
  });

  // Safe error boundary with secret redaction
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const rawMsg = err instanceof Error ? err.message : 'Unexpected server error';
    console.error('[api:error]', redactSecrets(rawMsg));
    if (!res.headersSent) {
      res.status(500).json({ error: 'خطای داخلی سرور رخ داد.', code: 'INTERNAL_ERROR' });
    }
  });

  return app;
}

