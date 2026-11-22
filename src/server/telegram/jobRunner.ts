import { Api, InputFile } from 'grammy';
import { asc, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import {
  aiRequests,
  conversationMessages,
  conversations,
  generationJobs,
  telegramAccounts,
  telegramBotSettings,
} from '../../db/schema.ts';
import { decryptSecret, redactSecrets } from '../security/crypto.ts';
import {
  analyzeDocumentWithRoute,
  analyzeVisionWithRoute,
  editImageWithRoute,
  generateImageWithRoute,
  generateSpeechWithRoute,
  generateTextWithRoute,
  loadModelExecutionRoute,
  pollVideoGenerationJob,
  startVideoGenerationWithRoute,
  transcribeAudioWithRoute,
} from '../providers/engine.ts';
import { AIProviderError, type ChatMessage } from '../providers/types.ts';
import { reconcileRequestSuccess, refundFailedRequest } from '../services/usageService.ts';
import { extractDocumentContent, validateAudioFile } from '../services/documentService.ts';
import { getStorageAdapter } from '../storage/storageAdapter.ts';
import { enqueueBackgroundJob } from '../queue/qstash.ts';
import {
  createThrottledStreamEditor,
  sendFormattedTelegramResponse,
} from './formatter.ts';
import { buildConversationActionKeyboard } from './keyboards.ts';
import { getUserActivePlan } from './userService.ts';

export async function getConfiguredTelegramApi(): Promise<{
  api: Api;
  botToken: string;
} | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(telegramBotSettings)
    .where(eq(telegramBotSettings.singletonKey, 'primary'))
    .limit(1);

  if (!row?.encryptedBotToken || !row.tokenIv || !row.tokenAuthTag) {
    return null;
  }
  const botToken = decryptSecret({
    ciphertext: row.encryptedBotToken,
    iv: row.tokenIv,
    authTag: row.tokenAuthTag,
  });
  const safeFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    globalThis.fetch(input, init)) as unknown as NonNullable<
    ConstructorParameters<typeof Api>[1]
  >['fetch'];
  return {
    api: new Api(botToken, { fetch: safeFetch }),
    botToken,
  };
}

async function downloadTelegramFile(params: {
  api: Api;
  botToken: string;
  fileId: string;
  maxSizeMb: number;
}): Promise<{ buffer: Buffer; filePath: string; fileName: string }> {
  const fileInfo = await params.api.getFile(params.fileId);
  if (!fileInfo.file_path) {
    throw new AIProviderError({
      code: 'UNSUPPORTED_MEDIA',
      message: 'Telegram file_path missing',
      userMessageFa: 'فایل مورد نظر از سرور تلگرام قابل دریافت نبود.',
    });
  }
  if (fileInfo.file_size && fileInfo.file_size > params.maxSizeMb * 1024 * 1024) {
    throw new AIProviderError({
      code: 'UNSUPPORTED_MEDIA',
      message: 'Telegram file exceeds plan limit',
      userMessageFa: `حجم فایل بیش از سقف مجاز پلن شما (${params.maxSizeMb} مگابایت) است.`,
    });
  }

  const dlUrl = `https://api.telegram.org/file/bot${params.botToken}/${fileInfo.file_path}`;
  const res = await fetch(dlUrl);
  if (!res.ok) {
    throw new AIProviderError({
      code: 'NETWORK_ERROR',
      message: `Telegram file download HTTP ${res.status}`,
      userMessageFa: 'خطا در دریافت فایل از تلگرام. لطفاً مجدداً ارسال کنید.',
      retryable: true,
    });
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const fileName = fileInfo.file_path.split('/').pop() ?? 'file.bin';
  return { buffer, filePath: fileInfo.file_path, fileName };
}

async function isJobCanceled(jobId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ status: generationJobs.status })
    .from(generationJobs)
    .where(eq(generationJobs.id, jobId))
    .limit(1);
  return !row || row.status === 'canceled';
}

async function sendSafeErrorToChat(
  api: Api | null,
  chatId: number | null,
  statusMessageId: number | null,
  messageFa: string,
): Promise<void> {
  if (!api || !chatId) return;
  const fullText = `❌ ${messageFa}\n\n💡 اعتبار رزروشده برای این درخواست به‌صورت خودکار به کیف‌پول شما بازگردانده شد.`;
  if (statusMessageId) {
    try {
      await api.editMessageText(chatId, statusMessageId, fullText);
      return;
    } catch {
      // fall through
    }
  }
  try {
    await api.sendMessage(chatId, fullText);
  } catch {
    // ignore delivery failure if user blocked bot
  }
}

export async function executeQueuedGenerationJob(jobId: string): Promise<{
  ok: boolean;
  status: string;
  responseText?: string;
  storageObjectKey?: string | null;
  error?: string;
}> {
  const db = getDb();
  const startedAt = Date.now();

  const [job] = await db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.id, jobId))
    .limit(1);

  if (!job) {
    return { ok: false, status: 'not_found', error: 'Job not found' };
  }
  if (job.status === 'succeeded' || job.status === 'canceled') {
    return { ok: job.status === 'succeeded', status: job.status };
  }

  const [reqRow] = await db
    .select()
    .from(aiRequests)
    .where(eq(aiRequests.id, job.requestId))
    .limit(1);

  if (!reqRow || !reqRow.modelId) {
    await refundFailedRequest({
      requestId: job.requestId,
      jobId: job.id,
      errorCode: 'MODEL_MISSING',
      errorMessage: 'AI request or model reference missing',
    });
    return { ok: false, status: 'failed', error: 'Model missing' };
  }

  const now = new Date();
  await db
    .update(generationJobs)
    .set({
      status: 'running',
      progressPercent: 15,
      attempts: job.attempts + 1,
      startedAt: job.startedAt ?? now,
      updatedAt: now,
    })
    .where(eq(generationJobs.id, job.id));

  await db
    .update(aiRequests)
    .set({
      status: 'running',
      retryCount: job.attempts,
    })
    .where(eq(aiRequests.id, reqRow.id));

  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const silentDelivery = payload.silentDelivery === true;
  const tgClient = !silentDelivery && job.telegramChatId ? await getConfiguredTelegramApi() : null;
  const api = tgClient?.api ?? null;

  try {
    if (await isJobCanceled(job.id)) {
      await refundFailedRequest({
        requestId: reqRow.id,
        jobId: job.id,
        errorCode: 'CANCELED',
        errorMessage: 'Canceled by user before execution',
        canceled: true,
        latencyMs: Date.now() - startedAt,
      });
      return { ok: false, status: 'canceled' };
    }

    const activePlan = await getUserActivePlan(job.userId);
    const route = await loadModelExecutionRoute(reqRow.modelId, {
      requiredCapability: job.capability,
      allowedProviderIds: activePlan?.plan.allowedProviderIds ?? [],
      allowedModelIds: activePlan?.plan.availableModelIds ?? [],
      userPlanTier: activePlan?.plan.tier,
    });
    const maxFileSizeMb = Number(payload.maxFileSizeMb ?? activePlan?.plan.maxFileSizeMb ?? 10);

    // =========================================================================
    // 1. CHAT / TEXT GENERATION
    // =========================================================================
    if (job.capability === 'chat' || job.capability === 'text_generation') {
      const prompt = String(payload.prompt ?? '').trim();
      const systemPrompt = typeof payload.systemPrompt === 'string' ? payload.systemPrompt : undefined;
      const conversationId = reqRow.conversationId;

      const historyMessages: ChatMessage[] = [];
      if (conversationId) {
        const recent = await db
          .select({ role: conversationMessages.role, content: conversationMessages.content })
          .from(conversationMessages)
          .where(eq(conversationMessages.conversationId, conversationId))
          .orderBy(desc(conversationMessages.createdAt))
          .limit(16);

        for (const m of recent.reverse()) {
          if (m.role === 'user' || m.role === 'assistant') {
            historyMessages.push({ role: m.role, content: m.content });
          }
        }
      }

      if (historyMessages.length === 0 && prompt) {
        historyMessages.push({ role: 'user', content: prompt });
      }

      const streamEdit =
        api && job.telegramChatId && job.statusMessageId
          ? createThrottledStreamEditor({
              api,
              chatId: job.telegramChatId,
              messageId: job.statusMessageId,
            })
          : undefined;

      const abortController = new AbortController();
      const { result, usedFallback, providerId } = await generateTextWithRoute(route, {
        messages: historyMessages,
        systemPrompt,
        signal: abortController.signal,
        onChunk: async (accumulated) => {
          if (await isJobCanceled(job.id)) {
            abortController.abort();
            return;
          }
          if (streamEdit) {
            await streamEdit(accumulated);
          }
        },
      });

      if (await isJobCanceled(job.id)) {
        await refundFailedRequest({
          requestId: reqRow.id,
          jobId: job.id,
          errorCode: 'CANCELED',
          errorMessage: 'Generation stopped by user',
          canceled: true,
          latencyMs: Date.now() - startedAt,
        });
        return { ok: false, status: 'canceled' };
      }

      // Persist assistant response to conversation
      if (conversationId) {
        await db.insert(conversationMessages).values({
          conversationId,
          role: 'assistant',
          content: result.text,
          tokenCount: result.outputTokens,
        });
        const allMsgs = await db
          .select({ id: conversationMessages.id })
          .from(conversationMessages)
          .where(eq(conversationMessages.conversationId, conversationId))
          .orderBy(asc(conversationMessages.createdAt));

        await db
          .update(conversations)
          .set({
            messageCount: allMsgs.length,
            lastMessageAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(conversations.id, conversationId));
      }

      if (api && job.telegramChatId) {
        await sendFormattedTelegramResponse({
          api,
          chatId: job.telegramChatId,
          text: result.text,
          editMessageId: job.statusMessageId,
          replyMarkup: buildConversationActionKeyboard(reqRow.id) as unknown as Record<string, unknown>,
        });
      }

      await reconcileRequestSuccess({
        requestId: reqRow.id,
        jobId: job.id,
        providerId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        latencyMs: Date.now() - startedAt,
        responsePreview: result.text,
        usedFallback,
        resultMetadata: { finishReason: result.finishReason },
      });

      return { ok: true, status: 'succeeded', responseText: result.text };
    }

    // =========================================================================
    // 2. VISION ANALYSIS
    // =========================================================================
    if (job.capability === 'vision') {
      const prompt = String(payload.prompt ?? 'این تصویر را با جزئیات کامل به فارسی تحلیل کن.');
      let imageBase64 = typeof payload.imageBase64 === 'string' ? payload.imageBase64 : '';
      const mimeType = typeof payload.mimeType === 'string' ? payload.mimeType : 'image/jpeg';

      if (!imageBase64 && typeof payload.telegramFileId === 'string' && tgClient) {
        const dl = await downloadTelegramFile({
          api: tgClient.api,
          botToken: tgClient.botToken,
          fileId: payload.telegramFileId,
          maxSizeMb: maxFileSizeMb,
        });
        imageBase64 = dl.buffer.toString('base64');
      }

      const { result, usedFallback, providerId } = await analyzeVisionWithRoute(route, {
        prompt,
        imageBase64,
        mimeType,
      });

      if (reqRow.conversationId) {
        await db.insert(conversationMessages).values({
          conversationId: reqRow.conversationId,
          role: 'assistant',
          content: result.text,
          tokenCount: result.outputTokens,
        });
      }

      if (api && job.telegramChatId) {
        await sendFormattedTelegramResponse({
          api,
          chatId: job.telegramChatId,
          text: result.text,
          editMessageId: job.statusMessageId,
          replyMarkup: buildConversationActionKeyboard(reqRow.id) as unknown as Record<string, unknown>,
        });
      }

      await reconcileRequestSuccess({
        requestId: reqRow.id,
        jobId: job.id,
        providerId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        latencyMs: Date.now() - startedAt,
        responsePreview: result.text,
        usedFallback,
      });

      return { ok: true, status: 'succeeded', responseText: result.text };
    }

    // =========================================================================
    // 3. IMAGE GENERATION / EDITING / VARIATION
    // =========================================================================
    if (
      job.capability === 'image_generation' ||
      job.capability === 'image_editing' ||
      job.capability === 'image_variation'
    ) {
      const prompt = String(payload.prompt ?? '').trim();
      const aspectRatio = typeof payload.aspectRatio === 'string' ? payload.aspectRatio : '1:1';
      const resolution = typeof payload.resolution === 'string' ? payload.resolution : '1K';
      const countNum = Number(payload.count ?? 1);

      let outputRes: {
        result: { images: Array<{ buffer: Buffer; mimeType: string; extension: string; revisedPrompt?: string }>; costUsd: number };
        usedFallback: boolean;
        providerId: string;
      };

      if (job.capability === 'image_generation') {
        outputRes = await generateImageWithRoute(route, {
          prompt,
          aspectRatio,
          resolution,
          count: countNum,
        });
      } else {
        let sourceBuffer: Buffer;
        const sourceMimeType =
          typeof payload.sourceMimeType === 'string' ? payload.sourceMimeType : 'image/jpeg';

        if (typeof payload.sourceImageBase64 === 'string') {
          sourceBuffer = Buffer.from(payload.sourceImageBase64, 'base64');
        } else if (typeof payload.sourceFileId === 'string' && tgClient) {
          const dl = await downloadTelegramFile({
            api: tgClient.api,
            botToken: tgClient.botToken,
            fileId: payload.sourceFileId,
            maxSizeMb: maxFileSizeMb,
          });
          sourceBuffer = dl.buffer;
        } else {
          throw new AIProviderError({
            code: 'UNSUPPORTED_MEDIA',
            message: 'Missing source image for editing',
            userMessageFa: 'تصویر مرجع برای ویرایش یافت نشد. لطفاً دوباره تصویر را ارسال کنید.',
          });
        }

        outputRes = await editImageWithRoute(route, {
          prompt,
          sourceImageBuffer: sourceBuffer,
          sourceMimeType,
          mode: job.capability === 'image_variation' ? 'variation' : 'edit',
          aspectRatio,
          resolution,
        });
      }

      const storage = getStorageAdapter();
      let firstKey: string | null = null;
      const storedKeys: string[] = [];

      for (let i = 0; i < outputRes.result.images.length; i++) {
        const img = outputRes.result.images[i]!;
        const stored = await storage.putObject({
          buffer: img.buffer,
          mimeType: img.mimeType,
          extension: img.extension,
          prefix: 'generated-images',
          userId: job.userId,
          requestId: reqRow.id,
          jobId: job.id,
        });
        if (!firstKey) firstKey = stored.objectKey;
        storedKeys.push(stored.objectKey);

        if (api && job.telegramChatId) {
          const caption = `🎨 تصویر تولیدشده با مدل ${route.primary.modelName}\nنسبت تصویر: ${aspectRatio}`;
          await api.sendPhoto(
            job.telegramChatId,
            new InputFile(img.buffer, `hooshnegar-${i + 1}.${img.extension}`),
            { caption: caption.slice(0, 1000) },
          );
        }
      }

      if (api && job.telegramChatId && job.statusMessageId) {
        try {
          await api.deleteMessage(job.telegramChatId, job.statusMessageId);
        } catch {
          // ignore
        }
      }

      await reconcileRequestSuccess({
        requestId: reqRow.id,
        jobId: job.id,
        providerId: outputRes.providerId,
        costUsd: outputRes.result.costUsd,
        latencyMs: Date.now() - startedAt,
        responsePreview: `تولید ${outputRes.result.images.length} تصویر با موفقیت انجام شد.`,
        usedFallback: outputRes.usedFallback,
        storageObjectKey: firstKey,
        resultMetadata: { imageCount: outputRes.result.images.length, objectKeys: storedKeys },
      });

      return { ok: true, status: 'succeeded', storageObjectKey: firstKey };
    }

    // =========================================================================
    // 4. AUDIO TRANSCRIPTION (STT)
    // =========================================================================
    if (job.capability === 'audio_transcription') {
      let audioBuffer: Buffer;
      let fileName = typeof payload.fileName === 'string' ? payload.fileName : 'voice.ogg';
      let mimeType = typeof payload.mimeType === 'string' ? payload.mimeType : 'audio/ogg';
      const language = typeof payload.language === 'string' ? payload.language : 'fa';

      if (typeof payload.audioBase64 === 'string') {
        audioBuffer = Buffer.from(payload.audioBase64, 'base64');
      } else if (typeof payload.telegramFileId === 'string' && tgClient) {
        const dl = await downloadTelegramFile({
          api: tgClient.api,
          botToken: tgClient.botToken,
          fileId: payload.telegramFileId,
          maxSizeMb: maxFileSizeMb,
        });
        audioBuffer = dl.buffer;
        fileName = dl.fileName;
      } else {
        throw new AIProviderError({
          code: 'UNSUPPORTED_MEDIA',
          message: 'Missing audio input',
          userMessageFa: 'فایل صوتی یافت نشد. لطفاً ویس یا فایل صوتی را دوباره ارسال کنید.',
        });
      }

      const check = validateAudioFile({
        mimeType,
        fileName,
        sizeBytes: audioBuffer.byteLength,
        maxSizeMb: maxFileSizeMb,
      });
      if (!check.ok) {
        throw new AIProviderError({
          code: 'UNSUPPORTED_MEDIA',
          message: check.error ?? 'Invalid audio',
          userMessageFa: check.error ?? 'فایل صوتی معتبر نیست.',
        });
      }
      mimeType = check.normalizedMime ?? mimeType;

      const { result, usedFallback, providerId } = await transcribeAudioWithRoute(route, {
        audioBuffer,
        mimeType,
        fileName,
        language,
      });

      const responseText = `🎙 **متن استخراج‌شده از صوت:**\n\n${result.text}`;

      if (api && job.telegramChatId) {
        await sendFormattedTelegramResponse({
          api,
          chatId: job.telegramChatId,
          text: responseText,
          editMessageId: job.statusMessageId,
        });
      }

      await reconcileRequestSuccess({
        requestId: reqRow.id,
        jobId: job.id,
        providerId,
        costUsd: result.costUsd,
        latencyMs: Date.now() - startedAt,
        responsePreview: result.text,
        usedFallback,
      });

      return { ok: true, status: 'succeeded', responseText: result.text };
    }

    // =========================================================================
    // 5. SPEECH GENERATION (TTS)
    // =========================================================================
    if (job.capability === 'speech_generation') {
      const text = String(payload.prompt ?? '').trim();
      const voice = typeof payload.voice === 'string' ? payload.voice : 'Kore';
      const language = typeof payload.language === 'string' ? payload.language : 'fa';

      const { result, usedFallback, providerId } = await generateSpeechWithRoute(route, {
        text,
        voice,
        language,
      });

      const storage = getStorageAdapter();
      const stored = await storage.putObject({
        buffer: result.audioBuffer,
        mimeType: result.mimeType,
        extension: result.extension,
        prefix: 'generated-audio',
        userId: job.userId,
        requestId: reqRow.id,
        jobId: job.id,
      });

      if (api && job.telegramChatId) {
        await api.sendAudio(
          job.telegramChatId,
          new InputFile(result.audioBuffer, `speech.${result.extension}`),
          { caption: `🔊 خروجی صوتی (${route.primary.modelName})` },
        );
        if (job.statusMessageId) {
          try {
            await api.deleteMessage(job.telegramChatId, job.statusMessageId);
          } catch {
            // ignore
          }
        }
      }

      await reconcileRequestSuccess({
        requestId: reqRow.id,
        jobId: job.id,
        providerId,
        costUsd: result.costUsd,
        latencyMs: Date.now() - startedAt,
        responsePreview: `فایل صوتی (${stored.fileSizeBytes} بایت) تولید شد.`,
        usedFallback,
        storageObjectKey: stored.objectKey,
      });

      return { ok: true, status: 'succeeded', storageObjectKey: stored.objectKey };
    }

    // =========================================================================
    // 6. DOCUMENT & FILE ANALYSIS
    // =========================================================================
    if (job.capability === 'document_analysis') {
      const userPrompt = String(
        payload.prompt ?? 'این سند را خلاصه کن و نکات کلیدی آن را به زبان فارسی ارائه بده.',
      );
      let fileName = typeof payload.fileName === 'string' ? payload.fileName : 'document.txt';
      const mimeType = typeof payload.mimeType === 'string' ? payload.mimeType : undefined;
      let fileBuffer: Buffer;

      if (typeof payload.fileBase64 === 'string') {
        fileBuffer = Buffer.from(payload.fileBase64, 'base64');
      } else if (typeof payload.telegramFileId === 'string' && tgClient) {
        const dl = await downloadTelegramFile({
          api: tgClient.api,
          botToken: tgClient.botToken,
          fileId: payload.telegramFileId,
          maxSizeMb: maxFileSizeMb,
        });
        fileBuffer = dl.buffer;
        if (fileName === 'document.txt') fileName = dl.fileName;
      } else {
        throw new AIProviderError({
          code: 'UNSUPPORTED_MEDIA',
          message: 'Document buffer missing',
          userMessageFa: 'فایل مورد نظر برای تحلیل یافت نشد.',
        });
      }

      const extracted = await extractDocumentContent({
        buffer: fileBuffer,
        fileName,
        mimeType,
        maxSizeMb: maxFileSizeMb,
      });

      if (!extracted.ok) {
        throw new AIProviderError({
          code: 'UNSUPPORTED_MEDIA',
          message: extracted.error,
          userMessageFa: extracted.error,
        });
      }

      const { result, usedFallback, providerId } = await analyzeDocumentWithRoute(route, {
        fileName: extracted.data.fileName,
        mimeType: extracted.data.mimeType,
        extractedText: extracted.data.textContent,
        imageBase64: extracted.data.imageBase64,
        userPrompt,
      });

      if (api && job.telegramChatId) {
        await sendFormattedTelegramResponse({
          api,
          chatId: job.telegramChatId,
          text: result.text,
          editMessageId: job.statusMessageId,
          replyMarkup: buildConversationActionKeyboard(reqRow.id) as unknown as Record<string, unknown>,
        });
      }

      await reconcileRequestSuccess({
        requestId: reqRow.id,
        jobId: job.id,
        providerId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        latencyMs: Date.now() - startedAt,
        responsePreview: result.text,
        usedFallback,
        resultMetadata: { fileName: extracted.data.fileName, kind: extracted.data.kind },
      });

      return { ok: true, status: 'succeeded', responseText: result.text };
    }

    // =========================================================================
    // 7. ASYNC VIDEO GENERATION (START + ENQUEUE POLL)
    // =========================================================================
    if (job.capability === 'video_generation') {
      const prompt = String(payload.prompt ?? '').trim();
      const durationSeconds = Number(payload.durationSeconds ?? 5);
      const aspectRatio = typeof payload.aspectRatio === 'string' ? payload.aspectRatio : '16:9';
      const quality = typeof payload.quality === 'string' ? payload.quality : '720p';

      let sourceImageBase64 =
        typeof payload.sourceImageBase64 === 'string' ? payload.sourceImageBase64 : undefined;
      const sourceImageMimeType =
        typeof payload.sourceImageMimeType === 'string' ? payload.sourceImageMimeType : 'image/jpeg';

      if (!sourceImageBase64 && typeof payload.sourceFileId === 'string' && tgClient) {
        const dl = await downloadTelegramFile({
          api: tgClient.api,
          botToken: tgClient.botToken,
          fileId: payload.sourceFileId,
          maxSizeMb: maxFileSizeMb,
        });
        sourceImageBase64 = dl.buffer.toString('base64');
      }

      const { result, usedFallback, providerId } = await startVideoGenerationWithRoute(route, {
        prompt,
        sourceImageBase64,
        sourceImageMimeType,
        durationSeconds,
        aspectRatio,
        quality,
      });

      if (result.status === 'succeeded' && result.videoBuffer) {
        const storage = getStorageAdapter();
        const stored = await storage.putObject({
          buffer: result.videoBuffer,
          mimeType: result.mimeType ?? 'video/mp4',
          extension: 'mp4',
          prefix: 'generated-videos',
          userId: job.userId,
          requestId: reqRow.id,
          jobId: job.id,
        });

        if (api && job.telegramChatId) {
          await api.sendVideo(
            job.telegramChatId,
            new InputFile(result.videoBuffer, 'hooshnegar-video.mp4'),
            { caption: `🎬 ویدیو با مدل ${route.primary.modelName} آماده شد.` },
          );
          if (job.statusMessageId) {
            try {
              await api.deleteMessage(job.telegramChatId, job.statusMessageId);
            } catch {
              // ignore
            }
          }
        }

        await reconcileRequestSuccess({
          requestId: reqRow.id,
          jobId: job.id,
          providerId,
          costUsd: result.costUsd ?? 0.15,
          latencyMs: Date.now() - startedAt,
          responsePreview: 'ویدیو با موفقیت تولید و ارسال شد.',
          usedFallback,
          storageObjectKey: stored.objectKey,
        });
        return { ok: true, status: 'succeeded', storageObjectKey: stored.objectKey };
      }

      // Async video job started: store providerJobId & enqueue polling job
      await db
        .update(generationJobs)
        .set({
          providerJobId: result.providerJobId,
          progressPercent: Math.max(25, result.progressPercent),
          resultMetadata: { ...(result.metadata ?? {}), pollCount: 0, providerId },
          updatedAt: new Date(),
        })
        .where(eq(generationJobs.id, job.id));

      if (api && job.telegramChatId && job.statusMessageId) {
        try {
          await api.editMessageText(
            job.telegramChatId,
            job.statusMessageId,
            `🎬 درخواست ساخت ویدیو در صف پردازش قرار گرفت (${Math.max(25, result.progressPercent)}٪)...\nلطفاً صبر کنید، پس از آماده شدن به‌صورت خودکار ارسال می‌شود.`,
          );
        } catch {
          // ignore
        }
      }

      await enqueueBackgroundJob(
        {
          kind: 'video_poll_job',
          idempotencyKey: `vidpoll:${job.id}:1`,
          jobId: job.id,
          requestId: reqRow.id,
        },
        { delaySeconds: 8, retries: 3 },
      );

      return { ok: true, status: 'running' };
    }

    throw new AIProviderError({
      code: 'UNSUPPORTED_CAPABILITY',
      message: `Unhandled capability ${job.capability}`,
      userMessageFa: 'قابلیت درخواستی پشتیبانی نمی‌شود.',
    });
  } catch (err) {
    const aiErr =
      err instanceof AIProviderError
        ? err
        : new AIProviderError({
            code: 'PROVIDER_ERROR',
            message: redactSecrets(err instanceof Error ? err.message : 'Unexpected job error'),
            userMessageFa: 'خطایی در اجرای درخواست هوش مصنوعی رخ داد.',
          });

    await refundFailedRequest({
      requestId: reqRow.id,
      jobId: job.id,
      errorCode: aiErr.code,
      errorMessage: aiErr.message,
      canceled: aiErr.code === 'CANCELED',
      latencyMs: Date.now() - startedAt,
    });

    await sendSafeErrorToChat(api, job.telegramChatId, job.statusMessageId, aiErr.userMessageFa);
    return { ok: false, status: 'failed', error: aiErr.message };
  }
}

export async function executeVideoPollJob(jobId: string): Promise<{
  ok: boolean;
  status: string;
  storageObjectKey?: string | null;
}> {
  const db = getDb();
  const [job] = await db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.id, jobId))
    .limit(1);

  if (!job || !job.providerJobId || job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled') {
    return { ok: false, status: job?.status ?? 'not_found' };
  }

  const [reqRow] = await db
    .select()
    .from(aiRequests)
    .where(eq(aiRequests.id, job.requestId))
    .limit(1);

  if (!reqRow || !reqRow.modelId) {
    return { ok: false, status: 'failed' };
  }

  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const silentDelivery = payload.silentDelivery === true;
  const tgClient = !silentDelivery && job.telegramChatId ? await getConfiguredTelegramApi() : null;
  const api = tgClient?.api ?? null;

  try {
    const route = await loadModelExecutionRoute(reqRow.modelId);
    const meta = (job.resultMetadata ?? {}) as Record<string, unknown>;
    const pollCount = Number(meta.pollCount ?? 0) + 1;

    const pollRes = await pollVideoGenerationJob(route.primary, job.providerJobId, meta);

    if (pollRes.status === 'succeeded') {
      let videoBuffer = pollRes.videoBuffer;
      if (!videoBuffer && pollRes.videoUrl) {
        const dlRes = await fetch(pollRes.videoUrl);
        if (!dlRes.ok) throw new Error(`Video download failed HTTP ${dlRes.status}`);
        videoBuffer = Buffer.from(await dlRes.arrayBuffer());
      }
      if (!videoBuffer) {
        throw new Error('Completed video job returned no media buffer');
      }

      const storage = getStorageAdapter();
      const stored = await storage.putObject({
        buffer: videoBuffer,
        mimeType: pollRes.mimeType ?? 'video/mp4',
        extension: 'mp4',
        prefix: 'generated-videos',
        userId: job.userId,
        requestId: reqRow.id,
        jobId: job.id,
      });

      if (api && job.telegramChatId) {
        await api.sendVideo(
          job.telegramChatId,
          new InputFile(videoBuffer, 'hooshnegar-video.mp4'),
          { caption: `🎬 ویدیوی شما با مدل ${route.primary.modelName} آماده شد.` },
        );
        if (job.statusMessageId) {
          try {
            await api.deleteMessage(job.telegramChatId, job.statusMessageId);
          } catch {
            // ignore
          }
        }
      }

      const latencyMs = job.startedAt ? Date.now() - job.startedAt.getTime() : 0;
      await reconcileRequestSuccess({
        requestId: reqRow.id,
        jobId: job.id,
        providerId: route.primary.providerId,
        costUsd: pollRes.costUsd ?? 0.2,
        latencyMs,
        responsePreview: 'ویدیو با موفقیت تولید شد.',
        storageObjectKey: stored.objectKey,
      });

      return { ok: true, status: 'succeeded', storageObjectKey: stored.objectKey };
    }

    if (pollRes.status === 'failed' || pollCount >= 24) {
      const reason =
        pollRes.errorMessage ?? 'زمان پردازش ویدیو به پایان رسید (Timeout).';
      await refundFailedRequest({
        requestId: reqRow.id,
        jobId: job.id,
        errorCode: 'VIDEO_FAILED',
        errorMessage: reason,
      });
      await sendSafeErrorToChat(api, job.telegramChatId, job.statusMessageId, reason);
      return { ok: false, status: 'failed' };
    }

    // Still running -> update progress & enqueue next poll
    const nextProgress = Math.min(95, Math.max(job.progressPercent + 10, pollRes.progressPercent));
    await db
      .update(generationJobs)
      .set({
        progressPercent: nextProgress,
        resultMetadata: { ...meta, pollCount },
        updatedAt: new Date(),
      })
      .where(eq(generationJobs.id, job.id));

    if (api && job.telegramChatId && job.statusMessageId) {
      try {
        await api.editMessageText(
          job.telegramChatId,
          job.statusMessageId,
          `🎬 در حال رندر ویدیو (${nextProgress}٪)...\nلطفاً چند لحظه دیگر صبر کنید.`,
        );
      } catch {
        // ignore unchanged text
      }
    }

    await enqueueBackgroundJob(
      {
        kind: 'video_poll_job',
        idempotencyKey: `vidpoll:${job.id}:${pollCount + 1}`,
        jobId: job.id,
        requestId: reqRow.id,
      },
      { delaySeconds: 10, retries: 3 },
    );

    return { ok: true, status: 'running' };
  } catch (err) {
    const msg = redactSecrets(err instanceof Error ? err.message : 'Video polling failed');
    await refundFailedRequest({
      requestId: reqRow.id,
      jobId: job.id,
      errorCode: 'VIDEO_POLL_ERROR',
      errorMessage: msg,
    });
    await sendSafeErrorToChat(
      api,
      job.telegramChatId,
      job.statusMessageId,
      'خطا در بررسی وضعیت تولید ویدیو. اعتبار شما بازگردانده شد.',
    );
    return { ok: false, status: 'failed' };
  }
}

export async function cancelActiveJobsForUser(userId: string): Promise<number> {
  const db = getDb();
  const active = await db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.userId, userId));

  let canceledCount = 0;
  for (const j of active) {
    if (j.status === 'queued' || j.status === 'running') {
      await refundFailedRequest({
        requestId: j.requestId,
        jobId: j.id,
        errorCode: 'CANCELED',
        errorMessage: 'Canceled by user via Telegram',
        canceled: true,
      });
      canceledCount += 1;
    }
  }

  await db
    .update(telegramAccounts)
    .set({ updatedAt: new Date() })
    .where(eq(telegramAccounts.userId, userId));

  return canceledCount;
}
