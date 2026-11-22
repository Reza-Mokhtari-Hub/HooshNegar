import type {
  AudioTranscriptionInput,
  AudioTranscriptionOutput,
  DocumentAnalysisInput,
  ImageEditInput,
  ImageGenerationInput,
  ImageOutput,
  ProviderExecutionContext,
  SpeechGenerationInput,
  SpeechGenerationOutput,
  TextGenerationInput,
  TextGenerationOutput,
  VideoGenerationInput,
  VideoJobPollOutput,
  VideoJobStartOutput,
  VisionAnalysisInput,
} from './types.ts';
import { estimateTokenCostUsd, estimateTokensRough } from './types.ts';

// Valid 1x1 PNG image for deterministic dev/test mode
const VALID_PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Minimal valid PCM WAV buffer (0.2s silence, 16kHz mono 16-bit)
function createMinimalWavBuffer(): Buffer {
  const sampleRate = 16000;
  const numSamples = 3200;
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

// Minimal MP4 ftyp box for dev/test verification
function createMinimalMp4Buffer(): Buffer {
  return Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  ]);
}

const mockVideoPolls = new Map<string, number>();

export async function runMockTextGeneration(
  ctx: ProviderExecutionContext,
  input: TextGenerationInput,
): Promise<TextGenerationOutput> {
  const lastUser = [...input.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const responseText = `پاسخ آزمایشی (${ctx.modelName} · حالت توسعه Mock):\n\nدرخواست شما دریافت شد: «${lastUser.slice(0, 180)}»\n\nاین خروجی توسط آداپتور توسعه (AI_MOCK_MODE) تولید شده است و در محیط تولید غیرفعال است.`;

  if (input.onChunk) {
    const mid = Math.floor(responseText.length / 2);
    await input.onChunk(responseText.slice(0, mid));
    await input.onChunk(responseText);
  }

  const inputTokens = estimateTokensRough(input.messages.map((m) => m.content).join('\n'));
  const outputTokens = estimateTokensRough(responseText);
  return {
    text: responseText,
    inputTokens,
    outputTokens,
    costUsd: estimateTokenCostUsd(
      inputTokens,
      outputTokens,
      ctx.inputPricePerMillion,
      ctx.outputPricePerMillion,
    ),
    finishReason: 'stop',
  };
}

export async function runMockVisionAnalysis(
  ctx: ProviderExecutionContext,
  input: VisionAnalysisInput,
): Promise<TextGenerationOutput> {
  const text = `تحلیل تصویر آزمایشی (${ctx.modelName}): تصویر با فرمت ${input.mimeType} بررسی شد. پرسش شما: «${input.prompt.slice(0, 140)}».`;
  return {
    text,
    inputTokens: 256,
    outputTokens: estimateTokensRough(text),
    costUsd: 0.0005,
    finishReason: 'stop',
  };
}

export async function runMockImageGeneration(
  _ctx: ProviderExecutionContext,
  input: ImageGenerationInput,
): Promise<ImageOutput> {
  const count = Math.min(Math.max(input.count ?? 1, 1), 4);
  const png = Buffer.from(VALID_PNG_1X1_BASE64, 'base64');
  return {
    images: Array.from({ length: count }, () => ({
      buffer: png,
      mimeType: 'image/png',
      extension: 'png',
      revisedPrompt: `${input.prompt} [${input.aspectRatio ?? '1:1'} · ${input.resolution ?? '1024x1024'}]`,
    })),
    costUsd: 0.02 * count,
  };
}

export async function runMockImageEdit(
  _ctx: ProviderExecutionContext,
  input: ImageEditInput,
): Promise<ImageOutput> {
  const png = Buffer.from(VALID_PNG_1X1_BASE64, 'base64');
  return {
    images: [
      {
        buffer: png,
        mimeType: 'image/png',
        extension: 'png',
        revisedPrompt: `${input.mode === 'variation' ? 'Variation' : 'Edited'}: ${input.prompt}`,
      },
    ],
    costUsd: 0.025,
  };
}

export async function runMockAudioTranscription(
  ctx: ProviderExecutionContext,
  input: AudioTranscriptionInput,
): Promise<AudioTranscriptionOutput> {
  return {
    text: `متن استخراج‌شده آزمایشی (${ctx.modelName}) از فایل ${input.fileName} (${input.mimeType}).`,
    language: input.language ?? 'fa',
    costUsd: 0.002,
  };
}

export async function runMockSpeechGeneration(
  _ctx: ProviderExecutionContext,
  _input: SpeechGenerationInput,
): Promise<SpeechGenerationOutput> {
  return {
    audioBuffer: createMinimalWavBuffer(),
    mimeType: 'audio/wav',
    extension: 'wav',
    costUsd: 0.003,
  };
}

export async function runMockVideoStart(
  _ctx: ProviderExecutionContext,
  _input: VideoGenerationInput,
): Promise<VideoJobStartOutput> {
  const providerJobId = `mock_vid_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  mockVideoPolls.set(providerJobId, 0);
  return {
    providerJobId,
    status: 'running',
    progressPercent: 25,
    costUsd: 0.08,
  };
}

export async function runMockVideoPoll(
  _ctx: ProviderExecutionContext,
  providerJobId: string,
): Promise<VideoJobPollOutput> {
  const count = (mockVideoPolls.get(providerJobId) ?? 0) + 1;
  mockVideoPolls.set(providerJobId, count);
  if (count < 2) {
    return {
      status: 'running',
      progressPercent: 65,
    };
  }
  mockVideoPolls.delete(providerJobId);
  return {
    status: 'succeeded',
    progressPercent: 100,
    videoBuffer: createMinimalMp4Buffer(),
    mimeType: 'video/mp4',
    costUsd: 0.08,
  };
}

export async function runMockDocumentAnalysis(
  ctx: ProviderExecutionContext,
  input: DocumentAnalysisInput,
): Promise<TextGenerationOutput> {
  const preview = (input.extractedText ?? '').slice(0, 140);
  const text = `خلاصه تحلیل سند (${ctx.modelName} · حالت توسعه):\nفایل: ${input.fileName}\nپرسش: ${input.userPrompt}\nبخشی از متن: ${preview || '(تصویر)'}`;
  const inTok = estimateTokensRough(input.extractedText ?? input.userPrompt);
  const outTok = estimateTokensRough(text);
  return {
    text,
    inputTokens: inTok,
    outputTokens: outTok,
    costUsd: estimateTokenCostUsd(inTok, outTok, ctx.inputPricePerMillion, ctx.outputPricePerMillion),
  };
}
