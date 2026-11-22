import { InlineKeyboard, Keyboard } from 'grammy';
import type { DynamicAvailableModel } from './userService.ts';

export const MAIN_MENU_LABELS = {
  TEXT_AI: '🤖 هوش مصنوعی متنی',
  IMAGE_AI: '🎨 ساخت و ویرایش تصویر',
  VIDEO_AI: '🎬 ساخت ویدیو',
  AUDIO_AI: '🎙 هوش مصنوعی صوتی',
  DOCUMENT_AI: '📁 تحلیل فایل و سند',
  MODELS: '🧠 مدل‌های هوش مصنوعی',
  PLANS: '💎 اشتراک و تعرفه‌ها',
  BALANCE: '🪙 موجودی و اعتبار',
  REFERRAL: '🎁 دعوت از دوستان',
  SETTINGS: '⚙️ تنظیمات',
  SUPPORT: '🆘 پشتیبانی',
} as const;

export function buildMainMenuKeyboard(): Keyboard {
  return new Keyboard()
    .text(MAIN_MENU_LABELS.TEXT_AI)
    .text(MAIN_MENU_LABELS.IMAGE_AI)
    .row()
    .text(MAIN_MENU_LABELS.VIDEO_AI)
    .text(MAIN_MENU_LABELS.AUDIO_AI)
    .row()
    .text(MAIN_MENU_LABELS.DOCUMENT_AI)
    .text(MAIN_MENU_LABELS.MODELS)
    .row()
    .text(MAIN_MENU_LABELS.PLANS)
    .text(MAIN_MENU_LABELS.BALANCE)
    .row()
    .text(MAIN_MENU_LABELS.REFERRAL)
    .text(MAIN_MENU_LABELS.SETTINGS)
    .row()
    .text(MAIN_MENU_LABELS.SUPPORT)
    .resized()
    .persistent();
}

export function buildModelCategoryKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🤖 مدل‌های متنی و گفتگو', 'mcat:text')
    .text('🎨 مدل‌های تصویر', 'mcat:image')
    .row()
    .text('🎬 مدل‌های ویدیو', 'mcat:video')
    .text('🎙 مدل‌های صوتی', 'mcat:audio')
    .row()
    .text('📁 مدل‌های تحلیل سند / چندوجهی', 'mcat:multimodal')
    .row()
    .text('📋 نمایش همه مدل‌های فعال', 'mcat:all');
}

export function buildDynamicModelsKeyboard(
  models: DynamicAvailableModel[],
  selectedModelId: string | null,
  categoryKey: string,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const m of models.slice(0, 24)) {
    const isSelected = m.id === selectedModelId;
    const prefix = isSelected ? '✅ ' : '';
    const costLabel = m.creditCost > 0 ? ` (${m.creditCost} اعتبار)` : ' (رایگان)';
    kb.text(`${prefix}${m.name} · ${m.providerName}${costLabel}`, `msel:${categoryKey}:${m.id}`).row();
  }
  kb.text('🔙 بازگشت به دسته‌بندی مدل‌ها', 'mcat:menu');
  return kb;
}

export function buildConversationActionKeyboard(requestId?: string): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('🔄 تولید مجدد', `conv:regen:${requestId ?? 'last'}`)
    .text('➕ ادامه پاسخ', 'conv:continue')
    .row()
    .text('🆕 گفتگوی جدید', 'conv:new')
    .text('🧠 تغییر مدل', 'mcat:text')
    .row()
    .text('📝 دستور سیستم', 'conv:sysprompt')
    .text('🗑 پاک کردن تاریخچه', 'conv:clear');
  return kb;
}

export function buildStopGenerationKeyboard(requestId: string): InlineKeyboard {
  return new InlineKeyboard().text('⏹ توقف تولید', `gen:stop:${requestId}`);
}

export function buildImageStudioKeyboard(params: {
  aspectRatio?: string;
  resolution?: string;
  count?: number;
}): InlineKeyboard {
  const ar = params.aspectRatio ?? '1:1';
  const res = params.resolution ?? '1K';
  const cnt = params.count ?? 1;

  return new InlineKeyboard()
    .text('✨ ساخت تصویر از متن', 'img:mode:prompt')
    .row()
    .text('🪄 ویرایش تصویر با دستور', 'img:mode:edit')
    .text('🔁 ایجاد نسخه مشابه', 'img:mode:variation')
    .row()
    .text(ar === '1:1' ? '✅ 1:1' : '1:1', 'img:ar:1:1')
    .text(ar === '16:9' ? '✅ 16:9' : '16:9', 'img:ar:16:9')
    .text(ar === '9:16' ? '✅ 9:16' : '9:16', 'img:ar:9:16')
    .text(ar === '4:3' ? '✅ 4:3' : '4:3', 'img:ar:4:3')
    .row()
    .text(res === '1K' ? '✅ 1K' : '1K', 'img:res:1K')
    .text(res === '2K' ? '✅ 2K' : '2K', 'img:res:2K')
    .text(`تعداد: ${cnt}`, `img:cnt:${cnt === 1 ? 2 : 1}`)
    .row()
    .text('🧠 تغییر مدل تصویر', 'mcat:image');
}

export function buildVideoStudioKeyboard(params: {
  durationSeconds?: number;
  aspectRatio?: string;
  quality?: string;
}): InlineKeyboard {
  const dur = params.durationSeconds ?? 5;
  const ar = params.aspectRatio ?? '16:9';
  const q = params.quality ?? '720p';

  return new InlineKeyboard()
    .text('🎬 متن به ویدیو', 'vid:mode:prompt')
    .text('🖼 تصویر به ویدیو', 'vid:mode:image')
    .row()
    .text(dur === 5 ? '✅ ۵ ثانیه' : '۵ ثانیه', 'vid:dur:5')
    .text(dur === 8 ? '✅ ۸ ثانیه' : '۸ ثانیه', 'vid:dur:8')
    .row()
    .text(ar === '16:9' ? '✅ 16:9' : '16:9', 'vid:ar:16:9')
    .text(ar === '9:16' ? '✅ 9:16' : '9:16', 'vid:ar:9:16')
    .row()
    .text(q === '720p' ? '✅ 720p' : '720p', 'vid:q:720p')
    .text(q === '1080p' ? '✅ 1080p' : '1080p', 'vid:q:1080p')
    .row()
    .text('🧠 تغییر مدل ویدیو', 'mcat:video');
}

export function buildAudioStudioKeyboard(params: {
  voice?: string;
  language?: string;
}): InlineKeyboard {
  const voice = params.voice ?? 'Kore';
  const lang = params.language ?? 'fa';

  return new InlineKeyboard()
    .text('🎤 تبدیل ویس / صوت به متن (STT)', 'aud:mode:stt')
    .row()
    .text('🔊 تبدیل متن به گفتار (TTS)', 'aud:mode:tts')
    .row()
    .text(voice === 'Kore' ? '✅ صدای Kore' : 'صدای Kore', 'aud:voice:Kore')
    .text(voice === 'Puck' ? '✅ صدای Puck' : 'صدای Puck', 'aud:voice:Puck')
    .text(voice === 'alloy' ? '✅ صدای Alloy' : 'صدای Alloy', 'aud:voice:alloy')
    .row()
    .text(lang === 'fa' ? '✅ زبان فارسی' : 'زبان فارسی', 'aud:lang:fa')
    .text(lang === 'en' ? '✅ English' : 'English', 'aud:lang:en')
    .row()
    .text('🧠 تغییر مدل صوتی', 'mcat:audio');
}

export function buildSettingsKeyboard(currentLocale: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(currentLocale === 'fa' ? '✅ فارسی' : 'فارسی', 'set:lang:fa')
    .text(currentLocale === 'en' ? '✅ English' : 'English', 'set:lang:en')
    .row()
    .text('📝 تنظیم دستور سیستم (System Prompt)', 'conv:sysprompt')
    .row()
    .text('🆕 شروع گفتگوی جدید', 'conv:new')
    .text('🗑 پاک‌سازی حافظه گفتگو', 'conv:clear');
}

export function buildBuyPlansKeyboard(
  plans: Array<{
    id: string;
    name: string;
    starsPrice: number;
    durationDays: number;
    isRecurringStars: boolean;
  }>,
  hasActiveAutoRenew = false,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of plans.slice(0, 8)) {
    const recurTag = p.isRecurringStars ? ' · تمدید ماهانه' : '';
    const priceText = p.starsPrice > 0 ? `${p.starsPrice} ⭐️` : 'رایگان';
    kb.text(`💎 ${p.name} — ${priceText}${recurTag}`, `plan:select:${p.id}`).row();
  }
  kb.text('🪙 خرید بسته اعتبار (Stars)', 'store:packages')
    .text('🎁 اعمال کد هدیه', 'store:coupon')
    .row()
    .text('🧾 تاریخچه پرداخت‌ها و رسیدها', 'store:payments');
  if (hasActiveAutoRenew) {
    kb.row().text('⏹ لغو تمدید خودکار اشتراک', 'sub:cancel_renew');
  }
  kb.row().text('🆘 پشتیبانی پرداخت (/paysupport)', 'support:cat:payment');
  return kb;
}

export function buildCreditPackagesKeyboard(
  packages: Array<{
    id: string;
    name: string;
    creditsAmount: number;
    bonusCredits: number;
    starsPrice: number;
  }>,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const pkg of packages.slice(0, 8)) {
    const total = pkg.creditsAmount + pkg.bonusCredits;
    const bonusTag = pkg.bonusCredits > 0 ? ` (+${pkg.bonusCredits} هدیه)` : '';
    kb.text(`🪙 ${pkg.name} · ${total} اعتبار${bonusTag} — ${pkg.starsPrice} ⭐️`, `pkg:buy:${pkg.id}`).row();
  }
  kb.text('💎 بازگشت به پلن‌های اشتراک', 'store:plans').text('🎁 اعمال کد هدیه', 'store:coupon');
  return kb;
}

export function buildSupportCategoryKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('💳 مشکل پرداخت یا تلگرام استارز', 'support:cat:payment')
    .row()
    .text('↩️ درخواست بازپرداخت (Refund)', 'support:cat:refund')
    .row()
    .text('⚠️ خطای درخواست هوش مصنوعی', 'support:cat:failed_request')
    .row()
    .text('💬 سوال عمومی و راهنمایی', 'support:cat:general');
}

