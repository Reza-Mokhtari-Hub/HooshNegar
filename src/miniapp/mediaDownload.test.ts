import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMiniAppDownloadFilename,
  buildMiniAppDownloadUrl,
  downloadMiniAppMedia,
  extractExtensionFromMediaUrl,
  parseContentDispositionFilename,
} from './mediaDownload';

test('extractExtensionFromMediaUrl extracts normalized extensions from object keys', () => {
  assert.equal(
    extractExtensionFromMediaUrl('/api/miniapp/media?key=generated-images%2Fuser%2Fimg1.png&token=abc'),
    'png',
  );
  assert.equal(
    extractExtensionFromMediaUrl('/api/miniapp/media?key=generated-images%2Fuser%2Fphoto.JPEG&token=abc'),
    'jpg',
  );
  assert.equal(
    extractExtensionFromMediaUrl('/api/miniapp/media?key=generated-videos%2Fuser%2Fclip.mp4&token=abc'),
    'mp4',
  );
  assert.equal(
    extractExtensionFromMediaUrl('/api/miniapp/media?key=generated-files%2Fnoext&token=abc'),
    null,
  );
});

test('buildMiniAppDownloadFilename builds capability-aware filenames with real extensions', () => {
  assert.equal(
    buildMiniAppDownloadFilename({
      mediaUrl: '/api/miniapp/media?key=generated-images%2Fu1%2Fabc123.png&token=t1',
      capability: 'image_generation',
      stamp: 'test01',
    }),
    'hooshnegar-image-test01.png',
  );
  assert.equal(
    buildMiniAppDownloadFilename({
      mediaUrl: '/api/miniapp/media?key=generated-videos%2Fu1%2Fvid999.mp4&token=t1',
      capability: 'video_generation',
      stamp: 'vid01',
    }),
    'hooshnegar-video-vid01.mp4',
  );
  assert.equal(
    buildMiniAppDownloadFilename({
      mediaUrl: '/api/miniapp/media?key=generated-images%2Fu1%2Fnoext&token=t1',
      capability: 'image_editing',
      mimeType: 'image/webp',
      stamp: 'ed01',
    }),
    'hooshnegar-edited-ed01.webp',
  );
});

test('buildMiniAppDownloadUrl appends download=1 cleanly', () => {
  assert.equal(
    buildMiniAppDownloadUrl('/api/miniapp/media?key=a.mp4&token=xyz', 'https://app.example.com'),
    'https://app.example.com/api/miniapp/media?key=a.mp4&token=xyz&download=1',
  );
});

test('parseContentDispositionFilename extracts quoted and UTF-8 filenames', () => {
  assert.equal(
    parseContentDispositionFilename('attachment; filename="hooshnegar-clip.mp4"'),
    'hooshnegar-clip.mp4',
  );
  assert.equal(
    parseContentDispositionFilename("attachment; filename*=UTF-8''hooshnegar-%D8%B9%DA%A9%D8%B3.png"),
    'hooshnegar-عکس.png',
  );
  assert.equal(parseContentDispositionFilename('inline'), null);
});

test('downloadMiniAppMedia uses Telegram downloadFile when supported and accepted', async () => {
  let calledWith: { url: string; file_name: string } | null = null;
  const result = await downloadMiniAppMedia(
    {
      mediaUrl: '/api/miniapp/media?key=generated-videos%2Fclip.mp4&token=tok',
      capability: 'video_generation',
    },
    {
      origin: 'https://app.example.com',
      tg: {
        initData: 'user=123&hash=abc',
        ready: () => {},
        expand: () => {},
        close: () => {},
        isVersionAtLeast: (v) => v === '8.0',
        downloadFile: (params, cb) => {
          calledWith = params;
          cb?.(true);
        },
      },
      fetchFn: async () => {
        throw new Error('fetch should not run when Telegram downloadFile succeeds');
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.method, 'telegram');
  assert.ok(calledWith);
  assert.equal(
    (calledWith as { url: string; file_name: string }).url,
    'https://app.example.com/api/miniapp/media?key=generated-videos%2Fclip.mp4&token=tok&download=1',
  );
  assert.ok((calledWith as { url: string; file_name: string }).file_name.endsWith('.mp4'));
});

test('downloadMiniAppMedia falls back to authenticated fetch + Blob download when outside Telegram', async () => {
  let fetchedUrl = '';
  let triggeredFile = '';
  let triggeredSize = 0;

  const result = await downloadMiniAppMedia(
    {
      mediaUrl: '/api/miniapp/media?key=generated-images%2Fpic123.png&token=tok',
      capability: 'image_generation',
    },
    {
      origin: 'http://localhost:3000',
      tg: null,
      fetchFn: async (input) => {
        fetchedUrl = String(input);
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-disposition': 'attachment; filename="hooshnegar-pic123.png"',
          },
        });
      },
      triggerBlobAnchor: (blob, fileName) => {
        triggeredFile = fileName;
        triggeredSize = blob.size;
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.method, 'blob');
  assert.equal(
    fetchedUrl,
    'http://localhost:3000/api/miniapp/media?key=generated-images%2Fpic123.png&token=tok&download=1',
  );
  assert.equal(triggeredFile, 'hooshnegar-pic123.png');
  assert.equal(triggeredSize, 4);
});

test('downloadMiniAppMedia uses openLink fallback on legacy mobile Telegram WebView without downloadFile', async () => {
  let openedUrl = '';
  const result = await downloadMiniAppMedia(
    {
      mediaUrl: '/api/miniapp/media?key=generated-videos%2Fv2.mp4&token=tok',
      capability: 'video_generation',
    },
    {
      origin: 'https://app.example.com',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      tg: {
        initData: 'user=123&hash=abc',
        ready: () => {},
        expand: () => {},
        close: () => {},
        openLink: (url) => {
          openedUrl = url;
        },
      },
      fetchFn: async () => {
        throw new Error('fetch should not run when openLink handles legacy mobile WebView');
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.method, 'telegram_link');
  assert.equal(
    openedUrl,
    'https://app.example.com/api/miniapp/media?key=generated-videos%2Fv2.mp4&token=tok&download=1',
  );
});
