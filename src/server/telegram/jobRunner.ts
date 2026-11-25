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
  generateSpeechWithRoute,
  generateTextWithRoute,
  loadModelExecutionRoute,
  pollMediaGenerationJob,
  pollVideoGenerationJob,
  startImageEditWithRoute,
  startImageGenerationWithRoute,
  startVideoGenerationWithRoute,
  transcribeAudioWithRoute,
  type ImageJobOutcome,
} from '../providers/engine.ts';
import { AIProviderError, type ChatMessage } from '../providers/types.ts';
import { reconcileRequestSuccess, refundFailedRequest } from '../services/usageService.ts';
import { extractDocumentContent, validateAudioFile } from '../services/documentService.ts';
import { getStorageAdapter } from '../storage/storageAdapter.ts';
import { enqueueBackgroundJob, hasDurableAsyncQueue } from '../queue/qstash.ts';
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
  const fullText = `❌ ${messageFa}\n\n💡 اعتبار رزروشده به‌صورت خودکار به کیف‌پول شما بازگردانده شد.`;
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

async function deliverImageToTelegram(params: {
  api: Api;
  chatId: number;
  buffer: Buffer;
  fileName: string;
  caption: string;
}): Promise<void> {
  if (!params.buffer || params.buffer.byteLength === 0) {
    throw new AIProviderError({
      code: 'PROVIDER_ERROR',
      message: 'Generated image buffer is empty.',
      userMessageFa: 'فایل تصویر تولیدشده خالی بود. لطفاً دوباره تلاش کنید.',
    });
  }
  const safeCaption = params.caption.slice(0, 1000);
  const inputFile = new InputFile(new Uint8Array(params.buffer), params.fileName);
  try {
    await params.api.sendPhoto(params.chatId, inputFile, { caption: safeCaption });
  } catch (photoErr) {
    const errMsg = photoErr instanceof Error ? photoErr.message : String(photoErr ?? '');
    const shouldFallbackToDocument =
      /PHOTO_INVALID_DIMENSIONS|IMAGE_PROCESS_FAILED|PHOTO_EXT_INVALID|FILE_PARTS|wrong type of the web page content|Bad Request/i.test(
        errMsg,
      );
    if (!shouldFallbackToDocument) {
      throw photoErr;
    }
    await params.api.sendDocument(
      params.chatId,
      new InputFile(new Uint8Array(params.buffer), params.fileName),
      { caption: safeCaption },
    );
  }
}

export async function executeQueuedGenerationJob(
  jobId: string,
  options?: { maxSyncWaitMs?: number },
): Promise<{
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

      let outcome: ImageJobOutcome;

      if (job.capability === 'image_generation') {
        outcome = await startImageGenerationWithRoute(
          route,
          {
            prompt,
            aspectRatio,
            resolution,
            count: countNum,
          },
          { syncWaitCapMs: options?.maxSyncWaitMs },
        );
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

        outcome = await startImageEditWithRoute(
          route,
          {
            prompt,
            sourceImageBuffer: sourceBuffer,
            sourceMimeType,
            mode: job.capability === 'image_variation' ? 'variation' : 'edit',
            aspectRatio,
            resolution,
          },
          { syncWaitCapMs: options?.maxSyncWaitMs },
        );
      }

      if (outcome.kind === 'pending') {
        const nextProgress = Math.max(25, outcome.progressPercent);
        await db
          .update(generationJobs)
          .set({
            providerJobId: outcome.providerJobId,
            progressPercent: nextProgress,
            resultMetadata: {
              ...outcome.metadata,
              pollCount: 0,
              providerId: outcome.providerId,
              usedFallback: outcome.usedFallback,
              aspectRatio,
              lastPolledAtMs: Date.now(),
            },
            updatedAt: new Date(),
          })
          .where(eq(generationJobs.id, job.id));

        if (api && job.telegramChatId && job.statusMessageId) {
          const verb = job.capability === 'image_generation' ? 'ساخت تصویر' : 'ویرایش تصویر';
          try {
            await api.editMessageText(
              job.telegramChatId,
              job.statusMessageId,
              `🎨 درخواست ${verb} در صف پردازش قرار گرفت (${nextProgress}٪)...\nپس از آماده شدن به‌صورت خودکار ارسال می‌شود.`,
            );
          } catch {
            // ignore
          }
        }

        if (hasDurableAsyncQueue() || !silentDelivery) {
          const isHfGradio = outcome.metadata?.kind === 'hf_space_gradio_media';
          await enqueueBackgroundJob(
            {
              kind: 'media_poll_job',
              idempotencyKey: `mediapoll:${job.id}:1`,
              jobId: job.id,
              requestId: reqRow.id,
            },
            {
              delaySeconds: isHfGradio ? (hasDurableAsyncQueue() ? 14 : 6) : hasDurableAsyncQueue() ? 5 : 2,
              retries: 3,
            },
          );
        }

        return { ok: true, status: 'running' };
      }

      const storage = getStorageAdapter();
      let firstKey: string | null = null;
      const storedKeys: string[] = [];

      for (let i = 0; i < outcome.result.images.length; i++) {
        const img = outcome.result.images[i]!;
        const canDeliverToTelegram = Boolean(api && job.telegramChatId);

        try {
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
        } catch (storageErr) {
          if (!canDeliverToTelegram) {
            throw storageErr;
          }
          console.error(
            '[jobRunner] non-fatal image storage error before Telegram delivery:',
            storageErr instanceof Error ? storageErr.message : 'unknown',
          );
        }

        if (api && job.telegramChatId) {
          const caption = `🎨 تصویر تولیدشده با مدل ${route.primary.modelName}\nنسبت تصویر: ${aspectRatio}`;
          await deliverImageToTelegram({
            api,
            chatId: job.telegramChatId,
            buffer: img.buffer,
            fileName: `hooshnegar-${i + 1}.${img.extension}`,
            caption,
          });
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
        providerId: outcome.providerId,
        costUsd: outcome.result.costUsd,
        latencyMs: Date.now() - startedAt,
        responsePreview: `تولید ${outcome.result.images.length} تصویر با موفقیت انجام شد.`,
        usedFallback: outcome.usedFallback,
        storageObjectKey: firstKey,
        resultMetadata: { imageCount: outcome.result.images.length, objectKeys: storedKeys },
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
          new InputFile(new Uint8Array(result.audioBuffer), `speech.${result.extension}`),
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
        typeof payload.sourceImageMimeType === 'string'
          ? payload.sourceImageMimeType
          : typeof payload.sourceMimeType === 'string'
            ? payload.sourceMimeType
            : 'image/jpeg';

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
            new InputFile(new Uint8Array(result.videoBuffer), 'hooshnegar-video.mp4'),
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
          resultMetadata: {
            ...(result.metadata ?? {}),
            pollCount: 0,
            providerId,
            usedFallback,
            lastPolledAtMs: Date.now(),
          },
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

      if (hasDurableAsyncQueue() || !silentDelivery) {
        const isHfVideo = result.metadata?.kind === 'hf_space_gradio';
        await enqueueBackgroundJob(
          {
            kind: 'video_poll_job',
            idempotencyKey: `vidpoll:${job.id}:1`,
            jobId: job.id,
            requestId: reqRow.id,
          },
          { delaySeconds: isHfVideo && hasDurableAsyncQueue() ? 18 : 8, retries: 3 },
        );
      }

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

    await sendSafeErrorToChat(
      api,
      job.telegramChatId,
      job.statusMessageId,
      aiErr.userMessageFa,
    );
    return {
      ok: false,
      status: 'failed',
      error: aiErr.userMessageFa,
    };
  }
}

export async function executeMediaPollJob(
  jobId: string,
  options?: { maxWaitMs?: number; scheduleNextPoll?: boolean },
): Promise<{
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

  if (
    !job ||
    !job.providerJobId ||
    job.status === 'succeeded' ||
    job.status === 'failed' ||
    job.status === 'canceled'
  ) {
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

    const targetCredentialId = typeof meta.credentialId === 'string' ? meta.credentialId : null;
    const basePoolCtx =
      route.fallback && meta.providerId === route.fallback.providerId
        ? route.fallback
        : route.primary;
    const pollCtx =
      (targetCredentialId &&
        basePoolCtx.credentialPool?.find((c) => c.credentialId === targetCredentialId)) ||
      basePoolCtx;

    const pollRes = await pollMediaGenerationJob(pollCtx, job.providerJobId, meta, {
      maxWaitMs: options?.maxWaitMs,
    });

    if (pollRes.status === 'succeeded' && pollRes.images && pollRes.images.length > 0) {
      const storage = getStorageAdapter();
      let firstKey: string | null = null;
      const storedKeys: string[] = [];
      const aspectRatio =
        typeof meta.aspectRatio === 'string'
          ? meta.aspectRatio
          : typeof payload.aspectRatio === 'string'
            ? payload.aspectRatio
            : '1:1';

      for (let i = 0; i < pollRes.images.length; i++) {
        const img = pollRes.images[i]!;
        const canDeliverToTelegram = Boolean(api && job.telegramChatId);
        try {
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
        } catch (storageErr) {
          if (!canDeliverToTelegram) throw storageErr;
        }

        if (api && job.telegramChatId) {
          await deliverImageToTelegram({
            api,
            chatId: job.telegramChatId,
            buffer: img.buffer,
            fileName: `hooshnegar-${i + 1}.${img.extension}`,
            caption: `🎨 تصویر تولیدشده با مدل ${route.primary.modelName}\nنسبت تصویر: ${aspectRatio}`,
          });
        }
      }

      if (api && job.telegramChatId && job.statusMessageId) {
        try {
          await api.deleteMessage(job.telegramChatId, job.statusMessageId);
        } catch {
          // ignore
        }
      }

      const latencyMs = job.startedAt ? Date.now() - job.startedAt.getTime() : 0;
      await reconcileRequestSuccess({
        requestId: reqRow.id,
        jobId: job.id,
        providerId: pollCtx.providerId,
        costUsd: pollRes.costUsd ?? 0,
        latencyMs,
        responsePreview: `تولید ${pollRes.images.length} تصویر با موفقیت انجام شد.`,
        usedFallback: meta.usedFallback === true,
        storageObjectKey: firstKey,
        resultMetadata: { imageCount: pollRes.images.length, objectKeys: storedKeys },
      });

      return { ok: true, status: 'succeeded', storageObjectKey: firstKey };
    }

    if (
      pollRes.status === 'failed' &&
      pollRes.sessionExpired &&
      Number(meta.hfResubmitCount ?? 0) < 1 &&
      ((typeof payload.prompt === 'string' && payload.prompt.trim().length > 0) ||
        job.capability === 'image_variation')
    ) {
      const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
      const aspectRatio = typeof payload.aspectRatio === 'string' ? payload.aspectRatio : '1:1';
      const resolution = typeof payload.resolution === 'string' ? payload.resolution : '1K';
      const countNum = Number(payload.count ?? 1);
      try {
        let retryOutcome: ImageJobOutcome | null = null;
        if (job.capability === 'image_generation') {
          retryOutcome = await startImageGenerationWithRoute(
            route,
            { prompt, aspectRatio, resolution, count: countNum },
            { syncWaitCapMs: 5_000 },
          );
        } else if (job.capability === 'image_editing' || job.capability === 'image_variation') {
          let sourceBuffer: Buffer | null = null;
          if (typeof payload.sourceImageBase64 === 'string' && payload.sourceImageBase64.length > 0) {
            sourceBuffer = Buffer.from(payload.sourceImageBase64, 'base64');
          } else if (typeof payload.sourceFileId === 'string' && tgClient) {
            const activePlanForLimit = await getUserActivePlan(job.userId);
            const maxFileSizeMb = Number(
              payload.maxFileSizeMb ?? activePlanForLimit?.plan.maxFileSizeMb ?? 10,
            );
            const dl = await downloadTelegramFile({
              api: tgClient.api,
              botToken: tgClient.botToken,
              fileId: payload.sourceFileId,
              maxSizeMb: maxFileSizeMb,
            });
            sourceBuffer = dl.buffer;
          }

          if (sourceBuffer) {
            retryOutcome = await startImageEditWithRoute(
              route,
              {
                prompt,
                sourceImageBuffer: sourceBuffer,
                sourceMimeType:
                  typeof payload.sourceMimeType === 'string' ? payload.sourceMimeType : 'image/jpeg',
                mode: job.capability === 'image_variation' ? 'variation' : 'edit',
                aspectRatio,
                resolution,
              },
              { syncWaitCapMs: 5_000 },
            );
          }
        }

        if (retryOutcome?.kind === 'complete') {
          const storage = getStorageAdapter();
          let firstKey: string | null = null;
          const storedKeys: string[] = [];
          for (let i = 0; i < retryOutcome.result.images.length; i++) {
            const img = retryOutcome.result.images[i]!;
            const canDeliverToTelegram = Boolean(api && job.telegramChatId);
            try {
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
            } catch (storageErr) {
              if (!canDeliverToTelegram) throw storageErr;
            }
            if (api && job.telegramChatId) {
              await deliverImageToTelegram({
                api,
                chatId: job.telegramChatId,
                buffer: img.buffer,
                fileName: `hooshnegar-${i + 1}.${img.extension}`,
                caption: `🎨 تصویر ویرایش‌شده با مدل ${route.primary.modelName}\nنسبت تصویر: ${aspectRatio}`,
              });
            }
          }
          if (api && job.telegramChatId && job.statusMessageId) {
            try {
              await api.deleteMessage(job.telegramChatId, job.statusMessageId);
            } catch {
              // ignore
            }
          }
          const latencyMs = job.startedAt ? Date.now() - job.startedAt.getTime() : 0;
          await reconcileRequestSuccess({
            requestId: reqRow.id,
            jobId: job.id,
            providerId: retryOutcome.providerId,
            costUsd: retryOutcome.result.costUsd ?? 0,
            latencyMs,
            responsePreview: `تولید ${retryOutcome.result.images.length} تصویر با موفقیت انجام شد.`,
            usedFallback: retryOutcome.usedFallback,
            storageObjectKey: firstKey,
            resultMetadata: { imageCount: retryOutcome.result.images.length, objectKeys: storedKeys },
          });
          return { ok: true, status: 'succeeded', storageObjectKey: firstKey };
        }

        if (retryOutcome?.kind === 'pending') {
          await db
            .update(generationJobs)
            .set({
              providerJobId: retryOutcome.providerJobId,
              progressPercent: Math.max(25, job.progressPercent),
              resultMetadata: {
                ...retryOutcome.metadata,
                pollCount,
                hfResubmitCount: Number(meta.hfResubmitCount ?? 0) + 1,
                providerId: retryOutcome.providerId,
                usedFallback: retryOutcome.usedFallback,
                aspectRatio,
                lastPolledAtMs: Date.now(),
              },
              updatedAt: new Date(),
            })
            .where(eq(generationJobs.id, job.id));

          const shouldScheduleRetry =
            options?.scheduleNextPoll !== undefined
              ? options.scheduleNextPoll
              : hasDurableAsyncQueue() || !silentDelivery;
          if (shouldScheduleRetry) {
            await enqueueBackgroundJob(
              {
                kind: 'media_poll_job',
                idempotencyKey: `mediapoll:${job.id}:resubmit:${pollCount + 1}`,
                jobId: job.id,
                requestId: reqRow.id,
              },
              { delaySeconds: hasDurableAsyncQueue() ? 14 : 6, retries: 3 },
            );
          }
          return { ok: true, status: 'running' };
        }
      } catch {
        // Fall through to standard failed-refund handling
      }
    }

    if (pollRes.status === 'failed' || pollCount >= 20) {
      const reason =
        pollRes.errorMessage ?? 'زمان پردازش تصویر در سرور مدل به پایان رسید (Timeout).';
      await refundFailedRequest({
        requestId: reqRow.id,
        jobId: job.id,
        errorCode: 'IMAGE_POLL_FAILED',
        errorMessage: reason,
      });
      await sendSafeErrorToChat(
        api,
        job.telegramChatId,
        job.statusMessageId,
        'در حال حاضر امکان تکمیل تصویر با این مدل وجود نداشت. لطفاً دوباره تلاش کنید یا مدل دیگری انتخاب نمایید.',
      );
      return { ok: false, status: 'failed' };
    }

    const nextProgress = Math.min(95, Math.max(job.progressPercent + 12, pollRes.progressPercent));
    await db
      .update(generationJobs)
      .set({
        status: 'running',
        progressPercent: nextProgress,
        resultMetadata: {
          ...meta,
          pollCount,
          pollLockUntilMs: 0,
          lastPolledAtMs: Date.now(),
        },
        updatedAt: new Date(),
      })
      .where(eq(generationJobs.id, job.id));

    if (api && job.telegramChatId && job.statusMessageId) {
      try {
        await api.editMessageText(
          job.telegramChatId,
          job.statusMessageId,
          `🎨 در حال پردازش تصویر (${nextProgress}٪)...\nلطفاً لحظاتی دیگر صبر کنید.`,
        );
      } catch {
        // ignore
      }
    }

    const shouldSchedule =
      options?.scheduleNextPoll !== undefined
        ? options.scheduleNextPoll
        : hasDurableAsyncQueue() || !silentDelivery;

    if (shouldSchedule) {
      const isHfGradio = meta.kind === 'hf_space_gradio_media';
      await enqueueBackgroundJob(
        {
          kind: 'media_poll_job',
          idempotencyKey: `mediapoll:${job.id}:${pollCount + 1}`,
          jobId: job.id,
          requestId: reqRow.id,
        },
        { delaySeconds: isHfGradio ? 12 : hasDurableAsyncQueue() ? 6 : 2, retries: 3 },
      );
    }

    return { ok: true, status: 'running' };
  } catch (err) {
    const msg = redactSecrets(err instanceof Error ? err.message : 'Media polling failed');
    await refundFailedRequest({
      requestId: reqRow.id,
      jobId: job.id,
      errorCode: 'MEDIA_POLL_ERROR',
      errorMessage: msg,
    });
    await sendSafeErrorToChat(
      api,
      job.telegramChatId,
      job.statusMessageId,
      'خطا در بررسی وضعیت تولید تصویر. اعتبار شما بازگردانده شد.',
    );
    return { ok: false, status: 'failed' };
  }
}

export async function executeVideoPollJob(
  jobId: string,
  options?: { maxWaitMs?: number; scheduleNextPoll?: boolean },
): Promise<{
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

    const targetCredentialId = typeof meta.credentialId === 'string' ? meta.credentialId : null;
    const basePoolCtx =
      route.fallback && meta.providerId === route.fallback.providerId
        ? route.fallback
        : route.primary;
    const pollCtx =
      (targetCredentialId &&
        basePoolCtx.credentialPool?.find((c) => c.credentialId === targetCredentialId)) ||
      basePoolCtx;

    const pollRes = await pollVideoGenerationJob(pollCtx, job.providerJobId, meta, {
      maxWaitMs: options?.maxWaitMs,
    });

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
          new InputFile(new Uint8Array(videoBuffer), 'hooshnegar-video.mp4'),
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
        providerId: pollCtx.providerId,
        costUsd: pollRes.costUsd ?? 0.2,
        latencyMs,
        responsePreview: 'ویدیو با موفقیت تولید شد.',
        usedFallback: meta.usedFallback === true,
        storageObjectKey: stored.objectKey,
      });

      return { ok: true, status: 'succeeded', storageObjectKey: stored.objectKey };
    }

    if (
      pollRes.status === 'failed' &&
      pollRes.sessionExpired &&
      Number(meta.hfResubmitCount ?? 0) < 1 &&
      typeof payload.prompt === 'string' &&
      payload.prompt.trim().length > 0
    ) {
      try {
        let sourceImageBase64 =
          typeof payload.sourceImageBase64 === 'string' ? payload.sourceImageBase64 : undefined;
        const sourceImageMimeType =
          typeof payload.sourceImageMimeType === 'string'
            ? payload.sourceImageMimeType
            : typeof payload.sourceMimeType === 'string'
              ? payload.sourceMimeType
              : 'image/jpeg';

        if (!sourceImageBase64 && typeof payload.sourceFileId === 'string' && tgClient) {
          const activePlanForLimit = await getUserActivePlan(job.userId);
          const maxFileSizeMb = Number(
            payload.maxFileSizeMb ?? activePlanForLimit?.plan.maxFileSizeMb ?? 10,
          );
          const dl = await downloadTelegramFile({
            api: tgClient.api,
            botToken: tgClient.botToken,
            fileId: payload.sourceFileId,
            maxSizeMb: maxFileSizeMb,
          });
          sourceImageBase64 = dl.buffer.toString('base64');
        }

        const retryStart = await startVideoGenerationWithRoute(
          route,
          {
            prompt: payload.prompt.trim(),
            sourceImageBase64,
            sourceImageMimeType,
            durationSeconds: Number(payload.durationSeconds ?? 5),
            aspectRatio: typeof payload.aspectRatio === 'string' ? payload.aspectRatio : '16:9',
            quality: typeof payload.quality === 'string' ? payload.quality : '720p',
          },
          { syncWaitCapMs: 5_000 },
        );

        if (retryStart.result.status === 'succeeded' && retryStart.result.videoBuffer) {
          const storage = getStorageAdapter();
          const stored = await storage.putObject({
            buffer: retryStart.result.videoBuffer,
            mimeType: retryStart.result.mimeType ?? 'video/mp4',
            extension: 'mp4',
            prefix: 'generated-videos',
            userId: job.userId,
            requestId: reqRow.id,
            jobId: job.id,
          });

          if (api && job.telegramChatId) {
            await api.sendVideo(
              job.telegramChatId,
              new InputFile(new Uint8Array(retryStart.result.videoBuffer), 'hooshnegar-video.mp4'),
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
            providerId: retryStart.providerId,
            costUsd: retryStart.result.costUsd ?? 0.2,
            latencyMs,
            responsePreview: 'ویدیو با موفقیت تولید شد.',
            usedFallback: retryStart.usedFallback,
            storageObjectKey: stored.objectKey,
          });

          return { ok: true, status: 'succeeded', storageObjectKey: stored.objectKey };
        }

        if (retryStart.result.providerJobId) {
          await db
            .update(generationJobs)
            .set({
              providerJobId: retryStart.result.providerJobId,
              status: 'running',
              progressPercent: Math.max(25, retryStart.result.progressPercent),
              resultMetadata: {
                ...meta,
                ...(retryStart.result.metadata ?? {}),
                providerId: retryStart.providerId,
                usedFallback: retryStart.usedFallback,
                pollCount,
                hfResubmitCount: Number(meta.hfResubmitCount ?? 0) + 1,
                lastPolledAtMs: Date.now(),
              },
              updatedAt: new Date(),
            })
            .where(eq(generationJobs.id, job.id));

          const shouldScheduleRetry =
            options?.scheduleNextPoll !== undefined
              ? options.scheduleNextPoll
              : hasDurableAsyncQueue() || !silentDelivery;

          if (shouldScheduleRetry) {
            await enqueueBackgroundJob(
              {
                kind: 'video_poll_job',
                idempotencyKey: `vidpoll:${job.id}:${pollCount + 1}`,
                jobId: job.id,
                requestId: reqRow.id,
              },
              { delaySeconds: 18, retries: 3 },
            );
          }

          return { ok: true, status: 'running' };
        }
      } catch {
        // Fall through to failure handler
      }
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
        status: 'running',
        progressPercent: nextProgress,
        resultMetadata: { ...meta, pollCount, lastPolledAtMs: Date.now() },
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

    const shouldSchedule =
      options?.scheduleNextPoll !== undefined
        ? options.scheduleNextPoll
        : hasDurableAsyncQueue() || !silentDelivery;

    if (shouldSchedule) {
      await enqueueBackgroundJob(
        {
          kind: 'video_poll_job',
          idempotencyKey: `vidpoll:${job.id}:${pollCount + 1}`,
          jobId: job.id,
          requestId: reqRow.id,
        },
        { delaySeconds: 10, retries: 3 },
      );
    }

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
