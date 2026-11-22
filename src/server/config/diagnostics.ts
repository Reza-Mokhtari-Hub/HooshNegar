import { isCloudflareWorker, isProductionRuntime } from './env.ts';
import { redactSecrets } from '../security/crypto.ts';

export interface EnvVarCheckItem {
  name: string;
  required: boolean;
  status: 'ok' | 'missing' | 'invalid';
  detail: string;
}

export interface DbProbeResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  hint?: string;
}

export interface RuntimeDiagnosticsReport {
  ready: boolean;
  runtime: 'cloudflare_workers' | 'nodejs';
  databaseMode: 'neon_postgres' | 'cloudflare_durable_object' | 'embedded_pglite';
  checks: EnvVarCheckItem[];
  missingRequiredVars: string[];
  invalidVars: Array<{ name: string; reason: string }>;
  boundEnvKeys: string[];
  probableCause: string | null;
  fixSteps: string[];
  dbProbe?: DbProbeResult;
  error?: string;
}

export interface DiagnosticsInput {
  envMap?: Record<string, string | undefined>;
  isCloudflare?: boolean;
  isProduction?: boolean;
  hasDurableObjectStore?: boolean;
  boundEnvKeys?: string[];
  dbProbe?: DbProbeResult;
  rawError?: string;
}

function isValidMasterKey(value: string): boolean {
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return true;
  }
  try {
    return Buffer.from(value, 'base64').length === 32;
  } catch {
    return false;
  }
}

function isValidPostgresUrl(value: string): boolean {
  return (value.startsWith('postgres://') || value.startsWith('postgresql://')) && value.includes('@');
}

export function classifyDatabaseError(rawError: string): { safeError: string; hint: string } {
  const safeError = redactSecrets(rawError).slice(0, 400);
  const lower = safeError.toLowerCase();

  if (lower.includes('database_url') && lower.includes('required')) {
    return {
      safeError,
      hint: 'متغیر DATABASE_URL در بخش Runtime ورکر (Settings → Variables and Secrets) ثبت نشده است.',
    };
  }
  if (lower.includes('password authentication failed') || lower.includes('28p01')) {
    return {
      safeError,
      hint: 'نام کاربری یا رمز عبور داخل DATABASE_URL اشتباه است. رشته اتصال را دوباره از داشبورد Neon کپی کنید.',
    };
  }
  if (lower.includes('does not exist') && lower.includes('relation')) {
    return {
      safeError,
      hint: 'جداول دیتابیس روی این پایگاه‌داده ساخته نشده‌اند. مطمئن شوید دستور npm run db:migrate روی همین DATABASE_URL اجرا شده است.',
    };
  }
  if (lower.includes('does not exist') && lower.includes('database')) {
    return {
      safeError,
      hint: 'نام دیتابیس در انتهای DATABASE_URL وجود ندارد. آدرس کامل اتصال Neon را بررسی کنید.',
    };
  }
  if (lower.includes('enotfound') || lower.includes('getaddrinfo') || lower.includes('fetch failed')) {
    return {
      safeError,
      hint: 'آدرس هاست Neon در DATABASE_URL قابل دسترس نیست یا اشتباه تایپ شده است.',
    };
  }
  if (lower.includes('ssl') || lower.includes('tls')) {
    return {
      safeError,
      hint: 'اتصال Neon نیازمند SSL است. مطمئن شوید انتهای DATABASE_URL شامل ?sslmode=require است.',
    };
  }
  if (lower.includes('timeout') || lower.includes('etimedout')) {
    return {
      safeError,
      hint: 'پاسخ دیتابیس Neon زمان‌بر شد (احتمالاً دیتابیس در حالت Sleep بوده است). یک‌بار دیگر دکمه بررسی مجدد را بزنید.',
    };
  }

  return {
    safeError,
    hint: 'اتصال به دیتابیس برقرار نشد. وضعیت اتصال و تنظیمات ذخیره‌سازی را بررسی کنید.',
  };
}

export function buildRuntimeDiagnostics(input: DiagnosticsInput = {}): RuntimeDiagnosticsReport {
  const envMap = input.envMap ?? (process.env as Record<string, string | undefined>);
  const isCf = input.isCloudflare ?? isCloudflareWorker();
  const isProd = input.isProduction ?? (isCf || isProductionRuntime());
  const boundKeys =
    input.boundEnvKeys ??
    (globalThis as { _hooshnegarCfBoundKeys?: string[] })._hooshnegarCfBoundKeys ??
    [];
  const hasDoStore =
    input.hasDurableObjectStore ??
    (Boolean((globalThis as { _hooshnegarCfSqlExecutor?: unknown })._hooshnegarCfSqlExecutor) ||
      boundKeys.includes('STATE_DB'));

  const checks: EnvVarCheckItem[] = [];
  const missingRequiredVars: string[] = [];
  const invalidVars: Array<{ name: string; reason: string }> = [];

  // 1. Storage Backend (Cloudflare Durable Object SQLite or external Neon PostgreSQL)
  const dbUrl = envMap.DATABASE_URL?.trim() ?? '';
  const dbRequired = isCf && !hasDoStore;
  if (!dbUrl) {
    checks.push({
      name: hasDoStore ? 'CLOUDFLARE_DURABLE_SQLITE' : 'DATABASE_URL',
      required: dbRequired,
      status: dbRequired ? 'missing' : 'ok',
      detail: hasDoStore
        ? 'دیتابیس داخلی Cloudflare Durable Objects SQLite فعال و متصل است (بدون نیاز به دیتابیس خارجی)'
        : dbRequired
          ? 'تنظیم نشده (در نبود STATE_DB، رشته اتصال Neon PostgreSQL اجباری است)'
          : 'در حالت محلی از دیتابیس داخلی PGlite استفاده می‌شود',
    });
    if (dbRequired) missingRequiredVars.push('DATABASE_URL');
  } else if (!isValidPostgresUrl(dbUrl)) {
    const reason = 'باید با postgresql:// یا postgres:// شروع شود و شامل آدرس کامل Neon باشد';
    checks.push({ name: 'DATABASE_URL', required: dbRequired, status: 'invalid', detail: reason });
    invalidVars.push({ name: 'DATABASE_URL', reason });
  } else {
    checks.push({
      name: 'DATABASE_URL',
      required: dbRequired,
      status: 'ok',
      detail: 'رشته اتصال PostgreSQL معتبر شناسایی شد',
    });
  }

  // 2. ENCRYPTION_MASTER_KEY
  const masterKey = envMap.ENCRYPTION_MASTER_KEY?.trim() ?? '';
  if (!masterKey) {
    checks.push({
      name: 'ENCRYPTION_MASTER_KEY',
      required: isProd,
      status: isProd ? 'missing' : 'ok',
      detail: isProd
        ? 'تنظیم نشده (کلید ۶۴ کاراکتری Hex برای رمزنگاری کلیدهای API اجباری است)'
        : 'در حالت توسعه از کلید محلی موقت استفاده می‌شود',
    });
    if (isProd) missingRequiredVars.push('ENCRYPTION_MASTER_KEY');
  } else if (!isValidMasterKey(masterKey)) {
    const reason = 'طول یا فرمت نامعتبر است (باید دقیقاً ۶۴ کاراکتر هگزادسیمال یا ۳۲ بایت Base64 باشد)';
    checks.push({ name: 'ENCRYPTION_MASTER_KEY', required: isProd, status: 'invalid', detail: reason });
    invalidVars.push({ name: 'ENCRYPTION_MASTER_KEY', reason });
  } else {
    checks.push({
      name: 'ENCRYPTION_MASTER_KEY',
      required: isProd,
      status: 'ok',
      detail: 'کلید رمزنگاری ۲۵۶ بیتی آماده و فعال است',
    });
  }

  // 3. SESSION_SECRET
  const sessionSecret = envMap.SESSION_SECRET?.trim() ?? '';
  if (!sessionSecret) {
    checks.push({
      name: 'SESSION_SECRET',
      required: isProd,
      status: isProd ? 'missing' : 'ok',
      detail: isProd
        ? 'تنظیم نشده (حداقل ۳۲ کاراکتر تصادفی برای ورود و نشست ادمین اجباری است)'
        : 'در حالت توسعه از کلید محلی موقت استفاده می‌شود',
    });
    if (isProd) missingRequiredVars.push('SESSION_SECRET');
  } else if (sessionSecret.length < 32) {
    const reason = 'کوتاه‌تر از ۳۲ کاراکتر است';
    checks.push({ name: 'SESSION_SECRET', required: isProd, status: 'invalid', detail: reason });
    invalidVars.push({ name: 'SESSION_SECRET', reason });
  } else {
    checks.push({
      name: 'SESSION_SECRET',
      required: isProd,
      status: 'ok',
      detail: 'کلید امضای نشست آماده و فعال است',
    });
  }

  // 4. APP_URL
  const appUrl = envMap.APP_URL?.trim() ?? '';
  if (!appUrl) {
    checks.push({
      name: 'APP_URL',
      required: false,
      status: isCf ? 'missing' : 'ok',
      detail: isCf
        ? 'به صورت خودکار از دامنه درخواست فعلی تشخیص داده می‌شود'
        : 'مقدار پیش‌فرض http://localhost:3000 استفاده می‌شود',
    });
  } else if (!/^https?:\/\/.+/.test(appUrl)) {
    const reason = 'باید با https:// یا http:// شروع شود';
    checks.push({ name: 'APP_URL', required: false, status: 'invalid', detail: reason });
    invalidVars.push({ name: 'APP_URL', reason });
  } else {
    checks.push({
      name: 'APP_URL',
      required: false,
      status: 'ok',
      detail: 'آدرس عمومی برنامه تنظیم شده است',
    });
  }

  // 5. PAYMENT_PAYLOAD_SECRET (recommended)
  const paymentSecret = envMap.PAYMENT_PAYLOAD_SECRET?.trim() ?? '';
  if (!paymentSecret) {
    checks.push({
      name: 'PAYMENT_PAYLOAD_SECRET',
      required: false,
      status: 'missing',
      detail: 'اختیاری تا زمان فعال‌سازی پرداخت تلگرام استارز (پیشنهادی)',
    });
  } else if (paymentSecret.length < 16) {
    const reason = 'کوتاه‌تر از ۱۶ کاراکتر است';
    checks.push({ name: 'PAYMENT_PAYLOAD_SECRET', required: false, status: 'invalid', detail: reason });
    invalidVars.push({ name: 'PAYMENT_PAYLOAD_SECRET', reason });
  } else {
    checks.push({
      name: 'PAYMENT_PAYLOAD_SECRET',
      required: false,
      status: 'ok',
      detail: 'تنظیم شده است',
    });
  }

  // 6. CRON_SECRET (recommended)
  const cronSecret = envMap.CRON_SECRET?.trim() ?? '';
  if (!cronSecret) {
    checks.push({
      name: 'CRON_SECRET',
      required: false,
      status: 'missing',
      detail: 'اختیاری (Cron داخلی کلودفلر بدون نیاز به این کلید کار می‌کند)',
    });
  } else if (cronSecret.length < 16) {
    const reason = 'کوتاه‌تر از ۱۶ کاراکتر است';
    checks.push({ name: 'CRON_SECRET', required: false, status: 'invalid', detail: reason });
    invalidVars.push({ name: 'CRON_SECRET', reason });
  } else {
    checks.push({
      name: 'CRON_SECRET',
      required: false,
      status: 'ok',
      detail: 'تنظیم شده است',
    });
  }

  const databaseMode: 'neon_postgres' | 'cloudflare_durable_object' | 'embedded_pglite' =
    dbUrl && isValidPostgresUrl(dbUrl)
      ? 'neon_postgres'
      : hasDoStore
        ? 'cloudflare_durable_object'
        : 'embedded_pglite';

  const nonSystemKeys = boundKeys.filter(
    (k) => k !== 'ASSETS' && k !== 'MEDIA_BUCKET' && k !== 'STATE_DB',
  );
  let probableCause: string | null = null;
  const fixSteps: string[] = [];

  if (isCf && missingRequiredVars.length > 0 && !hasDoStore && nonSystemKeys.length === 0) {
    probableCause =
      'کلودفلر هیچ متغیر محیطی به زمان اجرای Worker ارسال نکرده است (فقط ASSETS متصل است). به احتمال بسیار زیاد متغیرها را در بخش «Build → Variables and secrets» وارد کرده‌اید که فقط زمان بیلد (مثل db:migrate) کار می‌کند و به سایت زنده نمی‌رسد.';
    fixSteps.push(
      'در داشبورد Cloudflare به مسیر Workers & Pages → hooshnegar → Settings → Variables and Secrets بروید (دقت کنید بخش Build نباشد!).',
      `متغیرهای الزامی (${missingRequiredVars.join(' ، ')}) را با دکمه + Add و نوع Secret اضافه کنید.`,
      'دکمه Deploy / Save پایین جدول را بزنید و سپس اینجا روی «بررسی مجدد اتصال» کلیک کنید.',
    );
  } else if (isCf && missingRequiredVars.length > 0) {
    probableCause = `برخی متغیرهای الزامی در زمان اجرای Worker یافت نشدند: ${missingRequiredVars.join(' ، ')}`;
    fixSteps.push(
      'در مسیر Workers & Pages → hooshnegar → Settings → Variables and Secrets کلیدهای قرمزرنگ جدول زیر را اضافه کنید و دکمه Deploy را بزنید.',
      'مطمئن شوید املای دقیق نام متغیرها با حروف بزرگ (UPPER_CASE) و بدون فاصله اضافی است.',
    );
  } else if (invalidVars.length > 0) {
    probableCause = `فرمت یا طول یک یا چند متغیر محیطی نامعتبر است: ${invalidVars.map((v) => v.name).join(' ، ')}`;
    fixSteps.push(
      'مقدار متغیرهای مشخص‌شده با وضعیت «نامعتبر» را در Settings → Variables and Secrets اصلاح و دوباره Deploy کنید.',
    );
  } else if (input.dbProbe && !input.dbProbe.ok) {
    probableCause = input.dbProbe.hint ?? 'اتصال به دیتابیس برقرار نشد.';
    fixSteps.push(
      'جزئیات خطای فنی زیر را بررسی کرده و پس از اصلاح، دکمه «بررسی مجدد اتصال» را بزنید.',
    );
  } else if (input.rawError) {
    const classified = classifyDatabaseError(input.rawError);
    probableCause = classified.hint;
    fixSteps.push(
      'جزئیات خطای فنی زیر را بررسی کرده و پس از اصلاح تنظیمات، دکمه «بررسی مجدد اتصال» را بزنید.',
    );
  }

  const ready =
    missingRequiredVars.length === 0 &&
    invalidVars.length === 0 &&
    (!input.dbProbe || input.dbProbe.ok) &&
    !input.rawError;

  return {
    ready,
    runtime: isCf ? 'cloudflare_workers' : 'nodejs',
    databaseMode,
    checks,
    missingRequiredVars,
    invalidVars,
    boundEnvKeys: boundKeys,
    probableCause,
    fixSteps,
    ...(input.dbProbe ? { dbProbe: input.dbProbe } : {}),
    ...(input.rawError ? { error: classifyDatabaseError(input.rawError).safeError } : {}),
  };
}
