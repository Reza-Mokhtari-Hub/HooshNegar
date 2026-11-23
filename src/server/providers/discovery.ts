import { eq } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import { aiModels, modelCapabilities } from '../../db/schema.ts';
import type { CapabilityType, ModelCategory, ProviderType } from '../../shared/validation.ts';
import { redactSecrets } from '../security/crypto.ts';
import { SsrfProtectionError, validatePublicHttpsUrl } from '../security/ssrf.ts';
import { getCloudflareAiBinding } from '../cloudflare/requestContext.ts';

export const CLOUDFLARE_WORKERS_AI_CURATED_MODELS: DiscoveredModelSpec[] = [
  // Image Generation
  {
    name: 'FLUX.1 Schnell',
    modelIdentifier: '@cf/black-forest-labs/flux-1-schnell',
    category: 'image',
    capabilities: ['image_generation'],
    description: 'تولید تصویر سریع با کیفیت بالا و جزئیات دقیق.',
    maxInputSize: 4096,
    maxOutputSize: 4096,
    creditCost: 2,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
    modelParameters: { steps: 4 },
  },
  {
    name: 'SDXL Lightning',
    modelIdentifier: '@cf/bytedance/stable-diffusion-xl-lightning',
    category: 'image',
    capabilities: ['image_generation'],
    description: 'تولید تصویر فوق‌سریع با پشتیبانی از نسبت‌های تصویر متنوع.',
    maxInputSize: 4096,
    maxOutputSize: 4096,
    creditCost: 1,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
    modelParameters: {},
  },
  {
    name: 'Stable Diffusion XL',
    modelIdentifier: '@cf/stabilityai/stable-diffusion-xl-base-1.0',
    category: 'image',
    capabilities: ['image_generation'],
    description: 'تولید تصویر هنری و واقعی با کنترل ابعاد خروجی.',
    maxInputSize: 4096,
    maxOutputSize: 4096,
    creditCost: 2,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
    modelParameters: {},
  },
  {
    name: 'DreamShaper 8 LCM',
    modelIdentifier: '@cf/lykon/dreamshaper-8-lcm',
    category: 'image',
    capabilities: ['image_generation'],
    description: 'مدل سریع تصویرسازی فانتزی و انیمه‌ای.',
    maxInputSize: 4096,
    maxOutputSize: 4096,
    creditCost: 1,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
    modelParameters: {},
  },
  // Text & Chat LLMs
  {
    name: 'Llama 3.3 70B Fast',
    modelIdentifier: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    category: 'llm',
    capabilities: ['text_generation', 'chat'],
    description: 'مدل متنی قدرتمند و سریع برای گفتگو، نگارش و تحلیل.',
    maxInputSize: 32000,
    maxOutputSize: 4096,
    creditCost: 1,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
    modelParameters: {},
  },
  {
    name: 'Llama 4 Scout 17B',
    modelIdentifier: '@cf/meta/llama-4-scout-17b-16e-instruct',
    category: 'multimodal',
    capabilities: ['text_generation', 'chat', 'vision', 'document_analysis'],
    description: 'مدل چندوجهی نسل جدید با درک متن، تصویر و اسناد.',
    maxInputSize: 128000,
    maxOutputSize: 4096,
    creditCost: 1,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
    modelParameters: {},
  },
  {
    name: 'Llama 3.1 8B Instruct',
    modelIdentifier: '@cf/meta/llama-3.1-8b-instruct',
    category: 'llm',
    capabilities: ['text_generation', 'chat'],
    description: 'مدل متنی سبک و بسیار سریع برای پاسخ‌گویی روزمره.',
    maxInputSize: 32000,
    maxOutputSize: 4096,
    creditCost: 1,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
    modelParameters: {},
  },
  {
    name: 'Qwen 3 30B',
    modelIdentifier: '@cf/qwen/qwen3-30b-a3b-fp8',
    category: 'llm',
    capabilities: ['text_generation', 'chat'],
    description: 'مدل چندزبانه قدرتمند با پشتیبانی قوی از زبان فارسی و کدنویسی.',
    maxInputSize: 64000,
    maxOutputSize: 4096,
    creditCost: 1,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
    modelParameters: {},
  },
  {
    name: 'DeepSeek R1 32B',
    modelIdentifier: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    category: 'llm',
    capabilities: ['text_generation', 'chat'],
    description: 'مدل استدلالی تخصصی برای مسائل ریاضی، منطقی و برنامه‌نویسی.',
    maxInputSize: 64000,
    maxOutputSize: 4096,
    creditCost: 1,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
    modelParameters: {},
  },
  {
    name: 'Gemma 3 12B',
    modelIdentifier: '@cf/google/gemma-3-12b-it',
    category: 'llm',
    capabilities: ['text_generation', 'chat'],
    description: 'مدل متنی متعادل و روان برای تولید محتوا و ترجمه فارسی.',
    maxInputSize: 64000,
    maxOutputSize: 4096,
    creditCost: 1,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
    modelParameters: {},
  },
  {
    name: 'Mistral Small 3.1 24B',
    modelIdentifier: '@cf/mistralai/mistral-small-3.1-24b-instruct',
    category: 'llm',
    capabilities: ['text_generation', 'chat'],
    description: 'مدل متنی دقیق برای خلاصه‌سازی، کدنویسی و تحلیل متن.',
    maxInputSize: 64000,
    maxOutputSize: 4096,
    creditCost: 1,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
    modelParameters: {},
  },
  // Speech-to-Text (Audio Transcription)
  {
    name: 'Whisper Large v3 Turbo',
    modelIdentifier: '@cf/openai/whisper-large-v3-turbo',
    category: 'audio',
    capabilities: ['audio_transcription'],
    description: 'تبدیل سریع و دقیق گفتار و ویس فارسی و انگلیسی به متن.',
    maxInputSize: 64000,
    maxOutputSize: 8192,
    creditCost: 1,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
    modelParameters: {},
  },
  {
    name: 'Whisper Multilingual',
    modelIdentifier: '@cf/openai/whisper',
    category: 'audio',
    capabilities: ['audio_transcription'],
    description: 'تبدیل فایل صوتی چندزبانه به متن.',
    maxInputSize: 64000,
    maxOutputSize: 8192,
    creditCost: 1,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
    modelParameters: {},
  },
  {
    name: 'Deepgram Nova 3',
    modelIdentifier: '@cf/deepgram/nova-3',
    category: 'audio',
    capabilities: ['audio_transcription'],
    description: 'تشخیص گفتار پرسرعت برای فایل‌های صوتی.',
    maxInputSize: 64000,
    maxOutputSize: 8192,
    creditCost: 1,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
    modelParameters: {},
  },
  // Text-to-Speech
  {
    name: 'Deepgram Aura TTS',
    modelIdentifier: '@cf/deepgram/aura-1',
    category: 'audio',
    capabilities: ['speech_generation'],
    description: 'تبدیل متن به گفتار طبیعی با صدای روان.',
    maxInputSize: 16000,
    maxOutputSize: 4096,
    creditCost: 1,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
    modelParameters: {},
  },
  {
    name: 'MeloTTS',
    modelIdentifier: '@cf/myshell-ai/melotts',
    category: 'audio',
    capabilities: ['speech_generation'],
    description: 'تولید گفتار چندزبانه با سرعت بالا.',
    maxInputSize: 16000,
    maxOutputSize: 4096,
    creditCost: 1,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
    modelParameters: {},
  },
];

export interface DiscoveredModelSpec {
  name: string;
  modelIdentifier: string;
  category: ModelCategory;
  capabilities: CapabilityType[];
  description: string;
  maxInputSize: number;
  maxOutputSize: number;
  creditCost: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  modelParameters: Record<string, unknown>;
}

export interface ProviderDiscoveryConfig {
  providerType: ProviderType;
  baseUrl: string;
  apiKey?: string;
  organizationId?: string | null;
  additionalHeaders?: Record<string, string>;
}

export interface DiscoveryResult {
  ok: boolean;
  resolvedBaseUrl?: string;
  models: DiscoveredModelSpec[];
  message: string;
}

export interface SyncModelsResult {
  discoveredCount: number;
  createdCount: number;
  skippedCount: number;
  createdModelIds: string[];
  discoveredModels: DiscoveredModelSpec[];
  resolvedBaseUrl?: string;
  message: string;
}

export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/**
 * Strips trailing `/v1beta`, `/v1beta/models`, `/v1alpha`, `/v1`, `/models` from Gemini base URLs
 * so both `https://generativelanguage.googleapis.com` and `https://generativelanguage.googleapis.com/v1beta`
 * resolve to the exact root expected by `@google/genai` and raw REST calls.
 */
export function normalizeGeminiRootBaseUrl(raw: string): string {
  let clean = normalizeBaseUrl(raw);
  clean = clean.replace(/\/(v1beta|v1alpha|v1)\/models$/i, '');
  clean = clean.replace(/\/models$/i, '');
  clean = clean.replace(/\/(v1beta|v1alpha|v1)$/i, '');
  return normalizeBaseUrl(clean);
}

/**
 * Strips `models/` prefix from Google Gemini model identifiers if included.
 */
export function normalizeGeminiModelId(rawIdentifier: string): string {
  return rawIdentifier.trim().replace(/^models\//i, '');
}

/**
 * Normalizes OpenAI-compatible base URLs if an admin pasted `/chat/completions` or `/models`,
 * and appends `/v1` when a bare origin URL (e.g. `https://api.openai.com`) is provided.
 */
export function normalizeOpenAiRootBaseUrl(raw: string): string {
  let clean = normalizeBaseUrl(raw);
  clean = clean.replace(/\/chat\/completions$/i, '');
  clean = clean.replace(/\/images\/(generations|edits|variations)$/i, '');
  clean = clean.replace(/\/audio\/(speech|transcriptions)$/i, '');
  clean = clean.replace(/\/models$/i, '');
  clean = normalizeBaseUrl(clean);
  try {
    const parsed = new URL(clean);
    if (!parsed.pathname || parsed.pathname === '/') {
      return `${parsed.origin}/v1`;
    }
  } catch {
    // keep clean string if partial URL
  }
  return clean;
}

/**
 * Resolves the API inference/router root for Hugging Face models.
 * Hub model page URLs like `https://huggingface.co/black-forest-labs/FLUX.1-dev`
 * must route requests to `https://router.huggingface.co`, never to the Hub HTML repo path.
 */
export function resolveHuggingFaceRouterRoot(rawUrl: string): string {
  const clean = normalizeBaseUrl(rawUrl)
    .replace(/\/v1\/chat\/completions$/i, '')
    .replace(/\/v1\/models$/i, '')
    .replace(/\/v1$/i, '')
    .replace(/\/hf-inference\/models\/.+$/i, '');

  try {
    const u = new URL(clean);
    if (u.hostname === 'huggingface.co' || u.hostname === 'www.huggingface.co') {
      return 'https://router.huggingface.co';
    }
  } catch {
    // fallback below
  }
  return clean || 'https://router.huggingface.co';
}

export function normalizeModelIdentifierForProvider(
  providerType: ProviderType,
  rawIdentifier: string,
): string {
  const trimmed = rawIdentifier.trim();
  if (providerType === 'google_gemini') {
    return normalizeGeminiModelId(trimmed);
  }
  if (providerType === 'huggingface') {
    const repo = extractHuggingFaceRepoFromUrl(trimmed);
    if (repo) return repo;
  }
  return trimmed;
}

function mergeHeaders(
  base: Record<string, string>,
  extra?: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...base };
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      const clean = k.trim();
      if (clean && !clean.toLowerCase().startsWith('host')) {
        out[clean] = v;
      }
    }
  }
  return out;
}

export function extractHuggingFaceRepoFromUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl.trim());
    const hfInfMatch = u.pathname.match(/\/hf-inference\/models\/([^/]+\/[^/]+)/i);
    if (hfInfMatch?.[1]) return hfInfMatch[1];

    if (u.hostname === 'huggingface.co' || u.hostname === 'www.huggingface.co') {
      const pathParts = u.pathname.split('/').filter(Boolean);
      if (
        pathParts.length >= 2 &&
        pathParts[0] !== 'spaces' &&
        pathParts[0] !== 'datasets' &&
        pathParts[0] !== 'api'
      ) {
        return `${pathParts[0]}/${pathParts[1]}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function parseHuggingFaceSpaceUrl(rawUrl: string): {
  kind: 'hub_space' | 'direct_host';
  owner?: string;
  space?: string;
  hubApiUrl?: string;
  directHostUrl: string;
} | null {
  try {
    const u = new URL(rawUrl.trim());
    if (u.hostname.endsWith('.hf.space')) {
      return {
        kind: 'direct_host',
        directHostUrl: `${u.protocol}//${u.host}`,
      };
    }
    if (u.hostname === 'huggingface.co' || u.hostname === 'www.huggingface.co') {
      const match = u.pathname.match(/^\/spaces\/([^/]+)\/([^/]+)/i);
      if (match?.[1] && match?.[2]) {
        const owner = match[1];
        const space = match[2];
        const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        return {
          kind: 'hub_space',
          owner,
          space,
          hubApiUrl: `https://huggingface.co/api/spaces/${owner}/${space}`,
          directHostUrl: `https://${slugify(owner)}-${slugify(space)}.hf.space`,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function resolveHfSpaceRootUrl(
  baseUrl: string,
  apiKey?: string,
  additionalHeaders?: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  resolvedRootUrl: string;
  spaceId: string;
  sdk?: string;
  isPrivate?: boolean;
}> {
  validatePublicHttpsUrl(baseUrl);
  const parsed = parseHuggingFaceSpaceUrl(baseUrl);
  if (!parsed) {
    return {
      resolvedRootUrl: normalizeBaseUrl(baseUrl),
      spaceId: normalizeBaseUrl(baseUrl),
    };
  }

  if (parsed.kind === 'direct_host') {
    validatePublicHttpsUrl(parsed.directHostUrl);
    return {
      resolvedRootUrl: parsed.directHostUrl,
      spaceId: parsed.directHostUrl,
    };
  }

  let resolvedHost = parsed.directHostUrl;
  let sdk: string | undefined;
  let isPrivate = false;

  if (parsed.hubApiUrl) {
    try {
      validatePublicHttpsUrl(parsed.hubApiUrl);
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (apiKey?.trim()) {
        headers.Authorization = `Bearer ${apiKey.trim()}`;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await fetchImpl(parsed.hubApiUrl, {
          method: 'GET',
          headers: mergeHeaders(headers, additionalHeaders),
          signal: controller.signal,
        });
        if (res.ok) {
          const meta = (await res.json()) as {
            host?: string;
            sdk?: string;
            private?: boolean;
            runtime?: { domain?: string };
          };
          const candidateHost = meta.host || meta.runtime?.domain;
          if (candidateHost && candidateHost.startsWith('http')) {
            resolvedHost = normalizeBaseUrl(candidateHost);
          } else if (candidateHost) {
            resolvedHost = `https://${candidateHost.replace(/^\/+/, '')}`;
          }
          sdk = meta.sdk;
          isPrivate = Boolean(meta.private);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Fallback to computed deterministic `<owner>-<space>.hf.space` host
    }
  }

  validatePublicHttpsUrl(resolvedHost);
  return {
    resolvedRootUrl: resolvedHost,
    spaceId: parsed.owner && parsed.space ? `${parsed.owner}/${parsed.space}` : resolvedHost,
    sdk,
    isPrivate,
  };
}

function classifyModelMetadata(params: {
  id: string;
  displayName?: string;
  description?: string;
  pipelineTag?: string;
  architectureModality?: string;
  supportedMethods?: string[];
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}): DiscoveredModelSpec | null {
  const cleanId = params.id.trim();
  if (!cleanId) return null;
  const lower = cleanId.toLowerCase();
  const tag = (params.pipelineTag ?? '').toLowerCase();
  const methods = (params.supportedMethods ?? []).map((m) => m.toLowerCase());

  const name = params.displayName?.trim() || cleanId.split('/').pop() || cleanId;
  const description = params.description?.trim().slice(0, 600) ?? '';
  const maxInputSize = params.inputTokenLimit && params.inputTokenLimit > 0 ? params.inputTokenLimit : 128000;
  const maxOutputSize = params.outputTokenLimit && params.outputTokenLimit > 0 ? params.outputTokenLimit : 8192;

  // Skip legacy/internal non-callable Google models (e.g. aqa uses generateAnswer)
  if (lower === 'aqa' || lower.startsWith('models/aqa')) {
    return null;
  }

  // Skip legacy/internal non-callable methods when Google lists pure attribution/tuning-only entries
  if (
    methods.length > 0 &&
    !methods.includes('generatecontent') &&
    !methods.includes('predict') &&
    !methods.includes('embedcontent') &&
    !methods.includes('generatevideos')
  ) {
    return null;
  }

  // Embeddings
  if (
    tag === 'feature-extraction' ||
    lower.includes('embedding') ||
    lower.includes('embed-') ||
    (methods.includes('embedcontent') && !methods.includes('generatecontent'))
  ) {
    return {
      name,
      modelIdentifier: cleanId,
      category: 'embedding',
      capabilities: ['embeddings'],
      description,
      maxInputSize,
      maxOutputSize: Math.min(maxOutputSize, 4096),
      creditCost: 0.5,
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
      modelParameters: {},
    };
  }

  // Video Generation
  if (
    tag === 'text-to-video' ||
    tag === 'image-to-video' ||
    lower.includes('veo') ||
    lower.includes('sora') ||
    lower.includes('kling') ||
    lower.includes('runway') ||
    lower.includes('luma') ||
    lower.includes('wan2') ||
    methods.includes('generatevideos')
  ) {
    return {
      name,
      modelIdentifier: cleanId,
      category: 'video',
      capabilities: ['video_generation'],
      description,
      maxInputSize: Math.min(maxInputSize, 32000),
      maxOutputSize: 4096,
      creditCost: 15,
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
      modelParameters: {},
    };
  }

  // Audio Speech (TTS)
  if (
    tag === 'text-to-speech' ||
    tag === 'text-to-audio' ||
    lower.includes('-tts') ||
    lower.includes('tts-') ||
    lower.includes('kokoro') ||
    lower.includes('bark')
  ) {
    return {
      name,
      modelIdentifier: cleanId,
      category: 'audio',
      capabilities: ['speech_generation'],
      description,
      maxInputSize: Math.min(maxInputSize, 32000),
      maxOutputSize: 8192,
      creditCost: 2,
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
      modelParameters: {},
    };
  }

  // Audio Transcription (STT)
  if (
    tag === 'automatic-speech-recognition' ||
    lower.includes('whisper') ||
    lower.includes('-stt') ||
    lower.includes('transcribe')
  ) {
    return {
      name,
      modelIdentifier: cleanId,
      category: 'audio',
      capabilities: ['audio_transcription'],
      description,
      maxInputSize: 64000,
      maxOutputSize: 8192,
      creditCost: 1.5,
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
      modelParameters: {},
    };
  }

  // Image Generation (Imagen / Gemini Image / DALL-E / Flux / SD)
  if (
    tag === 'text-to-image' ||
    tag === 'image-to-image' ||
    lower.includes('imagen') ||
    lower.includes('-image') ||
    lower.includes('image-generation') ||
    lower.includes('nano-banana') ||
    lower.includes('dall-e') ||
    lower.includes('gpt-image') ||
    lower.includes('flux') ||
    lower.includes('stable-diffusion') ||
    lower.includes('sdxl') ||
    lower.includes('qwen-image')
  ) {
    const caps: CapabilityType[] = lower.includes('imagen')
      ? ['image_generation']
      : ['image_generation', 'image_editing', 'image_variation'];
    return {
      name,
      modelIdentifier: cleanId,
      category: 'image',
      capabilities: caps,
      description,
      maxInputSize: Math.min(maxInputSize, 65536),
      maxOutputSize: Math.min(maxOutputSize, 8192),
      creditCost: 5,
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
      modelParameters: {},
    };
  }

  // Multimodal Chat / Vision / Audio / Document (Gemini 1.5/2.0/2.5/3, GPT-4o/4.1/5, Claude 3/4, Qwen-VL, HF VLM)
  const modLower = (params.architectureModality ?? '').toLowerCase();
  const isMultimodal =
    tag === 'image-text-to-text' ||
    tag === 'visual-question-answering' ||
    modLower.includes('image') ||
    lower.includes('gemini-') ||
    lower.includes('gpt-4o') ||
    lower.includes('gpt-4.1') ||
    lower.includes('gpt-4.5') ||
    lower.includes('gpt-5') ||
    lower.includes('claude-3') ||
    lower.includes('claude-4') ||
    lower.includes('claude-sonnet-4') ||
    lower.includes('claude-opus-4') ||
    lower.includes('claude-haiku-4') ||
    lower.includes('-vl') ||
    lower.includes('vision') ||
    lower.includes('llama-4');

  if (isMultimodal) {
    const caps: CapabilityType[] = [
      'text_generation',
      'chat',
      'vision',
      'document_analysis',
    ];
    if (lower.includes('gemini-2.') || lower.includes('gemini-3') || lower.includes('gemini-1.5')) {
      caps.push('audio_transcription');
    }
    return {
      name,
      modelIdentifier: cleanId,
      category: 'multimodal',
      capabilities: caps,
      description,
      maxInputSize,
      maxOutputSize,
      creditCost: lower.includes('pro') || lower.includes('opus') ? 2 : 1,
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
      modelParameters: {},
    };
  }

  // Standard LLM / Text Generation / Chat
  return {
    name,
    modelIdentifier: cleanId,
    category: 'llm',
    capabilities: ['text_generation', 'chat'],
    description,
    maxInputSize,
    maxOutputSize,
    creditCost: 1,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
    modelParameters: {},
  };
}

async function fetchJsonSafe(
  url: string,
  headers: Record<string, string>,
  apiKey: string,
  fetchImpl: typeof fetch,
  timeoutMs = 15000,
): Promise<{ ok: boolean; status: number; data: unknown; rawText: string }> {
  validatePublicHttpsUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
    const rawText = await res.text();
    let data: unknown = null;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data, rawText: redactSecrets(rawText, apiKey ? [apiKey] : []) };
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverProviderModels(
  config: ProviderDiscoveryConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveryResult> {
  const apiKey = (config.apiKey ?? '').trim();

  try {
    // 1. GOOGLE GEMINI
    if (config.providerType === 'google_gemini') {
      const root = normalizeGeminiRootBaseUrl(config.baseUrl);
      validatePublicHttpsUrl(root);
      const headers = mergeHeaders(
        { 'x-goog-api-key': apiKey, Accept: 'application/json' },
        config.additionalHeaders,
      );

      const discovered: DiscoveredModelSpec[] = [];
      let nextPageToken: string | undefined;
      for (let page = 0; page < 5; page++) {
        const qs = new URLSearchParams({ pageSize: '100' });
        if (nextPageToken) qs.set('pageToken', nextPageToken);
        const url = `${root}/v1beta/models?${qs.toString()}`;
        const res = await fetchJsonSafe(url, headers, apiKey, fetchImpl);
        if (!res.ok) {
          return {
            ok: false,
            resolvedBaseUrl: root,
            models: [],
            message: `خطای دریافت مدل‌های Gemini (HTTP ${res.status}): ${res.rawText.slice(0, 200)}`,
          };
        }
        const json = res.data as {
          models?: Array<{
            name?: string;
            displayName?: string;
            description?: string;
            inputTokenLimit?: number;
            outputTokenLimit?: number;
            supportedGenerationMethods?: string[];
          }>;
          nextPageToken?: string;
        };
        for (const item of json?.models ?? []) {
          const cleanId = normalizeGeminiModelId(item.name ?? '');
          if (!cleanId) continue;
          const spec = classifyModelMetadata({
            id: cleanId,
            displayName: item.displayName,
            description: item.description,
            supportedMethods: item.supportedGenerationMethods,
            inputTokenLimit: item.inputTokenLimit,
            outputTokenLimit: item.outputTokenLimit,
          });
          if (spec) discovered.push(spec);
        }
        if (!json?.nextPageToken) break;
        nextPageToken = json.nextPageToken;
      }

      return {
        ok: true,
        resolvedBaseUrl: root,
        models: discovered,
        message: `${discovered.length} مدل از Google Gemini شناسایی شد.`,
      };
    }

    // 2. ANTHROPIC
    if (config.providerType === 'anthropic') {
      const base = normalizeBaseUrl(config.baseUrl).replace(/\/v1\/models$/i, '').replace(/\/models$/i, '');
      const url = `${base}/v1/models`;
      const headers = mergeHeaders(
        {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          Accept: 'application/json',
        },
        config.additionalHeaders,
      );
      const res = await fetchJsonSafe(url, headers, apiKey, fetchImpl);
      if (!res.ok) {
        return {
          ok: false,
          models: [],
          message: `خطای دریافت مدل‌های Anthropic (HTTP ${res.status}): ${res.rawText.slice(0, 200)}`,
        };
      }
      const json = res.data as { data?: Array<{ id?: string; display_name?: string }> };
      const discovered = (json?.data ?? [])
        .map((m) =>
          classifyModelMetadata({
            id: m.id ?? '',
            displayName: m.display_name,
            inputTokenLimit: 200000,
            outputTokenLimit: 8192,
          }),
        )
        .filter((x): x is DiscoveredModelSpec => Boolean(x));

      return {
        ok: true,
        models: discovered,
        message: `${discovered.length} مدل Anthropic شناسایی شد.`,
      };
    }

    // 3. HUGGING FACE INFERENCE / ROUTER
    if (config.providerType === 'huggingface') {
      const repoId = extractHuggingFaceRepoFromUrl(config.baseUrl);
      const authHeaders: Record<string, string> = { Accept: 'application/json' };
      if (apiKey) authHeaders.Authorization = `Bearer ${apiKey}`;
      const headers = mergeHeaders(authHeaders, config.additionalHeaders);

      if (repoId) {
        const metaUrl = `https://huggingface.co/api/models/${repoId}`;
        const res = await fetchJsonSafe(metaUrl, headers, apiKey, fetchImpl);
        if (!res.ok) {
          // Even if Hub API lookup is restricted, register with sensible default so admin can use it
          const fallback = classifyModelMetadata({ id: repoId, displayName: repoId });
          return {
            ok: true,
            models: fallback ? [fallback] : [],
            message: `مدل Hugging Face (${repoId}) ثبت شد.`,
          };
        }
        const meta = res.data as {
          id?: string;
          pipeline_tag?: string;
          cardData?: { pipeline_tag?: string };
          tags?: string[];
        };
        const spec = classifyModelMetadata({
          id: meta.id || repoId,
          displayName: (meta.id || repoId).split('/').pop(),
          pipelineTag: meta.pipeline_tag || meta.cardData?.pipeline_tag,
          description: meta.tags ? meta.tags.slice(0, 5).join(', ') : '',
        });
        return {
          ok: true,
          models: spec ? [spec] : [],
          message: `مدل Hugging Face (${repoId}) شناسایی شد.`,
        };
      }

      const root = resolveHuggingFaceRouterRoot(config.baseUrl);
      const listUrl = `${root}/v1/models`;
      const res = await fetchJsonSafe(listUrl, headers, apiKey, fetchImpl);
      if (!res.ok) {
        return {
          ok: false,
          models: [],
          message: `خطای دریافت مدل‌های Hugging Face (HTTP ${res.status}): ${res.rawText.slice(0, 200)}`,
        };
      }
      const json = res.data as {
        data?: Array<{
          id?: string;
          object?: string;
          architecture?: { input_modalities?: string[]; output_modalities?: string[] };
          providers?: Array<{ provider?: string; context_length?: number }>;
        }>;
      };
      const discovered = (json?.data ?? [])
        .slice(0, 50)
        .map((m) =>
          classifyModelMetadata({
            id: m.id ?? '',
            displayName: m.id?.split('/').pop() || m.id,
            architectureModality: (m.architecture?.input_modalities ?? []).join(','),
            inputTokenLimit: m.providers?.[0]?.context_length ?? 64000,
          }),
        )
        .filter((x): x is DiscoveredModelSpec => Boolean(x));

      // Also discover warm text-to-image inference models so Hugging Face Router supports image generation out-of-the-box
      try {
        const imgListUrl =
          'https://huggingface.co/api/models?pipeline_tag=text-to-image&inference=warm&sort=likes&direction=-1&limit=10';
        const imgRes = await fetchJsonSafe(imgListUrl, headers, apiKey, fetchImpl, 10000);
        if (imgRes.ok && Array.isArray(imgRes.data)) {
          const seen = new Set(discovered.map((d) => d.modelIdentifier.toLowerCase()));
          for (const rawItem of imgRes.data) {
            if (!rawItem || typeof rawItem !== 'object') continue;
            const item = rawItem as { id?: string; pipeline_tag?: string; tags?: string[] };
            if (!item.id || seen.has(item.id.toLowerCase())) continue;
            const imgSpec = classifyModelMetadata({
              id: item.id,
              displayName: item.id.split('/').pop() || item.id,
              pipelineTag: item.pipeline_tag || 'text-to-image',
              description: Array.isArray(item.tags) ? item.tags.slice(0, 4).join(', ') : '',
            });
            if (imgSpec) {
              seen.add(imgSpec.modelIdentifier.toLowerCase());
              discovered.push(imgSpec);
            }
          }
        }
      } catch {
        // Non-fatal: continue with /v1/models discovery results
      }

      return {
        ok: true,
        resolvedBaseUrl: root,
        models: discovered,
        message: `${discovered.length} مدل از Hugging Face Router شناسایی شد.`,
      };
    }

    // 4. HUGGING FACE SPACES (Gradio / ZeroGPU / Custom API)
    if (config.providerType === 'huggingface_space') {
      const resolved = await resolveHfSpaceRootUrl(
        config.baseUrl,
        apiKey,
        config.additionalHeaders,
        fetchImpl,
      );
      const authHeaders: Record<string, string> = { Accept: 'application/json' };
      if (apiKey) authHeaders.Authorization = `Bearer ${apiKey}`;
      const headers = mergeHeaders(authHeaders, config.additionalHeaders);

      let apiInfoJson: Record<string, unknown> | null = null;
      let endpointPrefix = '/gradio_api';

      for (const candidate of [
        { path: '/gradio_api/info', prefix: '/gradio_api' },
        { path: '/info', prefix: '' },
      ]) {
        const res = await fetchJsonSafe(`${resolved.resolvedRootUrl}${candidate.path}`, headers, apiKey, fetchImpl, 12000);
        if (res.ok && res.data && typeof res.data === 'object') {
          apiInfoJson = res.data as Record<string, unknown>;
          endpointPrefix = candidate.prefix;
          break;
        }
      }

      const discovered: DiscoveredModelSpec[] = [];
      const namedEndpoints = (apiInfoJson?.named_endpoints ?? {}) as Record<
        string,
        {
          parameters?: Array<{
            label?: string;
            parameter_name?: string;
            type?: { type?: string };
            component?: string;
            parameter_has_default?: boolean;
            parameter_default?: unknown;
          }>;
          returns?: Array<{
            label?: string;
            type?: { type?: string };
            component?: string;
          }>;
        }
      >;

      const endpointEntries = Object.entries(namedEndpoints);
      for (const [rawApiPath, ep] of endpointEntries) {
        const apiName = rawApiPath.replace(/^\/+/, '');
        if (!apiName || apiName.startsWith('gradio_')) continue;

        const paramsList = ep.parameters ?? [];
        const returnsList = ep.returns ?? [];
        const inputSummary = paramsList.map((p) => (p.component || p.type?.type || p.label || '').toLowerCase());
        const returnSummary = returnsList.map((r) => (r.component || r.type?.type || r.label || '').toLowerCase());

        const hasImageOutput = returnSummary.some((r) => r.includes('image') || r.includes('gallery'));
        const hasAudioOutput = returnSummary.some((r) => r.includes('audio'));
        const hasVideoOutput = returnSummary.some((r) => r.includes('video'));
        const hasImageInput = inputSummary.some((i) => i.includes('image') || i.includes('file'));
        const hasAudioInput = inputSummary.some((i) => i.includes('audio'));

        let category: ModelCategory = 'llm';
        let capabilities: CapabilityType[] = ['text_generation', 'chat'];
        let creditCost = 1;

        if (hasVideoOutput) {
          category = 'video';
          capabilities = ['video_generation'];
          creditCost = 10;
        } else if (hasImageOutput) {
          category = 'image';
          capabilities = hasImageInput
            ? ['image_generation', 'image_editing', 'image_variation']
            : ['image_generation'];
          creditCost = 4;
        } else if (hasAudioOutput) {
          category = 'audio';
          capabilities = ['speech_generation'];
          creditCost = 2;
        } else if (hasAudioInput && !hasImageInput) {
          category = 'audio';
          capabilities = ['audio_transcription'];
          creditCost = 1.5;
        } else if (hasImageInput) {
          category = 'multimodal';
          capabilities = ['text_generation', 'chat', 'vision', 'document_analysis'];
          creditCost = 2;
        }

        const spaceShortName = resolved.spaceId.split('/').pop() || 'HF Space';
        const endpointLabel = endpointEntries.length === 1 ? spaceShortName : `${spaceShortName} (${apiName})`;

        discovered.push({
          name: endpointLabel.slice(0, 130),
          modelIdentifier: `${resolved.spaceId}::${apiName}`.slice(0, 195),
          category,
          capabilities,
          description: `Hugging Face Space endpoint /${apiName} (${paramsList.length} ورودی)`,
          maxInputSize: 32000,
          maxOutputSize: 4096,
          creditCost,
          inputPricePerMillion: 0,
          outputPricePerMillion: 0,
          modelParameters: {
            spaceHost: resolved.resolvedRootUrl,
            spaceId: resolved.spaceId,
            apiName,
            endpointPrefix,
            parameters: paramsList.map((p, idx) => ({
              index: idx,
              name: p.parameter_name || p.label || `arg_${idx}`,
              component: (p.component || p.type?.type || 'textbox').toLowerCase(),
              hasDefault: Boolean(p.parameter_has_default),
              defaultValue: p.parameter_default ?? null,
            })),
            returns: returnsList.map((r, idx) => ({
              index: idx,
              label: r.label || `out_${idx}`,
              component: (r.component || r.type?.type || 'textbox').toLowerCase(),
            })),
          },
        });
      }

      // Fallback probe via /config if named_endpoints wasn't populated
      if (discovered.length === 0) {
        const cfgRes = await fetchJsonSafe(`${resolved.resolvedRootUrl}/config`, headers, apiKey, fetchImpl, 10000);
        if (cfgRes.ok && cfgRes.data && typeof cfgRes.data === 'object') {
          const cfg = cfgRes.data as {
            dependencies?: Array<{ api_name?: string | false; inputs?: unknown[]; outputs?: unknown[] }>;
          };
          const deps = (cfg.dependencies ?? []).filter((d) => typeof d.api_name === 'string' && d.api_name);
          for (const dep of deps.slice(0, 10)) {
            const apiName = String(dep.api_name).replace(/^\/+/, '');
            const spaceShortName = resolved.spaceId.split('/').pop() || 'HF Space';
            discovered.push({
              name: deps.length === 1 ? spaceShortName : `${spaceShortName} (${apiName})`,
              modelIdentifier: `${resolved.spaceId}::${apiName}`.slice(0, 195),
              category: 'llm',
              capabilities: ['text_generation', 'chat'],
              description: `Hugging Face Space Gradio endpoint /${apiName}`,
              maxInputSize: 32000,
              maxOutputSize: 4096,
              creditCost: 1,
              inputPricePerMillion: 0,
              outputPricePerMillion: 0,
              modelParameters: {
                spaceHost: resolved.resolvedRootUrl,
                spaceId: resolved.spaceId,
                apiName,
                endpointPrefix: '/gradio_api',
              },
            });
          }
        }
      }

      if (discovered.length === 0) {
        // Still allow direct chat/predict integration for generic OpenAI-compatible or custom HF Spaces
        const spaceShortName = resolved.spaceId.split('/').pop() || 'HF Space';
        discovered.push({
          name: spaceShortName,
          modelIdentifier: `${resolved.spaceId}::predict`.slice(0, 195),
          category: 'llm',
          capabilities: ['text_generation', 'chat'],
          description: `Hugging Face Space (${resolved.resolvedRootUrl})`,
          maxInputSize: 32000,
          maxOutputSize: 4096,
          creditCost: 1,
          inputPricePerMillion: 0,
          outputPricePerMillion: 0,
          modelParameters: {
            spaceHost: resolved.resolvedRootUrl,
            spaceId: resolved.spaceId,
            apiName: 'predict',
            endpointPrefix: '/gradio_api',
          },
        });
      }

      return {
        ok: true,
        resolvedBaseUrl: resolved.resolvedRootUrl,
        models: discovered,
        message: `${discovered.length} اندپوینت/مدل از Hugging Face Space (${resolved.spaceId}) شناسایی شد.`,
      };
    }

    // 5. OPENAI-COMPATIBLE / CUSTOM
    if (config.providerType === 'openai_compatible' || config.providerType === 'custom') {
      const base = normalizeOpenAiRootBaseUrl(config.baseUrl);
      const url = `${base}/models`;
      const authHeaders: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      };
      if (config.organizationId) {
        authHeaders['OpenAI-Organization'] = config.organizationId;
      }
      const res = await fetchJsonSafe(
        url,
        mergeHeaders(authHeaders, config.additionalHeaders),
        apiKey,
        fetchImpl,
      );
      if (!res.ok) {
        return {
          ok: false,
          models: [],
          message: `خطای دریافت لیست مدل‌ها (HTTP ${res.status}): ${res.rawText.slice(0, 200)}`,
        };
      }
      const rawArr = Array.isArray(res.data)
        ? res.data
        : ((res.data as { data?: unknown[]; models?: unknown[] })?.data ??
          (res.data as { models?: unknown[] })?.models ??
          []);

      const discovered: DiscoveredModelSpec[] = [];
      for (const item of rawArr) {
        if (!item || typeof item !== 'object') continue;
        const m = item as {
          id?: string;
          name?: string;
          description?: string;
          context_length?: number;
          architecture?: { modality?: string };
        };
        if (!m.id) continue;
        const spec = classifyModelMetadata({
          id: m.id,
          displayName: m.name,
          description: m.description,
          architectureModality: m.architecture?.modality,
          inputTokenLimit: m.context_length,
        });
        if (spec) discovered.push(spec);
      }

      return {
        ok: true,
        resolvedBaseUrl: base,
        models: discovered,
        message: `${discovered.length} مدل از سرویس شناسایی شد.`,
      };
    }

    // 6. CLOUDFLARE WORKERS AI (Native env.AI binding or live Cloudflare REST catalog)
    if (config.providerType === 'cloudflare_workers_ai') {
      const hasNativeBinding = Boolean(getCloudflareAiBinding());
      const accountId = (config.organizationId ?? '').trim();

      const mapCloudflareCatalogModel = (item: {
        name?: string;
        description?: string;
        task?: { name?: string };
      }): DiscoveredModelSpec | null => {
        const id = (item.name ?? '').trim();
        if (!id) return null;
        const taskName = (item.task?.name ?? '').toLowerCase();
        const prettyName = id
          .split('/')
          .pop()
          ?.replace(/[-_]+/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase()) || id;

        if (taskName === 'text-to-image') {
          return {
            name: prettyName,
            modelIdentifier: id,
            category: 'image',
            capabilities: ['image_generation'],
            description: (item.description ?? '').slice(0, 400),
            maxInputSize: 4096,
            maxOutputSize: 4096,
            creditCost: 2,
            inputPricePerMillion: 0,
            outputPricePerMillion: 0,
            modelParameters: id.includes('flux-1-schnell') ? { steps: 4 } : {},
          };
        }
        if (taskName === 'text generation') {
          const isVision = /llama-4|vision|vl|gemma-3/i.test(id);
          return {
            name: prettyName,
            modelIdentifier: id,
            category: isVision ? 'multimodal' : 'llm',
            capabilities: isVision
              ? ['text_generation', 'chat', 'vision', 'document_analysis']
              : ['text_generation', 'chat'],
            description: (item.description ?? '').slice(0, 400),
            maxInputSize: 32000,
            maxOutputSize: 4096,
            creditCost: 1,
            inputPricePerMillion: 0,
            outputPricePerMillion: 0,
            modelParameters: {},
          };
        }
        if (taskName === 'automatic speech recognition') {
          return {
            name: prettyName,
            modelIdentifier: id,
            category: 'audio',
            capabilities: ['audio_transcription'],
            description: (item.description ?? '').slice(0, 400),
            maxInputSize: 64000,
            maxOutputSize: 8192,
            creditCost: 1,
            inputPricePerMillion: 0,
            outputPricePerMillion: 0,
            modelParameters: {},
          };
        }
        if (taskName === 'text-to-speech') {
          return {
            name: prettyName,
            modelIdentifier: id,
            category: 'audio',
            capabilities: ['speech_generation'],
            description: (item.description ?? '').slice(0, 400),
            maxInputSize: 16000,
            maxOutputSize: 4096,
            creditCost: 1,
            inputPricePerMillion: 0,
            outputPricePerMillion: 0,
            modelParameters: {},
          };
        }
        if (taskName === 'text embeddings') {
          return {
            name: prettyName,
            modelIdentifier: id,
            category: 'embedding',
            capabilities: ['embeddings'],
            description: (item.description ?? '').slice(0, 400),
            maxInputSize: 8192,
            maxOutputSize: 1024,
            creditCost: 0.5,
            inputPricePerMillion: 0,
            outputPricePerMillion: 0,
            modelParameters: {},
          };
        }
        return null;
      };

      // If Account ID + API Token are supplied, enumerate the complete live Cloudflare catalog (paginated)
      if (accountId && apiKey) {
        const mergedMap = new Map<string, DiscoveredModelSpec>();
        for (const curated of CLOUDFLARE_WORKERS_AI_CURATED_MODELS) {
          mergedMap.set(curated.modelIdentifier.toLowerCase(), curated);
        }

        let gotAnyPage = false;
        for (let page = 1; page <= 3; page++) {
          const searchUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search?per_page=100&page=${page}`;
          const res = await fetchJsonSafe(
            searchUrl,
            mergeHeaders({ Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, config.additionalHeaders),
            apiKey,
            fetchImpl,
          );
          if (!res.ok) {
            if (!hasNativeBinding && !gotAnyPage) {
              return {
                ok: false,
                models: [],
                message: `خطای احراز هویت Cloudflare Workers AI (HTTP ${res.status}): ${res.rawText.slice(0, 200)}`,
              };
            }
            break;
          }
          gotAnyPage = true;
          const payload = res.data as {
            result?: Array<{ name?: string; description?: string; task?: { name?: string } }>;
          };
          const batch = Array.isArray(payload?.result) ? payload.result : [];
          for (const item of batch) {
            const spec = mapCloudflareCatalogModel(item);
            if (spec && !mergedMap.has(spec.modelIdentifier.toLowerCase())) {
              mergedMap.set(spec.modelIdentifier.toLowerCase(), spec);
            }
          }
          if (batch.length < 100) break;
        }

        const allModels = Array.from(mergedMap.values());
        return {
          ok: true,
          resolvedBaseUrl: 'https://api.cloudflare.com/client/v4',
          models: allModels,
          message: `${allModels.length} مدل Cloudflare Workers AI شناسایی شد.`,
        };
      }

      if (hasNativeBinding) {
        return {
          ok: true,
          resolvedBaseUrl: 'https://api.cloudflare.com/client/v4',
          models: CLOUDFLARE_WORKERS_AI_CURATED_MODELS,
          message: `${CLOUDFLARE_WORKERS_AI_CURATED_MODELS.length} مدل Cloudflare Workers AI (تصویری، متنی، صوتی و تبدیل گفتار) با اتصال بومی شناسایی شد.`,
        };
      }

      return {
        ok: false,
        models: [],
        message:
          'خارج از محیط Cloudflare Worker، برای همگام‌سازی REST باید شناسه اکانت (Account ID در فیلد شناسه سازمان) و API Token وارد شود؛ پس از دیپلوی روی Cloudflare بدون کلید کار می‌کند.',
      };
    }

    // Replicate / fal.ai don't enumerate a compact curated user-scoped model list uniformly
    return {
      ok: true,
      models: [],
      message: 'این نوع ارائه‌دهنده لیست خودکار عمومی ندارد؛ مدل‌ها را می‌توانید دستی ثبت کنید.',
    };
  } catch (err) {
    if (err instanceof SsrfProtectionError) {
      return { ok: false, models: [], message: err.message };
    }
    return {
      ok: false,
      models: [],
      message: redactSecrets(
        err instanceof Error ? err.message : 'خطا در شناسایی مدل‌های ارائه‌دهنده.',
        apiKey ? [apiKey] : [],
      ),
    };
  }
}

function scoreDefaultChatCandidate(item: DiscoveredModelSpec, cleanId: string): number {
  if (item.category !== 'llm' && item.category !== 'multimodal') return -1;
  if (!item.capabilities.includes('chat') && !item.capabilities.includes('text_generation')) return -1;

  const lower = cleanId.toLowerCase();
  // Never auto-select specialized/restricted models as the default chat model
  if (
    lower.includes('gemma') ||
    lower.includes('image') ||
    lower.includes('tts') ||
    lower.includes('robotics') ||
    lower.includes('computer-use') ||
    lower.includes('deep-research') ||
    lower.includes('thinking')
  ) {
    return 1;
  }

  if (lower === 'gemini-2.5-flash') return 100;
  if (lower === 'gemini-2.0-flash' || lower === 'gemini-2.5-flash-lite') return 95;
  if (lower === 'gpt-4o-mini' || lower === 'gpt-4.1-mini') return 92;
  if (lower === 'gpt-4o' || lower === 'gpt-4.1') return 90;
  if (lower.includes('claude-sonnet-4') || lower.includes('claude-3-5-sonnet') || lower.includes('claude-3-7-sonnet')) {
    return 88;
  }
  if (lower.includes('gemini-2.5') && lower.includes('flash')) return 85;
  if (lower.includes('gemini-2.0') && lower.includes('flash')) return 80;
  if (lower.includes('flash') || lower.includes('mini')) return 70;
  return 50;
}

export async function syncProviderModelsToDatabase(params: {
  providerId: string;
  providerType: ProviderType;
  discoveredModels: DiscoveredModelSpec[];
  activateAll?: boolean;
  defaultCreditCost?: number;
}): Promise<SyncModelsResult> {
  const db = getDb();
  const existing = await db
    .select({ id: aiModels.id, modelIdentifier: aiModels.modelIdentifier, isDefault: aiModels.isDefault })
    .from(aiModels)
    .where(eq(aiModels.providerId, params.providerId));

  const existingNormalizedSet = new Set(
    existing.map((m) => normalizeModelIdentifierForProvider(params.providerType, m.modelIdentifier).toLowerCase()),
  );

  // Check if the platform already has any default chat/text model
  const existingDefaults = await db
    .select({ id: aiModels.id, category: aiModels.category })
    .from(aiModels)
    .where(eq(aiModels.isDefault, true));
  const hasAnyTextDefault = existingDefaults.some((d) => d.category === 'llm' || d.category === 'multimodal');

  // Identify the single best default chat candidate among newly added models
  let bestDefaultIdentifier: string | null = null;
  if (!hasAnyTextDefault) {
    let bestScore = -1;
    for (const item of params.discoveredModels) {
      const cleanId = normalizeModelIdentifierForProvider(params.providerType, item.modelIdentifier);
      if (!cleanId || existingNormalizedSet.has(cleanId.toLowerCase())) continue;
      const score = scoreDefaultChatCandidate(item, cleanId);
      if (score > bestScore) {
        bestScore = score;
        bestDefaultIdentifier = cleanId.toLowerCase();
      }
    }
  }

  const createdModelIds: string[] = [];
  let skippedCount = 0;

  await db.transaction(async (tx) => {
    for (let idx = 0; idx < params.discoveredModels.length; idx++) {
      const item = params.discoveredModels[idx]!;
      const cleanId = normalizeModelIdentifierForProvider(params.providerType, item.modelIdentifier);
      if (!cleanId || existingNormalizedSet.has(cleanId.toLowerCase())) {
        skippedCount++;
        continue;
      }

      const creditCost =
        params.defaultCreditCost !== undefined ? params.defaultCreditCost : item.creditCost;
      const isPreferredDefault =
        bestDefaultIdentifier !== null && cleanId.toLowerCase() === bestDefaultIdentifier;
      if (isPreferredDefault) {
        bestDefaultIdentifier = null;
      }

      const candidateScore = scoreDefaultChatCandidate(item, cleanId);
      const priority = isPreferredDefault ? 40 : candidateScore >= 70 ? 60 + idx : 100 + idx;

      const [inserted] = await tx
        .insert(aiModels)
        .values({
          providerId: params.providerId,
          name: item.name.slice(0, 140),
          modelIdentifier: cleanId.slice(0, 200),
          category: item.category,
          description: item.description,
          inputPricePerMillion: String(item.inputPricePerMillion ?? 0),
          outputPricePerMillion: String(item.outputPricePerMillion ?? 0),
          creditCost: String(creditCost),
          minCreditCost: '0',
          providerCostPerOpUsd: '0',
          allowedPlanTiers: [],
          priority,
          isDefault: isPreferredDefault,
          isActive: params.activateAll ?? true,
          maxInputSize: item.maxInputSize,
          maxOutputSize: item.maxOutputSize,
          modelParameters: item.modelParameters ?? {},
        })
        .onConflictDoNothing()
        .returning({ id: aiModels.id });

      if (!inserted) {
        skippedCount++;
        continue;
      }

      const uniqueCaps = Array.from(new Set(item.capabilities));
      if (uniqueCaps.length > 0) {
        await tx
          .insert(modelCapabilities)
          .values(uniqueCaps.map((capability) => ({ modelId: inserted.id, capability })))
          .onConflictDoNothing();
      }

      existingNormalizedSet.add(cleanId.toLowerCase());
      createdModelIds.push(inserted.id);
    }
  });

  return {
    discoveredCount: params.discoveredModels.length,
    createdCount: createdModelIds.length,
    skippedCount,
    createdModelIds,
    discoveredModels: params.discoveredModels,
    message:
      createdModelIds.length > 0
        ? `${createdModelIds.length} مدل جدید شناسایی و به صورت خودکار ثبت شد (${skippedCount} مدل تکراری نادیده گرفته شد).`
        : params.discoveredModels.length > 0
          ? `همه ${params.discoveredModels.length} مدل شناسایی‌شده از قبل ثبت شده بودند.`
          : 'مدل جدیدی برای افزودن خودکار یافت نشد.',
  };
}
