import { httpServerHandler, type HttpServerHandler } from 'cloudflare:node';
import type {
  CloudflareExecutionContext,
  CloudflareScheduledController,
  CloudflareWorkerEnv,
} from './src/cloudflare-env.d.ts';
import { createApiApp } from './src/server/app.ts';
import { ensurePlatformReady } from './src/server/services/bootstrap.ts';
import { runScheduledMaintenance } from './src/server/services/maintenanceService.ts';
import { setCloudflareR2Bucket } from './src/server/storage/storageAdapter.ts';

const WORKER_HTTP_PORT = 3000;
let cachedHandler: HttpServerHandler | null = null;

function syncWorkerEnvToProcessEnv(env: CloudflareWorkerEnv | undefined): void {
  process.env.CF_WORKER = '1';
  if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = 'production';
  }
  if (!env) return;

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      process.env[key] = value;
    }
  }

  if (env.MEDIA_BUCKET) {
    setCloudflareR2Bucket(env.MEDIA_BUCKET);
  }
}

function getExpressWorkerHandler(): HttpServerHandler {
  if (!cachedHandler) {
    const app = createApiApp();
    app.listen(WORKER_HTTP_PORT);
    cachedHandler = httpServerHandler({ port: WORKER_HTTP_PORT });
  }
  return cachedHandler;
}

export default {
  async fetch(
    request: Request,
    env: CloudflareWorkerEnv,
    ctx: CloudflareExecutionContext,
  ): Promise<Response> {
    syncWorkerEnvToProcessEnv(env);

    const url = new URL(request.url);
    if (url.pathname.startsWith('/api')) {
      const handler = getExpressWorkerHandler();
      return handler.fetch(request, env, ctx);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Static assets binding (ASSETS) not configured.', { status: 404 });
  },

  async scheduled(
    _controller: CloudflareScheduledController,
    env: CloudflareWorkerEnv,
    ctx: CloudflareExecutionContext,
  ): Promise<void> {
    syncWorkerEnvToProcessEnv(env);

    ctx.waitUntil(
      (async () => {
        await ensurePlatformReady();
        const result = await runScheduledMaintenance();
        console.log('[cloudflare:cron] Maintenance sweep completed:', JSON.stringify(result));
      })(),
    );
  },
};
