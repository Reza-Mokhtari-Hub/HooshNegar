import React, { useEffect, useRef, useState } from 'react';
import {
  Image as ImageIcon,
  Wand2,
  Volume2,
  Video,
  Mic,
  Sparkles,
  Download,
  Loader2,
  AlertCircle,
  Upload,
  X,
} from 'lucide-react';
import { miniAppRequest, type MiniAppModel } from './miniAppApi';
import { triggerMiniAppHaptic } from './telegramSdk';

type StudioTabMode =
  | 'image_generation'
  | 'image_editing'
  | 'speech_generation'
  | 'video_generation'
  | 'audio_transcription';

type StudioCapability =
  | 'image_generation'
  | 'image_editing'
  | 'image_variation'
  | 'speech_generation'
  | 'video_generation'
  | 'audio_transcription';

interface UploadedImageState {
  name: string;
  mimeType: string;
  base64: string;
  previewUrl: string;
}

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
  id: StudioTabMode;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'image_generation', label: 'ساخت تصویر', icon: ImageIcon },
  { id: 'image_editing', label: 'ویرایش تصویر', icon: Wand2 },
  { id: 'speech_generation', label: 'صدا (TTS)', icon: Volume2 },
  { id: 'video_generation', label: 'ویدیو', icon: Video },
  { id: 'audio_transcription', label: 'ویس به متن', icon: Mic },
];

function createClientRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function MiniAppStudioTab({
  models,
  preferences,
  onWalletUpdated,
}: MiniAppStudioTabProps) {
  const [mode, setMode] = useState<StudioTabMode>('image_generation');
  const [imageEditOp, setImageEditOp] = useState<'edit' | 'variation'>('edit');
  const [selectedModelByMode, setSelectedModelByMode] = useState<Record<StudioCapability, string>>({
    image_generation: preferences.selectedImageModelId ?? '',
    image_editing: preferences.selectedImageModelId ?? '',
    image_variation: preferences.selectedImageModelId ?? '',
    speech_generation: preferences.selectedAudioModelId ?? '',
    video_generation: preferences.selectedVideoModelId ?? '',
    audio_transcription: preferences.selectedAudioModelId ?? '',
  });

  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [voice, setVoice] = useState('Kore');
  const [durationSeconds, setDurationSeconds] = useState(5);
  const [sourceImage, setSourceImage] = useState<UploadedImageState | null>(null);
  const [audioFile, setAudioFile] = useState<{
    name: string;
    mimeType: string;
    base64: string;
  } | null>(null);

  const [generating, setGenerating] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [pollingJobId, setPollingJobId] = useState<string | null>(null);
  const [progressText, setProgressText] = useState('');
  const [error, setError] = useState('');
  const submitLockRef = useRef(false);

  const [result, setResult] = useState<{
    capability: StudioCapability;
    mediaUrl: string | null;
    responseText: string | null;
  } | null>(null);

  const effectiveCapability: StudioCapability =
    mode === 'image_editing'
      ? imageEditOp === 'variation'
        ? 'image_variation'
        : 'image_editing'
      : mode;

  const modeModels = models.filter((m) => m.capabilities.includes(effectiveCapability));
  const preferredId = selectedModelByMode[effectiveCapability];
  const currentModelId =
    (preferredId && modeModels.some((m) => m.id === preferredId)
      ? preferredId
      : modeModels.find((m) => m.isDefault)?.id ?? modeModels[0]?.id) ?? '';
  const currentModel = modeModels.find((m) => m.id === currentModelId) ?? null;
  const suggestedAltModel =
    modeModels.find((m) => m.id !== currentModelId && m.providerId !== currentModel?.providerId) ??
    modeModels.find((m) => m.id !== currentModelId) ??
    null;

  // Poll async jobs (image/edit/video generation)
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
          submitLockRef.current = false;
          setProgressText('');
          triggerMiniAppHaptic('success');
        } else if (res.job.status === 'failed' || res.job.status === 'canceled') {
          setError(
            res.job.errorMessage ||
              (res.job.status === 'canceled'
                ? 'پردازش لغو شد و اعتبار به کیف‌پول بازگردانده شد.'
                : 'تولید رسانه ناموفق بود و اعتبار بازگردانده شد.'),
          );
          setPollingJobId(null);
          setGenerating(false);
          submitLockRef.current = false;
          setProgressText('');
          triggerMiniAppHaptic('error');
        } else {
          setProgressText(`در حال پردازش (${res.job.progressPercent || 25}٪)...`);
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

  const handleImageUpload = (file: File | undefined) => {
    if (!file) return;
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    const isAllowed =
      allowedTypes.includes(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name);
    if (!isAllowed) {
      setError('فرمت تصویر باید JPG، PNG یا WebP باشد.');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError('حجم تصویر نباید بیشتر از ۸ مگابایت باشد.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] ?? '' : dataUrl;
      setSourceImage({
        name: file.name,
        mimeType: file.type || 'image/jpeg',
        base64,
        previewUrl: dataUrl,
      });
      setError('');
    };
    reader.readAsDataURL(file);
  };

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

  const handleCancelJob = async () => {
    if (!pollingJobId || canceling) return;
    setCanceling(true);
    try {
      const res = await miniAppRequest<{
        ok: boolean;
        status: string;
        wallet: { balance: number; reservedBalance: number };
      }>(`/api/miniapp/jobs/${encodeURIComponent(pollingJobId)}/cancel`, {
        method: 'POST',
      });
      onWalletUpdated(res.wallet);
      setPollingJobId(null);
      setGenerating(false);
      submitLockRef.current = false;
      setProgressText('');
      setError('پردازش لغو شد و اعتبار رزروشده به کیف‌پول بازگردانده شد.');
      triggerMiniAppHaptic('tap');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در لغو پردازش.');
    } finally {
      setCanceling(false);
    }
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitLockRef.current || generating) return;

    setError('');
    setResult(null);

    if (
      (effectiveCapability === 'image_editing' || effectiveCapability === 'image_variation') &&
      !sourceImage
    ) {
      setError('لطفاً ابتدا تصویر مرجع مورد نظر برای ویرایش را آپلود کنید.');
      return;
    }
    if (
      effectiveCapability !== 'audio_transcription' &&
      effectiveCapability !== 'image_variation' &&
      !prompt.trim()
    ) {
      setError(
        effectiveCapability === 'image_editing'
          ? 'لطفاً دستور ویرایش تصویر را بنویسید.'
          : 'لطفاً متن توصیفی را وارد کنید.',
      );
      return;
    }
    if (effectiveCapability === 'audio_transcription' && !audioFile) {
      setError('لطفاً یک فایل صوتی انتخاب کنید.');
      return;
    }

    submitLockRef.current = true;
    setGenerating(true);
    setProgressText('در حال ارسال به موتور هوش مصنوعی...');
    triggerMiniAppHaptic('tap');

    const clientRequestId = createClientRequestId();
    const attachSourceImage =
      effectiveCapability === 'image_editing' ||
      effectiveCapability === 'image_variation' ||
      (effectiveCapability === 'video_generation' && Boolean(sourceImage));

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
          capability: effectiveCapability,
          prompt: prompt.trim(),
          modelId: currentModelId || null,
          clientRequestId,
          aspectRatio,
          voice,
          durationSeconds,
          audioBase64: effectiveCapability === 'audio_transcription' ? audioFile?.base64 : undefined,
          sourceImageBase64: attachSourceImage ? sourceImage?.base64 : undefined,
          sourceMimeType: attachSourceImage ? sourceImage?.mimeType : undefined,
          mimeType:
            effectiveCapability === 'audio_transcription' ? audioFile?.mimeType : undefined,
          fileName: effectiveCapability === 'audio_transcription' ? audioFile?.name : undefined,
        },
      });

      onWalletUpdated(res.wallet);

      if (res.status === 'running' || res.status === 'queued') {
        setPollingJobId(res.jobId);
        setProgressText('در صف پردازش قرار گرفت. نتیجه به محض آماده شدن نمایش داده می‌شود...');
      } else {
        setResult({
          capability: effectiveCapability,
          mediaUrl: res.mediaUrl,
          responseText: res.responseText,
        });
        setGenerating(false);
        submitLockRef.current = false;
        setProgressText('');
        triggerMiniAppHaptic('success');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در اجرای پردازش.');
      setGenerating(false);
      submitLockRef.current = false;
      setProgressText('');
      triggerMiniAppHaptic('error');
    }
  };

  const isImageResult =
    result &&
    (result.capability === 'image_generation' ||
      result.capability === 'image_editing' ||
      result.capability === 'image_variation');

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
      <section className="lg:col-span-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5 space-y-4">
        {/* Segmented Mode Selector */}
        <div
          className="grid grid-cols-2 sm:grid-cols-3 gap-2"
          role="tablist"
          aria-label="حالت‌های استودیو"
        >
          {MODES.map((item, idx) => {
            const Icon = item.icon;
            const active = mode === item.id;
            const isLastOdd = idx === MODES.length - 1 && MODES.length % 2 === 1;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                disabled={generating}
                onClick={() => {
                  setMode(item.id);
                  setError('');
                  triggerMiniAppHaptic('tap');
                }}
                className={`min-h-[44px] px-2.5 rounded-xl border text-xs font-medium flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors cursor-pointer disabled:opacity-60 ${
                  isLastOdd ? 'col-span-2 sm:col-span-1' : ''
                } ${
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
          {mode === 'image_editing' && (
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={generating}
                onClick={() => setImageEditOp('edit')}
                className={`min-h-[44px] px-3 rounded-xl border text-xs font-medium cursor-pointer transition-colors ${
                  imageEditOp === 'edit'
                    ? 'bg-blue-50 dark:bg-blue-950/60 border-blue-600 text-blue-800 dark:text-blue-200 font-semibold'
                    : 'border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300'
                }`}
              >
                ویرایش با دستور
              </button>
              <button
                type="button"
                disabled={generating}
                onClick={() => setImageEditOp('variation')}
                className={`min-h-[44px] px-3 rounded-xl border text-xs font-medium cursor-pointer transition-colors ${
                  imageEditOp === 'variation'
                    ? 'bg-blue-50 dark:bg-blue-950/60 border-blue-600 text-blue-800 dark:text-blue-200 font-semibold'
                    : 'border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300'
                }`}
              >
                نسخه مشابه (Variation)
              </button>
            </div>
          )}

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
                setSelectedModelByMode((prev) => ({
                  ...prev,
                  [effectiveCapability]: e.target.value,
                }))
              }
              disabled={modeModels.length === 0 || generating}
              className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs font-medium text-slate-900 dark:text-slate-100"
            >
              {modeModels.length === 0 ? (
                <option value="">هیچ مدل فعالی برای این بخش تعریف نشده است</option>
              ) : (
                modeModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.creditCost.toLocaleString('fa-IR')} اعتبار)
                  </option>
                ))
              )}
            </select>
          </div>

          {(mode === 'image_editing' || mode === 'video_generation') && (
            <div>
              <label
                htmlFor="studio-source-image"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
              >
                {mode === 'image_editing'
                  ? 'تصویر مرجع برای ویرایش (الزامی)'
                  : 'تصویر شروع ویدیو (اختیاری - Image to Video)'}
              </label>

              {sourceImage ? (
                <div className="p-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 flex items-center gap-3">
                  <img
                    src={sourceImage.previewUrl}
                    alt="پیش‌نمایش تصویر مرجع"
                    className="w-16 h-16 rounded-lg object-cover border border-slate-200 dark:border-slate-800 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
                      {sourceImage.name}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">آماده ارسال به مدل</div>
                  </div>
                  <button
                    type="button"
                    disabled={generating}
                    onClick={() => setSourceImage(null)}
                    aria-label="حذف تصویر مرجع"
                    className="min-h-[44px] min-w-[44px] rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-slate-500 hover:text-rose-600 flex items-center justify-center cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <label
                  htmlFor="studio-source-image"
                  className="min-h-[84px] px-4 py-3 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 hover:border-blue-500 flex flex-col items-center justify-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer"
                >
                  <Upload className="w-5 h-5 text-blue-700 dark:text-blue-400" />
                  <span>انتخاب تصویر (JPG, PNG, WebP تا ۸ مگابایت)</span>
                  <input
                    id="studio-source-image"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="sr-only"
                    onChange={(e) => {
                      handleImageUpload(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                </label>
              )}
            </div>
          )}

          {(mode === 'image_generation' || mode === 'image_editing') && (
            <div>
              <span className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                نسبت تصویر
              </span>
              <div className="grid grid-cols-3 gap-2">
                {['1:1', '16:9', '9:16'].map((ratio) => (
                  <button
                    key={ratio}
                    type="button"
                    disabled={generating}
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
                disabled={generating}
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
                  disabled={generating}
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
                  disabled={generating}
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
                {effectiveCapability === 'speech_generation'
                  ? 'متن برای خوانش صوتی'
                  : effectiveCapability === 'image_editing'
                    ? 'دستور ویرایش تصویر'
                    : effectiveCapability === 'image_variation'
                      ? 'توضیح تکمیلی برای نسخه مشابه (اختیاری)'
                      : 'توصیف خروجی (پرامپت)'}
              </label>
              <textarea
                id="studio-prompt-input"
                rows={4}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={generating}
                placeholder={
                  effectiveCapability === 'image_generation'
                    ? 'مثلاً: نمای سینمایی از برج آزادی در غروب آفتاب با سبک عکاسی واقعی...'
                    : effectiveCapability === 'image_editing'
                      ? 'مثلاً: پس‌زمینه را به ساحل آفتابی تغییر بده و نورپردازی را سینمایی کن...'
                      : effectiveCapability === 'image_variation'
                        ? 'مثلاً: با حفظ ترکیب اصلی، سبک نقاشی آبرنگ بدهد (یا خالی بگذارید)...'
                        : effectiveCapability === 'speech_generation'
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
              {suggestedAltModel && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedModelByMode((prev) => ({
                      ...prev,
                      [effectiveCapability]: suggestedAltModel.id,
                    }));
                    setError('');
                    triggerMiniAppHaptic('tap');
                  }}
                  className="min-h-[44px] px-3 rounded-lg bg-white dark:bg-slate-900 border border-rose-300 dark:border-rose-800 text-rose-900 dark:text-rose-100 font-medium hover:bg-rose-100 dark:hover:bg-rose-900/50 cursor-pointer transition-colors"
                >
                  تغییر مدل به: {suggestedAltModel.name}
                </button>
              )}
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-2">
            <button
              type="submit"
              disabled={generating || modeModels.length === 0}
              className="flex-1 min-h-[48px] px-4 rounded-xl bg-blue-700 hover:bg-blue-800 disabled:bg-slate-300 dark:disabled:bg-slate-800 text-white text-sm font-medium flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:cursor-not-allowed"
            >
              {generating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  <span>{progressText || 'در حال پردازش...'}</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 shrink-0" />
                  <span>
                    {effectiveCapability === 'image_editing'
                      ? 'اعمال ویرایش تصویر'
                      : effectiveCapability === 'image_variation'
                        ? 'ساخت نسخه مشابه'
                        : 'ساخت خروجی'}
                  </span>
                </>
              )}
            </button>

            {generating && pollingJobId && (
              <button
                type="button"
                disabled={canceling}
                onClick={() => void handleCancelJob()}
                className="min-h-[48px] px-4 rounded-xl border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-900/40 text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <X className="w-4 h-4" />
                <span>{canceling ? 'در حال لغو...' : 'لغو و بازگشت اعتبار'}</span>
              </button>
            )}
          </div>
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
              پس از اجرای پردازش، تصویر ساخته‌شده یا ویرایش‌شده، فایل صوتی، ویدیو یا متن پیاده‌سازی‌شده در همین بخش نمایش داده می‌شود.
            </div>
          ) : (
            <div className="w-full space-y-3">
              {isImageResult && result.mediaUrl && (
                <img
                  src={result.mediaUrl}
                  alt="تصویر تولید یا ویرایش‌شده توسط هوش‌نگار"
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
