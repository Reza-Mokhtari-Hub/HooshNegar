import { getTelegramWebApp, type TelegramWebAppInstance } from './telegramSdk';

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
};

const CAPABILITY_PREFIX_AND_EXT: Record<string, { prefix: string; ext: string }> = {
  image_generation: { prefix: 'hooshnegar-image', ext: 'png' },
  image_editing: { prefix: 'hooshnegar-edited', ext: 'png' },
  image_variation: { prefix: 'hooshnegar-variation', ext: 'png' },
  video_generation: { prefix: 'hooshnegar-video', ext: 'mp4' },
  speech_generation: { prefix: 'hooshnegar-audio', ext: 'mp3' },
  audio_transcription: { prefix: 'hooshnegar-transcript', ext: 'txt' },
};

const VALID_EXT_RE = /^[a-z0-9]{2,5}$/i;

export function sanitizeExtension(ext: string | null | undefined): string | null {
  if (!ext) return null;
  const cleaned = ext.trim().replace(/^\./, '').toLowerCase();
  if (!cleaned || !VALID_EXT_RE.test(cleaned)) return null;
  if (cleaned === 'jpeg') return 'jpg';
  return cleaned;
}

export function extensionFromMimeType(mimeType: string | null | undefined): string | null {
  if (!mimeType) return null;
  const baseMime = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return MIME_TO_EXT[baseMime] ?? null;
}

export function extractKeyFromMediaUrl(mediaUrl: string): string | null {
  try {
    const parsed = new URL(mediaUrl, 'https://hooshnegar.local');
    const key = parsed.searchParams.get('key');
    return key ? key.trim() : null;
  } catch {
    return null;
  }
}

export function extractExtensionFromMediaUrl(mediaUrl: string): string | null {
  const key = extractKeyFromMediaUrl(mediaUrl);
  const target = key ?? mediaUrl.split('?')[0] ?? '';
  const basename = target.split('/').pop() ?? '';
  const dotIdx = basename.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === basename.length - 1) return null;
  return sanitizeExtension(basename.slice(dotIdx + 1));
}

export function parseContentDispositionFilename(header: string | null | undefined): string | null {
  if (!header) return null;
  const utf8Match = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (utf8Match?.[1]) {
    try {
      const decoded = decodeURIComponent(utf8Match[1].trim().replace(/^["']|["']$/g, ''));
      if (decoded) return decoded;
    } catch {
      // ignore malformed URI sequence
    }
  }
  const plainMatch = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;\s]+)/i.exec(header);
  const raw = plainMatch?.[1] ?? plainMatch?.[2];
  return raw ? raw.trim() : null;
}

export function buildMiniAppDownloadFilename(params: {
  mediaUrl: string;
  capability: string;
  mimeType?: string | null;
  stamp?: string;
}): string {
  const capDefaults = CAPABILITY_PREFIX_AND_EXT[params.capability] ?? {
    prefix: 'hooshnegar-media',
    ext: 'bin',
  };
  const ext =
    sanitizeExtension(extensionFromMimeType(params.mimeType)) ??
    extractExtensionFromMediaUrl(params.mediaUrl) ??
    capDefaults.ext;

  const key = extractKeyFromMediaUrl(params.mediaUrl);
  const rawBase = key ? (key.split('/').pop() ?? '') : '';
  const withoutExt = rawBase.replace(/\.[a-z0-9]{2,5}$/i, '');
  const safeToken = withoutExt.replace(/[^a-zA-Z0-9_-]/g, '').slice(-12);
  const suffix = params.stamp ?? (safeToken || String(Date.now()).slice(-6));
  return `${capDefaults.prefix}-${suffix}.${ext}`;
}

export function buildMiniAppDownloadUrl(mediaUrl: string, origin?: string): string {
  const baseOrigin =
    origin ??
    (typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'https://hooshnegar.local');
  const parsed = new URL(mediaUrl, baseOrigin);
  parsed.searchParams.set('download', '1');
  if (!origin && typeof window === 'undefined') {
    return `${parsed.pathname}${parsed.search}`;
  }
  return parsed.toString();
}

export interface DownloadMiniAppMediaResult {
  ok: boolean;
  method: 'telegram' | 'telegram_link' | 'blob';
  fileName: string;
}

export interface DownloadMediaDeps {
  tg?: TelegramWebAppInstance | null;
  origin?: string;
  userAgent?: string;
  fetchFn?: typeof fetch;
  triggerBlobAnchor?: (blob: Blob, fileName: string) => void;
}

function defaultTriggerBlobAnchor(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 15_000);
}

export async function downloadMiniAppMedia(
  params: { mediaUrl: string; capability: string },
  deps?: DownloadMediaDeps,
): Promise<DownloadMiniAppMediaResult> {
  const tg = deps?.tg !== undefined ? deps.tg : getTelegramWebApp();
  const origin =
    deps?.origin ??
    (typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '');
  const userAgent =
    deps?.userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const fetchFn = deps?.fetchFn ?? globalThis.fetch;
  const triggerBlobAnchor = deps?.triggerBlobAnchor ?? defaultTriggerBlobAnchor;

  const initialFileName = buildMiniAppDownloadFilename({
    mediaUrl: params.mediaUrl,
    capability: params.capability,
  });
  const absoluteDownloadUrl = origin
    ? buildMiniAppDownloadUrl(params.mediaUrl, origin)
    : buildMiniAppDownloadUrl(params.mediaUrl);
  const relativeOrSameOriginUrl = buildMiniAppDownloadUrl(
    params.mediaUrl,
    origin || undefined,
  );

  const hasTelegramSession = Boolean(tg?.initData && tg.initData.trim().length > 0);
  const supportsTelegramDownloadFile =
    hasTelegramSession &&
    typeof tg?.downloadFile === 'function' &&
    (typeof tg.isVersionAtLeast !== 'function' || tg.isVersionAtLeast('8.0'));

  if (supportsTelegramDownloadFile && tg?.downloadFile) {
    const accepted = await new Promise<boolean>((resolve) => {
      try {
        tg.downloadFile!(
          { url: absoluteDownloadUrl, file_name: initialFileName },
          (ok) => resolve(Boolean(ok)),
        );
      } catch {
        resolve(false);
      }
    });
    if (accepted) {
      return {
        ok: true,
        method: 'telegram',
        fileName: initialFileName,
      };
    }
  }

  const isMobileWebView = /iPhone|iPad|iPod|Android/i.test(userAgent);
  if (hasTelegramSession && isMobileWebView && typeof tg?.openLink === 'function') {
    tg.openLink(absoluteDownloadUrl);
    return {
      ok: true,
      method: 'telegram_link',
      fileName: initialFileName,
    };
  }

  const res = await fetchFn(relativeOrSameOriginUrl, {
    method: 'GET',
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let serverErr = '';
    try {
      const json = (await res.json()) as { error?: string };
      if (typeof json?.error === 'string') serverErr = json.error;
    } catch {
      // ignore non-json error body
    }
    throw new Error(serverErr || `خطا در دریافت فایل از سرور (${res.status}).`);
  }

  const headerName = parseContentDispositionFilename(res.headers.get('content-disposition'));
  const resolvedName = headerName
    ? headerName
    : buildMiniAppDownloadFilename({
        mediaUrl: params.mediaUrl,
        capability: params.capability,
        mimeType: res.headers.get('content-type'),
      });
  const blob = await res.blob();
  if (!blob || blob.size === 0) {
    throw new Error('فایل دریافت‌شده خالی است.');
  }

  triggerBlobAnchor(blob, resolvedName);
  return {
    ok: true,
    method: 'blob',
    fileName: resolvedName,
  };
}
