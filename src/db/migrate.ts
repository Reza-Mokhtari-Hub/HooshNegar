import fs from 'node:fs';
import path from 'node:path';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { migrate as migrateNeon } from 'drizzle-orm/neon-http/migrator';
import { getDb, getDatabaseMode } from './index.ts';
import { isCloudflareWorker } from '../server/config/env.ts';

let migrationPromise: Promise<void> | null = null;

export async function runMigrations(): Promise<void> {
  if (migrationPromise) {
    return migrationPromise;
  }

  // Cloudflare Workers isolates have no local filesystem for drizzle/*.sql.
  // Schema migrations are applied against Neon PostgreSQL via `npm run db:migrate` during deploy.
  if (isCloudflareWorker()) {
    getDb();
    migrationPromise = Promise.resolve();
    return migrationPromise;
  }

  migrationPromise = (async () => {
    const migrationsFolder = path.resolve(process.cwd(), 'drizzle');
    if (!fs.existsSync(migrationsFolder)) {
      throw new Error(`Drizzle migrations folder not found at ${migrationsFolder}`);
    }

    const db = getDb();
    const mode = getDatabaseMode();

    if (mode === 'neon_postgres') {
      await migrateNeon(db as never, { migrationsFolder });
    } else {
      await migratePglite(db, { migrationsFolder });
    }
  })();

  try {
    await migrationPromise;
  } catch (err) {
    migrationPromise = null;
    throw err;
  }
}

// Allow running directly via `npm run db:migrate` (Node.js CLI only)
const argv1 = process.argv?.[1];
const isDirectExecution =
  !isCloudflareWorker() &&
  typeof argv1 === 'string' &&
  typeof import.meta?.url === 'string' &&
  path.resolve(argv1) === path.resolve(new URL(import.meta.url).pathname);

if (isDirectExecution) {
  runMigrations()
    .then(() => {
      console.log('[db:migrate] PostgreSQL migrations applied successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[db:migrate] Migration failed:', err);
      process.exit(1);
    });
}
