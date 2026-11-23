import React, { useCallback, useEffect, useState } from 'react';
import {
  Plus,
  PlugZap,
  KeyRound,
  Pencil,
  Trash2,
  Search,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  ExternalLink,
  Gift,
} from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, formatDateTime, formatNumber, type Locale } from '../../i18n';
import {
  PROVIDER_TYPES,
  type CredentialPoolStatus,
  type ProviderType,
} from '../../shared/validation';
import {
  Button,
  EmptyState,
  FieldLabel,
  Input,
  Modal,
  Select,
  StatusText,
  Surface,
  TableSkeleton,
  Textarea,
} from '../ui/primitives';

export interface ProviderRecord {
  id: string;
  name: string;
  slug: string;
  providerType: ProviderType;
  baseUrl: string;
  organizationId: string | null;
  additionalHeaders: Record<string, string>;
  connectionStatus: 'untested' | 'connected' | 'degraded' | 'failed';
  lastTestMessage: string | null;
  lastTestLatencyMs: number | null;
  lastTestedAt: string | null;
  isActive: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
  hasCredential: boolean;
  maskedApiKey: string | null;
  keyVersion: number | null;
  activeKeysCount?: number;
  healthyKeysCount?: number;
  exhaustedKeysCount?: number;
  invalidKeysCount?: number;
  primaryCredentialStatus?: string | null;
  modelsTotal: number;
  modelsActive: number;
}

interface PoolCredentialItem {
  id: string;
  providerId: string;
  label: string;
  keyVersion: number;
  maskedPreview: string;
  priority: number;
  status: CredentialPoolStatus | string;
  cooldownUntil: string | null;
  failureCount: number;
  lastUsedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  isActive: boolean;
  createdAt: string;
}

const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  openai_compatible: 'https://api.openai.com/v1',
  google_gemini: 'https://generativelanguage.googleapis.com',
  anthropic: 'https://api.anthropic.com',
  replicate: 'https://api.replicate.com',
  fal_ai: 'https://api.fal.ai',
  huggingface: 'https://router.huggingface.co',
  huggingface_space: 'https://huggingface.co/spaces/owner/space',
  cloudflare_workers_ai: 'https://api.cloudflare.com/client/v4',
  custom: 'https://api.example.com/v1',
};

interface FreeApiPreset {
  id: string;
  name: string;
  providerType: ProviderType;
  baseUrl: string;
  signupUrl: string;
  categories: Array<'text' | 'image' | 'audio'>;
  freeQuotaFa: string;
  freeQuotaEn: string;
  noteFa: string;
  noteEn: string;
}

const FREE_API_PROVIDERS: FreeApiPreset[] = [
  {
    id: 'cloudflare-workers-ai',
    name: 'Cloudflare Workers AI',
    providerType: 'cloudflare_workers_ai',
    baseUrl: 'https://api.cloudflare.com/client/v4',
    signupUrl: 'https://dash.cloudflare.com/',
    categories: ['text', 'image', 'audio'],
    freeQuotaFa: '۱۰,۰۰۰ Neuron رایگان روزانه (بدون کارت بانکی)',
    freeQuotaEn: '10,000 free Neurons/day (no credit card required)',
    noteFa: 'پشتیبانی از FLUX.1 Schnell، SDXL، Llama 3.3، Qwen 3، DeepSeek R1، Whisper و Deepgram TTS.',
    noteEn: 'Includes FLUX.1 Schnell, SDXL, Llama 3.3, Qwen 3, DeepSeek R1, Whisper STT, and Deepgram TTS.',
  },
  {
    id: 'google-ai-studio',
    name: 'Google AI Studio',
    providerType: 'google_gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    signupUrl: 'https://aistudio.google.com/apikey',
    categories: ['text', 'audio'],
    freeQuotaFa: 'سهمیه رایگان روزانه برای Gemini 2.5 Flash و 2.5 Pro',
    freeQuotaEn: 'Daily free quota for Gemini 2.5 Flash & 2.5 Pro',
    noteFa: 'عالی برای چت، تحلیل عکس و صوت؛ مدل‌های تصویری گوگل نیازمند فعال‌سازی Billing هستند.',
    noteEn: 'Great for chat, vision, and audio; Google image models require Billing.',
  },
  {
    id: 'groq-cloud',
    name: 'GroqCloud',
    providerType: 'openai_compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    signupUrl: 'https://console.groq.com/keys',
    categories: ['text', 'audio'],
    freeQuotaFa: 'سهمیه رایگان روزانه با سرعت بسیار بالا (Llama 3.3 & Whisper)',
    freeQuotaEn: 'Generous daily free tier with ultra-fast Llama 3.3 & Whisper',
    noteFa: 'سازگار با OpenAI؛ یکی از سریع‌ترین سرویس‌ها برای چت و تبدیل ویس به متن.',
    noteEn: 'OpenAI-compatible; one of the fastest free APIs for chat and Whisper STT.',
  },
  {
    id: 'openrouter-free',
    name: 'OpenRouter Free',
    providerType: 'openai_compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    signupUrl: 'https://openrouter.ai/keys',
    categories: ['text'],
    freeQuotaFa: 'ده‌ها مدل رایگان با پسوند :free (DeepSeek، Qwen، Llama، Gemma)',
    freeQuotaEn: 'Dozens of :free models (DeepSeek, Qwen, Llama, Gemma)',
    noteFa: 'با یک کلید به مدل‌های متعدد رایگان دسترسی می‌دهد؛ مدل‌های دارای :free را فعال نگه دارید.',
    noteEn: 'Single API key for dozens of free LLMs; enable models ending in :free.',
  },
  {
    id: 'cerebras-cloud',
    name: 'Cerebras Inference',
    providerType: 'openai_compatible',
    baseUrl: 'https://api.cerebras.ai/v1',
    signupUrl: 'https://cloud.cerebras.ai/',
    categories: ['text'],
    freeQuotaFa: '۱ میلیون توکن رایگان روزانه با سرعت فوق‌العاده',
    freeQuotaEn: '1M free tokens/day at extreme inference speed',
    noteFa: 'ایده‌آل برای مدل‌های Llama 3.3 70B و Qwen با تاخیر بسیار کم.',
    noteEn: 'Ideal for Llama 3.3 70B and Qwen with near-instant token streaming.',
  },
  {
    id: 'hf-spaces-zerogpu',
    name: 'Hugging Face Spaces (FLUX)',
    providerType: 'huggingface_space',
    baseUrl: 'https://huggingface.co/spaces/black-forest-labs/FLUX.1-schnell',
    signupUrl: 'https://huggingface.co/settings/tokens',
    categories: ['image', 'text', 'audio'],
    freeQuotaFa: '۵ دقیقه ZeroGPU رایگان روزانه برای هر اکانت',
    freeQuotaEn: '5 min/day free ZeroGPU per account',
    noteFa: 'می‌توانید چندین توکن اکانت مختلف در استخر کلیدها وارد کنید تا هنگام اتمام سهمیه خودکار سوییچ شود.',
    noteEn: 'Add multiple account tokens to the credential pool for automatic rotation when quota runs out.',
  },
  {
    id: 'hf-inference-router',
    name: 'Hugging Face Router',
    providerType: 'huggingface',
    baseUrl: 'https://router.huggingface.co',
    signupUrl: 'https://huggingface.co/settings/tokens',
    categories: ['text', 'image', 'audio'],
    freeQuotaFa: 'اعتبار رایگان ماهانه روی روتر Inference هاگینگ‌فیس',
    freeQuotaEn: 'Free monthly credits on Hugging Face Inference Router',
    noteFa: 'هنگام ساخت توکن تیک «Make calls to Inference Providers» را فعال کنید.',
    noteEn: 'Enable "Make calls to Inference Providers" permission when creating your token.',
  },
  {
    id: 'mistral-experiment',
    name: 'Mistral AI (Free Experiment)',
    providerType: 'openai_compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    signupUrl: 'https://console.mistral.ai/api-keys',
    categories: ['text'],
    freeQuotaFa: 'پلن رایگان Experiment با سهمیه ماهانه بالا',
    freeQuotaEn: 'Free Experiment tier with generous monthly quota',
    noteFa: 'شامل مدل‌های Mistral Small، Pixtral و Codestral با پروتکل OpenAI.',
    noteEn: 'Includes Mistral Small, Pixtral, and Codestral via OpenAI-compatible API.',
  },
  {
    id: 'sambanova-cloud',
    name: 'SambaNova Cloud',
    providerType: 'openai_compatible',
    baseUrl: 'https://api.sambanova.ai/v1',
    signupUrl: 'https://cloud.sambanova.ai/apis',
    categories: ['text'],
    freeQuotaFa: 'سهمیه رایگان توسعه‌دهندگان برای DeepSeek R1 و Llama 3.3',
    freeQuotaEn: 'Free developer tier for DeepSeek R1 & Llama 3.3',
    noteFa: 'سرعت بسیار بالا روی مدل‌های بزرگ DeepSeek و Meta Llama.',
    noteEn: 'High-speed RDU inference for large DeepSeek and Meta Llama models.',
  },
  {
    id: 'nvidia-nim',
    name: 'NVIDIA NIM',
    providerType: 'openai_compatible',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    signupUrl: 'https://build.nvidia.com/',
    categories: ['text'],
    freeQuotaFa: 'اعتبار رایگان اولیه ۱۰۰۰ تا ۵۰۰۰ درخواست روی build.nvidia.com',
    freeQuotaEn: '1,000–5,000 free starter credits on build.nvidia.com',
    noteFa: 'پشتیبانی از مدل‌های DeepSeek، Qwen، Llama و Nemotron.',
    noteEn: 'Supports DeepSeek, Qwen, Llama, and Nemotron via OpenAI-compatible API.',
  },
  {
    id: 'github-models',
    name: 'GitHub Models',
    providerType: 'openai_compatible',
    baseUrl: 'https://models.inference.ai.azure.com',
    signupUrl: 'https://github.com/settings/tokens',
    categories: ['text'],
    freeQuotaFa: 'رایگان با اکانت GitHub (کلید PAT با دسترسی models:read)',
    freeQuotaEn: 'Free with GitHub account (PAT with models:read)',
    noteFa: 'دسترسی رایگان محدود روزانه به GPT-4o-mini، DeepSeek، Llama و Phi-4.',
    noteEn: 'Daily free developer quota for GPT-4o-mini, DeepSeek, Llama, and Phi-4.',
  },
  {
    id: 'cohere-trial',
    name: 'Cohere Trial',
    providerType: 'openai_compatible',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    signupUrl: 'https://dashboard.cohere.com/api-keys',
    categories: ['text'],
    freeQuotaFa: 'کلید Trial رایگان تا ۱۰۰۰ درخواست در ماه (بسیار قوی در فارسی)',
    freeQuotaEn: 'Free Trial key up to 1,000 calls/month (strong Persian support)',
    noteFa: 'مدل‌های Command A و Command R+ پشتیبانی بسیار خوبی از زبان فارسی دارند.',
    noteEn: 'Command A and Command R+ excel at Persian and multilingual tasks.',
  },
];

function getUrlHint(providerType: ProviderType, locale: Locale): string {
  if (locale === 'en') {
    if (providerType === 'google_gemini') {
      return 'Use https://generativelanguage.googleapis.com (Note: Google AI Studio free keys have limit: 0 on image models; use Cloudflare Workers AI for free image generation).';
    }
    if (providerType === 'huggingface') return 'Router: https://router.huggingface.co or direct model URL https://huggingface.co/owner/model.';
    if (providerType === 'huggingface_space') return 'Space URL: https://huggingface.co/spaces/owner/space or https://owner-space.hf.space (API token optional for public Spaces).';
    if (providerType === 'cloudflare_workers_ai') {
      return 'Uses native Cloudflare Workers AI binding automatically on deploy (10,000 free Neurons/day, no API key needed). Outside Workers, enter Account ID + API Token.';
    }
    return 'Must be a valid public HTTPS endpoint URL.';
  }
  if (providerType === 'google_gemini') {
    return 'آدرس استاندارد: https://generativelanguage.googleapis.com (توجه: کلید رایگان Google AI Studio روی مدل‌های تصویری سهمیه صفر دارد؛ برای ساخت تصویر رایگان از Cloudflare Workers AI استفاده کنید).';
  }
  if (providerType === 'huggingface') {
    return 'آدرس روتر: https://router.huggingface.co یا آدرس مستقیم مدل مانند https://huggingface.co/owner/model';
  }
  if (providerType === 'huggingface_space') {
    return 'آدرس اسپیس: https://huggingface.co/spaces/owner/space یا https://owner-space.hf.space (برای اسپیس‌های عمومی کلید اختیاری است).';
  }
  if (providerType === 'cloudflare_workers_ai') {
    return 'روی Cloudflare Workers به صورت بومی و رایگان (۱۰,۰۰۰ Neuron روزانه بدون نیاز به کلید) کار می‌کند؛ در اجرای خارج از Worker شناسه اکانت و توکن کلودفلر وارد کنید.';
  }
  return 'آدرس باید یک دامنه عمومی معتبر با پروتکل HTTPS باشد.';
}

function getPoolBadgeMeta(status: string, isActive: boolean, locale: Locale) {
  if (!isActive || status === 'disabled') {
    return { tone: 'neutral' as const, label: locale === 'fa' ? 'غیرفعال/باطل' : 'Disabled' };
  }
  if (status === 'invalid') {
    return { tone: 'danger' as const, label: locale === 'fa' ? 'نامعتبر' : 'Invalid' };
  }
  if (status === 'quota_exhausted') {
    return { tone: 'danger' as const, label: locale === 'fa' ? 'سهمیه تمام' : 'Quota Exhausted' };
  }
  if (status === 'rate_limited') {
    return { tone: 'warning' as const, label: locale === 'fa' ? 'محدودیت نرخ' : 'Rate Limited' };
  }
  return { tone: 'success' as const, label: locale === 'fa' ? 'سالم' : 'Healthy' };
}

export function ProvidersSection({ locale }: { locale: Locale }) {
  const t = DICTIONARIES[locale];
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [testingId, setTestingId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);

  // Create / Edit modal state
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderRecord | null>(null);
  const [name, setName] = useState('');
  const [providerType, setProviderType] = useState<ProviderType>('openai_compatible');
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URLS.openai_compatible);
  const [apiKey, setApiKey] = useState('');
  const [backupKeysText, setBackupKeysText] = useState('');
  const [autoSyncModels, setAutoSyncModels] = useState(true);
  const [organizationId, setOrganizationId] = useState('');
  const [headersJson, setHeadersJson] = useState('{}');
  const [priority, setPriority] = useState(100);
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);

  // Credential Pool & Rotation modal state
  const [poolTarget, setPoolTarget] = useState<ProviderRecord | null>(null);
  const [poolItems, setPoolItems] = useState<PoolCredentialItem[]>([]);
  const [poolLoading, setPoolLoading] = useState(false);
  const [poolMode, setPoolMode] = useState<'pool' | 'rotate'>('pool');
  const [addKeysText, setAddKeysText] = useState('');
  const [addKeyLabel, setAddKeyLabel] = useState('backup');
  const [addKeyPriority, setAddKeyPriority] = useState(110);
  const [rotateApiKey, setRotateApiKey] = useState('');
  const [poolBusy, setPoolBusy] = useState(false);

  // Free API Directory modal state
  const [freeGuideOpen, setFreeGuideOpen] = useState(false);
  const [freeGuideCategory, setFreeGuideCategory] = useState<'all' | 'text' | 'image' | 'audio'>('all');

  const loadProviders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<{ providers: ProviderRecord[] }>('/api/providers');
      setProviders(res.providers);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در بارگذاری ارائه‌دهندگان');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const loadPoolCredentials = useCallback(async (providerId: string) => {
    setPoolLoading(true);
    try {
      const res = await apiRequest<{ credentials: PoolCredentialItem[] }>(
        `/api/providers/${providerId}/credentials`,
      );
      setPoolItems(res.credentials);
    } catch (err) {
      setFeedback({
        tone: 'danger',
        text: err instanceof Error ? err.message : 'خطا در دریافت لیست کلیدهای ارائه‌دهنده',
      });
    } finally {
      setPoolLoading(false);
    }
  }, []);

  const openPoolModal = (p: ProviderRecord) => {
    setPoolTarget(p);
    setPoolMode('pool');
    setAddKeysText('');
    setAddKeyLabel('backup');
    setAddKeyPriority(110);
    setRotateApiKey('');
    void loadPoolCredentials(p.id);
  };

  const openCreateModal = () => {
    setEditing(null);
    setName('');
    setProviderType('openai_compatible');
    setBaseUrl(DEFAULT_BASE_URLS.openai_compatible);
    setApiKey('');
    setBackupKeysText('');
    setAutoSyncModels(true);
    setOrganizationId('');
    setHeadersJson('{}');
    setPriority(100);
    setIsActive(true);
    setFormOpen(true);
  };

  const openCreateWithPreset = (preset: FreeApiPreset) => {
    setFreeGuideOpen(false);
    setEditing(null);
    setName(preset.name);
    setProviderType(preset.providerType);
    setBaseUrl(preset.baseUrl);
    setApiKey('');
    setBackupKeysText('');
    setAutoSyncModels(true);
    setOrganizationId('');
    setHeadersJson('{}');
    setPriority(100);
    setIsActive(true);
    setFormOpen(true);
  };

  const openEditModal = (p: ProviderRecord) => {
    setEditing(p);
    setName(p.name);
    setProviderType(p.providerType);
    setBaseUrl(p.baseUrl);
    setApiKey('');
    setBackupKeysText('');
    setOrganizationId(p.organizationId ?? '');
    setHeadersJson(JSON.stringify(p.additionalHeaders ?? {}, null, 2));
    setPriority(p.priority);
    setIsActive(p.isActive);
    setFormOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      let parsedHeaders: Record<string, string> = {};
      if (headersJson.trim()) {
        const raw = JSON.parse(headersJson) as unknown;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new Error(locale === 'fa' ? 'ساختار JSON هدرهای اضافی نامعتبر است.' : 'Invalid headers JSON object.');
        }
        parsedHeaders = raw as Record<string, string>;
      }

      if (editing) {
        await apiRequest(`/api/providers/${editing.id}`, {
          method: 'PATCH',
          body: {
            name: name.trim(),
            providerType,
            baseUrl: baseUrl.trim(),
            organizationId: organizationId.trim() || null,
            additionalHeaders: parsedHeaders,
            priority: Number(priority),
            isActive,
          },
        });
        setFeedback({
          tone: 'success',
          text: locale === 'fa' ? 'اطلاعات ارائه‌دهنده با موفقیت بروزرسانی شد.' : 'Provider updated.',
        });
      } else {
        const extraKeys = backupKeysText
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);

        const res = await apiRequest<{
          provider: ProviderRecord;
          syncResult?: { createdCount?: number; discoveredCount?: number; message?: string } | null;
        }>('/api/providers', {
          method: 'POST',
          body: {
            name: name.trim(),
            providerType,
            baseUrl: baseUrl.trim(),
            apiKey: apiKey.trim(),
            apiKeys: extraKeys,
            autoSyncModels,
            organizationId: organizationId.trim(),
            additionalHeaders: parsedHeaders,
            priority: Number(priority),
            isActive,
          },
        });

        const syncedMsg =
          res.syncResult && res.syncResult.createdCount
            ? locale === 'fa'
              ? ` (${res.syncResult.createdCount} مدل به‌صورت خودکار شناسایی و ثبت شد)`
              : ` (${res.syncResult.createdCount} models auto-registered)`
            : res.syncResult?.message
              ? ` (${res.syncResult.message})`
              : '';

        setFeedback({
          tone: 'success',
          text:
            (locale === 'fa'
              ? 'ارائه‌دهنده ایجاد شد و کلیدها با AES-256-GCM رمزنگاری شدند.'
              : 'Provider created and credentials encrypted with AES-256-GCM.') + syncedMsg,
        });
      }

      setFormOpen(false);
      await loadProviders();
    } catch (err) {
      setFeedback({
        tone: 'danger',
        text: err instanceof Error ? err.message : 'خطا در ذخیره ارائه‌دهنده',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSyncModels = async (p: ProviderRecord) => {
    setSyncingId(p.id);
    setFeedback(null);
    try {
      const res = await apiRequest<{
        ok: boolean;
        discoveredCount: number;
        createdCount: number;
        skippedCount: number;
        message: string;
      }>(`/api/providers/${p.id}/sync-models`, {
        method: 'POST',
        body: { activateAll: true },
      });

      setFeedback({
        tone: 'success',
        text: `${p.name}: ${res.message}`,
      });
      await loadProviders();
    } catch (err) {
      setFeedback({
        tone: 'danger',
        text: err instanceof Error ? err.message : 'خطا در همگام‌سازی خودکار مدل‌ها',
      });
    } finally {
      setSyncingId(null);
    }
  };

  const handleAddBackupKeys = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!poolTarget) return;
    const keys = addKeysText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (keys.length === 0) return;

    setPoolBusy(true);
    try {
      await apiRequest(`/api/providers/${poolTarget.id}/credentials`, {
        method: 'POST',
        body: {
          apiKeys: keys,
          label: addKeyLabel.trim() || 'backup',
          priority: Number(addKeyPriority) || 110,
        },
      });
      setAddKeysText('');
      setFeedback({
        tone: 'success',
        text:
          locale === 'fa'
            ? `${keys.length} کلید پشتیبان جدید به استخر «${poolTarget.name}» اضافه شد.`
            : `Added ${keys.length} backup key(s) to ${poolTarget.name}.`,
      });
      await Promise.all([loadPoolCredentials(poolTarget.id), loadProviders()]);
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در افزودن کلید' });
    } finally {
      setPoolBusy(false);
    }
  };

  const handleRotateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!poolTarget) return;
    setPoolBusy(true);
    try {
      await apiRequest(`/api/providers/${poolTarget.id}/rotate-key`, {
        method: 'POST',
        body: { apiKey: rotateApiKey.trim() },
      });
      setRotateApiKey('');
      setFeedback({
        tone: 'success',
        text:
          locale === 'fa'
            ? 'کلید جدید رمزنگاری شد و کلیدهای قبلی باطل شدند.'
            : 'API key rotated and previous keys revoked.',
      });
      await Promise.all([loadPoolCredentials(poolTarget.id), loadProviders()]);
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در چرخش کلید' });
    } finally {
      setPoolBusy(false);
    }
  };

  const handleResetCredential = async (credId: string) => {
    if (!poolTarget) return;
    setPoolBusy(true);
    try {
      await apiRequest(`/api/credentials/${credId}`, {
        method: 'PATCH',
        body: { resetStatus: true, isActive: true },
      });
      await Promise.all([loadPoolCredentials(poolTarget.id), loadProviders()]);
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در بازنشانی کلید' });
    } finally {
      setPoolBusy(false);
    }
  };

  const handleUpdateCredPriority = async (credId: string, nextPriority: number) => {
    if (!poolTarget) return;
    try {
      await apiRequest(`/api/credentials/${credId}`, {
        method: 'PATCH',
        body: { priority: Math.max(0, nextPriority) },
      });
      await Promise.all([loadPoolCredentials(poolTarget.id), loadProviders()]);
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در تغییر اولویت' });
    }
  };

  const handleRevokeCredential = async (credId: string) => {
    if (!poolTarget) return;
    setPoolBusy(true);
    try {
      await apiRequest(`/api/credentials/${credId}/revoke`, { method: 'POST' });
      await Promise.all([loadPoolCredentials(poolTarget.id), loadProviders()]);
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در باطل‌سازی کلید' });
    } finally {
      setPoolBusy(false);
    }
  };

  const handleTestConnection = async (p: ProviderRecord) => {
    setTestingId(p.id);
    setFeedback(null);
    try {
      const res = await apiRequest<{
        result: { ok: boolean; message: string; latencyMs: number; protocol: string };
      }>(`/api/providers/${p.id}/test`, { method: 'POST' });

      setFeedback({
        tone: res.result.ok ? 'success' : 'danger',
        text: `${p.name} (${res.result.protocol} · ${res.result.latencyMs}ms): ${res.result.message}`,
      });
      await loadProviders();
    } catch (err) {
      setFeedback({
        tone: 'danger',
        text: err instanceof Error ? err.message : 'خطا در تست اتصال',
      });
    } finally {
      setTestingId(null);
    }
  };

  const handleToggleActive = async (p: ProviderRecord) => {
    try {
      await apiRequest(`/api/providers/${p.id}`, {
        method: 'PATCH',
        body: { isActive: !p.isActive },
      });
      await loadProviders();
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در تغییر وضعیت' });
    }
  };

  const handleDelete = async (p: ProviderRecord) => {
    try {
      await apiRequest(`/api/providers/${p.id}`, { method: 'DELETE' });
      setFeedback({
        tone: 'success',
        text: locale === 'fa' ? `ارائه‌دهنده «${p.name}» حذف شد.` : `Provider "${p.name}" deleted.`,
      });
      await loadProviders();
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در حذف' });
    }
  };

  const filtered = providers.filter((p) => {
    const matchesSearch =
      !search.trim() ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.baseUrl.toLowerCase().includes(search.toLowerCase());
    const matchesType = filterType === 'all' || p.providerType === filterType;
    return matchesSearch && matchesType;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t.nav.providers}</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'مدیریت چندارائه‌دهنده (Gemini، Hugging Face، Spaces، OpenAI) با استخر چند کلید Failover و شناسایی خودکار مدل‌ها.'
              : 'Multi-provider adapters (Gemini, Hugging Face, Spaces, OpenAI) with multi-key failover pools and auto model sync.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setFreeGuideOpen(true)}>
            <Gift className="w-4 h-4" />
            <span>{locale === 'fa' ? 'منابع API رایگان' : 'Free API Sources'}</span>
          </Button>
          <Button onClick={openCreateModal}>
            <Plus className="w-4 h-4" />
            <span>{locale === 'fa' ? 'افزودن ارائه‌دهنده جدید' : 'Add AI Provider'}</span>
          </Button>
        </div>
      </div>

      {feedback && (
        <div
          role="status"
          className={`p-3.5 rounded-xl border text-xs ${
            feedback.tone === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-200'
              : 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900 text-red-800 dark:text-red-200'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {error && (
        <div className="p-3.5 rounded-xl border border-red-200 bg-red-50 text-xs text-red-700">{error}</div>
      )}

      {/* Filter & Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 text-slate-400 absolute top-3 start-3 pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={locale === 'fa' ? 'جستجو بر اساس نام یا آدرس پایه...' : 'Search by name or base URL...'}
            className="ps-9"
          />
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-x-auto max-w-full">
          <button
            type="button"
            onClick={() => setFilterType('all')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              filterType === 'all'
                ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
            }`}
          >
            {t.common.all}
          </button>
          {PROVIDER_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setFilterType(type)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                filterType === type
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
              }`}
            >
              {t.providerTypes[type]}
            </button>
          ))}
        </div>
      </div>

      {/* Providers Table */}
      <Surface className="overflow-hidden">
        {loading ? (
          <TableSkeleton rows={4} cols={6} />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={locale === 'fa' ? 'هیچ ارائه‌دهنده‌ای ثبت نشده است' : 'No AI providers configured'}
            description={
              locale === 'fa'
                ? 'ارائه‌دهندگان Google Gemini، Hugging Face، HF Spaces، OpenAI یا سرویس‌های سفارشی را با کلیدهای Failover اضافه کنید.'
                : 'Add Google Gemini, Hugging Face, HF Spaces, OpenAI-compatible, or custom providers.'
            }
            action={
              <Button onClick={openCreateModal}>
                <Plus className="w-4 h-4" />
                <span>{locale === 'fa' ? 'ثبت اولین ارائه‌دهنده' : 'Add First Provider'}</span>
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'ارائه‌دهنده و پروتکل' : 'Provider & Protocol'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'استخر کلیدهای API' : 'API Key Pool'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'وضعیت اتصال' : 'Connection'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'اولویت / مدل‌ها' : 'Priority / Models'}</th>
                  <th className="py-3 px-4 text-start">{t.common.status}</th>
                  <th className="py-3 px-4 text-end">{t.common.actions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {filtered.map((p) => {
                  const totalKeys = p.activeKeysCount ?? (p.hasCredential ? 1 : 0);
                  const healthyKeys = p.healthyKeysCount ?? (p.hasCredential ? 1 : 0);
                  const exhaustedKeys = p.exhaustedKeysCount ?? 0;
                  const invalidKeys = p.invalidKeysCount ?? 0;

                  return (
                    <tr key={p.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors">
                      <td className="py-3.5 px-4">
                        <div className="font-semibold text-slate-900 dark:text-slate-100">{p.name}</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                          {t.providerTypes[p.providerType]} ·{' '}
                          <span dir="ltr" className="font-mono">
                            {p.baseUrl}
                          </span>
                        </div>
                      </td>
                      <td className="py-3.5 px-4">
                        {totalKeys > 0 ? (
                          <>
                            <div className="font-mono text-slate-700 dark:text-slate-300">
                              <span dir="ltr" className="inline-block">
                                {p.maskedApiKey ?? '—'}
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 tabular-nums">
                              {locale === 'fa'
                                ? `${formatNumber(healthyKeys, locale)}/${formatNumber(totalKeys, locale)} کلید سالم`
                                : `${healthyKeys}/${totalKeys} healthy keys`}
                              {exhaustedKeys > 0 && (
                                <span className="text-amber-600 dark:text-amber-400 ms-1.5">
                                  ({formatNumber(exhaustedKeys, locale)}{' '}
                                  {locale === 'fa' ? 'در استراحت/تمام' : 'cooldown'})
                                </span>
                              )}
                              {invalidKeys > 0 && (
                                <span className="text-red-600 dark:text-red-400 ms-1.5">
                                  ({formatNumber(invalidKeys, locale)}{' '}
                                  {locale === 'fa' ? 'نامعتبر' : 'invalid'})
                                </span>
                              )}
                            </div>
                          </>
                        ) : (
                          <div className="text-[11px] text-slate-500">
                            {p.providerType === 'huggingface_space'
                              ? locale === 'fa'
                                ? 'عمومی (بدون کلید)'
                                : 'Public (no token)'
                              : p.providerType === 'cloudflare_workers_ai'
                                ? locale === 'fa'
                                  ? 'بومی کلودفلر (رایگان / بدون کلید)'
                                  : 'Native Cloudflare AI (Free)'
                                : '—'}
                          </div>
                        )}
                      </td>
                      <td className="py-3.5 px-4">
                        <StatusText
                          tone={
                            p.connectionStatus === 'connected'
                              ? 'success'
                              : p.connectionStatus === 'degraded'
                                ? 'warning'
                                : p.connectionStatus === 'failed'
                                  ? 'danger'
                                  : 'neutral'
                          }
                        >
                          {t.connectionStatuses[p.connectionStatus]}
                        </StatusText>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 max-w-[240px] truncate" title={p.lastTestMessage ?? ''}>
                          {p.lastTestLatencyMs !== null ? `${p.lastTestLatencyMs}ms · ` : ''}
                          {p.lastTestedAt ? formatDateTime(p.lastTestedAt, locale) : locale === 'fa' ? 'هنوز تست نشده' : 'Not tested'}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 tabular-nums text-slate-700 dark:text-slate-300">
                        <div className="font-mono">
                          <span dir="ltr" className="inline-block">
                            #{p.priority}
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {formatNumber(p.modelsActive, locale)}/{formatNumber(p.modelsTotal, locale)}{' '}
                          {locale === 'fa' ? 'مدل فعال' : 'models'}
                        </div>
                      </td>
                      <td className="py-3.5 px-4">
                        <button
                          type="button"
                          onClick={() => handleToggleActive(p)}
                          className="text-xs font-medium underline-offset-4 hover:underline cursor-pointer"
                        >
                          <StatusText tone={p.isActive ? 'success' : 'neutral'}>
                            {p.isActive ? t.common.active : t.common.inactive}
                          </StatusText>
                        </button>
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="flex flex-col items-end gap-1.5">
                          <div className="flex items-center gap-1.5">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleSyncModels(p)}
                              disabled={syncingId === p.id}
                              aria-label={`${locale === 'fa' ? 'همگام‌سازی مدل‌های' : 'Sync models for'} ${p.name}`}
                            >
                              <RefreshCw className={`w-3.5 h-3.5 ${syncingId === p.id ? 'animate-spin' : ''}`} />
                              <span>
                                {syncingId === p.id
                                  ? locale === 'fa'
                                    ? 'در حال دریافت...'
                                    : 'Syncing...'
                                  : locale === 'fa'
                                    ? 'همگام‌سازی مدل‌ها'
                                    : 'Sync Models'}
                              </span>
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleTestConnection(p)}
                              disabled={testingId === p.id}
                              aria-label={`${t.common.testConnection} ${p.name}`}
                            >
                              <PlugZap className="w-3.5 h-3.5" />
                              <span>{testingId === p.id ? t.common.testing : t.common.testConnection}</span>
                            </Button>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openPoolModal(p)}
                              aria-label={`${locale === 'fa' ? 'استخر کلیدهای' : 'Key pool for'} ${p.name}`}
                              title={locale === 'fa' ? 'استخر کلیدهای Failover و چرخش کلید' : 'Failover Key Pool'}
                            >
                              <KeyRound className="w-3.5 h-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEditModal(p)}
                              aria-label={`${t.common.edit} ${p.name}`}
                              title={t.common.edit}
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDelete(p)}
                              aria-label={`${t.common.delete} ${p.name}`}
                              title={t.common.delete}
                              className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Surface>

      {/* Create / Edit Provider Modal */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={
          editing
            ? locale === 'fa'
              ? `ویرایش ارائه‌دهنده: ${editing.name}`
              : `Edit Provider: ${editing.name}`
            : locale === 'fa'
              ? 'افزودن ارائه‌دهنده هوش مصنوعی'
              : 'Add AI Provider'
        }
        description={
          locale === 'fa'
            ? 'کلیدهای API بلافاصله با AES-256-GCM رمزنگاری می‌شوند و مدل‌های ارائه‌دهنده می‌توانند خودکار شناسایی شوند.'
            : 'API keys are AES-256-GCM encrypted and models can be auto-discovered upon creation.'
        }
      >
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <FieldLabel htmlFor="prov-name" required>
                {locale === 'fa' ? 'نام ارائه‌دهنده' : 'Provider Name'}
              </FieldLabel>
              <Input
                id="prov-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={locale === 'fa' ? 'مثلاً Gemini Primary / HF Space' : 'e.g. Gemini Primary'}
              />
            </div>

            <div>
              <FieldLabel htmlFor="prov-type" required>
                {locale === 'fa' ? 'نوع پروتکل (آداپتور)' : 'Provider Protocol Type'}
              </FieldLabel>
              <Select
                id="prov-type"
                value={providerType}
                onChange={(e) => {
                  const nextType = e.target.value as ProviderType;
                  setProviderType(nextType);
                  if (!editing) {
                    setBaseUrl(DEFAULT_BASE_URLS[nextType]);
                  }
                }}
              >
                {PROVIDER_TYPES.map((pt) => (
                  <option key={pt} value={pt}>
                    {t.providerTypes[pt]}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div>
            <FieldLabel htmlFor="prov-url" required>
              {locale === 'fa' ? 'آدرس پایه API / اسپیس (Base URL)' : 'API / Space Base URL'}
            </FieldLabel>
            <Input
              id="prov-url"
              type="url"
              dir="ltr"
              required
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={DEFAULT_BASE_URLS[providerType]}
            />
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">{getUrlHint(providerType, locale)}</p>
          </div>

          {!editing && (
            <div className="space-y-3">
              <div>
                <FieldLabel
                  htmlFor="prov-key"
                  required={providerType !== 'huggingface_space' && providerType !== 'cloudflare_workers_ai'}
                >
                  {providerType === 'huggingface_space'
                    ? locale === 'fa'
                      ? 'توکن Hugging Face (اختیاری برای اسپیس‌های عمومی)'
                      : 'Hugging Face Token (Optional for Public Spaces)'
                    : providerType === 'cloudflare_workers_ai'
                      ? locale === 'fa'
                        ? 'توکن API کلودفلر (روی Worker نیازی نیست — اختیاری)'
                        : 'Cloudflare API Token (Optional — auto-bound on Workers)'
                      : locale === 'fa'
                        ? 'کلید API اصلی (AES-256-GCM)'
                        : 'Primary API Key (AES-256-GCM)'}
                </FieldLabel>
                <Input
                  id="prov-key"
                  type="password"
                  dir="ltr"
                  required={providerType !== 'huggingface_space' && providerType !== 'cloudflare_workers_ai'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    providerType === 'huggingface' || providerType === 'huggingface_space'
                      ? 'hf_...'
                      : providerType === 'cloudflare_workers_ai'
                        ? 'Optional on Cloudflare Workers'
                        : 'sk-... / AIza...'
                  }
                  autoComplete="off"
                />
              </div>

              <div>
                <FieldLabel htmlFor="prov-backup-keys">
                  {locale === 'fa'
                    ? 'کلیدهای پشتیبان Failover (اختیاری — هر کلید در یک خط جداگانه)'
                    : 'Backup Failover API Keys (Optional — one per line)'}
                </FieldLabel>
                <Textarea
                  id="prov-backup-keys"
                  dir="ltr"
                  rows={2}
                  className="font-mono text-xs"
                  value={backupKeysText}
                  onChange={(e) => setBackupKeysText(e.target.value)}
                  placeholder={locale === 'fa' ? 'AIza...\nAIza...' : 'key-2\nkey-3'}
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <FieldLabel htmlFor="prov-org">
                {providerType === 'cloudflare_workers_ai'
                  ? locale === 'fa'
                    ? 'شناسه اکانت کلودفلر (Account ID — فقط خارج از Worker)'
                    : 'Cloudflare Account ID (REST fallback only)'
                  : locale === 'fa'
                    ? 'شناسه سازمان (اختیاری)'
                    : 'Organization ID (Optional)'}
              </FieldLabel>
              <Input
                id="prov-org"
                dir="ltr"
                value={organizationId}
                onChange={(e) => setOrganizationId(e.target.value)}
                placeholder={providerType === 'cloudflare_workers_ai' ? '32-char Cloudflare Account ID' : 'org-...'}
              />
            </div>

            <div>
              <FieldLabel htmlFor="prov-priority">
                {locale === 'fa' ? 'اولویت مسیریابی (عدد کمتر = اولویت بالاتر)' : 'Routing Priority (lower = higher)'}
              </FieldLabel>
              <Input
                id="prov-priority"
                type="number"
                min={0}
                max={10000}
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
              />
            </div>
          </div>

          <div>
            <FieldLabel htmlFor="prov-headers">
              {locale === 'fa' ? 'هدرهای HTTP اضافی (JSON اختیاری)' : 'Additional HTTP Headers (JSON)'}
            </FieldLabel>
            <Textarea
              id="prov-headers"
              dir="ltr"
              rows={2}
              className="font-mono text-xs"
              value={headersJson}
              onChange={(e) => setHeadersJson(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            {!editing && (
              <label className="flex items-center gap-2.5 text-xs font-medium text-blue-700 dark:text-blue-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoSyncModels}
                  onChange={(e) => setAutoSyncModels(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 text-blue-700"
                />
                <Sparkles className="w-3.5 h-3.5 shrink-0" />
                <span>
                  {locale === 'fa'
                    ? 'شناسایی و افزودن خودکار همه مدل‌های ارائه‌دهنده بلافاصله پس از ثبت'
                    : 'Auto-discover & register provider models immediately'}
                </span>
              </label>
            )}

            <label className="flex items-center gap-2.5 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-blue-700"
              />
              <span>{locale === 'fa' ? 'ارائه‌دهنده در حالت فعال باشد' : 'Provider is active'}</span>
            </label>
          </div>

          <div className="flex items-center justify-end gap-2 pt-4 border-t border-slate-200 dark:border-slate-800">
            <Button variant="outline" onClick={() => setFormOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? t.common.saving : t.common.save}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Multi-Key Failover Pool & Rotation Modal */}
      <Modal
        open={Boolean(poolTarget)}
        onClose={() => setPoolTarget(null)}
        maxWidth="max-w-2xl"
        title={
          locale === 'fa'
            ? `استخر کلیدهای Failover: ${poolTarget?.name ?? ''}`
            : `Failover Key Pool: ${poolTarget?.name ?? ''}`
        }
        description={
          locale === 'fa'
            ? 'چندین کلید API اضافه کنید تا هنگام اتمام سهمیه یا خطای محدودیت نرخ، سامانه به‌طور خودکار به کلید بعدی سوییچ کند.'
            : 'Add multiple API keys so requests automatically fail over to the next healthy key on quota exhaustion.'
        }
      >
        <div className="space-y-5">
          <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-3">
            <Button
              variant={poolMode === 'pool' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setPoolMode('pool')}
            >
              {locale === 'fa' ? 'مدیریت استخر و افزودن کلید پشتیبان' : 'Manage Pool & Add Backup Keys'}
            </Button>
            <Button
              variant={poolMode === 'rotate' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setPoolMode('rotate')}
            >
              {locale === 'fa' ? 'چرخش و جایگزینی کامل کلیدها' : 'Rotate & Replace All Keys'}
            </Button>
          </div>

          {/* Existing Keys List */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            {poolLoading ? (
              <div className="p-4 text-xs text-slate-500">{t.common.loading}</div>
            ) : poolItems.length === 0 ? (
              <div className="p-4 text-xs text-slate-500">
                {locale === 'fa' ? 'هیچ کلیدی در استخر این ارائه‌دهنده ثبت نشده است.' : 'No keys stored for this provider.'}
              </div>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-800">
                {poolItems.map((item) => {
                  const badge = getPoolBadgeMeta(item.status, item.isActive, locale);
                  const canReset = !item.isActive || item.status !== 'active' || item.failureCount > 0;
                  return (
                    <div
                      key={item.id}
                      className="p-3 flex flex-wrap items-center justify-between gap-3 text-xs bg-white dark:bg-slate-900"
                    >
                      <div className="space-y-0.5 min-w-[180px]">
                        <div className="flex items-center gap-2">
                          <span dir="ltr" className="font-mono font-semibold text-slate-800 dark:text-slate-100">
                            {item.maskedPreview}
                          </span>
                          <span className="text-[11px] text-slate-500 font-mono">
                            ({item.label} · v{item.keyVersion})
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-[11px]">
                          <StatusText tone={badge.tone}>{badge.label}</StatusText>
                          {item.failureCount > 0 && (
                            <span className="text-slate-500 tabular-nums">
                              · {formatNumber(item.failureCount, locale)} {locale === 'fa' ? 'خطا' : 'errors'}
                            </span>
                          )}
                          {item.lastErrorMessage && (
                            <span className="text-slate-500 truncate max-w-[220px]" title={item.lastErrorMessage}>
                              · {item.lastErrorMessage}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-1 text-[11px] text-slate-500">
                          <span>{locale === 'fa' ? 'اولویت:' : 'Priority:'}</span>
                          <input
                            type="number"
                            min={0}
                            max={10000}
                            defaultValue={item.priority}
                            onBlur={(e) => {
                              const nextVal = Number(e.target.value);
                              if (!Number.isNaN(nextVal) && nextVal !== item.priority) {
                                void handleUpdateCredPriority(item.id, nextVal);
                              }
                            }}
                            className="w-16 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-mono text-xs tabular-nums"
                          />
                        </label>
                        {canReset && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleResetCredential(item.id)}
                            disabled={poolBusy}
                            aria-label={`${locale === 'fa' ? 'بازنشانی کلید' : 'Reset key'} ${item.maskedPreview}`}
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span>{locale === 'fa' ? 'بازنشانی' : 'Reset'}</span>
                          </Button>
                        )}
                        {item.isActive && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRevokeCredential(item.id)}
                            disabled={poolBusy}
                            className="text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
                            aria-label={`${locale === 'fa' ? 'باطل‌سازی کلید' : 'Revoke key'} ${item.maskedPreview}`}
                          >
                            <ShieldAlert className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {poolMode === 'pool' ? (
            <form onSubmit={handleAddBackupKeys} className="space-y-3 pt-2 border-t border-slate-200 dark:border-slate-800">
              <div>
                <FieldLabel htmlFor="pool-add-keys" required>
                  {locale === 'fa'
                    ? 'افزودن کلیدهای جدید به استخر (هر کلید در یک خط — کلیدهای قبلی حفظ می‌شوند)'
                    : 'Add New Keys to Pool (one per line — keeps existing keys)'}
                </FieldLabel>
                <Textarea
                  id="pool-add-keys"
                  dir="ltr"
                  rows={3}
                  required
                  className="font-mono text-xs"
                  value={addKeysText}
                  onChange={(e) => setAddKeysText(e.target.value)}
                  placeholder="AIza...\nAIza..."
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <FieldLabel htmlFor="pool-key-label">{locale === 'fa' ? 'برچسب' : 'Label'}</FieldLabel>
                  <Input
                    id="pool-key-label"
                    dir="ltr"
                    value={addKeyLabel}
                    onChange={(e) => setAddKeyLabel(e.target.value)}
                  />
                </div>
                <div>
                  <FieldLabel htmlFor="pool-key-priority">
                    {locale === 'fa' ? 'اولویت شروع (کمتر = زودتر)' : 'Start Priority'}
                  </FieldLabel>
                  <Input
                    id="pool-key-priority"
                    type="number"
                    min={0}
                    max={10000}
                    value={addKeyPriority}
                    onChange={(e) => setAddKeyPriority(Number(e.target.value))}
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setPoolTarget(null)}>
                  {t.common.close}
                </Button>
                <Button type="submit" disabled={poolBusy}>
                  <Plus className="w-3.5 h-3.5" />
                  <span>{locale === 'fa' ? 'افزودن به استخر' : 'Add to Pool'}</span>
                </Button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleRotateKey} className="space-y-3 pt-2 border-t border-slate-200 dark:border-slate-800">
              <div>
                <FieldLabel htmlFor="rotate-key-input" required>
                  {locale === 'fa' ? 'کلید API جایگزین (تمامی کلیدهای فعال قبلی باطل می‌شوند)' : 'Replacement API Key'}
                </FieldLabel>
                <Input
                  id="rotate-key-input"
                  type="password"
                  dir="ltr"
                  required
                  value={rotateApiKey}
                  onChange={(e) => setRotateApiKey(e.target.value)}
                  placeholder="sk-..."
                  autoComplete="off"
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setPoolTarget(null)}>
                  {t.common.close}
                </Button>
                <Button type="submit" disabled={poolBusy}>
                  {poolBusy ? t.common.saving : t.common.rotateKey}
                </Button>
              </div>
            </form>
          )}
        </div>
      </Modal>

      {/* Free AI API Directory Modal */}
      <Modal
        open={freeGuideOpen}
        onClose={() => setFreeGuideOpen(false)}
        title={
          locale === 'fa'
            ? 'لیست کامل سایت‌های دریافت API رایگان هوش مصنوعی'
            : 'Complete Free AI API Providers Directory'
        }
        maxWidth="max-w-4xl"
      >
        <div className="space-y-4">
          <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
            {locale === 'fa'
              ? 'از هر یک از سایت‌های زیر می‌توانید API رایگان دریافت کنید و با یک کلیک فرم افزودن ارائه‌دهنده را با آدرس و پروتکل صحیح پر نمایید. برای افزایش سهمیه رایگان (مثلاً در Hugging Face Spaces) می‌توانید چندین کلید از اکانت‌های مختلف را هم‌زمان در استخر کلیدها وارد کنید تا سیستم به‌صورت خودکار سوییچ کند.'
              : 'Get free API keys from any of the verified providers below and click Select to pre-fill the Add Provider form with the exact protocol and endpoint URL.'}
          </p>

          <div className="flex flex-wrap items-center gap-1.5 p-1 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg w-fit">
            {(
              [
                { id: 'all', labelFa: `همه (${FREE_API_PROVIDERS.length})`, labelEn: `All (${FREE_API_PROVIDERS.length})` },
                { id: 'text', labelFa: 'متن و چت', labelEn: 'Text & Chat' },
                { id: 'image', labelFa: 'تولید تصویر', labelEn: 'Image' },
                { id: 'audio', labelFa: 'صوت و ویس', labelEn: 'Audio' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFreeGuideCategory(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  freeGuideCategory === tab.id
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                }`}
              >
                {locale === 'fa' ? tab.labelFa : tab.labelEn}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[60vh] overflow-y-auto pe-1">
            {FREE_API_PROVIDERS.filter(
              (item) => freeGuideCategory === 'all' || item.categories.includes(freeGuideCategory),
            ).map((item) => (
              <div
                key={item.id}
                className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/50 flex flex-col justify-between gap-3"
              >
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                      {item.name}
                    </div>
                    <span className="shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-md bg-slate-200/70 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                      {t.providerTypes[item.providerType]}
                    </span>
                  </div>
                  <div
                    className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate"
                    dir="ltr"
                    title={item.baseUrl}
                  >
                    {item.baseUrl}
                  </div>

                  <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                    {locale === 'fa' ? item.freeQuotaFa : item.freeQuotaEn}
                  </div>
                  <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-relaxed">
                    {locale === 'fa' ? item.noteFa : item.noteEn}
                  </p>
                </div>

                <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-200/80 dark:border-slate-800">
                  <a
                    href={item.signupUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 dark:text-sky-400 hover:underline"
                  >
                    <span>{locale === 'fa' ? 'دریافت کلید از سایت' : 'Get API Key'}</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                  <Button size="sm" onClick={() => openCreateWithPreset(item)}>
                    <Plus className="w-3.5 h-3.5" />
                    <span>{locale === 'fa' ? 'انتخاب و پر کردن فرم' : 'Select & Pre-fill'}</span>
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className="flex justify-end pt-2 border-t border-slate-200 dark:border-slate-800">
            <Button variant="outline" onClick={() => setFreeGuideOpen(false)}>
              {t.common.close}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
