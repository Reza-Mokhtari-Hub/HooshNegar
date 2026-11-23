import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import { aiModels, aiProviders, modelCapabilities, providerCredentials } from '../../db/schema.ts';
import type { CapabilityType } from '../../shared/validation.ts';
import { isAiMockModeEnabled } from '../config/env.ts';
import { getCloudflareAiBinding, getCloudflareRequestContext } from '../cloudflare/requestContext.ts';
import { decryptSecret, redactSecrets } from '../security/crypto.ts';
import { assertSafeOutboundUrl, SsrfProtectionError } from '../security/ssrf.ts';
import {
  extractHuggingFaceRepoFromUrl,
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

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  await assertSafeOutboundUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
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

  let candidateCreds = usableCreds;
  const supportsKeylessRuntime =
    provider.providerType === 'huggingface_space' ||
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

  if (provider.providerType === 'huggingface_space') {
    contexts.push({
      ...baseMeta,
      apiKey: '',
      credentialId: null,
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

async function tryExecutionPool<T>(
  baseCtx: ProviderExecutionContext,
  executor: (ctx: ProviderExecutionContext) => Promise<T>,
): Promise<T> {
  const pool = baseCtx.credentialPool && baseCtx.credentialPool.length > 0 ? baseCtx.credentialPool : [baseCtx];
  let lastError: AIProviderError | null = null;

  for (const candidate of pool) {
    try {
      const result = await executor(candidate);
      await markCredentialSuccess(candidate.credentialId);
      return result;
    } catch (err) {
      const aiErr = wrapNetworkError(err, candidate.apiKey);
      lastError = aiErr;
      // Never rotate API keys for user input validation, cancelation, or missing capabilities
      if (
        aiErr.code === 'CANCELED' ||
        aiErr.code === 'UNSUPPORTED_CAPABILITY' ||
        aiErr.code === 'SSRF_BLOCKED' ||
        aiErr.credentialFailureKind === 'prompt_error'
      ) {
        throw aiErr;
      }
      await markCredentialFailure(candidate.credentialId, aiErr);
    }
  }

  throw (
    lastError ??
    new AIProviderError({
      code: 'PROVIDER_ERROR',
      message: 'All active credentials for provider failed.',
      userMessageFa: 'سرویس این مدل موقتاً در دسترس نیست. لطفاً لحظاتی دیگر دوباره تلاش کنید یا مدل دیگری انتخاب نمایید.',
    })
  );
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
      const result = await tryExecutionPool(route.fallback, executor);
      return { result, usedFallback: true, providerId: route.fallback.providerId };
    }
    throw aiErr;
  }
}

// =============================================================================
// HUGGING FACE GRADIO SPACE EXECUTION HELPER
// =============================================================================

function extractGradioOutputText(val: unknown): string {
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) {
    const last = val[val.length - 1];
    if (Array.isArray(last)) {
      return last.map((x) => (typeof x === 'string' ? x : '')).filter(Boolean).join('\n');
    }
    return val.map(extractGradioOutputText).filter(Boolean).join('\n');
  }
  if (val && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if (typeof obj.value === 'string') return obj.value;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.content === 'string') return obj.content;
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

function extractGradioMediaUrl(val: unknown, spaceHost: string): string | null {
  const resolvePath = (p: string): string => {
    if (p.startsWith('http://') || p.startsWith('https://') || p.startsWith('data:')) return p;
    const cleanHost = normalizeBaseUrl(spaceHost);
    if (p.startsWith('/gradio_api/')) return `${cleanHost}${p}`;
    if (p.startsWith('/file=')) return `${cleanHost}/gradio_api${p}`;
    return `${cleanHost}/gradio_api/file=${p}`;
  };
  if (typeof val === 'string' && (val.startsWith('http') || val.startsWith('data:') || val.includes('/'))) {
    return resolvePath(val);
  }
  if (Array.isArray(val)) {
    for (const item of val) {
      const found = extractGradioMediaUrl(item, spaceHost);
      if (found) return found;
    }
  }
  if (val && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    // Ignore empty Gradio UI update payloads that carry no media file
    if (obj.__type__ === 'update' && !obj.url && !obj.path && !obj.value && !obj.image) {
      return null;
    }
    if (typeof obj.url === 'string' && obj.url.trim()) return resolvePath(obj.url.trim());
    if (typeof obj.path === 'string' && obj.path.trim()) return resolvePath(obj.path.trim());
    if (obj.image) {
      const found = extractGradioMediaUrl(obj.image, spaceHost);
      if (found) return found;
    }
    if (obj.video) {
      const found = extractGradioMediaUrl(obj.video, spaceHost);
      if (found) return found;
    }
    if (obj.audio) {
      const found = extractGradioMediaUrl(obj.audio, spaceHost);
      if (found) return found;
    }
    if (obj.value) {
      const found = extractGradioMediaUrl(obj.value, spaceHost);
      if (found) return found;
    }
  }
  return null;
}

async function resolveGradioContext(
  ctx: ProviderExecutionContext,
  signal?: AbortSignal,
): Promise<ProviderExecutionContext> {
  const rawApiName = (
    typeof ctx.modelParameters?.apiName === 'string'
      ? ctx.modelParameters.apiName
      : ctx.modelIdentifier.split('::')[1] || 'predict'
  ).replace(/^\/+/, '');
  const isStaleUiHelper = isGradioUiHelperName(rawApiName);

  const hasParams =
    Array.isArray(ctx.modelParameters?.parameters) && ctx.modelParameters.parameters.length > 0;
  const paramSpaceHost =
    typeof ctx.modelParameters?.spaceHost === 'string' ? ctx.modelParameters.spaceHost : '';

  if (hasParams && paramSpaceHost && !isStaleUiHelper) {
    return ctx;
  }

  const spaceHost = paramSpaceHost
    ? normalizeBaseUrl(paramSpaceHost)
    : (await resolveHfSpaceRootUrl(ctx.baseUrl, ctx.apiKey, ctx.additionalHeaders)).resolvedRootUrl;

  if (hasParams && !isStaleUiHelper) {
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
        8000,
        signal,
      );
      if (!res.ok) continue;
      const info = (await res.json()) as {
        named_endpoints?: Record<
          string,
          {
            parameters?: Array<{
              label?: string;
              parameter_name?: string;
              type?: { type?: string; enum?: unknown[] };
              component?: string;
              parameter_has_default?: boolean;
              parameter_default?: unknown;
            }>;
            returns?: Array<{ label?: string; component?: string }>;
          }
        >;
      };
      const endpoints = info.named_endpoints ?? {};
      const realEntries = Object.entries(endpoints).filter(([k, v]) => {
        const clean = k.replace(/^\/+/, '');
        return !isGradioUiHelperName(clean) && ((v.parameters?.length ?? 0) > 0 || (v.returns?.length ?? 0) > 0);
      });

      let matchedKey = rawApiName;
      let entry = !isStaleUiHelper ? (endpoints[`/${rawApiName}`] ?? endpoints[rawApiName]) : undefined;

      if (!entry) {
        // Prefer inference endpoints like generate, infer, predict, run
        const preferred =
          realEntries.find(([k]) => /^\/?(generate|infer|predict|run|txt2img|create|synthesize|transcribe)/i.test(k)) ??
          realEntries[0] ??
          Object.entries(endpoints)[0];
        if (preferred) {
          matchedKey = preferred[0].replace(/^\/+/, '');
          entry = preferred[1];
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
            parameters: entry.parameters.map((p, idx) => ({
              index: idx,
              name: p.parameter_name || p.label || `arg_${idx}`,
              label: p.label || p.parameter_name || `arg_${idx}`,
              component: (p.component || p.type?.type || 'textbox').toLowerCase(),
              hasDefault: Boolean(p.parameter_has_default),
              defaultValue: p.parameter_default ?? null,
              ...(Array.isArray(p.type?.enum) ? { enum: p.type.enum } : {}),
            })),
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
): Promise<{ path?: string; url?: string; meta: { _type: 'gradio.FileData' } }> {
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

  for (const uploadUrl of [`${spaceHost}${prefix}/upload`, `${spaceHost}/upload`]) {
    try {
      const form = new FormData();
      form.append('files', new Blob([new Uint8Array(buffer)], { type: mimeType }), fileName);
      const res = await fetchWithTimeout(
        uploadUrl,
        { method: 'POST', headers: mergedHeaders, body: form },
        20000,
        signal,
      );
      if (!res.ok) continue;
      const uploaded = (await res.json()) as unknown;
      if (Array.isArray(uploaded) && typeof uploaded[0] === 'string' && uploaded[0].trim()) {
        return { path: uploaded[0].trim(), meta: { _type: 'gradio.FileData' } };
      }
    } catch {
      // fall through to next upload path or data URI fallback
    }
  }

  return {
    url: `data:${mimeType};base64,${buffer.toString('base64')}`,
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

function buildGradioInputPayload(
  ctx: ProviderExecutionContext,
  promptText: string,
  systemPrompt?: string,
  history?: Array<{ role: string; content: string }>,
  mediaInput?: string | { path?: string; url?: string; meta: { _type: 'gradio.FileData' } },
  options?: { aspectRatio?: string; mode?: 'generate' | 'edit' | 'variation' },
): unknown[] {
  const paramSpecs = Array.isArray(ctx.modelParameters?.parameters)
    ? (ctx.modelParameters.parameters as Array<{
        index?: number;
        name?: string;
        label?: string;
        component?: string;
        hasDefault?: boolean;
        defaultValue?: unknown;
        enum?: unknown[];
      }>)
    : null;

  const mediaPayload =
    typeof mediaInput === 'string'
      ? { url: mediaInput, meta: { _type: 'gradio.FileData' } }
      : mediaInput;

  if (!paramSpecs || paramSpecs.length === 0) {
    return mediaPayload ? [promptText, mediaPayload] : [promptText];
  }

  const isExcludedTextbox = (pname: string, plabel: string): boolean =>
    /negative|repo|file|lora|weight|system|token|key|password|seed|url|model|checkpoint/i.test(`${pname} ${plabel}`);

  // Pick the single best prompt slot before filling defaults
  let promptSlotIndex = paramSpecs.findIndex((spec) => {
    const comp = (spec.component ?? '').toLowerCase();
    const pname = (spec.name ?? '').toLowerCase();
    const plabel = (spec.label ?? '').toLowerCase();
    if (comp.includes('image') || comp.includes('audio') || comp.includes('file') || comp.includes('slider') || comp.includes('checkbox') || comp.includes('number')) {
      return false;
    }
    if (isExcludedTextbox(pname, plabel)) return false;
    return /prompt|message|query|instruction|text|input/i.test(`${pname} ${plabel}`);
  });

  if (promptSlotIndex === -1) {
    promptSlotIndex = paramSpecs.findIndex((spec) => {
      const comp = (spec.component ?? '').toLowerCase();
      const pname = (spec.name ?? '').toLowerCase();
      const plabel = (spec.label ?? '').toLowerCase();
      return (comp.includes('textbox') || comp.includes('text')) && !isExcludedTextbox(pname, plabel);
    });
  }

  const dims = mapAspectRatioToDimensions(options?.aspectRatio);
  const isCfWorker = Boolean(getCloudflareRequestContext()?.waitUntil);
  let injectedMedia = false;

  return paramSpecs.map((spec, idx) => {
    const comp = (spec.component ?? '').toLowerCase();
    const pname = (spec.name ?? '').toLowerCase();
    const plabel = (spec.label ?? '').toLowerCase();
    const isMediaComp =
      comp.includes('image') || comp.includes('audio') || comp.includes('video') || comp.includes('file') || comp.includes('gallery');

    if (isMediaComp) {
      if (mediaPayload && !injectedMedia) {
        injectedMedia = true;
        return mediaPayload;
      }
      return spec.hasDefault ? (spec.defaultValue ?? null) : null;
    }

    if (comp.includes('chatbot') || pname.includes('history')) {
      return (history ?? []).map((h) => [h.role === 'user' ? h.content : null, h.role === 'assistant' ? h.content : null]);
    }
    if (pname.includes('system') && systemPrompt) {
      return systemPrompt;
    }
    if (idx === promptSlotIndex) {
      return promptText;
    }

    // Mode selection (e.g., Text to Image vs Edit Image on AIO Spaces)
    if (
      (pname.includes('mode') || plabel.includes('mode')) &&
      Array.isArray(spec.enum) &&
      spec.enum.length > 0
    ) {
      if (options?.mode === 'edit' || options?.mode === 'variation') {
        const editChoice = spec.enum.find((v) => typeof v === 'string' && /edit|img2img|ref/i.test(v));
        if (editChoice !== undefined) return editChoice;
      } else if (options?.mode === 'generate') {
        const genChoice = spec.enum.find((v) => typeof v === 'string' && /text to image|txt2img|generate/i.test(v));
        if (genChoice !== undefined) return genChoice;
      }
    }

    // Aspect ratio dropdown matching (e.g. "Landscape · 16:9 (1344x768)")
    if (
      options?.aspectRatio &&
      (pname.includes('aspect') || pname.includes('ratio') || plabel.includes('aspect')) &&
      Array.isArray(spec.enum)
    ) {
      const ratioMatch = spec.enum.find(
        (v) => typeof v === 'string' && v.includes(options.aspectRatio!),
      );
      if (ratioMatch !== undefined) return ratioMatch;
    }

    // Explicit width / height sliders
    if (options?.aspectRatio && (comp.includes('slider') || comp.includes('number'))) {
      if (pname === 'width' || plabel === 'width') return dims.width;
      if (pname === 'height' || plabel === 'height') return dims.height;
    }

    // Cap very heavy default inference steps (e.g. 30-50 steps on slow ZeroGPU Spaces) so Cloudflare Workers completes cleanly
    if (
      (pname.includes('step') || plabel.includes('step')) &&
      (comp.includes('slider') || comp.includes('number')) &&
      typeof spec.defaultValue === 'number' &&
      spec.defaultValue > 12
    ) {
      return isCfWorker ? Math.min(spec.defaultValue, 12) : Math.min(spec.defaultValue, 20);
    }

    if (spec.hasDefault) {
      return spec.defaultValue ?? null;
    }
    if (Array.isArray(spec.enum) && spec.enum.length > 0) {
      return spec.enum[0];
    }
    if (comp.includes('slider') || comp.includes('number')) return 1;
    if (comp.includes('checkbox')) return false;
    return '';
  });
}

async function runGradioSpaceCall(
  ctx: ProviderExecutionContext,
  dataArgs: unknown[],
  signal?: AbortSignal,
): Promise<{ outputData: unknown[]; spaceHost: string }> {
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

  const prefix =
    typeof ctx.modelParameters?.endpointPrefix === 'string'
      ? ctx.modelParameters.endpointPrefix
      : '/gradio_api';

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ctx.apiKey.trim()) {
    headers.Authorization = `Bearer ${ctx.apiKey.trim()}`;
  }
  const mergedHeaders = mergeHeaders(headers, ctx.additionalHeaders);

  const candidates = [
    `${spaceHost}${prefix}/call/${apiName}`,
    `${spaceHost}/call/${apiName}`,
  ];

  let submitRes: Response | null = null;
  let activeCallUrl = candidates[0]!;

  for (const url of candidates) {
    const res = await fetchWithTimeout(
      url,
      { method: 'POST', headers: mergedHeaders, body: JSON.stringify({ data: dataArgs }) },
      20000,
      signal,
    );
    if (res.status !== 404) {
      submitRes = res;
      activeCallUrl = url;
      break;
    }
  }

  // Fallback for legacy Gradio `/api/predict`
  if (!submitRes) {
    const legacyUrl = `${spaceHost}/api/predict`;
    const legacyRes = await fetchWithTimeout(
      legacyUrl,
      { method: 'POST', headers: mergedHeaders, body: JSON.stringify({ data: dataArgs }) },
      45000,
      signal,
    );
    if (!legacyRes.ok) throw classifyHttpError(legacyRes.status, await legacyRes.text(), ctx.apiKey);
    const json = (await legacyRes.json()) as { data?: unknown[] };
    return { outputData: Array.isArray(json.data) ? json.data : [], spaceHost };
  }

  if (!submitRes.ok) {
    const errBody = await submitRes.text();
    if (submitRes.status === 503 && /queue is stopped|sleeping|building|paused|no space/i.test(errBody)) {
      throw new AIProviderError({
        code: 'PROVIDER_ERROR',
        message: `HF Space unavailable (${submitRes.status}): ${redactSecrets(errBody.slice(0, 200), ctx.apiKey ? [ctx.apiKey] : [])}`,
        userMessageFa: 'این مدل در حال حاضر در دسترس نیست. لطفاً مدل دیگری انتخاب کنید.',
        retryable: false,
        httpStatus: 503,
        credentialFailureKind: 'transient',
      });
    }
    throw classifyHttpError(submitRes.status, errBody, ctx.apiKey);
  }

  const { event_id: eventId } = (await submitRes.json()) as { event_id?: string };
  if (!eventId) {
    throw new AIProviderError({
      code: 'PROVIDER_ERROR',
      message: 'Hugging Face Space did not return an event_id.',
      userMessageFa: 'پاسخی از سرور پردازش دریافت نشد. لطفاً دوباره تلاش کنید.',
    });
  }

  // Keep a single active AbortController across BOTH the SSE connect AND the entire streaming body read.
  // Inside Cloudflare Workers waitUntil (30s hard kill), finish cleanly before 24s so catch+refund always execute.
  const isCfBackgroundWaitUntil = Boolean(getCloudflareRequestContext()?.childWaitUntilTasks);
  const sseTimeoutMs = isCfBackgroundWaitUntil ? 24_000 : 55_000;
  const sseController = new AbortController();
  let timedOut = false;
  const sseTimer = setTimeout(() => {
    timedOut = true;
    sseController.abort();
  }, sseTimeoutMs);
  const onExternalAbort = () => sseController.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });

  const parseSseBlock = (
    block: string,
  ): { kind: 'complete'; data: unknown[] } | { kind: 'error'; raw: string } | null => {
    const lines = block.split(/\r?\n/);
    let eventName = '';
    const dataLines: string[] = [];
    for (const l of lines) {
      if (l.startsWith('event:')) eventName = l.slice(6).trim();
      if (l.startsWith('data:')) dataLines.push(l.slice(5).trim());
    }
    const payloadRaw = dataLines.join('\n');
    if (eventName === 'error') {
      return { kind: 'error', raw: payloadRaw };
    }
    if (eventName === 'complete' && payloadRaw) {
      const parsed = JSON.parse(payloadRaw) as unknown;
      return { kind: 'complete', data: Array.isArray(parsed) ? parsed : [parsed] };
    }
    return null;
  };

  try {
    const sseRes = await fetch(`${activeCallUrl}/${encodeURIComponent(eventId)}`, {
      method: 'GET',
      headers: mergeHeaders({ Accept: 'text/event-stream' }, mergedHeaders),
      signal: sseController.signal,
    });
    if (!sseRes.ok) {
      throw classifyHttpError(sseRes.status, await sseRes.text(), ctx.apiKey);
    }

    if (!sseRes.body) {
      const sseText = await sseRes.text();
      for (const block of sseText.split(/\r?\n\r?\n/)) {
        const parsed = parseSseBlock(block);
        if (parsed?.kind === 'error') {
          const isQuota = isQuotaExhaustedSignal(parsed.raw);
          throw new AIProviderError({
            code: isQuota ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
            message: `HF Space error: ${redactSecrets(parsed.raw, ctx.apiKey ? [ctx.apiKey] : [])}`,
            userMessageFa: isQuota
              ? 'سرویس این مدل موقتاً شلوغ است. لطفاً لحظاتی دیگر دوباره تلاش کنید یا مدل دیگری انتخاب نمایید.'
              : 'پردازش درخواست با خطا مواجه شد. لطفاً دوباره تلاش کنید.',
            retryable: true,
            credentialFailureKind: isQuota ? 'quota_exhausted' : 'transient',
          });
        }
        if (parsed?.kind === 'complete') {
          return { outputData: parsed.data, spaceHost };
        }
      }
      throw new AIProviderError({
        code: 'PROVIDER_ERROR',
        message: 'Hugging Face Space stream ended without complete event.',
        userMessageFa: 'خروجی کاملی از مدل دریافت نشد. لطفاً دوباره تلاش کنید.',
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
          const parsed = parseSseBlock(block);
          if (parsed?.kind === 'error') {
            await reader.cancel().catch(() => {});
            const isQuota = isQuotaExhaustedSignal(parsed.raw);
            throw new AIProviderError({
              code: isQuota ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
              message: `HF Space error: ${redactSecrets(parsed.raw, ctx.apiKey ? [ctx.apiKey] : [])}`,
              userMessageFa: isQuota
                ? 'سرویس این مدل موقتاً شلوغ است. لطفاً لحظاتی دیگر دوباره تلاش کنید یا مدل دیگری انتخاب نمایید.'
                : 'پردازش درخواست با خطا مواجه شد. لطفاً دوباره تلاش کنید.',
              retryable: true,
              credentialFailureKind: isQuota ? 'quota_exhausted' : 'transient',
            });
          }
          if (parsed?.kind === 'complete') {
            await reader.cancel().catch(() => {});
            return { outputData: parsed.data, spaceHost };
          }
        }
      }

      // Process any trailing block after stream EOF
      if (buffer.trim()) {
        const parsed = parseSseBlock(buffer);
        if (parsed?.kind === 'error') {
          const isQuota = isQuotaExhaustedSignal(parsed.raw);
          throw new AIProviderError({
            code: isQuota ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
            message: `HF Space error: ${redactSecrets(parsed.raw, ctx.apiKey ? [ctx.apiKey] : [])}`,
            userMessageFa: isQuota
              ? 'سرویس این مدل موقتاً شلوغ است. لطفاً لحظاتی دیگر دوباره تلاش کنید یا مدل دیگری انتخاب نمایید.'
              : 'پردازش درخواست با خطا مواجه شد. لطفاً دوباره تلاش کنید.',
            retryable: true,
            credentialFailureKind: isQuota ? 'quota_exhausted' : 'transient',
          });
        }
        if (parsed?.kind === 'complete') {
          return { outputData: parsed.data, spaceHost };
        }
      }
    } finally {
      reader.releaseLock();
    }

    throw new AIProviderError({
      code: 'PROVIDER_ERROR',
      message: 'Hugging Face Space stream ended without complete event.',
      userMessageFa: 'خروجی کاملی از مدل دریافت نشد. لطفاً دوباره تلاش کنید.',
    });
  } catch (err) {
    if (err instanceof AIProviderError) throw err;
    if (timedOut) {
      throw new AIProviderError({
        code: 'TIMEOUT',
        message: `Hugging Face Space SSE queue timed out after ${Math.round(sseTimeoutMs / 1000)}s.`,
        userMessageFa: 'زمان پاسخ‌گویی این مدل به پایان رسید (صف شلوغ است). لطفاً دوباره تلاش کنید یا مدل دیگری انتخاب نمایید.',
        retryable: true,
        credentialFailureKind: 'transient',
      });
    }
    throw err;
  } finally {
    clearTimeout(sseTimer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
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
      ctx.providerType === 'huggingface'
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

    if (ctx.providerType === 'huggingface_space') {
      const resolvedCtx = await resolveGradioContext(ctx, input.signal);
      const lastUser = [...input.messages].reverse().find((m) => m.role === 'user');
      const promptText = lastUser?.content || input.messages.map((m) => m.content).join('\n');
      const mediaDataUri =
        lastUser?.imageBase64 && lastUser?.imageMimeType
          ? `data:${lastUser.imageMimeType};base64,${lastUser.imageBase64}`
          : undefined;

      const args = buildGradioInputPayload(
        resolvedCtx,
        promptText,
        input.systemPrompt,
        input.messages.slice(0, -1),
        mediaDataUri,
      );
      const { outputData } = await runGradioSpaceCall(resolvedCtx, args, input.signal);
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
  const res = await fetchWithTimeout(url, { method: 'GET', headers }, 45000);
  if (!res.ok) {
    throw classifyHttpError(res.status, await res.text(), apiKey);
  }
  const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
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

    if (ctx.providerType === 'huggingface') {
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

    if (ctx.providerType === 'huggingface_space') {
      const resolvedCtx = await resolveGradioContext(ctx, input.signal);
      const args = buildGradioInputPayload(resolvedCtx, input.prompt, undefined, undefined, undefined, {
        aspectRatio: input.aspectRatio,
        mode: 'generate',
      });
      const { outputData, spaceHost } = await runGradioSpaceCall(resolvedCtx, args, input.signal);
      const mediaUrl = extractGradioMediaUrl(outputData, spaceHost);
      if (!mediaUrl) {
        throw new AIProviderError({
          code: 'PROVIDER_ERROR',
          message: 'Hugging Face Space returned no image output.',
          userMessageFa: 'تصویری تولید نشد. لطفاً دوباره تلاش کنید.',
        });
      }
      const dl = await downloadBinarySafe(mediaUrl, resolvedCtx.apiKey, true);
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

export async function generateImageWithRoute(
  route: LoadedModelRoute,
  input: ImageGenerationInput,
): Promise<{ result: ImageOutput; usedFallback: boolean; providerId: string }> {
  assertCapabilitySupported(route.primary, 'image_generation');
  return runWithFailover(route, (ctx) => executeImageGenOnProvider(ctx, input));
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

    if (ctx.providerType === 'huggingface') {
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

    if (ctx.providerType === 'huggingface_space') {
      const resolvedCtx = await resolveGradioContext(ctx, input.signal);
      const uploadedImg = await uploadMediaToGradioSpace(
        resolvedCtx,
        input.sourceImageBuffer,
        input.sourceMimeType,
        input.sourceMimeType.includes('png') ? 'source.png' : 'source.jpg',
        input.signal,
      );
      const promptText =
        input.mode === 'variation'
          ? `Create a stylized variation. ${input.prompt || ''}`.trim()
          : input.prompt;
      const args = buildGradioInputPayload(resolvedCtx, promptText, undefined, undefined, uploadedImg, {
        aspectRatio: input.aspectRatio,
        mode: input.mode,
      });
      const { outputData, spaceHost } = await runGradioSpaceCall(resolvedCtx, args, input.signal);
      const mediaUrl = extractGradioMediaUrl(outputData, spaceHost);
      if (!mediaUrl) {
        throw new AIProviderError({
          code: 'PROVIDER_ERROR',
          message: 'Hugging Face Space returned no edited image.',
          userMessageFa: 'ویرایش تصویر نتیجه‌ای برنگرداند. لطفاً دوباره تلاش کنید.',
        });
      }
      const dl = await downloadBinarySafe(mediaUrl, resolvedCtx.apiKey, true);
      return {
        images: [
          {
            buffer: dl.buffer,
            mimeType: dl.mimeType,
            extension: dl.mimeType.includes('jpeg') ? 'jpg' : 'png',
          },
        ],
        costUsd: 0,
      };
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

    if (ctx.providerType === 'huggingface') {
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

    if (ctx.providerType === 'huggingface_space') {
      const resolvedCtx = await resolveGradioContext(ctx, input.signal);
      const uploadedAudio = await uploadMediaToGradioSpace(
        resolvedCtx,
        input.audioBuffer,
        input.mimeType || 'audio/ogg',
        input.fileName || 'voice.ogg',
        input.signal,
      );
      const args = buildGradioInputPayload(resolvedCtx, '', undefined, undefined, uploadedAudio);
      const { outputData } = await runGradioSpaceCall(resolvedCtx, args, input.signal);
      return {
        text: extractGradioOutputText(outputData).trim(),
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

    if (ctx.providerType === 'huggingface') {
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

    if (ctx.providerType === 'huggingface_space') {
      const resolvedCtx = await resolveGradioContext(ctx, input.signal);
      const args = buildGradioInputPayload(resolvedCtx, input.text);
      const { outputData, spaceHost } = await runGradioSpaceCall(resolvedCtx, args, input.signal);
      const mediaUrl = extractGradioMediaUrl(outputData, spaceHost);
      if (!mediaUrl) {
        throw new AIProviderError({
          code: 'PROVIDER_ERROR',
          message: 'Hugging Face Space returned no audio output.',
          userMessageFa: 'خروجی صوتی از مدل دریافت نشد. لطفاً دوباره تلاش کنید.',
        });
      }
      const dl = await downloadBinarySafe(mediaUrl, resolvedCtx.apiKey, true);
      const ext = dl.mimeType.includes('mpeg') ? 'mp3' : dl.mimeType.includes('ogg') ? 'ogg' : 'wav';
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

    return { status: 'failed', progressPercent: 0, errorMessage: 'پشتیبانی از polling این ارائه‌دهنده تعریف نشده است.' };
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
