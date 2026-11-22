import { AsyncLocalStorage } from 'node:async_hooks';
import type { CloudflareR2Bucket } from '../../cloudflare-env.d.ts';

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
  deleteBlob(objectKey: string): Promise<void>;
}

export interface CloudflareRequestContext {
  sqlExecutor?: CloudflareSqlExecutor;
  blobStore?: CloudflareBlobStore;
  r2Bucket?: CloudflareR2Bucket;
  waitUntil?: (promise: Promise<unknown>) => void;
}

declare global {
  var _hooshnegarCfRequestAls: AsyncLocalStorage<CloudflareRequestContext> | undefined;
  var _hooshnegarCfWaitUntil: ((promise: Promise<unknown>) => void) | undefined;
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
