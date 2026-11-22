import type { CapabilityType, ProviderType } from '../../shared/validation.ts';

export type AIErrorCode =
  | 'INVALID_API_KEY'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'UNSUPPORTED_CAPABILITY'
  | 'INVALID_PROMPT'
  | 'UNSUPPORTED_MEDIA'
  | 'INSUFFICIENT_CREDITS'
  | 'NETWORK_ERROR'
  | 'PROVIDER_ERROR'
  | 'SSRF_BLOCKED'
  | 'CANCELED';

export class AIProviderError extends Error {
  readonly code: AIErrorCode;
  readonly retryable: boolean;
  readonly httpStatus: number | null;
  readonly userMessageFa: string;

  constructor(params: {
    code: AIErrorCode;
    message: string;
    userMessageFa: string;
    retryable?: boolean;
    httpStatus?: number | null;
  }) {
    super(params.message);
    this.name = 'AIProviderError';
    this.code = params.code;
    this.userMessageFa = params.userMessageFa;
    this.retryable = params.retryable ?? false;
    this.httpStatus = params.httpStatus ?? null;
  }
}

export interface ProviderExecutionContext {
  providerId: string;
  providerName: string;
  providerType: ProviderType;
  baseUrl: string;
  apiKey: string;
  organizationId?: string | null;
  additionalHeaders?: Record<string, string>;
  modelId: string;
  modelName: string;
  modelIdentifier: string;
  modelParameters?: Record<string, unknown>;
  supportedCapabilities: CapabilityType[];
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  maxInputSize?: number;
  maxOutputSize?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  imageBase64?: string;
  imageMimeType?: string;
}

export interface TextGenerationInput {
  messages: ChatMessage[];
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onChunk?: (accumulatedText: string) => Promise<void> | void;
}

export interface TextGenerationOutput {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  finishReason?: string;
}

export interface VisionAnalysisInput {
  prompt: string;
  imageBase64: string;
  mimeType: string;
  systemPrompt?: string;
  signal?: AbortSignal;
}

export interface ImageGenerationInput {
  prompt: string;
  aspectRatio?: string;
  resolution?: string;
  count?: number;
  signal?: AbortSignal;
}

export interface ImageEditInput {
  prompt: string;
  sourceImageBuffer: Buffer;
  sourceMimeType: string;
  mode: 'edit' | 'variation';
  aspectRatio?: string;
  resolution?: string;
  signal?: AbortSignal;
}

export interface GeneratedMediaItem {
  buffer: Buffer;
  mimeType: string;
  extension: string;
  revisedPrompt?: string;
}

export interface ImageOutput {
  images: GeneratedMediaItem[];
  costUsd: number;
}

export interface AudioTranscriptionInput {
  audioBuffer: Buffer;
  mimeType: string;
  fileName: string;
  language?: string;
  signal?: AbortSignal;
}

export interface AudioTranscriptionOutput {
  text: string;
  language?: string;
  costUsd: number;
}

export interface SpeechGenerationInput {
  text: string;
  voice?: string;
  language?: string;
  signal?: AbortSignal;
}

export interface SpeechGenerationOutput {
  audioBuffer: Buffer;
  mimeType: string;
  extension: string;
  costUsd: number;
}

export interface VideoGenerationInput {
  prompt: string;
  sourceImageBase64?: string;
  sourceImageMimeType?: string;
  durationSeconds?: number;
  aspectRatio?: string;
  quality?: string;
  signal?: AbortSignal;
}

export interface VideoJobStartOutput {
  providerJobId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  progressPercent: number;
  videoBuffer?: Buffer;
  videoUrl?: string;
  mimeType?: string;
  costUsd?: number;
  metadata?: Record<string, unknown>;
}

export interface VideoJobPollOutput {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  progressPercent: number;
  videoBuffer?: Buffer;
  videoUrl?: string;
  mimeType?: string;
  errorMessage?: string;
  costUsd?: number;
}

export interface DocumentAnalysisInput {
  fileName: string;
  mimeType: string;
  extractedText?: string;
  imageBase64?: string;
  userPrompt: string;
  systemPrompt?: string;
  signal?: AbortSignal;
}

export function estimateTokenCostUsd(
  inputTokens: number,
  outputTokens: number,
  inputPricePerMillion = 0,
  outputPricePerMillion = 0,
): number {
  const inputCost = (Math.max(0, inputTokens) / 1_000_000) * Math.max(0, inputPricePerMillion);
  const outputCost = (Math.max(0, outputTokens) / 1_000_000) * Math.max(0, outputPricePerMillion);
  return Number((inputCost + outputCost).toFixed(6));
}

export function estimateTokensRough(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3.5));
}
