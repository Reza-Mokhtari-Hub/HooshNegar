import { Bot, type Context } from 'grammy';
import type { Update } from 'grammy/types';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import {
  aiRequests,
  conversationMessages,
  conversations,
  creditPackages,
  generationJobs,
  payments,
  subscriptionPlans,
  supportTickets,
  telegramAccounts,
  telegramBotSettings,
  users,
} from '../../db/schema.ts';
import type { CapabilityType, ModelCategory } from '../../shared/validation.ts';
import { decryptSecret, redactSecrets } from '../security/crypto.ts';
import { enqueueBackgroundJob } from '../queue/qstash.ts';
import {
  reserveCreditsAndCreateRequest,
  UsageGuardError,
} from '../services/usageService.ts';
import {
  createTelegramStarsOrder,
  processSuccessfulTelegramPayment,
  validateTelegramPreCheckout,
} from '../services/telegramStarsService.ts';
import { cancelSubscriptionAutoRenewal } from '../services/subscriptionService.ts';
import {
  getReferralProgramConfig,
  redeemGiftCreditCoupon,
} from '../services/referralCouponService.ts';
import {
  ensureTelegramUser,
  getAvailableModelsForUser,
  getOrCreateActiveConversation,
  getUserRecentPayments,
  getUserReferralDashboard,
  getUserUsageSnapshot,
  resolveSelectedModelForCapability,
  updateTelegramUserState,
  type EnsuredTelegramUser,
} from './userService.ts';
import {
  buildAudioStudioKeyboard,
  buildBuyPlansKeyboard,
  buildConversationActionKeyboard,
  buildCreditPackagesKeyboard,
  buildDynamicModelsKeyboard,
  buildImageStudioKeyboard,
  buildMainMenuKeyboard,
  buildModelCategoryKeyboard,
  buildSettingsKeyboard,
  buildStopGenerationKeyboard,
  buildSupportCategoryKeyboard,
  buildVideoStudioKeyboard,
  MAIN_MENU_LABELS,
} from './keyboards.ts';
import { cancelActiveJobsForUser, executeQueuedGenerationJob } from './jobRunner.ts';
import { escapeTelegramHtml } from './formatter.ts';

async function loadBotConfig() {
  const db = getDb();
  const [cfg] = await db
    .select()
    .from(telegramBotSettings)
    .where(eq(telegramBotSettings.singletonKey, 'primary'))
    .limit(1);
  return cfg ?? null;
}

async function resolveContextUser(
  ctx: Context,
  referralCode?: string | null,
): Promise<EnsuredTelegramUser | null> {
  const from = ctx.from;
  const chatId = ctx.chat?.id ?? from?.id;
  if (!from || !chatId) return null;
  return ensureTelegramUser({
    telegramUserId: from.id,
    telegramChatId: chatId,
    username: from.username ?? null,
    firstName: from.first_name ?? null,
    lastName: from.last_name ?? null,
    languageCode: from.language_code ?? 'fa',
    isPremium: Boolean(from.is_premium),
    referralCode,
  });
}

async function safeAnswerCallback(ctx: Context, text?: string, alert = false): Promise<void> {
  try {
    await ctx.answerCallbackQuery({ text, show_alert: alert });
  } catch {
    // Gracefully ignore expired callback queries (>30s old)
  }
}

async function enqueueAiJobFromContext(params: {
  ctx: Context;
  ensured: EnsuredTelegramUser;
  capability: CapabilityType;
  promptPreview: string;
  idempotencyKey: string;
  conversationId?: string | null;
  jobPayload: Record<string, unknown>;
  statusText: string;
}): Promise<void> {
  const model = await resolveSelectedModelForCapability({
    userId: params.ensured.user.id,
    telegramAccount: params.ensured.telegramAccount,
    capability: params.capability,
  });

  if (!model) {
    await params.ctx.reply(
      '⚠️ در حال حاضر هیچ مدل فعالی با این قابلیت برای پلن شما تنظیم نشده است. از منوی «🧠 مدل‌های هوش مصنوعی» یا پنل مدیریت مدل‌ها را بررسی کنید.',
      { reply_markup: buildMainMenuKeyboard() },
    );
    return;
  }

  let reserved;
  try {
    reserved = await reserveCreditsAndCreateRequest({
      userId: params.ensured.user.id,
      modelId: model.id,
      capability: params.capability,
      idempotencyKey: params.idempotencyKey,
      conversationId: params.conversationId ?? null,
      telegramChatId: params.ctx.chat?.id ?? null,
      promptPreview: params.promptPreview,
      jobPayload: params.jobPayload,
    });
  } catch (err) {
    if (err instanceof UsageGuardError) {
      await params.ctx.reply(`⛔️ ${err.userMessageFa}`, {
        reply_markup: buildMainMenuKeyboard(),
      });
      return;
    }
    throw err;
  }

  if (reserved.alreadyExists) {
    return;
  }

  const statusMsg = await params.ctx.reply(
    `${params.statusText}\n🧠 مدل: ${model.name} (${model.providerName})`,
    {
      reply_markup: buildStopGenerationKeyboard(reserved.requestId),
    },
  );

  const db = getDb();
  await db
    .update(generationJobs)
    .set({
      statusMessageId: statusMsg.message_id,
      payload: {
        ...params.jobPayload,
        maxFileSizeMb: reserved.maxFileSizeMb,
      },
      updatedAt: new Date(),
    })
    .where(eq(generationJobs.id, reserved.jobId));

  await enqueueBackgroundJob(
    {
      kind: 'ai_generation_job',
      idempotencyKey: `job:${reserved.jobId}`,
      jobId: reserved.jobId,
      requestId: reserved.requestId,
    },
    { retries: 2 },
  );
}

async function sendModelsMenu(ctx: Context, ensured: EnsuredTelegramUser, categoryKey = 'menu') {
  if (categoryKey === 'menu') {
    await ctx.reply(
      '🧠 <b>انتخاب مدل هوش مصنوعی</b>\n\nفهرست زیر به‌صورت زنده از پایگاه‌داده سامانه و متناسب با اشتراک فعال شما بارگذاری می‌شود. دسته‌بندی مورد نظر را انتخاب کنید:',
      {
        parse_mode: 'HTML',
        reply_markup: buildModelCategoryKeyboard(),
      },
    );
    return;
  }

  const categoryMap: Record<string, ModelCategory | undefined> = {
    text: 'llm',
    image: 'image',
    video: 'video',
    audio: 'audio',
    multimodal: 'multimodal',
    document: 'document',
    all: undefined,
  };
  const models = await getAvailableModelsForUser({
    userId: ensured.user.id,
    category: categoryMap[categoryKey],
  });

  if (models.length === 0) {
    await ctx.reply(
      '⚠️ هیچ مدل فعالی در این دسته‌بندی برای پلن فعلی شما در دسترس نیست.',
      { reply_markup: buildModelCategoryKeyboard() },
    );
    return;
  }

  const selectedId =
    categoryKey === 'image'
      ? ensured.telegramAccount.selectedImageModelId
      : categoryKey === 'video'
        ? ensured.telegramAccount.selectedVideoModelId
        : categoryKey === 'audio'
          ? ensured.telegramAccount.selectedAudioModelId
          : categoryKey === 'multimodal'
            ? ensured.telegramAccount.selectedDocumentModelId
            : ensured.telegramAccount.selectedTextModelId;

  await ctx.reply(
    `🧠 <b>مدل‌های فعال (${models.length} مدل)</b>\nروی مدل مورد نظر کلیک کنید تا به عنوان مدل پیش‌فرض شما ذخیره شود:`,
    {
      parse_mode: 'HTML',
      reply_markup: buildDynamicModelsKeyboard(models, selectedId, categoryKey),
    },
  );
}

async function sendPlanSummary(ctx: Context, ensured: EnsuredTelegramUser) {
  const usage = await getUserUsageSnapshot(ensured.user.id);
  const plan = ensured.plan;
  const sub = ensured.subscription;
  if (!plan) {
    await ctx.reply('⚠️ در حال حاضر اشتراک فعالی برای شما ثبت نشده است.');
    return;
  }

  const expiryText = sub?.endsAt ? sub.endsAt.toISOString().slice(0, 10) : 'نامشخص';
  const renewLabel = sub?.autoRenew ? 'فعال (تمدید خودکار استارز)' : 'غیرفعال';

  const lines = [
    `💎 <b>وضعیت اشتراک فعلی شما</b>`,
    ``,
    `• پلن فعال: <b>${escapeTelegramHtml(plan.name)}</b>`,
    `• تاریخ انقضا: <b>${expiryText}</b>`,
    `• تمدید خودکار: <b>${renewLabel}</b>`,
    `• موجودی کیف‌پول: <b>${ensured.walletBalance.toFixed(2)}</b> اعتبار`,
    `• درخواست امروز: <b>${usage.todayRequests}</b> از <b>${plan.dailyRequestLimit}</b>`,
    `• درخواست این ماه: <b>${usage.monthRequests}</b> از <b>${plan.monthlyRequestLimit}</b>`,
    `• سهمیه تصویر ماهانه: <b>${usage.monthImages}</b> از <b>${plan.imageGenerationLimit}</b>`,
    `• سهمیه صوت ماهانه: <b>${usage.monthAudio}</b> از <b>${plan.audioGenerationLimit}</b>`,
    `• سهمیه ویدیو ماهانه: <b>${usage.monthVideos}</b> از <b>${plan.videoGenerationLimit}</b>`,
    `• حداکثر حجم فایل: <b>${plan.maxFileSizeMb} MB</b> | صف اولویت‌دار: <b>${plan.priorityQueue ? 'بله' : 'خیر'}</b>`,
    `• کارهای همزمان مجاز: <b>${plan.maxConcurrentTasks}</b>`,
    ``,
    `برای ارتقا، خرید بسته اعتبار یا مشاهده رسیدها از دستور /buy استفاده کنید.`,
  ];

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: buildMainMenuKeyboard(),
  });
}

async function sendBuyMenu(ctx: Context, ensured?: EnsuredTelegramUser | null) {
  const db = getDb();
  const plans = await db
    .select()
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.isEnabled, true))
    .orderBy(subscriptionPlans.sortOrder);

  if (plans.length === 0) {
    await ctx.reply('در حال حاضر پلن اشتراکی تعریف نشده است.');
    return;
  }

  const textLines = [
    '💎 <b>اشتراک‌ها و تعرفه‌های هوش‌نگار (پرداخت امن با Telegram Stars ⭐️)</b>',
    '',
    ...plans.map((p) => {
      const price =
        p.starsPrice > 0
          ? `${p.starsPrice} ⭐️ (XTR)${p.isRecurringStars ? ' / تمدید ماهانه' : ''}`
          : 'رایگان';
      return `▫️ <b>${escapeTelegramHtml(p.name)}</b> — ${price}\n   ${p.durationDays} روز | ${p.creditAllocation} اعتبار | ${p.dailyRequestLimit} درخواست/روز`;
    }),
    '',
    'تمامی خریدهای دیجیتال داخل تلگرام به‌صورت رسمی از طریق <b>تلگرام استارز (XTR)</b> انجام و بلافاصله فعال می‌شوند:',
  ];

  await ctx.reply(textLines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: buildBuyPlansKeyboard(
      plans.map((p) => ({
        id: p.id,
        name: p.name,
        starsPrice: p.starsPrice,
        durationDays: p.durationDays,
        isRecurringStars: p.isRecurringStars,
      })),
      Boolean(ensured?.subscription?.autoRenew),
    ),
  });
}

async function sendCreditPackagesMenu(ctx: Context) {
  const db = getDb();
  const packages = await db
    .select()
    .from(creditPackages)
    .where(eq(creditPackages.isActive, true))
    .orderBy(creditPackages.sortOrder);

  if (packages.length === 0) {
    await ctx.reply('🪙 در حال حاضر بسته اعتبار فعالی تعریف نشده است. لطفاً پلن‌های اشتراک را بررسی کنید.');
    return;
  }

  const lines = [
    '🪙 <b>بسته‌های اعتبار اضافه (Telegram Stars ⭐️)</b>',
    '',
    'اعتبار خریداری‌شده بلافاصله پس از تأیید پرداخت به کیف پول شما اضافه می‌شود و منقضی نمی‌شود:',
  ];

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: buildCreditPackagesKeyboard(packages),
  });
}

async function sendBalanceInfo(ctx: Context, ensured: EnsuredTelegramUser) {
  const available = Math.max(0, ensured.walletBalance - ensured.reservedBalance);
  const msg = [
    '🪙 <b>کیف‌پول و موجودی اعتبار</b>',
    '',
    `• موجودی کل: <b>${ensured.walletBalance.toFixed(2)}</b> اعتبار`,
    `• رزروشده در پردازش‌های فعال: <b>${ensured.reservedBalance.toFixed(2)}</b> اعتبار`,
    `• موجودی قابل استفاده: <b>${available.toFixed(2)}</b> اعتبار`,
    '',
    '💡 در صورت بروز هرگونه خطا در تولید، اعتبار رزروشده به‌صورت خودکار و کامل بازگردانده می‌شود.',
  ].join('\n');

  await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: buildMainMenuKeyboard() });
}

async function sendReferralInfo(ctx: Context, ensured: EnsuredTelegramUser) {
  const [dash, cfg, botCfg] = await Promise.all([
    getUserReferralDashboard(ensured.user.id),
    getReferralProgramConfig(),
    loadBotConfig(),
  ]);
  const botUsername = botCfg?.botUsername || 'YourBot';
  const code = dash.referralCode ?? 'PENDING';
  const inviteLink = `https://t.me/${botUsername}?start=REF_${code}`;

  const rewardText =
    cfg.inviterRewardType === 'subscription_days'
      ? `${cfg.inviterFreeDays} روز اشتراک هدیه`
      : `${cfg.inviterBonusCredits} اعتبار هدیه`;
  const conditionText = cfg.requirePurchase
    ? `پس از اولین خرید دوست شما (حداقل ${cfg.minPurchaseStars} ⭐️)`
    : 'بلافاصله پس از عضویت دوست شما';

  const msg = [
    '🎁 <b>داشبورد دعوت از دوستان و کسب اعتبار هدیه</b>',
    '',
    `• کد دعوت اختصاصی شما: <code>${escapeTelegramHtml(code)}</code>`,
    `• کل دعوت‌شدگان: <b>${dash.totalInvited}</b> نفر`,
    `• دعوت‌های تکمیل‌شده: <b>${dash.qualifiedCount}</b> نفر | در انتظار خرید: <b>${dash.pendingCount}</b> نفر`,
    `• مجموع اعتبار دریافت‌شده: <b>${dash.earnedCredits}</b> اعتبار${dash.earnedDays > 0 ? ` (+${dash.earnedDays} روز اشتراک)` : ''}`,
    `• پاداش هر دعوت موفق: <b>${rewardText}</b> (${conditionText})`,
    '',
    `🔗 لینک اختصاصی دعوت شما:`,
    `<code>${escapeTelegramHtml(inviteLink)}</code>`,
  ].join('\n');

  await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: buildMainMenuKeyboard() });
}

async function sendHistoryList(ctx: Context, ensured: EnsuredTelegramUser) {
  const db = getDb();
  const recent = await db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, ensured.user.id))
    .orderBy(desc(conversations.updatedAt))
    .limit(8);

  if (recent.length === 0) {
    await ctx.reply('📜 هنوز تاریخچه گفتگویی برای شما ثبت نشده است. پیام خود را ارسال کنید تا گفتگو آغاز شود.');
    return;
  }

  const lines = [
    '📜 <b>آخرین گفتگوهای شما</b>',
    '',
    ...recent.map((c, i) => {
      const activeMark = c.id === ensured.telegramAccount.activeConversationId ? '✅ ' : '';
      return `${i + 1}. ${activeMark}<b>${escapeTelegramHtml(c.title)}</b> (${c.messageCount} پیام)`;
    }),
  ];

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: buildConversationActionKeyboard(),
  });
}

async function sendSupportInfo(ctx: Context, isPaySupport = false) {
  const cfg = await loadBotConfig();
  const supportUser = cfg?.supportUsername ? `@${cfg.supportUsername}` : 'تیم پشتیبانی سامانه';
  const msg = isPaySupport
    ? `💳 <b>پشتیبانی خرید و پرداخت تلگرام استارز (/paysupport)</b>\n\nبرای پیگیری پرداخت‌ها، فعال‌سازی اشتراک یا درخواست بازپرداخت استارز، لطفاً دسته‌بندی زیر را انتخاب کنید یا پیام خود را بنویسید.\nپشتیبانی مستقیم: ${escapeTelegramHtml(supportUser)}`
    : `🆘 <b>مرکز پشتیبانی هوش‌نگار</b>\n\nدسته‌بندی مشکل یا سوال خود را انتخاب کنید تا تیکت شما با اولویت بررسی شود (پشتیبانی مستقیم: ${escapeTelegramHtml(supportUser)}):`;

  await ctx.reply(msg, {
    parse_mode: 'HTML',
    reply_markup: buildSupportCategoryKeyboard(),
  });
}

export function createTelegramBotInstance(botToken: string): Bot {
  const bot = new Bot(botToken);

  // =========================================================================
  // SLASH COMMANDS (All 11 Required Commands)
  // =========================================================================
  bot.command('start', async (ctx) => {
    const startPayload = typeof ctx.match === 'string' && ctx.match.trim() ? ctx.match.trim() : null;
    const ensured = await resolveContextUser(ctx, startPayload);
    if (!ensured) return;

    await updateTelegramUserState(ensured.telegramAccount.id, { mode: 'chat' });
    const cfg = await loadBotConfig();
    const welcomeBase =
      cfg?.welcomeMessage ||
      'به دستیار هوشمند چندمدلی خوش آمدید! برای شروع، یکی از بخش‌های منوی زیر را انتخاب کنید یا مستقیم پیام خود را بنویسید.';

    const extras: string[] = [];
    if (ensured.isNewUser) {
      extras.push(`🎉 حساب کاربری شما ساخته شد و <b>${ensured.walletBalance.toFixed(0)}</b> اعتبار هدیه فعال گردید.`);
    }
    if (ensured.referralApplied) {
      extras.push('🎁 کد دعوت با موفقیت ثبت شد و پاداش معرفی به کیف‌پول شما اضافه گردید!');
    }

    const fullMsg = [
      `👋 <b>سلام ${escapeTelegramHtml(ensured.profile?.firstName || 'دوست گرامی')}!</b>`,
      '',
      escapeTelegramHtml(welcomeBase),
      ...(extras.length > 0 ? ['', ...extras] : []),
    ].join('\n');

    await ctx.reply(fullMsg, {
      parse_mode: 'HTML',
      reply_markup: buildMainMenuKeyboard(),
    });
  });

  bot.command('help', async (ctx) => {
    await resolveContextUser(ctx);
    const helpText = [
      '📖 <b>راهنمای دستورات ربات هوش‌نگار</b>',
      '',
      '/start — شروع و نمایش منوی اصلی',
      '/models — انتخاب مدل هوش مصنوعی (متن، تصویر، ویدیو، صوت، سند)',
      '/plan — مشاهده وضعیت اشتراک و سهمیه‌ها',
      '/balance — مشاهده موجودی کیف‌پول اعتبار',
      '/buy — مشاهده تعرفه‌ها و ارتقای اشتراک',
      '/referral — لینک دعوت از دوستان و اعتبار هدیه',
      '/history — مشاهده تاریخچه گفتگوها',
      '/settings — تنظیمات زبان، دستور سیستم و حافظه گفتگو',
      '/cancel — لغو عملیات یا پردازش در حال اجرا',
      '/paysupport — پشتیبانی پرداخت و اشتراک',
    ].join('\n');
    await ctx.reply(helpText, { parse_mode: 'HTML', reply_markup: buildMainMenuKeyboard() });
  });

  bot.command('models', async (ctx) => {
    const ensured = await resolveContextUser(ctx);
    if (!ensured) return;
    await sendModelsMenu(ctx, ensured, 'menu');
  });

  bot.command('plan', async (ctx) => {
    const ensured = await resolveContextUser(ctx);
    if (!ensured) return;
    await sendPlanSummary(ctx, ensured);
  });

  bot.command('balance', async (ctx) => {
    const ensured = await resolveContextUser(ctx);
    if (!ensured) return;
    await sendBalanceInfo(ctx, ensured);
  });

  bot.command('buy', async (ctx) => {
    const ensured = await resolveContextUser(ctx);
    await sendBuyMenu(ctx, ensured);
  });

  bot.command('referral', async (ctx) => {
    const ensured = await resolveContextUser(ctx);
    if (!ensured) return;
    await sendReferralInfo(ctx, ensured);
  });

  bot.command('history', async (ctx) => {
    const ensured = await resolveContextUser(ctx);
    if (!ensured) return;
    await sendHistoryList(ctx, ensured);
  });

  bot.command('settings', async (ctx) => {
    const ensured = await resolveContextUser(ctx);
    if (!ensured) return;
    const sysPromptPreview = ensured.telegramAccount.systemPrompt
      ? escapeTelegramHtml(ensured.telegramAccount.systemPrompt.slice(0, 120))
      : 'پیش‌فرض سامانه';
    await ctx.reply(
      `⚙️ <b>تنظیمات حساب و گفتگو</b>\n\n• زبان رابط: <b>${ensured.user.locale === 'en' ? 'English' : 'فارسی'}</b>\n• دستور سیستم فعلی: <i>${sysPromptPreview}</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: buildSettingsKeyboard(ensured.user.locale),
      },
    );
  });

  bot.command('cancel', async (ctx) => {
    const ensured = await resolveContextUser(ctx);
    if (!ensured) return;
    const countCanceled = await cancelActiveJobsForUser(ensured.user.id);
    await updateTelegramUserState(ensured.telegramAccount.id, {
      mode: 'chat',
      cancelRequestedAt: new Date().toISOString(),
    });
    await ctx.reply(
      countCanceled > 0
        ? `⏹ ${countCanceled} پردازش فعال لغو شد و اعتبار رزروشده بازگردانده شد. حالت گفتگو فعال است.`
        : '✅ عملیات فعلی لغو شد و به حالت گفتگوی عادی بازگشتید.',
      { reply_markup: buildMainMenuKeyboard() },
    );
  });

  bot.command('paysupport', async (ctx) => {
    const ensured = await resolveContextUser(ctx);
    if (ensured) {
      await updateTelegramUserState(ensured.telegramAccount.id, { mode: 'paysupport_message' });
    }
    await sendSupportInfo(ctx, true);
  });

  // =========================================================================
  // MAIN MENU BUTTON HANDLERS (All 11 Required Persian Buttons)
  // =========================================================================
  bot.hears(MAIN_MENU_LABELS.TEXT_AI, async (ctx) => {
    const ensured = await resolveContextUser(ctx);
    if (!ensured) return;
    await updateTelegramUserState(ensured.telegramAccount.id, { mode: 'chat' });
    const model = await resolveSelectedModelForCapability({
      userId: ensured.user.id,
      telegramAccount: ensured.telegramAccount,
      capability: 'chat',
    });
    await ctx.reply(
      `🤖 <b>حالت هوش مصنوعی متنی فعال شد</b>\n🧠 مدل فعلی: <b>${escapeTelegramHtml(model?.name ?? 'تنظیم‌نشده')}</b>\n\nپیام یا پرسش خود را بنویسید تا با حفظ حافظه گفتگو پاسخ دریافت کنید:`,
      {
        parse_mode: 'HTML',
        reply_markup: buildConversationActionKeyboard(),
      },
    );
  });

  bot.hears(MAIN_MENU_LABELS.IMAGE_AI, async (ctx) => {
    const ensured = await resolveContextUser(ctx);
    if (!ensured) return;
    const imgParams = ensured.telegramAccount.botState.imageParams ?? {
      aspectRatio: '1:1',
      resolution: '1K',
      count: 1,
    };
    await updateTelegramUserState(ensured.telegramAccount.id, {
      mode: 'image_prompt',
      imageParams: imgParams,
    });
    await ctx.reply(
      '🎨 <b>استودیوی ساخت و ویرایش تصویر</b>\n\nتنظیمات دلخواه را انتخاب کنید و سپس متن توصیفی تصویر (پرامپت) را ارسال نمایید یا حالت ویرایش را بزنید:',
      {
        parse_mode: 'HTML',
        reply_markup: buildImageStudioKeyboard(imgParams),
      },
    );
  });

  bot.hears(MAIN_MENU_LABELS.VIDEO_AI, async (ctx) => {
    const ensured = await resolveContextUser(ctx);
    if (!ensured) return;
    const vidParams = ensured.telegramAccount.botState.videoParams ?? {
      durationSeconds: 5,
      aspectRatio: '16:9',
      quality: '720p',
    };
    await updateTelegramUserState(ensured.telegramAccount.id, {
      mode: 'video_prompt',
      videoParams: vidParams,
    });
    await ctx.reply(
      '🎬 <b>استودیوی ساخت ویدیو با هوش مصنوعی</b>\n\nمدت، نسبت تصویر و کیفیت را انتخاب کرده و سپس توضیح صحنه ویدیو را ارسال کنید (پردازش در صف پس‌زمینه انجام می‌شود):',
      {
        parse_mode: 'HTML',
        reply_markup: buildVideoStudioKeyboard(vidParams),
      },
    );
  });

  bot.hears(MAIN_MENU_LABELS.AUDIO_AI, async (ctx) => {
    const ensured = await resolveContextUser(ctx);
    if (!ensured) return;
    const audParams = ensured.telegramAccount.botState.audioParams ?? {
      voice: 'Kore',
      language: 'fa',
    };
    await updateTelegramUserState(ensured.telegramAccount.id, {
      mode: 'audio_stt_wait',
      audioParams: audParams,
    });
    await ctx.reply(
      '🎙 <b>هوش مصنوعی صوتی (تبدیل ویس به متن و متن به گفتار)</b>\n\n• برای تبدیل ویس به متن، کافی است پیام صوتی یا فایل صوتی ارسال کنید.\n• برای تبدیل متن به صدا، گزینه TTS را بزنید و متن خود را بنویسید.',
      {
        parse_mode: 'HTML',
        reply_markup: buildAudioStudioKeyboard(audParams),
      },
    );
  });

  bot.hears(MAIN_MENU_LABELS.DOCUMENT_AI, async (ctx) => {
    const ensured = await resolveContextUser(ctx);
    if (!ensured) return;
    await updateTelegramUserState(ensured.telegramAccount.id, { mode: 'document_wait' });
    await ctx.reply(
      `📁 <b>تحلیل هوشمند فایل و سند</b>\n\nفایل خود را ارسال کنید (فرمت‌های مجاز: PDF، DOCX، TXT، CSV و تصویر). می‌توانید درخواست تحلیلی خود را در کپشن فایل بنویسید.\nحداکثر حجم مجاز پلن شما: <b>${ensured.plan?.maxFileSizeMb ?? 10} MB</b>`,
      { parse_mode: 'HTML', reply_markup: buildMainMenuKeyboard() },
    );
  });

  bot.hears(MAIN_MENU_LABELS.MODELS, async (ctx) => {
    const ensured = await resolveContextUser(ctx);
    if (!ensured) return;
    await sendModelsMenu(ctx, ensured, 'menu');
  });

  bot.hears(MAIN_MENU_LABELS.PLANS, async (ctx) => {
    const ensured = await resolveContextUser(ctx);
    if (!ensured) return;
    await sendPlanSummary(ctx, ensured);
    await sendBuyMenu(ctx, ensured);
  });

  bot.hears(MAIN_MENU_LABELS.BALANCE, async (ctx) => {
    const ensured = await resolveContextUser(ctx);
    if (!ensured) return;
    await sendBalanceInfo(ctx, ensured);
  });

  bot.hears(MAIN_MENU_LABELS.REFERRAL, async (ctx) => {
    const ensured = await resolveContextUser(ctx);
    if (!ensured) return;
    await sendReferralInfo(ctx, ensured);
  });

  bot.hears(MAIN_MENU_LABELS.SETTINGS, async (ctx) => {
    const ensured = await resolveContextUser(ctx);
    if (!ensured) return;
    await ctx.reply('⚙️ <b>تنظیمات حساب کاربری</b>', {
      parse_mode: 'HTML',
      reply_markup: buildSettingsKeyboard(ensured.user.locale),
    });
  });

  bot.hears(MAIN_MENU_LABELS.SUPPORT, async (ctx) => {
    const ensured = await resolveContextUser(ctx);
    if (!ensured) return;
    await updateTelegramUserState(ensured.telegramAccount.id, { mode: 'support_message' });
    await sendSupportInfo(ctx, false);
  });

  // =========================================================================
  // CALLBACK QUERIES (Dynamic Models, Conversation Controls, Wizards)
  // =========================================================================
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const ensured = await resolveContextUser(ctx);
    if (!ensured) {
      await safeAnswerCallback(ctx, 'نشست نامعتبر است. /start را ارسال کنید.', true);
      return;
    }

    try {
      // Model categories
      if (data.startsWith('mcat:')) {
        const cat = data.slice(5);
        await safeAnswerCallback(ctx);
        await sendModelsMenu(ctx, ensured, cat);
        return;
      }

      // Select model from DB
      if (data.startsWith('msel:')) {
        const [, categoryKey, modelId] = data.split(':');
        if (!modelId) {
          await safeAnswerCallback(ctx, 'مدل نامعتبر است.', true);
          return;
        }
        const available = await getAvailableModelsForUser({ userId: ensured.user.id });
        const chosen = available.find((m) => m.id === modelId);
        if (!chosen) {
          await safeAnswerCallback(ctx, 'این مدل غیرفعال شده یا در پلن شما مجاز نیست.', true);
          return;
        }

        const updateCol: Partial<typeof telegramAccounts.$inferInsert> = {};
        if (categoryKey === 'image' || chosen.category === 'image') {
          updateCol.selectedImageModelId = chosen.id;
        } else if (categoryKey === 'video' || chosen.category === 'video') {
          updateCol.selectedVideoModelId = chosen.id;
        } else if (categoryKey === 'audio' || chosen.category === 'audio') {
          updateCol.selectedAudioModelId = chosen.id;
        } else if (categoryKey === 'multimodal' || chosen.category === 'multimodal') {
          updateCol.selectedDocumentModelId = chosen.id;
          if (chosen.capabilities.includes('chat')) {
            updateCol.selectedTextModelId = chosen.id;
          }
        } else {
          updateCol.selectedTextModelId = chosen.id;
        }

        await updateTelegramUserState(ensured.telegramAccount.id, {}, updateCol);
        await safeAnswerCallback(ctx, `✅ مدل «${chosen.name}» انتخاب شد.`);
        await ctx.reply(
          `✅ مدل فعال شما به <b>${escapeTelegramHtml(chosen.name)}</b> (${escapeTelegramHtml(chosen.providerName)}) تغییر یافت.\nهزینه هر درخواست: <b>${chosen.creditCost}</b> اعتبار`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      // Stop generation
      if (data.startsWith('gen:stop:')) {
        const canceled = await cancelActiveJobsForUser(ensured.user.id);
        await updateTelegramUserState(ensured.telegramAccount.id, {
          cancelRequestedAt: new Date().toISOString(),
        });
        await safeAnswerCallback(
          ctx,
          canceled > 0 ? '⏹ تولید متوقف شد و اعتبار بازگشت.' : 'پردازش فعالی برای توقف وجود نداشت.',
        );
        return;
      }

      // Conversation controls
      if (data === 'conv:new') {
        const conv = await getOrCreateActiveConversation({
          userId: ensured.user.id,
          telegramAccount: ensured.telegramAccount,
          modelId: ensured.telegramAccount.selectedTextModelId,
          forceNew: true,
        });
        await updateTelegramUserState(ensured.telegramAccount.id, { mode: 'chat' });
        await safeAnswerCallback(ctx, '🆕 گفتگوی جدید آغاز شد.');
        await ctx.reply(`🆕 گفتگوی جدید ایجاد شد (شناسه: <code>${conv.id.slice(0, 8)}</code>). پیام خود را ارسال کنید:`, {
          parse_mode: 'HTML',
        });
        return;
      }

      if (data === 'conv:clear') {
        const db = getDb();
        if (ensured.telegramAccount.activeConversationId) {
          await db
            .delete(conversationMessages)
            .where(eq(conversationMessages.conversationId, ensured.telegramAccount.activeConversationId));
          await db
            .update(conversations)
            .set({ messageCount: 0, updatedAt: new Date() })
            .where(eq(conversations.id, ensured.telegramAccount.activeConversationId));
        }
        await safeAnswerCallback(ctx, '🗑 حافظه گفتگوی فعلی پاک شد.');
        await ctx.reply('🗑 حافظه گفتگوی فعلی پاک‌سازی شد.');
        return;
      }

      if (data === 'conv:sysprompt') {
        await updateTelegramUserState(ensured.telegramAccount.id, { mode: 'system_prompt_input' });
        await safeAnswerCallback(ctx);
        await ctx.reply(
          '📝 لطفاً دستور سیستم (System Prompt) دلخواه خود را بنویسید (یا برای حذف آن عبارت <code>پاک</code> را ارسال کنید):',
          { parse_mode: 'HTML' },
        );
        return;
      }

      if (data === 'conv:continue' || data.startsWith('conv:regen:')) {
        const conv = await getOrCreateActiveConversation({
          userId: ensured.user.id,
          telegramAccount: ensured.telegramAccount,
          modelId: ensured.telegramAccount.selectedTextModelId,
        });
        const promptText =
          data === 'conv:continue'
            ? 'لطفاً پاسخ قبلی را به صورت کامل‌تر ادامه بده.'
            : 'لطفاً پاسخ قبلی را با کیفیت و ساختار بهتر مجدداً تولید کن.';
        const db = getDb();
        await db.insert(conversationMessages).values({
          conversationId: conv.id,
          role: 'user',
          content: promptText,
        });
        await safeAnswerCallback(ctx, '⏳ در حال پردازش...');
        await enqueueAiJobFromContext({
          ctx,
          ensured,
          capability: 'chat',
          promptPreview: promptText,
          idempotencyKey: `cb:${ctx.callbackQuery.id}`,
          conversationId: conv.id,
          jobPayload: {
            prompt: promptText,
            systemPrompt: ensured.telegramAccount.systemPrompt || undefined,
          },
          statusText: '⏳ در حال پردازش مجدد پاسخ...',
        });
        return;
      }

      // Image Studio callbacks
      if (data.startsWith('img:')) {
        const [, action, value] = data.split(':');
        const cur = { ...(ensured.telegramAccount.botState.imageParams ?? { aspectRatio: '1:1', resolution: '1K', count: 1 }) };
        let mode = ensured.telegramAccount.botState.mode ?? 'image_prompt';
        if (action === 'ar' && value) cur.aspectRatio = value;
        if (action === 'res' && value) cur.resolution = value;
        if (action === 'cnt' && value) cur.count = Number(value) === 2 ? 2 : 1;
        if (action === 'mode') {
          if (value === 'prompt') mode = 'image_prompt';
          if (value === 'edit') mode = 'image_edit_photo';
          if (value === 'variation') mode = 'image_variation_photo';
        }
        await updateTelegramUserState(ensured.telegramAccount.id, { mode, imageParams: cur });
        await safeAnswerCallback(ctx, '✅ تنظیمات تصویر به‌روزرسانی شد.');
        if (action === 'mode' && value === 'edit') {
          await ctx.reply('🖼 ابتدا تصویر مورد نظر برای ویرایش را ارسال کنید (می‌توانید دستور ویرایش را در کپشن آن بنویسید).');
        } else if (action === 'mode' && value === 'variation') {
          await ctx.reply('🔁 تصویر مرجع را ارسال کنید تا نسخه مشابه با هوش مصنوعی تولید شود.');
        } else if (action === 'mode' && value === 'prompt') {
          await ctx.reply('✨ متن توصیفی (پرامپت) تصویر مورد نظر خود را ارسال کنید:');
        } else {
          try {
            await ctx.editMessageReplyMarkup({ reply_markup: buildImageStudioKeyboard(cur) });
          } catch {
            // ignore
          }
        }
        return;
      }

      // Video Studio callbacks
      if (data.startsWith('vid:')) {
        const [, action, value] = data.split(':');
        const cur = { ...(ensured.telegramAccount.botState.videoParams ?? { durationSeconds: 5, aspectRatio: '16:9', quality: '720p' }) };
        let mode = ensured.telegramAccount.botState.mode ?? 'video_prompt';
        if (action === 'dur' && value) cur.durationSeconds = Number(value) || 5;
        if (action === 'ar' && value) cur.aspectRatio = value;
        if (action === 'q' && value) cur.quality = value;
        if (action === 'mode') {
          mode = value === 'image' ? 'video_image_photo' : 'video_prompt';
        }
        await updateTelegramUserState(ensured.telegramAccount.id, { mode, videoParams: cur });
        await safeAnswerCallback(ctx, '✅ تنظیمات ویدیو ذخیره شد.');
        if (action === 'mode' && value === 'image') {
          await ctx.reply('🖼 تصویر اولیه برای تبدیل به ویدیو را همراه با توضیح حرکت (در کپشن) ارسال کنید:');
        } else if (action === 'mode' && value === 'prompt') {
          await ctx.reply('🎬 توضیح صحنه ویدیو (پرامپت) را ارسال کنید:');
        } else {
          try {
            await ctx.editMessageReplyMarkup({ reply_markup: buildVideoStudioKeyboard(cur) });
          } catch {
            // ignore
          }
        }
        return;
      }

      // Audio Studio callbacks
      if (data.startsWith('aud:')) {
        const [, action, value] = data.split(':');
        const cur = { ...(ensured.telegramAccount.botState.audioParams ?? { voice: 'Kore', language: 'fa' }) };
        let mode = ensured.telegramAccount.botState.mode ?? 'audio_stt_wait';
        if (action === 'voice' && value) cur.voice = value;
        if (action === 'lang' && value) cur.language = value;
        if (action === 'mode') {
          mode = value === 'tts' ? 'audio_tts_prompt' : 'audio_stt_wait';
        }
        await updateTelegramUserState(ensured.telegramAccount.id, { mode, audioParams: cur });
        await safeAnswerCallback(ctx, '✅ تنظیمات صوتی ذخیره شد.');
        if (action === 'mode' && value === 'tts') {
          await ctx.reply('🔊 متنی را که می‌خواهید به گفتار (صدا) تبدیل شود ارسال کنید:');
        } else if (action === 'mode' && value === 'stt') {
          await ctx.reply('🎤 پیام صوتی (ویس) یا فایل صوتی خود را ارسال کنید تا به متن تبدیل شود:');
        } else {
          try {
            await ctx.editMessageReplyMarkup({ reply_markup: buildAudioStudioKeyboard(cur) });
          } catch {
            // ignore
          }
        }
        return;
      }

      // Settings callbacks
      if (data.startsWith('set:lang:')) {
        const lang = data.endsWith(':en') ? 'en' : 'fa';
        const db = getDb();
        await db
          .update(users)
          .set({ locale: lang, updatedAt: new Date() })
          .where(eq(users.id, ensured.user.id));
        await safeAnswerCallback(ctx, lang === 'en' ? 'Language set to English' : 'زبان به فارسی تغییر یافت.');
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: buildSettingsKeyboard(lang) });
        } catch {
          // ignore
        }
        return;
      }

      // Plan selection -> Official Telegram Stars (XTR) Invoice
      if (data.startsWith('plan:select:')) {
        const planId = data.slice('plan:select:'.length);
        const db = getDb();
        const [plan] = await db
          .select()
          .from(subscriptionPlans)
          .where(eq(subscriptionPlans.id, planId))
          .limit(1);
        await safeAnswerCallback(ctx);
        if (!plan || !plan.isEnabled) {
          await ctx.reply('⚠️ پلن مورد نظر یافت نشد یا غیرفعال است.');
          return;
        }
        if (plan.starsPrice <= 0) {
          await ctx.reply(
            `💎 <b>${escapeTelegramHtml(plan.name)}</b> یک پلن رایگان است و به‌صورت خودکار برای کاربران بدون اشتراک پولی فعال می‌شود.`,
            { parse_mode: 'HTML' },
          );
          return;
        }

        const order = await createTelegramStarsOrder({
          userId: ensured.user.id,
          telegramUserId: ensured.telegramAccount.telegramUserId,
          kind: 'subscription',
          planId: plan.id,
        });

        if (order.isRecurring && order.subscriptionPeriodSeconds) {
          const invoiceLink = await ctx.api.createInvoiceLink(
            order.title,
            order.description,
            order.invoicePayload,
            '',
            'XTR',
            [{ label: order.label, amount: order.starsAmount }],
            { subscription_period: order.subscriptionPeriodSeconds },
          );
          await ctx.reply(
            `💎 <b>فاکتور اشتراک تمدید خودکار ${escapeTelegramHtml(plan.name)}</b>\n\n• شماره سفارش: <code>${order.orderNumber}</code>\n• مبلغ ماهانه: <b>${order.starsAmount} ⭐️ (Telegram Stars)</b>\n• دوره: <b>۳۰ روز (تمدید خودکار)</b>\n\nبرای تکمیل پرداخت رسمی در تلگرام روی دکمه زیر بزنید:`,
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[{ text: `⭐️ پرداخت ${order.starsAmount} استارز`, url: invoiceLink }]],
              },
            },
          );
        } else {
          await ctx.replyWithInvoice(
            order.title,
            order.description,
            order.invoicePayload,
            'XTR',
            [{ label: order.label, amount: order.starsAmount }],
            { provider_token: '' },
          );
        }
        return;
      }

      // Credit package purchase -> Official Telegram Stars (XTR) Invoice
      if (data.startsWith('pkg:buy:')) {
        const packageId = data.slice('pkg:buy:'.length);
        await safeAnswerCallback(ctx);
        const order = await createTelegramStarsOrder({
          userId: ensured.user.id,
          telegramUserId: ensured.telegramAccount.telegramUserId,
          kind: 'credit_package',
          creditPackageId: packageId,
        });
        await ctx.replyWithInvoice(
          order.title,
          order.description,
          order.invoicePayload,
          'XTR',
          [{ label: order.label, amount: order.starsAmount }],
          { provider_token: '' },
        );
        return;
      }

      // Store navigation callbacks
      if (data === 'store:packages') {
        await safeAnswerCallback(ctx);
        await sendCreditPackagesMenu(ctx);
        return;
      }

      if (data === 'store:plans') {
        await safeAnswerCallback(ctx);
        await sendBuyMenu(ctx, ensured);
        return;
      }

      if (data === 'store:coupon') {
        await updateTelegramUserState(ensured.telegramAccount.id, { mode: 'coupon_redeem_input' });
        await safeAnswerCallback(ctx);
        await ctx.reply(
          '🎁 لطفاً کد هدیه یا کد اعتبار تبلیغاتی خود را ارسال کنید (مثال: <code>WELCOME50</code>):',
          { parse_mode: 'HTML' },
        );
        return;
      }

      if (data === 'store:payments') {
        await safeAnswerCallback(ctx);
        const history = await getUserRecentPayments(ensured.user.id);
        if (history.length === 0) {
          await ctx.reply('🧾 هنوز پرداختی برای حساب شما ثبت نشده است.');
          return;
        }
        const statusMap: Record<string, string> = {
          succeeded: '✅ موفق',
          pending: '⏳ در انتظار',
          failed: '❌ ناموفق',
          refunded: '↩️ بازپرداخت‌شده',
          canceled: '🚫 لغوشده',
        };
        const lines = [
          '🧾 <b>تاریخچه پرداخت‌ها و رسیدهای تلگرام استارز</b>',
          '',
          ...history.map((p) => {
            const dt = (p.paidAt ?? p.createdAt).toISOString().slice(0, 10);
            const st = statusMap[p.status] ?? p.status;
            return `• <code>${escapeTelegramHtml(p.orderNumber ?? p.id.slice(0, 8))}</code> — <b>${Number(p.amount)} ⭐️</b> | ${st} | ${dt}`;
          }),
        ];
        await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
        return;
      }

      if (data === 'sub:cancel_renew') {
        const res = await cancelSubscriptionAutoRenewal({
          userId: ensured.user.id,
          reason: 'Canceled by user via Telegram bot',
        });
        await safeAnswerCallback(ctx, res.ok ? 'تمدید خودکار لغو شد' : 'خطا');
        await ctx.reply(res.ok ? `✅ ${res.messageFa}` : `⚠️ ${res.messageFa}`);
        return;
      }

      // Categorized Support callbacks
      if (data.startsWith('support:cat:') || data === 'support:pay') {
        const category = data === 'support:pay' ? 'payment' : data.slice('support:cat:'.length);
        const mode = category === 'payment' || category === 'refund' ? 'paysupport_message' : 'support_message';
        await updateTelegramUserState(ensured.telegramAccount.id, {
          mode,
          activeRequestId: category,
        });
        await safeAnswerCallback(ctx);
        const catLabel =
          category === 'payment'
            ? 'پرداخت و تلگرام استارز'
            : category === 'refund'
              ? 'درخواست بازپرداخت'
              : category === 'failed_request'
                ? 'خطای درخواست هوش مصنوعی'
                : 'پشتیبانی عمومی';
        await ctx.reply(
          `📝 دسته‌بندی انتخاب‌شده: <b>${catLabel}</b>\n\nلطفاً توضیحات یا شماره سفارش خود را در یک پیام ارسال کنید تا تیکت شما ثبت شود:`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      await safeAnswerCallback(ctx, 'این دکمه منقضی یا نامعتبر شده است.', false);
    } catch (err) {
      console.error('[telegram:callback]', redactSecrets(err instanceof Error ? err.message : 'unknown'));
      await safeAnswerCallback(ctx, 'خطایی در پردازش درخواست رخ داد. لطفاً مجدداً تلاش کنید.', true);
    }
  });

  // =========================================================================
  // OFFICIAL TELEGRAM STARS (XTR) PAYMENT HANDLERS
  // =========================================================================
  bot.on('pre_checkout_query', async (ctx) => {
    const pcq = ctx.preCheckoutQuery;
    const check = await validateTelegramPreCheckout({
      preCheckoutQueryId: pcq.id,
      telegramUserId: pcq.from.id,
      currency: pcq.currency,
      totalAmount: pcq.total_amount,
      invoicePayload: pcq.invoice_payload,
    });
    await ctx.answerPreCheckoutQuery(check.ok, {
      error_message: check.ok ? undefined : check.errorMessage,
    });
  });

  bot.on('message:successful_payment', async (ctx) => {
    const sp = ctx.message.successful_payment;
    const fromId = ctx.from?.id;
    if (!fromId) return;

    const settled = await processSuccessfulTelegramPayment({
      telegramUserId: fromId,
      currency: sp.currency,
      totalAmount: sp.total_amount,
      invoicePayload: sp.invoice_payload,
      telegramPaymentChargeId: sp.telegram_payment_charge_id,
      providerPaymentChargeId: sp.provider_payment_charge_id,
      isRecurring: Boolean((sp as { is_recurring?: boolean }).is_recurring),
      isFirstRecurring: Boolean((sp as { is_first_recurring?: boolean }).is_first_recurring),
      subscriptionExpirationDate: (sp as { subscription_expiration_date?: number })
        .subscription_expiration_date,
    });

    if (!settled.ok) {
      await ctx.reply(
        '⚠️ پرداخت شما دریافت شد اما در فعال‌سازی خودکار خطایی رخ داد. لطفاً از دستور /paysupport استفاده کنید تا فوراً بررسی شود.',
        { reply_markup: buildMainMenuKeyboard() },
      );
      return;
    }

    if (!settled.duplicate) {
      await ctx.reply(
        `✅ <b>پرداخت تلگرام استارز با موفقیت تأیید شد!</b>\n\n• شماره سفارش: <code>${escapeTelegramHtml(settled.orderNumber ?? '')}</code>\n• عنوان: <b>${escapeTelegramHtml(settled.itemName ?? 'سفارش')}</b>\n• مبلغ: <b>${sp.total_amount} ⭐️</b>\n• موجودی فعلی کیف‌پول: <b>${(settled.newBalance ?? 0).toFixed(2)}</b> اعتبار`,
        { parse_mode: 'HTML', reply_markup: buildMainMenuKeyboard() },
      );
    }
  });

  // =========================================================================
  // VOICE & AUDIO HANDLERS (STT)
  // =========================================================================
  bot.on(['message:voice', 'message:audio'], async (ctx) => {
    const ensured = await resolveContextUser(ctx);
    if (!ensured) return;
    const voice = ctx.message.voice;
    const audio = ctx.message.audio;
    const fileId = voice?.file_id ?? audio?.file_id;
    if (!fileId) return;

    const mimeType = voice?.mime_type ?? audio?.mime_type ?? 'audio/ogg';
    const fileName = audio?.file_name ?? (voice ? 'voice.ogg' : 'audio.mp3');
    const lang = ensured.telegramAccount.botState.audioParams?.language ?? 'fa';

    await enqueueAiJobFromContext({
      ctx,
      ensured,
      capability: 'audio_transcription',
      promptPreview: `رونویسی فایل صوتی (${fileName})`,
      idempotencyKey: `tgmsg:${ctx.chat.id}:${ctx.message.message_id}`,
      jobPayload: {
        telegramFileId: fileId,
        mimeType,
        fileName,
        language: lang,
      },
      statusText: '🎙 در حال تبدیل صوت به متن...',
    });
  });

  // =========================================================================
  // PHOTO HANDLER (Image Edit / Variation / Image-to-Video / Vision)
  // =========================================================================
  bot.on('message:photo', async (ctx) => {
    const ensured = await resolveContextUser(ctx);
    if (!ensured) return;
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    if (!largest) return;

    const caption = (ctx.message.caption ?? '').trim();
    const mode = ensured.telegramAccount.botState.mode ?? 'chat';

    if (mode === 'image_edit_photo') {
      const curImg = { ...(ensured.telegramAccount.botState.imageParams ?? {}), sourceFileId: largest.file_id, sourceMimeType: 'image/jpeg' };
      if (!caption) {
        await updateTelegramUserState(ensured.telegramAccount.id, {
          mode: 'image_edit_prompt',
          imageParams: curImg,
        });
        await ctx.reply('✏️ تصویر دریافت شد! اکنون دستور ویرایش مورد نظر خود را بنویسید:');
        return;
      }
      await updateTelegramUserState(ensured.telegramAccount.id, { mode: 'image_prompt', imageParams: curImg });
      await enqueueAiJobFromContext({
        ctx,
        ensured,
        capability: 'image_editing',
        promptPreview: caption,
        idempotencyKey: `tgmsg:${ctx.chat.id}:${ctx.message.message_id}`,
        jobPayload: {
          prompt: caption,
          sourceFileId: largest.file_id,
          sourceMimeType: 'image/jpeg',
          aspectRatio: curImg.aspectRatio ?? '1:1',
          resolution: curImg.resolution ?? '1K',
        },
        statusText: '🪄 در حال ویرایش تصویر با هوش مصنوعی...',
      });
      return;
    }

    if (mode === 'image_variation_photo') {
      const curImg = ensured.telegramAccount.botState.imageParams ?? {};
      await updateTelegramUserState(ensured.telegramAccount.id, { mode: 'image_prompt' });
      await enqueueAiJobFromContext({
        ctx,
        ensured,
        capability: 'image_variation',
        promptPreview: caption || 'ایجاد نسخه مشابه از تصویر',
        idempotencyKey: `tgmsg:${ctx.chat.id}:${ctx.message.message_id}`,
        jobPayload: {
          prompt: caption || 'ایجاد نسخه مشابه خلاقانه از تصویر',
          sourceFileId: largest.file_id,
          sourceMimeType: 'image/jpeg',
          aspectRatio: curImg.aspectRatio ?? '1:1',
        },
        statusText: '🔁 در حال تولید نسخه مشابه از تصویر...',
      });
      return;
    }

    if (mode === 'video_image_photo') {
      const curVid = { ...(ensured.telegramAccount.botState.videoParams ?? {}), sourceFileId: largest.file_id };
      if (!caption) {
        await updateTelegramUserState(ensured.telegramAccount.id, {
          mode: 'video_image_prompt',
          videoParams: curVid,
        });
        await ctx.reply('🎬 تصویر دریافت شد! اکنون توضیح حرکت و صحنه ویدیو را بنویسید:');
        return;
      }
      await updateTelegramUserState(ensured.telegramAccount.id, { mode: 'video_prompt', videoParams: curVid });
      await enqueueAiJobFromContext({
        ctx,
        ensured,
        capability: 'video_generation',
        promptPreview: caption,
        idempotencyKey: `tgmsg:${ctx.chat.id}:${ctx.message.message_id}`,
        jobPayload: {
          prompt: caption,
          sourceFileId: largest.file_id,
          durationSeconds: curVid.durationSeconds ?? 5,
          aspectRatio: curVid.aspectRatio ?? '16:9',
          quality: curVid.quality ?? '720p',
        },
        statusText: '🎬 در حال ارسال تصویر برای تولید ویدیو...',
      });
      return;
    }

    // Default: Vision / Document image analysis
    const conv = await getOrCreateActiveConversation({
      userId: ensured.user.id,
      telegramAccount: ensured.telegramAccount,
      modelId: ensured.telegramAccount.selectedTextModelId,
    });
    const visionPrompt = caption || 'این تصویر را با جزئیات کامل به زبان فارسی تحلیل کن.';
    await enqueueAiJobFromContext({
      ctx,
      ensured,
      capability: mode === 'document_wait' ? 'document_analysis' : 'vision',
      promptPreview: visionPrompt,
      idempotencyKey: `tgmsg:${ctx.chat.id}:${ctx.message.message_id}`,
      conversationId: conv.id,
      jobPayload: {
        prompt: visionPrompt,
        telegramFileId: largest.file_id,
        mimeType: 'image/jpeg',
        fileName: 'photo.jpg',
      },
      statusText: '👁 در حال تحلیل تصویر...',
    });
  });

  // =========================================================================
  // DOCUMENT HANDLER (Safe PDF / DOCX / TXT / CSV / Image Analysis)
  // =========================================================================
  bot.on('message:document', async (ctx) => {
    const ensured = await resolveContextUser(ctx);
    if (!ensured) return;
    const doc = ctx.message.document;
    const caption =
      (ctx.message.caption ?? '').trim() ||
      'این سند را به صورت ساختارمند خلاصه کن و نکات کلیدی آن را به فارسی استخراج کن.';

    await enqueueAiJobFromContext({
      ctx,
      ensured,
      capability: 'document_analysis',
      promptPreview: `${doc.file_name ?? 'document'}: ${caption}`,
      idempotencyKey: `tgmsg:${ctx.chat.id}:${ctx.message.message_id}`,
      jobPayload: {
        prompt: caption,
        telegramFileId: doc.file_id,
        fileName: doc.file_name ?? 'document.bin',
        mimeType: doc.mime_type,
      },
      statusText: `📁 در حال بررسی امنیتی و تحلیل فایل «${doc.file_name ?? 'سند'}»...`,
    });
  });

  // =========================================================================
  // GENERAL TEXT MESSAGE ROUTER
  // =========================================================================
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith('/')) return;

    const ensured = await resolveContextUser(ctx);
    if (!ensured) return;

    const state = ensured.telegramAccount.botState ?? {};
    const mode = state.mode ?? 'chat';

    if (mode === 'system_prompt_input') {
      const cleanPrompt = text === 'پاک' || text.toLowerCase() === 'clear' ? '' : text.slice(0, 2000);
      await updateTelegramUserState(
        ensured.telegramAccount.id,
        { mode: 'chat' },
        { systemPrompt: cleanPrompt },
      );
      await ctx.reply(
        cleanPrompt
          ? '✅ دستور سیستم (System Prompt) جدید شما ذخیره شد.'
          : '🗑 دستور سیستم پاک شد و به حالت پیش‌فرض بازگشت.',
        { reply_markup: buildMainMenuKeyboard() },
      );
      return;
    }

    if (mode === 'coupon_redeem_input') {
      await updateTelegramUserState(ensured.telegramAccount.id, { mode: 'chat' });
      const res = await redeemGiftCreditCoupon({
        userId: ensured.user.id,
        code: text,
      });
      await ctx.reply(
        res.ok
          ? `🎉 کد هدیه با موفقیت اعمال شد!\n• اعتبار اضافه‌شده: <b>${res.creditsAwarded}</b> اعتبار\n• موجودی جدید: <b>${(res.newBalance ?? 0).toFixed(2)}</b> اعتبار`
          : `⚠️ ${res.errorFa ?? 'کد هدیه معتبر نیست.'}`,
        { parse_mode: 'HTML', reply_markup: buildMainMenuKeyboard() },
      );
      return;
    }

    if (mode === 'support_message' || mode === 'paysupport_message') {
      const db = getDb();
      const rawCategory = state.activeRequestId;
      const category =
        rawCategory === 'payment' ||
        rawCategory === 'refund' ||
        rawCategory === 'failed_request' ||
        rawCategory === 'general'
          ? rawCategory
          : mode === 'paysupport_message'
            ? 'payment'
            : 'general';

      let relatedPaymentId: string | null = null;
      let relatedRequestId: string | null = null;
      if (category === 'payment' || category === 'refund') {
        const [latestPay] = await db
          .select({ id: payments.id })
          .from(payments)
          .where(eq(payments.userId, ensured.user.id))
          .orderBy(desc(payments.createdAt))
          .limit(1);
        relatedPaymentId = latestPay?.id ?? null;
      } else if (category === 'failed_request') {
        const [latestFail] = await db
          .select({ id: aiRequests.id })
          .from(aiRequests)
          .where(and(eq(aiRequests.userId, ensured.user.id), eq(aiRequests.status, 'failed')))
          .orderBy(desc(aiRequests.createdAt))
          .limit(1);
        relatedRequestId = latestFail?.id ?? null;
      }

      const [ticket] = await db
        .insert(supportTickets)
        .values({
          userId: ensured.user.id,
          category,
          relatedPaymentId,
          relatedRequestId,
          subject: text.slice(0, 120),
          message: text,
          priority: category === 'payment' || category === 'refund' ? 'high' : 'medium',
          status: 'open',
        })
        .returning({ id: supportTickets.id });

      await updateTelegramUserState(ensured.telegramAccount.id, {
        mode: 'chat',
        activeRequestId: null,
      });
      await ctx.reply(
        `✅ تیکت پشتیبانی شما با کد پیگیری <code>${ticket?.id.slice(0, 8) ?? 'NEW'}</code> در دسته «${category}» ثبت شد. پس از پاسخ کارشناس، نتیجه مستقیماً در تلگرام برای شما ارسال خواهد شد.`,
        { parse_mode: 'HTML', reply_markup: buildMainMenuKeyboard() },
      );
      return;
    }

    if (mode === 'image_prompt') {
      const imgParams = state.imageParams ?? { aspectRatio: '1:1', resolution: '1K', count: 1 };
      await enqueueAiJobFromContext({
        ctx,
        ensured,
        capability: 'image_generation',
        promptPreview: text,
        idempotencyKey: `tgmsg:${ctx.chat.id}:${ctx.message.message_id}`,
        jobPayload: {
          prompt: text,
          aspectRatio: imgParams.aspectRatio ?? '1:1',
          resolution: imgParams.resolution ?? '1K',
          count: imgParams.count ?? 1,
        },
        statusText: '🎨 در حال ساخت تصویر با هوش مصنوعی...',
      });
      return;
    }

    if (mode === 'image_edit_prompt' && state.imageParams?.sourceFileId) {
      const imgParams = state.imageParams;
      await updateTelegramUserState(ensured.telegramAccount.id, { mode: 'image_prompt' });
      await enqueueAiJobFromContext({
        ctx,
        ensured,
        capability: 'image_editing',
        promptPreview: text,
        idempotencyKey: `tgmsg:${ctx.chat.id}:${ctx.message.message_id}`,
        jobPayload: {
          prompt: text,
          sourceFileId: imgParams.sourceFileId,
          sourceMimeType: imgParams.sourceMimeType ?? 'image/jpeg',
          aspectRatio: imgParams.aspectRatio ?? '1:1',
          resolution: imgParams.resolution ?? '1K',
        },
        statusText: '🪄 در حال ویرایش تصویر...',
      });
      return;
    }

    if (mode === 'video_prompt') {
      const vidParams = state.videoParams ?? { durationSeconds: 5, aspectRatio: '16:9', quality: '720p' };
      await enqueueAiJobFromContext({
        ctx,
        ensured,
        capability: 'video_generation',
        promptPreview: text,
        idempotencyKey: `tgmsg:${ctx.chat.id}:${ctx.message.message_id}`,
        jobPayload: {
          prompt: text,
          durationSeconds: vidParams.durationSeconds ?? 5,
          aspectRatio: vidParams.aspectRatio ?? '16:9',
          quality: vidParams.quality ?? '720p',
        },
        statusText: '🎬 در حال ارسال درخواست تولید ویدیو به صف پردازش...',
      });
      return;
    }

    if (mode === 'video_image_prompt' && state.videoParams?.sourceFileId) {
      const vidParams = state.videoParams;
      await updateTelegramUserState(ensured.telegramAccount.id, { mode: 'video_prompt' });
      await enqueueAiJobFromContext({
        ctx,
        ensured,
        capability: 'video_generation',
        promptPreview: text,
        idempotencyKey: `tgmsg:${ctx.chat.id}:${ctx.message.message_id}`,
        jobPayload: {
          prompt: text,
          sourceFileId: vidParams.sourceFileId,
          durationSeconds: vidParams.durationSeconds ?? 5,
          aspectRatio: vidParams.aspectRatio ?? '16:9',
          quality: vidParams.quality ?? '720p',
        },
        statusText: '🎬 در حال تولید ویدیو از تصویر...',
      });
      return;
    }

    if (mode === 'audio_tts_prompt') {
      const audParams = state.audioParams ?? { voice: 'Kore', language: 'fa' };
      await enqueueAiJobFromContext({
        ctx,
        ensured,
        capability: 'speech_generation',
        promptPreview: text,
        idempotencyKey: `tgmsg:${ctx.chat.id}:${ctx.message.message_id}`,
        jobPayload: {
          prompt: text,
          voice: audParams.voice ?? 'Kore',
          language: audParams.language ?? 'fa',
        },
        statusText: '🔊 در حال تبدیل متن به گفتار...',
      });
      return;
    }

    // Default: Multi-turn Chat Completion
    const conv = await getOrCreateActiveConversation({
      userId: ensured.user.id,
      telegramAccount: ensured.telegramAccount,
      modelId: ensured.telegramAccount.selectedTextModelId,
      title: text.slice(0, 80),
    });

    const db = getDb();
    await db.insert(conversationMessages).values({
      conversationId: conv.id,
      role: 'user',
      content: text,
    });
    await db
      .update(conversations)
      .set({
        title: conv.messageCount === 0 ? text.slice(0, 80) : conv.title,
        messageCount: conv.messageCount + 1,
        lastMessageAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conv.id));

    await enqueueAiJobFromContext({
      ctx,
      ensured,
      capability: 'chat',
      promptPreview: text,
      idempotencyKey: `tgmsg:${ctx.chat.id}:${ctx.message.message_id}`,
      conversationId: conv.id,
      jobPayload: {
        prompt: text,
        systemPrompt: ensured.telegramAccount.systemPrompt || undefined,
      },
      statusText: '🤖 در حال تولید پاسخ...',
    });
  });

  bot.catch((err) => {
    console.error('[telegram:bot]', redactSecrets(err.message));
  });

  return bot;
}

/**
 * Processes a raw Telegram Update via the configured Grammy Bot instance.
 * Executed asynchronously from the QStash/local background job queue.
 */
export async function processTelegramUpdate(update: Update): Promise<{ ok: boolean; reason?: string }> {
  const cfg = await loadBotConfig();
  if (!cfg || !cfg.isActive || !cfg.encryptedBotToken || !cfg.tokenIv || !cfg.tokenAuthTag) {
    return { ok: false, reason: 'BOT_INACTIVE_OR_UNCONFIGURED' };
  }

  const botToken = decryptSecret({
    ciphertext: cfg.encryptedBotToken,
    iv: cfg.tokenIv,
    authTag: cfg.tokenAuthTag,
  });

  const bot = createTelegramBotInstance(botToken);
  await bot.init();
  await bot.handleUpdate(update);
  return { ok: true };
}

/**
 * Dev/Test helper (strictly guarded by AI_MOCK_MODE in routes) to run an end-to-end
 * Telegram user -> reservation -> AI execution -> conversation persistence pipeline
 * without requiring live Telegram API credentials.
 */
export async function runEndToEndTelegramSimulation(params: {
  telegramUserId: number;
  username?: string;
  firstName?: string;
  prompt: string;
  capability?: CapabilityType;
  modelId?: string;
  referralCode?: string;
}) {
  const ensured = await ensureTelegramUser({
    telegramUserId: params.telegramUserId,
    telegramChatId: params.telegramUserId,
    username: params.username ?? `tg_user_${params.telegramUserId}`,
    firstName: params.firstName ?? 'کاربر تست تلگرام',
    languageCode: 'fa',
    referralCode: params.referralCode ?? null,
  });

  const capability = params.capability ?? 'chat';
  let chosenModelId = params.modelId;
  if (!chosenModelId) {
    const resolved = await resolveSelectedModelForCapability({
      userId: ensured.user.id,
      telegramAccount: ensured.telegramAccount,
      capability,
    });
    if (!resolved) {
      throw new Error('هیچ مدل فعالی برای این قابلیت یافت نشد.');
    }
    chosenModelId = resolved.id;
  }

  let conversationId: string | null = null;
  if (capability === 'chat' || capability === 'text_generation') {
    const conv = await getOrCreateActiveConversation({
      userId: ensured.user.id,
      telegramAccount: ensured.telegramAccount,
      modelId: chosenModelId,
      title: params.prompt.slice(0, 80),
    });
    conversationId = conv.id;
    const db = getDb();
    await db.insert(conversationMessages).values({
      conversationId: conv.id,
      role: 'user',
      content: params.prompt,
    });
  }

  const reserved = await reserveCreditsAndCreateRequest({
    userId: ensured.user.id,
    modelId: chosenModelId,
    capability,
    idempotencyKey: `sim:${params.telegramUserId}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
    conversationId,
    telegramChatId: params.telegramUserId,
    promptPreview: params.prompt,
    jobPayload: {
      prompt: params.prompt,
      silentDelivery: true,
    },
  });

  const execRes = await executeQueuedGenerationJob(reserved.jobId);
  return {
    ensured,
    reserved,
    execution: execRes,
  };
}
