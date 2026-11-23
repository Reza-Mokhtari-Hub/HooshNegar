import { AsyncLocalStorage } from 'node:async_hooks';
import type { CloudflareAiBinding, CloudflareR2Bucket } from '../../cloudflare-env.d.ts';

export interface CloudflareSqlExecutor {
  execSql(
    queryString: string,
    params: unknown[],
    method: string,
    txToken?: string,
  ): Promise<{ rows: unknown[][] }>;
  beginTx(): Promise<string>;
  endTx(txToken: string): Promise<void>;
}

export interface CloudflareBlobStore {
  putBlob(
    objectKey: string,
    mimeType: string,
    dataBase64: string,
    expiresAtIso: string,
  ): Promise<void>;
  getBlob(objectKey: string): Promise<{ mimeType: string; dataBase64: string } | null>;
  deleteBlob(objectKey: string): Promise<void>;
}

export interface CloudflareRequestContext {
  sqlExecutor?: CloudflareSqlExecutor;
  blobStore?: CloudflareBlobStore;
  r2Bucket?: CloudflareR2Bucket;
  aiBinding?: CloudflareAiBinding;
  waitUntil?: (promise: Promise<unknown>) => void;
  childWaitUntilTasks?: Promise<unknown>[];
  requestOrigin?: string;
}

declare global {
  var _hooshnegarCfRequestAls: AsyncLocalStorage<CloudflareRequestContext> | undefined;
  var _hooshnegarCfWaitUntil: ((promise: Promise<unknown>) => void) | undefined;
  var _hooshnegarCfAiBinding: CloudflareAiBinding | undefined;
}

function getAls(): AsyncLocalStorage<CloudflareRequestContext> {
  if (!global._hooshnegarCfRequestAls) {
    global._hooshnegarCfRequestAls = new AsyncLocalStorage<CloudflareRequestContext>();
  }
  return global._hooshnegarCfRequestAls;
}

export function runWithCloudflareRequestContext<T>(
  context: CloudflareRequestContext,
  fn: () => T,
): T {
  return getAls().run(context, fn);
}

export function getCloudflareRequestContext(): CloudflareRequestContext | undefined {
  return getAls().getStore();
}

export function setGlobalCloudflareWaitUntil(
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
): void {
  global._hooshnegarCfWaitUntil = waitUntil;
}

export function getCloudflareWaitUntil(): ((promise: Promise<unknown>) => void) | undefined {
  return getCloudflareRequestContext()?.waitUntil ?? global._hooshnegarCfWaitUntil;
}

export function setGlobalCloudflareAiBinding(aiBinding: CloudflareAiBinding | undefined): void {
  global._hooshnegarCfAiBinding = aiBinding;
}

export function getCloudflareAiBinding(): CloudflareAiBinding | undefined {
  return getCloudflareRequestContext()?.aiBinding ?? global._hooshnegarCfAiBinding;
}
