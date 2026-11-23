import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import {
  aiModels,
  aiProviders,
  modelCapabilities,
  providerCredentials,
} from '../../db/schema.ts';
import type { ModelCategory, ProviderType } from '../../shared/validation.ts';
import { getCloudflareAiBinding } from '../cloudflare/requestContext.ts';
import { isAiMockModeEnabled } from '../config/env.ts';
import { decryptSecret, redactSecrets } from '../security/crypto.ts';
import { assertSafeOutboundUrl } from '../security/ssrf.ts';
import {
  extractHuggingFaceRepoFromUrl,
  normalizeBaseUrl,
  normalizeGeminiModelId,
  normalizeGeminiRootBaseUrl,
  normalizeOpenAiRootBaseUrl,
  parseHuggingFaceSpaceUrl,
  resolveHfSpaceRootUrl,
  resolveHuggingFaceRouterRoot,
} from './discovery.ts';

export type ModelHealthStatus =
  | 'healthy'
  | 'rate_limited'
  | 'broken'
  | 'auth_error'
  | 'transient';

export type HealthPruneAction = 'report_only' | 'deactivate_broken' | 'delete_broken';

export interface ModelHealthProbeResult {
  modelId: string;
  modelName: string;
  modelIdentifier: string;
  providerId: string;
  providerName: string;
  providerType: ProviderType;
  category: ModelCategory;
  wasActive: boolean;
  status: ModelHealthStatus;
  preserved: boolean;
  httpStatus: number | null;
  reasonFa: string;
  technicalReason: string;
  latencyMs: number;
  actionTaken: 'kept' | 'deactivated' | 'deleted';
}

export interface BatchModelHealthSummary {
  healthy: number;
  rateLimited: number;
  broken: number;
  authError: number;
  transient: number;
  deactivated: number;
  deleted: number;
  kept: number;
}

export interface BatchModelHealthResponse {
  totalMatching: number;
  offset: number;
  limit: number;
  processedCount: number;
  nextOffset: number | null;
  hasMore: boolean;
  action: HealthPruneAction;
  summary: BatchModelHealthSummary;
  results: ModelHealthProbeResult[];
}

export interface ProbeClassification {
  status: ModelHealthStatus;
  reasonFa: string;
  technicalReason: string;
}

const GRADIO_UI_HELPER_PATTERN =
  /(^|[/_-])(update|change|toggle|select|reset|clear|load|save|refresh|sync|check|init|on_|get_default|set_|show_|hide_|preview_ui|mode_ui|lora_selection|login_status|example|gallery)/i;

export function isLikelyBrokenGradioUiHelper(modelIdentifier: string): boolean {
  const clean = modelIdentifier.trim().replace(/^\/+/, '');
  if (!clean) return false;
  if (clean.includes('::')) {
    const [, fnPart] = clean.split('::');
    return Boolean(fnPart && GRADIO_UI_HELPER_PATTERN.test(fnPart));
  }
  return GRADIO_UI_HELPER_PATTERN.test(clean);
}

function extractCompactError(bodyText: string, secrets: string[]): string {
  let clean = bodyText.trim();
  try {
    const parsed = JSON.parse(clean) as {
      error?: { message?: unknown; code?: unknown } | string;
      message?: unknown;
      detail?: unknown;
    };
    if (typeof parsed?.error === 'string') {
      clean = parsed.error;
    } else if (
      parsed?.error &&
      typeof parsed.error === 'object' &&
      typeof parsed.error.message === 'string'
    ) {
      clean = parsed.error.message;
    } else if (typeof parsed?.message === 'string') {
      clean = parsed.message;
    } else if (typeof parsed?.detail === 'string') {
      clean = parsed.detail;
    }
  } catch {
    // plain text body
  }
  return redactSecrets(clean.replace(/\s+/g, ' ').trim().slice(0, 240), secrets);
}

/**
 * Pure deterministic classifier for HTTP probe responses.
 * CRITICAL GUARANTEE:
 * - Rate-limited models (429 without limit:0, 503, timeout, monthly account credit cap) are NEVER classified as 'broken'.
 * - Auth errors (401 invalid API key) are classified as 'auth_error' (kept), so an expired key never wipes out 90 models.
 * - ONLY permanent model-level failures (404, 429 limit:0, 403 billing/gated, 400/422 unsupported/dead model, OpenRouter 402 paid-only) are 'broken'.
 */
export function classifyProbeHttpResponse(params: {
  providerType: ProviderType;
  modelIdentifier: string;
  httpStatus: number;
  bodyText: string;
  secrets?: string[];
}): ProbeClassification {
  const { providerType, modelIdentifier, httpStatus, bodyText } = params;
  const secrets = params.secrets ?? [];
  const compact = extractCompactError(bodyText, secrets);
  const lower = `${bodyText} ${compact}`.toLowerCase();

  if (httpStatus >= 200 && httpStatus < 300) {
    return {
      status: 'healthy',
      reasonFa: 'مدل سالم و آماده پاسخ‌گویی است.',
      technicalReason: `HTTP ${httpStatus} OK`,
    };
  }

  // 1. Auth errors — NEVER delete/disable models just because the provider's API key is invalid/expired
  if (
    httpStatus === 401 ||
    /api_key_invalid|api key not valid|invalid[_\s-]?api[_\s-]?key|incorrect api key|invalid[_\s-]?token|authentication_error|unauthenticated|revoked api key/i.test(
      lower,
    )
  ) {
    return {
      status: 'auth_error',
      reasonFa: 'خطای احراز هویت کلید API (مدل حفظ شد تا با تعویض کلید کار کند).',
      technicalReason: `HTTP ${httpStatus}: ${compact || 'Invalid API credentials'}`,
    };
  }

  // 2. 429 — Distinguish permanent zero-quota (limit: 0) vs temporary rate limit
  if (httpStatus === 429) {
    if (/\blimit\s*:\s*0\b/i.test(bodyText)) {
      return {
        status: 'broken',
        reasonFa: 'سهمیه این مدل در پلن فعلی صفر (limit: 0) است و قابل استفاده نیست.',
        technicalReason: `HTTP 429 (limit: 0): ${compact}`,
      };
    }
    return {
      status: 'rate_limited',
      reasonFa: 'محدودیت نرخ موقت (Rate Limit) — مدل سالم است و حفظ شد.',
      technicalReason: `HTTP 429 rate limited: ${compact}`,
    };
  }

  // 3. 402 Payment Required — Distinguish account monthly quota vs paid-only model on free OpenRouter/proxy key
  if (httpStatus === 402) {
    if (
      providerType === 'huggingface' ||
      /monthly included credits|exceeded your monthly/i.test(lower)
    ) {
      return {
        status: 'rate_limited',
        reasonFa: 'سهمیه ماهانه حساب پر شده است — مدل سالم است و حفظ شد.',
        technicalReason: `HTTP 402 monthly quota: ${compact}`,
      };
    }
    const looksFreeSuffix = /:free$/i.test(modelIdentifier.trim());
    if (looksFreeSuffix) {
      return {
        status: 'rate_limited',
        reasonFa: 'محدودیت اعتبار موقت — مدل رایگان حفظ شد.',
        technicalReason: `HTTP 402 on :free model: ${compact}`,
      };
    }
    return {
      status: 'broken',
      reasonFa: 'این مدل پولی است و با اعتبار/کلید فعلی قابل اجرا نیست (HTTP 402).',
      technicalReason: `HTTP 402 paid-only model: ${compact}`,
    };
  }

  // 4. 404 — Model does not exist / deprecated / no endpoints
  if (httpStatus === 404) {
    return {
      status: 'broken',
      reasonFa: 'مدل یا endpoint آن در ارائه‌دهنده وجود ندارد یا حذف شده است (404).',
      technicalReason: `HTTP 404: ${compact || 'Model not found'}`,
    };
  }

  // 5. 403 — Gated, billing-only, region/tier restricted
  if (httpStatus === 403) {
    return {
      status: 'broken',
      reasonFa: 'دسترسی به این مدل محدود یا نیازمند فعال‌سازی Billing/مجوز است (403).',
      technicalReason: `HTTP 403: ${compact || 'Access forbidden'}`,
    };
  }

  // 6. 400 / 422 — Check if it's a permanent model failure vs benign probe input rejection
  if (httpStatus === 400 || httpStatus === 422) {
    const permanentModelFailure =
      /billed users|only accessible to billed|not supported for generatecontent|not a chat model|model[_\s-]?not[_\s-]?found|invalid model|is not a valid model|does not exist|decommissioned|deprecated|no endpoints found|unsupported model|model is not supported|cannot be used with|not found for api version|unknown model|invalid model id|not available in your region|model .* is disabled/i.test(
        lower,
      );
    if (permanentModelFailure) {
      return {
        status: 'broken',
        reasonFa: 'مدل منقضی، ناسازگار یا نیازمند حساب پولی است.',
        technicalReason: `HTTP ${httpStatus}: ${compact}`,
      };
    }
    if (/rate limit|quota|too many requests/i.test(lower)) {
      return {
        status: 'rate_limited',
        reasonFa: 'محدودیت موقت ارائه‌دهنده — مدل حفظ شد.',
        technicalReason: `HTTP ${httpStatus} rate/quota: ${compact}`,
      };
    }
    // Benign 400 (e.g., probe payload didn't match an audio/image/strict schema) — do NOT falsely delete!
    return {
      status: 'healthy',
      reasonFa: 'مدل پاسخ داد (خطای ورودی تست خفیف بود، مدل فعال است و حفظ شد).',
      technicalReason: `HTTP ${httpStatus} (input schema mismatch): ${compact}`,
    };
  }

  // 7. 5xx / 408 — Transient server issue — ALWAYS KEEP
  if (httpStatus >= 500 || httpStatus === 408) {
    return {
      status: 'transient',
      reasonFa: 'خطای موقت سرور ارائه‌دهنده (5xx) — مدل حفظ شد.',
      technicalReason: `HTTP ${httpStatus}: ${compact}`,
    };
  }

  return {
    status: 'transient',
    reasonFa: `پاسخ غیرمنتظره (HTTP ${httpStatus}) — جهت احتیاط مدل حفظ شد.`,
    technicalReason: `HTTP ${httpStatus}: ${compact}`,
  };
}

async function fetchProbeWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 10_000,
): Promise<Response> {
  assertSafeOutboundUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface ProviderProbeCredential {
  providerId: string;
  providerName: string;
  providerType: ProviderType;
  baseUrl: string;
  organizationId: string | null;
  additionalHeaders: Record<string, string>;
  apiKey: string;
}

async function loadProviderProbeCredential(
  providerId: string,
): Promise<ProviderProbeCredential | null> {
  const db = getDb();
  const [provider] = await db
    .select()
    .from(aiProviders)
    .where(eq(aiProviders.id, providerId))
    .limit(1);

  if (!provider) return null;

  const creds = await db
    .select()
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.providerId, provider.id),
        eq(providerCredentials.isActive, true),
      ),
    )
    .orderBy(asc(providerCredentials.priority), asc(providerCredentials.createdAt));

  let apiKey = '';
  for (const cred of creds) {
    if (cred.status === 'invalid' || cred.status === 'disabled') continue;
    try {
      apiKey = decryptSecret({
        ciphertext: cred.encryptedApiKey,
        iv: cred.iv,
        authTag: cred.authTag,
      });
      if (apiKey) break;
    } catch {
      continue;
    }
  }

  if (!apiKey && creds[0]) {
    try {
      apiKey = decryptSecret({
        ciphertext: creds[0].encryptedApiKey,
        iv: creds[0].iv,
        authTag: creds[0].authTag,
      });
    } catch {
      apiKey = '';
    }
  }

  return {
    providerId: provider.id,
    providerName: provider.name,
    providerType: provider.providerType,
    baseUrl: provider.baseUrl,
    organizationId: provider.organizationId,
    additionalHeaders: provider.additionalHeaders ?? {},
    apiKey,
  };
}

function mergeProbeHeaders(
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

async function probeHuggingFaceSpaceModel(
  cred: ProviderProbeCredential,
  modelIdentifier: string,
  modelParameters: Record<string, unknown>,
): Promise<{ classification: ProbeClassification; httpStatus: number | null }> {
  // 1. Instantly catch legacy Gradio UI helper endpoints like update_mode_ui
  if (isLikelyBrokenGradioUiHelper(modelIdentifier)) {
    return {
      httpStatus: 400,
      classification: {
        status: 'broken',
        reasonFa: 'این مورد یک تابع رابط کاربری (UI Helper) است و مدل تولید واقعی نیست.',
        technicalReason: `Detected non-inference Gradio UI helper endpoint: ${modelIdentifier}`,
      },
    };
  }

  const parsedSpace = parseHuggingFaceSpaceUrl(cred.baseUrl);
  const authHeaders = cred.apiKey
    ? mergeProbeHeaders({ Authorization: `Bearer ${cred.apiKey}` }, cred.additionalHeaders)
    : mergeProbeHeaders({}, cred.additionalHeaders);

  // 2. Check Space runtime status via Hugging Face Hub API (zero ZeroGPU quota cost!)
  if (parsedSpace?.hubApiUrl) {
    const spaceLabel =
      parsedSpace.owner && parsedSpace.space
        ? `${parsedSpace.owner}/${parsedSpace.space}`
        : parsedSpace.hubApiUrl;
    try {
      const hubRes = await fetchProbeWithTimeout(
        parsedSpace.hubApiUrl,
        { method: 'GET', headers: authHeaders },
        8_000,
      );
      if (hubRes.status === 404) {
        return {
          httpStatus: 404,
          classification: {
            status: 'broken',
            reasonFa: 'این Space در Hugging Face حذف شده یا خصوصی است (404).',
            technicalReason: `Space not found on Hub: ${spaceLabel}`,
          },
        };
      }
      if (hubRes.status === 401) {
        return {
          httpStatus: 401,
          classification: {
            status: 'auth_error',
            reasonFa: 'توکن Hugging Face معتبر نیست (مدل حفظ شد).',
            technicalReason: 'HTTP 401 on Space Hub check',
          },
        };
      }
      if (hubRes.ok) {
        const meta = (await hubRes.json()) as {
          runtime?: { stage?: string; errorMessage?: string };
        };
        const stage = String(meta?.runtime?.stage ?? '').toUpperCase();
        if (
          stage === 'RUNTIME_ERROR' ||
          stage === 'BUILD_ERROR' ||
          stage === 'CONFIG_ERROR' ||
          stage === 'PAUSED' ||
          stage === 'NO_APP_FILE' ||
          stage === 'STOPPED'
        ) {
          return {
            httpStatus: 503,
            classification: {
              status: 'broken',
              reasonFa: `وضعیت Space خراب یا متوقف است (${stage}).`,
              technicalReason: `Space runtime stage=${stage} ${meta?.runtime?.errorMessage ?? ''}`.trim(),
            },
          };
        }
        if (stage === 'SLEEPING' || stage === 'BUILDING' || stage === 'APP_STARTING') {
          return {
            httpStatus: 202,
            classification: {
              status: 'rate_limited',
              reasonFa: `Space در حال بیدار شدن یا ساخت است (${stage}) — مدل حفظ شد.`,
              technicalReason: `Space runtime stage=${stage}`,
            },
          };
        }
      }
    } catch {
      // Fall through to direct Gradio info probe
    }
  }

  // 3. Verify Gradio /gradio_api/info endpoint exists and exposes this api_name
  try {
    const spaceRoot = await resolveHfSpaceRootUrl(cred.baseUrl, cred.apiKey || undefined);
    const configuredPrefix =
      typeof modelParameters.gradioApiPrefix === 'string'
        ? modelParameters.gradioApiPrefix
        : '/gradio_api';
    const infoUrls = [
      `${spaceRoot}${configuredPrefix}/info`,
      `${spaceRoot}/gradio_api/info`,
      `${spaceRoot}/info`,
    ];
    const seen = new Set<string>();

    for (const infoUrl of infoUrls) {
      if (seen.has(infoUrl)) continue;
      seen.add(infoUrl);
      const res = await fetchProbeWithTimeout(infoUrl, { method: 'GET', headers: authHeaders }, 9_000);
      if (res.status === 404) continue;
      if (!res.ok) {
        return {
          httpStatus: res.status,
          classification: classifyProbeHttpResponse({
            providerType: 'huggingface_space',
            modelIdentifier,
            httpStatus: res.status,
            bodyText: await res.text(),
            secrets: cred.apiKey ? [cred.apiKey] : [],
          }),
        };
      }
      const info = (await res.json()) as {
        named_endpoints?: Record<string, unknown>;
      };
      const named = info?.named_endpoints ?? {};
      const fnName =
        typeof modelParameters.gradioApiName === 'string' && modelParameters.gradioApiName
          ? modelParameters.gradioApiName
          : modelIdentifier.includes('::')
            ? `/${modelIdentifier.split('::')[1]!.replace(/^\/+/, '')}`
            : `/${modelIdentifier.replace(/^\/+/, '')}`;

      const endpointKeys = Object.keys(named);
      if (endpointKeys.length === 0) {
        return {
          httpStatus: 200,
          classification: {
            status: 'healthy',
            reasonFa: 'Space فعال و در دسترس است.',
            technicalReason: 'Gradio Space responded OK',
          },
        };
      }

      const normalizedTarget = fnName.replace(/^\/+/, '').toLowerCase();
      const matched = endpointKeys.some(
        (k) => k.replace(/^\/+/, '').toLowerCase() === normalizedTarget,
      );
      if (!matched) {
        return {
          httpStatus: 404,
          classification: {
            status: 'broken',
            reasonFa: `تابع ${fnName} دیگر در این Space وجود ندارد.`,
            technicalReason: `Endpoint ${fnName} missing from Gradio named_endpoints (${endpointKeys.slice(0, 6).join(', ')})`,
          },
        };
      }

      return {
        httpStatus: 200,
        classification: {
          status: 'healthy',
          reasonFa: 'Space فعال است و تابع تولیدی آن تأیید شد.',
          technicalReason: `Verified Gradio endpoint ${fnName}`,
        },
      };
    }

    return {
      httpStatus: 404,
      classification: {
        status: 'broken',
        reasonFa: 'ساختار API این Space در دسترس نیست (404).',
        technicalReason: 'No Gradio info endpoint found',
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Network error';
    return {
      httpStatus: null,
      classification: {
        status: 'transient',
        reasonFa: 'خطای موقت شبکه یا زمان‌انتظار در اتصال به Space — مدل حفظ شد.',
        technicalReason: redactSecrets(msg, cred.apiKey ? [cred.apiKey] : []),
      },
    };
  }
}

async function probeCloudflareModel(
  cred: ProviderProbeCredential,
  modelIdentifier: string,
  category: ModelCategory,
): Promise<{ classification: ProbeClassification; httpStatus: number | null }> {
  const cfAi = getCloudflareAiBinding();
  const cleanId = modelIdentifier.trim();

  if (!cleanId.startsWith('@cf/') && !cleanId.startsWith('@hf/')) {
    return {
      httpStatus: 400,
      classification: {
        status: 'broken',
        reasonFa: 'شناسه مدل Cloudflare Workers AI معتبر نیست (باید با @cf/ یا @hf/ شروع شود).',
        technicalReason: `Invalid Cloudflare model ID: ${cleanId}`,
      },
    };
  }

  // Native binding fast check for LLM/embedding
  if (cfAi) {
    if (category === 'llm' || category === 'multimodal' || category === 'document') {
      try {
        await cfAi.run(cleanId, {
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 4,
        });
        return {
          httpStatus: 200,
          classification: {
            status: 'healthy',
            reasonFa: 'مدل روی Cloudflare Workers AI (Native) سالم و آماده است.',
            technicalReason: 'Cloudflare Native AI binding responded OK',
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/no such model|not found|invalid model|deprecated/i.test(msg)) {
          return {
            httpStatus: 404,
            classification: {
              status: 'broken',
              reasonFa: 'این مدل در Cloudflare Workers AI پشتیبانی یا یافت نشد.',
              technicalReason: msg.slice(0, 220),
            },
          };
        }
        if (/rate|limit|quota|neuron|429/i.test(msg)) {
          return {
            httpStatus: 429,
            classification: {
              status: 'rate_limited',
              reasonFa: 'سقف روزانه/نرخ Cloudflare پر شده — مدل سالم است و حفظ شد.',
              technicalReason: msg.slice(0, 220),
            },
          };
        }
        return {
          httpStatus: 500,
          classification: {
            status: 'transient',
            reasonFa: 'خطای موقت در اجرای Workers AI — مدل حفظ شد.',
            technicalReason: msg.slice(0, 220),
          },
        };
      }
    }

    if (category === 'embedding') {
      try {
        await cfAi.run(cleanId, { text: ['hi'] });
        return {
          httpStatus: 200,
          classification: {
            status: 'healthy',
            reasonFa: 'مدل Embedding در Cloudflare سالم است.',
            technicalReason: 'Cloudflare embedding OK',
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/no such model|not found/i.test(msg)) {
          return {
            httpStatus: 404,
            classification: {
              status: 'broken',
              reasonFa: 'مدل Embedding در Cloudflare یافت نشد.',
              technicalReason: msg.slice(0, 220),
            },
          };
        }
        return {
          httpStatus: 500,
          classification: {
            status: 'transient',
            reasonFa: 'خطای موقت Cloudflare — مدل حفظ شد.',
            technicalReason: msg.slice(0, 220),
          },
        };
      }
    }

    // For image/audio on Native binding, avoid burning heavy image neurons during 90-model sweeps
    return {
      httpStatus: 200,
      classification: {
        status: 'healthy',
        reasonFa: 'مدل رسمی Cloudflare Workers AI (تأیید ساختاری بدون مصرف Neuron اضافه).',
        technicalReason: 'Verified Cloudflare Workers AI model identifier on Native binding',
      },
    };
  }

  // REST API mode
  const accountId = cred.organizationId?.trim() ?? '';
  if (!accountId || !cred.apiKey || cred.apiKey === 'cloudflare-native-binding') {
    return {
      httpStatus: 401,
      classification: {
        status: 'auth_error',
        reasonFa: 'کلید REST یا Account ID کلادفلر تنظیم نشده است (مدل حفظ شد).',
        technicalReason: 'Missing Cloudflare Account ID or API token outside Workers runtime',
      },
    };
  }

  const root = normalizeBaseUrl(cred.baseUrl) || 'https://api.cloudflare.com/client/v4';
  const headers = mergeProbeHeaders(
    {
      Authorization: `Bearer ${cred.apiKey}`,
      'Content-Type': 'application/json',
    },
    cred.additionalHeaders,
  );

  if (category === 'llm' || category === 'multimodal' || category === 'document') {
    const url = `${root}/accounts/${encodeURIComponent(accountId)}/ai/run/${cleanId}`;
    const res = await fetchProbeWithTimeout(
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 4,
        }),
      },
      10_000,
    );
    return {
      httpStatus: res.status,
      classification: classifyProbeHttpResponse({
        providerType: 'cloudflare_workers_ai',
        modelIdentifier: cleanId,
        httpStatus: res.status,
        bodyText: res.ok ? '' : await res.text(),
        secrets: [cred.apiKey],
      }),
    };
  }

  // Verify non-LLM model via Cloudflare model catalog search without burning neurons
  const searchUrl = `${root}/accounts/${encodeURIComponent(accountId)}/ai/models/search?search=${encodeURIComponent(cleanId)}&per_page=10`;
  const res = await fetchProbeWithTimeout(searchUrl, { method: 'GET', headers }, 9_000);
  if (!res.ok) {
    return {
      httpStatus: res.status,
      classification: classifyProbeHttpResponse({
        providerType: 'cloudflare_workers_ai',
        modelIdentifier: cleanId,
        httpStatus: res.status,
        bodyText: await res.text(),
        secrets: [cred.apiKey],
      }),
    };
  }
  const json = (await res.json()) as { result?: Array<{ name?: string }> };
  const exists = (json.result ?? []).some((m) => m.name?.toLowerCase() === cleanId.toLowerCase());
  return {
    httpStatus: exists ? 200 : 404,
    classification: exists
      ? {
          status: 'healthy',
          reasonFa: 'مدل در کاتالوگ رسمی Cloudflare تایید شد.',
          technicalReason: 'Verified via Cloudflare models/search',
        }
      : {
          status: 'broken',
          reasonFa: 'مدل در کاتالوگ Cloudflare یافت نشد (404).',
          technicalReason: `Model ${cleanId} not found in Cloudflare catalog`,
        },
  };
}

async function probeSingleLiveModel(params: {
  cred: ProviderProbeCredential;
  modelIdentifier: string;
  category: ModelCategory;
  capabilities: string[];
  modelParameters: Record<string, unknown>;
  openAiModelCache: Map<string, Set<string> | null>;
}): Promise<{ classification: ProbeClassification; httpStatus: number | null }> {
  const { cred, modelIdentifier, category, capabilities, modelParameters, openAiModelCache } = params;
  const secrets = cred.apiKey ? [cred.apiKey] : [];

  // Mock mode for deterministic automated tests & local demo without external network calls
  if (isAiMockModeEnabled()) {
    const lowerId = modelIdentifier.toLowerCase();
    if (
      isLikelyBrokenGradioUiHelper(modelIdentifier) ||
      /broken|dead|not-found|404|zero-quota|deprecated|billing-only/.test(lowerId)
    ) {
      return {
        httpStatus: lowerId.includes('zero-quota') ? 429 : 404,
        classification: {
          status: 'broken',
          reasonFa: lowerId.includes('zero-quota')
            ? 'سهمیه رایگان این مدل صفر (limit: 0) است و قابل استفاده نیست.'
            : 'مدل در ارائه‌دهنده یافت نشد یا خراب است.',
          technicalReason: `Mock probe classified ${modelIdentifier} as broken`,
        },
      };
    }
    if (/rate-limit|ratelimit|limited|429|busy/.test(lowerId)) {
      return {
        httpStatus: 429,
        classification: {
          status: 'rate_limited',
          reasonFa: 'محدودیت نرخ موقت (Rate Limit) — مدل سالم است و حفظ شد.',
          technicalReason: `Mock probe classified ${modelIdentifier} as rate_limited`,
        },
      };
    }
    if (/auth-err|invalid-key|401/.test(lowerId)) {
      return {
        httpStatus: 401,
        classification: {
          status: 'auth_error',
          reasonFa: 'خطای کلید API (مدل حفظ شد).',
          technicalReason: `Mock probe classified ${modelIdentifier} as auth_error`,
        },
      };
    }
    return {
      httpStatus: 200,
      classification: {
        status: 'healthy',
        reasonFa: 'مدل سالم و آماده پاسخ‌گویی است.',
        technicalReason: 'Mock probe 200 OK',
      },
    };
  }

  try {
    // 1. Hugging Face Space
    if (cred.providerType === 'huggingface_space') {
      return await probeHuggingFaceSpaceModel(cred, modelIdentifier, modelParameters);
    }

    // 2. Cloudflare Workers AI
    if (cred.providerType === 'cloudflare_workers_ai') {
      return await probeCloudflareModel(cred, modelIdentifier, category);
    }

    // All remaining providers require an API key
    if (!cred.apiKey) {
      return {
        httpStatus: 401,
        classification: {
          status: 'auth_error',
          reasonFa: 'کلید API فعال برای این ارائه‌دهنده ثبت نشده است (مدل حفظ شد).',
          technicalReason: 'No active API key configured on provider',
        },
      };
    }

    // 3. Google Gemini
    if (cred.providerType === 'google_gemini') {
      const root = normalizeGeminiRootBaseUrl(cred.baseUrl);
      const normId = normalizeGeminiModelId(modelIdentifier);
      const headers = mergeProbeHeaders(
        {
          'x-goog-api-key': cred.apiKey,
          'Content-Type': 'application/json',
        },
        cred.additionalHeaders,
      );

      if (category === 'embedding') {
        const res = await fetchProbeWithTimeout(
          `${root}/v1beta/models/${encodeURIComponent(normId)}:embedContent`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ content: { parts: [{ text: 'hi' }] } }),
          },
          10_000,
        );
        return {
          httpStatus: res.status,
          classification: classifyProbeHttpResponse({
            providerType: 'google_gemini',
            modelIdentifier: normId,
            httpStatus: res.status,
            bodyText: res.ok ? '' : await res.text(),
            secrets,
          }),
        };
      }

      if (category === 'image') {
        const isImagen = /^imagen/i.test(normId);
        const url = isImagen
          ? `${root}/v1beta/models/${encodeURIComponent(normId)}:predict`
          : `${root}/v1beta/models/${encodeURIComponent(normId)}:generateContent`;
        const body = isImagen
          ? { instances: [{ prompt: 'blue dot' }], parameters: { sampleCount: 1 } }
          : {
              contents: [{ role: 'user', parts: [{ text: 'blue dot' }] }],
              generationConfig: { responseModalities: ['IMAGE'] },
            };
        const res = await fetchProbeWithTimeout(
          url,
          { method: 'POST', headers, body: JSON.stringify(body) },
          12_000,
        );
        return {
          httpStatus: res.status,
          classification: classifyProbeHttpResponse({
            providerType: 'google_gemini',
            modelIdentifier: normId,
            httpStatus: res.status,
            bodyText: res.ok ? '' : await res.text(),
            secrets,
          }),
        };
      }

      if (category === 'video' || category === 'audio') {
        // Non-destructive metadata check so we don't launch expensive video jobs on paid accounts
        const res = await fetchProbeWithTimeout(
          `${root}/v1beta/models/${encodeURIComponent(normId)}`,
          { method: 'GET', headers },
          9_000,
        );
        return {
          httpStatus: res.status,
          classification: classifyProbeHttpResponse({
            providerType: 'google_gemini',
            modelIdentifier: normId,
            httpStatus: res.status,
            bodyText: res.ok ? '' : await res.text(),
            secrets,
          }),
        };
      }

      // LLM / Multimodal / Document
      const res = await fetchProbeWithTimeout(
        `${root}/v1beta/models/${encodeURIComponent(normId)}:generateContent`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
            generationConfig: { maxOutputTokens: 4 },
          }),
        },
        10_000,
      );
      return {
        httpStatus: res.status,
        classification: classifyProbeHttpResponse({
          providerType: 'google_gemini',
          modelIdentifier: normId,
          httpStatus: res.status,
          bodyText: res.ok ? '' : await res.text(),
          secrets,
        }),
      };
    }

    // 4. Anthropic
    if (cred.providerType === 'anthropic') {
      const base = normalizeBaseUrl(cred.baseUrl) || 'https://api.anthropic.com';
      const headers = mergeProbeHeaders(
        {
          'x-api-key': cred.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        cred.additionalHeaders,
      );
      const res = await fetchProbeWithTimeout(
        `${base}/v1/messages`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: modelIdentifier,
            max_tokens: 4,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
        10_000,
      );
      return {
        httpStatus: res.status,
        classification: classifyProbeHttpResponse({
          providerType: 'anthropic',
          modelIdentifier,
          httpStatus: res.status,
          bodyText: res.ok ? '' : await res.text(),
          secrets,
        }),
      };
    }

    // 5. Hugging Face Inference Router
    if (cred.providerType === 'huggingface') {
      const repoId = extractHuggingFaceRepoFromUrl(modelIdentifier) ?? modelIdentifier.trim();
      const headers = mergeProbeHeaders(
        {
          Authorization: `Bearer ${cred.apiKey}`,
          'Content-Type': 'application/json',
        },
        cred.additionalHeaders,
      );

      if (category === 'llm' || category === 'multimodal' || category === 'document') {
        const routerRoot = resolveHuggingFaceRouterRoot(cred.baseUrl);
        const res = await fetchProbeWithTimeout(
          `${routerRoot}/v1/chat/completions`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: repoId,
              messages: [{ role: 'user', content: 'hi' }],
              max_tokens: 4,
            }),
          },
          10_000,
        );
        return {
          httpStatus: res.status,
          classification: classifyProbeHttpResponse({
            providerType: 'huggingface',
            modelIdentifier: repoId,
            httpStatus: res.status,
            bodyText: res.ok ? '' : await res.text(),
            secrets,
          }),
        };
      }

      // Non-chat HF models: check inferenceProviderMapping via Hub API (0 credit burn!)
      const hubRes = await fetchProbeWithTimeout(
        `https://huggingface.co/api/models/${repoId}?expand[]=inferenceProviderMapping&expand[]=gated`,
        { method: 'GET', headers: { Authorization: `Bearer ${cred.apiKey}` } },
        9_000,
      );
      if (!hubRes.ok) {
        return {
          httpStatus: hubRes.status,
          classification: classifyProbeHttpResponse({
            providerType: 'huggingface',
            modelIdentifier: repoId,
            httpStatus: hubRes.status,
            bodyText: await hubRes.text(),
            secrets,
          }),
        };
      }
      const meta = (await hubRes.json()) as {
        inferenceProviderMapping?: Record<string, { status?: string }>;
      };
      const mapping = meta.inferenceProviderMapping ?? {};
      const hasLive = Object.values(mapping).some((entry) => entry?.status === 'live');
      if (Object.keys(mapping).length > 0 && !hasLive) {
        return {
          httpStatus: 404,
          classification: {
            status: 'broken',
            reasonFa: 'هیچ سرور فعال (live) برای اجرای این مدل در Hugging Face یافت نشد.',
            technicalReason: 'No live inferenceProviderMapping on HF Hub',
          },
        };
      }
      return {
        httpStatus: 200,
        classification: {
          status: 'healthy',
          reasonFa: 'مدل روی Hugging Face Inference فعال است.',
          technicalReason: 'Verified live HF model',
        },
      };
    }

    // 6. Replicate
    if (cred.providerType === 'replicate') {
      const base = normalizeBaseUrl(cred.baseUrl) || 'https://api.replicate.com';
      const cleanModel = modelIdentifier.split(':')[0]!.replace(/^\/+/, '');
      const headers = mergeProbeHeaders(
        { Authorization: `Bearer ${cred.apiKey}` },
        cred.additionalHeaders,
      );
      const res = await fetchProbeWithTimeout(
        `${base}/v1/models/${cleanModel}`,
        { method: 'GET', headers },
        9_000,
      );
      return {
        httpStatus: res.status,
        classification: classifyProbeHttpResponse({
          providerType: 'replicate',
          modelIdentifier,
          httpStatus: res.status,
          bodyText: res.ok ? '' : await res.text(),
          secrets,
        }),
      };
    }

    // 7. OpenAI-Compatible & Custom (OpenRouter, Groq, Cerebras, NVIDIA NIM, SambaNova, DeepSeek, Mistral, Together, etc.)
    const openAiRoot = normalizeOpenAiRootBaseUrl(cred.baseUrl);
    const headers = mergeProbeHeaders(
      {
        Authorization: `Bearer ${cred.apiKey}`,
        'Content-Type': 'application/json',
        ...(cred.organizationId ? { 'OpenAI-Organization': cred.organizationId } : {}),
      },
      cred.additionalHeaders,
    );

    const isChatCapable =
      category === 'llm' ||
      category === 'multimodal' ||
      category === 'document' ||
      capabilities.includes('chat') ||
      capabilities.includes('text_generation');

    if (isChatCapable) {
      const res = await fetchProbeWithTimeout(
        `${openAiRoot}/chat/completions`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: modelIdentifier,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 4,
          }),
        },
        10_000,
      );
      return {
        httpStatus: res.status,
        classification: classifyProbeHttpResponse({
          providerType: cred.providerType,
          modelIdentifier,
          httpStatus: res.status,
          bodyText: res.ok ? '' : await res.text(),
          secrets,
        }),
      };
    }

    if (category === 'embedding') {
      const res = await fetchProbeWithTimeout(
        `${openAiRoot}/embeddings`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: modelIdentifier, input: 'hi' }),
        },
        10_000,
      );
      return {
        httpStatus: res.status,
        classification: classifyProbeHttpResponse({
          providerType: cred.providerType,
          modelIdentifier,
          httpStatus: res.status,
          bodyText: res.ok ? '' : await res.text(),
          secrets,
        }),
      };
    }

    // Non-chat OpenAI-compatible (image/audio/video): check cached /models catalog (avoids burning paid image credits)
    let catalogSet = openAiModelCache.get(cred.providerId);
    if (catalogSet === undefined) {
      try {
        const listRes = await fetchProbeWithTimeout(
          `${openAiRoot}/models`,
          { method: 'GET', headers },
          9_000,
        );
        if (listRes.ok) {
          const listJson = (await listRes.json()) as { data?: Array<{ id?: string }> };
          catalogSet = new Set(
            (listJson.data ?? [])
              .map((m) => String(m.id ?? '').trim().toLowerCase())
              .filter(Boolean),
          );
        } else {
          catalogSet = null;
        }
      } catch {
        catalogSet = null;
      }
      openAiModelCache.set(cred.providerId, catalogSet);
    }

    if (catalogSet && catalogSet.size > 0) {
      const exists = catalogSet.has(modelIdentifier.trim().toLowerCase());
      return {
        httpStatus: exists ? 200 : 404,
        classification: exists
          ? {
              status: 'healthy',
              reasonFa: 'مدل در فهرست فعال ارائه‌دهنده تأیید شد.',
              technicalReason: 'Verified via /models catalog',
            }
          : {
              status: 'broken',
              reasonFa: 'این مدل دیگر در فهرست مدل‌های ارائه‌دهنده وجود ندارد (404).',
              technicalReason: `Model ${modelIdentifier} absent from /models catalog`,
            },
      };
    }

    return {
      httpStatus: 200,
      classification: {
        status: 'healthy',
        reasonFa: 'مدل غیرمتنی (جهت جلوگیری از هزینه اضافی حفظ شد).',
        technicalReason: 'Non-chat model preserved (no /models list available)',
      },
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const msg = err instanceof Error ? err.message : 'Network error';
    return {
      httpStatus: isAbort ? 408 : null,
      classification: {
        status: 'transient',
        reasonFa: isAbort
          ? 'زمان انتظار پاسخ به پایان رسید (Timeout) — مدل جهت احتیاط حفظ شد.'
          : 'خطای موقت شبکه — مدل جهت احتیاط حفظ شد.',
        technicalReason: redactSecrets(msg, secrets),
      },
    };
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function runLane() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx]!);
    }
  }

  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, () => runLane());
  await Promise.all(lanes);
  return results;
}

/**
 * Runs a Cloudflare-Workers-safe paginated batch health check across AI models.
 * - Keeps `healthy`, `rate_limited`, `auth_error`, and `transient` models untouched.
 * - Deactivates or deletes ONLY `broken` models when `action` is `deactivate_broken` or `delete_broken`.
 */
export async function runBatchModelHealthCheck(params: {
  providerId?: string;
  category?: ModelCategory;
  modelIds?: string[];
  onlyActive?: boolean;
  offset?: number;
  limit?: number;
  action: HealthPruneAction;
}): Promise<BatchModelHealthResponse> {
  const db = getDb();
  const offset = Math.max(0, params.offset ?? 0);
  const limit = Math.min(20, Math.max(1, params.limit ?? 8));

  const conditions = [];
  if (params.providerId) conditions.push(eq(aiModels.providerId, params.providerId));
  if (params.category) conditions.push(eq(aiModels.category, params.category));
  if (params.onlyActive !== false) conditions.push(eq(aiModels.isActive, true));
  if (params.modelIds && params.modelIds.length > 0) {
    conditions.push(inArray(aiModels.id, params.modelIds));
  }

  const allMatching = await db
    .select({
      id: aiModels.id,
      providerId: aiModels.providerId,
      providerName: aiProviders.name,
      providerType: aiProviders.providerType,
      name: aiModels.name,
      modelIdentifier: aiModels.modelIdentifier,
      category: aiModels.category,
      isActive: aiModels.isActive,
      modelParameters: aiModels.modelParameters,
    })
    .from(aiModels)
    .innerJoin(aiProviders, eq(aiModels.providerId, aiProviders.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(aiModels.priority), asc(aiModels.id));

  const totalMatching = allMatching.length;
  const batchRows = allMatching.slice(offset, offset + limit);

  if (batchRows.length === 0) {
    return {
      totalMatching,
      offset,
      limit,
      processedCount: 0,
      nextOffset: null,
      hasMore: false,
      action: params.action,
      summary: {
        healthy: 0,
        rateLimited: 0,
        broken: 0,
        authError: 0,
        transient: 0,
        deactivated: 0,
        deleted: 0,
        kept: 0,
      },
      results: [],
    };
  }

  // Preload capabilities & provider credentials once per provider in this batch
  const batchIds = batchRows.map((m) => m.id);
  const capsRows = await db
    .select({ modelId: modelCapabilities.modelId, capability: modelCapabilities.capability })
    .from(modelCapabilities)
    .where(inArray(modelCapabilities.modelId, batchIds));
  const capsByModel = new Map<string, string[]>();
  for (const row of capsRows) {
    const arr = capsByModel.get(row.modelId) ?? [];
    arr.push(row.capability);
    capsByModel.set(row.modelId, arr);
  }

  const uniqueProviderIds = Array.from(new Set(batchRows.map((m) => m.providerId)));
  const credMap = new Map<string, ProviderProbeCredential | null>();
  await Promise.all(
    uniqueProviderIds.map(async (pid) => {
      credMap.set(pid, await loadProviderProbeCredential(pid));
    }),
  );

  const openAiModelCache = new Map<string, Set<string> | null>();

  const results = await runWithConcurrency(batchRows, 4, async (row): Promise<ModelHealthProbeResult> => {
    const startedAt = Date.now();
    const cred = credMap.get(row.providerId);

    if (!cred) {
      return {
        modelId: row.id,
        modelName: row.name,
        modelIdentifier: row.modelIdentifier,
        providerId: row.providerId,
        providerName: row.providerName,
        providerType: row.providerType,
        category: row.category,
        wasActive: row.isActive,
        status: 'auth_error',
        preserved: true,
        httpStatus: null,
        reasonFa: 'ارائه‌دهنده یافت نشد (مدل حفظ شد).',
        technicalReason: 'Provider missing',
        latencyMs: Date.now() - startedAt,
        actionTaken: 'kept',
      };
    }

    const probe = await probeSingleLiveModel({
      cred,
      modelIdentifier: row.modelIdentifier,
      category: row.category,
      capabilities: capsByModel.get(row.id) ?? [],
      modelParameters: row.modelParameters ?? {},
      openAiModelCache,
    });

    const latencyMs = Date.now() - startedAt;
    let actionTaken: 'kept' | 'deactivated' | 'deleted' = 'kept';

    // CRITICAL SAFETY RULE: ONLY 'broken' models can EVER be deactivated or deleted.
    // 'healthy', 'rate_limited', 'auth_error', and 'transient' are ALWAYS preserved.
    if (probe.classification.status === 'broken') {
      if (params.action === 'deactivate_broken' && row.isActive) {
        await db
          .update(aiModels)
          .set({ isActive: false, isDefault: false, updatedAt: new Date() })
          .where(eq(aiModels.id, row.id));
        actionTaken = 'deactivated';
      } else if (params.action === 'delete_broken') {
        await db.delete(aiModels).where(eq(aiModels.id, row.id));
        actionTaken = 'deleted';
      }
    }

    return {
      modelId: row.id,
      modelName: row.name,
      modelIdentifier: row.modelIdentifier,
      providerId: row.providerId,
      providerName: row.providerName,
      providerType: row.providerType,
      category: row.category,
      wasActive: row.isActive,
      status: probe.classification.status,
      preserved: actionTaken === 'kept',
      httpStatus: probe.httpStatus,
      reasonFa: probe.classification.reasonFa,
      technicalReason: probe.classification.technicalReason,
      latencyMs,
      actionTaken,
    };
  });

  const summary: BatchModelHealthSummary = {
    healthy: results.filter((r) => r.status === 'healthy').length,
    rateLimited: results.filter((r) => r.status === 'rate_limited').length,
    broken: results.filter((r) => r.status === 'broken').length,
    authError: results.filter((r) => r.status === 'auth_error').length,
    transient: results.filter((r) => r.status === 'transient').length,
    deactivated: results.filter((r) => r.actionTaken === 'deactivated').length,
    deleted: results.filter((r) => r.actionTaken === 'deleted').length,
    kept: results.filter((r) => r.actionTaken === 'kept').length,
  };

  // Note: If models were deleted or deactivated (while onlyActive=true), offset stays adjusted cleanly
  const removedFromQuery =
    params.action === 'delete_broken'
      ? summary.deleted
      : params.action === 'deactivate_broken' && params.onlyActive !== false
        ? summary.deactivated
        : 0;

  const processedUpTo = offset + batchRows.length;
  const hasMore = processedUpTo < totalMatching;
  const nextOffset = hasMore ? Math.max(0, processedUpTo - removedFromQuery) : null;

  return {
    totalMatching,
    offset,
    limit,
    processedCount: results.length,
    nextOffset,
    hasMore,
    action: params.action,
    summary,
    results,
  };
}
