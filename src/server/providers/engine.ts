import { GoogleGenAI } from '@google/genai';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import { aiModels, aiProviders, modelCapabilities, providerCredentials } from '../../db/schema.ts';
import type { CapabilityType } from '../../shared/validation.ts';
import { isAiMockModeEnabled } from '../config/env.ts';
import { decryptSecret, redactSecrets } from '../security/crypto.ts';
import { assertSafeOutboundUrl, SsrfProtectionError } from '../security/ssrf.ts';
import {
  AIProviderError,
  estimateTokenCostUsd,
  estimateTokensRough,
  type AudioTranscriptionInput,
  type AudioTranscriptionOutput,
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

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
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

function classifyHttpError(status: number, bodyText: string, apiKey: string): AIProviderError {
  const safeMsg = redactSecrets(bodyText.slice(0, 300), [apiKey]);
  if (status === 401 || status === 403) {
    return new AIProviderError({
      code: 'INVALID_API_KEY',
      message: `Provider auth failed (${status}): ${safeMsg}`,
      userMessageFa: 'کلید API ارائه‌دهنده نامعتبر یا منقضی است. لطفاً به پشتیبانی اطلاع دهید.',
      retryable: false,
      httpStatus: status,
    });
  }
  if (status === 429) {
    return new AIProviderError({
      code: 'RATE_LIMITED',
      message: `Provider rate limited (429): ${safeMsg}`,
      userMessageFa: 'سرویس هوش مصنوعی موقتاً شلوغ است (محدودیت نرخ). لطفاً لحظاتی بعد دوباره تلاش کنید.',
      retryable: true,
      httpStatus: 429,
    });
  }
  if (status === 400 || status === 422) {
    return new AIProviderError({
      code: 'INVALID_PROMPT',
      message: `Provider rejected input (${status}): ${safeMsg}`,
      userMessageFa: 'درخواست یا ورودی ارسال‌شده توسط مدل هوش مصنوعی پذیرفته نشد. لطفاً متن یا فایل را اصلاح کنید.',
      retryable: false,
      httpStatus: status,
    });
  }
  return new AIProviderError({
    code: 'PROVIDER_ERROR',
    message: `Provider HTTP ${status}: ${safeMsg}`,
    userMessageFa: 'خطایی از سمت سرویس هوش مصنوعی رخ داد. اعتبار شما کسر نشد.',
    retryable: status >= 500 || status === 408,
    httpStatus: status,
  });
}

function wrapNetworkError(err: unknown, apiKey: string): AIProviderError {
  if (err instanceof AIProviderError) return err;
  if (err instanceof SsrfProtectionError) {
    return new AIProviderError({
      code: 'SSRF_BLOCKED',
      message: err.message,
      userMessageFa: 'آدرس ارائه‌دهنده به دلیل قوانین امنیتی مسدود شده است.',
      retryable: false,
    });
  }
  const msg = redactSecrets(err instanceof Error ? err.message : 'Network error', [apiKey]);
  if (err instanceof Error && err.name === 'AbortError') {
    return new AIProviderError({
      code: 'TIMEOUT',
      message: `Request aborted or timed out: ${msg}`,
      userMessageFa: 'زمان پاسخ‌گویی مدل هوش مصنوعی به پایان رسید یا عملیات متوقف شد.',
      retryable: true,
    });
  }
  return new AIProviderError({
    code: 'NETWORK_ERROR',
    message: msg,
    userMessageFa: 'خطای شبکه در ارتباط با سرویس هوش مصنوعی رخ داد. اعتبار شما بازگردانده شد.',
    retryable: true,
  });
}

function assertCapabilitySupported(ctx: ProviderExecutionContext, required: CapabilityType): void {
  if (!ctx.supportedCapabilities.includes(required)) {
    throw new AIProviderError({
      code: 'UNSUPPORTED_CAPABILITY',
      message: `Model ${ctx.modelIdentifier} does not have capability ${required} enabled.`,
      userMessageFa: 'مدل انتخاب‌شده از این قابلیت پشتیبانی نمی‌کند. لطفاً مدل دیگری از منوی مدل‌ها انتخاب کنید.',
      retryable: false,
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

function createGeminiClient(ctx: ProviderExecutionContext): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: ctx.apiKey,
    httpOptions: {
      baseUrl: ctx.baseUrl ? normalizeBaseUrl(ctx.baseUrl) : undefined,
      headers: mergeHeaders({ 'User-Agent': 'aistudio-build' }, ctx.additionalHeaders),
    },
  });
}

// =============================================================================
// LOAD MODEL + PROVIDER + DECRYPTED CREDENTIAL (WITH FALLBACK)
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

  const [cred] = await db
    .select()
    .from(providerCredentials)
    .where(and(eq(providerCredentials.providerId, provider.id), eq(providerCredentials.isActive, true)))
    .orderBy(desc(providerCredentials.keyVersion))
    .limit(1);

  if (!cred) return null;

  const apiKey = decryptSecret({
    ciphertext: cred.encryptedApiKey,
    iv: cred.iv,
    authTag: cred.authTag,
  });

  return {
    providerId: provider.id,
    providerName: provider.name,
    providerType: provider.providerType,
    baseUrl: provider.baseUrl,
    apiKey,
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

async function runWithFailover<T>(
  route: LoadedModelRoute,
  executor: (ctx: ProviderExecutionContext) => Promise<T>,
): Promise<{ result: T; usedFallback: boolean; providerId: string }> {
  try {
    const result = await executor(route.primary);
    return { result, usedFallback: false, providerId: route.primary.providerId };
  } catch (err) {
    const aiErr = wrapNetworkError(err, route.primary.apiKey);
    if (route.fallback && (aiErr.retryable || aiErr.code === 'PROVIDER_ERROR' || aiErr.code === 'RATE_LIMITED')) {
      const result = await executor(route.fallback);
      return { result, usedFallback: true, providerId: route.fallback.providerId };
    }
    throw aiErr;
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
      const ai = createGeminiClient(ctx);
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

      const config: Record<string, unknown> = {};
      if (input.systemPrompt) config.systemInstruction = input.systemPrompt;

      if (input.onChunk) {
        const stream = await ai.models.generateContentStream({
          model: ctx.modelIdentifier,
          contents: contents as never,
          config: config as never,
        });
        let fullText = '';
        let inTok = 0;
        let outTok = 0;
        for await (const chunk of stream) {
          if (input.signal?.aborted) {
            throw new AIProviderError({
              code: 'CANCELED',
              message: 'Generation stopped by user',
              userMessageFa: 'تولید پاسخ متوقف شد.',
            });
          }
          if (chunk.text) {
            fullText += chunk.text;
            await input.onChunk(fullText);
          }
          if (chunk.usageMetadata) {
            inTok = chunk.usageMetadata.promptTokenCount ?? inTok;
            outTok = chunk.usageMetadata.candidatesTokenCount ?? outTok;
          }
        }
        inTok = inTok || estimateTokensRough(input.messages.map((m) => m.content).join('\n'));
        outTok = outTok || estimateTokensRough(fullText);
        return {
          text: fullText.trim() || 'پاسخی از مدل دریافت نشد.',
          inputTokens: inTok,
          outputTokens: outTok,
          costUsd: estimateTokenCostUsd(inTok, outTok, ctx.inputPricePerMillion, ctx.outputPricePerMillion),
        };
      }

      const response = await ai.models.generateContent({
        model: ctx.modelIdentifier,
        contents: contents as never,
        config: config as never,
      });
      const text = response.text?.trim() ?? '';
      const inTok =
        response.usageMetadata?.promptTokenCount ??
        estimateTokensRough(input.messages.map((m) => m.content).join('\n'));
      const outTok = response.usageMetadata?.candidatesTokenCount ?? estimateTokensRough(text);
      return {
        text: text || 'پاسخی از مدل دریافت نشد.',
        inputTokens: inTok,
        outputTokens: outTok,
        costUsd: estimateTokenCostUsd(inTok, outTok, ctx.inputPricePerMillion, ctx.outputPricePerMillion),
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

    if (ctx.providerType === 'openai_compatible' || ctx.providerType === 'custom') {
      const base = normalizeBaseUrl(ctx.baseUrl);
      const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
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
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: mergeHeaders(headers, ctx.additionalHeaders),
          body: JSON.stringify({
            model: ctx.modelIdentifier,
            messages: formattedMessages,
            max_tokens: input.maxTokens ?? ctx.maxOutputSize ?? 4096,
            temperature: input.temperature ?? (ctx.modelParameters?.temperature as number | undefined),
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

async function downloadBinarySafe(url: string, apiKey: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const res = await fetchWithTimeout(url, { method: 'GET' }, 45000);
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
      const ai = createGeminiClient(ctx);
      const imageConfig: Record<string, unknown> = {};
      if (input.aspectRatio) imageConfig.aspectRatio = input.aspectRatio;
      if (input.resolution && ['1K', '2K', '4K'].includes(input.resolution.toUpperCase())) {
        imageConfig.imageSize = input.resolution.toUpperCase();
      }
      const response = await ai.models.generateContent({
        model: ctx.modelIdentifier,
        contents: { parts: [{ text: input.prompt }] } as never,
        config: Object.keys(imageConfig).length > 0 ? ({ imageConfig } as never) : undefined,
      });

      const images: ImageOutput['images'] = [];
      for (const part of response.candidates?.[0]?.content?.parts ?? []) {
        if (part.inlineData?.data) {
          const mime = part.inlineData.mimeType ?? 'image/png';
          images.push({
            buffer: Buffer.from(part.inlineData.data, 'base64'),
            mimeType: mime,
            extension: mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png',
          });
        }
      }
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
      const url = `${normalizeBaseUrl(ctx.baseUrl)}/images/generations`;
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
      const ai = createGeminiClient(ctx);
      const response = await ai.models.generateContent({
        model: ctx.modelIdentifier,
        contents: {
          parts: [
            {
              inlineData: {
                data: input.sourceImageBuffer.toString('base64'),
                mimeType: input.sourceMimeType,
              },
            },
            {
              text:
                input.mode === 'variation'
                  ? `Create a high-quality visual variation of this image. ${input.prompt || ''}`.trim()
                  : input.prompt,
            },
          ],
        } as never,
      });

      const images: ImageOutput['images'] = [];
      for (const part of response.candidates?.[0]?.content?.parts ?? []) {
        if (part.inlineData?.data) {
          const mime = part.inlineData.mimeType ?? 'image/png';
          images.push({
            buffer: Buffer.from(part.inlineData.data, 'base64'),
            mimeType: mime,
            extension: mime.includes('jpeg') ? 'jpg' : 'png',
          });
        }
      }
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
      const url = `${normalizeBaseUrl(ctx.baseUrl)}${endpoint}`;
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
      const ai = createGeminiClient(ctx);
      const response = await ai.models.generateContent({
        model: ctx.modelIdentifier,
        contents: {
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
        } as never,
      });
      return {
        text: response.text?.trim() || '',
        language: input.language,
        costUsd: 0.004,
      };
    }

    if (ctx.providerType === 'openai_compatible' || ctx.providerType === 'custom') {
      const url = `${normalizeBaseUrl(ctx.baseUrl)}/audio/transcriptions`;
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
      const ai = createGeminiClient(ctx);
      const voiceName = input.voice || 'Kore';
      const response = await ai.models.generateContent({
        model: ctx.modelIdentifier,
        contents: [{ role: 'user', parts: [{ text: input.text }] }] as never,
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        } as never,
      });
      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) {
        throw new AIProviderError({
          code: 'PROVIDER_ERROR',
          message: 'Gemini TTS returned no audio data.',
          userMessageFa: 'خروجی صوتی از مدل دریافت نشد.',
        });
      }
      return {
        audioBuffer: Buffer.from(base64Audio, 'base64'),
        mimeType: 'audio/wav',
        extension: 'wav',
        costUsd: 0.006,
      };
    }

    if (ctx.providerType === 'openai_compatible' || ctx.providerType === 'custom') {
      const url = `${normalizeBaseUrl(ctx.baseUrl)}/audio/speech`;
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
        const ai = createGeminiClient(ctx);
        const op = await (ai.models as unknown as {
          generateVideos?: (args: Record<string, unknown>) => Promise<{ name?: string; done?: boolean }>;
        }).generateVideos?.({
          model: ctx.modelIdentifier,
          prompt: input.prompt,
          config: {
            aspectRatio: input.aspectRatio ?? '16:9',
            durationSeconds: input.durationSeconds ?? 5,
          },
        });
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
      const url = `${normalizeBaseUrl(ctx.baseUrl)}/v1beta/${providerJobId}`;
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
