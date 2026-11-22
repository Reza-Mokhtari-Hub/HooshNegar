import type { ProviderType } from '../../shared/validation.ts';
import { redactSecrets } from '../security/crypto.ts';
import { SsrfProtectionError, validatePublicHttpsUrl } from '../security/ssrf.ts';

export interface ProviderConnectionConfig {
  providerType: ProviderType;
  baseUrl: string;
  apiKey: string;
  organizationId?: string | null;
  additionalHeaders?: Record<string, string>;
}

export interface ProviderTestResult {
  ok: boolean;
  status: 'connected' | 'degraded' | 'failed';
  httpStatus: number | null;
  latencyMs: number;
  message: string;
  discoveredModelsCount?: number;
  protocol: string;
}

export interface ProviderRequestSpec {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  protocol: string;
}

export interface AIProviderAdapter {
  readonly type: ProviderType;
  readonly protocolName: string;
  readonly defaultBaseUrl: string;
  buildTestRequest(config: ProviderConnectionConfig): ProviderRequestSpec;
  parseTestResponse(status: number, bodyText: string, latencyMs: number, apiKey: string): ProviderTestResult;
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function mergeSafeHeaders(
  base: Record<string, string>,
  extra?: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = { ...base };
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      const cleanKey = k.trim();
      if (cleanKey && !cleanKey.toLowerCase().startsWith('host')) {
        merged[cleanKey] = v;
      }
    }
  }
  return merged;
}

function extractSafeErrorMessage(bodyText: string, apiKey: string): string {
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const errObj = parsed.error as Record<string, unknown> | string | undefined;
    const rawMsg =
      typeof errObj === 'string'
        ? errObj
        : typeof errObj?.message === 'string'
          ? errObj.message
          : typeof parsed.detail === 'string'
            ? parsed.detail
            : typeof parsed.message === 'string'
              ? parsed.message
              : bodyText.slice(0, 220);
    return redactSecrets(rawMsg, [apiKey]).slice(0, 260);
  } catch {
    return redactSecrets(bodyText.slice(0, 220), [apiKey]);
  }
}

export const openaiCompatibleAdapter: AIProviderAdapter = {
  type: 'openai_compatible',
  protocolName: 'OpenAI REST v1',
  defaultBaseUrl: 'https://api.openai.com/v1',
  buildTestRequest(config) {
    const base = normalizeBaseUrl(config.baseUrl);
    const url = base.endsWith('/models') ? base : `${base}/models`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
      Accept: 'application/json',
    };
    if (config.organizationId) {
      headers['OpenAI-Organization'] = config.organizationId;
    }
    return {
      url,
      method: 'GET',
      headers: mergeSafeHeaders(headers, config.additionalHeaders),
      protocol: this.protocolName,
    };
  },
  parseTestResponse(status, bodyText, latencyMs, apiKey) {
    if (status >= 200 && status < 300) {
      let count: number | undefined;
      try {
        const parsed = JSON.parse(bodyText) as { data?: unknown[] };
        if (Array.isArray(parsed.data)) count = parsed.data.length;
      } catch {
        // non-JSON ok response
      }
      return {
        ok: true,
        status: 'connected',
        httpStatus: status,
        latencyMs,
        discoveredModelsCount: count,
        protocol: this.protocolName,
        message:
          count !== undefined
            ? `اتصال برقرار شد (${count} مدل در دسترس).`
            : 'اتصال با موفقیت تأیید شد.',
      };
    }
    return {
      ok: false,
      status: status === 429 ? 'degraded' : 'failed',
      httpStatus: status,
      latencyMs,
      protocol: this.protocolName,
      message: `خطای HTTP ${status}: ${extractSafeErrorMessage(bodyText, apiKey)}`,
    };
  },
};

export const googleGeminiAdapter: AIProviderAdapter = {
  type: 'google_gemini',
  protocolName: 'Google Gemini Native v1beta',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com',
  buildTestRequest(config) {
    const base = normalizeBaseUrl(config.baseUrl);
    const url = base.includes('/models') ? base : `${base}/v1beta/models?pageSize=20`;
    return {
      url,
      method: 'GET',
      headers: mergeSafeHeaders(
        {
          'x-goog-api-key': config.apiKey,
          Accept: 'application/json',
        },
        config.additionalHeaders,
      ),
      protocol: this.protocolName,
    };
  },
  parseTestResponse(status, bodyText, latencyMs, apiKey) {
    if (status >= 200 && status < 300) {
      let count: number | undefined;
      try {
        const parsed = JSON.parse(bodyText) as { models?: unknown[] };
        if (Array.isArray(parsed.models)) count = parsed.models.length;
      } catch {
        // ignore
      }
      return {
        ok: true,
        status: 'connected',
        httpStatus: status,
        latencyMs,
        discoveredModelsCount: count,
        protocol: this.protocolName,
        message:
          count !== undefined
            ? `اتصال به Google Gemini برقرار شد (${count} مدل شناسایی شد).`
            : 'اتصال به Google Gemini تأیید شد.',
      };
    }
    return {
      ok: false,
      status: status === 429 ? 'degraded' : 'failed',
      httpStatus: status,
      latencyMs,
      protocol: this.protocolName,
      message: `خطای Gemini HTTP ${status}: ${extractSafeErrorMessage(bodyText, apiKey)}`,
    };
  },
};

export const anthropicAdapter: AIProviderAdapter = {
  type: 'anthropic',
  protocolName: 'Anthropic Messages API v1',
  defaultBaseUrl: 'https://api.anthropic.com',
  buildTestRequest(config) {
    const base = normalizeBaseUrl(config.baseUrl);
    const url = base.endsWith('/models') ? base : `${base}/v1/models`;
    return {
      url,
      method: 'GET',
      headers: mergeSafeHeaders(
        {
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
          Accept: 'application/json',
        },
        config.additionalHeaders,
      ),
      protocol: this.protocolName,
    };
  },
  parseTestResponse(status, bodyText, latencyMs, apiKey) {
    if (status >= 200 && status < 300) {
      let count: number | undefined;
      try {
        const parsed = JSON.parse(bodyText) as { data?: unknown[] };
        if (Array.isArray(parsed.data)) count = parsed.data.length;
      } catch {
        // ignore
      }
      return {
        ok: true,
        status: 'connected',
        httpStatus: status,
        latencyMs,
        discoveredModelsCount: count,
        protocol: this.protocolName,
        message:
          count !== undefined
            ? `اتصال به Anthropic برقرار شد (${count} مدل فعال).`
            : 'اتصال به Anthropic تأیید شد.',
      };
    }
    return {
      ok: false,
      status: status === 429 ? 'degraded' : 'failed',
      httpStatus: status,
      latencyMs,
      protocol: this.protocolName,
      message: `خطای Anthropic HTTP ${status}: ${extractSafeErrorMessage(bodyText, apiKey)}`,
    };
  },
};

export const replicateAdapter: AIProviderAdapter = {
  type: 'replicate',
  protocolName: 'Replicate REST API v1',
  defaultBaseUrl: 'https://api.replicate.com',
  buildTestRequest(config) {
    const base = normalizeBaseUrl(config.baseUrl);
    const url = base.endsWith('/account') ? base : `${base}/v1/account`;
    return {
      url,
      method: 'GET',
      headers: mergeSafeHeaders(
        {
          Authorization: `Bearer ${config.apiKey}`,
          Accept: 'application/json',
        },
        config.additionalHeaders,
      ),
      protocol: this.protocolName,
    };
  },
  parseTestResponse(status, bodyText, latencyMs, apiKey) {
    if (status >= 200 && status < 300) {
      let accountType = '';
      try {
        const parsed = JSON.parse(bodyText) as { type?: string };
        if (parsed.type) accountType = ` (${parsed.type})`;
      } catch {
        // ignore
      }
      return {
        ok: true,
        status: 'connected',
        httpStatus: status,
        latencyMs,
        protocol: this.protocolName,
        message: `اتصال به حساب Replicate تأیید شد${accountType}.`,
      };
    }
    return {
      ok: false,
      status: status === 429 ? 'degraded' : 'failed',
      httpStatus: status,
      latencyMs,
      protocol: this.protocolName,
      message: `خطای Replicate HTTP ${status}: ${extractSafeErrorMessage(bodyText, apiKey)}`,
    };
  },
};

export const falAiAdapter: AIProviderAdapter = {
  type: 'fal_ai',
  protocolName: 'fal.ai Queue & REST API',
  defaultBaseUrl: 'https://api.fal.ai',
  buildTestRequest(config) {
    const base = normalizeBaseUrl(config.baseUrl);
    const url = base.includes('/models') ? base : `${base}/v1/models?limit=10`;
    return {
      url,
      method: 'GET',
      headers: mergeSafeHeaders(
        {
          Authorization: `Key ${config.apiKey}`,
          Accept: 'application/json',
        },
        config.additionalHeaders,
      ),
      protocol: this.protocolName,
    };
  },
  parseTestResponse(status, bodyText, latencyMs, apiKey) {
    if (status >= 200 && status < 300) {
      return {
        ok: true,
        status: 'connected',
        httpStatus: status,
        latencyMs,
        protocol: this.protocolName,
        message: 'اتصال به سرویس fal.ai با موفقیت تأیید شد.',
      };
    }
    return {
      ok: false,
      status: status === 429 ? 'degraded' : 'failed',
      httpStatus: status,
      latencyMs,
      protocol: this.protocolName,
      message: `خطای fal.ai HTTP ${status}: ${extractSafeErrorMessage(bodyText, apiKey)}`,
    };
  },
};

export const customAdapter: AIProviderAdapter = {
  type: 'custom',
  protocolName: 'Custom HTTP/JSON Provider',
  defaultBaseUrl: 'https://api.example.com/v1',
  buildTestRequest(config) {
    const base = normalizeBaseUrl(config.baseUrl);
    const url = base.endsWith('/models') || base.endsWith('/health') ? base : `${base}/models`;
    return {
      url,
      method: 'GET',
      headers: mergeSafeHeaders(
        {
          Authorization: `Bearer ${config.apiKey}`,
          Accept: 'application/json',
        },
        config.additionalHeaders,
      ),
      protocol: this.protocolName,
    };
  },
  parseTestResponse(status, bodyText, latencyMs, apiKey) {
    if (status >= 200 && status < 300) {
      return {
        ok: true,
        status: 'connected',
        httpStatus: status,
        latencyMs,
        protocol: this.protocolName,
        message: 'اتصال به ارائه‌دهنده سفارشی تأیید شد.',
      };
    }
    return {
      ok: false,
      status: status === 429 ? 'degraded' : 'failed',
      httpStatus: status,
      latencyMs,
      protocol: this.protocolName,
      message: `خطای سرویس سفارشی HTTP ${status}: ${extractSafeErrorMessage(bodyText, apiKey)}`,
    };
  },
};

const ADAPTER_REGISTRY: Record<ProviderType, AIProviderAdapter> = {
  openai_compatible: openaiCompatibleAdapter,
  google_gemini: googleGeminiAdapter,
  anthropic: anthropicAdapter,
  replicate: replicateAdapter,
  fal_ai: falAiAdapter,
  custom: customAdapter,
};

export function getProviderAdapter(providerType: ProviderType): AIProviderAdapter {
  return ADAPTER_REGISTRY[providerType];
}

export async function testProviderConnection(
  config: ProviderConnectionConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderTestResult> {
  const adapter = getProviderAdapter(config.providerType);
  const spec = adapter.buildTestRequest(config);
  const startedAt = Date.now();
  try {
    validatePublicHttpsUrl(spec.url);
  } catch (err) {
    return {
      ok: false,
      status: 'failed',
      httpStatus: null,
      latencyMs: Date.now() - startedAt,
      protocol: adapter.protocolName,
      message:
        err instanceof SsrfProtectionError
          ? err.message
          : 'آدرس ارائه‌دهنده به دلیل قوانین امنیتی مسدود شد.',
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetchImpl(spec.url, {
      method: spec.method,
      headers: spec.headers,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const bodyText = await response.text();
    return adapter.parseTestResponse(response.status, bodyText, latencyMs, config.apiKey);
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const rawMessage = err instanceof Error ? err.message : 'خطای شبکه در ارتباط با ارائه‌دهنده';
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      status: 'failed',
      httpStatus: null,
      latencyMs,
      protocol: adapter.protocolName,
      message: isTimeout
        ? 'پاسخ ارائه‌دهنده بیش از ۱۲ ثانیه طول کشید (Timeout).'
        : `عدم دسترسی به سرویس: ${redactSecrets(rawMessage, [config.apiKey])}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}
