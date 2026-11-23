import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface EnvValidationResult {
  nodeEnv: 'development' | 'production' | 'test';
  isProduction: boolean;
  isCloudflare: boolean;
  appUrl: string;
  databaseMode: 'neon_postgres' | 'cloudflare_durable_object' | 'embedded_pglite';
  encryptionConfigured: boolean;
  encryptionSource: 'env' | 'dev_local_file' | 'missing';
  sessionSecretSource: 'env' | 'dev_local_file' | 'missing';
  initialAdminEnvConfigured: boolean;
  qstashConfigured: boolean;
  r2Configured: boolean;
  aiMockMode: boolean;
  warnings: string[];
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DEV_KEYS_FILE = path.join(DATA_DIR, '.dev-runtime-keys.json');

interface DevRuntimeKeys {
  encryptionMasterKey: string;
  sessionSecret: string;
}

let cachedDevKeys: DevRuntimeKeys | null = null;

export function isCloudflareWorker(): boolean {
  if (process.env.CF_WORKER === '1') {
    return true;
  }
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  return nav?.userAgent === 'Cloudflare-Workers';
}

function hasCloudflareDurableObjectStore(): boolean {
  return Boolean((globalThis as { _hooshnegarCfSqlExecutor?: unknown })._hooshnegarCfSqlExecutor);
}

function loadOrCreateDevKeys(): DevRuntimeKeys {
  if (cachedDevKeys) return cachedDevKeys;
  if (isCloudflareWorker()) {
    throw new Error(
      'ENCRYPTION_MASTER_KEY and SESSION_SECRET must be set as Cloudflare Workers Secrets or provisioned via STATE_DB.',
    );
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DEV_KEYS_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(DEV_KEYS_FILE, 'utf8')) as Partial<DevRuntimeKeys>;
    if (
      typeof parsed.encryptionMasterKey === 'string' &&
      /^[0-9a-fA-F]{64}$/.test(parsed.encryptionMasterKey) &&
      typeof parsed.sessionSecret === 'string' &&
      parsed.sessionSecret.length >= 32
    ) {
      cachedDevKeys = {
        encryptionMasterKey: parsed.encryptionMasterKey,
        sessionSecret: parsed.sessionSecret,
      };
      return cachedDevKeys;
    }
  }
  const generated: DevRuntimeKeys = {
    encryptionMasterKey: crypto.randomBytes(32).toString('hex'),
    sessionSecret: crypto.randomBytes(48).toString('base64url'),
  };
  fs.writeFileSync(DEV_KEYS_FILE, JSON.stringify(generated, null, 2), { mode: 0o600 });
  cachedDevKeys = generated;
  return generated;
}

export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === 'production' || isCloudflareWorker();
}

export function getEncryptionMasterKeyHex(): string | null {
  const fromEnv = process.env.ENCRYPTION_MASTER_KEY?.trim();
  if (fromEnv) {
    if (/^[0-9a-fA-F]{64}$/.test(fromEnv)) {
      return fromEnv;
    }
    try {
      const buf = Buffer.from(fromEnv, 'base64');
      if (buf.length === 32) {
        return buf.toString('hex');
      }
    } catch {
      return null;
    }
    return null;
  }
  if (isProductionRuntime() || process.env.NODE_ENV === 'test') {
    return null;
  }
  return loadOrCreateDevKeys().encryptionMasterKey;
}

export function getSessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET?.trim();
  if (fromEnv && fromEnv.length >= 32) {
    return fromEnv;
  }
  if (isProductionRuntime()) {
    throw new Error('SESSION_SECRET environment variable must be set (min 32 chars) in production.');
  }
  return loadOrCreateDevKeys().sessionSecret;
}

export function isAiMockModeEnabled(): boolean {
  if (isProductionRuntime() && process.env.NODE_ENV === 'production') {
    // Strictly never allow mock mode in production deployments
    return false;
  }
  return process.env.AI_MOCK_MODE === 'true' || process.env.AI_MOCK_MODE === '1';
}

function normalizeQStashBaseUrl(rawUrl: string | undefined): string {
  const trimmed = rawUrl?.trim() ?? '';
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.origin;
    }
  } catch {
    // Ignore malformed URL and fall back to trimmed host without trailing slash
  }
  return trimmed.replace(/\/+$/, '');
}

function normalizeQStashTokenAndFallbackUrl(rawToken: string | undefined): {
  token: string;
  fallbackBaseUrl: string;
} {
  const trimmed = rawToken?.trim() ?? '';
  if (!trimmed) {
    return { token: '', fallbackBaseUrl: '' };
  }

  let candidate = trimmed;
  let fallbackBaseUrl = '';

  if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
    try {
      const parsed = new URL(candidate);
      fallbackBaseUrl = parsed.origin;
      const fromParam = parsed.searchParams.get('qstash_token')?.trim();
      if (fromParam) {
        candidate = fromParam;
      }
    } catch {
      // Keep original string if URL parsing fails
    }
  }

  if (candidate.includes('%')) {
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      // Keep original token if percent-decoding fails
    }
  }

  return { token: candidate.trim(), fallbackBaseUrl };
}

export function getQStashConfig(): {
  configured: boolean;
  baseUrl: string;
  token: string;
  currentSigningKey: string;
  nextSigningKey: string;
} {
  const explicitBaseUrl = normalizeQStashBaseUrl(process.env.QSTASH_URL);
  const parsedToken = normalizeQStashTokenAndFallbackUrl(process.env.QSTASH_TOKEN);
  const baseUrl = explicitBaseUrl || parsedToken.fallbackBaseUrl;
  const token = parsedToken.token;
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY?.trim() ?? '';
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY?.trim() ?? '';
  return {
    configured: Boolean(token && currentSigningKey),
    baseUrl,
    token,
    currentSigningKey,
    nextSigningKey,
  };
}

export function getR2Config(): {
  configured: boolean;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicBaseUrl: string;
} {
  const accountId = process.env.R2_ACCOUNT_ID?.trim() ?? '';
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim() ?? '';
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim() ?? '';
  const bucketName = process.env.R2_BUCKET_NAME?.trim() ?? '';
  const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL?.trim() ?? '';
  return {
    configured: Boolean(accountId && accessKeyId && secretAccessKey && bucketName),
    accountId,
    accessKeyId,
    secretAccessKey,
    bucketName,
    publicBaseUrl,
  };
}

export function getEnvValidationSummary(): EnvValidationResult {
  const nodeEnv =
    process.env.NODE_ENV === 'production'
      ? 'production'
      : process.env.NODE_ENV === 'test'
        ? 'test'
        : 'development';
  const isProd = isProductionRuntime();
  const isCloudflare = isCloudflareWorker();
  const appUrl = process.env.APP_URL?.trim() || 'http://localhost:3000';
  const hasDbUrl = Boolean(process.env.DATABASE_URL?.trim());
  const hasDoStore = hasCloudflareDurableObjectStore();
  const databaseMode: 'neon_postgres' | 'cloudflare_durable_object' | 'embedded_pglite' = hasDbUrl
    ? 'neon_postgres'
    : hasDoStore
      ? 'cloudflare_durable_object'
      : 'embedded_pglite';

  const envMasterKey = process.env.ENCRYPTION_MASTER_KEY?.trim();
  const envMasterKeyValid = Boolean(
    envMasterKey &&
      (/^[0-9a-fA-F]{64}$/.test(envMasterKey) || Buffer.from(envMasterKey, 'base64').length === 32),
  );

  let encryptionSource: 'env' | 'dev_local_file' | 'missing' = 'missing';
  if (envMasterKeyValid) {
    encryptionSource = 'env';
  } else if (!isProd && nodeEnv !== 'test') {
    loadOrCreateDevKeys();
    encryptionSource = 'dev_local_file';
  }

  const envSessionValid = Boolean(
    process.env.SESSION_SECRET?.trim() && process.env.SESSION_SECRET.trim().length >= 32,
  );
  let sessionSecretSource: 'env' | 'dev_local_file' | 'missing' = 'missing';
  if (envSessionValid) {
    sessionSecretSource = 'env';
  } else if (!isProd && nodeEnv !== 'test') {
    sessionSecretSource = 'dev_local_file';
  }

  const initialAdminEnvConfigured = Boolean(
    process.env.INITIAL_ADMIN_EMAIL?.trim() && process.env.INITIAL_ADMIN_PASSWORD?.trim(),
  );
  const qstashConfigured = getQStashConfig().configured;
  const r2Configured = getR2Config().configured;
  const aiMockMode = isAiMockModeEnabled();

  const warnings: string[] = [];
  if (!hasDbUrl && !hasDoStore) {
    warnings.push('DATABASE_URL تنظیم نشده است؛ از موتور محلی PostgreSQL (PGlite) استفاده می‌شود.');
  }
  if (encryptionSource !== 'env') {
    warnings.push(
      isProd
        ? 'ENCRYPTION_MASTER_KEY تنظیم نشده است؛ ذخیره اعتبارنامه‌های رمزنگاری‌شده غیرفعال است.'
        : 'ENCRYPTION_MASTER_KEY در محیط توسعه از فایل محلی موقت بارگذاری شده است. در تولید حتماً از متغیر محیطی استفاده کنید.',
    );
  }
  if (sessionSecretSource !== 'env') {
    warnings.push('SESSION_SECRET باید در محیط تولید حداقل ۳۲ کاراکتر تصادفی تنظیم شود.');
  }

  return {
    nodeEnv,
    isProduction: isProd,
    isCloudflare,
    appUrl,
    databaseMode,
    encryptionConfigured: encryptionSource !== 'missing',
    encryptionSource,
    sessionSecretSource,
    initialAdminEnvConfigured,
    qstashConfigured,
    r2Configured,
    aiMockMode,
    warnings,
  };
}
