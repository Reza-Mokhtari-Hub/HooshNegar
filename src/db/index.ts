import fs from 'node:fs';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import { isCloudflareWorker } from '../server/config/env.ts';
import * as schema from './schema.ts';

export type AppDatabase = PgliteDatabase<typeof schema>;

declare global {
  var _hooshnegarDb: AppDatabase | undefined;
  var _hooshnegarPglite: PGlite | undefined;
  var _hooshnegarDbMode: 'neon_postgres' | 'embedded_pglite' | undefined;
}

function createDatabaseInstance(): { db: AppDatabase; mode: 'neon_postgres' | 'embedded_pglite' } {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (databaseUrl && databaseUrl.startsWith('postgres')) {
    const sqlClient = neon(databaseUrl);
    const neonDb = drizzleNeon(sqlClient, { schema });
    return {
      db: neonDb as unknown as AppDatabase,
      mode: 'neon_postgres',
    };
  }

  if (isCloudflareWorker()) {
    throw new Error(
      'DATABASE_URL (Neon PostgreSQL) is required on Cloudflare Workers. Add it in Cloudflare Dashboard → Workers → Settings → Variables and Secrets.',
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
  if (!global._hooshnegarDb) {
    const created = createDatabaseInstance();
    global._hooshnegarDb = created.db;
    global._hooshnegarDbMode = created.mode;
  }
  return global._hooshnegarDb;
}

export function getDatabaseMode(): 'neon_postgres' | 'embedded_pglite' {
  if (!global._hooshnegarDbMode) {
    getDb();
  }
  return global._hooshnegarDbMode ?? 'embedded_pglite';
}

export function getPgliteClient(): PGlite | undefined {
  getDb();
  return global._hooshnegarPglite;
}
