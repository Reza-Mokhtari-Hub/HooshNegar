/// <reference path="./src/cloudflare-workers.d.ts" />
import crypto from 'node:crypto';
import { DurableObject } from 'cloudflare:workers';
import { httpServerHandler, type HttpServerHandler } from 'cloudflare:node';
import type {
  CloudflareExecutionContext,
  CloudflareQueueBatch,
  CloudflareScheduledController,
  CloudflareWorkerEnv,
} from './src/cloudflare-env.d.ts';
import { setCloudflareSqlExecutor } from './src/db/index.ts';
import {
  buildSqliteSchemaStatements,
  decodeSqliteRows,
  getSqliteSchemaTables,
  translatePgQueryToSqlite,
} from './src/db/pgToSqliteTranslator.ts';
import { createApiApp } from './src/server/app.ts';
import {
  dispatchJobPayload,
  initBackgroundJobProcessor,
} from './src/server/routes/telegramWebhookRoutes.ts';
import type { QueuedJobPayload } from './src/server/queue/qstash.ts';
import { ensurePlatformReady } from './src/server/services/bootstrap.ts';
import { runScheduledMaintenance } from './src/server/services/maintenanceService.ts';
import {
  BLOB_CHUNK_SENTINEL,
  BLOB_CHUNK_SIZE,
  joinBlobChunks,
  setCloudflareBlobStore,
  setCloudflareR2Bucket,
  splitBlobBase64,
} from './src/server/storage/storageAdapter.ts';
import {
  runWithCloudflareRequestContext,
  setGlobalCloudflareAiBinding,
  setGlobalCloudflareJobQueue,
  setGlobalCloudflareWaitUntil,
  type CloudflareRequestContext,
} from './src/server/cloudflare/requestContext.ts';

declare global {
  var _hooshnegarCfBoundKeys: string[] | undefined;
}

const WORKER_HTTP_PORT = 3000;
const TX_LOCK_TIMEOUT_MS = 15_000;
let cachedHandler: HttpServerHandler | null = null;

/**
 * Persistent SQLite-backed Durable Object storing the full relational database,
 * auto-provisioned cryptographic keys, and temporary media/upload blobs 100% inside Cloudflare.
 */
export class HooshNegarStore extends DurableObject<CloudflareWorkerEnv> {
  private schemaReady = false;
  private activeTx: { token: string; expiresAt: number } | null = null;
  private readonly txWaiters: Array<() => void> = [];

  constructor(ctx: unknown, env: CloudflareWorkerEnv) {
    super(ctx, env);
    void this.ctx.blockConcurrencyWhile(async () => {
      this.ensureSchemaInitialized();
    });
  }

  private ensureSchemaInitialized(): void {
    if (this.schemaReady) return;

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('PRAGMA foreign_keys = ON;');

      for (const stmt of buildSqliteSchemaStatements()) {
        this.ctx.storage.sql.exec(stmt);
      }

      // Safely reconcile any newly added columns on existing tables
      for (const tbl of getSqliteSchemaTables()) {
        const existingCols = new Set(
          this.ctx.storage.sql
            .exec<{ name: string }>(`PRAGMA table_info("${tbl.tableName.replace(/"/g, '""')}")`)
            .toArray()
            .map((row: { name: string }) => row.name),
        );
        for (const col of tbl.columns) {
          if (!existingCols.has(col.name)) {
            this.ctx.storage.sql.exec(
              `ALTER TABLE "${tbl.tableName.replace(/"/g, '""')}" ADD COLUMN ${col.alterDefinition}`,
            );
          }
        }
      }

      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS "_hooshnegar_kv" (
          "key" TEXT PRIMARY KEY,
          "value" TEXT NOT NULL,
          "updated_at" TEXT NOT NULL
        );
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS "_hooshnegar_blobs" (
          "object_key" TEXT PRIMARY KEY,
          "mime_type" TEXT NOT NULL,
          "data_base64" TEXT NOT NULL,
          "expires_at" TEXT NOT NULL,
          "created_at" TEXT NOT NULL
        );
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS "_hooshnegar_blob_chunks" (
          "object_key" TEXT NOT NULL,
          "chunk_index" INTEGER NOT NULL,
          "data" TEXT NOT NULL,
          PRIMARY KEY ("object_key", "chunk_index")
        );
      `);
    });

    this.schemaReady = true;
  }

  private clearExpiredTxIfNeeded(): void {
    if (this.activeTx && Date.now() >= this.activeTx.expiresAt) {
      this.activeTx = null;
      const next = this.txWaiters.shift();
      if (next) next();
    }
  }

  private async waitForTurn(): Promise<void> {
    this.clearExpiredTxIfNeeded();
    while (this.activeTx !== null) {
      await new Promise<void>((resolve) => {
        this.txWaiters.push(resolve);
      });
      this.clearExpiredTxIfNeeded();
    }
  }

  async beginTx(): Promise<string> {
    this.ensureSchemaInitialized();
    await this.waitForTurn();
    const token = crypto.randomUUID();
    this.activeTx = {
      token,
      expiresAt: Date.now() + TX_LOCK_TIMEOUT_MS,
    };
    return token;
  }

  async endTx(txToken: string): Promise<void> {
    if (this.activeTx?.token === txToken) {
      this.activeTx = null;
      const next = this.txWaiters.shift();
      if (next) next();
    }
  }

  async execSql(
    queryString: string,
    params: unknown[],
    _method: string,
    txToken?: string,
  ): Promise<{ rows: unknown[][] }> {
    this.ensureSchemaInitialized();

    if (!txToken) {
      await this.waitForTurn();
    } else if (this.activeTx && this.activeTx.token !== txToken) {
      await this.waitForTurn();
    }

    const { sql, params: sqliteParams } = translatePgQueryToSqlite(queryString, params);
    const cursor = this.ctx.storage.sql.exec(sql, ...sqliteParams);
    const columnNames = cursor.columnNames ?? [];
    const rawRows = Array.from(cursor.raw()) as unknown[][];

    if (columnNames.length === 0 || rawRows.length === 0) {
      return { rows: [] };
    }

    return {
      rows: decodeSqliteRows(columnNames, rawRows),
    };
  }

  async getOrProvisionSecrets(): Promise<{
    encryptionMasterKey: string;
    sessionSecret: string;
  }> {
    this.ensureSchemaInitialized();
    const now = new Date().toISOString();

    const readKv = (key: string): string | null => {
      const rows = this.ctx.storage.sql
        .exec<{ value: string }>('SELECT "value" FROM "_hooshnegar_kv" WHERE "key" = ? LIMIT 1', key)
        .toArray();
      return rows[0]?.value ?? null;
    };

    const writeKv = (key: string, value: string): void => {
      this.ctx.storage.sql.exec(
        `INSERT INTO "_hooshnegar_kv" ("key", "value", "updated_at")
         VALUES (?, ?, ?)
         ON CONFLICT("key") DO UPDATE SET "value" = excluded."value", "updated_at" = excluded."updated_at"`,
        key,
        value,
        now,
      );
    };

    return this.ctx.storage.transactionSync(() => {
      let encryptionMasterKey = readKv('ENCRYPTION_MASTER_KEY');
      if (!encryptionMasterKey || !/^[0-9a-fA-F]{64}$/.test(encryptionMasterKey)) {
        encryptionMasterKey = crypto.randomBytes(32).toString('hex');
        writeKv('ENCRYPTION_MASTER_KEY', encryptionMasterKey);
      }

      let sessionSecret = readKv('SESSION_SECRET');
      if (!sessionSecret || sessionSecret.length < 32) {
        sessionSecret = crypto.randomBytes(48).toString('base64url');
        writeKv('SESSION_SECRET', sessionSecret);
      }

      return { encryptionMasterKey, sessionSecret };
    });
  }

  async putBlob(
    objectKey: string,
    mimeType: string,
    dataBase64: string,
    expiresAtIso: string,
  ): Promise<void> {
    this.ensureSchemaInitialized();
    const now = new Date().toISOString();
    const needsChunking = dataBase64.length > BLOB_CHUNK_SIZE;

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        'DELETE FROM "_hooshnegar_blob_chunks" WHERE "object_key" = ?',
        objectKey,
      );

      this.ctx.storage.sql.exec(
        `INSERT INTO "_hooshnegar_blobs" ("object_key", "mime_type", "data_base64", "expires_at", "created_at")
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT("object_key") DO UPDATE SET "mime_type" = excluded."mime_type", "data_base64" = excluded."data_base64", "expires_at" = excluded."expires_at"`,
        objectKey,
        mimeType,
        needsChunking ? BLOB_CHUNK_SENTINEL : dataBase64,
        expiresAtIso,
        now,
      );

      if (needsChunking) {
        const chunks = splitBlobBase64(dataBase64, BLOB_CHUNK_SIZE);
        for (let i = 0; i < chunks.length; i++) {
          this.ctx.storage.sql.exec(
            `INSERT INTO "_hooshnegar_blob_chunks" ("object_key", "chunk_index", "data")
             VALUES (?, ?, ?)`,
            objectKey,
            i,
            chunks[i]!,
          );
        }
      }
    });
  }

  async getBlob(objectKey: string): Promise<{ mimeType: string; dataBase64: string } | null> {
    this.ensureSchemaInitialized();
    const rows = this.ctx.storage.sql
      .exec<{ mime_type: string; data_base64: string }>(
        'SELECT "mime_type", "data_base64" FROM "_hooshnegar_blobs" WHERE "object_key" = ? LIMIT 1',
        objectKey,
      )
      .toArray();
    if (!rows[0]) return null;

    if (rows[0].data_base64 === BLOB_CHUNK_SENTINEL) {
      const chunkRows = this.ctx.storage.sql
        .exec<{ data: string }>(
          'SELECT "data" FROM "_hooshnegar_blob_chunks" WHERE "object_key" = ? ORDER BY "chunk_index" ASC',
          objectKey,
        )
        .toArray();
      if (chunkRows.length === 0) return null;
      return {
        mimeType: rows[0].mime_type,
        dataBase64: joinBlobChunks(chunkRows.map((c) => c.data)),
      };
    }

    return { mimeType: rows[0].mime_type, dataBase64: rows[0].data_base64 };
  }

  async deleteBlob(objectKey: string): Promise<void> {
    this.ensureSchemaInitialized();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM "_hooshnegar_blob_chunks" WHERE "object_key" = ?', objectKey);
      this.ctx.storage.sql.exec('DELETE FROM "_hooshnegar_blobs" WHERE "object_key" = ?', objectKey);
    });
  }
}

async function syncWorkerEnvToProcessEnv(
  env: CloudflareWorkerEnv | undefined,
  requestUrl?: string,
  waitUntilFn?: (promise: Promise<unknown>) => void,
): Promise<CloudflareRequestContext> {
  const procEnv = process.env as Record<string, string | undefined>;
  procEnv['CF_WORKER'] = '1';
  setGlobalCloudflareWaitUntil(waitUntilFn);
  const reqCtx: CloudflareRequestContext = {
    waitUntil: waitUntilFn,
  };

  if (!env) {
    global._hooshnegarCfBoundKeys = [];
    return reqCtx;
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
      key !== 'MEDIA_BUCKET' &&
      key !== 'STATE_DB' &&
      key !== 'AI' &&
      key !== 'JOB_QUEUE'
    ) {
      // Support Cloudflare Secrets Store bindings (`await env.MY_SECRET.get()`)
      try {
        const resolved = await (value as { get: () => Promise<unknown> }).get();
        if (typeof resolved === 'string') {
          procEnv[key] = resolved;
        }
      } catch {
        // Ignore non-secret objects with a .get() method
      }
    }
  }
  global._hooshnegarCfBoundKeys = boundKeys.sort();

  if (env.MEDIA_BUCKET) {
    setCloudflareR2Bucket(env.MEDIA_BUCKET);
    reqCtx.r2Bucket = env.MEDIA_BUCKET;
  }

  if (env.AI && typeof env.AI.run === 'function') {
    setGlobalCloudflareAiBinding(env.AI);
    reqCtx.aiBinding = env.AI;
  }

  if (env.JOB_QUEUE && typeof env.JOB_QUEUE.send === 'function') {
    setGlobalCloudflareJobQueue(env.JOB_QUEUE);
    reqCtx.jobQueue = env.JOB_QUEUE;
  }

  if (env.STATE_DB) {
    const storeId = env.STATE_DB.idFromName('primary');
    const stub = env.STATE_DB.get(storeId);
    setCloudflareSqlExecutor(stub);
    setCloudflareBlobStore(stub);
    reqCtx.sqlExecutor = stub;
    reqCtx.blobStore = stub;

    // Auto-provision persistent 256-bit encryption & session keys inside Cloudflare Durable Object
    // when not explicitly set via Cloudflare Dashboard Secrets
    if (!procEnv['ENCRYPTION_MASTER_KEY']?.trim() || !procEnv['SESSION_SECRET']?.trim()) {
      const secrets = await stub.getOrProvisionSecrets();
      if (!procEnv['ENCRYPTION_MASTER_KEY']?.trim()) {
        procEnv['ENCRYPTION_MASTER_KEY'] = secrets.encryptionMasterKey;
      }
      if (!procEnv['SESSION_SECRET']?.trim()) {
        procEnv['SESSION_SECRET'] = secrets.sessionSecret;
      }
    }
  }

  if (requestUrl) {
    try {
      const parsedOrigin = new URL(requestUrl).origin;
      if (parsedOrigin.startsWith('https://')) {
        reqCtx.requestOrigin = parsedOrigin;
      }
      if (!procEnv['APP_URL']?.trim() || (!procEnv['APP_URL'].startsWith('https://') && parsedOrigin.startsWith('https://'))) {
        procEnv['APP_URL'] = parsedOrigin;
      }
    } catch {
      // Ignore malformed request URL
    }
  }

  return reqCtx;
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
    const waitUntilFn = (promise: Promise<unknown>) => {
      ctx.waitUntil(promise);
    };
    const reqCtx = await syncWorkerEnvToProcessEnv(env, request.url, waitUntilFn);

    const url = new URL(request.url);
    if (url.pathname.startsWith('/api')) {
      const handler = getExpressWorkerHandler();
      return runWithCloudflareRequestContext(reqCtx, () => handler.fetch(request, env, ctx));
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
    const waitUntilFn = (promise: Promise<unknown>) => {
      ctx.waitUntil(promise);
    };
    const reqCtx = await syncWorkerEnvToProcessEnv(env, undefined, waitUntilFn);

    ctx.waitUntil(
      runWithCloudflareRequestContext(reqCtx, async () => {
        await ensurePlatformReady();
        const result = await runScheduledMaintenance();
        console.log('[cloudflare:cron] Maintenance sweep completed:', JSON.stringify(result));
      }),
    );
  },

  async queue(
    batch: CloudflareQueueBatch<QueuedJobPayload>,
    env: CloudflareWorkerEnv,
    ctx: CloudflareExecutionContext,
  ): Promise<void> {
    const waitUntilFn = (promise: Promise<unknown>) => {
      ctx.waitUntil(promise);
    };
    const reqCtx = await syncWorkerEnvToProcessEnv(env, undefined, waitUntilFn);
    initBackgroundJobProcessor();

    await runWithCloudflareRequestContext(reqCtx, async () => {
      await ensurePlatformReady();
      for (const msg of batch.messages) {
        try {
          await dispatchJobPayload(msg.body);
          msg.ack();
        } catch (err) {
          console.error(
            `[cloudflare:queue] Failed processing ${msg.body?.kind ?? 'unknown'} (${msg.body?.jobId ?? msg.id}):`,
            err instanceof Error ? err.message : 'unknown',
          );
          msg.retry({ delaySeconds: 15 });
        }
      }
    });
  },
};
