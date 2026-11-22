import { Client, Receiver } from '@upstash/qstash';
import { getQStashConfig, getEnvValidationSummary } from '../config/env.ts';
import {
  getCloudflareRequestContext,
  getCloudflareWaitUntil,
  runWithCloudflareRequestContext,
  type CloudflareRequestContext,
} from '../cloudflare/requestContext.ts';
import type { CloudflareR2Bucket } from '../../cloudflare-env.d.ts';
import type { CloudflareBlobStore } from '../storage/storageAdapter.ts';
import type { CloudflareSqlExecutor } from '../../db/index.ts';

export interface QueuedJobPayload {
  kind: 'telegram_update' | 'ai_generation_job' | 'video_poll_job';
  idempotencyKey: string;
  jobId?: string;
  requestId?: string;
  update?: Record<string, unknown>;
  attempt?: number;
}

type LocalJobProcessor = (payload: QueuedJobPayload) => Promise<void>;

let localProcessor: LocalJobProcessor | null = null;

export function registerLocalJobProcessor(handler: LocalJobProcessor): void {
  localProcessor = handler;
}

function getCallbackBaseUrl(): string {
  const override = process.env.QSTASH_CALLBACK_BASE_URL?.trim();
  if (override) return override.replace(/\/+$/, '');
  return getEnvValidationSummary().appUrl.replace(/\/+$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureRequestContext(): CloudflareRequestContext {
  const active = getCloudflareRequestContext();
  const g = globalThis as {
    _hooshnegarCfSqlExecutor?: CloudflareSqlExecutor;
    _hooshnegarCfBlobStore?: CloudflareBlobStore;
    _hooshnegarCfR2Bucket?: CloudflareR2Bucket;
  };
  return {
    sqlExecutor: active?.sqlExecutor ?? g._hooshnegarCfSqlExecutor,
    blobStore: active?.blobStore ?? g._hooshnegarCfBlobStore,
    r2Bucket: active?.r2Bucket ?? g._hooshnegarCfR2Bucket,
    waitUntil: active?.waitUntil ?? getCloudflareWaitUntil(),
  };
}

/**
 * Verifies Upstash-Signature JWT on incoming QStash worker requests.
 */
export async function verifyQStashSignature(params: {
  signature: string | undefined;
  rawBody: string;
  url: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const cfg = getQStashConfig();
  if (!cfg.configured) {
    return { ok: false, reason: 'QSTASH_NOT_CONFIGURED' };
  }
  if (!params.signature) {
    return { ok: false, reason: 'MISSING_QSTASH_SIGNATURE' };
  }

  try {
    const receiver = new Receiver({
      currentSigningKey: cfg.currentSigningKey,
      nextSigningKey: cfg.nextSigningKey || cfg.currentSigningKey,
    });
    const isValid = await receiver.verify({
      signature: params.signature,
      body: params.rawBody,
      url: params.url,
    });
    return isValid ? { ok: true } : { ok: false, reason: 'INVALID_QSTASH_SIGNATURE' };
  } catch {
    return { ok: false, reason: 'SIGNATURE_VERIFICATION_FAILED' };
  }
}

/**
 * Enqueues a durable background job via Upstash QStash when configured,
 * executes inside Cloudflare ctx.waitUntil() on Cloudflare Workers,
 * or executes asynchronously with bounded retries in local Node.js runtime.
 */
export async function enqueueBackgroundJob(
  payload: QueuedJobPayload,
  options?: { delaySeconds?: number; retries?: number },
): Promise<{ mode: 'qstash' | 'cloudflare_waituntil' | 'local_async'; messageId: string }> {
  const cfg = getQStashConfig();
  const baseUrl = getCallbackBaseUrl();
  const retries = Math.max(1, options?.retries ?? 3);
  const delaySeconds = options?.delaySeconds ?? 0;

  if (cfg.configured && baseUrl.startsWith('https://')) {
    const client = new Client({ token: cfg.token });
    const targetPath =
      payload.kind === 'video_poll_job' ? '/api/jobs/poll' : '/api/jobs/process';
    const result = await client.publishJSON({
      url: `${baseUrl}${targetPath}`,
      body: payload,
      retries,
      delay: delaySeconds > 0 ? delaySeconds : undefined,
      deduplicationId: payload.idempotencyKey.slice(0, 128),
      failureCallback: `${baseUrl}/api/jobs/failed`,
    });
    return {
      mode: 'qstash',
      messageId: result.messageId,
    };
  }

  const capturedCtx = captureRequestContext();
  const waitUntil = capturedCtx.waitUntil;
  const runJobWithRetries = async () => {
    if (!localProcessor) return;
    if (delaySeconds > 0) {
      await sleep(delaySeconds * 1000);
    }
    for (let attemptNum = 1; attemptNum <= retries; attemptNum++) {
      try {
        await runWithCloudflareRequestContext(capturedCtx, () =>
          localProcessor!({ ...payload, attempt: attemptNum }),
        );
        return;
      } catch (err) {
        console.error(
          `[bg-queue] job ${payload.kind} attempt ${attemptNum} failed:`,
          err instanceof Error ? err.message : 'unknown',
        );
        if (attemptNum >= retries) {
          return;
        }
        await sleep(Math.min(15000, 1000 * Math.pow(2, attemptNum)));
      }
    }
  };

  if (waitUntil) {
    const messageId = `cf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    waitUntil(runJobWithRetries());
    return {
      mode: 'cloudflare_waituntil',
      messageId,
    };
  }

  // Non-blocking async local Node queue with bounded exponential retries
  const messageId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const scheduleAttempt = (attemptNum: number, delayMs: number) => {
    const timer = setTimeout(() => {
      if (!localProcessor) return;
      void runWithCloudflareRequestContext(capturedCtx, () =>
        localProcessor!({ ...payload, attempt: attemptNum }),
      ).catch((err) => {
        console.error(
          `[local-queue] job ${payload.kind} attempt ${attemptNum} failed:`,
          err instanceof Error ? err.message : 'unknown',
        );
        if (attemptNum < retries) {
          scheduleAttempt(attemptNum + 1, Math.min(15000, 1000 * Math.pow(2, attemptNum)));
        }
      });
    }, delayMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  };

  scheduleAttempt(1, delaySeconds > 0 ? delaySeconds * 1000 : 10);

  return {
    mode: 'local_async',
    messageId,
  };
}
