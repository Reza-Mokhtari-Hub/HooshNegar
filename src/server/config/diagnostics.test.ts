import { describe, it, expect } from 'vitest';
import { buildRuntimeDiagnostics, classifyDatabaseError } from './diagnostics.ts';

describe('Runtime Self-Diagnostics', () => {
  it('detects Cloudflare Build-vs-Runtime misconfiguration when only ASSETS is bound', () => {
    const report = buildRuntimeDiagnostics({
      envMap: {},
      isCloudflare: true,
      isProduction: true,
      boundEnvKeys: ['ASSETS'],
    });

    expect(report.ready).toBe(false);
    expect(report.runtime).toBe('cloudflare_workers');
    expect(report.databaseMode).toBe('embedded_pglite');
    expect(report.missingRequiredVars).toEqual([
      'DATABASE_URL',
      'ENCRYPTION_MASTER_KEY',
      'SESSION_SECRET',
    ]);
    expect(report.probableCause).toContain('Build');
    expect(report.fixSteps.length).toBeGreaterThanOrEqual(2);
  });

  it('marks Cloudflare Worker ready when all required runtime secrets are valid without leaking values', () => {
    const report = buildRuntimeDiagnostics({
      envMap: {
        DATABASE_URL:
          'postgresql://user:supersecret@ep-demo.us-east-2.aws.neon.tech/neondb?sslmode=require',
        ENCRYPTION_MASTER_KEY: 'a'.repeat(64),
        SESSION_SECRET: 's'.repeat(40),
        APP_URL: 'https://hooshnegar.reza2015zzzx.workers.dev',
      },
      isCloudflare: true,
      isProduction: true,
      boundEnvKeys: ['APP_URL', 'ASSETS', 'DATABASE_URL', 'ENCRYPTION_MASTER_KEY', 'SESSION_SECRET'],
      dbProbe: { ok: true, latencyMs: 42 },
    });

    expect(report.ready).toBe(true);
    expect(report.databaseMode).toBe('neon_postgres');
    expect(report.missingRequiredVars).toEqual([]);
    expect(report.invalidVars).toEqual([]);
    expect(report.probableCause).toBeNull();

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('supersecret');
    expect(serialized).not.toContain('a'.repeat(32));
    expect(serialized).not.toContain('s'.repeat(32));
  });

  it('flags invalid secret formats without leaking secret values', () => {
    const report = buildRuntimeDiagnostics({
      envMap: {
        DATABASE_URL: 'mysql://bad-secret-value/db',
        ENCRYPTION_MASTER_KEY: 'too-short-secret-key',
        SESSION_SECRET: 'short',
        APP_URL: 'hooshnegar.workers.dev',
      },
      isCloudflare: true,
      isProduction: true,
      boundEnvKeys: ['APP_URL', 'ASSETS', 'DATABASE_URL', 'ENCRYPTION_MASTER_KEY', 'SESSION_SECRET'],
    });

    expect(report.ready).toBe(false);
    expect(report.invalidVars).toHaveLength(4);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('bad-secret-value');
    expect(serialized).not.toContain('too-short-secret-key');
  });

  it('maps common PostgreSQL failures to actionable Persian hints', () => {
    const authErr = classifyDatabaseError('error: password authentication failed for user "neondb_owner"');
    expect(authErr.hint).toContain('رمز عبور');

    const tableErr = classifyDatabaseError('relation "admin_users" does not exist');
    expect(tableErr.hint).toContain('db:migrate');

    const sslErr = classifyDatabaseError('connection requires SSL');
    expect(sslErr.hint).toContain('sslmode=require');
  });

  it('marks Cloudflare Worker ready with Cloudflare Durable Object SQLite even when DATABASE_URL is absent', () => {
    const report = buildRuntimeDiagnostics({
      envMap: {
        ENCRYPTION_MASTER_KEY: 'b'.repeat(64),
        SESSION_SECRET: 's'.repeat(40),
      },
      isCloudflare: true,
      isProduction: true,
      hasDurableObjectStore: true,
      boundEnvKeys: ['ASSETS', 'STATE_DB'],
      dbProbe: { ok: true, latencyMs: 3 },
    });

    expect(report.ready).toBe(true);
    expect(report.databaseMode).toBe('cloudflare_durable_object');
    expect(report.missingRequiredVars).toEqual([]);
    expect(report.probableCause).toBeNull();
  });
});
