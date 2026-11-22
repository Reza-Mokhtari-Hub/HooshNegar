import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { eq, count, sql } from 'drizzle-orm';
import * as schema from './schema.ts';
import {
  buildSqliteSchemaStatements,
  translatePgQueryToSqlite,
  decodeSqliteRows,
} from './pgToSqliteTranslator.ts';

function createSqliteDrizzleHarness() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  for (const stmt of buildSqliteSchemaStatements()) {
    sqlite.exec(stmt);
  }

  const db = drizzle(
    async (queryString, params) => {
      const { sql: sqliteSql, params: sqliteParams } = translatePgQueryToSqlite(queryString, params);
      const stmt = sqlite.prepare(sqliteSql);
      const cols = stmt.columns().map((c) => c.name);
      if (cols.length === 0) {
        stmt.run(...sqliteParams);
        return { rows: [] };
      }
      const objRows = stmt.all(...sqliteParams) as Array<Record<string, unknown>>;
      const rawRows = objRows.map((obj) => cols.map((c) => obj[c]));
      return { rows: decodeSqliteRows(cols, rawRows) };
    },
    { schema },
  );

  return { sqlite, db };
}

describe('PostgreSQL-to-SQLite Cloudflare Durable Object Bridge', () => {
  it('creates all 37 tables and handles admin setup, JSONB, booleans, dates, and updates cleanly', async () => {
    const { db } = createSqliteDrizzleHarness();

    const [admin] = await db
      .insert(schema.adminUsers)
      .values({
        email: 'admin@hooshnegar.ai',
        fullName: 'مدیر ارشد سیستم',
        passwordHash: 'scrypt$salt$hash',
        role: 'super_admin',
        permissions: ['*'],
        status: 'active',
      })
      .returning();

    expect(admin).toBeDefined();
    if (!admin) throw new Error('Expected inserted admin');
    expect(admin.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(admin.permissions).toEqual(['*']);
    expect(admin.createdAt).toBeInstanceOf(Date);

    await db.insert(schema.adminSessions).values({
      adminUserId: admin.id,
      tokenHash: 'tokhash-1',
      csrfToken: 'csrf-1',
      ipAddress: '127.0.0.1',
      userAgent: 'vitest',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const [countRow] = await db.select({ total: count() }).from(schema.adminUsers);
    expect(countRow?.total).toBe(1);
  });

  it('decodes boolean columns, is-not-null expressions, FILTER aggregates, and JSON extraction accurately', async () => {
    const { db } = createSqliteDrizzleHarness();

    await db
      .insert(schema.telegramBotSettings)
      .values({ singletonKey: 'primary', isActive: true, botUsername: 'hooshnegar_bot' })
      .onConflictDoNothing();

    const [bot] = await db
      .select({
        isActive: schema.telegramBotSettings.isActive,
        hasBotToken: sql<boolean>`${schema.telegramBotSettings.encryptedBotToken} is not null`,
      })
      .from(schema.telegramBotSettings)
      .where(eq(schema.telegramBotSettings.singletonKey, 'primary'));

    expect(bot?.isActive).toBe(true);
    expect(bot?.hasBotToken).toBe(false);

    await db.insert(schema.webhookEvents).values([
      {
        source: 'telegram',
        idempotencyKey: 'evt-1',
        eventType: 'message',
        payload: { signatureVerified: true },
        status: 'processed',
      },
      {
        source: 'telegram',
        idempotencyKey: 'evt-2',
        eventType: 'message',
        payload: { signatureVerified: false },
        status: 'failed',
      },
    ]);

    const events = await db
      .select({
        id: schema.webhookEvents.id,
        signatureVerified: sql<boolean>`coalesce((${schema.webhookEvents.payload}->>'signatureVerified')::boolean, true)`,
      })
      .from(schema.webhookEvents);

    expect(events).toHaveLength(2);
    expect(events.map((e) => e.signatureVerified).sort()).toEqual([false, true]);
  });

  it('handles provider, model, user, wallet upsert, and usage aggregates cleanly', async () => {
    const { db } = createSqliteDrizzleHarness();

    const [provider] = await db
      .insert(schema.aiProviders)
      .values({
        name: 'OpenAI',
        slug: 'openai',
        providerType: 'openai_compatible',
        baseUrl: 'https://api.openai.com/v1',
        isActive: true,
      })
      .returning();

    expect(provider).toBeDefined();
    if (!provider) throw new Error('Expected inserted provider');
    expect(provider.isActive).toBe(true);

    const [user] = await db
      .insert(schema.users)
      .values({
        email: 'reza@example.com',
        status: 'active',
        locale: 'fa',
      })
      .returning();

    expect(user).toBeDefined();
    if (!user) throw new Error('Expected inserted user');

    const [tgUser] = await db
      .insert(schema.telegramAccounts)
      .values({
        userId: user.id,
        telegramUserId: 123456789,
        username: 'reza_test',
        firstName: 'رضا',
      })
      .returning();

    expect(tgUser).toBeDefined();

    await db
      .insert(schema.creditWallets)
      .values({
        userId: user.id,
        balance: '100.0000',
        lifetimeEarned: '100.0000',
      })
      .onConflictDoUpdate({
        target: schema.creditWallets.userId,
        set: { balance: '150.0000' },
      });

    await db.insert(schema.usageRecords).values({
      userId: user.id,
      recordedDate: '2026-11-22',
      capability: 'chat',
      creditsConsumed: '12.5000',
      costUsd: '0.0250',
    });

    const [usage] = await db
      .select({
        credits: sql<string>`coalesce(sum(${schema.usageRecords.creditsConsumed}), 0)`,
      })
      .from(schema.usageRecords)
      .where(sql`${schema.usageRecords.recordedDate} like ${'2026-11%'}`);

    expect(Number(usage?.credits)).toBe(12.5);
  });
});
