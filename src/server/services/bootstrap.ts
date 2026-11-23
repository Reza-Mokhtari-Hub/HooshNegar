import { and, count, eq } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import { runMigrations } from '../../db/migrate.ts';
import {
  adminUsers,
  aiModels,
  aiProviders,
  notificationTemplates,
  referralProgramSettings,
  subscriptionPlans,
  systemSettings,
  telegramBotSettings,
} from '../../db/schema.ts';
import { getCloudflareAiBinding } from '../cloudflare/requestContext.ts';
import {
  CLOUDFLARE_WORKERS_AI_CURATED_MODELS,
  syncProviderModelsToDatabase,
} from '../providers/discovery.ts';
import { hashPassword } from '../security/password.ts';
import { recordAuditLog } from '../security/audit.ts';

let bootstrapPromise: Promise<void> | null = null;
let cloudflareAiSeeded = false;

export const DEFAULT_SYSTEM_SETTINGS = {
  appName: 'هوش‌نگار',
  logoUrl: '',
  primaryColor: '#1D4ED8',
  accentColor: '#0F172A',
  defaultTimezone: 'Asia/Tehran',
  defaultLanguage: 'fa',
  supportContact: '',
  maintenanceMode: false,
  registrationEnabled: true,
  defaultUserPlanId: '',
  globalRequestsPerMinute: 120,
  globalRequestsPerDay: 25000,
  creditValueUsd: 0.01,
  starValueUsd: 0.013,
  lowCreditThreshold: 15,
  allowNegativeBalance: false,
  dataRetentionDays: 365,
};

export const DEFAULT_NOTIFICATION_TEMPLATES = [
  {
    templateKey: 'payment_success',
    titleFa: 'تأیید پرداخت تلگرام استارز',
    bodyFa:
      '✅ پرداخت شما با موفقیت ثبت شد.\n\nشماره سفارش: {{orderNumber}}\nمبلغ: {{starsAmount}} ⭐️\nعنوان: {{itemName}}\nموجودی فعلی: {{balance}} اعتبار',
    bodyEn:
      '✅ Your Telegram Stars payment succeeded.\nOrder: {{orderNumber}}\nAmount: {{starsAmount}} ⭐\nItem: {{itemName}}\nBalance: {{balance}} credits',
  },
  {
    templateKey: 'subscription_activated',
    titleFa: 'فعال‌سازی اشتراک',
    bodyFa:
      '💎 اشتراک «{{planName}}» با موفقیت فعال شد.\nتاریخ انقضا: {{endsAt}}\nاعتبار اضافه‌شده: {{creditsAdded}}',
    bodyEn:
      '💎 Subscription "{{planName}}" is now active.\nExpires: {{endsAt}}\nCredits granted: {{creditsAdded}}',
  },
  {
    templateKey: 'subscription_expired',
    titleFa: 'پایان اعتبار اشتراک',
    bodyFa:
      '⏳ اشتراک «{{planName}}» شما به پایان رسید. برای ادامه استفاده از مدل‌های پیشرفته از بخش 💎 اشتراک و تعرفه‌ها تمدید کنید.',
    bodyEn:
      '⏳ Your "{{planName}}" subscription has expired. Renew anytime from /buy.',
  },
  {
    templateKey: 'renewal_upcoming',
    titleFa: 'یادآوری نزدیک شدن به پایان اشتراک',
    bodyFa:
      '🔔 اشتراک «{{planName}}» شما در تاریخ {{endsAt}} ({{daysLeft}} روز دیگر) به پایان می‌رسد.',
    bodyEn:
      '🔔 Your "{{planName}}" subscription ends on {{endsAt}} ({{daysLeft}} days left).',
  },
  {
    templateKey: 'renewal_failed',
    titleFa: 'خطا در تمدید اشتراک',
    bodyFa:
      '⚠️ تمدید خودکار اشتراک «{{planName}}» انجام نشد. لطفاً موجودی تلگرام استارز خود را بررسی کرده و از /buy اقدام نمایید.',
    bodyEn:
      '⚠️ Auto-renewal for "{{planName}}" failed. Please check your Telegram Stars balance and renew via /buy.',
  },
  {
    templateKey: 'low_credits',
    titleFa: 'هشدار کمبود اعتبار',
    bodyFa:
      '🪙 اعتبار حساب شما به {{balance}} واحد رسیده است. برای جلوگیری از توقف سرویس، از /buy بسته اعتبار یا اشتراک تهیه کنید.',
    bodyEn:
      '🪙 Your credit balance is low ({{balance}} credits remaining). Top up via /buy.',
  },
  {
    templateKey: 'referral_success',
    titleFa: 'پاداش معرفی دوستان',
    bodyFa:
      '🎁 تبریک! دعوت شما تکمیل شد و {{rewardSummary}} به حساب شما اضافه گردید.',
    bodyEn:
      '🎁 Congrats! Your referral qualified and {{rewardSummary}} was added to your account.',
  },
  {
    templateKey: 'promo_reward',
    titleFa: 'دریافت هدیه یا اعتبار تبلیغاتی',
    bodyFa:
      '🎉 {{creditsAdded}} اعتبار هدیه بابت «{{reason}}» به کیف پول شما واریز شد.\nموجودی جدید: {{balance}} اعتبار',
    bodyEn:
      '🎉 {{creditsAdded}} promotional credits were added for "{{reason}}". New balance: {{balance}}.',
  },
  {
    templateKey: 'ai_completed',
    titleFa: 'تکمیل پردازش هوش مصنوعی',
    bodyFa:
      '✅ درخواست {{capability}} شما با مدل {{modelName}} با موفقیت تکمیل شد.',
    bodyEn:
      '✅ Your {{capability}} request with {{modelName}} completed successfully.',
  },
  {
    templateKey: 'ai_failed',
    titleFa: 'خطا در پردازش هوش مصنوعی',
    bodyFa:
      '❌ پردازش درخواست {{capability}} ناموفق بود. در صورت کسر اعتبار، مبلغ به کیف پول شما بازگردانده شد.',
    bodyEn:
      '❌ Your {{capability}} request failed. Any reserved credits have been refunded.',
  },
] as const;

export async function ensureCloudflareWorkersAiSeeded(): Promise<void> {
  if (cloudflareAiSeeded || !getCloudflareAiBinding()) {
    return;
  }

  try {
    const db = getDb();
    const existing = await db
      .select({ id: aiProviders.id })
      .from(aiProviders)
      .where(eq(aiProviders.providerType, 'cloudflare_workers_ai'))
      .limit(1);

    let providerId = existing[0]?.id;
    const now = new Date();

    if (!providerId) {
      const [created] = await db
        .insert(aiProviders)
        .values({
          name: 'Cloudflare Workers AI (رایگان)',
          slug: 'cloudflare-workers-ai-free',
          providerType: 'cloudflare_workers_ai',
          baseUrl: 'https://api.cloudflare.com/client/v4',
          connectionStatus: 'connected',
          lastTestLatencyMs: 1,
          lastTestMessage: 'اتصال بومی Cloudflare Workers AI فعال است (۱۰,۰۰۰ Neuron رایگان روزانه).',
          lastTestedAt: now,
          isActive: true,
          priority: 15,
        })
        .onConflictDoNothing()
        .returning({ id: aiProviders.id });

      if (created) {
        providerId = created.id;
      } else {
        const [reloaded] = await db
          .select({ id: aiProviders.id })
          .from(aiProviders)
          .where(eq(aiProviders.providerType, 'cloudflare_workers_ai'))
          .limit(1);
        providerId = reloaded?.id;
      }
    }

    if (providerId) {
      await syncProviderModelsToDatabase({
        providerId,
        providerType: 'cloudflare_workers_ai',
        discoveredModels: CLOUDFLARE_WORKERS_AI_CURATED_MODELS,
        activateAll: true,
      });

      // Clean legacy provider suffixes on previously auto-seeded Cloudflare models so customers only see clean model names
      const legacyRenameMap: Array<{ modelIdentifier: string; cleanName: string }> = [
        { modelIdentifier: '@cf/black-forest-labs/flux-1-schnell', cleanName: 'FLUX.1 Schnell' },
        { modelIdentifier: '@cf/bytedance/stable-diffusion-xl-lightning', cleanName: 'SDXL Lightning' },
        { modelIdentifier: '@cf/stabilityai/stable-diffusion-xl-base-1.0', cleanName: 'Stable Diffusion XL' },
        { modelIdentifier: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', cleanName: 'Llama 3.3 70B Fast' },
      ];
      for (const item of legacyRenameMap) {
        await db
          .update(aiModels)
          .set({ name: item.cleanName, updatedAt: now })
          .where(
            and(
              eq(aiModels.providerId, providerId),
              eq(aiModels.modelIdentifier, item.modelIdentifier),
            ),
          );
      }

      // Elevate FLUX.1 Schnell so fast image generation appears first in Telegram & Mini App
      const existingDefaultImage = await db
        .select({ id: aiModels.id })
        .from(aiModels)
        .where(and(eq(aiModels.category, 'image'), eq(aiModels.isDefault, true)))
        .limit(1);

      await db
        .update(aiModels)
        .set({
          priority: 15,
          ...(existingDefaultImage.length === 0 ? { isDefault: true } : {}),
          updatedAt: now,
        })
        .where(
          and(
            eq(aiModels.providerId, providerId),
            eq(aiModels.modelIdentifier, '@cf/black-forest-labs/flux-1-schnell'),
          ),
        );
    }

    cloudflareAiSeeded = true;
  } catch (err) {
    console.warn(
      '[bootstrap:cloudflare-ai]',
      err instanceof Error ? err.message : 'Unable to auto-seed Cloudflare Workers AI',
    );
  }
}

export async function ensurePlatformReady(): Promise<void> {
  if (bootstrapPromise) {
    await bootstrapPromise;
    await ensureCloudflareWorkersAiSeeded();
    return;
  }

  bootstrapPromise = (async () => {
    await runMigrations();
    const db = getDb();

    // 1. Ensure singleton Telegram bot configuration row exists
    const existingTg = await db
      .select({ id: telegramBotSettings.id })
      .from(telegramBotSettings)
      .where(eq(telegramBotSettings.singletonKey, 'primary'))
      .limit(1);

    if (existingTg.length === 0) {
      await db
        .insert(telegramBotSettings)
        .values({ singletonKey: 'primary' })
        .onConflictDoNothing();
    }

    // 2. Ensure singleton referral program settings row exists
    const existingRefSettings = await db
      .select({ id: referralProgramSettings.id })
      .from(referralProgramSettings)
      .where(eq(referralProgramSettings.singletonKey, 'primary'))
      .limit(1);

    if (existingRefSettings.length === 0) {
      await db
        .insert(referralProgramSettings)
        .values({ singletonKey: 'primary' })
        .onConflictDoNothing();
    }

    // 3. Ensure default notification templates exist
    const existingTemplates = await db
      .select({ key: notificationTemplates.templateKey })
      .from(notificationTemplates);
    const templateKeySet = new Set(existingTemplates.map((t) => t.key));
    const missingTemplates = DEFAULT_NOTIFICATION_TEMPLATES.filter(
      (t) => !templateKeySet.has(t.templateKey),
    );
    if (missingTemplates.length > 0) {
      await db
        .insert(notificationTemplates)
        .values(
          missingTemplates.map((t) => ({
            templateKey: t.templateKey,
            titleFa: t.titleFa,
            bodyFa: t.bodyFa,
            bodyEn: t.bodyEn,
            isEnabled: true,
          })),
        )
        .onConflictDoNothing();
    }

    // 4. Ensure a default Free subscription plan exists for Telegram onboarding
    const existingPlans = await db
      .select({ id: subscriptionPlans.id, slug: subscriptionPlans.slug })
      .from(subscriptionPlans)
      .limit(1);

    let defaultFreePlanId = '';
    if (existingPlans.length === 0) {
      const [createdPlan] = await db
        .insert(subscriptionPlans)
        .values({
          name: 'پلن رایگان شروع',
          slug: 'free-default',
          tier: 'free',
          description: 'پلن پیش‌فرض رایگان برای کاربران جدید ربات تلگرام',
          priceAmount: '0',
          currency: 'XTR',
          starsPrice: 0,
          billingInterval: 'monthly',
          isRecurringStars: false,
          durationDays: 365,
          allowedProviderIds: [],
          availableModelIds: [],
          dailyRequestLimit: 30,
          monthlyRequestLimit: 500,
          dailyTextLimit: 30,
          textGenerationLimit: 500,
          dailyImageLimit: 5,
          imageGenerationLimit: 10,
          audioGenerationLimit: 15,
          dailyVideoLimit: 1,
          videoGenerationLimit: 2,
          maxFileSizeMb: 10,
          maxContextLength: 16000,
          maxConcurrentTasks: 2,
          creditAllocation: 50,
          priorityQueue: false,
          features: ['دسترسی به مدل‌های پایه متنی', 'پشتیبانی فارسی'],
          restrictions: ['اولویت عادی در صف پردازش'],
          isEnabled: true,
          sortOrder: 0,
        })
        .onConflictDoNothing()
        .returning({ id: subscriptionPlans.id });
      defaultFreePlanId = createdPlan?.id ?? '';
    } else {
      defaultFreePlanId = existingPlans[0]?.id ?? '';
    }

    // 5. Ensure core system_settings keys exist
    const existingSettings = await db
      .select({ key: systemSettings.settingKey })
      .from(systemSettings);
    const existingSet = new Set(existingSettings.map((r) => r.key));

    const toInsert = Object.entries({
      ...DEFAULT_SYSTEM_SETTINGS,
      defaultUserPlanId: defaultFreePlanId,
    })
      .filter(([key]) => !existingSet.has(key))
      .map(([settingKey, value]) => ({
        settingKey,
        value,
        category:
          settingKey.includes('Color') || settingKey === 'appName' || settingKey === 'logoUrl'
            ? 'branding'
            : settingKey.includes('Requests') ||
                settingKey.includes('Mode') ||
                settingKey.includes('registration')
              ? 'operations'
              : settingKey.includes('Usd') ||
                  settingKey.includes('Credit') ||
                  settingKey.includes('Balance')
                ? 'billing'
                : 'general',
        isSecret: false,
      }));

    if (toInsert.length > 0) {
      await db.insert(systemSettings).values(toInsert).onConflictDoNothing();
    }

    // 6. Seed initial super_admin strictly from environment variables (never hardcoded)
    const initialEmail = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
    const initialPassword = process.env.INITIAL_ADMIN_PASSWORD?.trim();
    const initialName = process.env.INITIAL_ADMIN_NAME?.trim() || 'مدیر ارشد سیستم';

    if (initialEmail && initialPassword && initialPassword.length >= 12) {
      const [countRow] = await db.select({ total: count() }).from(adminUsers);
      if ((countRow?.total ?? 0) === 0) {
        const passwordHash = await hashPassword(initialPassword);
        const [created] = await db
          .insert(adminUsers)
          .values({
            email: initialEmail,
            fullName: initialName,
            passwordHash,
            role: 'super_admin',
            permissions: ['*'],
            status: 'active',
          })
          .onConflictDoNothing()
          .returning({ id: adminUsers.id, email: adminUsers.email });

        if (created) {
          await recordAuditLog({
            adminUserId: created.id,
            actorEmail: created.email,
            action: 'admin.bootstrap_env',
            resourceType: 'admin_user',
            resourceId: created.id,
            severity: 'info',
            details: { source: 'environment_variables' },
          });
        }
      }
    }
  })();

  try {
    await bootstrapPromise;
    await ensureCloudflareWorkersAiSeeded();
  } catch (err) {
    bootstrapPromise = null;
    throw err;
  }
}

export function resetBootstrapCacheForTests(): void {
  bootstrapPromise = null;
  cloudflareAiSeeded = false;
}
