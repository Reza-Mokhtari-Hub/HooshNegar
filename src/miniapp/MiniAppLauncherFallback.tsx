import React from 'react';
import { Bot, MessageSquare, Sparkles, Coins, ArrowUpLeft, ShieldCheck } from 'lucide-react';
import type { MiniAppPublicInfo } from './miniAppApi';

export function MiniAppLauncherFallback({ info }: { info: MiniAppPublicInfo | null }) {
  const botUsername = info?.botUsername?.replace(/^@/, '') ?? '';
  const botDisplayName = info?.botDisplayName || 'هوش‌نگار';
  const telegramBotUrl = botUsername ? `https://t.me/${botUsername}` : '';
  const telegramMiniAppDirectUrl = botUsername ? `https://t.me/${botUsername}?startapp=miniapp` : '';

  return (
    <div
      dir="rtl"
      className="min-h-dvh bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col justify-center px-4 py-8"
    >
      <div className="w-full max-w-lg mx-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 sm:p-8 shadow-sm space-y-6">
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-blue-700 text-white flex items-center justify-center shrink-0">
            <Bot className="w-6 h-6" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">
              مینی‌اپ {botDisplayName}
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {botUsername ? (
                <span dir="ltr" className="font-mono">
                  @{botUsername}
                </span>
              ) : (
                'متصل به ربات هوش مصنوعی هوش‌نگار'
              )}
            </p>
          </div>
        </div>

        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
          این صفحه رابط اختصاصی <strong>Telegram Mini App</strong> است و برای احراز هویت امن حساب کاربری، کیف‌پول و پرداخت تلگرام استارز باید از داخل اپلیکیشن تلگرام باز شود.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
            <MessageSquare className="w-4 h-4 text-blue-700 dark:text-blue-400 mb-2" />
            <div className="font-semibold text-slate-900 dark:text-slate-100">گفتگوی چندمدلی</div>
            <div className="text-slate-500 dark:text-slate-400 mt-1">همگام با تاریخچه ربات</div>
          </div>
          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
            <Sparkles className="w-4 h-4 text-blue-700 dark:text-blue-400 mb-2" />
            <div className="font-semibold text-slate-900 dark:text-slate-100">استودیو رسانه</div>
            <div className="text-slate-500 dark:text-slate-400 mt-1">تولید تصویر، صوت و ویدیو</div>
          </div>
          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
            <Coins className="w-4 h-4 text-blue-700 dark:text-blue-400 mb-2" />
            <div className="font-semibold text-slate-900 dark:text-slate-100">کیف‌پول و استارز</div>
            <div className="text-slate-500 dark:text-slate-400 mt-1">پرداخت آنی درون‌تلگرامی</div>
          </div>
        </div>

        <div className="space-y-3 pt-2 border-t border-slate-200 dark:border-slate-800">
          {telegramBotUrl ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <a
                href={telegramMiniAppDirectUrl}
                className="min-h-[48px] px-4 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-sm font-medium flex items-center justify-center gap-2 transition-colors"
              >
                <Bot className="w-4 h-4" />
                <span>باز کردن مینی‌اپ در تلگرام</span>
              </a>
              <a
                href={telegramBotUrl}
                className="min-h-[48px] px-4 rounded-xl border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 text-sm font-medium flex items-center justify-center gap-2 transition-colors"
              >
                <ArrowUpLeft className="w-4 h-4" />
                <span>ورود به چت ربات</span>
              </a>
            </div>
          ) : (
            <div className="p-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 text-xs text-amber-800 dark:text-amber-200">
              ربات تلگرام هنوز متصل نشده است. از پنل مدیریت وارد بخش «ربات تلگرام» شده و توکن ربات را ذخیره و همگام‌سازی کنید.
            </div>
          )}

          <div className="flex items-center justify-between pt-2 text-xs text-slate-500 dark:text-slate-400">
            <span>ادمین سامانه هستید؟</span>
            <a
              href="/"
              className="inline-flex items-center gap-1.5 min-h-[44px] px-2 font-medium text-blue-700 dark:text-blue-400 hover:underline"
            >
              <ShieldCheck className="w-4 h-4" />
              <span>بازگشت به پنل مدیریت</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
