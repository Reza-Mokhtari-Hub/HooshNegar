import React, { useState } from 'react';
import {
  Save,
  Copy,
  Check,
  Users,
  LifeBuoy,
  Loader2,
  AlertCircle,
  ExternalLink,
} from 'lucide-react';
import { miniAppRequest, type MiniAppBootstrap } from './miniAppApi';
import { triggerMiniAppHaptic } from './telegramSdk';

interface MiniAppAccountTabProps {
  bootstrap: MiniAppBootstrap;
  onRefreshBootstrap: () => Promise<void>;
}

export function MiniAppAccountTab({
  bootstrap,
  onRefreshBootstrap,
}: MiniAppAccountTabProps) {
  const [textModelId, setTextModelId] = useState(
    bootstrap.preferences.selectedTextModelId ?? '',
  );
  const [imageModelId, setImageModelId] = useState(
    bootstrap.preferences.selectedImageModelId ?? '',
  );
  const [audioModelId, setAudioModelId] = useState(
    bootstrap.preferences.selectedAudioModelId ?? '',
  );
  const [videoModelId, setVideoModelId] = useState(
    bootstrap.preferences.selectedVideoModelId ?? '',
  );
  const [systemPrompt, setSystemPrompt] = useState(bootstrap.preferences.systemPrompt ?? '');
  const [locale, setLocale] = useState<'fa' | 'en'>(bootstrap.preferences.locale ?? 'fa');

  const [savingPrefs, setSavingPrefs] = useState(false);
  const [copiedRef, setCopiedRef] = useState(false);

  const [ticketCategory, setTicketCategory] = useState<
    'general' | 'payment' | 'refund' | 'failed_request'
  >('general');
  const [ticketSubject, setTicketSubject] = useState('');
  const [ticketMessage, setTicketMessage] = useState('');
  const [sendingTicket, setSendingTicket] = useState(false);

  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');

  const chatModels = bootstrap.models.filter(
    (m) => m.capabilities.includes('chat') || m.capabilities.includes('text_generation'),
  );
  const imageModels = bootstrap.models.filter((m) =>
    m.capabilities.includes('image_generation'),
  );
  const audioModels = bootstrap.models.filter(
    (m) =>
      m.capabilities.includes('speech_generation') ||
      m.capabilities.includes('audio_transcription'),
  );
  const videoModels = bootstrap.models.filter((m) =>
    m.capabilities.includes('video_generation'),
  );

  const botUsernameClean = bootstrap.bot.username.replace(/^@/, '');
  const refCode = bootstrap.referralDashboard.referralCode ?? '';
  const referralUrl =
    botUsernameClean && refCode ? `https://t.me/${botUsernameClean}?start=REF_${refCode}` : '';

  const handleSavePreferences = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setFeedback('');
    setSavingPrefs(true);
    triggerMiniAppHaptic('tap');

    try {
      await miniAppRequest('/api/miniapp/preferences', {
        method: 'PATCH',
        body: {
          locale,
          systemPrompt,
          selectedTextModelId: textModelId || null,
          selectedImageModelId: imageModelId || null,
          selectedAudioModelId: audioModelId || null,
          selectedVideoModelId: videoModelId || null,
        },
      });
      setFeedback('تنظیمات کاربری ذخیره شد و در چت ربات و مینی‌اپ اعمال می‌گردد.');
      triggerMiniAppHaptic('success');
      await onRefreshBootstrap();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در ذخیره تنظیمات.');
      triggerMiniAppHaptic('error');
    } finally {
      setSavingPrefs(false);
    }
  };

  const handleCopyReferral = async () => {
    if (!referralUrl) return;
    try {
      await navigator.clipboard.writeText(referralUrl);
      setCopiedRef(true);
      triggerMiniAppHaptic('tap');
      setTimeout(() => setCopiedRef(false), 1600);
    } catch {
      // Ignore clipboard failure
    }
  };

  const handleSendTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ticketSubject.trim() || !ticketMessage.trim() || sendingTicket) return;
    setError('');
    setFeedback('');
    setSendingTicket(true);
    triggerMiniAppHaptic('tap');

    try {
      const res = await miniAppRequest<{ ok: boolean; trackingCode?: string }>(
        '/api/miniapp/support',
        {
          method: 'POST',
          body: {
            category: ticketCategory,
            subject: ticketSubject.trim(),
            message: ticketMessage.trim(),
          },
        },
      );
      setFeedback(
        `تیکت پشتیبانی با کد پیگیری ${res.trackingCode ?? ''} ثبت شد و توسط ادمین بررسی می‌شود.`,
      );
      setTicketSubject('');
      setTicketMessage('');
      triggerMiniAppHaptic('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در ثبت تیکت پشتیبانی.');
      triggerMiniAppHaptic('error');
    } finally {
      setSendingTicket(false);
    }
  };

  return (
    <div className="space-y-5">
      {feedback && (
        <div
          role="status"
          className="p-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-200 text-xs flex items-center gap-2"
        >
          <Check className="w-4 h-4 shrink-0" />
          <span>{feedback}</span>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="p-3.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-800 dark:text-rose-200 text-xs flex items-center gap-2"
        >
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Preferences & Default Models */}
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5 space-y-4">
          <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
            مدل‌های پیش‌فرض و پرامپت سیستم
          </h2>
          <form onSubmit={(e) => void handleSavePreferences(e)} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="pref-text-model"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                >
                  مدل گفتگو
                </label>
                <select
                  id="pref-text-model"
                  value={textModelId}
                  onChange={(e) => setTextModelId(e.target.value)}
                  className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs"
                >
                  <option value="">خودکار (پیش‌فرض)</option>
                  {chatModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  htmlFor="pref-image-model"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                >
                  مدل تصویر
                </label>
                <select
                  id="pref-image-model"
                  value={imageModelId}
                  onChange={(e) => setImageModelId(e.target.value)}
                  className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs"
                >
                  <option value="">خودکار (پیش‌فرض)</option>
                  {imageModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  htmlFor="pref-audio-model"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                >
                  مدل صوتی
                </label>
                <select
                  id="pref-audio-model"
                  value={audioModelId}
                  onChange={(e) => setAudioModelId(e.target.value)}
                  className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs"
                >
                  <option value="">خودکار (پیش‌فرض)</option>
                  {audioModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  htmlFor="pref-video-model"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                >
                  مدل ویدیو
                </label>
                <select
                  id="pref-video-model"
                  value={videoModelId}
                  onChange={(e) => setVideoModelId(e.target.value)}
                  className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs"
                >
                  <option value="">خودکار (پیش‌فرض)</option>
                  {videoModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label
                htmlFor="pref-locale"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                زبان ترجیحی ربات
              </label>
              <select
                id="pref-locale"
                value={locale}
                onChange={(e) => setLocale(e.target.value === 'en' ? 'en' : 'fa')}
                className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs"
              >
                <option value="fa">فارسی</option>
                <option value="en">English</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="pref-system-prompt"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                دستورالعمل ثابت گفتگو (System Prompt)
              </label>
              <textarea
                id="pref-system-prompt"
                rows={3}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="مثلاً: همیشه پاسخ‌ها را خلاصه، دقیق و با مثال عملی بنویس."
                className="w-full p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs"
              />
            </div>

            <button
              type="submit"
              disabled={savingPrefs}
              className="w-full min-h-[44px] px-4 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs font-medium flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
            >
              {savingPrefs ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              <span>ذخیره تنظیمات</span>
            </button>
          </form>
        </section>

        {/* Referral & Support */}
        <div className="space-y-4">
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">دعوت دوستان</h2>
              <Users className="w-4 h-4 text-blue-700 dark:text-blue-400" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                <div className="text-[11px] text-slate-500">دعوت‌های موفق</div>
                <div className="text-lg font-bold tabular-nums mt-0.5">
                  {bootstrap.referralDashboard.totalInvited.toLocaleString('fa-IR')}
                </div>
              </div>
              <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                <div className="text-[11px] text-slate-500">پاداش دریافت‌شده</div>
                <div className="text-lg font-bold tabular-nums mt-0.5">
                  {bootstrap.referralDashboard.earnedCredits.toLocaleString('fa-IR')} اعتبار
                </div>
              </div>
            </div>
            {referralUrl && (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  dir="ltr"
                  value={referralUrl}
                  aria-label="لینک دعوت اختصاصی"
                  className="flex-1 min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs font-mono text-slate-700 dark:text-slate-300"
                />
                <button
                  type="button"
                  onClick={() => void handleCopyReferral()}
                  aria-label="کپی لینک دعوت"
                  className="min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium flex items-center gap-1.5 cursor-pointer shrink-0"
                >
                  {copiedRef ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                  <span>{copiedRef ? 'کپی شد' : 'کپی'}</span>
                </button>
              </div>
            )}
          </section>

          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">ثبت تیکت پشتیبانی</h2>
              {bootstrap.bot.supportUsername ? (
                <a
                  href={`https://t.me/${bootstrap.bot.supportUsername.replace(/^@/, '')}`}
                  className="min-h-[44px] px-2.5 text-xs text-blue-700 dark:text-blue-400 flex items-center gap-1.5 hover:underline"
                >
                  <span>پشتیبانی تلگرام</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              ) : (
                <LifeBuoy className="w-4 h-4 text-blue-700 dark:text-blue-400" />
              )}
            </div>
            <form onSubmit={(e) => void handleSendTicket(e)} className="space-y-2.5">
              <select
                value={ticketCategory}
                onChange={(e) =>
                  setTicketCategory(
                    e.target.value as 'general' | 'payment' | 'refund' | 'failed_request',
                  )
                }
                aria-label="دسته‌بندی تیکت"
                className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs"
              >
                <option value="general">سوال عمومی</option>
                <option value="payment">پیگیری پرداخت استارز</option>
                <option value="refund">درخواست بازگشت وجه</option>
                <option value="failed_request">خطای پردازش هوش مصنوعی</option>
              </select>
              <input
                type="text"
                value={ticketSubject}
                onChange={(e) => setTicketSubject(e.target.value)}
                placeholder="موضوع پیام"
                className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs"
              />
              <textarea
                rows={3}
                value={ticketMessage}
                onChange={(e) => setTicketMessage(e.target.value)}
                placeholder="شرح دقیق مشکل یا درخواست..."
                className="w-full p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs"
              />
              <button
                type="submit"
                disabled={sendingTicket || !ticketSubject.trim() || !ticketMessage.trim()}
                className="w-full min-h-[44px] px-4 rounded-xl border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                {sendingTicket ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <LifeBuoy className="w-4 h-4" />
                )}
                <span>ارسال تیکت پشتیبانی</span>
              </button>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}
