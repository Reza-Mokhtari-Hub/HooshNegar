import fs from 'node:fs';
import path from 'node:path';
import { neon, Pool } from '@neondatabase/serverless';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http';
import { drizzle as drizzleNeonServerless } from 'drizzle-orm/neon-serverless';
import { drizzle as drizzlePgProxy } from 'drizzle-orm/pg-proxy';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import { isCloudflareWorker } from '../server/config/env.ts';
import {
  getCloudflareRequestContext,
  type CloudflareSqlExecutor,
} from '../server/cloudflare/requestContext.ts';
import * as schema from './schema.ts';

export type AppDatabase = PgliteDatabase<typeof schema>;
export type DatabaseMode = 'neon_postgres' | 'cloudflare_durable_object' | 'embedded_pglite';
export type { CloudflareSqlExecutor };

declare global {
  var _hooshnegarDb: AppDatabase | undefined;
  var _hooshnegarPglite: PGlite | undefined;
  var _hooshnegarDbMode: DatabaseMode | undefined;
  var _hooshnegarCfSqlExecutor: CloudflareSqlExecutor | undefined;
}

export function setCloudflareSqlExecutor(executor: CloudflareSqlExecutor | undefined): void {
  global._hooshnegarCfSqlExecutor = executor;
}

export function hasCloudflareSqlExecutor(): boolean {
  return Boolean(getCloudflareRequestContext()?.sqlExecutor ?? global._hooshnegarCfSqlExecutor);
}

function createCloudflareDurableObjectDb(): AppDatabase {
  const getLiveExecutor = (): CloudflareSqlExecutor => {
    const exec = getCloudflareRequestContext()?.sqlExecutor ?? global._hooshnegarCfSqlExecutor;
    if (!exec) {
      throw new Error(
        'Cloudflare Durable Object STATE_DB executor is not initialized for this request.',
      );
    }
    return exec;
  };

  const createScopedDb = (txToken?: string) =>
    drizzlePgProxy(
      async (queryString, params, method) => {
        return getLiveExecutor().execSql(queryString, params, method, txToken);
      },
      { schema },
    );

  const rootDb = createScopedDb();

  (
    rootDb as unknown as {
      transaction: <T>(
        callback: (tx: unknown) => Promise<T>,
        config?: Record<string, unknown>,
      ) => Promise<T>;
    }
  ).transaction = async <T>(
    callback: (tx: unknown) => Promise<T>,
    _config?: Record<string, unknown>,
  ): Promise<T> => {
    const executor = getLiveExecutor();
    const txToken = await executor.beginTx();
    const txDb = createScopedDb(txToken);
    try {
      return await callback(txDb);
    } finally {
      await executor.endTx(txToken).catch(() => {});
    }
  };

  return rootDb as unknown as AppDatabase;
}

function createDatabaseInstance(): { db: AppDatabase; mode: DatabaseMode } {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (databaseUrl && databaseUrl.startsWith('postgres')) {
    const sqlClient = neon(databaseUrl);
    const neonDb = drizzleNeon(sqlClient, { schema });

    // neon-http is stateless (ideal for Cloudflare Workers across requests) but does not support
    // interactive BEGIN/COMMIT transactions. Delegate db.transaction() to an ephemeral per-call
    // WebSocket Pool (drizzle-orm/neon-serverless) and close it immediately in finally so we get
    // real PostgreSQL ACID transactions with zero cross-request I/O leaks on Cloudflare Workers.
    (
      neonDb as unknown as {
        transaction: <T>(
          callback: (tx: unknown) => Promise<T>,
          config?: Record<string, unknown>,
        ) => Promise<T>;
      }
    ).transaction = async <T>(
      callback: (tx: unknown) => Promise<T>,
      config?: Record<string, unknown>,
    ): Promise<T> => {
      const pool = new Pool({ connectionString: databaseUrl });
      try {
        const txDb = drizzleNeonServerless(pool, { schema });
        return (await txDb.transaction(
          callback as Parameters<typeof txDb.transaction>[0],
          config as Parameters<typeof txDb.transaction>[1],
        )) as T;
      } finally {
        await pool.end().catch(() => {});
      }
    };

    return {
      db: neonDb as unknown as AppDatabase,
      mode: 'neon_postgres',
    };
  }

  if (hasCloudflareSqlExecutor()) {
    return {
      db: createCloudflareDurableObjectDb(),
      mode: 'cloudflare_durable_object',
    };
  }

  if (isCloudflareWorker()) {
    throw new Error(
      'Cloudflare Durable Object STATE_DB binding is missing and DATABASE_URL is not set.',
    );
  }

  const isTestEnv = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
  const dataDir = isTestEnv
    ? undefined
    : path.resolve(process.cwd(), 'data', 'pgdata');

  if (dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  global._hooshnegarPglite = client;
  const pgliteDb = drizzlePglite(client, { schema });

  return {
    db: pgliteDb,
    mode: 'embedded_pglite',
  };
}

export function getDb(): AppDatabase {
  // Always refresh DB handle inside Cloudflare Workers if executor or env changed between invocations
  if (
    global._hooshnegarDb &&
    hasCloudflareSqlExecutor() &&
    global._hooshnegarDbMode !== 'cloudflare_durable_object' &&
    !process.env.DATABASE_URL?.trim()
  ) {
    global._hooshnegarDb = undefined;
  }

  if (!global._hooshnegarDb) {
    const created = createDatabaseInstance();
    global._hooshnegarDb = created.db;
    global._hooshnegarDbMode = created.mode;
  }
  return global._hooshnegarDb;
}

export function getDatabaseMode(): DatabaseMode {
  if (!global._hooshnegarDbMode) {
    getDb();
  }
  return global._hooshnegarDbMode ?? 'embedded_pglite';
}

export function getPgliteClient(): PGlite | undefined {
  getDb();
  return global._hooshnegarPglite;
}
