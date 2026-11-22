import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import {
  aiModels,
  aiProviders,
  modelCapabilities,
  providerCredentials,
} from '../../db/schema.ts';
import { ensurePlatformReady } from '../services/bootstrap.ts';
import { encryptSecret, maskSecret } from '../security/crypto.ts';
import {
  discoverProviderModels,
  normalizeGeminiModelId,
  normalizeGeminiRootBaseUrl,
  syncProviderModelsToDatabase,
} from './discovery.ts';
import { generateTextWithRoute, loadModelExecutionRoute } from './engine.ts';
import {
  ensureTelegramUser,
  getAvailableModelsForUser,
  resolveSelectedModelForCapability,
} from '../telegram/userService.ts';
import { buildDynamicModelsKeyboard } from '../telegram/keyboards.ts';

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  process.env.ENCRYPTION_MASTER_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  await ensurePlatformReady();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.AI_MOCK_MODE = 'true';
});

describe('Provider Auto-Discovery, Telegram Visibility & Multi-Key Failover', () => {
  it('normalizes Gemini URLs/IDs, syncs discovered models, and surfaces multimodal/text models in Telegram', async () => {
    expect(normalizeGeminiRootBaseUrl('https://generativelanguage.googleapis.com/v1beta/')).toBe(
      'https://generativelanguage.googleapis.com',
    );
    expect(normalizeGeminiModelId('models/gemini-2.5-flash')).toBe('gemini-2.5-flash');

    const geminiDiscoveryFetch = (async () =>
      new Response(
        JSON.stringify({
          models: [
            {
              name: 'models/gemini-2.5-flash',
              displayName: 'Gemini 2.5 Flash',
              description: 'Fast multimodal Gemini',
              inputTokenLimit: 1000000,
              outputTokenLimit: 8192,
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/imagen-3.0-generate-002',
              displayName: 'Imagen 3',
              description: 'Image model',
              supportedGenerationMethods: ['predict'],
            },
            {
              name: 'models/text-embedding-004',
              displayName: 'Text Embedding 004',
              supportedGenerationMethods: ['embedContent'],
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const discovery = await discoverProviderModels(
      {
        providerType: 'google_gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'AIzaTestDiscoveryKey12345',
      },
      geminiDiscoveryFetch,
    );

    expect(discovery.ok).toBe(true);
    expect(discovery.resolvedBaseUrl).toBe('https://generativelanguage.googleapis.com');
    expect(discovery.models.length).toBe(3);

    const db = getDb();
    const [prov] = await db
      .insert(aiProviders)
      .values({
        name: 'Gemini Manual Test',
        slug: `gemini-manual-${Date.now()}`,
        providerType: 'google_gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        isActive: true,
        priority: 10,
      })
      .returning();

    const syncRes = await syncProviderModelsToDatabase({
      providerId: prov!.id,
      providerType: 'google_gemini',
      discoveredModels: discovery.models,
      activateAll: true,
    });
    expect(syncRes.createdCount).toBe(3);

    // Ensure repeated sync skips duplicates idempotently
    const secondSync = await syncProviderModelsToDatabase({
      providerId: prov!.id,
      providerType: 'google_gemini',
      discoveredModels: discovery.models,
      activateAll: true,
    });
    expect(secondSync.createdCount).toBe(0);
    expect(secondSync.skippedCount).toBe(3);

    // Also add a manual Gemini model that ONLY has 'text_generation' (not 'chat')
    const [manualLlm] = await db
      .insert(aiModels)
      .values({
        providerId: prov!.id,
        name: 'Gemini Text Only Manual',
        modelIdentifier: 'gemini-2.0-flash-lite',
        category: 'llm',
        isActive: true,
      })
      .returning();
    await db.insert(modelCapabilities).values({
      modelId: manualLlm!.id,
      capability: 'text_generation',
    });

    const tgUser = await ensureTelegramUser({
      telegramUserId: 998877661,
      telegramChatId: 998877661,
      firstName: 'TestGemini',
      languageCode: 'fa',
    });

    // 'text' Telegram category MUST include both multimodal Gemini 2.5 Flash and text_generation-only manual LLM
    const textMenuModels = await getAvailableModelsForUser({
      userId: tgUser.user.id,
      categoryGroup: 'text',
    });
    const ids = textMenuModels.map((m) => m.modelIdentifier);
    expect(ids).toContain('gemini-2.5-flash');
    expect(ids).toContain('gemini-2.0-flash-lite');
    expect(ids).not.toContain('text-embedding-004');

    // Mini App /chat compatibility ('chat' resolves text_generation too)
    const chatCapable = await getAvailableModelsForUser({
      userId: tgUser.user.id,
      capability: 'chat',
    });
    expect(chatCapable.some((m) => m.modelIdentifier === 'gemini-2.0-flash-lite')).toBe(true);

    // Selected resolution works even if user picks the text_generation-only model
    const selectedText = await resolveSelectedModelForCapability({
      userId: tgUser.user.id,
      telegramAccount: { ...tgUser.telegramAccount, selectedTextModelId: manualLlm!.id },
      capability: 'chat',
    });
    expect(selectedText?.id).toBe(manualLlm!.id);

    // Telegram keyboard pagination renders cleanly and keeps callback_data <= 64 bytes
    const manyModels = Array.from({ length: 15 }, (_, i) => ({
      ...textMenuModels[0]!,
      id: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
      name: `Model ${i + 1}`,
    }));
    const page0 = buildDynamicModelsKeyboard(manyModels, manyModels[0]!.id, 'text', 0);
    const flatButtons = page0.inline_keyboard.flat();
    for (const btn of flatButtons) {
      if ('callback_data' in btn && btn.callback_data) {
        expect(Buffer.byteLength(btn.callback_data, 'utf8')).toBeLessThanOrEqual(64);
      }
    }
    expect(flatButtons.some((b) => 'callback_data' in b && b.callback_data === 'mcat:text:1')).toBe(true);
  });

  it('discovers Hugging Face Router & Hugging Face Spaces (Gradio/ZeroGPU) and executes multi-key pool failover on quota exhaustion', async () => {
    // 1. Discover Hugging Face Space endpoints
    const spaceDiscoveryFetch = (async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href.includes('/api/spaces/')) {
        return new Response(
          JSON.stringify({ host: 'https://owner-chat-space.hf.space', sdk: 'gradio', private: false }),
          { status: 200 },
        );
      }
      if (href.endsWith('/gradio_api/info')) {
        return new Response(
          JSON.stringify({
            named_endpoints: {
              '/chat': {
                parameters: [{ label: 'Prompt', parameter_name: 'message', component: 'textbox' }],
                returns: [{ label: 'Response', component: 'textbox' }],
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const hfSpaceFound = await discoverProviderModels(
      {
        providerType: 'huggingface_space',
        baseUrl: 'https://huggingface.co/spaces/owner/chat-space',
        apiKey: '',
      },
      spaceDiscoveryFetch,
    );
    expect(hfSpaceFound.ok).toBe(true);
    expect(hfSpaceFound.models[0]?.modelIdentifier).toBe('owner/chat-space::chat');
    expect(hfSpaceFound.models[0]?.capabilities).toContain('chat');

    // 2. Multi-Key Failover Pool: Key #1 returns 429 insufficient_quota -> rotates to Key #2 and succeeds!
    const db = getDb();
    const key1 = 'hf_quota_exhausted_key_111111';
    const key2 = 'hf_healthy_backup_key_222222';
    const enc1 = encryptSecret(key1);
    const enc2 = encryptSecret(key2);

    const [hfProv] = await db
      .insert(aiProviders)
      .values({
        name: 'HF Failover Pool',
        slug: `hf-pool-${Date.now()}`,
        providerType: 'huggingface',
        baseUrl: 'https://router.huggingface.co',
        isActive: true,
        priority: 5,
      })
      .returning();

    const [cred1, cred2] = await db
      .insert(providerCredentials)
      .values([
        {
          providerId: hfProv!.id,
          label: 'primary',
          encryptedApiKey: enc1.ciphertext,
          iv: enc1.iv,
          authTag: enc1.authTag,
          keyVersion: 1,
          maskedPreview: maskSecret(key1),
          priority: 100,
          status: 'active',
          isActive: true,
        },
        {
          providerId: hfProv!.id,
          label: 'backup-1',
          encryptedApiKey: enc2.ciphertext,
          iv: enc2.iv,
          authTag: enc2.authTag,
          keyVersion: 2,
          maskedPreview: maskSecret(key2),
          priority: 101,
          status: 'active',
          isActive: true,
        },
      ])
      .returning();

    const [hfModel] = await db
      .insert(aiModels)
      .values({
        providerId: hfProv!.id,
        name: 'Llama 3.3 70B',
        modelIdentifier: 'meta-llama/Llama-3.3-70B-Instruct',
        category: 'llm',
        isActive: true,
      })
      .returning();
    await db.insert(modelCapabilities).values([
      { modelId: hfModel!.id, capability: 'text_generation' },
      { modelId: hfModel!.id, capability: 'chat' },
    ]);

    process.env.AI_MOCK_MODE = 'false';
    const seenAuthHeaders: string[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const auth = headers.Authorization || headers.authorization || '';
      seenAuthHeaders.push(auth);
      if (auth.includes(key1)) {
        return new Response(
          JSON.stringify({ error: { message: 'Monthly credits exceeded / insufficient_quota' } }),
          { status: 429 },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'پاسخ موفق از کلید پشتیبان دوم!' } }],
          usage: { prompt_tokens: 12, completion_tokens: 9 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const route = await loadModelExecutionRoute(hfModel!.id);
    expect(route.primary.credentialPool?.length).toBe(2);

    const exec = await generateTextWithRoute(route, {
      messages: [{ role: 'user', content: 'سلام' }],
    });
    expect(exec.usedFallback).toBe(false);
    expect(exec.result.text).toContain('کلید پشتیبان دوم');
    expect(seenAuthHeaders).toEqual([`Bearer ${key1}`, `Bearer ${key2}`]);

    const poolAfter = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.providerId, hfProv!.id))
      .orderBy(asc(providerCredentials.priority));

    expect(poolAfter[0]?.id).toBe(cred1!.id);
    expect(poolAfter[0]?.status).toBe('quota_exhausted');
    expect(poolAfter[0]?.failureCount).toBe(1);
    expect(poolAfter[1]?.id).toBe(cred2!.id);
    expect(poolAfter[1]?.status).toBe('active');
    expect(poolAfter[1]?.lastUsedAt).toBeTruthy();

    // 3. HF Space Gradio SSE execution rotates on ZeroGPU quota error
    const spaceKey1 = 'hf_zerogpu_empty_111';
    const spaceKey2 = 'hf_zerogpu_full_222';
    const sEnc1 = encryptSecret(spaceKey1);
    const sEnc2 = encryptSecret(spaceKey2);

    const [spaceProv] = await db
      .insert(aiProviders)
      .values({
        name: 'ZeroGPU Space',
        slug: `hf-space-${Date.now()}`,
        providerType: 'huggingface_space',
        baseUrl: 'https://owner-zerogpu.hf.space',
        isActive: true,
        priority: 6,
      })
      .returning();

    await db.insert(providerCredentials).values([
      {
        providerId: spaceProv!.id,
        label: 'primary',
        encryptedApiKey: sEnc1.ciphertext,
        iv: sEnc1.iv,
        authTag: sEnc1.authTag,
        keyVersion: 1,
        maskedPreview: maskSecret(spaceKey1),
        priority: 100,
        status: 'active',
        isActive: true,
      },
      {
        providerId: spaceProv!.id,
        label: 'backup-1',
        encryptedApiKey: sEnc2.ciphertext,
        iv: sEnc2.iv,
        authTag: sEnc2.authTag,
        keyVersion: 2,
        maskedPreview: maskSecret(spaceKey2),
        priority: 101,
        status: 'active',
        isActive: true,
      },
    ]);

    const [spaceModel] = await db
      .insert(aiModels)
      .values({
        providerId: spaceProv!.id,
        name: 'Space Chat',
        modelIdentifier: 'owner/zerogpu::chat',
        category: 'llm',
        modelParameters: {
          spaceHost: 'https://owner-zerogpu.hf.space',
          apiName: 'chat',
          endpointPrefix: '/gradio_api',
        },
        isActive: true,
      })
      .returning();
    await db.insert(modelCapabilities).values([
      { modelId: spaceModel!.id, capability: 'text_generation' },
      { modelId: spaceModel!.id, capability: 'chat' },
    ]);

    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const auth = headers.Authorization || headers.authorization || '';
      if (init?.method === 'POST' && href.endsWith('/gradio_api/call/chat')) {
        return new Response(
          JSON.stringify({ event_id: auth.includes(spaceKey1) ? 'evt_1' : 'evt_2' }),
          { status: 200 },
        );
      }
      if (href.endsWith('/gradio_api/call/chat/evt_1')) {
        return new Response('event: error\ndata: You have exceeded your GPU quota (ZeroGPU).\n\n', {
          status: 200,
        });
      }
      if (href.endsWith('/gradio_api/call/chat/evt_2')) {
        return new Response('event: complete\ndata: ["پاسخ موفق از اسپیس با توکن دوم"]\n\n', {
          status: 200,
        });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const spaceRoute = await loadModelExecutionRoute(spaceModel!.id);
    const spaceExec = await generateTextWithRoute(spaceRoute, {
      messages: [{ role: 'user', content: 'سلام اسپیس' }],
    });
    expect(spaceExec.result.text).toBe('پاسخ موفق از اسپیس با توکن دوم');
  });
});
