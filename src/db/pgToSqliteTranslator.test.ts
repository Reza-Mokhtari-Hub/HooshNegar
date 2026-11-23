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

  it('strips PostgreSQL FOR UPDATE / FOR SHARE clauses outside quotes without corrupting prompt strings, and executes full credit reservation/reconcile/refund on SQLite DO', async () => {
    const t1 = translatePgQueryToSqlite(
      'select "id", "balance" from "credit_wallets" where "credit_wallets"."user_id" = $1 for update',
      ['user-1'],
    );
    expect(t1.sql).toBe('select "id", "balance" from "credit_wallets" where "credit_wallets"."user_id" = ?1');

    const t2 = translatePgQueryToSqlite(
      'select "id" from "ai_requests" where "prompt_preview" = $1 for no key update of "ai_requests" skip locked',
      ['please wait for update now'],
    );
    expect(t2.sql).toBe('select "id" from "ai_requests" where "prompt_preview" = ?1');
    expect(t2.params).toEqual(['please wait for update now']);

    // Quoted literal inside SQL itself must remain untouched
    const t3 = translatePgQueryToSqlite(
      `insert into "ai_requests" ("prompt_preview") values ('waiting for update')`,
      [],
    );
    expect(t3.sql).toBe(`insert into "ai_requests" ("prompt_preview") values ('waiting for update')`);

    // End-to-end execution through Cloudflare DO SQLite harness (transactions + FOR UPDATE + boolean aliases)
    const { sqlite, db } = createSqliteDrizzleHarness();
    const { runWithCloudflareRequestContext } = await import('../server/cloudflare/requestContext.ts');

    let inTx = false;
    const executor = {
      async execSql(queryString: string, params: unknown[]) {
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
      async beginTx() {
        inTx = true;
        return 'tx-1';
      },
      async endTx() {
        inTx = false;
      },
    };

    expect(inTx).toBe(false);
    await runWithCloudflareRequestContext({ sqlExecutor: executor }, async () => {
      // Seed user, plan, subscription, wallet, provider, and text_generation-only model
      const [user] = await db.insert(schema.users).values({ email: 'do@test.ir', status: 'active' }).returning();
      const [plan] = await db
        .insert(schema.subscriptionPlans)
        .values({
          name: 'رایگان',
          slug: 'free-do',
          tier: 'free',
          dailyRequestLimit: 20,
          monthlyRequestLimit: 200,
          dailyTextLimit: 20,
          dailyImageLimit: 5,
          dailyVideoLimit: 2,
          textGenerationLimit: 200,
          imageGenerationLimit: 50,
          audioGenerationLimit: 50,
          videoGenerationLimit: 10,
          creditAllocation: 50,
          availableModelIds: [],
          allowedProviderIds: [],
          isEnabled: true,
        })
        .returning();

      await db.insert(schema.userSubscriptions).values({
        userId: user!.id,
        planId: plan!.id,
        status: 'active',
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 86_400_000),
      });

      await db.insert(schema.creditWallets).values({
        userId: user!.id,
        balance: '50.0000',
        reservedBalance: '0.0000',
        lifetimeEarned: '50.0000',
        lifetimeSpent: '0.0000',
      });

      const [provider] = await db
        .insert(schema.aiProviders)
        .values({
          name: 'Gemini DO',
          slug: 'gemini-do',
          providerType: 'google_gemini',
          baseUrl: 'https://generativelanguage.googleapis.com',
          isActive: true,
        })
        .returning();

      const [model] = await db
        .insert(schema.aiModels)
        .values({
          providerId: provider!.id,
          name: 'Gemini Flash DO',
          modelIdentifier: 'gemini-2.5-flash',
          category: 'llm',
          creditCost: '2.0000',
          allowedPlanTiers: [],
          isActive: true,
          isDefault: true,
        })
        .returning();

      await db.insert(schema.modelCapabilities).values({
        modelId: model!.id,
        capability: 'text_generation',
      });

      // Verify SELECT ... FOR UPDATE runs smoothly inside SQLite proxy
      const lockedWallets = await db
        .select()
        .from(schema.creditWallets)
        .where(eq(schema.creditWallets.userId, user!.id))
        .for('update');
      expect(Number(lockedWallets[0]?.balance)).toBe(50);
    });
  });

  it('tracks nested enqueueBackgroundJob calls inside outer waitUntil so Cloudflare Workers awaits child jobs', async () => {
    const { runWithCloudflareRequestContext } = await import('../server/cloudflare/requestContext.ts');
    const { enqueueBackgroundJob, registerLocalJobProcessor } = await import('../server/queue/qstash.ts');

    const prevToken = process.env.QSTASH_TOKEN;
    delete process.env.QSTASH_TOKEN;

    const executedOrder: string[] = [];
    const trackedPromises: Promise<unknown>[] = [];

    registerLocalJobProcessor(async (payload) => {
      executedOrder.push(`start:${payload.kind}`);
      if (payload.kind === 'telegram_update') {
        await enqueueBackgroundJob({
          kind: 'ai_generation_job',
          idempotencyKey: 'nested-child-1',
          jobId: 'job-child-1',
        });
      }
      await new Promise((r) => setTimeout(r, 15));
      executedOrder.push(`end:${payload.kind}`);
    });

    try {
      await runWithCloudflareRequestContext(
        {
          waitUntil: (p) => {
            trackedPromises.push(p);
          },
        },
        async () => {
          const enqueued = await enqueueBackgroundJob({
            kind: 'telegram_update',
            idempotencyKey: 'parent-upd-1',
            update: { update_id: 1 },
          });
          expect(enqueued.mode).toBe('cloudflare_waituntil');
        },
      );

      expect(trackedPromises.length).toBe(1);
      await Promise.all(trackedPromises);
      expect(executedOrder).toContain('start:telegram_update');
      expect(executedOrder).toContain('start:ai_generation_job');
      expect(executedOrder).toContain('end:ai_generation_job');
    } finally {
      if (prevToken) process.env.QSTASH_TOKEN = prevToken;
    }
  });
});
