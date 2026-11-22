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

declare global {
  var _hooshnegarCfBoundKeys: string[] | undefined;
}

const WORKER_HTTP_PORT = 3000;
let cachedHandler: HttpServerHandler | null = null;

async function syncWorkerEnvToProcessEnv(env: CloudflareWorkerEnv | undefined): Promise<void> {
  const procEnv = process.env as Record<string, string | undefined>;
  procEnv['CF_WORKER'] = '1';
  if (!env) {
    global._hooshnegarCfBoundKeys = [];
    return;
  }

  const boundKeys: string[] = [];
  for (const [rawKey, value] of Object.entries(env)) {
    const key = rawKey.trim();
    boundKeys.push(key);
    if (key === 'NODE_ENV') continue;

    if (typeof value === 'string') {
      procEnv[key] = value;
    } else if (
      value &&
      typeof value === 'object' &&
      'get' in value &&
      typeof (value as { get?: unknown }).get === 'function' &&
      key !== 'ASSETS' &&
      key !== 'MEDIA_BUCKET'
    ) {
      // Support Cloudflare Secrets Store bindings (`await env.MY_SECRET.get()`)
      try {
        const resolved = await (value as { get: () => Promise<unknown> }).get();
        if (typeof resolved === 'string') {
          procEnv[key] = resolved;
        }
      } catch {
        // Ignore non-secret objects with a .get() method (e.g. KV/R2 bindings)
      }
    }
  }
  global._hooshnegarCfBoundKeys = boundKeys.sort();

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
    await syncWorkerEnvToProcessEnv(env);

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
    await syncWorkerEnvToProcessEnv(env);

    ctx.waitUntil(
      (async () => {
        await ensurePlatformReady();
        const result = await runScheduledMaintenance();
        console.log('[cloudflare:cron] Maintenance sweep completed:', JSON.stringify(result));
      })(),
    );
  },
};
