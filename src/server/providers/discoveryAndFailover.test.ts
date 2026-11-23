import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import {
  aiModels,
  aiProviders,
  modelCapabilities,
  providerCredentials,
} from '../../db/schema.ts';
import {
  ensureCloudflareWorkersAiSeeded,
  ensurePlatformReady,
  resetBootstrapCacheForTests,
} from '../services/bootstrap.ts';
import { setGlobalCloudflareAiBinding } from '../cloudflare/requestContext.ts';
import { encryptSecret, maskSecret } from '../security/crypto.ts';
import { testProviderConnection } from './adapters.ts';
import {
  discoverProviderModels,
  normalizeGeminiModelId,
  normalizeGeminiRootBaseUrl,
  syncProviderModelsToDatabase,
} from './discovery.ts';
import {
  buildGradioInputPayload,
  generateImageWithRoute,
  generateSpeechWithRoute,
  generateTextWithRoute,
  loadModelExecutionRoute,
  transcribeAudioWithRoute,
} from './engine.ts';
import {
  BLOB_CHUNK_SENTINEL,
  BLOB_CHUNK_SIZE,
  joinBlobChunks,
  splitBlobBase64,
} from '../storage/storageAdapter.ts';
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
  setGlobalCloudflareAiBinding(undefined);
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

  it('executes Gemini text/Gemma/image/Imagen/TTS, OpenAI reasoning retry, and Hugging Face Hub routing properly via direct REST', async () => {
    const {
      normalizeOpenAiRootBaseUrl,
      resolveHuggingFaceRouterRoot,
    } = await import('./discovery.ts');
    const {
      editImageWithRoute,
      generateImageWithRoute,
      generateSpeechWithRoute,
    } = await import('./engine.ts');

    expect(normalizeOpenAiRootBaseUrl('https://api.openai.com')).toBe('https://api.openai.com/v1');
    expect(normalizeOpenAiRootBaseUrl('https://api.groq.com/openai/v1/chat/completions')).toBe(
      'https://api.groq.com/openai/v1',
    );
    expect(resolveHuggingFaceRouterRoot('https://huggingface.co/black-forest-labs/FLUX.1-dev')).toBe(
      'https://router.huggingface.co',
    );

    const db = getDb();
    const [gemProv] = await db
      .insert(aiProviders)
      .values({
        name: 'Gemini REST Provider',
        slug: `gem-rest-${Date.now()}`,
        providerType: 'google_gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        isActive: true,
      })
      .returning();

    const discovery = await discoverProviderModels(
      {
        providerType: 'google_gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'AIzaMockKey',
      },
      (async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-2.5-flash-image',
                displayName: 'Gemini 2.5 Flash Image',
                supportedGenerationMethods: ['generateContent'],
              },
              {
                name: 'models/gemma-3-27b-it',
                displayName: 'Gemma 3 27B',
                supportedGenerationMethods: ['generateContent'],
              },
              {
                name: 'models/gemini-2.5-flash',
                displayName: 'Gemini 2.5 Flash',
                supportedGenerationMethods: ['generateContent'],
              },
            ],
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    );

    // Clear any existing default flag from earlier tests in the shared PGlite harness
    await db.update(aiModels).set({ isDefault: false });

    await syncProviderModelsToDatabase({
      providerId: gemProv!.id,
      providerType: 'google_gemini',
      discoveredModels: discovery.models,
    });

    const syncedModels = await db
      .select()
      .from(aiModels)
      .where(eq(aiModels.providerId, gemProv!.id));

    const flashDefault = syncedModels.find((m) => m.modelIdentifier === 'gemini-2.5-flash');
    const gemImageModel = syncedModels.find((m) => m.modelIdentifier === 'gemini-2.5-flash-image');
    const gemmaModel = syncedModels.find((m) => m.modelIdentifier === 'gemma-3-27b-it');
    expect(flashDefault?.isDefault).toBe(true);
    expect(gemImageModel?.isDefault).toBe(false);
    expect(gemmaModel?.isDefault).toBe(false);

    const gemImageCaps = await db
      .select({ capability: modelCapabilities.capability })
      .from(modelCapabilities)
      .where(eq(modelCapabilities.modelId, gemImageModel!.id));
    expect(gemImageCaps.map((c) => c.capability)).not.toContain('chat');

    process.env.AI_MOCK_MODE = 'false';

    // 1. Gemma folds systemPrompt into user turn (no systemInstruction)
    const capturedGemmaBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedGemmaBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'پاسخ جما' }] }, finishReason: 'STOP' }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const gemKey = 'AIzaTestKeyForExecution999';
    const encGem = encryptSecret(gemKey);
    await db.insert(providerCredentials).values({
      providerId: gemProv!.id,
      label: 'main',
      encryptedApiKey: encGem.ciphertext,
      iv: encGem.iv,
      authTag: encGem.authTag,
      maskedPreview: maskSecret(gemKey),
      isActive: true,
      status: 'active',
    });

    const gemmaRoute = await loadModelExecutionRoute(gemmaModel!.id);
    const gemmaOut = await generateTextWithRoute(gemmaRoute, {
      systemPrompt: 'به فارسی جواب بده',
      messages: [{ role: 'user', content: 'سلام' }],
    });
    expect(gemmaOut.result.text).toBe('پاسخ جما');
    expect(capturedGemmaBodies[0]).toBeTruthy();
    expect(capturedGemmaBodies[0]?.systemInstruction).toBeUndefined();

    // 2. Gemini native image includes responseModalities: ['IMAGE', 'TEXT'] and omits unsupported imageSize
    let capturedImgUrl = '';
    const capturedImgBodies: Array<{
      generationConfig?: { responseModalities?: string[]; imageConfig?: Record<string, unknown> };
    }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedImgUrl = String(url);
      capturedImgBodies.push(
        JSON.parse(String(init?.body ?? '{}')) as {
          generationConfig?: { responseModalities?: string[]; imageConfig?: Record<string, unknown> };
        },
      );
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { inlineData: { mimeType: 'image/png', data: Buffer.from('PNGDATA').toString('base64') } },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const imgRoute = await loadModelExecutionRoute(gemImageModel!.id);
    const genImg = await generateImageWithRoute(imgRoute, {
      prompt: 'یک گربه فضانورد',
      aspectRatio: '1:1',
      resolution: '1K',
    });
    expect(capturedImgUrl).toContain('/v1beta/models/gemini-2.5-flash-image:generateContent');
    expect(genImg.result.images[0]?.buffer.toString()).toBe('PNGDATA');
    const genCfg = capturedImgBodies[0]?.generationConfig;
    expect(genCfg?.responseModalities).toEqual(['IMAGE', 'TEXT']);
    expect(genCfg?.imageConfig?.imageSize).toBeUndefined();

    // 3. Gemini Imagen uses :predict with instances & parameters
    const [imagenModel] = await db
      .insert(aiModels)
      .values({
        providerId: gemProv!.id,
        name: 'Imagen 3',
        modelIdentifier: 'imagen-3.0-generate-002',
        category: 'image',
        isActive: true,
      })
      .returning();
    await db.insert(modelCapabilities).values({ modelId: imagenModel!.id, capability: 'image_generation' });

    let capturedImagenUrl = '';
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      capturedImagenUrl = String(url);
      return new Response(
        JSON.stringify({
          predictions: [{ bytesBase64Encoded: Buffer.from('IMAGENBYTES').toString('base64'), mimeType: 'image/png' }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const imagenRoute = await loadModelExecutionRoute(imagenModel!.id);
    const imagenRes = await generateImageWithRoute(imagenRoute, {
      prompt: 'منظره کوهستان',
      aspectRatio: '16:9',
      resolution: '1K',
    });
    expect(capturedImagenUrl).toContain('/v1beta/models/imagen-3.0-generate-002:predict');
    expect(imagenRes.result.images[0]?.buffer.toString()).toBe('IMAGENBYTES');

    // 4. Gemini TTS wraps raw PCM audio/L16 in a valid RIFF WAVE header
    const [ttsModel] = await db
      .insert(aiModels)
      .values({
        providerId: gemProv!.id,
        name: 'Gemini TTS',
        modelIdentifier: 'gemini-2.5-flash-preview-tts',
        category: 'audio',
        isActive: true,
      })
      .returning();
    await db.insert(modelCapabilities).values({ modelId: ttsModel!.id, capability: 'speech_generation' });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: 'audio/L16;codec=pcm;rate=24000',
                      data: Buffer.from([1, 2, 3, 4]).toString('base64'),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const ttsRoute = await loadModelExecutionRoute(ttsModel!.id);
    const ttsRes = await generateSpeechWithRoute(ttsRoute, { text: 'سلام دنیا' });
    expect(ttsRes.result.mimeType).toBe('audio/wav');
    expect(ttsRes.result.audioBuffer.subarray(0, 4).toString()).toBe('RIFF');
    expect(ttsRes.result.audioBuffer.subarray(8, 12).toString()).toBe('WAVE');

    // 5. Gemini image edit sends responseModalities: ['IMAGE', 'TEXT'] + inlineData
    let capturedEditBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedEditBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { inlineData: { mimeType: 'image/png', data: Buffer.from('EDITED').toString('base64') } },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const editRes = await editImageWithRoute(imgRoute, {
      prompt: 'کلاه بگذار',
      sourceImageBuffer: Buffer.from('SRC'),
      sourceMimeType: 'image/png',
      mode: 'edit',
    });
    expect(editRes.result.images[0]?.buffer.toString()).toBe('EDITED');
    expect(
      (capturedEditBody as { generationConfig?: { responseModalities?: string[] } } | null)
        ?.generationConfig?.responseModalities,
    ).toEqual(['IMAGE', 'TEXT']);

    // 5b. OpenAI reasoning model (`o3-mini`) sends max_completion_tokens cleanly
    const [oaProv] = await db
      .insert(aiProviders)
      .values({
        name: 'OpenAI Bare Root',
        slug: `oa-bare-${Date.now()}`,
        providerType: 'openai_compatible',
        baseUrl: 'https://api.openai.com',
        isActive: true,
      })
      .returning();
    const oaKey = 'sk-test-openai-reasoning';
    const encOa = encryptSecret(oaKey);
    await db.insert(providerCredentials).values({
      providerId: oaProv!.id,
      label: 'main',
      encryptedApiKey: encOa.ciphertext,
      iv: encOa.iv,
      authTag: encOa.authTag,
      maskedPreview: maskSecret(oaKey),
      isActive: true,
      status: 'active',
    });
    const [o3Model] = await db
      .insert(aiModels)
      .values({
        providerId: oaProv!.id,
        name: 'o3-mini',
        modelIdentifier: 'o3-mini',
        category: 'llm',
        isActive: true,
      })
      .returning();
    await db.insert(modelCapabilities).values({ modelId: o3Model!.id, capability: 'chat' });

    let capturedOaUrl = '';
    let capturedOaBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedOaUrl = String(url);
      capturedOaBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'پاسخ استدلالی' } }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const o3Route = await loadModelExecutionRoute(o3Model!.id);
    const o3Out = await generateTextWithRoute(o3Route, {
      messages: [{ role: 'user', content: '2+2?' }],
    });
    expect(capturedOaUrl).toBe('https://api.openai.com/v1/chat/completions');
    expect((capturedOaBody as Record<string, unknown> | null)?.max_completion_tokens).toBeTruthy();
    expect(o3Out.result.text).toBe('پاسخ استدلالی');

    // 6. Hugging Face Hub model URL routes to router.huggingface.co/hf-inference/models/... (never 404 Hub HTML)
    const [hfFluxProv] = await db
      .insert(aiProviders)
      .values({
        name: 'HF Hub FLUX Repo',
        slug: `hf-flux-${Date.now()}`,
        providerType: 'huggingface',
        baseUrl: 'https://huggingface.co/black-forest-labs/FLUX.1-dev',
        isActive: true,
      })
      .returning();
    const hfRouterKey = 'hf_test_router_key_999';
    const encHf = encryptSecret(hfRouterKey);
    await db.insert(providerCredentials).values({
      providerId: hfFluxProv!.id,
      label: 'main',
      encryptedApiKey: encHf.ciphertext,
      iv: encHf.iv,
      authTag: encHf.authTag,
      maskedPreview: maskSecret(hfRouterKey),
      isActive: true,
      status: 'active',
    });
    const [fluxModel] = await db
      .insert(aiModels)
      .values({
        providerId: hfFluxProv!.id,
        name: 'FLUX.1-dev',
        modelIdentifier: 'black-forest-labs/FLUX.1-dev',
        category: 'image',
        isActive: true,
      })
      .returning();
    await db.insert(modelCapabilities).values({ modelId: fluxModel!.id, capability: 'image_generation' });

    let capturedHfImgUrl = '';
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      capturedHfImgUrl = String(url);
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    }) as unknown as typeof fetch;

    const fluxRoute = await loadModelExecutionRoute(fluxModel!.id);
    const fluxRes = await generateImageWithRoute(fluxRoute, { prompt: 'persian garden' });
    expect(capturedHfImgUrl).toBe('https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-dev');
    expect(fluxRes.result.images[0]?.buffer.byteLength).toBe(4);
  });

  it('prevents cross-model key poisoning on 403/limit:0, self-heals poisoned keys, and handles dall-e-3 + HF Hub URLs', async () => {
    const { normalizeModelIdentifierForProvider } = await import('./discovery.ts');
    const { generateImageWithRoute } = await import('./engine.ts');

    expect(
      normalizeModelIdentifierForProvider(
        'huggingface',
        'https://huggingface.co/black-forest-labs/FLUX.1-dev',
      ),
    ).toBe('black-forest-labs/FLUX.1-dev');

    const db = getDb();
    process.env.AI_MOCK_MODE = 'false';

    // A. Gemini provider with one valid key
    const [gemProv] = await db
      .insert(aiProviders)
      .values({
        name: 'Gemini Self-Heal Provider',
        slug: `gem-heal-${Date.now()}`,
        providerType: 'google_gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        isActive: true,
      })
      .returning();

    const gemSecret = 'AIzaHealKey123456789';
    const encGem = encryptSecret(gemSecret);
    const [gemCred] = await db
      .insert(providerCredentials)
      .values({
        providerId: gemProv!.id,
        label: 'primary',
        encryptedApiKey: encGem.ciphertext,
        iv: encGem.iv,
        authTag: encGem.authTag,
        maskedPreview: maskSecret(gemSecret),
        status: 'active',
        isActive: true,
      })
      .returning();

    const [imagenModel] = await db
      .insert(aiModels)
      .values({
        providerId: gemProv!.id,
        name: 'Imagen 3 Fast',
        modelIdentifier: 'imagen-3.0-fast-generate-001',
        category: 'image',
        isActive: true,
      })
      .returning();
    await db.insert(modelCapabilities).values({ modelId: imagenModel!.id, capability: 'image_generation' });

    const [flashImgModel] = await db
      .insert(aiModels)
      .values({
        providerId: gemProv!.id,
        name: 'Gemini 2.5 Flash Image',
        modelIdentifier: 'gemini-2.5-flash-image',
        category: 'image',
        isActive: true,
      })
      .returning();
    await db.insert(modelCapabilities).values({ modelId: flashImgModel!.id, capability: 'image_generation' });

    // 1. Imagen 403 billed-users error must NOT poison the credential
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 403,
            message: 'Imagen API is only accessible to billed users at this time.',
            status: 'PERMISSION_DENIED',
          },
        }),
        { status: 403 },
      )) as unknown as typeof fetch;

    const imagenRoute = await loadModelExecutionRoute(imagenModel!.id);
    await expect(
      generateImageWithRoute(imagenRoute, { prompt: 'sunset over Tehran' }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.stringMatching(/billed users/i),
      userMessageFa: expect.stringMatching(/در حال حاضر در دسترس نیست/),
    });

    const [credAfter403] = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.id, gemCred!.id));
    expect(credAfter403?.status).toBe('active');
    expect(credAfter403?.cooldownUntil).toBeNull();

    // 2. Gemini 429 with limit: 0 must NOT put credential into quota_exhausted cooldown,
    //    keeps full diagnostics in err.message (for Admin) while err.userMessageFa stays clean for customers
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 429,
            message:
              'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-2.5-flash-image',
            status: 'RESOURCE_EXHAUSTED',
          },
        }),
        { status: 429 },
      )) as unknown as typeof fetch;

    const flashRoute = await loadModelExecutionRoute(flashImgModel!.id);
    try {
      await generateImageWithRoute(flashRoute, { prompt: 'neon cat' });
      expect.unreachable('Should have thrown RATE_LIMITED');
    } catch (err) {
      const e = err as { code?: string; message?: string; userMessageFa?: string };
      expect(e.code).toBe('RATE_LIMITED');
      expect(e.message).toMatch(/gemini-2\.5-flash-image.*limit: 0|Quota exceeded.*limit: 0/i);
      expect(e.userMessageFa).toMatch(/در حال حاضر در دسترس نیست/);
      expect(e.userMessageFa).not.toMatch(/Google|Cloudflare|Billing|API|limit: 0|HTTP|کلودفلر|گوگل/i);
    }

    const [credAfterLimitZero] = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.id, gemCred!.id));
    expect(credAfterLimitZero?.status).toBe('active');
    expect(credAfterLimitZero?.cooldownUntil).toBeNull();

    // 3. Legacy poisoned credential in DB (status: 'invalid' from 403) auto-recovers on next working call
    await db
      .update(providerCredentials)
      .set({
        status: 'invalid',
        failureCount: 3,
        lastErrorCode: 'INVALID_API_KEY',
        lastErrorMessage: 'Provider auth failed (403): PERMISSION_DENIED',
      })
      .where(eq(providerCredentials.id, gemCred!.id));

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { inlineData: { mimeType: 'image/png', data: Buffer.from('HEALEDPNG').toString('base64') } },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const healedRoute = await loadModelExecutionRoute(flashImgModel!.id);
    const healedRes = await generateImageWithRoute(healedRoute, { prompt: 'healed lotus' });
    expect(healedRes.result.images[0]?.buffer.toString()).toBe('HEALEDPNG');

    const [credHealed] = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.id, gemCred!.id));
    expect(credHealed?.status).toBe('active');
    expect(credHealed?.failureCount).toBe(0);

    // 4. Disabled provider and zero-credential provider surface specific diagnostics
    const [disabledProv] = await db
      .insert(aiProviders)
      .values({
        name: 'Disabled Image Prov',
        slug: `disabled-prov-${Date.now()}`,
        providerType: 'google_gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        isActive: false,
      })
      .returning();
    const [disabledModel] = await db
      .insert(aiModels)
      .values({
        providerId: disabledProv!.id,
        name: 'Disabled Img',
        modelIdentifier: 'gemini-2.5-flash-image',
        category: 'image',
        isActive: true,
      })
      .returning();
    await expect(loadModelExecutionRoute(disabledModel!.id)).rejects.toMatchObject({
      code: 'INVALID_API_KEY',
      message: expect.stringMatching(/disabled in admin panel/i),
      userMessageFa: expect.stringMatching(/غیرفعال است/),
    });

    const [noKeyProv] = await db
      .insert(aiProviders)
      .values({
        name: 'Keyless Image Prov',
        slug: `nokey-prov-${Date.now()}`,
        providerType: 'openai_compatible',
        baseUrl: 'https://api.openai.com/v1',
        isActive: true,
      })
      .returning();
    const [noKeyModel] = await db
      .insert(aiModels)
      .values({
        providerId: noKeyProv!.id,
        name: 'Keyless Dall-E',
        modelIdentifier: 'dall-e-3',
        category: 'image',
        isActive: true,
      })
      .returning();
    await expect(loadModelExecutionRoute(noKeyModel!.id)).rejects.toMatchObject({
      code: 'INVALID_API_KEY',
      message: expect.stringMatching(/no API credentials registered/i),
      userMessageFa: expect.stringMatching(/در حال حاضر در دسترس نیست/),
    });

    // 5. dall-e-3 maps 16:9 -> 1792x1024 and n: 1
    const [oaDalleProv] = await db
      .insert(aiProviders)
      .values({
        name: 'OpenAI DALL-E 3 Prov',
        slug: `oa-dalle3-${Date.now()}`,
        providerType: 'openai_compatible',
        baseUrl: 'https://api.openai.com',
        isActive: true,
      })
      .returning();
    const oaDalleEnc = encryptSecret('sk-dalle3-test');
    await db.insert(providerCredentials).values({
      providerId: oaDalleProv!.id,
      label: 'main',
      encryptedApiKey: oaDalleEnc.ciphertext,
      iv: oaDalleEnc.iv,
      authTag: oaDalleEnc.authTag,
      maskedPreview: 'sk-d***test',
      status: 'active',
      isActive: true,
    });
    const [dalle3Model] = await db
      .insert(aiModels)
      .values({
        providerId: oaDalleProv!.id,
        name: 'DALL-E 3',
        modelIdentifier: 'dall-e-3',
        category: 'image',
        isActive: true,
      })
      .returning();
    await db.insert(modelCapabilities).values({ modelId: dalle3Model!.id, capability: 'image_generation' });

    let capturedDalleBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedDalleBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ data: [{ b64_json: Buffer.from('DALLE3PNG').toString('base64') }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const dalleRoute = await loadModelExecutionRoute(dalle3Model!.id);
    const dalleRes = await generateImageWithRoute(dalleRoute, {
      prompt: 'architecture in isfahan',
      aspectRatio: '16:9',
    });
    expect(dalleRes.result.images[0]?.buffer.toString()).toBe('DALLE3PNG');
    expect(capturedDalleBody).toMatchObject({
      model: 'dall-e-3',
      size: '1792x1024',
      n: 1,
    });

    // 6. Hugging Face Router discovery also registers warm text-to-image models alongside chat LLMs
    const hfDiscovery = await discoverProviderModels(
      {
        providerType: 'huggingface',
        baseUrl: 'https://router.huggingface.co',
        apiKey: 'hf_test_router',
      },
      (async (url: RequestInfo | URL) => {
        const href = String(url);
        if (href.includes('router.huggingface.co/v1/models')) {
          return new Response(
            JSON.stringify({ data: [{ id: 'Qwen/Qwen2.5-72B-Instruct' }] }),
            { status: 200 },
          );
        }
        if (href.includes('huggingface.co/api/models')) {
          return new Response(
            JSON.stringify([
              { id: 'black-forest-labs/FLUX.1-schnell', pipeline_tag: 'text-to-image', tags: ['flux'] },
            ]),
            { status: 200 },
          );
        }
        return new Response('not found', { status: 404 });
      }) as unknown as typeof fetch,
    );
    expect(hfDiscovery.ok).toBe(true);
    expect(hfDiscovery.models.some((m) => m.modelIdentifier === 'Qwen/Qwen2.5-72B-Instruct')).toBe(true);
    const fluxDisc = hfDiscovery.models.find((m) => m.modelIdentifier === 'black-forest-labs/FLUX.1-schnell');
    expect(fluxDisc?.category).toBe('image');
    expect(fluxDisc?.capabilities).toContain('image_generation');
  });

  it('auto-seeds free Cloudflare Workers AI image models and executes FLUX.1 Schnell, SDXL Lightning, and Llama via native env.AI binding without API keys', async () => {
    const db = getDb();
    process.env.AI_MOCK_MODE = 'false';

    const calls: Array<{ model: string; inputs: Record<string, unknown> }> = [];
    const jpegHeaderBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const pngHeaderBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

    setGlobalCloudflareAiBinding({
      async run(model, inputs) {
        calls.push({ model, inputs });
        if (model === '@cf/black-forest-labs/flux-1-schnell') {
          return { image: jpegHeaderBytes.toString('base64') };
        }
        if (model === '@cf/bytedance/stable-diffusion-xl-lightning') {
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(pngHeaderBytes));
              controller.close();
            },
          });
        }
        if (model === '@cf/meta/llama-3.3-70b-instruct-fp8-fast') {
          return { response: 'پاسخ سریع از مدل لاما' };
        }
        if (model === '@cf/openai/whisper-large-v3-turbo') {
          return { text: 'سلام دنیا از ویس' };
        }
        if (model === '@cf/deepgram/aura-1') {
          return new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00]); // ID3 MP3 header bytes
        }
        throw new Error(`Unexpected model: ${model}`);
      },
    });

    // Clear any existing default image models so auto-seed sets FLUX.1 Schnell as default
    await db.update(aiModels).set({ isDefault: false }).where(eq(aiModels.category, 'image'));
    resetBootstrapCacheForTests();
    await ensureCloudflareWorkersAiSeeded();

    // 1. Verify connection test and full 16-model catalog discovery succeed natively with zero keys
    const testRes = await testProviderConnection({
      providerType: 'cloudflare_workers_ai',
      baseUrl: 'https://api.cloudflare.com/client/v4',
      apiKey: '',
    });
    expect(testRes.ok).toBe(true);
    expect(testRes.status).toBe('connected');
    expect(testRes.protocol).toContain('Native Binding');

    const discRes = await discoverProviderModels({
      providerType: 'cloudflare_workers_ai',
      baseUrl: 'https://api.cloudflare.com/client/v4',
      apiKey: '',
    });
    expect(discRes.ok).toBe(true);
    expect(discRes.models.length).toBeGreaterThanOrEqual(16);

    // 2. Verify provider & all 16 Cloudflare models (Image, Chat, Multimodal, STT, TTS) were auto-seeded cleanly
    const [cfProvider] = await db
      .select()
      .from(aiProviders)
      .where(eq(aiProviders.providerType, 'cloudflare_workers_ai'))
      .limit(1);
    expect(cfProvider).toBeTruthy();
    expect(cfProvider?.isActive).toBe(true);

    const seededModels = await db
      .select()
      .from(aiModels)
      .where(eq(aiModels.providerId, cfProvider!.id));
    expect(seededModels.length).toBeGreaterThanOrEqual(16);
    expect(seededModels.every((m) => !m.name.includes('کلودفلر'))).toBe(true);

    const fluxModel = seededModels.find((m) => m.modelIdentifier === '@cf/black-forest-labs/flux-1-schnell');
    const sdxlModel = seededModels.find(
      (m) => m.modelIdentifier === '@cf/bytedance/stable-diffusion-xl-lightning',
    );
    const llamaModel = seededModels.find(
      (m) => m.modelIdentifier === '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    );
    const whisperModel = seededModels.find((m) => m.modelIdentifier === '@cf/openai/whisper-large-v3-turbo');
    const auraTtsModel = seededModels.find((m) => m.modelIdentifier === '@cf/deepgram/aura-1');

    expect(fluxModel).toBeTruthy();
    expect(fluxModel?.isDefault).toBe(true);
    expect(fluxModel?.priority).toBe(15);
    expect(sdxlModel).toBeTruthy();
    expect(llamaModel).toBeTruthy();
    expect(whisperModel).toBeTruthy();
    expect(auraTtsModel).toBeTruthy();

    // 3. Execute FLUX.1 Schnell (JSON base64 JPEG output) with zero stored credentials
    const fluxRoute = await loadModelExecutionRoute(fluxModel!.id);
    const fluxOut = await generateImageWithRoute(fluxRoute, {
      prompt: 'یک قلعه ایرانی در کویر',
      aspectRatio: '1:1',
    });
    expect(fluxOut.result.images[0]?.mimeType).toBe('image/jpeg');
    expect(fluxOut.result.images[0]?.extension).toBe('jpg');
    expect(fluxOut.result.images[0]?.buffer.equals(jpegHeaderBytes)).toBe(true);
    expect(calls[0]).toEqual({
      model: '@cf/black-forest-labs/flux-1-schnell',
      inputs: { prompt: 'یک قلعه ایرانی در کویر', steps: 4 },
    });

    // 4. Execute SDXL Lightning (ReadableStream PNG binary output + 16:9 dimensions)
    const sdxlRoute = await loadModelExecutionRoute(sdxlModel!.id);
    const sdxlOut = await generateImageWithRoute(sdxlRoute, {
      prompt: 'غروب خلیج فارس',
      aspectRatio: '16:9',
    });
    expect(sdxlOut.result.images[0]?.mimeType).toBe('image/png');
    expect(sdxlOut.result.images[0]?.extension).toBe('png');
    expect(sdxlOut.result.images[0]?.buffer.equals(pngHeaderBytes)).toBe(true);
    expect(calls[1]).toEqual({
      model: '@cf/bytedance/stable-diffusion-xl-lightning',
      inputs: { prompt: 'غروب خلیج فارس', width: 1024, height: 576 },
    });

    // 5. Execute seeded Llama 3.3 70B text chat via native binding
    const llamaRoute = await loadModelExecutionRoute(llamaModel!.id);
    const llamaOut = await generateTextWithRoute(llamaRoute, {
      systemPrompt: 'به فارسی جواب بده',
      messages: [{ role: 'user', content: 'سلام' }],
    });
    expect(llamaOut.result.text).toBe('پاسخ سریع از مدل لاما');

    // 6. Execute seeded Whisper Large v3 Turbo STT & Deepgram Aura TTS via native binding
    const whisperRoute = await loadModelExecutionRoute(whisperModel!.id);
    const sttOut = await transcribeAudioWithRoute(whisperRoute, {
      audioBuffer: Buffer.from('FAKE_OGG_AUDIO'),
      mimeType: 'audio/ogg',
      fileName: 'voice.ogg',
      language: 'fa',
    });
    expect(sttOut.result.text).toBe('سلام دنیا از ویس');

    const ttsRoute = await loadModelExecutionRoute(auraTtsModel!.id);
    const ttsOut = await generateSpeechWithRoute(ttsRoute, {
      text: 'Hello from HooshNegar',
    });
    expect(ttsOut.result.mimeType).toBe('audio/mpeg');
    expect(ttsOut.result.audioBuffer.byteLength).toBe(5);

    // 7. Live REST catalog discovery enumerates additional models from Cloudflare API when Account ID + Token exist
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/accounts/acct-123/ai/models/search')) {
        return new Response(
          JSON.stringify({
            success: true,
            result: [
              {
                name: '@cf/meta/llama-3.2-3b-instruct',
                description: 'Compact Llama 3.2 3B',
                task: { name: 'Text Generation' },
              },
              {
                name: '@cf/black-forest-labs/flux-1-schnell',
                description: 'Already curated',
                task: { name: 'Text-to-Image' },
              },
            ],
            result_info: { page: 1, per_page: 100, count: 2, total_count: 2 },
          }),
          { status: 200 },
        );
      }
      return new Response('Not found', { status: 404 });
    }) as unknown as typeof fetch;

    const restDisc = await discoverProviderModels({
      providerType: 'cloudflare_workers_ai',
      baseUrl: 'https://api.cloudflare.com/client/v4',
      apiKey: 'cf-api-token-test',
      organizationId: 'acct-123',
    });
    expect(restDisc.ok).toBe(true);
    expect(restDisc.models.some((m) => m.modelIdentifier === '@cf/meta/llama-3.2-3b-instruct')).toBe(true);
    expect(restDisc.models.length).toBeGreaterThanOrEqual(17);

    // 8. Outside Worker without binding or Account ID+Token, testProviderConnection gives clear guidance
    setGlobalCloudflareAiBinding(undefined);
    const noBindTest = await testProviderConnection({
      providerType: 'cloudflare_workers_ai',
      baseUrl: 'https://api.cloudflare.com/client/v4',
      apiKey: '',
    });
    expect(noBindTest.ok).toBe(false);
    expect(noBindTest.message).toContain('Account ID');
  });

  it('filters HF Space UI helpers (update_mode_ui), auto-redirects legacy rows, and fails over ZeroGPU tokens on streaming SSE', async () => {
    process.env.AI_MOCK_MODE = 'false';
    const db = getDb();

    const qwenGradioInfo = {
      named_endpoints: {
        '/update_mode_ui': {
          parameters: [
            { parameter_name: 'mode', label: 'Generation Mode', component: 'Radio', parameter_has_default: true, parameter_default: 'Text to Image' },
          ],
          returns: [{ label: 'Image 1', component: 'Image' }],
        },
        '/update_lora_selection': {
          parameters: [
            { parameter_name: 'selected_lora', label: 'Select LoRA', component: 'Dropdown', parameter_has_default: true, parameter_default: 'None' },
          ],
          returns: [{ label: 'Image 1', component: 'Image' }],
        },
        '/_check_login_status': { parameters: [], returns: [] },
        '/generate': {
          parameters: [
            { parameter_name: 'prompt', label: 'Prompt', component: 'Textbox', parameter_has_default: false, parameter_default: null },
            { parameter_name: 'mode', label: 'Generation Mode', component: 'Radio', parameter_has_default: true, parameter_default: 'Text to Image', type: { type: 'string', enum: ['Text to Image', 'Edit Image (1 Ref)'] } },
            { parameter_name: 'ref_image_1', label: 'Image 1', component: 'Image', parameter_has_default: false, parameter_default: null },
            { parameter_name: 'custom_repo', label: 'HF LoRA Repo', component: 'Textbox', parameter_has_default: false, parameter_default: null },
            { parameter_name: 'aspect_ratio', label: 'Aspect Ratio', component: 'Dropdown', parameter_has_default: true, parameter_default: 'Square · 1:1 (1024x1024)', type: { type: 'string', enum: ['Square · 1:1 (1024x1024)', 'Landscape · 16:9 (1344x768)'] } },
            { parameter_name: 'steps', label: 'Inference Steps', component: 'Slider', parameter_has_default: true, parameter_default: 30 },
          ],
          returns: [{ label: 'Generated Output', component: 'Image' }],
        },
      },
    };

    const capturedPosts: Array<{ auth: string; url: string; data: unknown[] }> = [];
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa, 0xbb]);

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const auth =
        (init?.headers && !Array.isArray(init.headers)
          ? (init.headers as Record<string, string>).Authorization || (init.headers as Record<string, string>).authorization
          : '') ?? '';

      if (url.includes('/api/spaces/owner/qwen-aio')) {
        return new Response(JSON.stringify({ host: 'https://owner-qwen-aio.hf.space', sdk: 'gradio' }), { status: 200 });
      }
      if (url.endsWith('/gradio_api/info')) {
        return new Response(JSON.stringify(qwenGradioInfo), { status: 200 });
      }
      if (url.endsWith('/gradio_api/call/generate')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { data?: unknown[] };
        capturedPosts.push({ auth, url, data: body.data ?? [] });
        const eventId = auth.includes('hf_token_1') ? 'evt-quota' : 'evt-ok';
        return new Response(JSON.stringify({ event_id: eventId }), { status: 200 });
      }
      if (url.endsWith('/gradio_api/call/generate/evt-quota')) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('event: error\ndata: "You have exceeded your GPU quota (60s requested vs. 0s left)"\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (url.endsWith('/gradio_api/call/generate/evt-ok')) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('event: heartbeat\ndata: null\n\n'));
            controller.enqueue(
              encoder.encode(
                'event: complete\ndata: [{"url":"https://owner-qwen-aio.hf.space/gradio_api/file=/tmp/out.png"}]\n\n',
              ),
            );
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (url.includes('/gradio_api/file=/tmp/out.png')) {
        return new Response(pngBytes, { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      return new Response('Not Found', { status: 404 });
    }) as unknown as typeof fetch;

    // 1. Discovery skips update_mode_ui, update_lora_selection, _check_login_status and imports ONLY /generate
    const disc = await discoverProviderModels({
      providerType: 'huggingface_space',
      baseUrl: 'https://huggingface.co/spaces/owner/qwen-aio',
      apiKey: 'hf_token_1',
    });
    expect(disc.ok).toBe(true);
    expect(disc.models).toHaveLength(1);
    expect(disc.models[0]?.modelIdentifier).toBe('owner/qwen-aio::generate');
    expect(disc.models[0]?.name).toBe('qwen-aio');

    // 2. Sync automatically deactivates legacy ::update_mode_ui models already in DB
    const [hfProv] = await db
      .insert(aiProviders)
      .values({
        name: 'HF Qwen Space Test',
        slug: `hf-qwen-space-${Date.now()}`,
        providerType: 'huggingface_space',
        baseUrl: 'https://huggingface.co/spaces/owner/qwen-aio',
        isActive: true,
      })
      .returning();

    const enc1 = encryptSecret('hf_token_1');
    const enc2 = encryptSecret('hf_token_2');
    const [cred1] = await db
      .insert(providerCredentials)
      .values({
        providerId: hfProv!.id,
        label: 'hf-acc-1',
        encryptedApiKey: enc1.ciphertext,
        iv: enc1.iv,
        authTag: enc1.authTag,
        maskedPreview: maskSecret('hf_token_1'),
        priority: 10,
        status: 'active',
        isActive: true,
      })
      .returning();
    await db.insert(providerCredentials).values({
      providerId: hfProv!.id,
      label: 'hf-acc-2',
      encryptedApiKey: enc2.ciphertext,
      iv: enc2.iv,
      authTag: enc2.authTag,
      maskedPreview: maskSecret('hf_token_2'),
      priority: 20,
      status: 'active',
      isActive: true,
    });

    const [legacyHelperModel] = await db
      .insert(aiModels)
      .values({
        providerId: hfProv!.id,
        name: 'qwen-aio (update_mode_ui)',
        modelIdentifier: 'owner/qwen-aio::update_mode_ui',
        category: 'image',
        isActive: true,
      })
      .returning();
    await db.insert(modelCapabilities).values({ modelId: legacyHelperModel!.id, capability: 'image_generation' });

    await syncProviderModelsToDatabase({
      providerId: hfProv!.id,
      providerType: 'huggingface_space',
      discoveredModels: disc.models,
    });

    const [legacyAfterSync] = await db
      .select()
      .from(aiModels)
      .where(eq(aiModels.id, legacyHelperModel!.id));
    expect(legacyAfterSync?.isActive).toBe(false);

    // 3. Even if a legacy ::update_mode_ui row were still active, execution auto-redirects to /generate,
    //    maps parameters properly (null image, 16:9 enum, capped steps), and fails over from hf_token_1 -> hf_token_2!
    await db.update(aiModels).set({ isActive: true }).where(eq(aiModels.id, legacyHelperModel!.id));
    const route = await loadModelExecutionRoute(legacyHelperModel!.id);
    const imgOut = await generateImageWithRoute(route, {
      prompt: 'persian garden at dusk',
      aspectRatio: '16:9',
    });

    expect(imgOut.result.images[0]?.buffer.equals(pngBytes)).toBe(true);
    expect(capturedPosts).toHaveLength(2);
    expect(capturedPosts[0]?.auth).toBe('Bearer hf_token_1');
    expect(capturedPosts[1]?.auth).toBe('Bearer hf_token_2');
    // Verify exact Gradio payload: [prompt, mode, ref_image_1=null, custom_repo='', aspect_ratio=16:9 enum, steps<=20]
    expect(capturedPosts[1]?.data[0]).toBe('persian garden at dusk');
    expect(capturedPosts[1]?.data[1]).toBe('Text to Image');
    expect(capturedPosts[1]?.data[2]).toBeNull();
    expect(capturedPosts[1]?.data[3]).toBe('');
    expect(capturedPosts[1]?.data[4]).toBe('Landscape · 16:9 (1344x768)');
    expect(Number(capturedPosts[1]?.data[5])).toBeLessThanOrEqual(20);

    const [cred1After] = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.id, cred1!.id));
    expect(cred1After?.status).toBe('quota_exhausted');
  });

  it('auto-selects built-in Turbo LoRA + optimal 6 steps on Qwen-Image AIO Gradio schema and caps steps in edit mode', () => {
    const qwenSchemaCtx = {
      providerId: 'prov-qwen',
      providerName: 'HF Qwen Space',
      providerType: 'huggingface_space' as const,
      baseUrl: 'https://huggingface.co/spaces/leivisondias/qwen-image-2.1-uncensored-aio-loras',
      apiKey: 'hf_test_dummy',
      credentialId: null,
      organizationId: null,
      additionalHeaders: {},
      modelId: 'm-qwen',
      modelName: 'qwen-image-2.1-uncensored-aio-loras',
      modelIdentifier: 'leivisondias/qwen-image-2.1-uncensored-aio-loras::generate',
      modelParameters: {
        spaceHost: 'https://leivisondias-qwen-image-2-1-uncensored-aio-loras.hf.space',
        apiName: 'generate',
        endpointPrefix: '/gradio_api',
        parameters: [
          { index: 0, name: 'prompt', label: 'Prompt', component: 'textbox', hasDefault: false, defaultValue: null },
          {
            index: 1,
            name: 'mode',
            label: 'Mode',
            component: 'radio',
            hasDefault: true,
            defaultValue: 'Text to Image',
            enum: ['Text to Image', 'Edit Image (1 Ref)', 'Multi-Image Edit (2 Refs)'],
          },
          { index: 2, name: 'ref_image_1', label: 'Ref Image 1', component: 'image', hasDefault: true, defaultValue: null },
          { index: 3, name: 'ref_image_2', label: 'Ref Image 2', component: 'image', hasDefault: true, defaultValue: null },
          {
            index: 4,
            name: 'lora_adapter',
            label: 'LoRA Adapter',
            component: 'dropdown',
            hasDefault: true,
            defaultValue: 'None (Base Uncensored)',
            enum: ['None (Base Uncensored)', 'Viggle Turbo (6-Step)', 'Realism Boost'],
          },
          { index: 5, name: 'lora_strength', label: 'LoRA Strength', component: 'slider', hasDefault: true, defaultValue: 1 },
          { index: 6, name: 'custom_repo', label: 'Custom Repo', component: 'textbox', hasDefault: true, defaultValue: '' },
          { index: 7, name: 'custom_file', label: 'Custom File', component: 'textbox', hasDefault: true, defaultValue: '' },
          {
            index: 8,
            name: 'aspect_ratio',
            label: 'Aspect Ratio',
            component: 'dropdown',
            hasDefault: true,
            defaultValue: 'Square · 1:1 (1024x1024)',
            enum: ['Square · 1:1 (1024x1024)', 'Landscape · 16:9 (1344x768)'],
          },
          { index: 9, name: 'steps', label: 'Steps', component: 'slider', hasDefault: true, defaultValue: 30 },
          { index: 10, name: 'seed', label: 'Seed', component: 'number', hasDefault: true, defaultValue: 42 },
          { index: 11, name: 'randomize_seed', label: 'Randomize Seed', component: 'checkbox', hasDefault: true, defaultValue: true },
        ],
      },
      supportedCapabilities: ['image_generation' as const, 'image_editing' as const],
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
      maxInputSize: 32000,
      maxOutputSize: 4096,
    };

    const genArgs = buildGradioInputPayload(qwenSchemaCtx, 'persian sunset over mountains', undefined, undefined, undefined, {
      aspectRatio: '16:9',
      mode: 'generate',
    });
    expect(genArgs).toEqual([
      'persian sunset over mountains',
      'Text to Image',
      null,
      null,
      'Viggle Turbo (6-Step)',
      1,
      '',
      '',
      'Landscape · 16:9 (1344x768)',
      6,
      42,
      true,
    ]);

    const editArgs = buildGradioInputPayload(
      qwenSchemaCtx,
      'add golden light',
      undefined,
      undefined,
      { path: '/tmp/source.png', meta: { _type: 'gradio.FileData' } },
      { aspectRatio: '1:1', mode: 'edit' },
    );
    expect(editArgs[1]).toBe('Edit Image (1 Ref)');
    expect(editArgs[2]).toEqual({ path: '/tmp/source.png', meta: { _type: 'gradio.FileData' } });
    expect(editArgs[3]).toBeNull();
    expect(editArgs[4]).toBe('Viggle Turbo (6-Step)');
    expect(Number(editArgs[9])).toBe(6);
  });

  it('auto-promotes Space URLs saved under providerType="huggingface" in testProviderConnection and discoverProviderModels', async () => {
    const spaceUrl = 'https://huggingface.co/spaces/owner/fast-img-space';
    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('huggingface.co/api/spaces/owner/fast-img-space')) {
        return new Response(
          JSON.stringify({ host: 'https://owner-fast-img-space.hf.space', sdk: 'gradio' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('owner-fast-img-space.hf.space/gradio_api/info')) {
        return new Response(
          JSON.stringify({
            named_endpoints: {
              '/generate': {
                parameters: [{ label: 'Prompt', parameter_name: 'prompt', component: 'textbox' }],
                returns: [{ label: 'Result', component: 'image' }],
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not found', { status: 404 });
    };

    const probe = await testProviderConnection(
      { providerType: 'huggingface', baseUrl: spaceUrl, apiKey: '' },
      mockFetch,
    );
    expect(probe.ok).toBe(true);
    expect(probe.protocol).toMatch(/Gradio|Space/i);

    const disc = await discoverProviderModels(
      { providerType: 'huggingface', baseUrl: spaceUrl, apiKey: '' },
      mockFetch,
    );
    expect(disc.ok).toBe(true);
    expect(disc.models).toHaveLength(1);
    expect(disc.models[0]?.modelIdentifier).toBe('owner/fast-img-space::generate');
  });

  it('chunks large 2.6 MB base64 image payloads safely below Cloudflare Durable Object SQLite 2 MB row limit', () => {
    // 2.6 MB base64 string (equivalent to a ~1.95 MB uncompressed 1024x1024 PNG)
    const largeBase64 = 'A'.repeat(1_000_000) + 'B'.repeat(1_000_000) + 'C'.repeat(600_000);
    expect(largeBase64.length).toBeGreaterThan(2_097_152);
    expect(BLOB_CHUNK_SENTINEL).toBe('__CHUNKED__');

    const chunks = splitBlobBase64(largeBase64, BLOB_CHUNK_SIZE);
    expect(chunks.length).toBe(6);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(BLOB_CHUNK_SIZE);
      expect(chunk.length).toBeLessThan(2_097_152);
    }
    expect(joinBlobChunks(chunks)).toBe(largeBase64);

    // Small payload stays single unchunked string
    const smallBase64 = 'SGVsbG8=';
    expect(splitBlobBase64(smallBase64)).toEqual([smallBase64]);
  });
});


