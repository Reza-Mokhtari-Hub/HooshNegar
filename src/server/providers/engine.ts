import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import { aiModels, aiProviders, modelCapabilities, providerCredentials } from '../../db/schema.ts';
import type { CapabilityType } from '../../shared/validation.ts';
import { isAiMockModeEnabled } from '../config/env.ts';
import { decryptSecret, redactSecrets } from '../security/crypto.ts';
import { assertSafeOutboundUrl, SsrfProtectionError } from '../security/ssrf.ts';
import {
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

function isQuotaExhaustedSignal(text: string): boolean {
  return /insufficient_quota|quota[_\s-]?exceeded|exceeded your current quota|resource_exhausted|credit balance is too low|billing|payment required|zerogpu.*quota|daily.*limit/i.test(
    text,
  );
}

function isInvalidKeySignal(text: string): boolean {
  return /api_key_invalid|invalid[_\s-]?api[_\s-]?key|incorrect api key|invalid token|unauthorized|authentication failed|permission_denied/i.test(
    text,
  );
}

function classifyHttpError(status: number, bodyText: string, apiKey: string): AIProviderError {
  const secrets = apiKey ? [apiKey] : [];
  const safeMsg = redactSecrets(bodyText.slice(0, 300), secrets);

  if (status === 402 || (status === 429 && isQuotaExhaustedSignal(bodyText))) {
    return new AIProviderError({
      code: 'RATE_LIMITED',
      message: `Provider quota exhausted (${status}): ${safeMsg}`,
      userMessageFa: 'سهمیه کلید API این ارائه‌دهنده به پایان رسیده است.',
      retryable: true,
      httpStatus: status,
      credentialFailureKind: 'quota_exhausted',
    });
  }

  if (status === 401 || status === 403 || isInvalidKeySignal(bodyText)) {
    return new AIProviderError({
      code: 'INVALID_API_KEY',
      message: `Provider auth failed (${status}): ${safeMsg}`,
      userMessageFa: 'کلید API ارائه‌دهنده نامعتبر یا منقضی است. لطفاً به پشتیبانی اطلاع دهید.',
      retryable: false,
      httpStatus: status,
      credentialFailureKind: 'invalid',
    });
  }

  if (status === 429) {
    return new AIProviderError({
      code: 'RATE_LIMITED',
      message: `Provider rate limited (429): ${safeMsg}`,
      userMessageFa: 'سرویس هوش مصنوعی موقتاً شلوغ است (محدودیت نرخ). لطفاً لحظاتی بعد دوباره تلاش کنید.',
      retryable: true,
      httpStatus: 429,
      credentialFailureKind: 'rate_limited',
    });
  }

  if (status === 400 || status === 422) {
    if (isQuotaExhaustedSignal(bodyText)) {
      return new AIProviderError({
        code: 'RATE_LIMITED',
        message: `Provider quota exhausted (${status}): ${safeMsg}`,
        userMessageFa: 'سهمیه کلید API این ارائه‌دهنده به پایان رسیده است.',
        retryable: true,
        httpStatus: status,
        credentialFailureKind: 'quota_exhausted',
      });
    }
    return new AIProviderError({
      code: 'INVALID_PROMPT',
      message: `Provider rejected input (${status}): ${safeMsg}`,
      userMessageFa: 'درخواست یا ورودی ارسال‌شده توسط مدل هوش مصنوعی پذیرفته نشد. لطفاً متن یا فایل را اصلاح کنید.',
      retryable: false,
      httpStatus: status,
      credentialFailureKind: 'prompt_error',
    });
  }

  return new AIProviderError({
    code: 'PROVIDER_ERROR',
    message: `Provider HTTP ${status}: ${safeMsg}`,
    userMessageFa: 'خطایی از سمت سرویس هوش مصنوعی رخ داد. اعتبار شما کسر نشد.',
    retryable: status >= 500 || status === 408,
    httpStatus: status,
    credentialFailureKind: 'transient',
  });
}

function wrapNetworkError(err: unknown, apiKey: string): AIProviderError {
  if (err instanceof AIProviderError) return err;
  const secrets = apiKey ? [apiKey] : [];
  if (err instanceof SsrfProtectionError) {
    return new AIProviderError({
      code: 'SSRF_BLOCKED',
      message: err.message,
      userMessageFa: 'آدرس ارائه‌دهنده به دلیل قوانین امنیتی مسدود شده است.',
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
      userMessageFa: 'کلید API ارائه‌دهنده نامعتبر یا منقضی است.',
      retryable: false,
      credentialFailureKind: 'invalid',
    });
  }

  if (isQuotaExhaustedSignal(rawMsg)) {
    return new AIProviderError({
      code: 'RATE_LIMITED',
      message: msg,
      userMessageFa: 'سهمیه کلید API این ارائه‌دهنده به پایان رسیده است.',
      retryable: true,
      httpStatus: 429,
      credentialFailureKind: 'quota_exhausted',
    });
  }

  if (/\b429\b|too many requests|rate[_\s-]?limit/i.test(rawMsg)) {
    return new AIProviderError({
      code: 'RATE_LIMITED',
      message: msg,
      userMessageFa: 'سرویس هوش مصنوعی موقتاً شلوغ است (محدودیت نرخ).',
      retryable: true,
      httpStatus: 429,
      credentialFailureKind: 'rate_limited',
    });
  }

  if (err instanceof Error && err.name === 'AbortError') {
    return new AIProviderError({
      code: 'TIMEOUT',
      message: `Request aborted or timed out: ${msg}`,
      userMessageFa: 'زمان پاسخ‌گویی مدل هوش مصنوعی به پایان رسید یا عملیات متوقف شد.',
      retryable: true,
      credentialFailureKind: 'transient',
    });
  }

  return new AIProviderError({
    code: 'NETWORK_ERROR',
    message: msg,
    userMessageFa: 'خطای شبکه در ارتباط با سرویس هوش مصنوعی رخ داد. اعتبار شما بازگردانده شد.',
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
}): Promise<ProviderExecutionContext | null> {
  const db = getDb();
  const [provider] = await db
    .select()
    .from(aiProviders)
    .where(and(eq(aiProviders.id, params.providerId), eq(aiProviders.isActive, true)))
    .limit(1);

  if (!provider) return null;

  const creds = await db
    .select()
    .from(providerCredentials)
    .where(and(eq(providerCredentials.providerId, provider.id), eq(providerCredentials.isActive, true)))
    .orderBy(asc(providerCredentials.priority), asc(providerCredentials.failureCount), desc(providerCredentials.keyVersion));

  const nowMs = Date.now();
  const usableCreds = creds.filter((c) => {
    if (c.status === 'invalid' || c.status === 'disabled') return false;
    if (c.cooldownUntil && new Date(c.cooldownUntil).getTime() > nowMs) return false;
    return true;
  });

  // Order healthy 'active' keys ahead of cooled-down/expired-cooldown keys
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

  if (usableCreds.length === 0) {
    // Public Hugging Face Spaces can operate without an API token if no credentials were attached
    if (provider.providerType === 'huggingface_space' && creds.length === 0) {
      const anonCtx: ProviderExecutionContext = {
        ...baseMeta,
        apiKey: '',
        credentialId: null,
      };
      anonCtx.credentialPool = [anonCtx];
      return anonCtx;
    }
    return null;
  }

  const contexts: ProviderExecutionContext[] = usableCreds.map((c) => ({
    ...baseMeta,
    credentialId: c.id,
    apiKey: decryptSecret({
      ciphertext: c.encryptedApiKey,
      iv: c.iv,
      authTag: c.authTag,
    }),
  }));

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
  });

  if (!primary) {
    throw new AIProviderError({
      code: 'INVALID_API_KEY',
      message: 'Primary provider is inactive or missing active API credentials.',
      userMessageFa: 'ارائه‌دهنده این مدل در حال حاضر غیرفعال یا فاقد کلید API معتبر است.',
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
      cooldownUntil = new Date(Date.now() + 6 * 60 * 60 * 1000); // 6 hours
    } else if (kind === 'rate_limited') {
      nextStatus = 'rate_limited';
      cooldownUntil = new Date(Date.now() + 90 * 1000); // 90 seconds
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
      userMessageFa: 'همه کلیدهای فعال این ارائه‌دهنده با خطا مواجه شدند یا سهمیه آن‌ها تمام شده است.',
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
    if (typeof obj.url === 'string') return resolvePath(obj.url);
    if (typeof obj.path === 'string') return resolvePath(obj.path);
    if (obj.image) return extractGradioMediaUrl(obj.image, spaceHost);
    if (obj.value) return extractGradioMediaUrl(obj.value, spaceHost);
  }
  return null;
}

async function resolveGradioContext(
  ctx: ProviderExecutionContext,
  signal?: AbortSignal,
): Promise<ProviderExecutionContext> {
  const hasParams =
    Array.isArray(ctx.modelParameters?.parameters) && ctx.modelParameters.parameters.length > 0;
  const paramSpaceHost =
    typeof ctx.modelParameters?.spaceHost === 'string' ? ctx.modelParameters.spaceHost : '';

  if (hasParams && paramSpaceHost) {
    return ctx;
  }

  const spaceHost = paramSpaceHost
    ? normalizeBaseUrl(paramSpaceHost)
    : (await resolveHfSpaceRootUrl(ctx.baseUrl, ctx.apiKey, ctx.additionalHeaders)).resolvedRootUrl;

  if (hasParams) {
    return {
      ...ctx,
      modelParameters: { ...(ctx.modelParameters ?? {}), spaceHost },
    };
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (ctx.apiKey.trim()) headers.Authorization = `Bearer ${ctx.apiKey.trim()}`;
  const merged = mergeHeaders(headers, ctx.additionalHeaders);

  const apiName = (
    typeof ctx.modelParameters?.apiName === 'string'
      ? ctx.modelParameters.apiName
      : ctx.modelIdentifier.split('::')[1] || 'predict'
  ).replace(/^\/+/, '');

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
              type?: { type?: string };
              component?: string;
              parameter_has_default?: boolean;
              parameter_default?: unknown;
            }>;
          }
        >;
      };
      const endpoints = info.named_endpoints ?? {};
      const entry =
        endpoints[`/${apiName}`] ?? endpoints[apiName] ?? Object.values(endpoints)[0];
      const matchedKey =
        endpoints[`/${apiName}`] || endpoints[apiName]
          ? apiName
          : Object.keys(endpoints)[0]?.replace(/^\/+/, '') || apiName;
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
              component: (p.component || p.type?.type || 'textbox').toLowerCase(),
              hasDefault: Boolean(p.parameter_has_default),
              defaultValue: p.parameter_default ?? null,
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

function buildGradioInputPayload(
  ctx: ProviderExecutionContext,
  promptText: string,
  systemPrompt?: string,
  history?: Array<{ role: string; content: string }>,
  mediaDataUri?: string,
): unknown[] {
  const paramSpecs = Array.isArray(ctx.modelParameters?.parameters)
    ? (ctx.modelParameters.parameters as Array<{
        index?: number;
        name?: string;
        component?: string;
        hasDefault?: boolean;
        defaultValue?: unknown;
      }>)
    : null;

  if (!paramSpecs || paramSpecs.length === 0) {
    return mediaDataUri ? [promptText, mediaDataUri] : [promptText];
  }

  let injectedPrompt = false;
  let injectedMedia = false;

  return paramSpecs.map((spec) => {
    const comp = (spec.component ?? '').toLowerCase();
    const pname = (spec.name ?? '').toLowerCase();

    if (mediaDataUri && !injectedMedia && (comp.includes('image') || comp.includes('audio') || comp.includes('file'))) {
      injectedMedia = true;
      return { url: mediaDataUri, meta: { _type: 'gradio.FileData' } };
    }
    if (comp.includes('chatbot') || pname.includes('history')) {
      return (history ?? []).map((h) => [h.role === 'user' ? h.content : null, h.role === 'assistant' ? h.content : null]);
    }
    if (pname.includes('system') && systemPrompt) {
      return systemPrompt;
    }
    if (
      !injectedPrompt &&
      (comp.includes('textbox') || comp.includes('text') || pname.includes('prompt') || pname.includes('message') || pname.includes('input'))
    ) {
      injectedPrompt = true;
      return promptText;
    }
    if (spec.hasDefault) {
      return spec.defaultValue ?? null;
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
      30000,
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
      60000,
      signal,
    );
    if (!legacyRes.ok) throw classifyHttpError(legacyRes.status, await legacyRes.text(), ctx.apiKey);
    const json = (await legacyRes.json()) as { data?: unknown[] };
    return { outputData: Array.isArray(json.data) ? json.data : [], spaceHost };
  }

  if (!submitRes.ok) {
    throw classifyHttpError(submitRes.status, await submitRes.text(), ctx.apiKey);
  }

  const { event_id: eventId } = (await submitRes.json()) as { event_id?: string };
  if (!eventId) {
    throw new AIProviderError({
      code: 'PROVIDER_ERROR',
      message: 'Hugging Face Space did not return an event_id.',
      userMessageFa: 'پاسخی از صف پردازش Hugging Face Space دریافت نشد.',
    });
  }

  const sseRes = await fetchWithTimeout(
    `${activeCallUrl}/${encodeURIComponent(eventId)}`,
    { method: 'GET', headers: mergedHeaders },
    90000,
    signal,
  );
  if (!sseRes.ok) {
    throw classifyHttpError(sseRes.status, await sseRes.text(), ctx.apiKey);
  }

  const sseText = await sseRes.text();
  const blocks = sseText.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let eventName = '';
    const dataLines: string[] = [];
    for (const l of lines) {
      if (l.startsWith('event:')) eventName = l.slice(6).trim();
      if (l.startsWith('data:')) dataLines.push(l.slice(5).trim());
    }
    const payloadRaw = dataLines.join('\n');
    if (eventName === 'error') {
      const isQuota = isQuotaExhaustedSignal(payloadRaw);
      throw new AIProviderError({
        code: isQuota ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
        message: `HF Space error: ${redactSecrets(payloadRaw, ctx.apiKey ? [ctx.apiKey] : [])}`,
        userMessageFa: isQuota
          ? 'سهمیه ZeroGPU توکن فعلی به پایان رسیده است.'
          : 'اجرای پردازش در Hugging Face Space با خطا مواجه شد.',
        retryable: true,
        credentialFailureKind: isQuota ? 'quota_exhausted' : 'transient',
      });
    }
    if (eventName === 'complete' && payloadRaw) {
      const parsed = JSON.parse(payloadRaw) as unknown;
      return {
        outputData: Array.isArray(parsed) ? parsed : [parsed],
        spaceHost,
      };
    }
  }

  throw new AIProviderError({
    code: 'PROVIDER_ERROR',
    message: 'Hugging Face Space stream ended without complete event.',
    userMessageFa: 'خروجی کاملی از Hugging Face Space دریافت نشد.',
  });
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
        text: text || 'پاسخی از Hugging Face Space دریافت نشد.',
        inputTokens: inTok,
        outputTokens: outTok,
        costUsd: 0,
      };
    }

    throw new AIProviderError({
      code: 'UNSUPPORTED_CAPABILITY',
      message: `Provider type ${ctx.providerType} does not support text/chat completion.`,
      userMessageFa: 'این ارائه‌دهنده از گفتگوی متنی پشتیبانی نمی‌کند.',
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
          throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
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
              ? 'درخواست تولید تصویر توسط فیلتر ایمنی Imagen مسدود شد. لطفاً پرامپت را تغییر دهید.'
              : 'مدل Imagen خروجی تصویر برنگرداند. لطفاً پرامپت را تغییر دهید.',
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
            throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
          }
        } else {
          throw classifyHttpError(res.status, errBody, ctx.apiKey);
        }
      } else if (!res.ok) {
        throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
      }

      const json = (await res.json()) as GeminiGenerateContentResponse;
      assertGeminiNotBlocked(json, true);
      const images = extractGeminiCandidateImages(json.candidates);
      if (images.length === 0) {
        throw new AIProviderError({
          code: 'PROVIDER_ERROR',
          message: 'Gemini returned no image parts.',
          userMessageFa: 'مدل تصویری خروجی تولید نکرد. لطفاً پرامپت را تغییر دهید.',
        });
      }
      return { images, costUsd: 0.03 * images.length };
    }

    if (ctx.providerType === 'openai_compatible' || ctx.providerType === 'custom') {
      const url = `${normalizeOpenAiRootBaseUrl(ctx.baseUrl)}/images/generations`;
      const sizeMap: Record<string, string> = {
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
            n: Math.min(Math.max(input.count ?? 1, 1), 4),
            size,
          }),
        },
        90000,
        input.signal,
      );
      if (!res.ok) throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
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
          userMessageFa: 'تولید تصویر در Replicate با خطا مواجه شد.',
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
            inputs: input.prompt,
            parameters: { ...(ctx.modelParameters ?? {}) },
          }),
        },
        90000,
        input.signal,
      );
      if (!res.ok) throw classifyHttpError(res.status, await res.text(), ctx.apiKey);
      const contentType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
      if (contentType.includes('application/json')) {
        const jsonBody = (await res.json()) as { error?: string; image?: string; url?: string };
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

    if (ctx.providerType === 'huggingface_space') {
      const resolvedCtx = await resolveGradioContext(ctx, input.signal);
      const args = buildGradioInputPayload(resolvedCtx, input.prompt);
      const { outputData, spaceHost } = await runGradioSpaceCall(resolvedCtx, args, input.signal);
      const mediaUrl = extractGradioMediaUrl(outputData, spaceHost);
      if (!mediaUrl) {
        throw new AIProviderError({
          code: 'PROVIDER_ERROR',
          message: 'Hugging Face Space returned no image output.',
          userMessageFa: 'تصویری از خروجی Hugging Face Space دریافت نشد.',
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
      userMessageFa: 'این ارائه‌دهنده از تولید تصویر پشتیبانی نمی‌کند.',
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
          userMessageFa: 'ویرایش تصویر در Replicate با خطا مواجه شد.',
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
      const dataUri = `data:${input.sourceMimeType};base64,${input.sourceImageBuffer.toString('base64')}`;
      const promptText =
        input.mode === 'variation'
          ? `Create a stylized variation. ${input.prompt || ''}`.trim()
          : input.prompt;
      const args = buildGradioInputPayload(resolvedCtx, promptText, undefined, undefined, dataUri);
      const { outputData, spaceHost } = await runGradioSpaceCall(resolvedCtx, args, input.signal);
      const mediaUrl = extractGradioMediaUrl(outputData, spaceHost);
      if (!mediaUrl) {
        throw new AIProviderError({
          code: 'PROVIDER_ERROR',
          message: 'Hugging Face Space returned no edited image.',
          userMessageFa: 'ویرایش تصویر در Hugging Face Space نتیجه‌ای برنگرداند.',
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
      userMessageFa: 'این ارائه‌دهنده از ویرایش تصویر پشتیبانی نمی‌کند.',
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

    if (ctx.providerType === 'huggingface_space') {
      const resolvedCtx = await resolveGradioContext(ctx, input.signal);
      const dataUri = `data:${input.mimeType};base64,${input.audioBuffer.toString('base64')}`;
      const args = buildGradioInputPayload(resolvedCtx, '', undefined, undefined, dataUri);
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
      userMessageFa: 'این ارائه‌دهنده از تبدیل گفتار به متن پشتیبانی نمی‌کند.',
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

    if (ctx.providerType === 'huggingface_space') {
      const resolvedCtx = await resolveGradioContext(ctx, input.signal);
      const args = buildGradioInputPayload(resolvedCtx, input.text);
      const { outputData, spaceHost } = await runGradioSpaceCall(resolvedCtx, args, input.signal);
      const mediaUrl = extractGradioMediaUrl(outputData, spaceHost);
      if (!mediaUrl) {
        throw new AIProviderError({
          code: 'PROVIDER_ERROR',
          message: 'Hugging Face Space returned no audio output.',
          userMessageFa: 'خروجی صوتی از Hugging Face Space دریافت نشد.',
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
      userMessageFa: 'این ارائه‌دهنده از تبدیل متن به گفتار پشتیبانی نمی‌کند.',
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
        userMessageFa: 'ارائه‌دهنده انتخاب‌شده از تولید ویدیو پشتیبانی نمی‌کند.',
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
