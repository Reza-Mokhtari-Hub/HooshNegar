export const MAX_UPLOAD_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 1536;
export const OPTIMIZE_IMAGE_THRESHOLD_BYTES = 900 * 1024;

export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export function isAllowedImageFile(file: { type?: string; name?: string }): boolean {
  const cleanType = (file.type ?? '').trim().toLowerCase();
  if ((ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(cleanType)) {
    return true;
  }
  return /\.(jpe?g|png|webp)$/i.test(file.name ?? '');
}

export function normalizeImageMimeType(mimeType?: string, fileName?: string): 'image/jpeg' | 'image/png' | 'image/webp' {
  const clean = (mimeType ?? '').trim().toLowerCase();
  if (clean === 'image/png') return 'image/png';
  if (clean === 'image/webp') return 'image/webp';
  if (clean === 'image/jpeg' || clean === 'image/jpg') return 'image/jpeg';
  if (/\.png$/i.test(fileName ?? '')) return 'image/png';
  if (/\.webp$/i.test(fileName ?? '')) return 'image/webp';
  return 'image/jpeg';
}

export function computeTargetDimensions(
  width: number,
  height: number,
  maxDimension: number = MAX_IMAGE_DIMENSION,
): { width: number; height: number; resized: boolean } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1, height: 1, resized: false };
  }
  const safeMax = Math.max(64, Math.floor(maxDimension));
  const longest = Math.max(width, height);
  if (longest <= safeMax) {
    return { width: Math.round(width), height: Math.round(height), resized: false };
  }
  const scale = safeMax / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    resized: true,
  };
}

export function chooseOutputMimeType(
  sourceMimeType: string,
  originalSizeBytes: number,
  needsResize: boolean,
): 'image/jpeg' | 'image/png' | 'image/webp' {
  const normalized = normalizeImageMimeType(sourceMimeType);
  if (normalized === 'image/png') {
    // Keep crisp lossless PNG only when already compact; use WebP (supports alpha + high compression) when large
    return !needsResize && originalSizeBytes <= 600 * 1024 ? 'image/png' : 'image/webp';
  }
  if (normalized === 'image/webp') return 'image/webp';
  return 'image/jpeg';
}

export function shouldOptimizeImage(params: {
  sizeBytes: number;
  width: number;
  height: number;
  maxDimension?: number;
  thresholdBytes?: number;
}): boolean {
  const maxDim = params.maxDimension ?? MAX_IMAGE_DIMENSION;
  const threshold = params.thresholdBytes ?? OPTIMIZE_IMAGE_THRESHOLD_BYTES;
  if (params.sizeBytes > threshold) return true;
  if (params.width > maxDim || params.height > maxDim) return true;
  return false;
}

export function estimateBase64ByteLength(base64: string): number {
  const clean = base64.includes(',') ? (base64.split(',')[1] ?? '') : base64;
  const trimmed = clean.trim();
  if (!trimmed) return 0;
  const padding = trimmed.endsWith('==') ? 2 : trimmed.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding);
}

export function formatImageSizeLabel(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return '۰ کیلوبایت';
  if (sizeBytes < 1024 * 1024) {
    const kb = Math.max(1, Math.round(sizeBytes / 1024));
    return `${kb.toLocaleString('fa-IR')} کیلوبایت`;
  }
  const mb = (sizeBytes / (1024 * 1024)).toFixed(1);
  return `${mb} مگابایت`;
}

export interface PreparedUploadImage {
  name: string;
  mimeType: string;
  base64: string;
  previewUrl: string;
  sizeBytes: number;
  wasCompressed: boolean;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error('خطا در خواندن فایل تصویر.'));
    reader.readAsDataURL(file);
  });
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('تصویر قابل رمزگشایی نیست.'));
    img.src = src;
  });
}

export async function prepareImageForUpload(file: File): Promise<PreparedUploadImage> {
  const sourceMime = normalizeImageMimeType(file.type, file.name);
  const originalDataUrl = await readFileAsDataUrl(file);
  const originalBase64 = originalDataUrl.includes(',')
    ? (originalDataUrl.split(',')[1] ?? '')
    : originalDataUrl;
  const originalSizeBytes = file.size || estimateBase64ByteLength(originalBase64);

  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    return {
      name: file.name,
      mimeType: sourceMime,
      base64: originalBase64,
      previewUrl: originalDataUrl,
      sizeBytes: originalSizeBytes,
      wasCompressed: false,
    };
  }

  try {
    const img = await loadHtmlImage(originalDataUrl);
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;

    if (!shouldOptimizeImage({ sizeBytes: originalSizeBytes, width, height })) {
      return {
        name: file.name,
        mimeType: sourceMime,
        base64: originalBase64,
        previewUrl: originalDataUrl,
        sizeBytes: originalSizeBytes,
        wasCompressed: false,
      };
    }

    const targetDims = computeTargetDimensions(width, height, MAX_IMAGE_DIMENSION);
    const targetMime = chooseOutputMimeType(sourceMime, originalSizeBytes, targetDims.resized);

    const canvas = document.createElement('canvas');
    canvas.width = targetDims.width;
    canvas.height = targetDims.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return {
        name: file.name,
        mimeType: sourceMime,
        base64: originalBase64,
        previewUrl: originalDataUrl,
        sizeBytes: originalSizeBytes,
        wasCompressed: false,
      };
    }
    ctx.drawImage(img, 0, 0, targetDims.width, targetDims.height);

    const compressedDataUrl = canvas.toDataURL(targetMime, 0.86);
    const compressedBase64 = compressedDataUrl.includes(',')
      ? (compressedDataUrl.split(',')[1] ?? '')
      : compressedDataUrl;
    const compressedBytes = estimateBase64ByteLength(compressedBase64);

    if (compressedBase64 && (compressedBytes < originalSizeBytes || targetDims.resized)) {
      const actualMime = compressedDataUrl.startsWith('data:image/webp')
        ? 'image/webp'
        : compressedDataUrl.startsWith('data:image/png')
          ? 'image/png'
          : compressedDataUrl.startsWith('data:image/jpeg')
            ? 'image/jpeg'
            : targetMime;
      return {
        name: file.name,
        mimeType: actualMime,
        base64: compressedBase64,
        previewUrl: compressedDataUrl,
        sizeBytes: compressedBytes,
        wasCompressed: compressedBytes < originalSizeBytes || targetDims.resized,
      };
    }
  } catch {
    // Safe pass-through on decode/canvas fallback
  }

  return {
    name: file.name,
    mimeType: sourceMime,
    base64: originalBase64,
    previewUrl: originalDataUrl,
    sizeBytes: originalSizeBytes,
    wasCompressed: false,
  };
}
