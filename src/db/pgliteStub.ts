/**
 * Cloudflare Workers build-time stub for @electric-sql/pglite and drizzle-orm/pglite.
 * Aliased exclusively in wrangler.jsonc so local PGlite WASM (~10 MB) is never bundled into
 * Cloudflare Workers, which connect directly to Neon PostgreSQL over HTTPS via @neondatabase/serverless.
 */

export class PGlite {
  constructor() {
    throw new Error(
      'Embedded PGlite is only available in local Node.js development/tests. Configure DATABASE_URL (Neon PostgreSQL) in Cloudflare Workers Secrets.',
    );
  }
}

export function drizzle(): never {
  throw new Error(
    'drizzle-orm/pglite is disabled on Cloudflare Workers. Set DATABASE_URL to your Neon PostgreSQL connection string.',
  );
}

export async function migrate(): Promise<void> {
  // Migrations on Cloudflare deployments are executed via `npm run db:migrate` against Neon PostgreSQL.
}
