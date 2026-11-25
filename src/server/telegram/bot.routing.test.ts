import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import type { Update } from 'grammy/types';
import { getDb } from '../../db/index.ts';
import {
  aiModels,
  aiProviders,
  aiRequests,
  generationJobs,
  modelCapabilities,
  providerCredentials,
  telegramAccounts,
  telegramBotSettings,
} from '../../db/schema.ts';
import { ensurePlatformReady } from '../services/bootstrap.ts';
import { encryptSecret, maskSecret } from '../security/crypto.ts';
import { createTelegramBotInstance } from './bot.ts';
import { executeMediaPollJob, executeVideoPollJob } from './jobRunner.ts';
import { ensureTelegramUser, updateTelegramUserState } from './userService.ts';

const TEST_BOT_TOKEN = '123456789:AAH_bot_routing_test_token_000111';

describe('Telegram Bot Photo & Document Image Routing', () => {
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    process.env.AI_MOCK_MODE = 'true';
    process.env.ENCRYPTION_MASTER_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.SESSION_SECRET = 'bot_routing_test_session_secret_0123456789abcdef';

    await ensurePlatformReady();

    const db = getDb();
    const encBot = encryptSecret(TEST_BOT_TOKEN);
    const existingBot = await db
      .select({ id: telegramBotSettings.id })
      .from(telegramBotSettings)
      .where(eq(telegramBotSettings.singletonKey, 'primary'))
      .limit(1);
    if (existingBot[0]) {
      await db
        .update(telegramBotSettings)
        .set({
          encryptedBotToken: encBot.ciphertext,
          tokenIv: encBot.iv,
          tokenAuthTag: encBot.authTag,
          maskedBotToken: maskSecret(TEST_BOT_TOKEN),
          botUsername: 'hooshnegar_routing_bot',
          isActive: true,
        })
        .where(eq(telegramBotSettings.singletonKey, 'primary'));
    }

    const [existingProv] = await db
      .select({ id: aiProviders.id })
      .from(aiProviders)
      .where(eq(aiProviders.slug, 'bot-routing-test-provider'))
      .limit(1);

    if (!existingProv) {
      const encKey = encryptSecret('sk-bot-routing-test-123');
      const [prov] = await db
        .insert(aiProviders)
        .values({
          name: 'Bot Routing Provider',
          slug: 'bot-routing-test-provider',
          providerType: 'google_gemini',
          baseUrl: 'https://generativelanguage.googleapis.com',
          isActive: true,
          priority: 1,
        })
        .returning();

      await db.insert(providerCredentials).values({
        providerId: prov!.id,
        label: 'routing-key',
        encryptedApiKey: encKey.ciphertext,
        iv: encKey.iv,
        authTag: encKey.authTag,
        keyVersion: 1,
        maskedPreview: maskSecret('sk-bot-routing-test-123'),
        isActive: true,
      });

      const [imgModel] = await db
        .insert(aiModels)
        .values({
          providerId: prov!.id,
          name: 'Bot Test Image Model',
          modelIdentifier: 'imagen-3.0-fast-generate-001',
          category: 'image',
          creditCost: '5',
          isDefault: true,
          isActive: true,
        })
        .returning();

      await db.insert(modelCapabilities).values([
        { modelId: imgModel!.id, capability: 'image_generation' },
        { modelId: imgModel!.id, capability: 'image_editing' },
        { modelId: imgModel!.id, capability: 'image_variation' },
      ]);

      const [vidModel] = await db
        .insert(aiModels)
        .values({
          providerId: prov!.id,
          name: 'Bot Test Video Model',
          modelIdentifier: 'veo-2.0-generate-001',
          category: 'video',
          creditCost: '15',
          isDefault: true,
          isActive: true,
        })
        .returning();

      await db.insert(modelCapabilities).values([
        { modelId: vidModel!.id, capability: 'video_generation' },
      ]);
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function createMockBot() {
    const sentMessages: Array<{ method: string; text?: string; caption?: string }> = [];
    const bot = createTelegramBotInstance(TEST_BOT_TOKEN);
    bot.botInfo = {
      id: 123456789,
      is_bot: true,
      first_name: 'HooshNegar Test',
      username: 'hooshnegar_routing_bot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    } as never;

    bot.api.config.use(async (_prev, method, payload) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      sentMessages.push({
        method,
        text: typeof p.text === 'string' ? p.text : undefined,
        caption: typeof p.caption === 'string' ? p.caption : undefined,
      });
      if (method === 'getFile') {
        return {
          ok: true,
          result: {
            file_id: String(p.file_id ?? 'file_1'),
            file_unique_id: 'uniq_1',
            file_path: 'photos/mock_input.png',
          },
        } as never;
      }
      if (method === 'sendMessage' || method === 'sendPhoto' || method === 'sendDocument') {
        return {
          ok: true,
          result: {
            message_id: 9901,
            date: Math.floor(Date.now() / 1000),
            chat: { id: Number(p.chat_id ?? 771001), type: 'private' },
            text: typeof p.text === 'string' ? p.text : undefined,
          },
        } as never;
      }
      return { ok: true, result: true } as never;
    });

    // Mock Telegram file download endpoint so jobRunner can execute mock edit jobs
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('api.telegram.org/file/')) {
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    return { bot, sentMessages };
  }

  it('routes photo sent in image_prompt mode without caption into image_edit_prompt instead of vision', async () => {
    const ensured = await ensureTelegramUser({
      telegramUserId: 771001,
      telegramChatId: 771001,
      username: 'photo_nocaption',
      firstName: 'تست عکس',
      languageCode: 'fa',
    });
    await updateTelegramUserState(ensured.telegramAccount.id, { mode: 'image_prompt' });

    const { bot, sentMessages } = createMockBot();
    const update: Update = {
      update_id: 50001,
      message: {
        message_id: 601,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 771001, type: 'private', first_name: 'تست عکس' },
        from: { id: 771001, is_bot: false, first_name: 'تست عکس', username: 'photo_nocaption' },
        photo: [
          {
            file_id: 'photo_edit_file_1',
            file_unique_id: 'uniq_photo_edit_1',
            width: 512,
            height: 512,
            file_size: 12345,
          },
        ],
      },
    };

    await bot.handleUpdate(update);

    const db = getDb();
    const [acc] = await db
      .select()
      .from(telegramAccounts)
      .where(eq(telegramAccounts.id, ensured.telegramAccount.id))
      .limit(1);

    expect(acc?.botState?.mode).toBe('image_edit_prompt');
    expect(acc?.botState?.imageParams?.sourceFileId).toBe('photo_edit_file_1');
    expect(sentMessages.some((m) => m.text?.includes('دستور ویرایش'))).toBe(true);
  });

  it('routes uncompressed PNG image document in image_prompt mode with caption directly to image_editing', async () => {
    const ensured = await ensureTelegramUser({
      telegramUserId: 771002,
      telegramChatId: 771002,
      username: 'doc_img_caption',
      firstName: 'تست فایل عکس',
      languageCode: 'fa',
    });
    await updateTelegramUserState(ensured.telegramAccount.id, { mode: 'image_prompt' });

    const { bot, sentMessages } = createMockBot();
    const update: Update = {
      update_id: 50002,
      message: {
        message_id: 602,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 771002, type: 'private', first_name: 'تست فایل عکس' },
        from: { id: 771002, is_bot: false, first_name: 'تست فایل عکس', username: 'doc_img_caption' },
        caption: 'تبدیل آسمان به شب پرستاره',
        document: {
          file_id: 'doc_png_edit_2',
          file_unique_id: 'uniq_doc_png_2',
          file_name: 'landscape.png',
          mime_type: 'image/png',
          file_size: 4096,
        },
      },
    };

    await bot.handleUpdate(update);

    const db = getDb();
    const [latestJob] = await db
      .select()
      .from(generationJobs)
      .where(
        and(
          eq(generationJobs.userId, ensured.user.id),
          eq(generationJobs.capability, 'image_editing'),
        ),
      )
      .orderBy(desc(generationJobs.createdAt))
      .limit(1);

    expect(latestJob).toBeTruthy();
    expect((latestJob?.payload as Record<string, unknown>)?.sourceFileId).toBe('doc_png_edit_2');
    expect((latestJob?.payload as Record<string, unknown>)?.sourceMimeType).toBe('image/png');
    expect(sentMessages.some((m) => m.text?.includes('ویرایش تصویر'))).toBe(true);
  });

  it('routes uncompressed image document without caption in video_image_photo mode cleanly to video_image_prompt', async () => {
    const ensured = await ensureTelegramUser({
      telegramUserId: 771003,
      telegramChatId: 771003,
      username: 'doc_video_frame',
      firstName: 'تست فریم ویدیو',
      languageCode: 'fa',
    });
    await updateTelegramUserState(ensured.telegramAccount.id, { mode: 'video_image_photo' });

    const { bot, sentMessages } = createMockBot();
    const update: Update = {
      update_id: 50003,
      message: {
        message_id: 603,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 771003, type: 'private', first_name: 'تست فریم ویدیو' },
        from: { id: 771003, is_bot: false, first_name: 'تست فریم ویدیو', username: 'doc_video_frame' },
        document: {
          file_id: 'doc_webp_vid_3',
          file_unique_id: 'uniq_doc_webp_3',
          file_name: 'frame.webp',
          mime_type: 'image/webp',
          file_size: 2048,
        },
      },
    };

    await bot.handleUpdate(update);

    const db = getDb();
    const [acc] = await db
      .select()
      .from(telegramAccounts)
      .where(eq(telegramAccounts.id, ensured.telegramAccount.id))
      .limit(1);

    expect(acc?.botState?.mode).toBe('video_image_prompt');
    expect(acc?.botState?.videoParams?.sourceFileId).toBe('doc_webp_vid_3');
    expect(acc?.botState?.videoParams?.sourceImageMimeType).toBe('image/webp');
    expect(sentMessages.some((m) => m.text?.includes('صحنه ویدیو'))).toBe(true);
  });

  it('auto-resubmits Telegram image_variation job using sourceFileId when HF Space poll session expires (404)', async () => {
    const db = getDb();
    const ensured = await ensureTelegramUser({
      telegramUserId: 771004,
      telegramChatId: 771004,
      username: 'tg_variation_resubmit',
      firstName: 'تست ری‌سابمیت',
      languageCode: 'fa',
    });

    const slug = `hf-resubmit-test-${randomUUID().slice(0, 8)}`;
    const encKey = encryptSecret('hf_resubmit_test_token_123');
    const [hfProv] = await db
      .insert(aiProviders)
      .values({
        name: 'HF Resubmit Test Provider',
        slug,
        providerType: 'huggingface',
        baseUrl: 'https://test-edit-space.hf.space',
        isActive: true,
        priority: 1,
      })
      .returning();

    const [cred] = await db
      .insert(providerCredentials)
      .values({
        providerId: hfProv!.id,
        label: 'hf-primary',
        encryptedApiKey: encKey.ciphertext,
        iv: encKey.iv,
        authTag: encKey.authTag,
        keyVersion: 1,
        maskedPreview: maskSecret('hf_resubmit_test_token_123'),
        isActive: true,
      })
      .returning();

    const [hfModel] = await db
      .insert(aiModels)
      .values({
        providerId: hfProv!.id,
        name: 'HF Resubmit Edit Space',
        modelIdentifier: 'owner/edit-space::generate',
        category: 'image',
        creditCost: '5',
        isDefault: false,
        isActive: true,
        modelParameters: {
          hfKind: 'space_gradio',
          spaceHost: 'https://test-edit-space.hf.space',
          endpointPrefix: '/gradio_api',
          apiName: 'generate',
        },
      })
      .returning();

    await db.insert(modelCapabilities).values([
      { modelId: hfModel!.id, capability: 'image_generation' },
      { modelId: hfModel!.id, capability: 'image_editing' },
      { modelId: hfModel!.id, capability: 'image_variation' },
    ]);

    const [reqRow] = await db
      .insert(aiRequests)
      .values({
        userId: ensured.user.id,
        modelId: hfModel!.id,
        providerId: hfProv!.id,
        capability: 'image_variation',
        status: 'running',
        idempotencyKey: `test-resubmit-${randomUUID()}`,
        creditsCharged: '0',
        promptPreview: '',
      })
      .returning();

    const [jobRow] = await db
      .insert(generationJobs)
      .values({
        requestId: reqRow!.id,
        userId: ensured.user.id,
        telegramChatId: 771004,
        capability: 'image_variation',
        status: 'running',
        progressPercent: 20,
        providerJobId: 'expired-event-1',
        startedAt: new Date(),
        payload: {
          prompt: '',
          sourceFileId: 'tg_variation_file_1',
          sourceMimeType: 'image/png',
          aspectRatio: '1:1',
          resolution: '1K',
          silentDelivery: false,
        },
        resultMetadata: {
          kind: 'hf_space_gradio_media',
          spaceHost: 'https://test-edit-space.hf.space',
          endpointPrefix: '/gradio_api',
          callUrl: 'https://test-edit-space.hf.space/gradio_api/call/generate',
          providerId: hfProv!.id,
          credentialId: cred!.id,
          pollCount: 1,
          hfResubmitCount: 0,
        },
      })
      .returning();

    let downloadedSourceFromTelegram = false;
    let resubmittedGradioCall = false;
    const prevMock = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = 'false';

    globalThis.fetch = (async (input: string | URL | Request, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('api.telegram.org/bot') && url.includes('/getFile')) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              file_id: 'tg_variation_file_1',
              file_unique_id: 'uniq_var_1',
              file_path: 'photos/source_var.png',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url.includes('api.telegram.org/file/')) {
        downloadedSourceFromTelegram = true;
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }

      if (url.includes('/gradio_api/call/generate/expired-event-1')) {
        return new Response('Session not found', { status: 404 });
      }

      if (url.endsWith('/gradio_api/info')) {
        return new Response(
          JSON.stringify({
            named_endpoints: {
              '/generate': {
                parameters: [
                  {
                    parameter_name: 'image',
                    component: 'Image',
                    type: { type: 'object' },
                  },
                  {
                    parameter_name: 'prompt',
                    component: 'Textbox',
                    type: { type: 'string' },
                  },
                ],
                returns: [{ component: 'Image', type: { type: 'object' } }],
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url.endsWith('/gradio_api/upload')) {
        return new Response(JSON.stringify(['/tmp/gradio/uploaded_var.png']), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.endsWith('/gradio_api/call/generate')) {
        resubmittedGradioCall = true;
        return new Response(JSON.stringify({ event_id: 'resubmitted-event-2' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.includes('/gradio_api/call/generate/resubmitted-event-2')) {
        return new Response('event: heartbeat\ndata: {}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    try {
      const outcome = await executeMediaPollJob(jobRow!.id, {
        maxWaitMs: 500,
        scheduleNextPoll: false,
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.status).toBe('running');
      expect(downloadedSourceFromTelegram).toBe(true);
      expect(resubmittedGradioCall).toBe(true);

      const [updatedJob] = await db
        .select()
        .from(generationJobs)
        .where(eq(generationJobs.id, jobRow!.id))
        .limit(1);

      expect(updatedJob?.status).toBe('running');
      expect(updatedJob?.providerJobId).toBe('resubmitted-event-2');
      expect((updatedJob?.resultMetadata as Record<string, unknown>)?.hfResubmitCount).toBe(1);
    } finally {
      process.env.AI_MOCK_MODE = prevMock;
    }
  });

  it('auto-resubmits HF Space video job in executeVideoPollJob when Gradio session expires with 404', async () => {
    const db = getDb();
    const ensured = await ensureTelegramUser({
      telegramUserId: 882005,
      telegramChatId: 882005,
      username: 'tg_video_poll_resubmit',
      firstName: 'VideoPollUser',
      languageCode: 'fa',
    });

    const encKey = encryptSecret('hf_video_poll_test_token');
    const [hfProv] = await db
      .insert(aiProviders)
      .values({
        name: 'HF Video Poll Test Provider',
        slug: `hf-vid-poll-test-${randomUUID().slice(0, 8)}`,
        providerType: 'huggingface',
        baseUrl: 'https://test-wan-poll-space.hf.space',
        isActive: true,
        priority: 1,
      })
      .returning();

    const [cred] = await db
      .insert(providerCredentials)
      .values({
        providerId: hfProv!.id,
        label: 'primary',
        encryptedApiKey: encKey.ciphertext,
        iv: encKey.iv,
        authTag: encKey.authTag,
        keyVersion: 1,
        maskedPreview: maskSecret('hf_video_poll_test_token'),
        isActive: true,
      })
      .returning();

    const [vidModel] = await db
      .insert(aiModels)
      .values({
        providerId: hfProv!.id,
        name: 'Wan 2.2 Test Model',
        modelIdentifier: 'owner/wan22-poll::generate_video',
        category: 'video',
        description: 'Test HF video space',
        creditCost: '10',
        isDefault: false,
        isActive: true,
        modelParameters: {
          hfKind: 'space_gradio',
          spaceHost: 'https://test-wan-poll-space.hf.space',
          apiName: 'generate_video',
          endpointPrefix: '/gradio_api',
          parameters: [
            { index: 0, name: 'input_image', label: 'Input Image', component: 'image', hasDefault: false },
            { index: 1, name: 'prompt', label: 'Prompt', component: 'textbox', hasDefault: false },
          ],
        },
      })
      .returning();

    await db.insert(modelCapabilities).values({
      modelId: vidModel!.id,
      capability: 'video_generation',
    });

    const [reqRow] = await db
      .insert(aiRequests)
      .values({
        userId: ensured.user.id,
        modelId: vidModel!.id,
        providerId: hfProv!.id,
        capability: 'video_generation',
        status: 'running',
        idempotencyKey: `test-vid-resubmit-${randomUUID()}`,
        creditsCharged: '0',
        promptPreview: 'camera pan around lantern',
      })
      .returning();

    const [jobRow] = await db
      .insert(generationJobs)
      .values({
        requestId: reqRow!.id,
        userId: ensured.user.id,
        telegramChatId: 882005,
        capability: 'video_generation',
        status: 'running',
        progressPercent: 25,
        providerJobId: 'expired-vid-event-1',
        startedAt: new Date(),
        payload: {
          prompt: 'camera pan around lantern',
          sourceFileId: 'tg_vid_src_1',
          sourceMimeType: 'image/jpeg',
          aspectRatio: '16:9',
          durationSeconds: 5,
          silentDelivery: false,
        },
        resultMetadata: {
          kind: 'hf_space_gradio',
          spaceHost: 'https://test-wan-poll-space.hf.space',
          endpointPrefix: '/gradio_api',
          callUrl: 'https://test-wan-poll-space.hf.space/gradio_api/call/generate_video',
          providerId: hfProv!.id,
          credentialId: cred!.id,
          pollCount: 1,
          hfResubmitCount: 0,
        },
      })
      .returning();

    let downloadedTgSource = false;
    let resubmittedVidCall = false;
    const prevMock = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = 'false';

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes('api.telegram.org/bot') && url.includes('/getFile')) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { file_id: 'tg_vid_src_1', file_unique_id: 'u_vid_1', file_path: 'photos/vid_src.jpg' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('api.telegram.org/file/')) {
        downloadedTgSource = true;
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        });
      }
      if (url.includes('/gradio_api/call/generate_video/expired-vid-event-1')) {
        return new Response('event: error\ndata: "404: Not Found"\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      if (url.endsWith('/gradio_api/upload')) {
        return new Response(JSON.stringify(['/tmp/gradio/vid_src.jpg']), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/gradio_api/call/generate_video')) {
        resubmittedVidCall = true;
        return new Response(JSON.stringify({ event_id: 'resubmitted-vid-event-2' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/gradio_api/call/generate_video/resubmitted-vid-event-2')) {
        return new Response('event: heartbeat\ndata: {}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    try {
      const outcome = await executeVideoPollJob(jobRow!.id, {
        maxWaitMs: 500,
        scheduleNextPoll: false,
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.status).toBe('running');
      expect(downloadedTgSource).toBe(true);
      expect(resubmittedVidCall).toBe(true);

      const [updatedJob] = await db
        .select()
        .from(generationJobs)
        .where(eq(generationJobs.id, jobRow!.id))
        .limit(1);

      expect(updatedJob?.status).toBe('running');
      expect(updatedJob?.providerJobId).toBe('resubmitted-vid-event-2');
      expect((updatedJob?.resultMetadata as Record<string, unknown>)?.hfResubmitCount).toBe(1);
    } finally {
      process.env.AI_MOCK_MODE = prevMock;
    }
  });
});

