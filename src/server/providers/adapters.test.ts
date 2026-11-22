import { describe, expect, it } from 'vitest';
import { getProviderAdapter, testProviderConnection } from './adapters.ts';

describe('Multi-Provider Protocol Adapters', () => {
  it('constructs protocol-specific headers and endpoints for all 6 providers', () => {
    const openai = getProviderAdapter('openai_compatible').buildTestRequest({
      providerType: 'openai_compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-openai-key-123456',
      organizationId: 'org-xyz',
    });
    expect(openai.url).toBe('https://api.openai.com/v1/models');
    expect(openai.headers.Authorization).toBe('Bearer sk-test-openai-key-123456');
    expect(openai.headers['OpenAI-Organization']).toBe('org-xyz');

    const gemini = getProviderAdapter('google_gemini').buildTestRequest({
      providerType: 'google_gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'AIzaSyTestKey12345678901234567890',
    });
    expect(gemini.url).toContain('/v1beta/models');
    expect(gemini.headers['x-goog-api-key']).toBe('AIzaSyTestKey12345678901234567890');

    const anthropic = getProviderAdapter('anthropic').buildTestRequest({
      providerType: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-test-key-1234567890',
    });
    expect(anthropic.url).toBe('https://api.anthropic.com/v1/models');
    expect(anthropic.headers['x-api-key']).toBe('sk-ant-test-key-1234567890');
    expect(anthropic.headers['anthropic-version']).toBe('2023-06-01');

    const replicate = getProviderAdapter('replicate').buildTestRequest({
      providerType: 'replicate',
      baseUrl: 'https://api.replicate.com',
      apiKey: 'r8_testtoken1234567890123',
    });
    expect(replicate.url).toBe('https://api.replicate.com/v1/account');

    const fal = getProviderAdapter('fal_ai').buildTestRequest({
      providerType: 'fal_ai',
      baseUrl: 'https://api.fal.ai',
      apiKey: 'fal_secret_key_12345',
    });
    expect(fal.headers.Authorization).toBe('Key fal_secret_key_12345');

    const hf = getProviderAdapter('huggingface').buildTestRequest({
      providerType: 'huggingface',
      baseUrl: 'https://router.huggingface.co',
      apiKey: 'hf_test_token_123456',
    });
    expect(hf.url).toBe('https://router.huggingface.co/v1/models');
    expect(hf.headers.Authorization).toBe('Bearer hf_test_token_123456');

    const hfSpace = getProviderAdapter('huggingface_space').buildTestRequest({
      providerType: 'huggingface_space',
      baseUrl: 'https://huggingface.co/spaces/Qwen/Qwen2.5-Max-Demo',
      apiKey: '',
    });
    expect(hfSpace.url).toContain('qwen-qwen2-5-max-demo.hf.space/gradio_api/info');
  });

  it('normalizes Gemini base URLs containing /v1beta and resolves public HF Space info', async () => {
    const geminiWithV1Beta = getProviderAdapter('google_gemini').buildTestRequest({
      providerType: 'google_gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'AIzaTest1234567890',
    });
    expect(geminiWithV1Beta.url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=50');

    const spaceFetch = (async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href.includes('/api/spaces/')) {
        return new Response(JSON.stringify({ host: 'https://qwen-demo.hf.space', sdk: 'gradio' }), {
          status: 200,
        });
      }
      if (href.endsWith('/gradio_api/info')) {
        return new Response(
          JSON.stringify({
            named_endpoints: {
              '/chat': { parameters: [{ label: 'Prompt' }], returns: [{ label: 'Reply' }] },
            },
          }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const spaceRes = await testProviderConnection(
      {
        providerType: 'huggingface_space',
        baseUrl: 'https://huggingface.co/spaces/Qwen/Demo',
        apiKey: '',
      },
      spaceFetch,
    );
    expect(spaceRes.ok).toBe(true);
    expect(spaceRes.status).toBe('connected');
    expect(spaceRes.resolvedBaseUrl).toBe('https://qwen-demo.hf.space');
    expect(spaceRes.discoveredModelsCount).toBe(1);
  });

  it('tests connection cleanly and redacts secrets on provider failure', async () => {
    const fakeKey = 'sk-proj-supersecretkey99887766';
    const mockOkFetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4.1' }] }), {
        status: 200,
      })) as unknown as typeof fetch;

    const okResult = await testProviderConnection(
      {
        providerType: 'openai_compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: fakeKey,
      },
      mockOkFetch,
    );
    expect(okResult.ok).toBe(true);
    expect(okResult.status).toBe('connected');
    expect(okResult.discoveredModelsCount).toBe(2);

    const mockErrFetch = (async () =>
      new Response(JSON.stringify({ error: { message: `Invalid key ${fakeKey}` } }), {
        status: 401,
      })) as unknown as typeof fetch;

    const errResult = await testProviderConnection(
      {
        providerType: 'openai_compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: fakeKey,
      },
      mockErrFetch,
    );
    expect(errResult.ok).toBe(false);
    expect(errResult.status).toBe('failed');
    expect(errResult.message).not.toContain(fakeKey);
    expect(errResult.message).toContain('[REDACTED]');
  });
});
