import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import type { Update } from 'grammy/types';
import { getDb } from '../../db/index.ts';
import {
  aiModels,
  aiProviders,
  generationJobs,
  modelCapabilities,
  providerCredentials,
  telegramAccounts,
  telegramBotSettings,
} from '../../db/schema.ts';
import { ensurePlatformReady } from '../services/bootstrap.ts';
import { encryptSecret, maskSecret } from '../security/crypto.ts';
import { createTelegramBotInstance } from './bot.ts';
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
});
