export interface CloudflareFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface CloudflareR2Object {
  key: string;
  size: number;
  httpMetadata?: { contentType?: string };
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

export interface CloudflareDurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  execSql(
    queryString: string,
    params: unknown[],
    method: string,
    txToken?: string,
  ): Promise<{ rows: unknown[][] }>;
  beginTx(): Promise<string>;
  endTx(txToken: string): Promise<void>;
  getOrProvisionSecrets(): Promise<{
    encryptionMasterKey: string;
    sessionSecret: string;
  }>;
  putBlob(
    objectKey: string,
    mimeType: string,
    dataBase64: string,
    expiresAtIso: string,
  ): Promise<void>;
  getBlob(objectKey: string): Promise<{ mimeType: string; dataBase64: string } | null>;
  deleteBlob(objectKey: string): Promise<void>;
}

export interface CloudflareDurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): CloudflareDurableObjectStub;
}

export interface CloudflareAiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export interface CloudflareQueueSendOptions {
  delaySeconds?: number;
  contentType?: 'json' | 'text' | 'bytes' | 'v8';
}

export interface CloudflareQueueBinding<T = unknown> {
  send(message: T, options?: CloudflareQueueSendOptions): Promise<void>;
  sendBatch?(messages: Array<{ body: T; delaySeconds?: number }>): Promise<void>;
}

export interface CloudflareQueueMessage<T = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: T;
  readonly attempts?: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface CloudflareQueueBatch<T = unknown> {
  readonly queue: string;
  readonly messages: ReadonlyArray<CloudflareQueueMessage<T>>;
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
}

export interface CloudflareWorkerEnv {
  ASSETS?: CloudflareFetcher;
  MEDIA_BUCKET?: CloudflareR2Bucket;
  STATE_DB?: CloudflareDurableObjectNamespace;
  AI?: CloudflareAiBinding;
  JOB_QUEUE?: CloudflareQueueBinding;
  [key: string]: unknown;
}
