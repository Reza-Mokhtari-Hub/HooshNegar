import fs from 'node:fs';
import path from 'node:path';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { migrate as migrateNeon } from 'drizzle-orm/neon-http/migrator';
import { getDb, getDatabaseMode } from './index.ts';

let migrationPromise: Promise<void> | null = null;

export async function runMigrations(): Promise<void> {
  if (migrationPromise) {
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

// Allow running directly via `npm run db:migrate`
const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

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
