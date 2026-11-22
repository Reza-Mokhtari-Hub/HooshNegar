export interface CloudflareFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface CloudflareR2Object {
  key: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface CloudflareR2Bucket {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<CloudflareR2Object | null>;
  get(key: string): Promise<CloudflareR2Object | null>;
  delete(keys: string | string[]): Promise<void>;
}

export interface CloudflareExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface CloudflareScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
  noRetry(): void;
}

export interface CloudflareWorkerEnv {
  ASSETS?: CloudflareFetcher;
  MEDIA_BUCKET?: CloudflareR2Bucket;
  [key: string]: unknown;
}
