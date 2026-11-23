import React, { useEffect, useState } from 'react';
import {
  Image as ImageIcon,
  Volume2,
  Video,
  Mic,
  Sparkles,
  Download,
  Loader2,
  AlertCircle,
  Upload,
} from 'lucide-react';
import { miniAppRequest, type MiniAppModel } from './miniAppApi';
import { triggerMiniAppHaptic } from './telegramSdk';

type StudioCapability =
  | 'image_generation'
  | 'speech_generation'
  | 'video_generation'
  | 'audio_transcription';

interface MiniAppStudioTabProps {
  models: MiniAppModel[];
  preferences: {
    selectedImageModelId: string | null;
    selectedAudioModelId: string | null;
    selectedVideoModelId: string | null;
  };
  onWalletUpdated: (wallet: { balance: number; reservedBalance: number }) => void;
}

const MODES: Array<{
  id: StudioCapability;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'image_generation', label: 'تصویر', icon: ImageIcon },
  { id: 'speech_generation', label: 'صدا (TTS)', icon: Volume2 },
  { id: 'video_generation', label: 'ویدیو', icon: Video },
  { id: 'audio_transcription', label: 'ویس به متن', icon: Mic },
];

export function MiniAppStudioTab({
  models,
  preferences,
  onWalletUpdated,
}: MiniAppStudioTabProps) {
  const [mode, setMode] = useState<StudioCapability>('image_generation');
  const [selectedModelByMode, setSelectedModelByMode] = useState<Record<StudioCapability, string>>({
    image_generation: preferences.selectedImageModelId ?? '',
    speech_generation: preferences.selectedAudioModelId ?? '',
    video_generation: preferences.selectedVideoModelId ?? '',
    audio_transcription: preferences.selectedAudioModelId ?? '',
  });

  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [voice, setVoice] = useState('Kore');
  const [durationSeconds, setDurationSeconds] = useState(5);
  const [audioFile, setAudioFile] = useState<{
    name: string;
    mimeType: string;
    base64: string;
  } | null>(null);

  const [generating, setGenerating] = useState(false);
  const [pollingJobId, setPollingJobId] = useState<string | null>(null);
  const [progressText, setProgressText] = useState('');
  const [error, setError] = useState('');

  const [result, setResult] = useState<{
    capability: StudioCapability;
    mediaUrl: string | null;
    responseText: string | null;
  } | null>(null);

  const modeModels = models.filter((m) => m.capabilities.includes(mode));
  const preferredId = selectedModelByMode[mode];
  const currentModelId =
    (preferredId && modeModels.some((m) => m.id === preferredId)
      ? preferredId
      : modeModels.find((m) => m.isDefault)?.id ?? modeModels[0]?.id) ?? '';
  const currentModel = modeModels.find((m) => m.id === currentModelId) ?? null;
  const suggestedAltModel =
    modeModels.find((m) => m.id !== currentModelId && m.providerId !== currentModel?.providerId) ??
    modeModels.find((m) => m.id !== currentModelId) ??
    null;

  // Poll async jobs (video generation)
  useEffect(() => {
    if (!pollingJobId) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const res = await miniAppRequest<{
          job: {
            id: string;
            status: string;
            capability: StudioCapability;
            progressPercent: number;
            responseText: string | null;
            mediaUrl: string | null;
            errorMessage: string | null;
          };
          wallet: { balance: number; reservedBalance: number };
        }>(`/api/miniapp/jobs/${encodeURIComponent(pollingJobId)}`);

        if (cancelled) return;
        onWalletUpdated(res.wallet);

        if (res.job.status === 'succeeded') {
          setResult({
            capability: res.job.capability,
            mediaUrl: res.job.mediaUrl,
            responseText: res.job.responseText,
          });
          setPollingJobId(null);
          setGenerating(false);
          setProgressText('');
          triggerMiniAppHaptic('success');
        } else if (res.job.status === 'failed') {
          setError(res.job.errorMessage || 'تولید رسانه ناموفق بود و اعتبار بازگردانده شد.');
          setPollingJobId(null);
          setGenerating(false);
          setProgressText('');
          triggerMiniAppHaptic('error');
        } else {
          setProgressText(`در حال رندر (${res.job.progressPercent || 25}%)...`);
        }
      } catch {
        // Keep polling on transient glitch
      }
    }, 3500);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollingJobId, onWalletUpdated]);

  const handleAudioUpload = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      setError('حجم فایل صوتی نباید بیشتر از ۸ مگابایت باشد.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] ?? '' : dataUrl;
      setAudioFile({
        name: file.name,
        mimeType: file.type || 'audio/mpeg',
        base64,
      });
      setError('');
    };
    reader.readAsDataURL(file);
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (generating) return;

    setError('');
    setResult(null);
    if (mode !== 'audio_transcription' && !prompt.trim()) {
      setError('لطفاً متن توصیفی را وارد کنید.');
      return;
    }
    if (mode === 'audio_transcription' && !audioFile) {
      setError('لطفاً یک فایل صوتی انتخاب کنید.');
      return;
    }

    setGenerating(true);
    setProgressText('در حال ارسال به موتور هوش مصنوعی...');
    triggerMiniAppHaptic('tap');

    try {
      const res = await miniAppRequest<{
        ok: boolean;
        jobId: string;
        status: string;
        responseText: string | null;
        mediaUrl: string | null;
        wallet: { balance: number; reservedBalance: number };
      }>('/api/miniapp/generate', {
        method: 'POST',
        body: {
          capability: mode,
          prompt: prompt.trim(),
          modelId: currentModelId || null,
          aspectRatio,
          voice,
          durationSeconds,
          audioBase64: mode === 'audio_transcription' ? audioFile?.base64 : undefined,
          mimeType: mode === 'audio_transcription' ? audioFile?.mimeType : undefined,
          fileName: mode === 'audio_transcription' ? audioFile?.name : undefined,
        },
      });

      onWalletUpdated(res.wallet);

      if (res.status === 'running') {
        setPollingJobId(res.jobId);
        setProgressText('پردازش زمان‌بر شروع شد. خروجی به محض آماده شدن نمایش داده می‌شود...');
      } else {
        setResult({
          capability: mode,
          mediaUrl: res.mediaUrl,
          responseText: res.responseText,
        });
        setGenerating(false);
        setProgressText('');
        triggerMiniAppHaptic('success');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در اجرای پردازش.');
      setGenerating(false);
      setProgressText('');
      triggerMiniAppHaptic('error');
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
      <section className="lg:col-span-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5 space-y-4">
        {/* Segmented Mode Selector */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" role="tablist" aria-label="حالت‌های استودیو">
          {MODES.map((item) => {
            const Icon = item.icon;
            const active = mode === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  setMode(item.id);
                  setError('');
                  triggerMiniAppHaptic('tap');
                }}
                className={`min-h-[44px] px-2.5 rounded-xl border text-xs font-medium flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                  active
                    ? 'bg-blue-700 border-blue-700 text-white'
                    : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>

        <form onSubmit={(e) => void handleGenerate(e)} className="space-y-4">
          <div>
            <label
              htmlFor="studio-model-select"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
            >
              مدل انتخابی
            </label>
            <select
              id="studio-model-select"
              value={currentModelId}
              onChange={(e) =>
                setSelectedModelByMode((prev) => ({ ...prev, [mode]: e.target.value }))
              }
              disabled={modeModels.length === 0 || generating}
              className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs font-medium text-slate-900 dark:text-slate-100"
            >
              {modeModels.length === 0 ? (
                <option value="">هیچ مدل فعالی برای این بخش تعریف نشده است</option>
              ) : (
                modeModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.providerName}) — {m.creditCost} اعتبار
                  </option>
                ))
              )}
            </select>
          </div>

          {mode === 'image_generation' && (
            <div>
              <span className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                نسبت تصویر
              </span>
              <div className="grid grid-cols-3 gap-2">
                {['1:1', '16:9', '9:16'].map((ratio) => (
                  <button
                    key={ratio}
                    type="button"
                    onClick={() => setAspectRatio(ratio)}
                    className={`min-h-[44px] rounded-xl border text-xs font-mono cursor-pointer ${
                      aspectRatio === ratio
                        ? 'bg-blue-50 dark:bg-blue-950/60 border-blue-600 text-blue-800 dark:text-blue-300 font-semibold'
                        : 'border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    {ratio}
                  </button>
                ))}
              </div>
            </div>
          )}

          {mode === 'speech_generation' && (
            <div>
              <label
                htmlFor="studio-voice-select"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                گوینده صوتی
              </label>
              <select
                id="studio-voice-select"
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
                className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs text-slate-900 dark:text-slate-100"
              >
                <option value="Kore">Kore (شفاف و استاندارد)</option>
                <option value="Puck">Puck (پرانرژی)</option>
                <option value="Charon">Charon (عمیق و مستند)</option>
                <option value="Aoede">Aoede (ملایم)</option>
                <option value="alloy">Alloy (OpenAI)</option>
              </select>
            </div>
          )}

          {mode === 'video_generation' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="studio-vid-ratio"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
                >
                  کادر ویدیو
                </label>
                <select
                  id="studio-vid-ratio"
                  value={aspectRatio}
                  onChange={(e) => setAspectRatio(e.target.value)}
                  className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs font-mono"
                >
                  <option value="16:9">16:9 افقی</option>
                  <option value="9:16">9:16 عمودی</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="studio-vid-duration"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
                >
                  مدت زمان
                </label>
                <select
                  id="studio-vid-duration"
                  value={durationSeconds}
                  onChange={(e) => setDurationSeconds(Number(e.target.value))}
                  className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs"
                >
                  <option value={5}>۵ ثانیه</option>
                  <option value={8}>۸ ثانیه</option>
                </select>
              </div>
            </div>
          )}

          {mode === 'audio_transcription' ? (
            <div>
              <label
                htmlFor="studio-audio-file"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                فایل صوتی (MP3, WAV, OGG, M4A)
              </label>
              <label
                htmlFor="studio-audio-file"
                className="min-h-[88px] px-4 py-4 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 hover:border-blue-500 flex flex-col items-center justify-center gap-2 text-xs text-slate-600 dark:text-slate-300 cursor-pointer"
              >
                <Upload className="w-5 h-5 text-blue-700 dark:text-blue-400" />
                <span>{audioFile ? audioFile.name : 'انتخاب فایل صوتی از دستگاه'}</span>
                <input
                  id="studio-audio-file"
                  type="file"
                  accept="audio/*"
                  className="sr-only"
                  onChange={(e) => handleAudioUpload(e.target.files?.[0])}
                />
              </label>
            </div>
          ) : (
            <div>
              <label
                htmlFor="studio-prompt-input"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                {mode === 'speech_generation' ? 'متن برای خوانش صوتی' : 'توصیف خروجی (پرامپت)'}
              </label>
              <textarea
                id="studio-prompt-input"
                rows={4}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={generating}
                placeholder={
                  mode === 'image_generation'
                    ? 'مثلاً: نمای سینمایی از برج آزادی در غروب آفتاب با سبک عکاسی واقعی...'
                    : mode === 'speech_generation'
                      ? 'متن فارسی یا انگلیسی مورد نظر برای تبدیل به گفتار را بنویسید...'
                      : 'توضیح صحنه و حرکت دوربین برای ساخت ویدیو...'
                }
                className="w-full p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-800 dark:text-rose-200 text-xs space-y-2"
            >
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="leading-relaxed">{error}</span>
              </div>
              {suggestedAltModel && /limit:\s*0|billing|سهمیه|429|403/i.test(error) && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedModelByMode((prev) => ({ ...prev, [mode]: suggestedAltModel.id }));
                    setError('');
                    triggerMiniAppHaptic('tap');
                  }}
                  className="min-h-[36px] px-3 rounded-lg bg-white dark:bg-slate-900 border border-rose-300 dark:border-rose-800 text-rose-900 dark:text-rose-100 font-medium hover:bg-rose-100 dark:hover:bg-rose-900/50 cursor-pointer transition-colors"
                >
                  تغییر مدل به: {suggestedAltModel.name} ({suggestedAltModel.providerName})
                </button>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={generating || modeModels.length === 0}
            className="w-full min-h-[48px] px-4 rounded-xl bg-blue-700 hover:bg-blue-800 disabled:bg-slate-300 dark:disabled:bg-slate-800 text-white text-sm font-medium flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:cursor-not-allowed"
          >
            {generating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{progressText || 'در حال پردازش...'}</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                <span>ساخت خروجی</span>
              </>
            )}
          </button>
        </form>
      </section>

      {/* Output Preview Stage */}
      <section className="lg:col-span-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5 flex flex-col justify-between min-h-[280px]">
        <div className="flex items-center justify-between gap-2 pb-3 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">پیش‌نمایش خروجی</h2>
          {result?.mediaUrl && (
            <a
              href={result.mediaUrl}
              download={`hooshnegar-${result.capability}`}
              className="min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 flex items-center gap-1.5"
            >
              <Download className="w-4 h-4" />
              <span>دانلود</span>
            </a>
          )}
        </div>

        <div className="flex-1 flex items-center justify-center py-4">
          {generating ? (
            <div className="text-center space-y-2 text-xs text-slate-500">
              <Loader2 className="w-7 h-7 animate-spin text-blue-700 dark:text-blue-400 mx-auto" />
              <div>{progressText || 'در حال تولید فایل...'}</div>
            </div>
          ) : !result ? (
            <div className="text-center text-xs text-slate-500 dark:text-slate-400 max-w-xs leading-relaxed">
              پس از اجرای پردازش، تصویر، فایل صوتی، ویدیو یا متن پیاده‌سازی‌شده در همین بخش نمایش داده می‌شود.
            </div>
          ) : (
            <div className="w-full space-y-3">
              {result.capability === 'image_generation' && result.mediaUrl && (
                <img
                  src={result.mediaUrl}
                  alt="تصویر تولیدشده توسط هوش‌نگار"
                  className="w-full max-h-[380px] object-contain rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950"
                />
              )}
              {result.capability === 'speech_generation' && result.mediaUrl && (
                <audio controls src={result.mediaUrl} className="w-full" />
              )}
              {result.capability === 'video_generation' && result.mediaUrl && (
                <video
                  controls
                  playsInline
                  src={result.mediaUrl}
                  className="w-full max-h-[380px] rounded-xl border border-slate-200 dark:border-slate-800 bg-black"
                />
              )}
              {result.responseText && (
                <div
                  dir="auto"
                  className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs sm:text-sm text-slate-800 dark:text-slate-200 whitespace-pre-wrap leading-relaxed"
                >
                  {result.responseText}
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
