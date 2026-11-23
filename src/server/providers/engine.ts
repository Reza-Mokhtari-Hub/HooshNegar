import { AsyncLocalStorage } from 'node:async_hooks';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import { aiModels, aiProviders, modelCapabilities, providerCredentials } from '../../db/schema.ts';
import type { CapabilityType } from '../../shared/validation.ts';
import { isAiMockModeEnabled, isCloudflareWorker } from '../config/env.ts';
import { getCloudflareAiBinding, getCloudflareRequestContext } from '../cloudflare/requestContext.ts';
import { decryptSecret, redactSecrets } from '../security/crypto.ts';
import { assertSafeOutboundUrl, SsrfProtectionError } from '../security/ssrf.ts';
import {
  extractHuggingFaceRepoFromUrl,
  isHuggingFaceSpaceUrl,
  normalizeBaseUrl,
  normalizeGeminiModelId,
  normalizeGeminiRootBaseUrl,
  normalizeOpenAiRootBaseUrl,
  resolveHfSpaceRootUrl,
  resolveHuggingFaceRouterRoot,
} from './discovery.ts';
import {
  AIProviderError,
  estimateTokenCostUsd,
  estimateTokensRough,
  type AudioTranscriptionInput,
  type AudioTranscriptionOutput,
  type CredentialFailureKind,
  type DocumentAnalysisInput,
  type ImageEditInput,
  type ImageGenerationInput,
  type ImageOutput,
  type ProviderExecutionContext,
  type SpeechGenerationInput,
  type SpeechGenerationOutput,
  type TextGenerationInput,
  type TextGenerationOutput,
  type VideoGenerationInput,
  type VideoJobPollOutput,
  type VideoJobStartOutput,
  type VisionAnalysisInput,
} from './types.ts';
import {
  runMockAudioTranscription,
  runMockDocumentAnalysis,
  runMockImageEdit,
  runMockImageGeneration,
  runMockSpeechGeneration,
  runMockTextGeneration,
  runMockVideoPoll,
  runMockVideoStart,
  runMockVisionAnalysis,
} from './mockAdapter.ts';

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

function isModelQuotaZeroSignal(text: string): boolean {
  return /\blimit\s*:\s*0\b/i.test(text);
}

function isQuotaExhaustedSignal(text: string): boolean {
  if (isModelQuotaZeroSignal(text)) return false;
  return /insufficient_quota|credit balance is too low|exceeded your monthly included credits|payment required|zerogpu.*quota|exceeded your.*gpu quota|free gpu quota|pro gpu quota|gpu quota.*left|gpu duration.*exceeded|sign in to hugging face.*gpu|no gpu was available|daily.*limit|exceeded your current quota/i.test(
    text,
  );
}

function isInvalidKeySignal(text: string): boolean {
  return /api_key_invalid|api key not valid|invalid[_\s-]?api[_\s-]?key|incorrect api key|invalid[_\s-]?x-api-key|invalid[_\s-]?token|token is invalid|authentication_error|unauthenticated|revoked api key/i.test(
    text,
  );
}

function extractReadableUpstreamError(bodyText: string, secrets: string[]): {
  summary: string;
  quotaModel: string | null;
} {
  let cleanText = bodyText.trim();
  try {
    const parsed = JSON.parse(cleanText) as {
      error?: { message?: unknown; status?: unknown } | string;
      message?: unknown;
    };
    if (typeof parsed?.error === 'string') {
      cleanText = parsed.error;
    } else if (parsed?.error && typeof parsed.error === 'object' && typeof parsed.error.message === 'string') {
      cleanText = parsed.error.message;
    } else if (typeof parsed?.message === 'string') {
      cleanText = parsed.message;
    }
  } catch {
    // keep raw text when not JSON
  }

  const quotaModelMatch = /\bmodel:\s*([a-zA-Z0-9._:/-]+)/i.exec(bodyText) ?? /\bmodel:\s*([a-zA-Z0-9._:/-]+)/i.exec(cleanText);
  const quotaModel = quotaModelMatch?.[1] ?? null;

  const compact = cleanText.replace(/\s+/g, ' ').trim();
  const limitSegmentMatch = /(Quota exceeded for metric:[^.\n]+(?:,\s*limit:\s*\d+)?(?:,\s*model:\s*[a-zA-Z0-9._:/-]+)?)/i.exec(compact);
  const prioritized = limitSegmentMatch?.[1]
    ? `${limitSegmentMatch[1]} — ${compact}`
    : compact;

  return {
    summary: redactSecrets(prioritized.slice(0, 260), secrets),
    quotaModel,
  };
}

function classifyHttpError(
  status: number,
  bodyText: string,
  apiKey: string,
  modelIdentifier?: string,
): AIProviderError {
  const secrets = apiKey ? [apiKey] : [];
  const { summary: safeMsg, quotaModel } = extractReadableUpstreamError(bodyText, secrets);
  const modelLabel = quotaModel || modelIdentifier || '';

  if (status === 402) {
    return new AIProviderError({
      code: 'RATE_LIMITED',
      message: `Provider quota exhausted (${status}): ${safeMsg}`,
      userMessageFa: 'این مدل در حال حاضر در دسترس نیست. لطفاً مدل دیگری انتخاب کنید.',
      retryable: true,
      httpStatus: status,
      credentialFailureKind: 'quota_exhausted',
    });
  }

  if (status === 401 || isInvalidKeySignal(bodyText)) {
    return new AIProviderError({
      code: 'INVALID_API_KEY',
      message: `Provider auth failed (${status}): ${safeMsg}`,
      userMessageFa: 'این مدل در حال حاضر در دسترس نیست. لطفاً مدل دیگری انتخاب کنید.',
      retryable: false,
      httpStatus: status,
      credentialFailureKind: 'invalid',
    });
  }

  if (status === 403) {
    // 403 without an invalid-key signal is usually billing, region, gated model, or token scope—never brick other models on this key
    return new AIProviderError({
      code: 'PROVIDER_ERROR',
      message: `Provider access restricted (403): ${safeMsg}`,
      userMessageFa: 'این مدل در حال حاضر در دسترس نیست. لطفاً مدل دیگری انتخاب کنید.',
      retryable: false,
      httpStatus: 403,
      credentialFailureKind: 'transient',
    });
  }

  if (status === 429) {
    if (isModelQuotaZeroSignal(bodyText)) {
      return new AIProviderError({
        code: 'RATE_LIMITED',
        message: `Model${modelLabel ? ` "${modelLabel}"` : ''} free-tier quota is zero (429): ${safeMsg}`,
        userMessageFa: 'این مدل در حال حاضر در دسترس نیست. لطفاً مدل دیگری انتخاب کنید.',
        retryable: false,
        httpStatus: 429,
        credentialFailureKind: 'transient',
      });
    }
    if (isQuotaExhaustedSignal(bodyText)) {
      return new AIProviderError({
        code: 'RATE_LIMITED',
        message: `Provider quota exhausted (429): ${safeMsg}`,
        userMessageFa: 'سرویس این مدل موقتاً در دسترس نیست. لطفاً لحظاتی دیگر دوباره تلاش کنید یا مدل دیگری انتخاب نمایید.',
        retryable: true,
        httpStatus: 429,
        credentialFailureKind: 'quota_exhausted',
      });
    }
    return new AIProviderError({
      code: 'RATE_LIMITED',
      message: `Provider rate limited (429): ${safeMsg}`,
      userMessageFa: 'سرویس این مدل موقتاً شلوغ است. لطفاً لحظاتی دیگر دوباره تلاش کنید.',
      retryable: true,
      httpStatus: 429,
      credentialFailureKind: 'rate_limited',
    });
  }

  if (status === 400 || status === 422) {
    if (/billed users|only accessible to billed/i.test(bodyText)) {
      return new AIProviderError({
        code: 'PROVIDER_ERROR',
        message: `Provider billing required (${status}): ${safeMsg}`,
        userMessageFa: 'این مدل در حال حاضر در دسترس نیست. لطفاً مدل دیگری انتخاب کنید.',
        retryable: false,
        httpStatus: status,
        credentialFailureKind: 'prompt_error',
      });
    }
    if (isAccountQuotaExhaustedSafe(bodyText)) {
      return new AIProviderError({
        code: 'RATE_LIMITED',
        message: `Provider quota exhausted (${status}): ${safeMsg}`,
        userMessageFa: 'سرویس این مدل موقتاً در دسترس نیست. لطفاً لحظاتی دیگر دوباره تلاش کنید یا مدل دیگری انتخاب نمایید.',
        retryable: true,
        httpStatus: status,
        credentialFailureKind: 'quota_exhausted',
      });
    }
    return new AIProviderError({
      code: 'INVALID_PROMPT',
      message: `Provider rejected input (${status}): ${safeMsg}`,
      userMessageFa: 'درخواست ارسال‌شده توسط این مدل پذیرفته نشد. لطفاً متن خود را اصلاح کرده و دوباره تلاش کنید.',
      retryable: false,
      httpStatus: status,
      credentialFailureKind: 'prompt_error',
    });
  }

  return new AIProviderError({
    code: 'PROVIDER_ERROR',
    message: `Provider HTTP ${status}: ${safeMsg}`,
    userMessageFa: 'خطایی در پردازش درخواست رخ داد. اعتبار شما کسر نشد؛ لطفاً دوباره تلاش کنید.',
    retryable: status >= 500 || status === 408,
    httpStatus: status,
    credentialFailureKind: 'transient',
  });
}

function isAccountQuotaExhaustedSafe(text: string): boolean {
  return /insufficient_quota|credit balance is too low|exceeded your monthly included credits|payment required/i.test(
    text,
  );
}

function wrapNetworkError(err: unknown, apiKey: string): AIProviderError {
  if (err instanceof AIProviderError) return err;
  const secrets = apiKey ? [apiKey] : [];
  if (err instanceof SsrfProtectionError) {
    return new AIProviderError({
      code: 'SSRF_BLOCKED',
      message: err.message,
      userMessageFa: 'این مدل در حال حاضر در دسترس نیست. لطفاً مدل دیگری انتخاب کنید.',
      retryable: false,
      credentialFailureKind: 'prompt_error',
    });
  }

  const rawMsg = err instanceof Error ? err.message : String(err ?? 'Network error');
  const msg = redactSecrets(rawMsg, secrets);

  // Inspect structured status from SDK errors (e.g. @google/genai ApiError)
  const errRecord = (typeof err === 'object' && err !== null ? err : {}) as {
    status?: unknown;
    statusCode?: unknown;
  };
  const numericStatus =
    typeof errRecord.status === 'number'
      ? errRecord.status
      : typeof errRecord.statusCode === 'number'
        ? errRecord.statusCode
        : null;

  if (numericStatus && numericStatus >= 400) {
    return classifyHttpError(numericStatus, rawMsg, apiKey);
  }

  if (isInvalidKeySignal(rawMsg)) {
    return new AIProviderError({
      code: 'INVALID_API_KEY',
      message: msg,
      userMessageFa: 'این مدل در حال حاضر در دسترس نیست. لطفاً مدل دیگری انتخاب کنید.',
      retryable: false,
      credentialFailureKind: 'invalid',
    });
  }

  if (isQuotaExhaustedSignal(rawMsg)) {
    return new AIProviderError({
      code: 'RATE_LIMITED',
      message: msg,
      userMessageFa: 'سرویس این مدل موقتاً در دسترس نیست. لطفاً لحظاتی دیگر دوباره تلاش کنید یا مدل دیگری انتخاب نمایید.',
      retryable: true,
      httpStatus: 429,
      credentialFailureKind: 'quota_exhausted',
    });
  }

  if (/\b429\b|too many requests|rate[_\s-]?limit/i.test(rawMsg)) {
    return new AIProviderError({
      code: 'RATE_LIMITED',
      message: msg,
      userMessageFa: 'سرویس این مدل موقتاً شلوغ است. لطفاً لحظاتی دیگر دوباره تلاش کنید.',
      retryable: true,
      httpStatus: 429,
      credentialFailureKind: 'rate_limited',
    });
  }

  if (err instanceof Error && err.name === 'AbortError') {
    return new AIProviderError({
      code: 'TIMEOUT',
      message: `Request aborted or timed out: ${msg}`,
      userMessageFa: 'زمان پاسخ‌گویی به پایان رسید. لطفاً دوباره تلاش کنید.',
      retryable: true,
      credentialFailureKind: 'transient',
    });
  }

  return new AIProviderError({
    code: 'NETWORK_ERROR',
    message: msg,
    userMessageFa: 'خطایی در ارتباط با سرور رخ داد. اعتبار شما بازگردانده شد؛ لطفاً دوباره تلاش کنید.',
    retryable: true,
    credentialFailureKind: 'transient',
  });
}

function assertCapabilitySupported(ctx: ProviderExecutionContext, required: CapabilityType): void {
  if (!ctx.supportedCapabilities.includes(required)) {
    throw new AIProviderError({
      code: 'UNSUPPORTED_CAPABILITY',
      message: `Model ${ctx.modelIdentifier} does not have capability ${required} enabled.`,
      userMessageFa: 'مدل انتخاب‌شده از این قابلیت پشتیبانی نمی‌کند. لطفاً مدل دیگری از منوی مدل‌ها انتخاب کنید.',
      retryable: false,
      credentialFailureKind: 'prompt_error',
    });
  }
}

interface AttemptBudgetStore {
  signal?: AbortSignal;
  deadlineAtMs?: number;
}

const attemptBudgetAls = new AsyncLocalStorage<AttemptBudgetStore>();

export function runWithProviderDeadline<T>(deadlineAtMs: number, fn: () => Promise<T>): Promise<T> {
  const existing = attemptBudgetAls.getStore();
  const effectiveDeadline = existing?.deadlineAtMs
    ? Math.min(existing.deadlineAtMs, deadlineAtMs)
    : deadlineAtMs;
  return attemptBudgetAls.run({ signal: existing?.signal, deadlineAtMs: effectiveDeadline }, fn);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  await assertSafeOutboundUrl(url);
  const store = attemptBudgetAls.getStore();
  const effectiveTimeoutMs =
    typeof store?.deadlineAtMs === 'number'
      ? Math.max(800, Math.min(timeoutMs, store.deadlineAtMs - Date.now()))
      : timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  store?.signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (externalSignal?.aborted || store?.signal?.aborted) {
    controller.abort();
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
    store?.signal?.removeEventListener('abort', onExternalAbort);
  }
}

function buildGeminiHeaders(ctx: ProviderExecutionContext): Record<string, string> {
  return mergeHeaders(
    {
      'Content-Type': 'application/json',
      'x-goog-api-key': ctx.apiKey,
    },
    ctx.additionalHeaders,
  );
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { data?: string; mimeType?: string };
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}

interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

function assertGeminiNotBlocked(resp: GeminiGenerateContentResponse, isImage = false): void {
  const blockReason = resp.promptFeedback?.blockReason;
  const finishReason = resp.candidates?.[0]?.finishReason;
  if (
    blockReason ||
    finishReason === 'SAFETY' ||
    finishReason === 'IMAGE_SAFETY' ||
    finishReason === 'PROHIBITED_CONTENT' ||
    finishReason === 'BLOCKLIST' ||
    finishReason === 'SPII'
  ) {
    throw new AIProviderError({
      code: 'INVALID_PROMPT',
      message: `Gemini blocked content (${blockReason || finishReason})`,
      userMessageFa: isImage
        ? 'درخواست ساخت/ویرایش تصویر به دلیل قوانین ایمنی مدل مسدود شد. لطفاً پرامپت دیگری بنویسید.'
        : 'درخواست شما به دلیل قوانین ایمنی مدل مسدود شد. لطفاً متن خود را اصلاح کنید.',
      retryable: false,
      credentialFailureKind: 'prompt_error',
    });
  }
}

function extractGeminiCandidateText(candidates?: GeminiCandidate[]): string {
  const parts = candidates?.[0]?.content?.parts ?? [];
  const regularText = parts
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text!)
    .join('');
  if (regularText) return regularText;
  return parts
    .filter((p) => typeof p.text === 'string')
    .map((p) => p.text!)
    .join('');
}

function extractGeminiCandidateImages(
  candidates?: GeminiCandidate[],
): Array<{ buffer: Buffer; mimeType: string; extension: string }> {
  const parts = candidates?.[0]?.content?.parts ?? [];
  const nonThoughtImages = parts.filter((p) => !p.thought && p.inlineData?.data);
  const chosenParts = nonThoughtImages.length > 0 ? nonThoughtImages : parts.filter((p) => p.inlineData?.data);

  const images: Array<{ buffer: Buffer; mimeType: string; extension: string }> = [];
  for (const part of chosenParts) {
    const data = part.inlineData?.data;
    if (!data) continue;
    const mime = part.inlineData?.mimeType ?? 'image/png';
    images.push({
      buffer: Buffer.from(data, 'base64'),
      mimeType: mime,
      extension: mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png',
    });
  }
  return images;
}

function pcm16ToWav(pcmBuffer: Buffer, sampleRate = 24000, channels = 1): Buffer {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.byteLength;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

// =============================================================================
// LOAD MODEL + PROVIDER + MULTI-KEY CREDENTIAL POOL (WITH AUTO-SWITCHING)
// =============================================================================

export interface LoadedModelRoute {
  primary: ProviderExecutionContext;
  fallback: ProviderExecutionContext | null;
}

async function loadProviderContextForId(params: {
  providerId: string;
  modelId: string;
  modelName: string;
  modelIdentifier: string;
  modelParameters: Record<string, unknown>;
  capabilities: CapabilityType[];
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  maxInputSize: number;
  maxOutputSize: number;
  throwDetailedOnMissing?: boolean;
}): Promise<ProviderExecutionContext | null> {
  const failOrNull = (errParams: ConstructorParameters<typeof AIProviderError>[0]): null => {
    if (params.throwDetailedOnMissing) {
      throw new AIProviderError(errParams);
    }
    return null;
  };

  const db = getDb();
  const [provider] = await db
    .select()
    .from(aiProviders)
    .where(eq(aiProviders.id, params.providerId))
    .limit(1);

  if (!provider) {
    return failOrNull({
      code: 'PROVIDER_ERROR',
      message: `Provider ${params.providerId} not found in database.`,
      userMessageFa: 'این مدل در حال حاضر در دسترس نیست. لطفاً مدل دیگری انتخاب کنید.',
      retryable: false,
    });
  }

  if (!provider.isActive) {
    return failOrNull({
      code: 'INVALID_API_KEY',
      message: `Provider "${provider.name}" is disabled in admin panel.`,
      userMessageFa: 'این مدل در حال حاضر غیرفعال است. لطفاً مدل دیگری انتخاب کنید.',
      retryable: false,
    });
  }

  const creds = await db
    .select()
    .from(providerCredentials)
    .where(and(eq(providerCredentials.providerId, provider.id), eq(providerCredentials.isActive, true)))
    .orderBy(asc(providerCredentials.priority), asc(providerCredentials.failureCount), desc(providerCredentials.keyVersion));

  const nonDisabledCreds = creds.filter((c) => c.status !== 'disabled');
  const nowMs = Date.now();
  const usableCreds = nonDisabledCreds.filter((c) => {
    if (c.status === 'invalid') return false;
    if (c.cooldownUntil && new Date(c.cooldownUntil).getTime() > nowMs) return false;
    return true;
  });

  // Order healthy 'active' keys ahead of expired-cooldown keys
  usableCreds.sort((a, b) => {
    const aHealthy = a.status === 'active' ? 0 : 1;
    const bHealthy = b.status === 'active' ? 0 : 1;
    if (aHealthy !== bHealthy) return aHealthy - bHealthy;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.keyVersion - a.keyVersion;
  });

  const baseMeta = {
    providerId: provider.id,
    providerName: provider.name,
    providerType: provider.providerType,
    baseUrl: provider.baseUrl,
    organizationId: provider.organizationId,
    additionalHeaders: provider.additionalHeaders ?? {},
    modelId: params.modelId,
    modelName: params.modelName,
    modelIdentifier: params.modelIdentifier,
    modelParameters: params.modelParameters,
    supportedCapabilities: params.capabilities,
    inputPricePerMillion: params.inputPricePerMillion,
    outputPricePerMillion: params.outputPricePerMillion,
    maxInputSize: params.maxInputSize,
    maxOutputSize: params.maxOutputSize,
  };

  const isHfSpaceProvider =
    provider.providerType === 'huggingface_space' ||
    (provider.providerType === 'huggingface' &&
      (isHuggingFaceSpaceUrl(provider.baseUrl) || params.modelIdentifier.includes('::')));

  let candidateCreds = usableCreds;
  const supportsKeylessRuntime =
    isHfSpaceProvider ||
    (provider.providerType === 'cloudflare_workers_ai' && Boolean(getCloudflareAiBinding()));

  // When running natively inside Cloudflare Workers with `env.AI`, prefer keyless native binding immediately
  if (provider.providerType === 'cloudflare_workers_ai' && Boolean(getCloudflareAiBinding())) {
    const nativeCtx: ProviderExecutionContext = {
      ...baseMeta,
      apiKey: '',
      credentialId: null,
    };
    nativeCtx.credentialPool = [nativeCtx];
    return nativeCtx;
  }

  // Recover automatically if active keys exist in DB but were previously poisoned by 403/cooldown
  if (candidateCreds.length === 0) {
    if (nonDisabledCreds.length === 0) {
      if (supportsKeylessRuntime) {
        const anonCtx: ProviderExecutionContext = {
          ...baseMeta,
          apiKey: '',
          credentialId: null,
        };
        anonCtx.credentialPool = [anonCtx];
        return anonCtx;
      }
      return failOrNull({
        code: 'INVALID_API_KEY',
        message:
          creds.length === 0
            ? `Provider "${provider.name}" has no API credentials registered.`
            : `All API credentials for provider "${provider.name}" are disabled.`,
        userMessageFa: 'این مدل در حال حاضر در دسترس نیست. لطفاً مدل دیگری انتخاب کنید.',
        retryable: false,
      });
    }

    // All non-disabled keys are either in cooldown or marked 'invalid' from an earlier error.
    // Allow probing cooldown keys or non-fresh/403-poisoned invalid keys instead of silently deadlocking.
    const recoverableCreds = nonDisabledCreds.filter((c) => {
      if (c.status !== 'invalid') return true;
      const msg = c.lastErrorMessage ?? '';
      const wasFalse403OrModelPoison = /\b403\b|permission_denied|billed users|sufficient permissions|gated/i.test(msg);
      const ageMs = nowMs - new Date(c.updatedAt).getTime();
      return wasFalse403OrModelPoison || ageMs > 90_000;
    });

    if (recoverableCreds.length > 0) {
      recoverableCreds.sort((a, b) => {
        const aInv = a.status === 'invalid' ? 1 : 0;
        const bInv = b.status === 'invalid' ? 1 : 0;
        if (aInv !== bInv) return aInv - bInv;
        const aCool = a.cooldownUntil ? new Date(a.cooldownUntil).getTime() : 0;
        const bCool = b.cooldownUntil ? new Date(b.cooldownUntil).getTime() : 0;
        return aCool - bCool;
      });
      candidateCreds = recoverableCreds;
    } else if (supportsKeylessRuntime) {
      const anonCtx: ProviderExecutionContext = {
        ...baseMeta,
        apiKey: '',
        credentialId: null,
      };
      anonCtx.credentialPool = [anonCtx];
      return anonCtx;
    } else {
      const latestErr = nonDisabledCreds[0]?.lastErrorMessage;
      return failOrNull({
        code: 'INVALID_API_KEY',
        message: latestErr
          ? `All credentials for "${provider.name}" failed: ${latestErr}`
          : `All API credentials for "${provider.name}" are invalid.`,
        userMessageFa: 'این مدل در حال حاضر در دسترس نیست. لطفاً مدل دیگری انتخاب کنید.',
        retryable: false,
      });
    }
  }

  const contexts: ProviderExecutionContext[] = [];
  for (const c of candidateCreds) {
    try {
      const apiKey = decryptSecret({
        ciphertext: c.encryptedApiKey,
        iv: c.iv,
        authTag: c.authTag,
      });
      contexts.push({
        ...baseMeta,
        credentialId: c.id,
        credentialLabel: c.label,
        maskedPreview: c.maskedPreview,
        apiKey,
      });
    } catch {
      // Skip malformed credential if another valid key exists; otherwise report decryption failure clearly
    }
  }

  if (contexts.length === 0) {
    if (supportsKeylessRuntime) {
      const anonCtx: ProviderExecutionContext = {
        ...baseMeta,
        apiKey: '',
        credentialId: null,
        credentialLabel: 'Keyless / Anonymous',
        maskedPreview: 'anonymous',
      };
      anonCtx.credentialPool = [anonCtx];
      return anonCtx;
    }
    return failOrNull({
      code: 'INVALID_API_KEY',
      message: `Failed to decrypt API credentials for provider "${provider.name}".`,
      userMessageFa: 'این مدل در حال حاضر در دسترس نیست. لطفاً مدل دیگری انتخاب کنید.',
      retryable: false,
    });
  }

  if (isHfSpaceProvider) {
    contexts.push({
      ...baseMeta,
      apiKey: '',
      credentialId: null,
      credentialLabel: 'Anonymous HF Fallback',
      maskedPreview: 'anonymous',
    });
  }

  const primary = { ...contexts[0]!, credentialPool: contexts };
  return primary;
}

export interface FailoverSafetyOptions {
  requiredCapability?: CapabilityType;
  allowedProviderIds?: string[];
  allowedModelIds?: string[];
  userPlanTier?: string;
}

export async function loadModelExecutionRoute(
  modelId: string,
  safety?: FailoverSafetyOptions,
): Promise<LoadedModelRoute> {
  const db = getDb();
  const [model] = await db
    .select()
    .from(aiModels)
    .where(and(eq(aiModels.id, modelId), eq(aiModels.isActive, true)))
    .limit(1);

  if (!model) {
    throw new AIProviderError({
      code: 'UNSUPPORTED_CAPABILITY',
      message: 'Selected AI model not found or disabled.',
      userMessageFa: 'مدل انتخاب‌شده یافت نشد یا غیرفعال شده است. لطفاً مدل دیگری انتخاب کنید.',
      retryable: false,
    });
  }

  const capsRows = await db
    .select({ capability: modelCapabilities.capability })
    .from(modelCapabilities)
    .where(eq(modelCapabilities.modelId, model.id));

  const capabilities = capsRows.map((c) => c.capability);

  const primary = await loadProviderContextForId({
    providerId: model.providerId,
    modelId: model.id,
    modelName: model.name,
    modelIdentifier: model.modelIdentifier,
    modelParameters: model.modelParameters ?? {},
    capabilities,
    inputPricePerMillion: Number(model.inputPricePerMillion),
    outputPricePerMillion: Number(model.outputPricePerMillion),
    maxInputSize: model.maxInputSize,
    maxOutputSize: model.maxOutputSize,
    throwDetailedOnMissing: true,
  });

  if (!primary) {
    throw new AIProviderError({
      code: 'INVALID_API_KEY',
      message: 'Primary provider is inactive or missing active API credentials.',
      userMessageFa: 'این مدل در حال حاضر در دسترس نیست. لطفاً مدل دیگری انتخاب کنید.',
      retryable: false,
    });
  }

  let fallback: ProviderExecutionContext | null = null;
  if (model.fallbackProviderId) {
    try {
      const targetIdentifier = model.fallbackModelIdentifier || model.modelIdentifier;
      const primaryCost = Math.max(Number(model.creditCost), Number(model.minCreditCost ?? 0));

      // Check plan provider allowlist if provided
      const providerAllowed =
        !safety?.allowedProviderIds ||
        safety.allowedProviderIds.length === 0 ||
        safety.allowedProviderIds.includes(model.fallbackProviderId);

      // Look up registered fallback model record to verify active status, capability compatibility, and cost safety
      const [registeredFallbackModel] = await db
        .select()
        .from(aiModels)
        .where(
          and(
            eq(aiModels.providerId, model.fallbackProviderId),
            eq(aiModels.modelIdentifier, targetIdentifier),
          ),
        )
        .limit(1);

      let safeToFailover = providerAllowed;
      let fallbackCapabilities = capabilities;

      if (registeredFallbackModel) {
        const fbCost = Math.max(
          Number(registeredFallbackModel.creditCost),
          Number(registeredFallbackModel.minCreditCost ?? 0),
        );
        const fbCapsRows = await db
          .select({ capability: modelCapabilities.capability })
          .from(modelCapabilities)
          .where(eq(modelCapabilities.modelId, registeredFallbackModel.id));
        fallbackCapabilities = fbCapsRows.map((c) => c.capability);

        const capCompatible =
          !safety?.requiredCapability || fallbackCapabilities.includes(safety.requiredCapability);
        const modelAllowed =
          !safety?.allowedModelIds ||
          safety.allowedModelIds.length === 0 ||
          safety.allowedModelIds.includes(registeredFallbackModel.id);
        const tierAllowed =
          !safety?.userPlanTier ||
          !Array.isArray(registeredFallbackModel.allowedPlanTiers) ||
          registeredFallbackModel.allowedPlanTiers.length === 0 ||
          registeredFallbackModel.allowedPlanTiers.includes(safety.userPlanTier);

        // NEVER fail over to a disabled, incompatible, unauthorized, or more expensive model
        if (
          !registeredFallbackModel.isActive ||
          !capCompatible ||
          !modelAllowed ||
          !tierAllowed ||
          fbCost > primaryCost
        ) {
          safeToFailover = false;
        }
      }

      if (safeToFailover) {
        fallback = await loadProviderContextForId({
          providerId: model.fallbackProviderId,
          modelId: registeredFallbackModel?.id ?? model.id,
          modelName: registeredFallbackModel?.name ?? model.name,
          modelIdentifier: targetIdentifier,
          modelParameters: registeredFallbackModel?.modelParameters ?? model.modelParameters ?? {},
          capabilities: fallbackCapabilities,
          inputPricePerMillion: Number(
            registeredFallbackModel?.inputPricePerMillion ?? model.inputPricePerMillion,
          ),
          outputPricePerMillion: Number(
            registeredFallbackModel?.outputPricePerMillion ?? model.outputPricePerMillion,
          ),
          maxInputSize: registeredFallbackModel?.maxInputSize ?? model.maxInputSize,
          maxOutputSize: registeredFallbackModel?.maxOutputSize ?? model.maxOutputSize,
        });
      }
    } catch {
      fallback = null;
    }
  }

  return { primary, fallback };
}

async function markCredentialSuccess(credentialId?: string | null): Promise<void> {
  if (!credentialId) return;
  try {
    const db = getDb();
    const now = new Date();
    await db
      .update(providerCredentials)
      .set({
        status: 'active',
        cooldownUntil: null,
        failureCount: 0,
        lastUsedAt: now,
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: now,
      })
      .where(eq(providerCredentials.id, credentialId));
  } catch {
    // Non-fatal in case a synthetic route without DB credential is tested
  }
}

async function markCredentialFailure(credentialId: string | null | undefined, err: AIProviderError): Promise<void> {
  if (!credentialId) return;
  try {
    const db = getDb();
    const now = new Date();
    const kind: CredentialFailureKind =
      err.credentialFailureKind ??
      (err.code === 'INVALID_API_KEY'
        ? 'invalid'
        : err.code === 'RATE_LIMITED'
          ? 'rate_limited'
          : 'transient');

    let nextStatus = 'active';
    let cooldownUntil: Date | null = null;
    if (kind === 'invalid') {
      nextStatus = 'invalid';
    } else if (kind === 'quota_exhausted') {
      nextStatus = 'quota_exhausted';
      cooldownUntil = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    } else if (kind === 'rate_limited') {
      nextStatus = 'rate_limited';
      cooldownUntil = new Date(Date.now() + 45 * 1000); // 45 seconds
    }

    await db
      .update(providerCredentials)
      .set({
        status: nextStatus,
        cooldownUntil,
        failureCount: sql`${providerCredentials.failureCount} + 1`,
        lastUsedAt: now,
        lastErrorCode: err.code,
        lastErrorMessage: err.message.slice(0, 500),
        updatedAt: now,
      })
      .where(eq(providerCredentials.id, credentialId));
  } catch {
    // Non-fatal
  }
}

function describeCandidateCredential(ctx: ProviderExecutionContext): string {
  const label = ctx.credentialLabel?.trim();
  const masked = ctx.maskedPreview?.trim();
  if (label && masked) return `${label} (${masked})`;
  if (label) return label;
  if (masked) return masked;
  return ctx.apiKey.trim() ? 'key' : 'anonymous';
}

function formatPoolDiagnosticMessage(traces: string[], secrets: string[]): string {
  const joined =
    traces.length === 1
      ? traces[0]!
      : `Failed after ${traces.length} key/attempt(s): ${traces.join(' | ')}`;
  return redactSecrets(joined, secrets);
}

async function tryExecutionPool<T>(
  baseCtx: ProviderExecutionContext,
  executor: (ctx: ProviderExecutionContext) => Promise<T>,
): Promise<T> {
  const pool = baseCtx.credentialPool && baseCtx.credentialPool.length > 0 ? baseCtx.credentialPool : [baseCtx];
  const allSecrets = pool.map((c) => c.apiKey).filter((k) => Boolean(k && k.trim()));
  let lastError: AIProviderError | null = null;
  const attemptTraces: string[] = [];
  const poolStartedAt = Date.now();
  const callerStore = attemptBudgetAls.getStore();
  const isCfRuntime =
    isCloudflareWorker() ||
    Boolean(getCloudflareRequestContext()?.waitUntil) ||
    Boolean(getCloudflareRequestContext()?.childWaitUntilTasks);

  const defaultPoolMaxMs = isCfRuntime ? 23_000 : 75_000;
  const poolDeadlineAtMs =
    typeof callerStore?.deadlineAtMs === 'number'
      ? Math.min(callerStore.deadlineAtMs, poolStartedAt + defaultPoolMaxMs)
      : poolStartedAt + defaultPoolMaxMs;

  for (let idx = 0; idx < pool.length; idx++) {
    const candidate = pool[idx]!;
    const remainingKeys = pool.length - idx;
    const remainingPoolMs = poolDeadlineAtMs - Date.now();
    if (idx > 0 && remainingPoolMs < 2_500) {
      attemptTraces.push(
        `#${idx + 1} [${candidate.providerName} · ${describeCandidateCredential(candidate)}] skipped (pool deadline reached)`,
      );
      break;
    }

    // When backup keys remain, cap each single key attempt so a hung connection cancels quickly and switches to the next key!
    const perKeyCapMs =
      remainingKeys > 1
        ? isCfRuntime
          ? Math.max(5_500, Math.min(10_500, Math.floor(remainingPoolMs / Math.min(remainingKeys, 2))))
          : Math.max(8_000, Math.min(20_000, Math.floor(remainingPoolMs / Math.min(remainingKeys, 2))))
        : Math.max(3_000, remainingPoolMs);

    const attemptDeadlineAtMs = Date.now() + perKeyCapMs;
    const attemptController = new AbortController();
    const onCallerAbort = () => attemptController.abort();
    callerStore?.signal?.addEventListener('abort', onCallerAbort, { once: true });
    if (callerStore?.signal?.aborted) {
      attemptController.abort();
    }
    const attemptTimer = setTimeout(() => attemptController.abort(), perKeyCapMs);
    const attemptStartedAt = Date.now();

    try {
      const candidateCtx: ProviderExecutionContext = {
        ...candidate,
        attemptDeadlineAtMs,
        attemptSignal: attemptController.signal,
      };
      const result = await attemptBudgetAls.run(
        { signal: attemptController.signal, deadlineAtMs: attemptDeadlineAtMs },
        () => executor(candidateCtx),
      );
      await markCredentialSuccess(candidate.credentialId);
      return result;
    } catch (err) {
      const elapsedMs = Date.now() - attemptStartedAt;
      let aiErr = wrapNetworkError(err, candidate.apiKey);
      if (attemptController.signal.aborted && !callerStore?.signal?.aborted && aiErr.code !== 'TIMEOUT') {
        aiErr = new AIProviderError({
          code: 'TIMEOUT',
          message: `Attempt timed out after ${elapsedMs}ms (limit ${perKeyCapMs}ms)`,
          userMessageFa: aiErr.userMessageFa,
          retryable: true,
          httpStatus: 408,
          credentialFailureKind: 'transient',
        });
      }
      lastError = aiErr;
      const statusPart = aiErr.httpStatus ? ` HTTP ${aiErr.httpStatus}` : '';
      const cleanReason = redactSecrets(aiErr.message.replace(/\s+/g, ' ').slice(0, 420), allSecrets);
      attemptTraces.push(
        `#${idx + 1} [${candidate.providerName} · ${describeCandidateCredential(candidate)} · ${aiErr.code}${statusPart} · ${elapsedMs}ms]: ${cleanReason}`,
      );

      // Never rotate API keys for user input validation, cancelation, or missing capabilities
      if (
        aiErr.code === 'CANCELED' ||
        aiErr.code === 'UNSUPPORTED_CAPABILITY' ||
        aiErr.code === 'SSRF_BLOCKED' ||
        aiErr.credentialFailureKind === 'prompt_error'
      ) {
        throw new AIProviderError({
          code: aiErr.code,
          message: formatPoolDiagnosticMessage(attemptTraces, allSecrets),
          userMessageFa: aiErr.userMessageFa,
          retryable: aiErr.retryable,
          httpStatus: aiErr.httpStatus,
          credentialFailureKind: aiErr.credentialFailureKind,
        });
      }
      await markCredentialFailure(candidate.credentialId, aiErr);
    } finally {
      clearTimeout(attemptTimer);
      callerStore?.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  if (lastError) {
    throw new AIProviderError({
      code: lastError.code,
      message: formatPoolDiagnosticMessage(attemptTraces, allSecrets),
      userMessageFa: lastError.userMessageFa,
      retryable: lastError.retryable,
      httpStatus: lastError.httpStatus,
      credentialFailureKind: lastError.credentialFailureKind,
    });
  }

  throw new AIProviderError({
    code: 'PROVIDER_ERROR',
    message: 'All active credentials for provider failed.',
    userMessageFa: 'سرویس این مدل موقتاً در دسترس نیست. لطفاً لحظاتی دیگر دوباره تلاش کنید یا مدل دیگری انتخاب نمایید.',
  });
}

async function runWithFailover<T>(
  route: LoadedModelRoute,
  executor: (ctx: ProviderExecutionContext) => Promise<T>,
): Promise<{ result: T; usedFallback: boolean; providerId: string }> {
  try {
    const result = await tryExecutionPool(route.primary, executor);
    return { result, usedFallback: false, providerId: route.primary.providerId };
  } catch (err) {
    const aiErr = wrapNetworkError(err, route.primary.apiKey);
    if (
      aiErr.code === 'CANCELED' ||
      aiErr.code === 'UNSUPPORTED_CAPABILITY' ||
      aiErr.code === 'SSRF_BLOCKED' ||
      aiErr.credentialFailureKind === 'prompt_error'
    ) {
      throw aiErr;
    }
    if (
      route.fallback &&
      (aiErr.retryable ||
        aiErr.code === 'INVALID_API_KEY' ||
        aiErr.code === 'PROVIDER_ERROR' ||
        aiErr.code === 'RATE_LIMITED')
    ) {
      try {
        const result = await tryExecutionPool(route.fallback, executor);
        return { result, usedFallback: true, providerId: route.fallback.providerId };
      } catch (fbErr) {
        const fbAiErr = wrapNetworkError(fbErr, route.fallback.apiKey);
        throw new AIProviderError({
          code: fbAiErr.code,
          message: redactSecrets(
            `Primary failed -> ${aiErr.message} || Fallback failed -> ${fbAiErr.message}`,
            [route.primary.apiKey, route.fallback.apiKey].filter(Boolean),
          ),
          userMessageFa: fbAiErr.userMessageFa,
          retryable: fbAiErr.retryable,
          httpStatus: fbAiErr.httpStatus,
          credentialFailureKind: fbAiErr.credentialFailureKind,
        });
      }
    }
    throw aiErr;
  }
}

// =============================================================================
// UNIVERSAL HUGGING FACE SPACE EXECUTION ENGINE (Gradio 4/5 + ZeroGPU + OpenAI)
// =============================================================================

export interface GradioFileData {
  path?: string;
  url?: string;
  orig_name?: string;
  size?: number;
  mime_type?: string;
  is_stream?: boolean;
  meta: { _type: 'gradio.FileData' };
}

type GradioPreferredKind =
  | 'text'
  | 'vision'
  | 'image_generate'
  | 'image_edit'
  | 'video_t2v'
  | 'video_i2v'
  | 'tts'
  | 'stt';

interface StoredGradioParamSpec {
  index?: number;
  name?: string;
  label?: string;
  component?: string;
  hasDefault?: boolean;
  defaultValue?: unknown;
  enum?: unknown[];
  min?: number;
  max?: number;
  pythonType?: string;
  schemaType?: string;
  isImageEditor?: boolean;
  isMultimodalTextbox?: boolean;
  isChatbotMessages?: boolean;
  isFileList?: boolean;
}

function createHfDeadline(mode: 'sync' | 'video_poll', ctx?: ProviderExecutionContext): number {
  const cfCtx = getCloudflareRequestContext();
  const isCfRuntime = isCloudflareWorker() || Boolean(cfCtx?.waitUntil) || Boolean(cfCtx?.childWaitUntilTasks);
  const storeDeadline = attemptBudgetAls.getStore()?.deadlineAtMs;
  const ctxDeadline = ctx?.attemptDeadlineAtMs;

  const baseMs =
    mode === 'video_poll'
      ? isCfRuntime
        ? 17_000
        : 28_000
      : isCfRuntime
        ? 18_500
        : 70_000;

  let deadline = Date.now() + baseMs;
  if (typeof ctxDeadline === 'number') deadline = Math.min(deadline, ctxDeadline);
  if (typeof storeDeadline === 'number') deadline = Math.min(deadline, storeDeadline);
  return Math.max(Date.now() + 2_000, deadline);
}

function getRemainingBudgetMs(deadlineAtMs: number | undefined, fallbackMs: number, minMs = 1500): number {
  if (typeof deadlineAtMs !== 'number') return fallbackMs;
  return Math.max(minMs, Math.min(fallbackMs, deadlineAtMs - Date.now()));
}

function safeParseJsonText(rawText: string): unknown {
  const trimmed = rawText.trim();
  if (!trimmed || trimmed.startsWith('<')) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function isGradioFileDataObject(val: unknown): boolean {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
  const obj = val as Record<string, unknown>;
  const meta = obj.meta as Record<string, unknown> | undefined;
  return meta?._type === 'gradio.FileData' || (typeof obj.path === 'string' && typeof obj.url === 'string');
}

function extractTextFromGradioContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part);
      } else if (part && typeof part === 'object') {
        const obj = part as Record<string, unknown>;
        if (typeof obj.text === 'string') parts.push(obj.text);
        else if (typeof obj.content === 'string') parts.push(obj.content);
      }
    }
    return parts.filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.value === 'string') return obj.value;
    if (typeof obj.content === 'string') return obj.content;
  }
  return '';
}

export function extractGradioOutputText(val: unknown): string {
  if (typeof val === 'string') return val.trim();
  if (val === null || val === undefined || typeof val === 'boolean' || typeof val === 'number') {
    return '';
  }

  if (Array.isArray(val)) {
    if (val.length === 0) return '';

    // 1. Gradio 5 Chatbot `messages` format: [{ role: 'user'|'assistant', content: ... }]
    const isMessagesList = val.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        typeof (item as Record<string, unknown>).role === 'string' &&
        'content' in (item as Record<string, unknown>),
    );
    if (isMessagesList) {
      for (let i = val.length - 1; i >= 0; i--) {
        const msg = val[i] as Record<string, unknown>;
        if (msg.role === 'assistant' || msg.role === 'model' || msg.role === 'bot') {
          const text = extractTextFromGradioContent(msg.content).trim();
          if (text) return text;
        }
      }
      const last = val[val.length - 1] as Record<string, unknown>;
      return extractTextFromGradioContent(last.content).trim();
    }

    // 2. Gradio 4 Chatbot tuple history format: [[userMsg, assistantMsg], ...]
    const isTupleTurnLeaf = (x: unknown): boolean =>
      x === null || x === undefined || typeof x === 'string' || (typeof x === 'object' && !Array.isArray(x));
    const isTupleHistory = val.every(
      (item) =>
        Array.isArray(item) &&
        item.length === 2 &&
        isTupleTurnLeaf(item[0]) &&
        isTupleTurnLeaf(item[1]),
    );
    if (isTupleHistory) {
      for (let i = val.length - 1; i >= 0; i--) {
        const pair = val[i] as [unknown, unknown];
        const assistantPart = extractTextFromGradioContent(pair[1]).trim();
        if (assistantPart) return assistantPart;
      }
      const lastPair = val[val.length - 1] as [unknown, unknown];
      return extractTextFromGradioContent(lastPair[0]).trim();
    }

    // 3. Multi-output endpoint array (e.g. [chatbotOutput, textboxState] or [text, metadata])
    const candidates: string[] = [];
    for (const item of val) {
      if (isGradioFileDataObject(item)) continue;
      const extracted = extractGradioOutputText(item);
      if (extracted) candidates.push(extracted);
    }
    if (candidates.length === 0) return '';
    // Prefer the first substantive non-empty candidate (usually primary output slot 0),
    // unless slot 0 is a tiny status token and a later slot holds the real reply.
    return candidates[0]!;
  }

  if (typeof val === 'object') {
    if (isGradioFileDataObject(val)) return '';
    const obj = val as Record<string, unknown>;
    if (obj.__type__ === 'update') {
      return obj.value !== undefined ? extractGradioOutputText(obj.value) : '';
    }
    if (typeof obj.text === 'string' && obj.text.trim()) return obj.text.trim();
    if (typeof obj.content === 'string' && obj.content.trim()) return obj.content.trim();
    if (typeof obj.value === 'string' && obj.value.trim()) return obj.value.trim();
    if (obj.value !== undefined && obj.value !== null) {
      return extractGradioOutputText(obj.value);
    }
  }
  return '';
}

function isGradioUiHelperName(apiName: string): boolean {
  const lower = apiName.replace(/^\/+/, '').trim().toLowerCase();
  if (!lower || lower.startsWith('gradio_') || lower.startsWith('_')) return true;
  if (
    /^(update|change|toggle|show|hide|switch|select|on_|handle_|reset|clear|refresh|load_preset|set_|check_login|lambda|get_example|populate|sync_ui|preview_)/i.test(
      lower,
    )
  ) {
    return true;
  }
  return /(_ui|_visibility|_selection|_dropdown|_slider|_preset|_tab|_panel|_state|_change|_click)$/i.test(lower);
}

type ExpectedGradioMediaKind = 'image' | 'video' | 'audio';

function detectMediaKindFromUrlOrMime(urlOrPath: string, mimeType?: string): ExpectedGradioMediaKind | null {
  const m = (mimeType ?? '').toLowerCase();
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('image/')) return 'image';

  const clean = urlOrPath.split('?')[0]?.split('#')[0]?.toLowerCase() ?? '';
  if (clean.startsWith('data:video/')) return 'video';
  if (clean.startsWith('data:audio/')) return 'audio';
  if (clean.startsWith('data:image/')) return 'image';
  if (/\.(mp4|webm|mov|mkv|avi|m4v)$/.test(clean)) return 'video';
  if (/\.(mp3|wav|ogg|flac|m4a|aac|opus)$/.test(clean)) return 'audio';
  if (/\.(png|jpe?g|webp|gif|bmp|avif)$/.test(clean)) return 'image';
  return null;
}

function looksLikeStrictMediaString(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (/^data:(image|video|audio)\//i.test(trimmed)) return true;
  if (trimmed.includes('/file=') || trimmed.startsWith('/gradio_api/file=') || trimmed.startsWith('/tmp/')) {
    return true;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return detectMediaKindFromUrlOrMime(trimmed) !== null || /\/(file=|gradio_api|media|download|output)/i.test(trimmed);
  }
  return detectMediaKindFromUrlOrMime(trimmed) !== null;
}

export function extractGradioMediaUrl(
  val: unknown,
  spaceHost: string,
  expectedKind?: ExpectedGradioMediaKind,
  endpointPrefix = '/gradio_api',
): string | null {
  const cleanHost = normalizeBaseUrl(spaceHost);
  const normalizedPrefix = endpointPrefix === '' ? '' : `/${endpointPrefix.replace(/^\/+|\/+$/g, '')}`;

  const resolvePath = (p: string): string => {
    if (p.startsWith('http://') || p.startsWith('https://') || p.startsWith('data:')) return p;
    if (p.startsWith('/gradio_api/')) return `${cleanHost}${p}`;
    if (p.startsWith('/file=')) return `${cleanHost}${normalizedPrefix}${p}`;
    return `${cleanHost}${normalizedPrefix}/file=${p}`;
  };

  interface MediaCandidate {
    url: string;
    score: number;
    kind: ExpectedGradioMediaKind | null;
  }

  const candidates: MediaCandidate[] = [];

  const collect = (node: unknown, inheritedHint: ExpectedGradioMediaKind | null, depth: number): void => {
    if (depth > 8 || node === null || node === undefined) return;

    if (typeof node === 'string') {
      const trimmed = node.trim();
      if (!looksLikeStrictMediaString(trimmed)) return;
      const detected = detectMediaKindFromUrlOrMime(trimmed) ?? inheritedHint;
      const resolved = resolvePath(trimmed);
      let score = 10;
      if (expectedKind && detected === expectedKind) score += 30;
      else if (expectedKind && detected && detected !== expectedKind) score -= 20;
      candidates.push({ url: resolved, score, kind: detected });
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        collect(item, inheritedHint, depth + 1);
      }
      return;
    }

    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if (
        obj.__type__ === 'update' &&
        !obj.url &&
        !obj.path &&
        !obj.value &&
        !obj.image &&
        !obj.video &&
        !obj.audio
      ) {
        return;
      }

      const mimeType = typeof obj.mime_type === 'string' ? obj.mime_type : undefined;
      const directUrl = typeof obj.url === 'string' && obj.url.trim() ? obj.url.trim() : null;
      const directPath = typeof obj.path === 'string' && obj.path.trim() ? obj.path.trim() : null;

      if (directUrl || directPath) {
        const chosen = directUrl ?? directPath!;
        const detected =
          detectMediaKindFromUrlOrMime(chosen, mimeType) ??
          (directPath ? detectMediaKindFromUrlOrMime(directPath, mimeType) : null) ??
          inheritedHint;
        let score = 50; // Structured Gradio FileData objects always outrank raw strings
        if (directUrl) score += 5;
        if (expectedKind && detected === expectedKind) score += 40;
        else if (expectedKind && detected && detected !== expectedKind) score -= 30;
        candidates.push({ url: resolvePath(chosen), score, kind: detected });
      }

      if (obj.video) collect(obj.video, 'video', depth + 1);
      if (obj.audio) collect(obj.audio, 'audio', depth + 1);
      if (obj.image) collect(obj.image, 'image', depth + 1);
      if (obj.composite) collect(obj.composite, 'image', depth + 1);
      if (obj.background) collect(obj.background, 'image', depth + 1);
      if (obj.value) collect(obj.value, inheritedHint, depth + 1);
    }
  };

  collect(val, null, 0);
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!.url;
}

function isHuggingFaceSpaceContext(
  ctx: Pick<ProviderExecutionContext, 'providerType' | 'baseUrl' | 'modelIdentifier'>,
): boolean {
  if (ctx.providerType === 'huggingface_space') return true;
  if (ctx.providerType === 'huggingface') {
    return isHuggingFaceSpaceUrl(ctx.baseUrl) || ctx.modelIdentifier.includes('::');
  }
  return false;
}

function isDirectGradioHostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith('.hf.space') || !parsed.hostname.includes('huggingface.co');
  } catch {
    return false;
  }
}

function serializeResolvedGradioParam(
  p: {
    label?: string;
    parameter_name?: string;
    type?: { type?: string; enum?: unknown[]; minimum?: number; maximum?: number };
    python_type?: { type?: string };
    component?: string;
    parameter_has_default?: boolean;
    parameter_default?: unknown;
  },
  idx: number,
): StoredGradioParamSpec {
  const comp = (p.component || p.type?.type || 'textbox').toLowerCase();
  const pyType = String(p.python_type?.type ?? '').toLowerCase();
  const schemaType = String(p.type?.type ?? '').toLowerCase();
  const labelText = `${p.parameter_name || ''} ${p.label || ''}`.toLowerCase();
  const isImageEditor = /imageeditor|paint|sketchpad|inpaint/.test(comp) || pyType.includes('editordata');
  const isMultimodalTextbox = comp.includes('multimodal') || pyType.includes('multimodal');
  const isChatbotMessages =
    (comp.includes('chatbot') || labelText.includes('history')) &&
    (pyType.includes('role') ||
      pyType.includes('chatmessage') ||
      pyType.includes('dict[str') ||
      pyType.includes('messagedict'));
  const isFileList =
    comp === 'files' ||
    comp.includes('gallery') ||
    ((comp.includes('file') || comp.includes('image')) &&
      (schemaType === 'array' || pyType.includes('list[')));

  return {
    index: idx,
    name: p.parameter_name || p.label || `arg_${idx}`,
    label: p.label || p.parameter_name || `arg_${idx}`,
    component: comp,
    hasDefault: Boolean(p.parameter_has_default),
    defaultValue: p.parameter_default ?? null,
    ...(Array.isArray(p.type?.enum) ? { enum: p.type.enum } : {}),
    ...(typeof p.type?.minimum === 'number' ? { min: p.type.minimum } : {}),
    ...(typeof p.type?.maximum === 'number' ? { max: p.type.maximum } : {}),
    ...(pyType ? { pythonType: pyType } : {}),
    ...(schemaType ? { schemaType } : {}),
    ...(isImageEditor ? { isImageEditor: true } : {}),
    ...(isMultimodalTextbox ? { isMultimodalTextbox: true } : {}),
    ...(isChatbotMessages ? { isChatbotMessages: true } : {}),
    ...(isFileList ? { isFileList: true } : {}),
  };
}

function gradioParamsHaveMediaInput(
  params: Array<{
    component?: string;
    label?: string;
    name?: string;
    parameter_name?: string;
    isImageEditor?: boolean;
    isMultimodalTextbox?: boolean;
    isFileList?: boolean;
  }>,
  mediaKind: 'image' | 'audio' | 'any',
): boolean {
  return params.some((p) => {
    const comp = String(p.component ?? '').toLowerCase();
    const label = String(p.label ?? p.name ?? p.parameter_name ?? '').toLowerCase();
    if (p.isMultimodalTextbox) return true;
    if (mediaKind === 'audio') {
      return comp.includes('audio') || comp.includes('file') || /audio|speech|voice|sound/.test(label);
    }
    return (
      Boolean(p.isImageEditor) ||
      Boolean(p.isFileList) ||
      comp.includes('image') ||
      comp.includes('paint') ||
      comp.includes('sketch') ||
      comp.includes('gallery') ||
      comp.includes('file')
    );
  });
}

function scoreGradioEndpointForKind(
  apiName: string,
  params: Array<{ component?: string; label?: string; parameter_name?: string; type?: { type?: string } }>,
  returns: Array<{ component?: string; label?: string; type?: { type?: string } }>,
  preferredKind?: GradioPreferredKind,
): number {
  const lower = apiName.replace(/^\/+/, '').toLowerCase();
  const inStr = params.map((p) => `${p.component ?? ''} ${p.label ?? ''} ${p.parameter_name ?? ''}`).join(' ').toLowerCase();
  const outStr = returns.map((r) => `${r.component ?? ''} ${r.label ?? ''}`).join(' ').toLowerCase();
  const hasImageIn = gradioParamsHaveMediaInput(params, 'image');
  const hasAudioIn = gradioParamsHaveMediaInput(params, 'audio');

  let score = 0;
  if (/^(generate|infer|predict|run|chat|respond|synthesize|transcribe)/.test(lower)) score += 10;

  switch (preferredKind) {
    case 'image_edit':
      if (outStr.includes('image') || outStr.includes('gallery')) score += 20;
      if (hasImageIn) score += 35;
      else score -= 55;
      if (/edit|img2img|inpaint|transform|variation|upscale/.test(lower)) score += 25;
      break;
    case 'image_generate':
      if (outStr.includes('image') || outStr.includes('gallery')) score += 25;
      if (/txt2img|text_to_image|generate|infer/.test(lower)) score += 15;
      if (/edit|img2img|inpaint/.test(lower) && !/txt2img|generate/.test(lower)) score -= 10;
      break;
    case 'video_i2v':
      if (outStr.includes('video')) score += 30;
      if (hasImageIn) score += 30;
      else score -= 45;
      if (/i2v|img2vid|image_to_video/.test(lower)) score += 25;
      break;
    case 'video_t2v':
      if (outStr.includes('video')) score += 30;
      if (/t2v|txt2vid|text_to_video|generate/.test(lower)) score += 20;
      break;
    case 'tts':
      if (outStr.includes('audio')) score += 35;
      if (/tts|speak|synth|voice|speech/.test(lower)) score += 20;
      break;
    case 'stt':
      if (hasAudioIn) score += 35;
      else score -= 40;
      if (/stt|transcribe|whisper|asr/.test(lower)) score += 20;
      break;
    case 'vision':
      if (hasImageIn && !outStr.includes('image') && !outStr.includes('video')) score += 30;
      break;
    case 'text':
      if (!outStr.includes('image') && !outStr.includes('video') && !outStr.includes('audio')) score += 20;
      if (/chat|respond|bot|predict|generate/.test(lower)) score += 15;
      break;
  }
  return score;
}

async function resolveGradioContext(
  ctx: ProviderExecutionContext,
  signal?: AbortSignal,
  options?: { forceRefresh?: boolean; preferredKind?: GradioPreferredKind; deadlineAtMs?: number },
): Promise<ProviderExecutionContext> {
  if (ctx.modelParameters?.openAiCompatible === true) {
    return ctx;
  }

  const rawApiName = (
    typeof ctx.modelParameters?.apiName === 'string'
      ? ctx.modelParameters.apiName
      : ctx.modelIdentifier.split('::')[1] || 'predict'
  ).replace(/^\/+/, '');
  const isStaleUiHelper = isGradioUiHelperName(rawApiName);

  const rawParams = Array.isArray(ctx.modelParameters?.parameters)
    ? (ctx.modelParameters.parameters as StoredGradioParamSpec[])
    : [];
  const hasParams = rawParams.length > 0;
  const paramSpaceHost =
    typeof ctx.modelParameters?.spaceHost === 'string' ? ctx.modelParameters.spaceHost.trim() : '';
  const hasValidSpaceHost = Boolean(paramSpaceHost) && isDirectGradioHostUrl(paramSpaceHost);

  const hasDropdownOrRadio = rawParams.some((p) =>
    /dropdown|radio/i.test(String(p.component ?? '')),
  );
  const hasEnumMetadata =
    !hasDropdownOrRadio ||
    rawParams.some((p) => Array.isArray(p.enum) && p.enum.length > 0);

  const requiredMediaKind: 'image' | 'audio' | null =
    options?.preferredKind === 'image_edit' ||
    options?.preferredKind === 'video_i2v' ||
    options?.preferredKind === 'vision'
      ? 'image'
      : options?.preferredKind === 'stt'
        ? 'audio'
        : null;
  const hasRequiredMediaSlot =
    !requiredMediaKind || gradioParamsHaveMediaInput(rawParams, requiredMediaKind);

  if (
    !options?.forceRefresh &&
    hasParams &&
    hasValidSpaceHost &&
    hasEnumMetadata &&
    !isStaleUiHelper &&
    hasRequiredMediaSlot
  ) {
    return ctx;
  }

  const spaceHost = hasValidSpaceHost
    ? normalizeBaseUrl(paramSpaceHost)
    : (await resolveHfSpaceRootUrl(ctx.baseUrl, ctx.apiKey, ctx.additionalHeaders)).resolvedRootUrl;

  if (!options?.forceRefresh && hasParams && hasEnumMetadata && !isStaleUiHelper && hasRequiredMediaSlot) {
    return {
      ...ctx,
      modelParameters: { ...(ctx.modelParameters ?? {}), spaceHost },
    };
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (ctx.apiKey.trim()) headers.Authorization = `Bearer ${ctx.apiKey.trim()}`;
  const merged = mergeHeaders(headers, ctx.additionalHeaders);

  for (const candidate of [
    { path: '/gradio_api/info', prefix: '/gradio_api' },
    { path: '/info', prefix: '' },
  ]) {
    try {
      const res = await fetchWithTimeout(
        `${spaceHost}${candidate.path}`,
        { method: 'GET', headers: merged },
        getRemainingBudgetMs(options?.deadlineAtMs, 7500),
        signal,
      );
      if (!res.ok) continue;
      const rawText = await res.text();
      const parsedInfo = safeParseJsonText(rawText) as {
        named_endpoints?: Record<
          string,
          {
            parameters?: Array<{
              label?: string;
              parameter_name?: string;
              type?: { type?: string; enum?: unknown[]; minimum?: number; maximum?: number };
              python_type?: { type?: string };
              component?: string;
              parameter_has_default?: boolean;
              parameter_default?: unknown;
            }>;
            returns?: Array<{ label?: string; component?: string; type?: { type?: string } }>;
          }
        >;
        unnamed_endpoints?: Record<
          string,
          {
            parameters?: Array<{
              label?: string;
              parameter_name?: string;
              type?: { type?: string; enum?: unknown[]; minimum?: number; maximum?: number };
              python_type?: { type?: string };
              component?: string;
              parameter_has_default?: boolean;
              parameter_default?: unknown;
            }>;
            returns?: Array<{ label?: string; component?: string; type?: { type?: string } }>;
          }
        >;
      } | null;

      if (!parsedInfo || typeof parsedInfo !== 'object') continue;
      const endpoints = parsedInfo.named_endpoints ?? {};
      const realEntries = Object.entries(endpoints).filter(([k, v]) => {
        const clean = k.replace(/^\/+/, '');
        return !isGradioUiHelperName(clean) && ((v.parameters?.length ?? 0) > 0 || (v.returns?.length ?? 0) > 0);
      });

      let matchedKey = rawApiName;
      let matchedFnIndex: number | undefined =
        typeof ctx.modelParameters?.fnIndex === 'number' ? ctx.modelParameters.fnIndex : undefined;
      const candidateRawEntry = !isStaleUiHelper ? (endpoints[`/${rawApiName}`] ?? endpoints[rawApiName]) : undefined;
      let entry =
        candidateRawEntry &&
        (!requiredMediaKind ||
          gradioParamsHaveMediaInput(candidateRawEntry.parameters ?? [], requiredMediaKind))
          ? candidateRawEntry
          : undefined;

      if (!entry && realEntries.length > 0) {
        const ranked = [...realEntries].sort(
          (a, b) =>
            scoreGradioEndpointForKind(b[0], b[1].parameters ?? [], b[1].returns ?? [], options?.preferredKind) -
            scoreGradioEndpointForKind(a[0], a[1].parameters ?? [], a[1].returns ?? [], options?.preferredKind),
        );
        const best = ranked[0];
        if (best) {
          matchedKey = best[0].replace(/^\/+/, '');
          entry = best[1];
          matchedFnIndex = undefined;
        }
      }

      // Check unnamed_endpoints if named_endpoints has no usable match
      if (!entry && parsedInfo.unnamed_endpoints) {
        const unnamedEntries = Object.entries(parsedInfo.unnamed_endpoints).filter(
          ([, v]) => (v.parameters?.length ?? 0) > 0,
        );
        if (unnamedEntries.length > 0) {
          const directUnnamed =
            matchedFnIndex !== undefined ? parsedInfo.unnamed_endpoints[String(matchedFnIndex)] : undefined;
          if (directUnnamed) {
            entry = directUnnamed;
          } else {
            const rankedUnnamed = [...unnamedEntries].sort(
              (a, b) =>
                scoreGradioEndpointForKind(b[0], b[1].parameters ?? [], b[1].returns ?? [], options?.preferredKind) -
                scoreGradioEndpointForKind(a[0], a[1].parameters ?? [], a[1].returns ?? [], options?.preferredKind),
            );
            const best = rankedUnnamed[0];
            if (best) {
              const idxNum = Number.parseInt(best[0], 10);
              matchedKey = `fn_${best[0]}`;
              matchedFnIndex = Number.isFinite(idxNum) ? idxNum : 0;
              entry = best[1];
            }
          }
        }
      }

      if (entry?.parameters && entry.parameters.length > 0) {
        return {
          ...ctx,
          modelParameters: {
            ...(ctx.modelParameters ?? {}),
            spaceHost,
            apiName: matchedKey,
            endpointPrefix: candidate.prefix,
            ...(typeof matchedFnIndex === 'number' ? { fnIndex: matchedFnIndex } : {}),
            parameters: entry.parameters.map(serializeResolvedGradioParam),
          },
        };
      }
    } catch {
      // try next info endpoint
    }
  }

  return {
    ...ctx,
    modelParameters: { ...(ctx.modelParameters ?? {}), spaceHost },
  };
}

async function uploadMediaToGradioSpace(
  ctx: ProviderExecutionContext,
  buffer: Buffer,
  mimeType: string,
  fileName: string,
  signal?: AbortSignal,
  deadlineAtMs?: number,
): Promise<GradioFileData> {
  const spaceHost =
    typeof ctx.modelParameters?.spaceHost === 'string' && ctx.modelParameters.spaceHost
      ? normalizeBaseUrl(ctx.modelParameters.spaceHost)
      : (await resolveHfSpaceRootUrl(ctx.baseUrl, ctx.apiKey, ctx.additionalHeaders)).resolvedRootUrl;
  const prefix =
    typeof ctx.modelParameters?.endpointPrefix === 'string'
      ? ctx.modelParameters.endpointPrefix
      : '/gradio_api';

  const headers: Record<string, string> = {};
  if (ctx.apiKey.trim()) headers.Authorization = `Bearer ${ctx.apiKey.trim()}`;
  const mergedHeaders = mergeHeaders(headers, ctx.additionalHeaders);

  const normalizedPrefix = prefix === '' ? '' : `/${prefix.replace(/^\/+|\/+$/g, '')}`;
  const uploadCandidates = Array.from(
    new Set([`${spaceHost}${normalizedPrefix}/upload`, `${spaceHost}/upload`]),
  );

  for (const uploadUrl of uploadCandidates) {
    try {
      const form = new FormData();
      form.append('files', new Blob([new Uint8Array(buffer)], { type: mimeType }), fileName);
      const res = await fetchWithTimeout(
        uploadUrl,
        { method: 'POST', headers: mergedHeaders, body: form },
        getRemainingBudgetMs(deadlineAtMs, 14_000),
        signal,
      );
      if (!res.ok) continue;
      const uploaded = safeParseJsonText(await res.text());
      if (Array.isArray(uploaded) && typeof uploaded[0] === 'string' && uploaded[0].trim()) {
        const uploadedPath = uploaded[0].trim();
        return {
          path: uploadedPath,
          url: `${spaceHost}${normalizedPrefix}/file=${uploadedPath}`,
          orig_name: fileName,
          size: buffer.byteLength,
          mime_type: mimeType,
          is_stream: false,
          meta: { _type: 'gradio.FileData' },
        };
      }
    } catch {
      // fall through to next upload path or data URI fallback
    }
  }

  return {
    url: `data:${mimeType};base64,${buffer.toString('base64')}`,
    orig_name: fileName,
    size: buffer.byteLength,
    mime_type: mimeType,
    is_stream: false,
    meta: { _type: 'gradio.FileData' },
  };
}

function mapAspectRatioToDimensions(aspectRatio?: string): { width: number; height: number } {
  switch (aspectRatio) {
    case '16:9':
      return { width: 1024, height: 576 };
    case '9:16':
      return { width: 576, height: 1024 };
    case '4:3':
      return { width: 1024, height: 768 };
    case '3:4':
      return { width: 768, height: 1024 };
    default:
      return { width: 1024, height: 1024 };
  }
}

function clampNumericToSpec(val: number, spec: StoredGradioParamSpec): number {
  let out = val;
  if (typeof spec.min === 'number') out = Math.max(spec.min, out);
  if (typeof spec.max === 'number') out = Math.min(spec.max, out);
  return out;
}

function matchLanguageChoice(enumValues: unknown[], language?: string): unknown {
  if (!language) return undefined;
  const code = language.trim().toLowerCase();
  const aliases: Record<string, string[]> = {
    fa: ['fa', 'persian', 'farsi', 'فارسی'],
    en: ['en', 'english', 'en-us', 'en-gb'],
    ar: ['ar', 'arabic', 'عربی'],
    tr: ['tr', 'turkish'],
    de: ['de', 'german'],
    fr: ['fr', 'french'],
    es: ['es', 'spanish'],
    ru: ['ru', 'russian'],
    zh: ['zh', 'chinese', 'mandarin'],
    ja: ['ja', 'japanese'],
    ko: ['ko', 'korean'],
  };
  const targets = aliases[code] ?? [code];
  return enumValues.find((v) => {
    if (typeof v !== 'string') return false;
    const low = v.trim().toLowerCase();
    return targets.some((t) => low === t || low.includes(t));
  });
}

function pairGradio4TupleHistory(history?: Array<{ role: string; content: string }>): Array<[string | null, string | null]> {
  if (!history || history.length === 0) return [];
  const pairs: Array<[string | null, string | null]> = [];
  for (const msg of history) {
    if (msg.role === 'system') continue;
    if (msg.role === 'user') {
      pairs.push([msg.content, null]);
    } else if (msg.role === 'assistant') {
      const last = pairs[pairs.length - 1];
      if (last && last[1] === null) {
        last[1] = msg.content;
      } else {
        pairs.push([null, msg.content]);
      }
    }
  }
  return pairs;
}

export function buildGradioInputPayload(
  ctx: ProviderExecutionContext,
  promptText: string,
  systemPrompt?: string,
  history?: Array<{ role: string; content: string }>,
  mediaInput?: string | GradioFileData,
  options?: {
    aspectRatio?: string;
    mode?: 'generate' | 'edit' | 'variation' | 't2v' | 'i2v' | 'text' | 'vision' | 'tts' | 'stt';
    durationSeconds?: number;
    voice?: string;
    language?: string;
    mediaKind?: 'image' | 'audio' | 'video';
    chatHistoryFormat?: 'auto' | 'messages' | 'tuples';
  },
): unknown[] {
  const paramSpecs = Array.isArray(ctx.modelParameters?.parameters)
    ? (ctx.modelParameters.parameters as StoredGradioParamSpec[])
    : null;

  const mediaPayload: GradioFileData | undefined =
    typeof mediaInput === 'string'
      ? { url: mediaInput, is_stream: false, meta: { _type: 'gradio.FileData' } }
      : mediaInput;

  if (!paramSpecs || paramSpecs.length === 0) {
    return mediaPayload ? [promptText, mediaPayload] : [promptText];
  }

  const isExcludedTextbox = (pname: string, plabel: string): boolean =>
    /negative|repo|file|lora|weight|system|token|key|password|seed|url|model|checkpoint|api_key/i.test(
      `${pname} ${plabel}`,
    );

  // Detect MultimodalTextbox (takes both prompt + uploaded files in one object)
  const multimodalSlotIndex = paramSpecs.findIndex((spec) => {
    const comp = (spec.component ?? '').toLowerCase();
    return Boolean(spec.isMultimodalTextbox) || comp.includes('multimodal');
  });

  // Pick the single best prompt slot before filling defaults
  let promptSlotIndex = multimodalSlotIndex;
  if (promptSlotIndex === -1) {
    promptSlotIndex = paramSpecs.findIndex((spec) => {
      const comp = (spec.component ?? '').toLowerCase();
      const pname = (spec.name ?? '').toLowerCase();
      const plabel = (spec.label ?? '').toLowerCase();
      if (
        comp.includes('image') ||
        comp.includes('audio') ||
        comp.includes('video') ||
        comp.includes('file') ||
        comp.includes('gallery') ||
        comp.includes('slider') ||
        comp.includes('checkbox') ||
        comp.includes('number') ||
        comp.includes('dropdown') ||
        comp.includes('radio') ||
        comp.includes('chatbot')
      ) {
        return false;
      }
      if (isExcludedTextbox(pname, plabel)) return false;
      return /prompt|message|query|instruction|text|input|caption/i.test(`${pname} ${plabel}`);
    });
  }

  if (promptSlotIndex === -1) {
    promptSlotIndex = paramSpecs.findIndex((spec) => {
      const comp = (spec.component ?? '').toLowerCase();
      const pname = (spec.name ?? '').toLowerCase();
      const plabel = (spec.label ?? '').toLowerCase();
      return (comp.includes('textbox') || comp.includes('text')) && !isExcludedTextbox(pname, plabel);
    });
  }

  // Pick the single best media input slot matching mediaKind (image vs audio vs video)
  let preferredMediaSlotIndex = -1;
  if (mediaPayload && multimodalSlotIndex === -1) {
    const isMediaComponent = (spec: StoredGradioParamSpec): boolean => {
      const comp = (spec.component ?? '').toLowerCase();
      return (
        Boolean(spec.isImageEditor) ||
        Boolean(spec.isFileList) ||
        comp.includes('image') ||
        comp.includes('paint') ||
        comp.includes('sketch') ||
        comp.includes('audio') ||
        comp.includes('video') ||
        comp.includes('file') ||
        comp.includes('gallery')
      );
    };

    if (options?.mediaKind === 'audio') {
      preferredMediaSlotIndex = paramSpecs.findIndex((s) => (s.component ?? '').toLowerCase().includes('audio'));
    } else if (options?.mediaKind === 'image') {
      preferredMediaSlotIndex = paramSpecs.findIndex((s) => {
        const comp = (s.component ?? '').toLowerCase();
        return (
          Boolean(s.isImageEditor) ||
          comp.includes('image') ||
          comp.includes('paint') ||
          comp.includes('sketch') ||
          comp.includes('gallery')
        );
      });
    } else if (options?.mediaKind === 'video') {
      preferredMediaSlotIndex = paramSpecs.findIndex((s) => (s.component ?? '').toLowerCase().includes('video'));
    }

    if (preferredMediaSlotIndex === -1) {
      preferredMediaSlotIndex = paramSpecs.findIndex(isMediaComponent);
    }
  }

  const dims = mapAspectRatioToDimensions(options?.aspectRatio);
  const isCfWorker = isCloudflareWorker() || Boolean(getCloudflareRequestContext()?.waitUntil);

  // Detect built-in fast/Turbo LoRA on heavy ZeroGPU image Spaces (e.g. "Viggle Turbo (6-Step)" on Qwen AIO).
  // Works for BOTH generate AND edit/variation! Cuts latency from ~35-60s (CF timeout) down to ~7-10s!
  const hasHeavyDefaultSteps = paramSpecs.some((spec) => {
    const comp = (spec.component ?? '').toLowerCase();
    const pname = (spec.name ?? '').toLowerCase();
    const plabel = (spec.label ?? '').toLowerCase();
    return (
      (pname.includes('step') || plabel.includes('step')) &&
      (comp.includes('slider') || comp.includes('number')) &&
      typeof spec.defaultValue === 'number' &&
      spec.defaultValue >= 18
    );
  });

  const isImageGenerationOrEdit =
    options?.mode === 'generate' || options?.mode === 'edit' || options?.mode === 'variation';

  const allowAutoTurbo =
    isImageGenerationOrEdit &&
    hasHeavyDefaultSteps &&
    ctx.modelParameters?.disableAutoTurbo !== true &&
    !ctx.modelParameters?.defaultLora;

  let selectedTurboLoraIndex = -1;
  let selectedTurboLoraValue: string | null = null;
  let selectedTurboSteps: number | null = null;

  if (allowAutoTurbo) {
    for (let i = 0; i < paramSpecs.length; i++) {
      const spec = paramSpecs[i]!;
      const pname = (spec.name ?? '').toLowerCase();
      const plabel = (spec.label ?? '').toLowerCase();
      if (
        Array.isArray(spec.enum) &&
        /lora|adapter|turbo|preset|speed|model_type/i.test(`${pname} ${plabel}`)
      ) {
        const turboChoice = spec.enum.find(
          (v): v is string =>
            typeof v === 'string' &&
            /\bturbo\b|\blightning\b|\bfast\b|\b[468]\s*-?\s*step\b/i.test(v),
        );
        if (turboChoice) {
          selectedTurboLoraIndex = i;
          selectedTurboLoraValue = turboChoice;
          const stepMatch = turboChoice.match(/\b(\d{1,2})\s*-?\s*step/i);
          const parsedStep = stepMatch?.[1] ? Number.parseInt(stepMatch[1], 10) : 8;
          selectedTurboSteps = Number.isFinite(parsedStep)
            ? Math.max(4, Math.min(10, parsedStep))
            : 8;
          break;
        }
      }
    }
  }

  return paramSpecs.map((spec, idx) => {
    const comp = (spec.component ?? '').toLowerCase();
    const pname = (spec.name ?? '').toLowerCase();
    const plabel = (spec.label ?? '').toLowerCase();
    const isMediaComp =
      Boolean(spec.isImageEditor) ||
      Boolean(spec.isFileList) ||
      comp.includes('image') ||
      comp.includes('paint') ||
      comp.includes('sketch') ||
      comp.includes('audio') ||
      comp.includes('video') ||
      comp.includes('file') ||
      comp.includes('gallery');

    // MultimodalTextbox slot receives BOTH text and uploaded files
    if (idx === multimodalSlotIndex) {
      return {
        text: promptText,
        files: mediaPayload ? [mediaPayload] : [],
      };
    }

    if (isMediaComp) {
      if (mediaPayload && idx === preferredMediaSlotIndex) {
        if (spec.isImageEditor || /imageeditor|paint|sketchpad|inpaint/.test(comp)) {
          return { background: mediaPayload, layers: [], composite: mediaPayload };
        }
        if (comp.includes('gallery')) {
          return [{ image: mediaPayload, caption: null }];
        }
        if (spec.isFileList || comp === 'files') {
          return [mediaPayload];
        }
        return mediaPayload;
      }
      return spec.hasDefault ? (spec.defaultValue ?? null) : null;
    }

    if (comp.includes('chatbot') || pname.includes('history')) {
      const useMessages =
        options?.chatHistoryFormat === 'messages' ||
        (options?.chatHistoryFormat !== 'tuples' && Boolean(spec.isChatbotMessages));
      if (useMessages) {
        return (history ?? [])
          .filter((h) => h.role !== 'system')
          .map((h) => ({
            role: h.role === 'assistant' ? 'assistant' : 'user',
            content: h.content,
          }));
      }
      return pairGradio4TupleHistory(history);
    }

    if (pname.includes('system') && systemPrompt) {
      return systemPrompt;
    }
    if (idx === promptSlotIndex) {
      return promptText;
    }

    if (idx === selectedTurboLoraIndex && selectedTurboLoraValue !== null) {
      return selectedTurboLoraValue;
    }

    // Mode selection (Image: Text-to-Image vs Edit; Video: T2V vs I2V)
    if (
      (pname.includes('mode') || plabel.includes('mode') || pname.includes('task') || plabel.includes('task')) &&
      Array.isArray(spec.enum) &&
      spec.enum.length > 0
    ) {
      if (options?.mode === 'edit' || options?.mode === 'variation') {
        const editChoice =
          spec.enum.find((v) => typeof v === 'string' && /edit.*1\s*ref|single|img2img/i.test(v)) ??
          spec.enum.find((v) => typeof v === 'string' && /edit|img2img|inpaint|ref/i.test(v));
        if (editChoice !== undefined) return editChoice;
      } else if (options?.mode === 'generate') {
        const genChoice = spec.enum.find((v) => typeof v === 'string' && /text to image|txt2img|t2i|generate/i.test(v));
        if (genChoice !== undefined) return genChoice;
      } else if (options?.mode === 'i2v') {
        const i2vChoice = spec.enum.find((v) => typeof v === 'string' && /image.*video|i2v|img2vid/i.test(v));
        if (i2vChoice !== undefined) return i2vChoice;
      } else if (options?.mode === 't2v') {
        const t2vChoice = spec.enum.find((v) => typeof v === 'string' && /text.*video|t2v|txt2vid/i.test(v));
        if (t2vChoice !== undefined) return t2vChoice;
      }
    }

    // Voice / speaker dropdown matching (TTS)
    if (
      options?.voice &&
      Array.isArray(spec.enum) &&
      spec.enum.length > 0 &&
      /voice|speaker|timbre|actor|narrator/i.test(`${pname} ${plabel}`)
    ) {
      const targetVoice = options.voice.trim().toLowerCase();
      const voiceMatch = spec.enum.find(
        (v) => typeof v === 'string' && v.toLowerCase().includes(targetVoice),
      );
      if (voiceMatch !== undefined) return voiceMatch;
    }

    // Language dropdown matching (TTS / STT)
    if (
      options?.language &&
      Array.isArray(spec.enum) &&
      spec.enum.length > 0 &&
      /lang|language/i.test(`${pname} ${plabel}`)
    ) {
      const langMatch = matchLanguageChoice(spec.enum, options.language);
      if (langMatch !== undefined) return langMatch;
    }

    // Video duration matching
    if (
      typeof options?.durationSeconds === 'number' &&
      /duration|second|video_len|clip_len/i.test(`${pname} ${plabel}`)
    ) {
      if (Array.isArray(spec.enum) && spec.enum.length > 0) {
        const durMatch = spec.enum.find(
          (v) =>
            Number(v) === options.durationSeconds ||
            (typeof v === 'string' && v.includes(String(options.durationSeconds))),
        );
        if (durMatch !== undefined) return durMatch;
      }
      if (comp.includes('slider') || comp.includes('number')) {
        return clampNumericToSpec(options.durationSeconds, spec);
      }
    }

    // Aspect ratio dropdown matching (e.g. "Landscape · 16:9 (1344x768)")
    if (
      options?.aspectRatio &&
      (pname.includes('aspect') || pname.includes('ratio') || plabel.includes('aspect') || plabel.includes('resolution')) &&
      Array.isArray(spec.enum)
    ) {
      const ratioMatch = spec.enum.find(
        (v) => typeof v === 'string' && v.includes(options.aspectRatio!),
      );
      if (ratioMatch !== undefined) return ratioMatch;
    }

    // Explicit width / height sliders (clamped to Space min/max)
    if (options?.aspectRatio && (comp.includes('slider') || comp.includes('number'))) {
      if (pname === 'width' || plabel === 'width') return clampNumericToSpec(dims.width, spec);
      if (pname === 'height' || plabel === 'height') return clampNumericToSpec(dims.height, spec);
    }

    // Match step count to auto-selected Turbo LoRA, or cap heavy steps so Cloudflare Workers completes cleanly
    if (
      (pname.includes('step') || plabel.includes('step')) &&
      (comp.includes('slider') || comp.includes('number'))
    ) {
      if (selectedTurboSteps !== null) {
        return clampNumericToSpec(selectedTurboSteps, spec);
      }
      if (typeof spec.defaultValue === 'number' && spec.defaultValue > 12) {
        const capped = isCfWorker ? Math.min(spec.defaultValue, 10) : Math.min(spec.defaultValue, 16);
        return clampNumericToSpec(capped, spec);
      }
    }

    if (spec.hasDefault) {
      return spec.defaultValue ?? null;
    }
    if (Array.isArray(spec.enum) && spec.enum.length > 0) {
      return spec.enum[0];
    }
    if (comp.includes('slider') || comp.includes('number')) {
      return typeof spec.min === 'number' ? spec.min : 1;
    }
    if (comp.includes('checkbox')) return false;
    return '';
  });
}

type GradioSubmitResult =
  | { kind: 'immediate'; outputData: unknown[]; spaceHost: string; endpointPrefix: string }
  | { kind: 'event'; eventId: string; callUrl: string; spaceHost: string; endpointPrefix: string };

async function submitGradioSpaceCall(
  ctx: ProviderExecutionContext,
  dataArgs: unknown[],
  signal?: AbortSignal,
  deadlineAtMs?: number,
): Promise<GradioSubmitResult> {
  const paramSpaceHost = typeof ctx.modelParameters?.spaceHost === 'string' ? ctx.modelParameters.spaceHost : '';
  const resolved = paramSpaceHost
    ? { resolvedRootUrl: normalizeBaseUrl(paramSpaceHost) }
    : await resolveHfSpaceRootUrl(ctx.baseUrl, ctx.apiKey, ctx.additionalHeaders);
  const spaceHost = resolved.resolvedRootUrl;

  const modelIdParts = ctx.modelIdentifier.split('::');
  const apiName = (
    typeof ctx.modelParameters?.apiName === 'string'
      ? ctx.modelParameters.apiName
      : modelIdParts[1] || 'predict'
  ).replace(/^\/+/, '');
  const fnIndex =
    typeof ctx.modelParameters?.fnIndex === 'number' ? ctx.modelParameters.fnIndex : undefined;

  const prefix =
    typeof ctx.modelParameters?.endpointPrefix === 'string'
      ? ctx.modelParameters.endpointPrefix
      : '/gradio_api';
  const normalizedPrefix = prefix === '' ? '' : `/${prefix.replace(/^\/+|\/+$/g, '')}`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ctx.apiKey.trim()) {
    headers.Authorization = `Bearer ${ctx.apiKey.trim()}`;
  }
  const mergedHeaders = mergeHeaders(headers, ctx.additionalHeaders);

  const callCandidates =
    fnIndex !== undefined
      ? []
      : Array.from(
          new Set([
            `${spaceHost}${normalizedPrefix}/call/${apiName}`,
            `${spaceHost}/call/${apiName}`,
          ]),
        );

  let submitRes: Response | null = null;
  let activeCallUrl = callCandidates[0] ?? `${spaceHost}${normalizedPrefix}/call/${apiName}`;

  for (const url of callCandidates) {
    const res = await fetchWithTimeout(
      url,
      { method: 'POST', headers: mergedHeaders, body: JSON.stringify({ data: dataArgs }) },
      getRemainingBudgetMs(deadlineAtMs, 15_000),
      signal,
    );
    if (res.status !== 404) {
      submitRes = res;
      activeCallUrl = url;
      break;
    }
  }

  // Fallback for unnamed fn_index endpoints or legacy Gradio `/api/predict`
  if (!submitRes) {
    const legacyUrls =
      fnIndex !== undefined
        ? [`${spaceHost}${normalizedPrefix}/api/predict`, `${spaceHost}/api/predict`, `${spaceHost}/run/predict`]
        : [`${spaceHost}/api/predict`, `${spaceHost}${normalizedPrefix}/api/predict`];
    const bodyPayload =
      fnIndex !== undefined ? { data: dataArgs, fn_index: fnIndex } : { data: dataArgs };

    let lastStatus = 404;
    let lastBody = '';
    for (const legacyUrl of legacyUrls) {
      const legacyRes = await fetchWithTimeout(
        legacyUrl,
        { method: 'POST', headers: mergedHeaders, body: JSON.stringify(bodyPayload) },
        getRemainingBudgetMs(deadlineAtMs, 25_000),
        signal,
      );
      lastStatus = legacyRes.status;
      lastBody = await legacyRes.text();
      if (legacyRes.ok) {
        const parsed = safeParseJsonText(lastBody) as { data?: unknown[] } | null;
        if (parsed && Array.isArray(parsed.data)) {
          return {
            kind: 'immediate',
            outputData: parsed.data,
            spaceHost,
            endpointPrefix: normalizedPrefix,
          };
        }
      }
      if (legacyRes.status !== 404) break;
    }

    if (lastStatus === 404 || lastBody.trim().startsWith('<')) {
      throw new AIProviderError({
        code: 'PROVIDER_ERROR',
        message: `HF Space endpoint unavailable (${lastStatus}): ${redactSecrets(lastBody.slice(0, 160), ctx.apiKey ? [ctx.apiKey] : [])}`,
        userMessageFa: 'این مدل موقتاً در حال راه‌اندازی یا در دسترس نیست. لطفاً لحظاتی دیگر دوباره تلاش کنید.',
        retryable: true,
        httpStatus: lastStatus,
        credentialFailureKind: 'transient',
      });
    }
    throw classifyHttpError(lastStatus, lastBody, ctx.apiKey);
  }

  const rawSubmitText = await submitRes.text();

  if (!submitRes.ok) {
    if (
      (submitRes.status === 503 || submitRes.status === 502 || submitRes.status === 504) &&
      (/queue is stopped|sleeping|building|paused|no space|restarting|<!doctype/i.test(rawSubmitText) ||
        rawSubmitText.trim().startsWith('<'))
    ) {
      throw new AIProviderError({
        code: 'PROVIDER_ERROR',
        message: `HF Space unavailable (${submitRes.status}): ${redactSecrets(rawSubmitText.slice(0, 200), ctx.apiKey ? [ctx.apiKey] : [])}`,
        userMessageFa: 'این مدل موقتاً در حال راه‌اندازی یا شلوغ است. لطفاً لحظاتی دیگر دوباره تلاش کنید یا مدل دیگری انتخاب کنید.',
        retryable: true,
        httpStatus: submitRes.status,
        credentialFailureKind: 'transient',
      });
    }
    throw classifyHttpError(submitRes.status, rawSubmitText, ctx.apiKey);
  }

  const parsedSubmit = safeParseJsonText(rawSubmitText) as { event_id?: string; data?: unknown[] } | null;
  if (!parsedSubmit) {
    throw new AIProviderError({
      code: 'PROVIDER_ERROR',
      message: `HF Space returned non-JSON submit response: ${redactSecrets(rawSubmitText.slice(0, 180), ctx.apiKey ? [ctx.apiKey] : [])}`,
      userMessageFa: 'سرور این مدل موقتاً پاسخ نامعتبر برگرداند (احتمالاً در حال ری‌استارت است). لطفاً دوباره تلاش کنید.',
      retryable: true,
      credentialFailureKind: 'transient',
    });
  }

  if (!parsedSubmit.event_id && Array.isArray(parsedSubmit.data)) {
    return {
      kind: 'immediate',
      outputData: parsedSubmit.data,
      spaceHost,
      endpointPrefix: normalizedPrefix,
    };
  }

  if (!parsedSubmit.event_id) {
    throw new AIProviderError({
      code: 'PROVIDER_ERROR',
      message: 'Hugging Face Space did not return an event_id.',
      userMessageFa: 'پاسخی از سرور پردازش دریافت نشد. لطفاً دوباره تلاش کنید.',
      retryable: true,
      credentialFailureKind: 'transient',
    });
  }

  return {
    kind: 'event',
    eventId: parsedSubmit.event_id,
    callUrl: activeCallUrl,
    spaceHost,
    endpointPrefix: normalizedPrefix,
  };
}

function parseGradioSseBlock(
  block: string,
): { kind: 'complete'; data: unknown[] } | { kind: 'error'; raw: string } | null {
  const lines = block.split(/\r?\n/);
  let eventName = '';
  const dataLines: string[] = [];
  for (const l of lines) {
    if (l.startsWith('event:')) eventName = l.slice(6).trim();
    if (l.startsWith('data:')) dataLines.push(l.slice(5).trim());
  }
  const payloadRaw = dataLines.join('\n');
  if (eventName === 'error') {
    return { kind: 'error', raw: payloadRaw || 'Space execution failed' };
  }
  if (eventName === 'complete' && payloadRaw) {
    const parsed = safeParseJsonText(payloadRaw);
    if (parsed !== null) {
      return { kind: 'complete', data: Array.isArray(parsed) ? parsed : [parsed] };
    }
    return { kind: 'complete', data: [payloadRaw] };
  }
  return null;
}

function buildGradioSseError(raw: string, apiKey: string): AIProviderError {
  const isQuota = isQuotaExhaustedSignal(raw);
  const safeDetail = redactSecrets(raw.slice(0, 300), apiKey ? [apiKey] : []);
  return new AIProviderError({
    code: isQuota ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
    message: `HF Space error: ${safeDetail}`,
    userMessageFa: isQuota
      ? 'سرویس این مدل موقتاً شلوغ است (محدودیت سهمیه GPU). لطفاً لحظاتی دیگر دوباره تلاش کنید یا مدل دیگری انتخاب نمایید.'
      : 'پردازش درخواست با خطا مواجه شد. لطفاً دوباره تلاش کنید.',
    retryable: true,
    credentialFailureKind: isQuota ? 'quota_exhausted' : 'transient',
  });
}

async function readGradioSpaceSse(params: {
  callUrl: string;
  eventId: string;
  apiKey: string;
  additionalHeaders?: Record<string, string>;
  deadlineAtMs: number;
  signal?: AbortSignal;
}): Promise<{ status: 'complete'; outputData: unknown[] } | { status: 'timeout' }> {
  const attemptStore = attemptBudgetAls.getStore();
  // Fire our soft SSE timeout at least 900ms before any hard attempt deadline so a slow
  // already-submitted Gradio job can hand off its eventId cleanly instead of aborting.
  const attemptSoftCeiling =
    typeof attemptStore?.deadlineAtMs === 'number'
      ? attemptStore.deadlineAtMs - 900
      : undefined;
  const effectiveDeadline =
    typeof attemptSoftCeiling === 'number'
      ? Math.min(params.deadlineAtMs, attemptSoftCeiling)
      : params.deadlineAtMs;
  if (effectiveDeadline <= Date.now() + 250) {
    return { status: 'timeout' };
  }
  const sseTimeoutMs = Math.max(250, effectiveDeadline - Date.now());
  const sseController = new AbortController();
  let timedOut = false;
  const sseTimer = setTimeout(() => {
    timedOut = true;
    sseController.abort();
  }, sseTimeoutMs);
  const onExternalAbort = () => sseController.abort();
  params.signal?.addEventListener('abort', onExternalAbort, { once: true });
  attemptStore?.signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (params.signal?.aborted || attemptStore?.signal?.aborted) {
    sseController.abort();
  }

  const authHeaders: Record<string, string> = { Accept: 'text/event-stream' };
  if (params.apiKey.trim()) authHeaders.Authorization = `Bearer ${params.apiKey.trim()}`;
  const mergedHeaders = mergeHeaders(authHeaders, params.additionalHeaders);

  const sseUrl = `${params.callUrl}/${encodeURIComponent(params.eventId)}`;
  await assertSafeOutboundUrl(sseUrl);

  try {
    const sseRes = await fetch(sseUrl, {
      method: 'GET',
      headers: mergedHeaders,
      signal: sseController.signal,
    });
    if (!sseRes.ok) {
      throw classifyHttpError(sseRes.status, await sseRes.text(), params.apiKey);
    }

    if (!sseRes.body) {
      const sseText = await sseRes.text();
      for (const block of sseText.split(/\r?\n\r?\n/)) {
        const parsed = parseGradioSseBlock(block);
        if (parsed?.kind === 'error') throw buildGradioSseError(parsed.raw, params.apiKey);
        if (parsed?.kind === 'complete') return { status: 'complete', outputData: parsed.data };
      }
      throw new AIProviderError({
        code: 'PROVIDER_ERROR',
        message: 'Hugging Face Space stream ended without complete event.',
        userMessageFa: 'خروجی کاملی از مدل دریافت نشد. لطفاً دوباره تلاش کنید.',
        retryable: true,
      });
    }

    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() ?? '';

        for (const block of parts) {
          if (!block.trim()) continue;
          const parsed = parseGradioSseBlock(block);
          if (parsed?.kind === 'error') {
            await reader.cancel().catch(() => {});
            throw buildGradioSseError(parsed.raw, params.apiKey);
          }
          if (parsed?.kind === 'complete') {
            await reader.cancel().catch(() => {});
            return { status: 'complete', outputData: parsed.data };
          }
        }
      }

      if (buffer.trim()) {
        const parsed = parseGradioSseBlock(buffer);
        if (parsed?.kind === 'error') throw buildGradioSseError(parsed.raw, params.apiKey);
        if (parsed?.kind === 'complete') return { status: 'complete', outputData: parsed.data };
      }
    } finally {
      reader.releaseLock();
    }

    throw new AIProviderError({
      code: 'PROVIDER_ERROR',
      message: 'Hugging Face Space stream ended without complete event.',
      userMessageFa: 'خروجی کاملی از مدل دریافت نشد. لطفاً دوباره تلاش کنید.',
      retryable: true,
    });
  } catch (err) {
    if (err instanceof AIProviderError) throw err;
    if (timedOut) {
      return { status: 'timeout' };
    }
    throw err;
  } finally {
    clearTimeout(sseTimer);
    params.signal?.removeEventListener('abort', onExternalAbort);
    attemptStore?.signal?.removeEventListener('abort', onExternalAbort);
  }
}

async function runGradioSpaceCall(
  ctx: ProviderExecutionContext,
  dataArgs: unknown[],
  signal?: AbortSignal,
  deadlineAtMs?: number,
): Promise<{ outputData: unknown[]; spaceHost: string; endpointPrefix: string }> {
  const effectiveDeadline = deadlineAtMs ?? createHfDeadline('sync');
  const submitted = await submitGradioSpaceCall(ctx, dataArgs, signal, effectiveDeadline);
  if (submitted.kind === 'immediate') {
    return {
      outputData: submitted.outputData,
      spaceHost: submitted.spaceHost,
      endpointPrefix: submitted.endpointPrefix,
    };
  }

  const sseResult = await readGradioSpaceSse({
    callUrl: submitted.callUrl,
    eventId: submitted.eventId,
    apiKey: ctx.apiKey,
    additionalHeaders: ctx.additionalHeaders,
    deadlineAtMs: effectiveDeadline,
    signal,
  });

  if (sseResult.status === 'timeout') {
    throw new AIProviderError({
      code: 'TIMEOUT',
      message: 'Hugging Face Space SSE queue timed out before completion.',
      userMessageFa:
        'زمان پاسخ‌گویی این مدل به پایان رسید (صف شلوغ است). اعتبار شما بازگردانده شد؛ لطفاً دوباره تلاش کنید یا مدل دیگری انتخاب نمایید.',
      retryable: true,
      credentialFailureKind: 'transient',
    });
  }

  return {
    outputData: sseResult.outputData,
    spaceHost: submitted.spaceHost,
    endpointPrefix: submitted.endpointPrefix,
  };
}

async function callOpenAiCompatibleSpaceText(
  ctx: ProviderExecutionContext,
  input: TextGenerationInput,
  spaceHost: string,
  deadlineAtMs: number,
): Promise<TextGenerationOutput> {
  const modelName =
    typeof ctx.modelParameters?.openAiModelId === 'string' && ctx.modelParameters.openAiModelId
      ? ctx.modelParameters.openAiModelId
      : ctx.modelIdentifier.split('::openai::')[1] || 'default';

  const messages: Array<{ role: string; content: unknown }> = [];
  if (input.systemPrompt) messages.push({ role: 'system', content: input.systemPrompt });
  for (const m of input.messages) {
    if (m.role === 'system') continue;
    if (m.imageBase64 && m.imageMimeType) {
      messages.push({
        role: m.role,
        content: [
          { type: 'image_url', image_url: { url: `data:${m.imageMimeType};base64,${m.imageBase64}` } },
          { type: 'text', text: m.content },
        ],
      });
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ctx.apiKey.trim()) headers.Authorization = `Bearer ${ctx.apiKey.trim()}`;
  const res = await fetchWithTimeout(
    `${normalizeBaseUrl(spaceHost)}/v1/chat/completions`,
    {
      method: 'POST',
      headers: mergeHeaders(headers, ctx.additionalHeaders),
      body: JSON.stringify({
        model: modelName,
        messages,
        max_tokens: Math.min(input.maxTokens ?? ctx.maxOutputSize ?? 2048, 4096),
        ...(typeof input.temperature === 'number' ? { temperature: input.temperature } : {}),
      }),
    },
    getRemainingBudgetMs(deadlineAtMs, 20_000),
    input.signal,
  );
  const rawText = await res.text();
  if (!res.ok) throw classifyHttpError(res.status, rawText, ctx.apiKey);
  const json = safeParseJsonText(rawText) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  } | null;
  const text = json?.choices?.[0]?.message?.content?.trim() ?? '';
  if (input.onChunk && text) await input.onChunk(text);
  const inTok = json?.usage?.prompt_tokens ?? estimateTokensRough(input.messages.map((m) => m.content).join('\n'));
  const outTok = json?.usage?.completion_tokens ?? estimateTokensRough(text);
  return {
    text: text || 'پاسخی از مدل دریافت نشد. لطفاً دوباره تلاش کنید.',
    inputTokens: inTok,
    outputTokens: outTok,
    costUsd: 0,
    finishReason: json?.choices?.[0]?.finish_reason,
  };
}

// =============================================================================
// 1. TEXT GENERATION & CHAT COMPLETION (WITH STREAMING)
// =============================================================================

async function executeTextOnProvider(
  ctx: ProviderExecutionContext,
  input: TextGenerationInput,
): Promise<TextGenerationOutput> {
  if (isAiMockModeEnabled()) {
    return runMockTextGeneration(ctx, input);
  }

  try {
    if (ctx.providerType === 'google_gemini') {
      const root = normalizeGeminiRootBaseUrl(ctx.baseUrl);
      const modelId = normalizeGeminiModelId(ctx.modelIdentifier);
      const isGemma = modelId.toLowerCase().includes('gemma');

      const contents = input.messages
        .filter((m) => m.role !== 'system')
        .map((m) => {
          const parts: Array<Record<string, unknown>> = [];
          if (m.imageBase64 && m.imageMimeType) {
            parts.push({ inlineData: { data: m.imageBase64, mimeType: m.imageMimeType } });
          }
          parts.push({ text: m.content });
          return {
            role: m.role === 'assistant' ? 'model' : 'user',
            parts,
          };
        });

      // Gemma models on Gemini API do not support systemInstruction; prepend to first user turn instead
      if (isGemma && input.systemPrompt) {
        const firstUser = contents.find((c) => c.role === 'user');
        const sysPrefix = `[System Instructions]\n${input.systemPrompt}\n\n`;
        if (firstUser) {
          const textPart = firstUser.parts.find((p) => typeof p.text === 'string');
          if (textPart) {
            textPart.text = `${sysPrefix}${textPart.text}`;
          } else {
            firstUser.parts.unshift({ text: sysPrefix });
          }
        } else {
          contents.unshift({ role: 'user', parts: [{ text: input.systemPrompt }] });
        }
      }

      const body: Record<string, unknown> = { contents };
      if (!isGemma && input.systemPrompt) {
        body.systemInstruction = { parts: [{ text: input.systemPrompt }] };
      }
      const generationConfig: Record<string, unknown> = {};
      if (input.maxTokens ?? ctx.maxOutputSize) {
        generationConfig.maxOutputTokens = input.maxTokens ?? ctx.maxOutputSize;
      }
      const temp = input.temperature ?? (ctx.modelParameters?.temperature as number | undefined);
      if (typeof temp === 'number') {
        generationConfig.temperature = temp;
      }
      if (Object.keys(generationConfig).length > 0) {
        body.generationConfig = generationConfig;
      }

      const encodedModel = encodeURIComponent(modelId);
      const headers = buildGeminiHeaders(ctx);

      if (input.onChunk) {
        const streamUrl = `${root}/v1beta/models/${encodedModel}:streamGenerateContent?alt=sse`;
        const res = await fetchWithTimeout(
          streamUrl,
          { method: 'POST', headers, body: JSON.stringify(body) },
          60000,
          input.signal,
        );
        if (!res.ok) {
          throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
        }

        if (res.body) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let fullText = '';
          let inTok = 0;
          let outTok = 0;
          let lastFinishReason: string | undefined;

          while (true) {
            if (input.signal?.aborted) {
              throw new AIProviderError({
                code: 'CANCELED',
                message: 'Generation stopped by user',
                userMessageFa: 'تولید پاسخ متوقف شد.',
              });
            }
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              if (!line.startsWith('data:')) continue;
              const raw = line.slice(5).trim();
              if (!raw || raw === '[DONE]') continue;
              try {
                const evt = JSON.parse(raw) as GeminiGenerateContentResponse;
                if (evt.promptFeedback?.blockReason) {
                  assertGeminiNotBlocked(evt, false);
                }
                const delta = extractGeminiCandidateText(evt.candidates);
                if (delta) {
                  fullText += delta;
                  await input.onChunk(fullText);
                }
                if (evt.candidates?.[0]?.finishReason) {
                  lastFinishReason = evt.candidates[0].finishReason;
                }
                if (evt.usageMetadata) {
                  inTok = evt.usageMetadata.promptTokenCount ?? inTok;
                  outTok = evt.usageMetadata.candidatesTokenCount ?? outTok;
                }
              } catch (parseErr) {
                if (parseErr instanceof AIProviderError) throw parseErr;
              }
            }
          }

          if (!fullText && (lastFinishReason === 'SAFETY' || lastFinishReason === 'PROHIBITED_CONTENT')) {
            assertGeminiNotBlocked({ candidates: [{ finishReason: lastFinishReason }] }, false);
          }

          inTok = inTok || estimateTokensRough(input.messages.map((m) => m.content).join('\n'));
          outTok = outTok || estimateTokensRough(fullText);
          return {
            text: fullText.trim() || 'پاسخی از مدل دریافت نشد.',
            inputTokens: inTok,
            outputTokens: outTok,
            costUsd: estimateTokenCostUsd(inTok, outTok, ctx.inputPricePerMillion, ctx.outputPricePerMillion),
            finishReason: lastFinishReason,
          };
        }
      }

      const url = `${root}/v1beta/models/${encodedModel}:generateContent`;
      const res = await fetchWithTimeout(
        url,
        { method: 'POST', headers, body: JSON.stringify(body) },
        60000,
        input.signal,
      );
      if (!res.ok) {
        throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
      }

      const json = (await res.json()) as GeminiGenerateContentResponse;
      assertGeminiNotBlocked(json, false);
      const text = extractGeminiCandidateText(json.candidates).trim();
      const inTok =
        json.usageMetadata?.promptTokenCount ??
        estimateTokensRough(input.messages.map((m) => m.content).join('\n'));
      const outTok = json.usageMetadata?.candidatesTokenCount ?? estimateTokensRough(text);
      return {
        text: text || 'پاسخی از مدل دریافت نشد.',
        inputTokens: inTok,
        outputTokens: outTok,
        costUsd: estimateTokenCostUsd(inTok, outTok, ctx.inputPricePerMillion, ctx.outputPricePerMillion),
        finishReason: json.candidates?.[0]?.finishReason,
      };
    }

    if (ctx.providerType === 'anthropic') {
      const url = `${normalizeBaseUrl(ctx.baseUrl)}/v1/messages`;
      const messages = input.messages
        .filter((m) => m.role !== 'system')
        .map((m) => {
          if (m.imageBase64 && m.imageMimeType) {
            return {
              role: m.role,
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: m.imageMimeType, data: m.imageBase64 },
                },
                { type: 'text', text: m.content },
              ],
            };
          }
          return { role: m.role, content: m.content };
        });

      const useStream = Boolean(input.onChunk);
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: mergeHeaders(
            {
              'Content-Type': 'application/json',
              'x-api-key': ctx.apiKey,
              'anthropic-version': '2023-06-01',
            },
            ctx.additionalHeaders,
          ),
          body: JSON.stringify({
            model: ctx.modelIdentifier,
            max_tokens: Math.min(input.maxTokens ?? ctx.maxOutputSize ?? 4096, 8192),
            system: input.systemPrompt || undefined,
            messages,
            stream: useStream,
          }),
        },
        60000,
        input.signal,
      );

      if (!res.ok) {
        throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
      }

      if (useStream && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';
        let inTok = 0;
        let outTok = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            try {
              const evt = JSON.parse(raw) as {
                type?: string;
                delta?: { text?: string };
                message?: { usage?: { input_tokens?: number } };
                usage?: { output_tokens?: number };
              };
              if (evt.type === 'content_block_delta' && evt.delta?.text) {
                fullText += evt.delta.text;
                await input.onChunk?.(fullText);
              }
              if (evt.message?.usage?.input_tokens) inTok = evt.message.usage.input_tokens;
              if (evt.usage?.output_tokens) outTok = evt.usage.output_tokens;
            } catch {
              // ignore non-json SSE keepalive
            }
          }
        }
        inTok = inTok || estimateTokensRough(input.messages.map((m) => m.content).join('\n'));
        outTok = outTok || estimateTokensRough(fullText);
        return {
          text: fullText.trim() || 'پاسخی دریافت نشد.',
          inputTokens: inTok,
          outputTokens: outTok,
          costUsd: estimateTokenCostUsd(inTok, outTok, ctx.inputPricePerMillion, ctx.outputPricePerMillion),
        };
      }

      const json = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (json.content ?? [])
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text)
        .join('\n')
        .trim();
      const inTok = json.usage?.input_tokens ?? estimateTokensRough(input.messages.map((m) => m.content).join('\n'));
      const outTok = json.usage?.output_tokens ?? estimateTokensRough(text);
      return {
        text: text || 'پاسخی دریافت نشد.',
        inputTokens: inTok,
        outputTokens: outTok,
        costUsd: estimateTokenCostUsd(inTok, outTok, ctx.inputPricePerMillion, ctx.outputPricePerMillion),
      };
    }

    if (
      ctx.providerType === 'openai_compatible' ||
      ctx.providerType === 'custom' ||
      (ctx.providerType === 'huggingface' && !isHuggingFaceSpaceContext(ctx))
    ) {
      let url: string;
      if (ctx.providerType === 'huggingface') {
        const routerRoot = resolveHuggingFaceRouterRoot(ctx.baseUrl);
        url = `${routerRoot}/v1/chat/completions`;
      } else {
        const base = normalizeOpenAiRootBaseUrl(ctx.baseUrl);
        url = `${base}/chat/completions`;
      }
      const formattedMessages: Array<Record<string, unknown>> = [];
      if (input.systemPrompt) {
        formattedMessages.push({ role: 'system', content: input.systemPrompt });
      }
      for (const m of input.messages) {
        if (m.role === 'system') continue;
        if (m.imageBase64 && m.imageMimeType) {
          formattedMessages.push({
            role: m.role,
            content: [
              { type: 'text', text: m.content },
              {
                type: 'image_url',
                image_url: { url: `data:${m.imageMimeType};base64,${m.imageBase64}` },
              },
            ],
          });
        } else {
          formattedMessages.push({ role: m.role, content: m.content });
        }
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.apiKey}`,
      };
      if (ctx.organizationId) headers['OpenAI-Organization'] = ctx.organizationId;

      const useStream = Boolean(input.onChunk);
      const maxTokensVal = input.maxTokens ?? ctx.maxOutputSize ?? 4096;
      const tempVal = input.temperature ?? (ctx.modelParameters?.temperature as number | undefined);
      const isOpenAiReasoningModel = /^(o1|o3|o4|gpt-5)/i.test(ctx.modelIdentifier);

      const buildChatBody = (useMaxCompletionTokens: boolean, includeTemperature: boolean) => {
        const payload: Record<string, unknown> = {
          model: ctx.modelIdentifier,
          messages: formattedMessages,
          stream: useStream,
        };
        if (useMaxCompletionTokens) {
          payload.max_completion_tokens = maxTokensVal;
        } else {
          payload.max_tokens = maxTokensVal;
        }
        if (includeTemperature && typeof tempVal === 'number') {
          payload.temperature = tempVal;
        }
        return payload;
      };

      const mergedHeaders = mergeHeaders(headers, ctx.additionalHeaders);
      let res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: mergedHeaders,
          body: JSON.stringify(buildChatBody(isOpenAiReasoningModel, !isOpenAiReasoningModel)),
        },
        60000,
        input.signal,
      );

      if (!res.ok && res.status === 400) {
        const firstErrBody = await res.text();
        if (/max_completion_tokens|max_tokens|temperature/i.test(firstErrBody)) {
          res = await fetchWithTimeout(
            url,
            {
              method: 'POST',
              headers: mergedHeaders,
              body: JSON.stringify(buildChatBody(!isOpenAiReasoningModel || firstErrBody.includes('max_completion_tokens'), false)),
            },
            60000,
            input.signal,
          );
          if (!res.ok) {
            throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
          }
        } else {
          throw classifyHttpError(res.status, firstErrBody, ctx.apiKey);
        }
      } else if (!res.ok) {
        throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
      }

      if (useStream && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';
        let inTok = 0;
        let outTok = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            try {
              const evt = JSON.parse(raw) as {
                choices?: Array<{ delta?: { content?: string } }>;
                usage?: { prompt_tokens?: number; completion_tokens?: number };
              };
              const delta = evt.choices?.[0]?.delta?.content;
              if (delta) {
                fullText += delta;
                await input.onChunk?.(fullText);
              }
              if (evt.usage?.prompt_tokens) inTok = evt.usage.prompt_tokens;
              if (evt.usage?.completion_tokens) outTok = evt.usage.completion_tokens;
            } catch {
              // ignore SSE parse hiccups
            }
          }
        }
        inTok = inTok || estimateTokensRough(input.messages.map((m) => m.content).join('\n'));
        outTok = outTok || estimateTokensRough(fullText);
        return {
          text: fullText.trim() || 'پاسخی دریافت نشد.',
          inputTokens: inTok,
          outputTokens: outTok,
          costUsd: estimateTokenCostUsd(inTok, outTok, ctx.inputPricePerMillion, ctx.outputPricePerMillion),
        };
      }

      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = json.choices?.[0]?.message?.content?.trim() ?? '';
      const inTok = json.usage?.prompt_tokens ?? estimateTokensRough(input.messages.map((m) => m.content).join('\n'));
      const outTok = json.usage?.completion_tokens ?? estimateTokensRough(text);
      return {
        text: text || 'پاسخی دریافت نشد.',
        inputTokens: inTok,
        outputTokens: outTok,
        costUsd: estimateTokenCostUsd(inTok, outTok, ctx.inputPricePerMillion, ctx.outputPricePerMillion),
        finishReason: json.choices?.[0]?.finish_reason,
      };
    }

    if (isHuggingFaceSpaceContext(ctx)) {
      const deadlineAtMs = createHfDeadline('sync');
      const lastUser = [...input.messages].reverse().find((m) => m.role === 'user');
      const hasVisionImage = Boolean(lastUser?.imageBase64 && lastUser?.imageMimeType);

      // Direct OpenAI-compatible Docker HF Space (/v1/chat/completions)
      if (ctx.modelParameters?.openAiCompatible === true) {
        const spaceHost =
          typeof ctx.modelParameters.spaceHost === 'string' && ctx.modelParameters.spaceHost
            ? normalizeBaseUrl(ctx.modelParameters.spaceHost)
            : (await resolveHfSpaceRootUrl(ctx.baseUrl, ctx.apiKey, ctx.additionalHeaders)).resolvedRootUrl;
        return callOpenAiCompatibleSpaceText(ctx, input, spaceHost, deadlineAtMs);
      }

      let resolvedCtx = await resolveGradioContext(ctx, input.signal, {
        preferredKind: hasVisionImage ? 'vision' : 'text',
        deadlineAtMs,
      });
      const promptText = lastUser?.content || input.messages.map((m) => m.content).join('\n');

      let uploadedVisionMedia: GradioFileData | undefined;
      if (hasVisionImage && lastUser?.imageBase64 && lastUser?.imageMimeType) {
        const ext = lastUser.imageMimeType.includes('png')
          ? 'png'
          : lastUser.imageMimeType.includes('webp')
            ? 'webp'
            : 'jpg';
        uploadedVisionMedia = await uploadMediaToGradioSpace(
          resolvedCtx,
          Buffer.from(lastUser.imageBase64, 'base64'),
          lastUser.imageMimeType,
          `vision.${ext}`,
          input.signal,
          deadlineAtMs,
        );
      }

      const historyMsgs = input.messages.slice(0, -1);
      const args = buildGradioInputPayload(
        resolvedCtx,
        promptText,
        input.systemPrompt,
        historyMsgs,
        uploadedVisionMedia,
        {
          mode: hasVisionImage ? 'vision' : 'text',
          mediaKind: hasVisionImage ? 'image' : undefined,
        },
      );

      let outputData: unknown[];
      try {
        const callRes = await runGradioSpaceCall(resolvedCtx, args, input.signal, deadlineAtMs);
        outputData = callRes.outputData;
      } catch (firstErr) {
        const isSchemaOrFormatErr =
          firstErr instanceof AIProviderError &&
          (firstErr.httpStatus === 400 ||
            firstErr.httpStatus === 422 ||
            firstErr.httpStatus === 500 ||
            (firstErr.code === 'PROVIDER_ERROR' && /Space error/i.test(firstErr.message)));
        const isNotFoundGradio =
          firstErr instanceof AIProviderError && firstErr.httpStatus === 404;

        // Auto-fallback to OpenAI /v1/chat/completions for Docker Spaces without Gradio endpoints
        if (isNotFoundGradio && deadlineAtMs - Date.now() > 4000) {
          const spaceHost =
            typeof resolvedCtx.modelParameters?.spaceHost === 'string' && resolvedCtx.modelParameters.spaceHost
              ? normalizeBaseUrl(resolvedCtx.modelParameters.spaceHost)
              : (await resolveHfSpaceRootUrl(ctx.baseUrl, ctx.apiKey, ctx.additionalHeaders)).resolvedRootUrl;
          return callOpenAiCompatibleSpaceText(resolvedCtx, input, spaceHost, deadlineAtMs);
        }

        if (!isSchemaOrFormatErr || deadlineAtMs - Date.now() < 5500) {
          throw firstErr;
        }

        resolvedCtx = await resolveGradioContext(ctx, input.signal, {
          forceRefresh: true,
          preferredKind: hasVisionImage ? 'vision' : 'text',
          deadlineAtMs,
        });
        const retryParams = Array.isArray(resolvedCtx.modelParameters?.parameters)
          ? (resolvedCtx.modelParameters.parameters as StoredGradioParamSpec[])
          : [];
        const hasMessagesBot = retryParams.some((p) => p.isChatbotMessages);
        const retryArgs = buildGradioInputPayload(
          resolvedCtx,
          promptText,
          input.systemPrompt,
          historyMsgs,
          uploadedVisionMedia,
          {
            mode: hasVisionImage ? 'vision' : 'text',
            mediaKind: hasVisionImage ? 'image' : undefined,
            chatHistoryFormat: hasMessagesBot ? 'tuples' : 'messages',
          },
        );
        const retryRes = await runGradioSpaceCall(resolvedCtx, retryArgs, input.signal, deadlineAtMs);
        outputData = retryRes.outputData;
      }

      const text = extractGradioOutputText(outputData).trim();
      const inTok = estimateTokensRough(input.messages.map((m) => m.content).join('\n'));
      const outTok = estimateTokensRough(text);
      if (input.onChunk && text) {
        await input.onChunk(text);
      }
      return {
        text: text || 'پاسخی از مدل دریافت نشد. لطفاً دوباره تلاش کنید.',
        inputTokens: inTok,
        outputTokens: outTok,
        costUsd: 0,
      };
    }

    if (ctx.providerType === 'cloudflare_workers_ai') {
      const messagesPayload: Array<{ role: string; content: string }> = [];
      if (input.systemPrompt) {
        messagesPayload.push({ role: 'system', content: input.systemPrompt });
      }
      for (const m of input.messages) {
        if (m.role === 'system') continue;
        messagesPayload.push({ role: m.role, content: m.content });
      }

      const payload: Record<string, unknown> = {
        messages: messagesPayload,
        max_tokens: Math.min(input.maxTokens ?? ctx.maxOutputSize ?? 2048, 4096),
      };
      const tempVal = input.temperature ?? (ctx.modelParameters?.temperature as number | undefined);
      if (typeof tempVal === 'number') payload.temperature = tempVal;

      const extractCfText = (raw: unknown): string => {
        if (typeof raw === 'string') return raw.trim();
        if (!raw || typeof raw !== 'object') return '';
        const obj = raw as {
          response?: unknown;
          result?: { response?: unknown; choices?: Array<{ message?: { content?: string } }> };
          choices?: Array<{ message?: { content?: string } }>;
        };
        if (typeof obj.response === 'string') return obj.response.trim();
        if (typeof obj.result?.response === 'string') return obj.result.response.trim();
        const choiceText =
          obj.choices?.[0]?.message?.content ?? obj.result?.choices?.[0]?.message?.content;
        return typeof choiceText === 'string' ? choiceText.trim() : '';
      };

      const aiBinding = getCloudflareAiBinding();
      let rawResp: unknown;
      if (aiBinding) {
        rawResp = await aiBinding.run(ctx.modelIdentifier, payload);
      } else {
        const accountId = (ctx.organizationId ?? '').trim();
        if (!accountId || !ctx.apiKey.trim()) {
          throw new AIProviderError({
            code: 'INVALID_API_KEY',
            message: 'Cloudflare Workers AI requires native Worker binding or Account ID + API Token.',
            userMessageFa: 'این مدل در حال حاضر در دسترس نیست. لطفاً مدل دیگری انتخاب کنید.',
            retryable: false,
          });
        }
        const restBase = normalizeBaseUrl(ctx.baseUrl || 'https://api.cloudflare.com/client/v4').replace(/\/accounts\/.+$/i, '');
        const restUrl = `${restBase}/accounts/${encodeURIComponent(accountId)}/ai/run/${ctx.modelIdentifier}`;
        const res = await fetchWithTimeout(
          restUrl,
          {
            method: 'POST',
            headers: mergeHeaders(
              { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.apiKey}` },
              ctx.additionalHeaders,
            ),
            body: JSON.stringify(payload),
          },
          60000,
          input.signal,
        );
        if (!res.ok) {
          throw classifyHttpError(res.status, await res.text(), ctx.apiKey, ctx.modelIdentifier);
        }
        rawResp = await res.json();
      }

      const text = extractCfText(rawResp);
      const inTok = estimateTokensRough(input.messages.map((m) => m.content).join('\n'));
      const outTok = estimateTokensRough(text);
      if (input.onChunk && text) {
        await input.onChunk(text);
      }
      return {
        text: text || 'پاسخی از مدل دریافت نشد. لطفاً دوباره تلاش کنید.',
        inputTokens: inTok,
        outputTokens: outTok,
        costUsd: 0,
      };
    }

    throw new AIProviderError({
      code: 'UNSUPPORTED_CAPABILITY',
      message: `Provider type ${ctx.providerType} does not support text/chat completion.`,
      userMessageFa: 'این مدل از گفتگوی متنی پشتیبانی نمی‌کند. لطفاً مدل دیگری انتخاب کنید.',
    });
  } catch (err) {
    throw wrapNetworkError(err, ctx.apiKey);
  }
}

export async function generateTextWithRoute(
  route: LoadedModelRoute,
  input: TextGenerationInput,
  requiredCap: 'text_generation' | 'chat' = 'chat',
): Promise<{ result: TextGenerationOutput; usedFallback: boolean; providerId: string }> {
  const hasCap =
    route.primary.supportedCapabilities.includes(requiredCap) ||
    route.primary.supportedCapabilities.includes('text_generation') ||
    route.primary.supportedCapabilities.includes('chat');
  if (!hasCap) {
    assertCapabilitySupported(route.primary, requiredCap);
  }
  return runWithFailover(route, (ctx) => executeTextOnProvider(ctx, input));
}

// =============================================================================
// 2. VISION ANALYSIS
// =============================================================================

export async function analyzeVisionWithRoute(
  route: LoadedModelRoute,
  input: VisionAnalysisInput,
): Promise<{ result: TextGenerationOutput; usedFallback: boolean; providerId: string }> {
  assertCapabilitySupported(route.primary, 'vision');
  if (isAiMockModeEnabled()) {
    return {
      result: await runMockVisionAnalysis(route.primary, input),
      usedFallback: false,
      providerId: route.primary.providerId,
    };
  }
  return runWithFailover(route, (ctx) =>
    executeTextOnProvider(ctx, {
      systemPrompt: input.systemPrompt,
      messages: [
        {
          role: 'user',
          content: input.prompt,
          imageBase64: input.imageBase64,
          imageMimeType: input.mimeType,
        },
      ],
      signal: input.signal,
    }),
  );
}

// =============================================================================
// 3. IMAGE GENERATION & IMAGE EDITING (STRICT CAPABILITY SEPARATION)
// =============================================================================

async function downloadBinarySafe(
  url: string,
  apiKey: string,
  attachBearerAuth = false,
  timeoutMs = 45000,
  signal?: AbortSignal,
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (url.startsWith('data:')) {
    const match = /^data:([^;]+);base64,(.+)$/s.exec(url);
    if (match?.[2]) {
      return {
        buffer: Buffer.from(match[2], 'base64'),
        mimeType: match[1] || 'application/octet-stream',
      };
    }
  }
  const headers: Record<string, string> = {};
  if (attachBearerAuth && apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  let res = await fetchWithTimeout(url, { method: 'GET', headers }, timeoutMs, signal);

  // Presigned S3/R2/CloudFront media URLs reject extra Authorization headers; retry once cleanly without auth
  if (
    !res.ok &&
    attachBearerAuth &&
    headers.Authorization &&
    (res.status === 400 || res.status === 401 || res.status === 403)
  ) {
    let isHfHost = false;
    try {
      const host = new URL(url).hostname.toLowerCase();
      isHfHost = host.endsWith('.hf.space') || host.endsWith('huggingface.co');
    } catch {
      isHfHost = false;
    }
    if (!isHfHost) {
      res = await fetchWithTimeout(url, { method: 'GET' }, timeoutMs, signal);
    }
  }

  if (!res.ok) {
    throw classifyHttpError(res.status, await res.text(), apiKey);
  }
  let mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || '';
  if (!mimeType || mimeType === 'application/octet-stream' || mimeType === 'binary/octet-stream') {
    const cleanUrl = url.split('?')[0]?.toLowerCase() ?? '';
    if (cleanUrl.endsWith('.mp4') || cleanUrl.endsWith('.m4v')) mimeType = 'video/mp4';
    else if (cleanUrl.endsWith('.webm')) mimeType = 'video/webm';
    else if (cleanUrl.endsWith('.mov')) mimeType = 'video/quicktime';
    else if (cleanUrl.endsWith('.mp3')) mimeType = 'audio/mpeg';
    else if (cleanUrl.endsWith('.wav')) mimeType = 'audio/wav';
    else if (cleanUrl.endsWith('.ogg') || cleanUrl.endsWith('.opus')) mimeType = 'audio/ogg';
    else if (cleanUrl.endsWith('.flac')) mimeType = 'audio/flac';
    else if (cleanUrl.endsWith('.jpg') || cleanUrl.endsWith('.jpeg')) mimeType = 'image/jpeg';
    else if (cleanUrl.endsWith('.webp')) mimeType = 'image/webp';
    else mimeType = 'image/png';
  }
  const arrayBuf = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuf), mimeType };
}

async function pollReplicatePrediction(
  baseUrl: string,
  predictionId: string,
  apiKey: string,
  extraHeaders?: Record<string, string>,
  maxWaitMs = 90000,
): Promise<{ status: string; output: unknown; error?: string }> {
  const started = Date.now();
  const pollUrl = `${normalizeBaseUrl(baseUrl)}/v1/predictions/${predictionId}`;
  while (Date.now() - started < maxWaitMs) {
    const res = await fetchWithTimeout(
      pollUrl,
      {
        method: 'GET',
        headers: mergeHeaders({ Authorization: `Bearer ${apiKey}` }, extraHeaders),
      },
      20000,
    );
    if (!res.ok) throw classifyHttpError(res.status, await res.text(), apiKey);
    const json = (await res.json()) as { status: string; output: unknown; error?: string };
    if (json.status === 'succeeded' || json.status === 'failed' || json.status === 'canceled') {
      return json;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new AIProviderError({
    code: 'TIMEOUT',
    message: 'Replicate prediction timed out.',
    userMessageFa: 'تولید رسانه بیش از حد مجاز طول کشید. اعتبار شما کسر نشد.',
    retryable: true,
  });
}

async function executeImageGenOnProvider(
  ctx: ProviderExecutionContext,
  input: ImageGenerationInput,
): Promise<ImageOutput> {
  if (isAiMockModeEnabled()) {
    return runMockImageGeneration(ctx, input);
  }

  try {
    if (ctx.providerType === 'google_gemini') {
      const root = normalizeGeminiRootBaseUrl(ctx.baseUrl);
      const modelId = normalizeGeminiModelId(ctx.modelIdentifier);
      const lowerModel = modelId.toLowerCase();
      const encodedModel = encodeURIComponent(modelId);
      const headers = buildGeminiHeaders(ctx);

      // Imagen models use :predict instead of :generateContent
      if (/^imagen-/i.test(lowerModel) || lowerModel.includes('/imagen-')) {
        const predictUrl = `${root}/v1beta/models/${encodedModel}:predict`;
        const parameters: Record<string, unknown> = {
          sampleCount: Math.min(Math.max(input.count ?? 1, 1), 4),
        };
        if (input.aspectRatio && ['1:1', '3:4', '4:3', '9:16', '16:9'].includes(input.aspectRatio)) {
          parameters.aspectRatio = input.aspectRatio;
        }
        const res = await fetchWithTimeout(
          predictUrl,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              instances: [{ prompt: input.prompt }],
              parameters,
            }),
          },
          90000,
          input.signal,
        );
        if (!res.ok) {
          throw classifyHttpError(res.status, await res.text(), ctx.apiKey, modelId);
        }
        const json = (await res.json()) as {
          predictions?: Array<{
            bytesBase64Encoded?: string;
            mimeType?: string;
            raiFilteredReason?: string;
          }>;
        };
        const images: ImageOutput['images'] = [];
        for (const pred of json.predictions ?? []) {
          if (pred.bytesBase64Encoded) {
            const mime = pred.mimeType ?? 'image/png';
            images.push({
              buffer: Buffer.from(pred.bytesBase64Encoded, 'base64'),
              mimeType: mime,
              extension: mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png',
            });
          }
        }
        if (images.length === 0) {
          const filterReason = json.predictions?.find((p) => p.raiFilteredReason)?.raiFilteredReason;
          throw new AIProviderError({
            code: filterReason ? 'INVALID_PROMPT' : 'PROVIDER_ERROR',
            message: filterReason
              ? `Imagen blocked prompt: ${filterReason}`
              : 'Imagen returned no generated image bytes.',
            userMessageFa: filterReason
              ? 'درخواست تولید تصویر با قوانین ایمنی مدل سازگار نبود. لطفاً متن دیگری بنویسید.'
              : 'تصویری تولید نشد. لطفاً متن خود را تغییر داده و دوباره تلاش کنید.',
          });
        }
        return { images, costUsd: 0.04 * images.length };
      }

      // Gemini Native Image Generation (gemini-2.5-flash-image, gemini-2.0-flash-preview-image-generation, gemini-3-pro-image-preview, etc.)
      const url = `${root}/v1beta/models/${encodedModel}:generateContent`;
      const supportsImageSize = lowerModel.includes('gemini-3') || lowerModel.includes('pro-image');
      const imageConfig: Record<string, unknown> = {};
      if (input.aspectRatio) imageConfig.aspectRatio = input.aspectRatio;
      if (
        supportsImageSize &&
        input.resolution &&
        ['1K', '2K', '4K'].includes(input.resolution.toUpperCase())
      ) {
        imageConfig.imageSize = input.resolution.toUpperCase();
      }

      const buildGenImageBody = (withImageConfig: boolean) => ({
        contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
        generationConfig: {
          responseModalities: ['IMAGE', 'TEXT'],
          ...(withImageConfig && Object.keys(imageConfig).length > 0 ? { imageConfig } : {}),
        },
      });

      let res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(buildGenImageBody(true)),
        },
        90000,
        input.signal,
      );

      // Retry without imageConfig if the specific Gemini image variant doesn't accept aspectRatio/imageSize
      if (!res.ok && res.status === 400 && Object.keys(imageConfig).length > 0) {
        const errBody = await res.text();
        if (/imageConfig|image_size|imageSize|aspectRatio|aspect_ratio|Unknown name/i.test(errBody)) {
          res = await fetchWithTimeout(
            url,
            {
              method: 'POST',
              headers,
              body: JSON.stringify(buildGenImageBody(false)),
            },
            90000,
            input.signal,
          );
          if (!res.ok) {
            throw classifyHttpError(res.status, await res.text(), ctx.apiKey, modelId);
          }
        } else {
          throw classifyHttpError(res.status, errBody, ctx.apiKey, modelId);
        }
      } else if (!res.ok) {
        throw classifyHttpError(res.status, await res.text(), ctx.apiKey, modelId);
      }

      const json = (await res.json()) as GeminiGenerateContentResponse;
      assertGeminiNotBlocked(json, true);
      const images = extractGeminiCandidateImages(json.candidates);
      if (images.length === 0) {
        const textHint = extractGeminiCandidateText(json.candidates).trim();
        throw new AIProviderError({
          code: 'PROVIDER_ERROR',
          message: textHint
            ? `Gemini returned text instead of image: ${textHint.slice(0, 180)}`
            : 'Gemini returned no image parts.',
          userMessageFa: 'مدل تصویری خروجی تصویر تولید نکرد. لطفاً پرامپت را تغییر دهید.',
        });
      }
      return { images, costUsd: 0.03 * images.length };
    }

    if (ctx.providerType === 'openai_compatible' || ctx.providerType === 'custom') {
      const url = `${normalizeOpenAiRootBaseUrl(ctx.baseUrl)}/images/generations`;
      const lowerModel = ctx.modelIdentifier.toLowerCase();
      const isDalle3 = lowerModel.includes('dall-e-3');
      const isDalle2 = lowerModel.includes('dall-e-2');
      const sizeMap: Record<string, string> = isDalle2
        ? {
            '1:1': '1024x1024',
            '16:9': '1024x1024',
            '9:16': '1024x1024',
            '4:3': '1024x1024',
            '3:4': '1024x1024',
          }
        : isDalle3
          ? {
              '1:1': '1024x1024',
              '16:9': '1792x1024',
              '9:16': '1024x1792',
              '4:3': '1024x1024',
              '3:4': '1024x1792',
            }
          : {
              '1:1': '1024x1024',
              '16:9': '1536x1024',
              '9:16': '1024x1536',
              '4:3': '1024x1024',
              '3:4': '1024x1536',
            };
      const size =
        input.resolution && /^\d+x\d+$/.test(input.resolution)
          ? input.resolution
          : sizeMap[input.aspectRatio ?? '1:1'] ?? '1024x1024';

      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: mergeHeaders(
            { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.apiKey}` },
            ctx.additionalHeaders,
          ),
          body: JSON.stringify({
            model: ctx.modelIdentifier,
            prompt: input.prompt,
            n: isDalle3 ? 1 : Math.min(Math.max(input.count ?? 1, 1), 4),
            size,
          }),
        },
        90000,
        input.signal,
      );
      if (!res.ok) throw classifyHttpError(res.status, await res.text(), ctx.apiKey, ctx.modelIdentifier);
      const json = (await res.json()) as {
        data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
      };
      const images: ImageOutput['images'] = [];
      for (const item of json.data ?? []) {
        if (item.b64_json) {
          images.push({
            buffer: Buffer.from(item.b64_json, 'base64'),
            mimeType: 'image/png',
            extension: 'png',
            revisedPrompt: item.revised_prompt,
          });
        } else if (item.url) {
          const dl = await downloadBinarySafe(item.url, ctx.apiKey);
          images.push({
            buffer: dl.buffer,
            mimeType: dl.mimeType,
            extension: dl.mimeType.includes('jpeg') ? 'jpg' : 'png',
            revisedPrompt: item.revised_prompt,
          });
        }
      }
      if (images.length === 0) {
        throw new AIProviderError({
          code: 'PROVIDER_ERROR',
          message: 'OpenAI images/generations returned empty data.',
          userMessageFa: 'تصویری توسط ارائه‌دهنده بازگردانده نشد.',
        });
      }
      return { images, costUsd: 0.04 * images.length };
    }

    if (ctx.providerType === 'replicate') {
      const url = `${normalizeBaseUrl(ctx.baseUrl)}/v1/models/${ctx.modelIdentifier}/predictions`;
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: mergeHeaders(
            {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${ctx.apiKey}`,
              Prefer: 'wait=30',
            },
            ctx.additionalHeaders,
          ),
          body: JSON.stringify({
            input: {
              prompt: input.prompt,
              aspect_ratio: input.aspectRatio ?? '1:1',
              num_outputs: Math.min(Math.max(input.count ?? 1, 1), 4),
              ...(ctx.modelParameters ?? {}),
            },
          }),
        },
        45000,
        input.signal,
      );
      if (!res.ok) throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
      let pred = (await res.json()) as { id: string; status: string; output?: unknown; error?: string };
      if (pred.status !== 'succeeded' && pred.status !== 'failed') {
        pred = { id: pred.id, ...(await pollReplicatePrediction(ctx.baseUrl, pred.id, ctx.apiKey, ctx.additionalHeaders)) };
      }
      if (pred.status !== 'succeeded') {
        throw new AIProviderError({
          code: 'PROVIDER_ERROR',
          message: `Replicate failed: ${pred.error ?? pred.status}`,
          userMessageFa: 'تولید تصویر با خطا مواجه شد. لطفاً دوباره تلاش کنید.',
        });
      }
      const urls = Array.isArray(pred.output)
        ? pred.output.filter((u): u is string => typeof u === 'string')
        : typeof pred.output === 'string'
          ? [pred.output]
          : [];
      const images: ImageOutput['images'] = [];
      for (const imgUrl of urls) {
        const dl = await downloadBinarySafe(imgUrl, ctx.apiKey);
        images.push({
          buffer: dl.buffer,
          mimeType: dl.mimeType,
          extension: dl.mimeType.includes('webp') ? 'webp' : dl.mimeType.includes('jpeg') ? 'jpg' : 'png',
        });
      }
      return { images, costUsd: 0.03 * Math.max(1, images.length) };
    }

    if (ctx.providerType === 'fal_ai') {
      const falHost = ctx.baseUrl.includes('fal.run')
        ? normalizeBaseUrl(ctx.baseUrl)
        : 'https://fal.run';
      const url = `${falHost}/${ctx.modelIdentifier.replace(/^\/+/, '')}`;
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: mergeHeaders(
            {
              'Content-Type': 'application/json',
              Authorization: `Key ${ctx.apiKey}`,
            },
            ctx.additionalHeaders,
          ),
          body: JSON.stringify({
            prompt: input.prompt,
            num_images: Math.min(Math.max(input.count ?? 1, 1), 4),
            aspect_ratio: input.aspectRatio ?? '1:1',
            ...(ctx.modelParameters ?? {}),
          }),
        },
        90000,
        input.signal,
      );
      if (!res.ok) throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
      const json = (await res.json()) as { images?: Array<{ url?: string; content_type?: string }> };
      const images: ImageOutput['images'] = [];
      for (const img of json.images ?? []) {
        if (!img.url) continue;
        const dl = await downloadBinarySafe(img.url, ctx.apiKey);
        images.push({
          buffer: dl.buffer,
          mimeType: img.content_type || dl.mimeType,
          extension: dl.mimeType.includes('jpeg') ? 'jpg' : 'png',
        });
      }
      return { images, costUsd: 0.03 * Math.max(1, images.length) };
    }

    if (ctx.providerType === 'huggingface' && !isHuggingFaceSpaceContext(ctx)) {
      const routerRoot = resolveHuggingFaceRouterRoot(ctx.baseUrl);
      const hfRepoId = extractHuggingFaceRepoFromUrl(ctx.modelIdentifier) ?? ctx.modelIdentifier.replace(/^\/+/, '');
      const url = `${routerRoot}/hf-inference/models/${hfRepoId}`;
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: mergeHeaders(
            {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${ctx.apiKey}`,
              Accept: 'image/png',
            },
            ctx.additionalHeaders,
          ),
          body: JSON.stringify({
            inputs: input.prompt,
            parameters: { ...(ctx.modelParameters ?? {}) },
          }),
        },
        90000,
        input.signal,
      );
      if (!res.ok) throw classifyHttpError(res.status, await res.text(), ctx.apiKey, hfRepoId);
      const contentType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
      if (contentType.includes('application/json')) {
        const jsonBody = (await res.json()) as {
          error?: string;
          image?: string;
          url?: string;
          data?: Array<{ b64_json?: string; url?: string }>;
        };
        if (jsonBody.error) {
          throw classifyHttpError(502, jsonBody.error, ctx.apiKey);
        }
        if (jsonBody.image) {
          return {
            images: [{ buffer: Buffer.from(jsonBody.image, 'base64'), mimeType: 'image/png', extension: 'png' }],
            costUsd: 0.02,
          };
        }
        if (jsonBody.url) {
          const dl = await downloadBinarySafe(jsonBody.url, ctx.apiKey, true);
          return {
            images: [{ buffer: dl.buffer, mimeType: dl.mimeType, extension: dl.mimeType.includes('jpeg') ? 'jpg' : 'png' }],
            costUsd: 0.02,
          };
        }
        const firstData = jsonBody.data?.[0];
        if (firstData?.b64_json) {
          return {
            images: [{ buffer: Buffer.from(firstData.b64_json, 'base64'), mimeType: 'image/png', extension: 'png' }],
            costUsd: 0.02,
          };
        }
        if (firstData?.url) {
          const dl = await downloadBinarySafe(firstData.url, ctx.apiKey, true);
          return {
            images: [{ buffer: dl.buffer, mimeType: dl.mimeType, extension: dl.mimeType.includes('jpeg') ? 'jpg' : 'png' }],
            costUsd: 0.02,
          };
        }
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      return {
        images: [
          {
            buffer,
            mimeType: contentType.startsWith('image/') ? contentType : 'image/png',
            extension: contentType.includes('jpeg') ? 'jpg' : contentType.includes('webp') ? 'webp' : 'png',
          },
        ],
        costUsd: 0.02,
      };
    }

    if (ctx.providerType === 'cloudflare_workers_ai') {
      const modelId = ctx.modelIdentifier.trim();
      const lowerModel = modelId.toLowerCase();
      const dimMap: Record<string, { width: number; height: number }> = {
        '1:1': { width: 1024, height: 1024 },
        '16:9': { width: 1024, height: 576 },
        '9:16': { width: 576, height: 1024 },
        '4:3': { width: 1024, height: 768 },
        '3:4': { width: 768, height: 1024 },
      };
      const dims = dimMap[input.aspectRatio ?? '1:1'] ?? { width: 1024, height: 1024 };

      const payload: Record<string, unknown> = lowerModel.includes('flux-1-schnell')
        ? {
            prompt: input.prompt,
            steps: Math.min(Math.max(Number(ctx.modelParameters?.steps ?? 4), 1), 8),
          }
        : {
            prompt: input.prompt,
            width: dims.width,
            height: dims.height,
          };

      const detectImageFormat = (buf: Buffer): { mimeType: string; extension: string } => {
        if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
          return { mimeType: 'image/png', extension: 'png' };
        }
        if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
          return { mimeType: 'image/jpeg', extension: 'jpg' };
        }
        if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'RIFF') {
          return { mimeType: 'image/webp', extension: 'webp' };
        }
        return { mimeType: 'image/png', extension: 'png' };
      };

      const decodeCfImageOutput = async (raw: unknown): Promise<{ buffer: Buffer; mimeType: string; extension: string }> => {
        if (raw instanceof Uint8Array) {
          const buffer = Buffer.from(raw);
          return { buffer, ...detectImageFormat(buffer) };
        }
        if (raw instanceof ArrayBuffer) {
          const buffer = Buffer.from(raw);
          return { buffer, ...detectImageFormat(buffer) };
        }
        if (raw && typeof raw === 'object' && 'arrayBuffer' in raw && typeof (raw as Response).arrayBuffer === 'function') {
          const buffer = Buffer.from(await (raw as Response).arrayBuffer());
          return { buffer, ...detectImageFormat(buffer) };
        }
        if (raw && typeof raw === 'object' && 'getReader' in raw && typeof (raw as ReadableStream).getReader === 'function') {
          const reader = (raw as ReadableStream<Uint8Array>).getReader();
          const chunks: Uint8Array[] = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
          }
          const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
          return { buffer, ...detectImageFormat(buffer) };
        }
        if (raw && typeof raw === 'object') {
          const obj = raw as { image?: unknown; result?: { image?: unknown } };
          const b64 = typeof obj.image === 'string' ? obj.image : typeof obj.result?.image === 'string' ? obj.result.image : null;
          if (b64) {
            const buffer = Buffer.from(b64, 'base64');
            return { buffer, ...detectImageFormat(buffer) };
          }
        }
        throw new AIProviderError({
          code: 'PROVIDER_ERROR',
          message: 'Cloudflare Workers AI returned no recognizable image output.',
          userMessageFa: 'خروجی تصویر معتبری دریافت نشد. لطفاً دوباره تلاش کنید.',
        });
      };

      const aiBinding = getCloudflareAiBinding();
      if (aiBinding) {
        const rawOut = await aiBinding.run(modelId, payload);
        const decoded = await decodeCfImageOutput(rawOut);
        if (decoded.buffer.byteLength === 0) {
          throw new AIProviderError({
            code: 'PROVIDER_ERROR',
            message: 'Cloudflare Workers AI returned empty image buffer.',
            userMessageFa: 'تصویر خروجی خالی بود. لطفاً دوباره تلاش کنید.',
          });
        }
        return {
          images: [decoded],
          costUsd: 0,
        };
      }

      const accountId = (ctx.organizationId ?? '').trim();
      if (!accountId || !ctx.apiKey.trim()) {
        throw new AIProviderError({
          code: 'INVALID_API_KEY',
          message: 'Cloudflare Workers AI requires native Worker binding or Account ID + API Token.',
          userMessageFa: 'این مدل در حال حاضر در دسترس نیست. لطفاً مدل دیگری انتخاب کنید.',
          retryable: false,
        });
      }

      const restBase = normalizeBaseUrl(ctx.baseUrl || 'https://api.cloudflare.com/client/v4').replace(/\/accounts\/.+$/i, '');
      const restUrl = `${restBase}/accounts/${encodeURIComponent(accountId)}/ai/run/${modelId}`;
      const res = await fetchWithTimeout(
        restUrl,
        {
          method: 'POST',
          headers: mergeHeaders(
            { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.apiKey}` },
            ctx.additionalHeaders,
          ),
          body: JSON.stringify(payload),
        },
        90000,
        input.signal,
      );
      if (!res.ok) {
        throw classifyHttpError(res.status, await res.text(), ctx.apiKey, modelId);
      }

      const contentType = res.headers.get('content-type')?.split(';')[0]?.trim() || '';
      if (contentType.includes('application/json')) {
        const jsonBody = await res.json();
        const decoded = await decodeCfImageOutput(jsonBody);
        return { images: [decoded], costUsd: 0 };
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      return {
        images: [{ buffer, ...detectImageFormat(buffer) }],
        costUsd: 0,
      };
    }

    if (isHuggingFaceSpaceContext(ctx)) {
      const outcome = await executeHfSpaceImageInternal(ctx, {
        prompt: input.prompt,
        mode: 'generate',
        aspectRatio: input.aspectRatio,
        signal: input.signal,
        allowPending: false,
      });
      if (outcome.kind === 'complete') return outcome.output;
      throw new AIProviderError({
        code: 'TIMEOUT',
        message: 'Hugging Face Space SSE queue timed out before completion.',
        userMessageFa:
          'زمان پاسخ‌گویی این مدل به پایان رسید (صف شلوغ است). اعتبار شما بازگردانده شد؛ لطفاً دوباره تلاش کنید یا مدل دیگری انتخاب نمایید.',
        retryable: true,
        credentialFailureKind: 'transient',
      });
    }

    throw new AIProviderError({
      code: 'UNSUPPORTED_CAPABILITY',
      message: `Provider ${ctx.providerType} does not support image generation.`,
      userMessageFa: 'این مدل از تولید تصویر پشتیبانی نمی‌کند. لطفاً مدل دیگری انتخاب کنید.',
    });
  } catch (err) {
    throw wrapNetworkError(err, ctx.apiKey);
  }
}

export type ImageJobOutcome =
  | { kind: 'complete'; result: ImageOutput; usedFallback: boolean; providerId: string }
  | {
      kind: 'pending';
      providerJobId: string;
      progressPercent: number;
      providerId: string;
      usedFallback: boolean;
      metadata: Record<string, unknown>;
    };

export interface MediaJobPollOutput {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  progressPercent: number;
  images?: ImageOutput['images'];
  errorMessage?: string;
  costUsd?: number;
}

type InternalHfImageOutcome =
  | { kind: 'complete'; output: ImageOutput }
  | {
      kind: 'pending';
      providerJobId: string;
      progressPercent: number;
      metadata: Record<string, unknown>;
    };

async function executeHfSpaceImageInternal(
  ctx: ProviderExecutionContext,
  params: {
    prompt: string;
    mode: 'generate' | 'edit' | 'variation';
    sourceImageBuffer?: Buffer;
    sourceMimeType?: string;
    aspectRatio?: string;
    signal?: AbortSignal;
    allowPending: boolean;
    syncWaitCapMs?: number;
  },
): Promise<InternalHfImageOutcome> {
  const preferredKind: GradioPreferredKind = params.mode === 'generate' ? 'image_generate' : 'image_edit';
  let deadlineAtMs = createHfDeadline('sync', ctx);
  if (typeof params.syncWaitCapMs === 'number' && params.syncWaitCapMs > 0) {
    deadlineAtMs = Math.min(deadlineAtMs, Date.now() + params.syncWaitCapMs);
  }

  let resolvedCtx = await resolveGradioContext(ctx, params.signal, {
    preferredKind,
    deadlineAtMs,
  });

  let uploadedImg: GradioFileData | undefined;
  if (params.sourceImageBuffer) {
    const srcMime = params.sourceMimeType || 'image/jpeg';
    const ext = srcMime.includes('png') ? 'png' : srcMime.includes('webp') ? 'webp' : 'jpg';
    uploadedImg = await uploadMediaToGradioSpace(
      resolvedCtx,
      params.sourceImageBuffer,
      srcMime,
      `source.${ext}`,
      params.signal,
      deadlineAtMs,
    );
  }

  const promptText =
    params.mode === 'variation'
      ? `Create a stylized variation. ${params.prompt || ''}`.trim()
      : params.prompt;

  const buildArgs = (targetCtx: ProviderExecutionContext) =>
    buildGradioInputPayload(targetCtx, promptText, undefined, undefined, uploadedImg, {
      aspectRatio: params.aspectRatio,
      mode: params.mode,
      ...(params.mode !== 'generate' ? { mediaKind: 'image' as const } : {}),
    });

  let submitted: GradioSubmitResult;
  try {
    submitted = await submitGradioSpaceCall(resolvedCtx, buildArgs(resolvedCtx), params.signal, deadlineAtMs);
  } catch (firstErr) {
    const isSchemaErr =
      firstErr instanceof AIProviderError &&
      (firstErr.httpStatus === 422 || firstErr.httpStatus === 400 || firstErr.httpStatus === 500);
    if (!isSchemaErr || deadlineAtMs - Date.now() < 5000) throw firstErr;
    resolvedCtx = await resolveGradioContext(ctx, params.signal, {
      forceRefresh: true,
      preferredKind,
      deadlineAtMs,
    });
    submitted = await submitGradioSpaceCall(resolvedCtx, buildArgs(resolvedCtx), params.signal, deadlineAtMs);
  }

  const extractAndDownloadImage = async (
    outputData: unknown[],
    spaceHost: string,
    endpointPrefix: string,
  ): Promise<ImageOutput> => {
    const mediaUrl = extractGradioMediaUrl(outputData, spaceHost, 'image', endpointPrefix);
    if (!mediaUrl) {
      throw new AIProviderError({
        code: 'PROVIDER_ERROR',
        message:
          params.mode === 'generate'
            ? 'Hugging Face Space returned no image output.'
            : 'Hugging Face Space returned no edited image.',
        userMessageFa:
          params.mode === 'generate'
            ? 'تصویری تولید نشد. لطفاً دوباره تلاش کنید.'
            : 'ویرایش تصویر نتیجه‌ای برنگرداند. لطفاً دوباره تلاش کنید.',
      });
    }
    const dl = await downloadBinarySafe(
      mediaUrl,
      resolvedCtx.apiKey,
      true,
      getRemainingBudgetMs(deadlineAtMs, 20_000, 5000),
      params.signal,
    );
    return {
      images: [
        {
          buffer: dl.buffer,
          mimeType: dl.mimeType,
          extension: dl.mimeType.includes('jpeg') ? 'jpg' : dl.mimeType.includes('webp') ? 'webp' : 'png',
        },
      ],
      costUsd: 0,
    };
  };

  if (submitted.kind === 'immediate') {
    const output = await extractAndDownloadImage(
      submitted.outputData,
      submitted.spaceHost,
      submitted.endpointPrefix,
    );
    return { kind: 'complete', output };
  }

  const hfMetadata: Record<string, unknown> = {
    kind: 'hf_space_gradio_media',
    expectedMedia: 'image',
    callUrl: submitted.callUrl,
    spaceHost: submitted.spaceHost,
    endpointPrefix: submitted.endpointPrefix,
    credentialId: ctx.credentialId ?? null,
    aspectRatio: params.aspectRatio ?? '1:1',
    modelName: ctx.modelName,
  };

  const attemptRemainingMs =
    typeof attemptBudgetAls.getStore()?.deadlineAtMs === 'number'
      ? attemptBudgetAls.getStore()!.deadlineAtMs! - Date.now()
      : deadlineAtMs - Date.now();

  if (params.allowPending && attemptRemainingMs < 1500) {
    return {
      kind: 'pending',
      providerJobId: submitted.eventId,
      progressPercent: 25,
      metadata: hfMetadata,
    };
  }

  // Check if we still have enough time to wait briefly on SSE for quick Spaces
  const sseResult = await readGradioSpaceSse({
    callUrl: submitted.callUrl,
    eventId: submitted.eventId,
    apiKey: resolvedCtx.apiKey,
    additionalHeaders: resolvedCtx.additionalHeaders,
    deadlineAtMs,
    signal: params.signal,
  });

  if (sseResult.status === 'complete') {
    const output = await extractAndDownloadImage(
      sseResult.outputData,
      submitted.spaceHost,
      submitted.endpointPrefix,
    );
    return { kind: 'complete', output };
  }

  if (params.allowPending) {
    return {
      kind: 'pending',
      providerJobId: submitted.eventId,
      progressPercent: 25,
      metadata: hfMetadata,
    };
  }

  throw new AIProviderError({
    code: 'TIMEOUT',
    message: 'Hugging Face Space SSE queue timed out before completion.',
    userMessageFa:
      'زمان پاسخ‌گویی این مدل به پایان رسید (صف شلوغ است). اعتبار شما بازگردانده شد؛ لطفاً دوباره تلاش کنید یا مدل دیگری انتخاب نمایید.',
    retryable: true,
    credentialFailureKind: 'transient',
  });
}

export async function generateImageWithRoute(
  route: LoadedModelRoute,
  input: ImageGenerationInput,
): Promise<{ result: ImageOutput; usedFallback: boolean; providerId: string }> {
  assertCapabilitySupported(route.primary, 'image_generation');
  return runWithFailover(route, (ctx) => executeImageGenOnProvider(ctx, input));
}

export async function startImageGenerationWithRoute(
  route: LoadedModelRoute,
  input: ImageGenerationInput,
  options?: { syncWaitCapMs?: number },
): Promise<ImageJobOutcome> {
  assertCapabilitySupported(route.primary, 'image_generation');
  const wrapped = await runWithFailover(route, async (ctx): Promise<InternalHfImageOutcome> => {
    if (!isAiMockModeEnabled() && isHuggingFaceSpaceContext(ctx)) {
      return executeHfSpaceImageInternal(ctx, {
        prompt: input.prompt,
        mode: 'generate',
        aspectRatio: input.aspectRatio,
        signal: input.signal,
        allowPending: true,
        syncWaitCapMs: options?.syncWaitCapMs,
      });
    }
    const output = await executeImageGenOnProvider(ctx, input);
    return { kind: 'complete', output };
  });

  if (wrapped.result.kind === 'pending') {
    return {
      kind: 'pending',
      providerJobId: wrapped.result.providerJobId,
      progressPercent: wrapped.result.progressPercent,
      providerId: wrapped.providerId,
      usedFallback: wrapped.usedFallback,
      metadata: wrapped.result.metadata,
    };
  }
  return {
    kind: 'complete',
    result: wrapped.result.output,
    usedFallback: wrapped.usedFallback,
    providerId: wrapped.providerId,
  };
}

async function executeImageEditOnProvider(
  ctx: ProviderExecutionContext,
  input: ImageEditInput,
): Promise<ImageOutput> {
  if (isAiMockModeEnabled()) {
    return runMockImageEdit(ctx, input);
  }

  try {
    if (ctx.providerType === 'google_gemini') {
      const root = normalizeGeminiRootBaseUrl(ctx.baseUrl);
      const modelId = normalizeGeminiModelId(ctx.modelIdentifier);
      const url = `${root}/v1beta/models/${encodeURIComponent(modelId)}:generateContent`;
      const promptText =
        input.mode === 'variation'
          ? `Create a high-quality visual variation of this image. ${input.prompt || ''}`.trim()
          : input.prompt;

      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: buildGeminiHeaders(ctx),
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    inlineData: {
                      data: input.sourceImageBuffer.toString('base64'),
                      mimeType: input.sourceMimeType,
                    },
                  },
                  { text: promptText },
                ],
              },
            ],
            generationConfig: {
              responseModalities: ['IMAGE', 'TEXT'],
            },
          }),
        },
        90000,
        input.signal,
      );
      if (!res.ok) {
        throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
      }
      const json = (await res.json()) as GeminiGenerateContentResponse;
      assertGeminiNotBlocked(json, true);
      const images = extractGeminiCandidateImages(json.candidates);
      if (images.length === 0) {
        throw new AIProviderError({
          code: 'PROVIDER_ERROR',
          message: 'Gemini image edit returned no image output.',
          userMessageFa: 'ویرایش تصویر نتیجه‌ای برنگرداند.',
        });
      }
      return { images, costUsd: 0.035 };
    }

    if (ctx.providerType === 'openai_compatible' || ctx.providerType === 'custom') {
      const endpoint = input.mode === 'variation' ? '/images/variations' : '/images/edits';
      const url = `${normalizeOpenAiRootBaseUrl(ctx.baseUrl)}${endpoint}`;
      const form = new FormData();
      form.append('model', ctx.modelIdentifier);
      if (input.mode === 'edit') {
        form.append('prompt', input.prompt);
      }
      form.append(
        'image',
        new Blob([new Uint8Array(input.sourceImageBuffer)], { type: input.sourceMimeType }),
        'source.png',
      );
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: mergeHeaders({ Authorization: `Bearer ${ctx.apiKey}` }, ctx.additionalHeaders),
          body: form,
        },
        90000,
        input.signal,
      );
      if (!res.ok) throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
      const json = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
      const images: ImageOutput['images'] = [];
      for (const item of json.data ?? []) {
        if (item.b64_json) {
          images.push({
            buffer: Buffer.from(item.b64_json, 'base64'),
            mimeType: 'image/png',
            extension: 'png',
          });
        } else if (item.url) {
          const dl = await downloadBinarySafe(item.url, ctx.apiKey);
          images.push({ buffer: dl.buffer, mimeType: dl.mimeType, extension: 'png' });
        }
      }
      return { images, costUsd: 0.04 };
    }

    if (ctx.providerType === 'replicate' || ctx.providerType === 'fal_ai') {
      const dataUri = `data:${input.sourceMimeType};base64,${input.sourceImageBuffer.toString('base64')}`;
      if (ctx.providerType === 'fal_ai') {
        const falHost = ctx.baseUrl.includes('fal.run') ? normalizeBaseUrl(ctx.baseUrl) : 'https://fal.run';
        const url = `${falHost}/${ctx.modelIdentifier.replace(/^\/+/, '')}`;
        const res = await fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: mergeHeaders(
              { 'Content-Type': 'application/json', Authorization: `Key ${ctx.apiKey}` },
              ctx.additionalHeaders,
            ),
            body: JSON.stringify({
              prompt: input.prompt || 'High quality variation',
              image_url: dataUri,
              ...(ctx.modelParameters ?? {}),
            }),
          },
          90000,
          input.signal,
        );
        if (!res.ok) throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
        const json = (await res.json()) as { images?: Array<{ url?: string }> };
        const images: ImageOutput['images'] = [];
        for (const item of json.images ?? []) {
          if (!item.url) continue;
          const dl = await downloadBinarySafe(item.url, ctx.apiKey);
          images.push({ buffer: dl.buffer, mimeType: dl.mimeType, extension: 'png' });
        }
        return { images, costUsd: 0.035 };
      }

      const url = `${normalizeBaseUrl(ctx.baseUrl)}/v1/models/${ctx.modelIdentifier}/predictions`;
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: mergeHeaders(
            {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${ctx.apiKey}`,
              Prefer: 'wait=30',
            },
            ctx.additionalHeaders,
          ),
          body: JSON.stringify({
            input: {
              prompt: input.prompt || 'Create a stylized variation',
              image: dataUri,
              ...(ctx.modelParameters ?? {}),
            },
          }),
        },
        45000,
        input.signal,
      );
      if (!res.ok) throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
      let pred = (await res.json()) as { id: string; status: string; output?: unknown; error?: string };
      if (pred.status !== 'succeeded' && pred.status !== 'failed') {
        pred = { id: pred.id, ...(await pollReplicatePrediction(ctx.baseUrl, pred.id, ctx.apiKey, ctx.additionalHeaders)) };
      }
      if (pred.status !== 'succeeded') {
        throw new AIProviderError({
          code: 'PROVIDER_ERROR',
          message: `Replicate image edit failed: ${pred.error ?? pred.status}`,
          userMessageFa: 'ویرایش تصویر با خطا مواجه شد. لطفاً دوباره تلاش کنید.',
        });
      }
      const urls = Array.isArray(pred.output)
        ? pred.output.filter((u): u is string => typeof u === 'string')
        : typeof pred.output === 'string'
          ? [pred.output]
          : [];
      const images: ImageOutput['images'] = [];
      for (const u of urls) {
        const dl = await downloadBinarySafe(u, ctx.apiKey);
        images.push({ buffer: dl.buffer, mimeType: dl.mimeType, extension: 'png' });
      }
      return { images, costUsd: 0.035 };
    }

    if (ctx.providerType === 'huggingface' && !isHuggingFaceSpaceContext(ctx)) {
      const routerRoot = resolveHuggingFaceRouterRoot(ctx.baseUrl);
      const url = `${routerRoot}/hf-inference/models/${ctx.modelIdentifier.replace(/^\/+/, '')}`;
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: mergeHeaders(
            {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${ctx.apiKey}`,
              Accept: 'image/png',
            },
            ctx.additionalHeaders,
          ),
          body: JSON.stringify({
            inputs: input.sourceImageBuffer.toString('base64'),
            parameters: {
              prompt:
                input.mode === 'variation'
                  ? `Create a high quality variation. ${input.prompt || ''}`.trim()
                  : input.prompt,
              ...(ctx.modelParameters ?? {}),
            },
          }),
        },
        90000,
        input.signal,
      );
      if (!res.ok) throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
      const contentType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
      const buffer = Buffer.from(await res.arrayBuffer());
      return {
        images: [
          {
            buffer,
            mimeType: contentType.startsWith('image/') ? contentType : 'image/png',
            extension: contentType.includes('jpeg') ? 'jpg' : 'png',
          },
        ],
        costUsd: 0.025,
      };
    }

    if (isHuggingFaceSpaceContext(ctx)) {
      const outcome = await executeHfSpaceImageInternal(ctx, {
        prompt: input.prompt,
        mode: input.mode,
        sourceImageBuffer: input.sourceImageBuffer,
        sourceMimeType: input.sourceMimeType,
        aspectRatio: input.aspectRatio,
        signal: input.signal,
        allowPending: false,
      });
      if (outcome.kind === 'complete') return outcome.output;
      throw new AIProviderError({
        code: 'TIMEOUT',
        message: 'Hugging Face Space SSE queue timed out before completion.',
        userMessageFa:
          'زمان پاسخ‌گویی این مدل به پایان رسید (صف شلوغ است). اعتبار شما بازگردانده شد؛ لطفاً دوباره تلاش کنید یا مدل دیگری انتخاب نمایید.',
        retryable: true,
        credentialFailureKind: 'transient',
      });
    }

    throw new AIProviderError({
      code: 'UNSUPPORTED_CAPABILITY',
      message: `Provider ${ctx.providerType} does not support image editing.`,
      userMessageFa: 'این مدل از ویرایش تصویر پشتیبانی نمی‌کند. لطفاً مدل دیگری انتخاب کنید.',
    });
  } catch (err) {
    throw wrapNetworkError(err, ctx.apiKey);
  }
}

export async function editImageWithRoute(
  route: LoadedModelRoute,
  input: ImageEditInput,
): Promise<{ result: ImageOutput; usedFallback: boolean; providerId: string }> {
  // Never fall back to an image_generation endpoint when image_editing/image_variation is required
  assertCapabilitySupported(
    route.primary,
    input.mode === 'variation' ? 'image_variation' : 'image_editing',
  );
  return runWithFailover(route, (ctx) => executeImageEditOnProvider(ctx, input));
}

export async function startImageEditWithRoute(
  route: LoadedModelRoute,
  input: ImageEditInput,
  options?: { syncWaitCapMs?: number },
): Promise<ImageJobOutcome> {
  assertCapabilitySupported(
    route.primary,
    input.mode === 'variation' ? 'image_variation' : 'image_editing',
  );
  const wrapped = await runWithFailover(route, async (ctx): Promise<InternalHfImageOutcome> => {
    if (!isAiMockModeEnabled() && isHuggingFaceSpaceContext(ctx)) {
      return executeHfSpaceImageInternal(ctx, {
        prompt: input.prompt,
        mode: input.mode,
        sourceImageBuffer: input.sourceImageBuffer,
        sourceMimeType: input.sourceMimeType,
        aspectRatio: input.aspectRatio,
        signal: input.signal,
        allowPending: true,
        syncWaitCapMs: options?.syncWaitCapMs,
      });
    }
    const output = await executeImageEditOnProvider(ctx, input);
    return { kind: 'complete', output };
  });

  if (wrapped.result.kind === 'pending') {
    return {
      kind: 'pending',
      providerJobId: wrapped.result.providerJobId,
      progressPercent: wrapped.result.progressPercent,
      providerId: wrapped.providerId,
      usedFallback: wrapped.usedFallback,
      metadata: wrapped.result.metadata,
    };
  }
  return {
    kind: 'complete',
    result: wrapped.result.output,
    usedFallback: wrapped.usedFallback,
    providerId: wrapped.providerId,
  };
}

// =============================================================================
// 4. AUDIO TRANSCRIPTION (STT) & TEXT-TO-SPEECH (TTS)
// =============================================================================

async function executeTranscribeOnProvider(
  ctx: ProviderExecutionContext,
  input: AudioTranscriptionInput,
): Promise<AudioTranscriptionOutput> {
  if (isAiMockModeEnabled()) {
    return runMockAudioTranscription(ctx, input);
  }

  try {
    if (ctx.providerType === 'google_gemini') {
      const root = normalizeGeminiRootBaseUrl(ctx.baseUrl);
      const modelId = normalizeGeminiModelId(ctx.modelIdentifier);
      const url = `${root}/v1beta/models/${encodeURIComponent(modelId)}:generateContent`;
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: buildGeminiHeaders(ctx),
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    inlineData: {
                      mimeType: input.mimeType,
                      data: input.audioBuffer.toString('base64'),
                    },
                  },
                  {
                    text: input.language
                      ? `Transcribe this audio accurately in language ${input.language}. Return only the transcription.`
                      : 'Transcribe this audio accurately in its original language. Return only the transcription.',
                  },
                ],
              },
            ],
          }),
        },
        60000,
        input.signal,
      );
      if (!res.ok) throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
      const json = (await res.json()) as GeminiGenerateContentResponse;
      assertGeminiNotBlocked(json, false);
      return {
        text: extractGeminiCandidateText(json.candidates).trim(),
        language: input.language,
        costUsd: 0.004,
      };
    }

    if (ctx.providerType === 'openai_compatible' || ctx.providerType === 'custom') {
      const url = `${normalizeOpenAiRootBaseUrl(ctx.baseUrl)}/audio/transcriptions`;
      const form = new FormData();
      form.append('model', ctx.modelIdentifier);
      if (input.language) form.append('language', input.language);
      form.append(
        'file',
        new Blob([new Uint8Array(input.audioBuffer)], { type: input.mimeType }),
        input.fileName || 'voice.ogg',
      );
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: mergeHeaders({ Authorization: `Bearer ${ctx.apiKey}` }, ctx.additionalHeaders),
          body: form,
        },
        60000,
        input.signal,
      );
      if (!res.ok) throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
      const json = (await res.json()) as { text?: string };
      return { text: json.text?.trim() ?? '', language: input.language, costUsd: 0.005 };
    }

    if (ctx.providerType === 'huggingface' && !isHuggingFaceSpaceContext(ctx)) {
      const routerRoot = resolveHuggingFaceRouterRoot(ctx.baseUrl);
      const url = `${routerRoot}/hf-inference/models/${ctx.modelIdentifier.replace(/^\/+/, '')}`;
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: mergeHeaders(
            { 'Content-Type': input.mimeType || 'audio/mpeg', Authorization: `Bearer ${ctx.apiKey}` },
            ctx.additionalHeaders,
          ),
          body: new Uint8Array(input.audioBuffer),
        },
        60000,
        input.signal,
      );
      if (!res.ok) throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
      const json = (await res.json()) as { text?: string };
      return { text: json.text?.trim() ?? '', language: input.language, costUsd: 0.003 };
    }

    if (ctx.providerType === 'cloudflare_workers_ai') {
      const modelId = ctx.modelIdentifier.trim();
      const lowerModel = modelId.toLowerCase();
      const extractCfSttText = (raw: unknown): string => {
        if (!raw || typeof raw !== 'object') return '';
        const obj = raw as {
          text?: unknown;
          result?: {
            text?: unknown;
            results?: { channels?: Array<{ alternatives?: Array<{ transcript?: unknown }> }> };
          };
          results?: { channels?: Array<{ alternatives?: Array<{ transcript?: unknown }> }> };
        };
        if (typeof obj.text === 'string') return obj.text.trim();
        if (typeof obj.result?.text === 'string') return obj.result.text.trim();
        const directTranscript = obj.results?.channels?.[0]?.alternatives?.[0]?.transcript;
        if (typeof directTranscript === 'string') return directTranscript.trim();
        const nestedTranscript = obj.result?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
        if (typeof nestedTranscript === 'string') return nestedTranscript.trim();
        return '';
      };

      const isWhisperTurbo = lowerModel.includes('whisper-large-v3-turbo');
      const isDeepgramNova = lowerModel.includes('deepgram/nova');
      const aiBinding = getCloudflareAiBinding();

      if (aiBinding) {
        let payload: Record<string, unknown>;
        if (isDeepgramNova) {
          payload = {
            audio: {
              body: new Uint8Array(input.audioBuffer),
              contentType: input.mimeType || 'audio/ogg',
            },
            ...(input.language ? { language: input.language } : {}),
          };
        } else if (isWhisperTurbo) {
          payload = {
            audio: input.audioBuffer.toString('base64'),
            ...(input.language ? { language: input.language } : {}),
          };
        } else {
          payload = {
            audio: Array.from(input.audioBuffer),
          };
        }
        const rawOut = await aiBinding.run(modelId, payload);
        return {
          text: extractCfSttText(rawOut),
          language: input.language,
          costUsd: 0,
        };
      }

      const accountId = (ctx.organizationId ?? '').trim();
      if (!accountId || !ctx.apiKey.trim()) {
        throw new AIProviderError({
          code: 'INVALID_API_KEY',
          message: 'Cloudflare Workers AI STT requires native Worker binding or Account ID + API Token.',
          userMessageFa: 'این مدل در حال حاضر در دسترس نیست. لطفاً مدل دیگری انتخاب کنید.',
          retryable: false,
        });
      }

      const restBase = normalizeBaseUrl(ctx.baseUrl || 'https://api.cloudflare.com/client/v4').replace(/\/accounts\/.+$/i, '');
      const restUrl = `${restBase}/accounts/${encodeURIComponent(accountId)}/ai/run/${modelId}`;
      const res = await fetchWithTimeout(
        restUrl,
        isWhisperTurbo
          ? {
              method: 'POST',
              headers: mergeHeaders(
                { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.apiKey}` },
                ctx.additionalHeaders,
              ),
              body: JSON.stringify({
                audio: input.audioBuffer.toString('base64'),
                ...(input.language ? { language: input.language } : {}),
              }),
            }
          : {
              method: 'POST',
              headers: mergeHeaders(
                { 'Content-Type': input.mimeType || 'audio/ogg', Authorization: `Bearer ${ctx.apiKey}` },
                ctx.additionalHeaders,
              ),
              body: new Uint8Array(input.audioBuffer),
            },
        60000,
        input.signal,
      );
      if (!res.ok) throw classifyHttpError(res.status, await res.text(), ctx.apiKey, modelId);
      const json = await res.json();
      return {
        text: extractCfSttText(json),
        language: input.language,
        costUsd: 0,
      };
    }

    if (isHuggingFaceSpaceContext(ctx)) {
      const deadlineAtMs = createHfDeadline('sync');
      let resolvedCtx = await resolveGradioContext(ctx, input.signal, {
        preferredKind: 'stt',
        deadlineAtMs,
      });
      const uploadedAudio = await uploadMediaToGradioSpace(
        resolvedCtx,
        input.audioBuffer,
        input.mimeType || 'audio/ogg',
        input.fileName || 'voice.ogg',
        input.signal,
        deadlineAtMs,
      );
      let args = buildGradioInputPayload(resolvedCtx, '', undefined, undefined, uploadedAudio, {
        mode: 'stt',
        language: input.language,
        mediaKind: 'audio',
      });
      let callRes: { outputData: unknown[]; spaceHost: string; endpointPrefix: string };
      try {
        callRes = await runGradioSpaceCall(resolvedCtx, args, input.signal, deadlineAtMs);
      } catch (firstErr) {
        const isSchemaErr =
          firstErr instanceof AIProviderError &&
          (firstErr.httpStatus === 422 || firstErr.httpStatus === 400 || firstErr.httpStatus === 500);
        if (!isSchemaErr || deadlineAtMs - Date.now() < 6000) throw firstErr;
        resolvedCtx = await resolveGradioContext(ctx, input.signal, {
          forceRefresh: true,
          preferredKind: 'stt',
          deadlineAtMs,
        });
        args = buildGradioInputPayload(resolvedCtx, '', undefined, undefined, uploadedAudio, {
          mode: 'stt',
          language: input.language,
          mediaKind: 'audio',
        });
        callRes = await runGradioSpaceCall(resolvedCtx, args, input.signal, deadlineAtMs);
      }
      return {
        text: extractGradioOutputText(callRes.outputData).trim(),
        language: input.language,
        costUsd: 0,
      };
    }

    throw new AIProviderError({
      code: 'UNSUPPORTED_CAPABILITY',
      message: `Provider ${ctx.providerType} does not support audio transcription.`,
      userMessageFa: 'این مدل از تبدیل گفتار به متن پشتیبانی نمی‌کند. لطفاً مدل دیگری انتخاب کنید.',
    });
  } catch (err) {
    throw wrapNetworkError(err, ctx.apiKey);
  }
}

export async function transcribeAudioWithRoute(
  route: LoadedModelRoute,
  input: AudioTranscriptionInput,
): Promise<{ result: AudioTranscriptionOutput; usedFallback: boolean; providerId: string }> {
  assertCapabilitySupported(route.primary, 'audio_transcription');
  return runWithFailover(route, (ctx) => executeTranscribeOnProvider(ctx, input));
}

async function executeSpeechOnProvider(
  ctx: ProviderExecutionContext,
  input: SpeechGenerationInput,
): Promise<SpeechGenerationOutput> {
  if (isAiMockModeEnabled()) {
    return runMockSpeechGeneration(ctx, input);
  }

  try {
    if (ctx.providerType === 'google_gemini') {
      const root = normalizeGeminiRootBaseUrl(ctx.baseUrl);
      const modelId = normalizeGeminiModelId(ctx.modelIdentifier);
      const voiceName = input.voice || 'Kore';
      const url = `${root}/v1beta/models/${encodeURIComponent(modelId)}:generateContent`;
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: buildGeminiHeaders(ctx),
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: input.text }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName },
                },
              },
            },
          }),
        },
        60000,
        input.signal,
      );
      if (!res.ok) throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
      const json = (await res.json()) as GeminiGenerateContentResponse;
      assertGeminiNotBlocked(json, false);
      const audioPart = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      const base64Audio = audioPart?.inlineData?.data;
      if (!base64Audio) {
        throw new AIProviderError({
          code: 'PROVIDER_ERROR',
          message: 'Gemini TTS returned no audio data.',
          userMessageFa: 'خروجی صوتی از مدل دریافت نشد.',
        });
      }
      const rawMime = audioPart?.inlineData?.mimeType || 'audio/wav';
      const rawBuf = Buffer.from(base64Audio, 'base64');
      const isRawPcm = /audio\/l16|codec=pcm/i.test(rawMime);
      const rateMatch = /rate=(\d+)/i.exec(rawMime);
      const sampleRate = rateMatch?.[1] ? Number.parseInt(rateMatch[1], 10) : 24000;
      const finalBuf = isRawPcm ? pcm16ToWav(rawBuf, sampleRate || 24000) : rawBuf;
      return {
        audioBuffer: finalBuf,
        mimeType: isRawPcm ? 'audio/wav' : rawMime,
        extension: isRawPcm || rawMime.includes('wav') ? 'wav' : rawMime.includes('mpeg') ? 'mp3' : 'wav',
        costUsd: 0.006,
      };
    }

    if (ctx.providerType === 'openai_compatible' || ctx.providerType === 'custom') {
      const url = `${normalizeOpenAiRootBaseUrl(ctx.baseUrl)}/audio/speech`;
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: mergeHeaders(
            { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.apiKey}` },
            ctx.additionalHeaders,
          ),
          body: JSON.stringify({
            model: ctx.modelIdentifier,
            input: input.text,
            voice: input.voice || 'alloy',
            response_format: 'mp3',
          }),
        },
        60000,
        input.signal,
      );
      if (!res.ok) throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        audioBuffer: buf,
        mimeType: 'audio/mpeg',
        extension: 'mp3',
        costUsd: 0.01,
      };
    }

    if (ctx.providerType === 'huggingface' && !isHuggingFaceSpaceContext(ctx)) {
      const routerRoot = resolveHuggingFaceRouterRoot(ctx.baseUrl);
      const url = `${routerRoot}/hf-inference/models/${ctx.modelIdentifier.replace(/^\/+/, '')}`;
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: mergeHeaders(
            { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.apiKey}` },
            ctx.additionalHeaders,
          ),
          body: JSON.stringify({ inputs: input.text }),
        },
        60000,
        input.signal,
      );
      if (!res.ok) throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
      const contentType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'audio/flac';
      const ext = contentType.includes('mpeg') ? 'mp3' : contentType.includes('wav') ? 'wav' : 'flac';
      return {
        audioBuffer: Buffer.from(await res.arrayBuffer()),
        mimeType: contentType,
        extension: ext,
        costUsd: 0.004,
      };
    }

    if (ctx.providerType === 'cloudflare_workers_ai') {
      const modelId = ctx.modelIdentifier.trim();
      const lowerModel = modelId.toLowerCase();
      const isMelo = lowerModel.includes('melotts');
      const payload = isMelo
        ? { prompt: input.text, lang: 'en' }
        : { text: input.text, ...(input.voice ? { speaker: input.voice } : {}) };

      const decodeCfAudio = async (raw: unknown): Promise<{ audioBuffer: Buffer; mimeType: string; extension: string }> => {
        if (raw instanceof Uint8Array) {
          return { audioBuffer: Buffer.from(raw), mimeType: 'audio/mpeg', extension: 'mp3' };
        }
        if (raw instanceof ArrayBuffer) {
          return { audioBuffer: Buffer.from(raw), mimeType: 'audio/mpeg', extension: 'mp3' };
        }
        if (raw && typeof raw === 'object' && 'arrayBuffer' in raw && typeof (raw as Response).arrayBuffer === 'function') {
          return { audioBuffer: Buffer.from(await (raw as Response).arrayBuffer()), mimeType: 'audio/mpeg', extension: 'mp3' };
        }
        if (raw && typeof raw === 'object' && 'getReader' in raw && typeof (raw as ReadableStream).getReader === 'function') {
          const reader = (raw as ReadableStream<Uint8Array>).getReader();
          const chunks: Uint8Array[] = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
          }
          return {
            audioBuffer: Buffer.concat(chunks.map((c) => Buffer.from(c))),
            mimeType: 'audio/mpeg',
            extension: 'mp3',
          };
        }
        if (raw && typeof raw === 'object') {
          const obj = raw as { audio?: unknown; result?: { audio?: unknown } };
          const b64 = typeof obj.audio === 'string' ? obj.audio : typeof obj.result?.audio === 'string' ? obj.result.audio : null;
          if (b64) {
            return { audioBuffer: Buffer.from(b64, 'base64'), mimeType: 'audio/mpeg', extension: 'mp3' };
          }
        }
        throw new AIProviderError({
          code: 'PROVIDER_ERROR',
          message: 'Cloudflare Workers AI TTS returned no recognizable audio output.',
          userMessageFa: 'خروجی صوتی از مدل دریافت نشد. لطفاً دوباره تلاش کنید.',
        });
      };

      const aiBinding = getCloudflareAiBinding();
      if (aiBinding) {
        const rawOut = await aiBinding.run(modelId, payload);
        const decoded = await decodeCfAudio(rawOut);
        return { ...decoded, costUsd: 0 };
      }

      const accountId = (ctx.organizationId ?? '').trim();
      if (!accountId || !ctx.apiKey.trim()) {
        throw new AIProviderError({
          code: 'INVALID_API_KEY',
          message: 'Cloudflare Workers AI TTS requires native Worker binding or Account ID + API Token.',
          userMessageFa: 'این مدل در حال حاضر در دسترس نیست. لطفاً مدل دیگری انتخاب کنید.',
          retryable: false,
        });
      }

      const restBase = normalizeBaseUrl(ctx.baseUrl || 'https://api.cloudflare.com/client/v4').replace(/\/accounts\/.+$/i, '');
      const restUrl = `${restBase}/accounts/${encodeURIComponent(accountId)}/ai/run/${modelId}`;
      const res = await fetchWithTimeout(
        restUrl,
        {
          method: 'POST',
          headers: mergeHeaders(
            { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.apiKey}` },
            ctx.additionalHeaders,
          ),
          body: JSON.stringify(payload),
        },
        60000,
        input.signal,
      );
      if (!res.ok) throw classifyHttpError(res.status, await res.text(), ctx.apiKey, modelId);
      const contentType = res.headers.get('content-type')?.split(';')[0]?.trim() || '';
      if (contentType.includes('application/json')) {
        const decoded = await decodeCfAudio(await res.json());
        return { ...decoded, costUsd: 0 };
      }
      return {
        audioBuffer: Buffer.from(await res.arrayBuffer()),
        mimeType: contentType.startsWith('audio/') ? contentType : 'audio/mpeg',
        extension: contentType.includes('wav') ? 'wav' : 'mp3',
        costUsd: 0,
      };
    }

    if (isHuggingFaceSpaceContext(ctx)) {
      const deadlineAtMs = createHfDeadline('sync');
      let resolvedCtx = await resolveGradioContext(ctx, input.signal, {
        preferredKind: 'tts',
        deadlineAtMs,
      });
      let args = buildGradioInputPayload(resolvedCtx, input.text, undefined, undefined, undefined, {
        mode: 'tts',
        voice: input.voice,
        language: input.language,
      });
      let callRes: { outputData: unknown[]; spaceHost: string; endpointPrefix: string };
      try {
        callRes = await runGradioSpaceCall(resolvedCtx, args, input.signal, deadlineAtMs);
      } catch (firstErr) {
        const isSchemaErr =
          firstErr instanceof AIProviderError &&
          (firstErr.httpStatus === 422 || firstErr.httpStatus === 400 || firstErr.httpStatus === 500);
        if (!isSchemaErr || deadlineAtMs - Date.now() < 6000) throw firstErr;
        resolvedCtx = await resolveGradioContext(ctx, input.signal, {
          forceRefresh: true,
          preferredKind: 'tts',
          deadlineAtMs,
        });
        args = buildGradioInputPayload(resolvedCtx, input.text, undefined, undefined, undefined, {
          mode: 'tts',
          voice: input.voice,
          language: input.language,
        });
        callRes = await runGradioSpaceCall(resolvedCtx, args, input.signal, deadlineAtMs);
      }
      const mediaUrl = extractGradioMediaUrl(
        callRes.outputData,
        callRes.spaceHost,
        'audio',
        callRes.endpointPrefix,
      );
      if (!mediaUrl) {
        throw new AIProviderError({
          code: 'PROVIDER_ERROR',
          message: 'Hugging Face Space returned no audio output.',
          userMessageFa: 'خروجی صوتی از مدل دریافت نشد. لطفاً دوباره تلاش کنید.',
        });
      }
      const dl = await downloadBinarySafe(
        mediaUrl,
        resolvedCtx.apiKey,
        true,
        getRemainingBudgetMs(deadlineAtMs, 20_000, 5000),
        input.signal,
      );
      const ext = dl.mimeType.includes('mpeg')
        ? 'mp3'
        : dl.mimeType.includes('ogg')
          ? 'ogg'
          : dl.mimeType.includes('flac')
            ? 'flac'
            : 'wav';
      return {
        audioBuffer: dl.buffer,
        mimeType: dl.mimeType,
        extension: ext,
        costUsd: 0,
      };
    }

    throw new AIProviderError({
      code: 'UNSUPPORTED_CAPABILITY',
      message: `Provider ${ctx.providerType} does not support text-to-speech.`,
      userMessageFa: 'این مدل از تبدیل متن به گفتار پشتیبانی نمی‌کند. لطفاً مدل دیگری انتخاب کنید.',
    });
  } catch (err) {
    throw wrapNetworkError(err, ctx.apiKey);
  }
}

export async function generateSpeechWithRoute(
  route: LoadedModelRoute,
  input: SpeechGenerationInput,
): Promise<{ result: SpeechGenerationOutput; usedFallback: boolean; providerId: string }> {
  assertCapabilitySupported(route.primary, 'speech_generation');
  return runWithFailover(route, (ctx) => executeSpeechOnProvider(ctx, input));
}

// =============================================================================
// 5. ASYNCHRONOUS VIDEO GENERATION (START + POLL)
// =============================================================================

export async function startVideoGenerationWithRoute(
  route: LoadedModelRoute,
  input: VideoGenerationInput,
): Promise<{ result: VideoJobStartOutput; usedFallback: boolean; providerId: string }> {
  assertCapabilitySupported(route.primary, 'video_generation');
  if (isAiMockModeEnabled()) {
    return {
      result: await runMockVideoStart(route.primary, input),
      usedFallback: false,
      providerId: route.primary.providerId,
    };
  }

  return runWithFailover(route, async (ctx) => {
    try {
      if (ctx.providerType === 'replicate') {
        const url = `${normalizeBaseUrl(ctx.baseUrl)}/v1/models/${ctx.modelIdentifier}/predictions`;
        const payloadInput: Record<string, unknown> = {
          prompt: input.prompt,
          duration: input.durationSeconds ?? 5,
          aspect_ratio: input.aspectRatio ?? '16:9',
          ...(ctx.modelParameters ?? {}),
        };
        if (input.sourceImageBase64 && input.sourceImageMimeType) {
          payloadInput.image = `data:${input.sourceImageMimeType};base64,${input.sourceImageBase64}`;
        }
        const res = await fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: mergeHeaders(
              { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.apiKey}` },
              ctx.additionalHeaders,
            ),
            body: JSON.stringify({ input: payloadInput }),
          },
          30000,
          input.signal,
        );
        if (!res.ok) throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
        const json = (await res.json()) as { id: string; status: string };
        return {
          providerJobId: json.id,
          status: json.status === 'processing' ? 'running' : 'queued',
          progressPercent: 15,
          costUsd: 0.15,
        };
      }

      if (ctx.providerType === 'fal_ai') {
        const url = `https://queue.fal.run/${ctx.modelIdentifier.replace(/^\/+/, '')}`;
        const body: Record<string, unknown> = {
          prompt: input.prompt,
          duration: String(input.durationSeconds ?? 5),
          aspect_ratio: input.aspectRatio ?? '16:9',
          ...(ctx.modelParameters ?? {}),
        };
        if (input.sourceImageBase64 && input.sourceImageMimeType) {
          body.image_url = `data:${input.sourceImageMimeType};base64,${input.sourceImageBase64}`;
        }
        const res = await fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: mergeHeaders(
              { 'Content-Type': 'application/json', Authorization: `Key ${ctx.apiKey}` },
              ctx.additionalHeaders,
            ),
            body: JSON.stringify(body),
          },
          30000,
          input.signal,
        );
        if (!res.ok) throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
        const json = (await res.json()) as { request_id: string; status_url?: string; response_url?: string };
        return {
          providerJobId: json.request_id,
          status: 'queued',
          progressPercent: 15,
          costUsd: 0.18,
          metadata: { statusUrl: json.status_url, responseUrl: json.response_url },
        };
      }

      if (ctx.providerType === 'google_gemini') {
        const root = normalizeGeminiRootBaseUrl(ctx.baseUrl);
        const modelId = normalizeGeminiModelId(ctx.modelIdentifier);
        const url = `${root}/v1beta/models/${encodeURIComponent(modelId)}:predictLongRunning`;
        const instance: Record<string, unknown> = { prompt: input.prompt };
        if (input.sourceImageBase64 && input.sourceImageMimeType) {
          instance.image = {
            bytesBase64Encoded: input.sourceImageBase64,
            mimeType: input.sourceImageMimeType,
          };
        }
        const res = await fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: buildGeminiHeaders(ctx),
            body: JSON.stringify({
              instances: [instance],
              parameters: {
                aspectRatio: input.aspectRatio ?? '16:9',
                durationSeconds: input.durationSeconds ?? 5,
              },
            }),
          },
          45000,
          input.signal,
        );
        if (!res.ok) throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
        const op = (await res.json()) as { name?: string };
        if (!op?.name) {
          throw new AIProviderError({
            code: 'PROVIDER_ERROR',
            message: 'Gemini video endpoint did not return an operation ID.',
            userMessageFa: 'امکان ثبت درخواست ویدیو در این مدل وجود ندارد.',
          });
        }
        return {
          providerJobId: op.name,
          status: 'running',
          progressPercent: 20,
          costUsd: 0.2,
        };
      }

      if (isHuggingFaceSpaceContext(ctx)) {
        const deadlineAtMs = createHfDeadline('sync');
        const hasSourceImage = Boolean(input.sourceImageBase64);
        let resolvedCtx = await resolveGradioContext(ctx, input.signal, {
          preferredKind: hasSourceImage ? 'video_i2v' : 'video_t2v',
          deadlineAtMs,
        });

        let uploadedImg: GradioFileData | undefined;
        if (input.sourceImageBase64) {
          const mime = input.sourceImageMimeType || 'image/jpeg';
          const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
          uploadedImg = await uploadMediaToGradioSpace(
            resolvedCtx,
            Buffer.from(input.sourceImageBase64, 'base64'),
            mime,
            `video-source.${ext}`,
            input.signal,
            deadlineAtMs,
          );
        }

        const buildVideoArgs = (targetCtx: ProviderExecutionContext) =>
          buildGradioInputPayload(targetCtx, input.prompt, undefined, undefined, uploadedImg, {
            mode: hasSourceImage ? 'i2v' : 't2v',
            aspectRatio: input.aspectRatio,
            durationSeconds: input.durationSeconds,
            mediaKind: hasSourceImage ? 'image' : undefined,
          });

        let submitted: GradioSubmitResult;
        try {
          submitted = await submitGradioSpaceCall(
            resolvedCtx,
            buildVideoArgs(resolvedCtx),
            input.signal,
            deadlineAtMs,
          );
        } catch (firstErr) {
          const isSchemaErr =
            firstErr instanceof AIProviderError &&
            (firstErr.httpStatus === 422 || firstErr.httpStatus === 400 || firstErr.httpStatus === 500);
          if (!isSchemaErr || deadlineAtMs - Date.now() < 6000) throw firstErr;
          resolvedCtx = await resolveGradioContext(ctx, input.signal, {
            forceRefresh: true,
            preferredKind: hasSourceImage ? 'video_i2v' : 'video_t2v',
            deadlineAtMs,
          });
          submitted = await submitGradioSpaceCall(
            resolvedCtx,
            buildVideoArgs(resolvedCtx),
            input.signal,
            deadlineAtMs,
          );
        }

        if (submitted.kind === 'immediate') {
          const videoUrl = extractGradioMediaUrl(
            submitted.outputData,
            submitted.spaceHost,
            'video',
            submitted.endpointPrefix,
          );
          if (!videoUrl) {
            throw new AIProviderError({
              code: 'PROVIDER_ERROR',
              message: 'Hugging Face Space returned no video output.',
              userMessageFa: 'ویدیویی از مدل دریافت نشد. لطفاً دوباره تلاش کنید.',
            });
          }
          const dl = await downloadBinarySafe(
            videoUrl,
            resolvedCtx.apiKey,
            true,
            getRemainingBudgetMs(deadlineAtMs, 25_000, 5000),
            input.signal,
          );
          return {
            providerJobId: `hf-sync-${Date.now()}`,
            status: 'succeeded',
            progressPercent: 100,
            videoBuffer: dl.buffer,
            videoUrl,
            mimeType: dl.mimeType.startsWith('video/') ? dl.mimeType : 'video/mp4',
            costUsd: 0,
          };
        }

        const hfMetadata = {
          kind: 'hf_space_gradio',
          callUrl: submitted.callUrl,
          spaceHost: submitted.spaceHost,
          endpointPrefix: submitted.endpointPrefix,
          credentialId: ctx.credentialId ?? null,
        };

        // On Cloudflare Workers (30s waitUntil ceiling), return immediately after POST so Gradio
        // keeps generating in the background without SSE disconnect cancellation; video poll collects it!
        const isCfBackgroundWaitUntil = Boolean(getCloudflareRequestContext()?.childWaitUntilTasks);
        if (isCfBackgroundWaitUntil) {
          return {
            providerJobId: submitted.eventId,
            status: 'running',
            progressPercent: 25,
            costUsd: 0,
            metadata: hfMetadata,
          };
        }

        // On Node.js, wait directly up to the sync deadline; if still rendering, hand off to async poll
        const sseResult = await readGradioSpaceSse({
          callUrl: submitted.callUrl,
          eventId: submitted.eventId,
          apiKey: resolvedCtx.apiKey,
          additionalHeaders: resolvedCtx.additionalHeaders,
          deadlineAtMs,
          signal: input.signal,
        });

        if (sseResult.status === 'complete') {
          const videoUrl = extractGradioMediaUrl(
            sseResult.outputData,
            submitted.spaceHost,
            'video',
            submitted.endpointPrefix,
          );
          if (!videoUrl) {
            throw new AIProviderError({
              code: 'PROVIDER_ERROR',
              message: 'Hugging Face Space completed without a video file.',
              userMessageFa: 'ویدیویی از مدل دریافت نشد. لطفاً دوباره تلاش کنید.',
            });
          }
          const dl = await downloadBinarySafe(videoUrl, resolvedCtx.apiKey, true, 45_000, input.signal);
          return {
            providerJobId: submitted.eventId,
            status: 'succeeded',
            progressPercent: 100,
            videoBuffer: dl.buffer,
            videoUrl,
            mimeType: dl.mimeType.startsWith('video/') ? dl.mimeType : 'video/mp4',
            costUsd: 0,
            metadata: hfMetadata,
          };
        }

        return {
          providerJobId: submitted.eventId,
          status: 'running',
          progressPercent: 45,
          costUsd: 0,
          metadata: hfMetadata,
        };
      }

      throw new AIProviderError({
        code: 'UNSUPPORTED_CAPABILITY',
        message: `Provider ${ctx.providerType} does not support video generation.`,
        userMessageFa: 'این مدل از تولید ویدیو پشتیبانی نمی‌کند. لطفاً مدل دیگری انتخاب کنید.',
      });
    } catch (err) {
      throw wrapNetworkError(err, ctx.apiKey);
    }
  });
}

export async function pollVideoGenerationJob(
  ctx: ProviderExecutionContext,
  providerJobId: string,
  metadata?: Record<string, unknown>,
): Promise<VideoJobPollOutput> {
  if (isAiMockModeEnabled()) {
    return runMockVideoPoll(ctx, providerJobId);
  }

  try {
    if (ctx.providerType === 'replicate') {
      const url = `${normalizeBaseUrl(ctx.baseUrl)}/v1/predictions/${providerJobId}`;
      const res = await fetchWithTimeout(
        url,
        {
          method: 'GET',
          headers: mergeHeaders({ Authorization: `Bearer ${ctx.apiKey}` }, ctx.additionalHeaders),
        },
        20000,
      );
      if (!res.ok) throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
      const json = (await res.json()) as { status: string; output?: unknown; error?: string };
      if (json.status === 'succeeded') {
        const videoUrl = Array.isArray(json.output)
          ? String(json.output[0] ?? '')
          : typeof json.output === 'string'
            ? json.output
            : '';
        if (!videoUrl) {
          return { status: 'failed', progressPercent: 0, errorMessage: 'خروجی ویدیو خالی بود.' };
        }
        const dl = await downloadBinarySafe(videoUrl, ctx.apiKey);
        return {
          status: 'succeeded',
          progressPercent: 100,
          videoBuffer: dl.buffer,
          videoUrl,
          mimeType: dl.mimeType.startsWith('video/') ? dl.mimeType : 'video/mp4',
          costUsd: 0.15,
        };
      }
      if (json.status === 'failed' || json.status === 'canceled') {
        return {
          status: 'failed',
          progressPercent: 0,
          errorMessage: redactSecrets(json.error ?? 'Video generation failed', [ctx.apiKey]),
        };
      }
      return {
        status: json.status === 'processing' ? 'running' : 'queued',
        progressPercent: json.status === 'processing' ? 60 : 25,
      };
    }

    if (ctx.providerType === 'fal_ai') {
      const statusUrl =
        typeof metadata?.statusUrl === 'string'
          ? metadata.statusUrl
          : `https://queue.fal.run/${ctx.modelIdentifier.replace(/^\/+/, '')}/requests/${providerJobId}/status`;
      const responseUrl =
        typeof metadata?.responseUrl === 'string'
          ? metadata.responseUrl
          : `https://queue.fal.run/${ctx.modelIdentifier.replace(/^\/+/, '')}/requests/${providerJobId}`;

      const statusRes = await fetchWithTimeout(
        statusUrl,
        {
          method: 'GET',
          headers: mergeHeaders({ Authorization: `Key ${ctx.apiKey}` }, ctx.additionalHeaders),
        },
        20000,
      );
      if (!statusRes.ok) throw classifyHttpError(statusRes.status, await statusRes.text(), ctx.apiKey);
      const st = (await statusRes.json()) as { status: string };
      if (st.status === 'COMPLETED') {
        const resultRes = await fetchWithTimeout(
          responseUrl,
          {
            method: 'GET',
            headers: mergeHeaders({ Authorization: `Key ${ctx.apiKey}` }, ctx.additionalHeaders),
          },
          30000,
        );
        if (!resultRes.ok) throw classifyHttpError(resultRes.status, await resultRes.text(), ctx.apiKey);
        const resultJson = (await resultRes.json()) as { video?: { url?: string }; url?: string };
        const videoUrl = resultJson.video?.url ?? resultJson.url ?? '';
        if (!videoUrl) {
          return { status: 'failed', progressPercent: 0, errorMessage: 'لینک ویدیو دریافت نشد.' };
        }
        const dl = await downloadBinarySafe(videoUrl, ctx.apiKey);
        return {
          status: 'succeeded',
          progressPercent: 100,
          videoBuffer: dl.buffer,
          videoUrl,
          mimeType: 'video/mp4',
          costUsd: 0.18,
        };
      }
      if (st.status === 'FAILED') {
        return { status: 'failed', progressPercent: 0, errorMessage: 'پردازش ویدیو در fal.ai ناموفق بود.' };
      }
      return {
        status: st.status === 'IN_PROGRESS' ? 'running' : 'queued',
        progressPercent: st.status === 'IN_PROGRESS' ? 65 : 25,
      };
    }

    if (ctx.providerType === 'google_gemini') {
      const url = `${normalizeGeminiRootBaseUrl(ctx.baseUrl)}/v1beta/${providerJobId}`;
      const res = await fetchWithTimeout(
        url,
        {
          method: 'GET',
          headers: mergeHeaders({ 'x-goog-api-key': ctx.apiKey }, ctx.additionalHeaders),
        },
        20000,
      );
      if (!res.ok) throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
      const op = (await res.json()) as {
        done?: boolean;
        error?: { message?: string };
        response?: { generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: string } }> } };
      };
      if (op.error) {
        return {
          status: 'failed',
          progressPercent: 0,
          errorMessage: redactSecrets(op.error.message ?? 'Gemini video error', [ctx.apiKey]),
        };
      }
      if (op.done) {
        const uri = op.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
        if (!uri) {
          return { status: 'failed', progressPercent: 0, errorMessage: 'ویدیویی تولید نشد.' };
        }
        const dlRes = await fetchWithTimeout(
          uri,
          { method: 'GET', headers: { 'x-goog-api-key': ctx.apiKey } },
          60000,
        );
        if (!dlRes.ok) throw classifyHttpError(dlRes.status, await dlRes.text(), ctx.apiKey);
        return {
          status: 'succeeded',
          progressPercent: 100,
          videoBuffer: Buffer.from(await dlRes.arrayBuffer()),
          mimeType: 'video/mp4',
          costUsd: 0.2,
        };
      }
      return { status: 'running', progressPercent: 55 };
    }

    if (isHuggingFaceSpaceContext(ctx) || metadata?.kind === 'hf_space_gradio') {
      const deadlineAtMs = createHfDeadline('video_poll', ctx);
      const spaceHost =
        typeof metadata?.spaceHost === 'string' && metadata.spaceHost
          ? normalizeBaseUrl(metadata.spaceHost)
          : typeof ctx.modelParameters?.spaceHost === 'string' && ctx.modelParameters.spaceHost
            ? normalizeBaseUrl(ctx.modelParameters.spaceHost)
            : (await resolveHfSpaceRootUrl(ctx.baseUrl, ctx.apiKey, ctx.additionalHeaders)).resolvedRootUrl;
      const endpointPrefix =
        typeof metadata?.endpointPrefix === 'string'
          ? metadata.endpointPrefix
          : typeof ctx.modelParameters?.endpointPrefix === 'string'
            ? ctx.modelParameters.endpointPrefix
            : '/gradio_api';
      const apiName = (
        typeof ctx.modelParameters?.apiName === 'string'
          ? ctx.modelParameters.apiName
          : ctx.modelIdentifier.split('::')[1] || 'predict'
      ).replace(/^\/+/, '');
      const normalizedPrefix = endpointPrefix === '' ? '' : `/${endpointPrefix.replace(/^\/+|\/+$/g, '')}`;
      const callUrl =
        typeof metadata?.callUrl === 'string' && metadata.callUrl
          ? metadata.callUrl
          : `${spaceHost}${normalizedPrefix}/call/${apiName}`;

      try {
        const sseResult = await readGradioSpaceSse({
          callUrl,
          eventId: providerJobId,
          apiKey: ctx.apiKey,
          additionalHeaders: ctx.additionalHeaders,
          deadlineAtMs,
        });

        if (sseResult.status === 'timeout') {
          return { status: 'running', progressPercent: 60 };
        }

        const videoUrl = extractGradioMediaUrl(
          sseResult.outputData,
          spaceHost,
          'video',
          normalizedPrefix,
        );
        if (!videoUrl) {
          return {
            status: 'failed',
            progressPercent: 0,
            errorMessage: 'ویدیویی از مدل دریافت نشد.',
          };
        }

        const dl = await downloadBinarySafe(
          videoUrl,
          ctx.apiKey,
          true,
          getRemainingBudgetMs(deadlineAtMs, 25_000, 6000),
        );
        return {
          status: 'succeeded',
          progressPercent: 100,
          videoBuffer: dl.buffer,
          videoUrl,
          mimeType: dl.mimeType.startsWith('video/') ? dl.mimeType : 'video/mp4',
          costUsd: 0,
        };
      } catch (pollErr) {
        if (pollErr instanceof AIProviderError) {
          if (pollErr.httpStatus === 404) {
            return {
              status: 'failed',
              progressPercent: 0,
              errorMessage: 'شناسه پردازش ویدیو در سرور منقضی شد. لطفاً دوباره تلاش کنید.',
            };
          }
          if (pollErr.retryable && pollErr.code === 'TIMEOUT') {
            return { status: 'running', progressPercent: 60 };
          }
          return {
            status: 'failed',
            progressPercent: 0,
            errorMessage: pollErr.userMessageFa,
          };
        }
        throw pollErr;
      }
    }

    return { status: 'failed', progressPercent: 0, errorMessage: 'پشتیبانی از polling این ارائه‌دهنده تعریف نشده است.' };
  } catch (err) {
    throw wrapNetworkError(err, ctx.apiKey);
  }
}

export async function pollMediaGenerationJob(
  ctx: ProviderExecutionContext,
  providerJobId: string,
  metadata?: Record<string, unknown>,
  options?: { maxWaitMs?: number },
): Promise<MediaJobPollOutput> {
  try {
    if (
      isHuggingFaceSpaceContext(ctx) ||
      metadata?.kind === 'hf_space_gradio_media' ||
      metadata?.kind === 'hf_space_gradio'
    ) {
      let deadlineAtMs = createHfDeadline('video_poll', ctx);
      if (typeof options?.maxWaitMs === 'number' && options.maxWaitMs > 0) {
        deadlineAtMs = Math.min(deadlineAtMs, Date.now() + options.maxWaitMs);
      }

      const spaceHost =
        typeof metadata?.spaceHost === 'string' && metadata.spaceHost
          ? normalizeBaseUrl(metadata.spaceHost)
          : typeof ctx.modelParameters?.spaceHost === 'string' && ctx.modelParameters.spaceHost
            ? normalizeBaseUrl(ctx.modelParameters.spaceHost)
            : (await resolveHfSpaceRootUrl(ctx.baseUrl, ctx.apiKey, ctx.additionalHeaders)).resolvedRootUrl;

      const endpointPrefix =
        typeof metadata?.endpointPrefix === 'string'
          ? metadata.endpointPrefix
          : typeof ctx.modelParameters?.endpointPrefix === 'string'
            ? ctx.modelParameters.endpointPrefix
            : '/gradio_api';

      const apiName = (
        typeof ctx.modelParameters?.apiName === 'string'
          ? ctx.modelParameters.apiName
          : ctx.modelIdentifier.split('::')[1] || 'predict'
      ).replace(/^\/+/, '');

      const normalizedPrefix = endpointPrefix === '' ? '' : `/${endpointPrefix.replace(/^\/+|\/+$/g, '')}`;
      const callUrl =
        typeof metadata?.callUrl === 'string' && metadata.callUrl
          ? metadata.callUrl
          : `${spaceHost}${normalizedPrefix}/call/${apiName}`;

      try {
        const sseResult = await readGradioSpaceSse({
          callUrl,
          eventId: providerJobId,
          apiKey: ctx.apiKey,
          additionalHeaders: ctx.additionalHeaders,
          deadlineAtMs,
        });

        if (sseResult.status === 'timeout') {
          return { status: 'running', progressPercent: 60 };
        }

        const imageUrl = extractGradioMediaUrl(
          sseResult.outputData,
          spaceHost,
          'image',
          normalizedPrefix,
        );
        if (!imageUrl) {
          return {
            status: 'failed',
            progressPercent: 0,
            errorMessage: 'تصویری از سرور مدل دریافت نشد.',
          };
        }

        const dl = await downloadBinarySafe(
          imageUrl,
          ctx.apiKey,
          true,
          getRemainingBudgetMs(deadlineAtMs, 20_000, 5000),
        );
        return {
          status: 'succeeded',
          progressPercent: 100,
          images: [
            {
              buffer: dl.buffer,
              mimeType: dl.mimeType,
              extension: dl.mimeType.includes('jpeg') ? 'jpg' : dl.mimeType.includes('webp') ? 'webp' : 'png',
            },
          ],
          costUsd: 0,
        };
      } catch (pollErr) {
        if (pollErr instanceof AIProviderError) {
          if (pollErr.httpStatus === 404) {
            return {
              status: 'failed',
              progressPercent: 0,
              errorMessage: 'شناسه پردازش تصویر در سرور منقضی شد. لطفاً دوباره تلاش کنید.',
            };
          }
          if (pollErr.retryable && pollErr.code === 'TIMEOUT') {
            return { status: 'running', progressPercent: 60 };
          }
          return {
            status: 'failed',
            progressPercent: 0,
            errorMessage: redactSecrets(pollErr.message, ctx.apiKey ? [ctx.apiKey] : []),
          };
        }
        throw pollErr;
      }
    }

    return {
      status: 'failed',
      progressPercent: 0,
      errorMessage: 'پشتیبانی از polling رسانه برای این ارائه‌دهنده تعریف نشده است.',
    };
  } catch (err) {
    throw wrapNetworkError(err, ctx.apiKey);
  }
}

// =============================================================================
// 6. DOCUMENT & FILE ANALYSIS
// =============================================================================

export async function analyzeDocumentWithRoute(
  route: LoadedModelRoute,
  input: DocumentAnalysisInput,
): Promise<{ result: TextGenerationOutput; usedFallback: boolean; providerId: string }> {
  const hasDocOrVision =
    route.primary.supportedCapabilities.includes('document_analysis') ||
    (Boolean(input.imageBase64) && route.primary.supportedCapabilities.includes('vision')) ||
    (Boolean(input.extractedText) &&
      (route.primary.supportedCapabilities.includes('text_generation') ||
        route.primary.supportedCapabilities.includes('chat')));

  if (!hasDocOrVision) {
    assertCapabilitySupported(route.primary, 'document_analysis');
  }

  if (isAiMockModeEnabled()) {
    return {
      result: await runMockDocumentAnalysis(route.primary, input),
      usedFallback: false,
      providerId: route.primary.providerId,
    };
  }

  if (input.imageBase64) {
    return runWithFailover(route, (ctx) =>
      executeTextOnProvider(ctx, {
        systemPrompt:
          input.systemPrompt ||
          'شما یک تحلیلگر دقیق اسناد و تصاویر هستید. به زبان فارسی شفاف و ساختارمند پاسخ دهید.',
        messages: [
          {
            role: 'user',
            content: `نام فایل: ${input.fileName}\nدرخواست کاربر: ${input.userPrompt}`,
            imageBase64: input.imageBase64,
            imageMimeType: input.mimeType,
          },
        ],
        signal: input.signal,
      }),
    );
  }

  const combinedPrompt = [
    `نام سند: ${input.fileName} (${input.mimeType})`,
    `درخواست کاربر: ${input.userPrompt}`,
    '--- محتوای استخراج‌شده سند ---',
    input.extractedText ?? '',
  ].join('\n\n');

  return runWithFailover(route, (ctx) =>
    executeTextOnProvider(ctx, {
      systemPrompt:
        input.systemPrompt ||
        'شما تحلیلگر حرفه‌ای اسناد (PDF، DOCX، CSV، TXT) هستید. فقط بر اساس محتوای سند پاسخ دقیق و فارسی ارائه دهید.',
      messages: [{ role: 'user', content: combinedPrompt }],
      signal: input.signal,
    }),
  );
}
