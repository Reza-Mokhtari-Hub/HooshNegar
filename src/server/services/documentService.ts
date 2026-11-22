import path from 'node:path';
import mammoth from 'mammoth';
import { extractText } from 'unpdf';

export type SupportedDocumentKind = 'pdf' | 'txt' | 'docx' | 'csv' | 'image';

export interface FileValidationResult {
  ok: boolean;
  kind?: SupportedDocumentKind;
  normalizedMime?: string;
  error?: string;
}

export interface ExtractedDocumentContent {
  kind: SupportedDocumentKind;
  mimeType: string;
  fileName: string;
  textContent?: string;
  imageBase64?: string;
  truncated?: boolean;
  charCount?: number;
}

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const AUDIO_MIMES = new Set([
  'audio/ogg',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/m4a',
  'audio/webm',
  'audio/flac',
]);

const BLOCKED_EXECUTABLE_EXTENSIONS = new Set([
  '.exe',
  '.sh',
  '.bat',
  '.cmd',
  '.ps1',
  '.js',
  '.mjs',
  '.cjs',
  '.php',
  '.py',
  '.rb',
  '.pl',
  '.jar',
  '.dll',
  '.so',
  '.msi',
  '.apk',
  '.html',
  '.htm',
  '.svg',
]);

export function validateAudioFile(params: {
  mimeType?: string;
  fileName?: string;
  sizeBytes: number;
  maxSizeMb: number;
}): { ok: boolean; normalizedMime?: string; error?: string } {
  const maxBytes = params.maxSizeMb * 1024 * 1024;
  if (params.sizeBytes <= 0) {
    return { ok: false, error: 'فایل صوتی خالی یا نامعتبر است.' };
  }
  if (params.sizeBytes > maxBytes) {
    return {
      ok: false,
      error: `حجم فایل صوتی بیش از سقف مجاز پلن شما (${params.maxSizeMb} مگابایت) است.`,
    };
  }
  const ext = path.extname(params.fileName ?? '').toLowerCase();
  const mime = (params.mimeType ?? '').toLowerCase().split(';')[0]?.trim() ?? '';

  if (AUDIO_MIMES.has(mime)) {
    return { ok: true, normalizedMime: mime };
  }
  const extToMime: Record<string, string> = {
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.mp4': 'audio/mp4',
    '.webm': 'audio/webm',
    '.flac': 'audio/flac',
  };
  if (ext && extToMime[ext]) {
    return { ok: true, normalizedMime: extToMime[ext] };
  }
  return {
    ok: false,
    error: 'فرمت فایل صوتی پشتیبانی نمی‌شود. فرمت‌های مجاز: OGG (ویس تلگرام)، MP3، WAV، M4A، WEBM، FLAC.',
  };
}

export function validateUploadedFile(params: {
  fileName: string;
  mimeType?: string;
  sizeBytes: number;
  maxSizeMb: number;
  buffer?: Buffer;
}): FileValidationResult {
  const maxBytes = params.maxSizeMb * 1024 * 1024;
  if (params.sizeBytes <= 0) {
    return { ok: false, error: 'فایل ارسال‌شده خالی است.' };
  }
  if (params.sizeBytes > maxBytes) {
    return {
      ok: false,
      error: `حجم فایل (${(params.sizeBytes / (1024 * 1024)).toFixed(1)}MB) بیش از سقف مجاز پلن شما (${params.maxSizeMb}MB) است.`,
    };
  }

  const ext = path.extname(params.fileName || '').toLowerCase();
  if (BLOCKED_EXECUTABLE_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      error: 'ارسال فایل‌های اجرایی یا اسکریپتی به دلایل امنیتی مجاز نیست.',
    };
  }

  const mime = (params.mimeType ?? '').toLowerCase().split(';')[0]?.trim() ?? '';

  // Magic byte sanity check for executables (ELF, PE MZ, Mach-O)
  if (params.buffer && params.buffer.length >= 4) {
    const b0 = params.buffer[0];
    const b1 = params.buffer[1];
    const b2 = params.buffer[2];
    const b3 = params.buffer[3];
    const isElf = b0 === 0x7f && b1 === 0x45 && b2 === 0x4c && b3 === 0x46;
    const isPe = b0 === 0x4d && b1 === 0x5a;
    if (isElf || isPe) {
      return { ok: false, error: 'فایل باینری اجرایی شناسایی و مسدود شد.' };
    }
  }

  if (mime === 'application/pdf' || ext === '.pdf') {
    if (params.buffer && params.buffer.length >= 4 && params.buffer.subarray(0, 4).toString('ascii') !== '%PDF') {
      return { ok: false, error: 'ساختار فایل PDF نامعتبر است.' };
    }
    return { ok: true, kind: 'pdf', normalizedMime: 'application/pdf' };
  }

  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === '.docx'
  ) {
    return {
      ok: true,
      kind: 'docx',
      normalizedMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
  }

  if (mime === 'text/csv' || mime === 'application/csv' || ext === '.csv') {
    return { ok: true, kind: 'csv', normalizedMime: 'text/csv' };
  }

  if (mime === 'text/plain' || mime === 'text/markdown' || ext === '.txt' || ext === '.md') {
    return { ok: true, kind: 'txt', normalizedMime: 'text/plain' };
  }

  if (IMAGE_MIMES.has(mime) || ['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
    const resolvedMime = IMAGE_MIMES.has(mime)
      ? mime
      : ext === '.png'
        ? 'image/png'
        : ext === '.webp'
          ? 'image/webp'
          : 'image/jpeg';
    return { ok: true, kind: 'image', normalizedMime: resolvedMime };
  }

  return {
    ok: false,
    error:
      'این نوع فایل پشتیبانی نمی‌شود. فرمت‌های مجاز برای تحلیل: PDF، DOCX، TXT، CSV و تصاویر (JPG/PNG/WEBP).',
  };
}

const MAX_EXTRACTED_CHARS = 60000;

export async function extractDocumentContent(params: {
  buffer: Buffer;
  fileName: string;
  mimeType?: string;
  maxSizeMb: number;
}): Promise<{ ok: true; data: ExtractedDocumentContent } | { ok: false; error: string }> {
  const validation = validateUploadedFile({
    fileName: params.fileName,
    mimeType: params.mimeType,
    sizeBytes: params.buffer.byteLength,
    maxSizeMb: params.maxSizeMb,
    buffer: params.buffer,
  });

  if (!validation.ok || !validation.kind || !validation.normalizedMime) {
    return { ok: false, error: validation.error ?? 'فایل معتبر نیست.' };
  }

  try {
    if (validation.kind === 'image') {
      return {
        ok: true,
        data: {
          kind: 'image',
          mimeType: validation.normalizedMime,
          fileName: params.fileName,
          imageBase64: params.buffer.toString('base64'),
        },
      };
    }

    let rawText = '';
    if (validation.kind === 'txt' || validation.kind === 'csv') {
      rawText = params.buffer.toString('utf8');
    } else if (validation.kind === 'docx') {
      const result = await mammoth.extractRawText({ buffer: params.buffer });
      rawText = result.value ?? '';
    } else if (validation.kind === 'pdf') {
      const pdfResult = await extractText(new Uint8Array(params.buffer), { mergePages: true });
      rawText = Array.isArray(pdfResult.text) ? pdfResult.text.join('\n\n') : String(pdfResult.text ?? '');
    }

    const cleaned = rawText.replace(/\u0000/g, '').trim();
    if (!cleaned) {
      return {
        ok: false,
        error: 'متن قابل استخراجی در این سند یافت نشد (ممکن است PDF اسکن‌شده باشد؛ آن را به صورت تصویر ارسال کنید).',
      };
    }

    const truncated = cleaned.length > MAX_EXTRACTED_CHARS;
    const finalText = truncated ? cleaned.slice(0, MAX_EXTRACTED_CHARS) : cleaned;

    return {
      ok: true,
      data: {
        kind: validation.kind,
        mimeType: validation.normalizedMime,
        fileName: params.fileName,
        textContent: finalText,
        truncated,
        charCount: cleaned.length,
      },
    };
  } catch {
    return {
      ok: false,
      error: 'خطا در خواندن یا استخراج محتوای فایل. لطفاً از سالم بودن فایل اطمینان حاصل کنید.',
    };
  }
}
