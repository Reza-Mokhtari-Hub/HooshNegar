import { describe, expect, it } from 'vitest';
import {
  buildGradioInputPayload,
  editImageWithRoute,
  extractGradioMediaUrl,
  extractGradioOutputText,
  generateTextWithRoute,
  pollMediaGenerationJob,
  pollVideoGenerationJob,
  startImageGenerationWithRoute,
  startVideoGenerationWithRoute,
  type GradioFileData,
} from './engine.ts';
import { discoverProviderModels } from './discovery.ts';
import { AIProviderError, type ProviderExecutionContext } from './types.ts';
import { runWithCloudflareRequestContext } from '../cloudflare/requestContext.ts';

function makeSpaceCtx(overrides: Partial<ProviderExecutionContext> = {}): ProviderExecutionContext {
  return {
    providerId: 'prov-hf-space',
    providerName: 'HF Space Test',
    providerType: 'huggingface_space',
    baseUrl: 'https://demo-user-demo-space.hf.space',
    apiKey: 'hf_test_token_12345',
    modelId: 'model-hf-space',
    modelName: 'Demo Space',
    modelIdentifier: 'demo-user/demo-space::generate',
    supportedCapabilities: [
      'text_generation',
      'chat',
      'vision',
      'image_generation',
      'image_editing',
      'image_variation',
      'video_generation',
      'speech_generation',
      'audio_transcription',
    ],
    modelParameters: {
      spaceHost: 'https://demo-user-demo-space.hf.space',
      apiName: 'generate',
      endpointPrefix: '/gradio_api',
    },
    ...overrides,
  };
}

const QWEN_AIO_PARAMS = [
  { index: 0, name: 'prompt', label: 'Prompt', component: 'textbox', hasDefault: false, defaultValue: null },
  {
    index: 1,
    name: 'mode',
    label: 'Mode',
    component: 'radio',
    hasDefault: true,
    defaultValue: 'Text to Image',
    enum: ['Text to Image', 'Edit Image (1 Ref)', 'Transform & Swap (2 Refs)', 'Transparent PNG'],
  },
  { index: 2, name: 'ref_image_1', label: 'Reference Image 1', component: 'image', hasDefault: true, defaultValue: null },
  { index: 3, name: 'ref_image_2', label: 'Reference Image 2', component: 'image', hasDefault: true, defaultValue: null },
  {
    index: 4,
    name: 'lora_adapter',
    label: 'LoRA Adapter',
    component: 'dropdown',
    hasDefault: true,
    defaultValue: 'None (Base Model)',
    enum: ['None (Base Model)', 'Viggle Turbo (6-Step)', 'Realism LoRA'],
  },
  { index: 5, name: 'lora_strength', label: 'LoRA Strength', component: 'slider', hasDefault: true, defaultValue: 0.8 },
  { index: 6, name: 'custom_repo', label: 'Custom Repo', component: 'textbox', hasDefault: true, defaultValue: '' },
  { index: 7, name: 'custom_file', label: 'Custom File', component: 'textbox', hasDefault: true, defaultValue: '' },
  {
    index: 8,
    name: 'aspect_ratio',
    label: 'Aspect Ratio',
    component: 'dropdown',
    hasDefault: true,
    defaultValue: 'Square · 1:1 (1024x1024)',
    enum: ['Square · 1:1 (1024x1024)', 'Landscape · 16:9 (1344x768)', 'Portrait · 9:16 (768x1344)'],
  },
  { index: 9, name: 'steps', label: 'Steps', component: 'slider', hasDefault: true, defaultValue: 30, min: 1, max: 50 },
  { index: 10, name: 'seed', label: 'Seed', component: 'number', hasDefault: true, defaultValue: 42 },
  { index: 11, name: 'randomize_seed', label: 'Randomize Seed', component: 'checkbox', hasDefault: true, defaultValue: true },
];

describe('Universal Hugging Face Space Engine', () => {
  it('enables Auto-Turbo LoRA & 6 steps for BOTH image editing and variation', () => {
    const ctx = makeSpaceCtx({
      modelParameters: {
        spaceHost: 'https://leivisondias-qwen-image-2-1-uncensored-aio-loras.hf.space',
        apiName: 'generate',
        endpointPrefix: '/gradio_api',
        parameters: QWEN_AIO_PARAMS,
      },
    });

    const uploadedImg: GradioFileData = {
      path: '/tmp/gradio/abc/source.png',
      url: 'https://leivisondias-qwen-image-2-1-uncensored-aio-loras.hf.space/gradio_api/file=/tmp/gradio/abc/source.png',
      orig_name: 'source.png',
      size: 4096,
      mime_type: 'image/png',
      is_stream: false,
      meta: { _type: 'gradio.FileData' },
    };

    const editArgs = buildGradioInputPayload(ctx, 'Change jacket to blue leather', undefined, undefined, uploadedImg, {
      mode: 'edit',
      aspectRatio: '16:9',
      mediaKind: 'image',
    });

    expect(editArgs[0]).toBe('Change jacket to blue leather');
    expect(editArgs[1]).toBe('Edit Image (1 Ref)');
    expect(editArgs[2]).toEqual(uploadedImg);
    expect(editArgs[3]).toBeNull();
    expect(editArgs[4]).toBe('Viggle Turbo (6-Step)');
    expect(editArgs[8]).toBe('Landscape · 16:9 (1344x768)');
    expect(editArgs[9]).toBe(6);

    const variationArgs = buildGradioInputPayload(ctx, 'Stylized variation', undefined, undefined, uploadedImg, {
      mode: 'variation',
      mediaKind: 'image',
    });
    expect(variationArgs[1]).toBe('Edit Image (1 Ref)');
    expect(variationArgs[4]).toBe('Viggle Turbo (6-Step)');
    expect(variationArgs[9]).toBe(6);
  });

  it('formats ImageEditor, Gallery, Files, MultimodalTextbox, and Gradio 4/5 Chatbot inputs accurately', () => {
    const fileData: GradioFileData = {
      path: '/tmp/gradio/img.png',
      mime_type: 'image/png',
      is_stream: false,
      meta: { _type: 'gradio.FileData' },
    };

    const editorCtx = makeSpaceCtx({
      modelParameters: {
        parameters: [
          { name: 'editor', label: 'Image Editor', component: 'imageeditor', isImageEditor: true },
          { name: 'prompt', label: 'Prompt', component: 'textbox' },
        ],
      },
    });
    const editorArgs = buildGradioInputPayload(editorCtx, 'Remove background', undefined, undefined, fileData, {
      mode: 'edit',
      mediaKind: 'image',
    });
    expect(editorArgs[0]).toEqual({ background: fileData, layers: [], composite: fileData });
    expect(editorArgs[1]).toBe('Remove background');

    const vlmCtx = makeSpaceCtx({
      modelParameters: {
        parameters: [
          { name: 'message', label: 'Message', component: 'multimodaltextbox', isMultimodalTextbox: true },
          { name: 'history', label: 'Chatbot', component: 'chatbot', isChatbotMessages: true },
        ],
      },
    });
    const vlmArgs = buildGradioInputPayload(
      vlmCtx,
      'What is in this photo?',
      undefined,
      [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
      ],
      fileData,
      { mode: 'vision', mediaKind: 'image' },
    );
    expect(vlmArgs[0]).toEqual({ text: 'What is in this photo?', files: [fileData] });
    expect(vlmArgs[1]).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ]);

    const g4Ctx = makeSpaceCtx({
      modelParameters: {
        parameters: [
          { name: 'message', label: 'Message', component: 'textbox' },
          { name: 'history', label: 'History', component: 'chatbot', isChatbotMessages: false },
        ],
      },
    });
    const g4Args = buildGradioInputPayload(g4Ctx, 'Next question', undefined, [
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
      { role: 'assistant', content: 'A2' },
    ]);
    expect(g4Args[1]).toEqual([
      ['Q1', 'A1'],
      ['Q2', 'A2'],
    ]);

    const galleryCtx = makeSpaceCtx({
      modelParameters: {
        parameters: [
          { name: 'images', label: 'Input Gallery', component: 'gallery', isFileList: true },
          { name: 'prompt', label: 'Prompt', component: 'textbox' },
        ],
      },
    });
    const galleryArgs = buildGradioInputPayload(galleryCtx, 'Merge style', undefined, undefined, fileData, {
      mode: 'edit',
      mediaKind: 'image',
    });
    expect(galleryArgs[0]).toEqual([{ image: fileData, caption: null }]);
  });

  it('matches video duration/mode/clamping and TTS/STT voice/language enums', () => {
    const videoCtx = makeSpaceCtx({
      modelParameters: {
        parameters: [
          { name: 'prompt', label: 'Prompt', component: 'textbox' },
          { name: 'image', label: 'First Frame', component: 'image' },
          { name: 'task', label: 'Task Mode', component: 'radio', enum: ['Text to Video', 'Image to Video'] },
          { name: 'duration', label: 'Duration (seconds)', component: 'slider', min: 2, max: 6, defaultValue: 4 },
          { name: 'aspect_ratio', label: 'Aspect Ratio', component: 'dropdown', enum: ['16:9', '9:16', '1:1'] },
        ],
      },
    });
    const imgFile: GradioFileData = { path: '/tmp/frame.png', meta: { _type: 'gradio.FileData' } };
    const videoArgs = buildGradioInputPayload(videoCtx, 'Camera zooms out smoothly', undefined, undefined, imgFile, {
      mode: 'i2v',
      durationSeconds: 10,
      aspectRatio: '9:16',
      mediaKind: 'image',
    });
    expect(videoArgs[0]).toBe('Camera zooms out smoothly');
    expect(videoArgs[1]).toEqual(imgFile);
    expect(videoArgs[2]).toBe('Image to Video');
    expect(videoArgs[3]).toBe(6);
    expect(videoArgs[4]).toBe('9:16');

    const ttsCtx = makeSpaceCtx({
      modelParameters: {
        parameters: [
          { name: 'text', label: 'Input Text', component: 'textbox' },
          { name: 'voice', label: 'Speaker Voice', component: 'dropdown', enum: ['Aria', 'Kore (Warm)', 'Nova'] },
          { name: 'language', label: 'Language', component: 'dropdown', enum: ['English', 'Persian', 'Arabic'] },
        ],
      },
    });
    const ttsArgs = buildGradioInputPayload(ttsCtx, 'سلام دنیا', undefined, undefined, undefined, {
      mode: 'tts',
      voice: 'Kore',
      language: 'fa',
    });
    expect(ttsArgs[0]).toBe('سلام دنیا');
    expect(ttsArgs[1]).toBe('Kore (Warm)');
    expect(ttsArgs[2]).toBe('Persian');
  });

  it('extracts Gradio 4/5 text and media outputs accurately without status-text false positives', () => {
    const g5Text = extractGradioOutputText([
      [
        { role: 'user', content: 'سلام' },
        { role: 'assistant', content: 'سلام! چطور می‌تونم کمکتون کنم؟' },
        { role: 'user', content: '۲ به علاوه ۲؟' },
        { role: 'assistant', content: [{ type: 'text', text: 'پاسخ برابر با ۴ است.' }] },
      ],
    ]);
    expect(g5Text).toBe('پاسخ برابر با ۴ است.');

    const g4Text = extractGradioOutputText([
      [
        ['اول', 'پاسخ اول'],
        ['دوم', 'پاسخ نهایی'],
      ],
    ]);
    expect(g4Text).toBe('پاسخ نهایی');

    const videoUrl = extractGradioMediaUrl(
      [
        'Done! Visit https://example.com/info for more details',
        { path: '/tmp/thumb.png', mime_type: 'image/png' },
        { video: { path: '/tmp/render_out.mp4', mime_type: 'video/mp4' } },
      ],
      'https://vid-space.hf.space',
      'video',
      '/gradio_api',
    );
    expect(videoUrl).toBe('https://vid-space.hf.space/gradio_api/file=/tmp/render_out.mp4');

    const legacyAudioUrl = extractGradioMediaUrl(
      [{ path: '/tmp/speech.wav', mime_type: 'audio/wav' }],
      'https://tts-space.hf.space',
      'audio',
      '',
    );
    expect(legacyAudioUrl).toBe('https://tts-space.hf.space/file=/tmp/speech.wav');
  });

  it('executes HF Space image editing end-to-end and safely handles HTML 503 restart responses', async () => {
    const originalFetch = globalThis.fetch;
    try {
      let uploadedForm = false;
      let submittedArgs: unknown[] | null = null;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/gradio_api/upload')) {
          uploadedForm = true;
          return new Response(JSON.stringify(['/tmp/gradio/uploaded_source.png']), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.endsWith('/gradio_api/call/generate') && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { data: unknown[] };
          submittedArgs = body.data;
          return new Response(JSON.stringify({ event_id: 'evt_edit_001' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.endsWith('/gradio_api/call/generate/evt_edit_001')) {
          const sse = `event: complete\ndata: [{"url":"https://demo-user-demo-space.hf.space/gradio_api/file=/tmp/edited.png","path":"/tmp/edited.png"}]\n\n`;
          return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        if (url.includes('/file=/tmp/edited.png')) {
          return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
            status: 200,
            headers: { 'Content-Type': 'image/png' },
          });
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch;

      const ctx = makeSpaceCtx({
        modelParameters: {
          spaceHost: 'https://demo-user-demo-space.hf.space',
          apiName: 'generate',
          endpointPrefix: '/gradio_api',
          parameters: QWEN_AIO_PARAMS,
        },
      });
      const res = await editImageWithRoute(
        { primary: ctx, fallback: null },
        {
          prompt: 'Make sky sunset orange',
          sourceImageBuffer: Buffer.from([1, 2, 3, 4]),
          sourceMimeType: 'image/png',
          mode: 'edit',
        },
      );
      expect(uploadedForm).toBe(true);
      expect(Array.isArray(submittedArgs)).toBe(true);
      expect(submittedArgs![1]).toBe('Edit Image (1 Ref)');
      expect(submittedArgs![4]).toBe('Viggle Turbo (6-Step)');
      expect(submittedArgs![9]).toBe(6);
      expect(res.result.images.length).toBe(1);
      expect(res.result.images[0]!.mimeType).toBe('image/png');

      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/upload')) {
          return new Response(JSON.stringify(['/tmp/x.png']), { status: 200 });
        }
        return new Response('<!DOCTYPE html><html><body>Space is restarting</body></html>', {
          status: 503,
          headers: { 'Content-Type': 'text/html' },
        });
      }) as typeof fetch;

      let caughtErr: unknown = null;
      try {
        await editImageWithRoute(
          { primary: ctx, fallback: null },
          {
            prompt: 'Test HTML error',
            sourceImageBuffer: Buffer.from([1, 2, 3]),
            sourceMimeType: 'image/png',
            mode: 'edit',
          },
        );
      } catch (err) {
        caughtErr = err;
      }
      expect(caughtErr).toBeInstanceOf(AIProviderError);
      expect((caughtErr as AIProviderError).code).toBe('PROVIDER_ERROR');
      expect((caughtErr as AIProviderError).retryable).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('runs HF Space video generation asynchronously in Cloudflare waitUntil and completes via pollVideoGenerationJob', async () => {
    const originalFetch = globalThis.fetch;
    try {
      let sseCalledDuringStart = false;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/gradio_api/upload')) {
          return new Response(JSON.stringify(['/tmp/gradio/vid_ref.jpg']), { status: 200 });
        }
        if (url.endsWith('/gradio_api/call/generate_video') && init?.method === 'POST') {
          return new Response(JSON.stringify({ event_id: 'evt_vid_999' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.endsWith('/gradio_api/call/generate_video/evt_vid_999')) {
          sseCalledDuringStart = true;
          const sse = `event: complete\ndata: [{"video":{"url":"https://vid-demo.hf.space/gradio_api/file=/tmp/final.mp4","mime_type":"video/mp4"}}]\n\n`;
          return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        if (url.includes('/file=/tmp/final.mp4')) {
          return new Response(new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]), {
            status: 200,
            headers: { 'Content-Type': 'video/mp4' },
          });
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch;

      const videoCtx = makeSpaceCtx({
        baseUrl: 'https://vid-demo.hf.space',
        modelIdentifier: 'demo/vid::generate_video',
        modelParameters: {
          spaceHost: 'https://vid-demo.hf.space',
          apiName: 'generate_video',
          endpointPrefix: '/gradio_api',
          parameters: [
            { name: 'prompt', label: 'Prompt', component: 'textbox' },
            { name: 'image', label: 'Image', component: 'image' },
            { name: 'duration', label: 'Duration', component: 'slider', min: 3, max: 8, defaultValue: 5 },
          ],
        },
      });

      const startRes = await runWithCloudflareRequestContext(
        { waitUntil: () => {}, childWaitUntilTasks: [] },
        () =>
          startVideoGenerationWithRoute(
            { primary: videoCtx, fallback: null },
            {
              prompt: 'Ocean waves at golden hour',
              sourceImageBase64: Buffer.from([1, 2, 3]).toString('base64'),
              sourceImageMimeType: 'image/jpeg',
              durationSeconds: 5,
              aspectRatio: '16:9',
            },
          ),
      );
      expect(sseCalledDuringStart).toBe(false);
      expect(startRes.result.status).toBe('running');
      expect(startRes.result.providerJobId).toBe('evt_vid_999');
      expect(startRes.result.metadata?.kind).toBe('hf_space_gradio');

      const pollRes = await pollVideoGenerationJob(videoCtx, startRes.result.providerJobId, startRes.result.metadata);
      expect(pollRes.status).toBe('succeeded');
      expect(pollRes.mimeType).toBe('video/mp4');
      expect(pollRes.videoBuffer?.byteLength).toBe(8);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('executes OpenAI-compatible Docker HF Space via /v1/chat/completions', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url === 'https://docker-llm.hf.space/v1/chat/completions') {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: 'پاسخ مستقیم از اسپیس داکر!' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 8 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch;

      const ctx = makeSpaceCtx({
        baseUrl: 'https://docker-llm.hf.space',
        modelIdentifier: 'org/docker-llm::openai::qwen-7b',
        modelParameters: {
          spaceHost: 'https://docker-llm.hf.space',
          openAiCompatible: true,
          openAiModelId: 'qwen-7b',
        },
      });
      const out = await generateTextWithRoute(
        { primary: ctx, fallback: null },
        { messages: [{ role: 'user', content: 'سلام' }] },
      );
      expect(out.result.text).toBe('پاسخ مستقیم از اسپیس داکر!');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('discovers rich Gradio 5 metadata (ImageEditor, Video, min/max)', async () => {
    const mockFetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/gradio_api/info')) {
        return new Response(
          JSON.stringify({
            named_endpoints: {
              '/generate_video': {
                parameters: [
                  { parameter_name: 'prompt', label: 'Prompt', component: 'Textbox', type: { type: 'string' } },
                  {
                    parameter_name: 'duration',
                    label: 'Duration',
                    component: 'Slider',
                    type: { type: 'number', minimum: 2, maximum: 10 },
                    parameter_has_default: true,
                    parameter_default: 5,
                  },
                ],
                returns: [{ label: 'Output Video', component: 'Video', type: { type: 'object' } }],
              },
              '/inpaint': {
                parameters: [
                  {
                    parameter_name: 'canvas',
                    label: 'Canvas',
                    component: 'ImageEditor',
                    python_type: { type: 'EditorData' },
                  },
                  { parameter_name: 'prompt', label: 'Prompt', component: 'Textbox', type: { type: 'string' } },
                ],
                returns: [{ label: 'Result', component: 'Image', type: { type: 'object' } }],
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const res = await discoverProviderModels(
      {
        providerType: 'huggingface_space',
        baseUrl: 'https://studio-multi-demo.hf.space',
        apiKey: 'hf_test_abc',
      },
      mockFetch,
    );
    expect(res.ok).toBe(true);
    expect(res.models.length).toBe(2);

    const vidModel = res.models.find((m) => m.modelIdentifier.endsWith('::generate_video'));
    expect(vidModel).toBeTruthy();
    expect(vidModel!.category).toBe('video');
    expect(vidModel!.capabilities).toEqual(['video_generation']);
    const durParam = (vidModel!.modelParameters?.parameters as Array<{ name: string; min?: number; max?: number }>)?.find(
      (p) => p.name === 'duration',
    );
    expect(durParam?.min).toBe(2);
    expect(durParam?.max).toBe(10);

    const editModel = res.models.find((m) => m.modelIdentifier.endsWith('::inpaint'));
    expect(editModel).toBeTruthy();
    expect(editModel!.category).toBe('image');
    expect(editModel!.capabilities).toContain('image_editing');
    const canvasParam = (editModel!.modelParameters?.parameters as Array<{ name: string; isImageEditor?: boolean }>)?.find(
      (p) => p.name === 'canvas',
    );
    expect(canvasParam?.isImageEditor).toBe(true);
  });

  it('refreshes stale cached txt2img Gradio parameters when image editing requires an image slot', async () => {
    const originalFetch = globalThis.fetch;
    try {
      let calledEndpoint = '';
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/gradio_api/info')) {
          return new Response(
            JSON.stringify({
              named_endpoints: {
                '/txt2img': {
                  parameters: [{ parameter_name: 'prompt', label: 'Prompt', component: 'Textbox' }],
                  returns: [{ label: 'Out', component: 'Image' }],
                },
                '/img_edit': {
                  parameters: [
                    { parameter_name: 'image', label: 'Source Image', component: 'Image' },
                    { parameter_name: 'prompt', label: 'Edit Prompt', component: 'Textbox' },
                  ],
                  returns: [{ label: 'Out', component: 'Image' }],
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.endsWith('/gradio_api/upload')) {
          return new Response(JSON.stringify(['/tmp/src_refresh.png']), { status: 200 });
        }
        if (url.includes('/gradio_api/call/') && init?.method === 'POST') {
          calledEndpoint = url;
          return new Response(JSON.stringify({ event_id: 'evt_refreshed_1' }), { status: 200 });
        }
        if (url.endsWith('/gradio_api/call/img_edit/evt_refreshed_1')) {
          const sse = `event: complete\ndata: [{"url":"https://refresh-demo.hf.space/gradio_api/file=/tmp/edited_ok.png","path":"/tmp/edited_ok.png"}]\n\n`;
          return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        if (url.includes('/file=/tmp/edited_ok.png')) {
          return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
            status: 200,
            headers: { 'Content-Type': 'image/png' },
          });
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch;

      const staleCtx = makeSpaceCtx({
        baseUrl: 'https://refresh-demo.hf.space',
        modelParameters: {
          spaceHost: 'https://refresh-demo.hf.space',
          apiName: 'txt2img',
          endpointPrefix: '/gradio_api',
          parameters: [{ index: 0, name: 'prompt', label: 'Prompt', component: 'textbox', hasDefault: false }],
        },
      });

      const res = await editImageWithRoute(
        { primary: staleCtx, fallback: null },
        {
          prompt: 'Add snow mountains',
          sourceImageBuffer: Buffer.from([1, 2, 3, 4]),
          sourceMimeType: 'image/png',
          mode: 'edit',
        },
      );
      expect(calledEndpoint.endsWith('/gradio_api/call/img_edit')).toBe(true);
      expect(res.result.images.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('hands off slow HF Space image jobs to async pending and finishes via pollMediaGenerationJob', async () => {
    const originalFetch = globalThis.fetch;
    try {
      let pollHit = false;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/gradio_api/call/generate') && init?.method === 'POST') {
          return new Response(JSON.stringify({ event_id: 'evt_slow_img_77' }), { status: 200 });
        }
        if (url.endsWith('/gradio_api/call/generate/evt_slow_img_77')) {
          if (!pollHit) {
            pollHit = true;
            // Hold SSE open until abort signal fires from syncWaitCapMs
            return new Promise<Response>((_, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
              });
            });
          }
          const sse = `event: complete\ndata: [{"url":"https://slow-img.hf.space/gradio_api/file=/tmp/final_img.png","path":"/tmp/final_img.png"}]\n\n`;
          return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        if (url.includes('/file=/tmp/final_img.png')) {
          return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
            status: 200,
            headers: { 'Content-Type': 'image/png' },
          });
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch;

      const ctx = makeSpaceCtx({
        baseUrl: 'https://slow-img.hf.space',
        modelParameters: {
          spaceHost: 'https://slow-img.hf.space',
          apiName: 'generate',
          endpointPrefix: '/gradio_api',
          parameters: [{ index: 0, name: 'prompt', label: 'Prompt', component: 'textbox', hasDefault: false }],
        },
      });

      const started = await startImageGenerationWithRoute(
        { primary: ctx, fallback: null },
        { prompt: 'Epic mountain sunset' },
        { syncWaitCapMs: 500 },
      );
      expect(started.kind).toBe('pending');
      if (started.kind !== 'pending') throw new Error('Expected pending');
      expect(started.providerJobId).toBe('evt_slow_img_77');

      const polled = await pollMediaGenerationJob(ctx, started.providerJobId, started.metadata);
      expect(polled.status).toBe('succeeded');
      expect(polled.images?.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('aborts hung first key, rotates to backup key in pool, and formats redacted multi-key traces', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const secret1 = 'hf_secret_key_alpha_111111';
      const secret2 = 'hf_secret_key_bravo_222222';
      let sawAlpha = false;
      let sawBravo = false;

      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const auth = new Headers(init?.headers).get('authorization') ?? '';
        if (url === 'https://pool-test.hf.space/v1/chat/completions') {
          if (auth.includes(secret1)) {
            sawAlpha = true;
            return new Promise<Response>((_, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
              });
            });
          }
          if (auth.includes(secret2)) {
            sawBravo = true;
            return new Response(
              JSON.stringify({
                choices: [{ message: { content: 'موفق با کلید دوم' }, finish_reason: 'stop' }],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch;

      const key1Ctx = makeSpaceCtx({
        apiKey: secret1,
        credentialLabel: 'Key-Alpha',
        maskedPreview: 'hf_sec...1111',
        baseUrl: 'https://pool-test.hf.space',
        modelParameters: {
          spaceHost: 'https://pool-test.hf.space',
          openAiCompatible: true,
          openAiModelId: 'qwen-7b',
        },
      });
      const key2Ctx = makeSpaceCtx({
        apiKey: secret2,
        credentialLabel: 'Key-Bravo',
        maskedPreview: 'hf_sec...2222',
        baseUrl: 'https://pool-test.hf.space',
        modelParameters: {
          spaceHost: 'https://pool-test.hf.space',
          openAiCompatible: true,
          openAiModelId: 'qwen-7b',
        },
      });
      const pooledPrimary: ProviderExecutionContext = {
        ...key1Ctx,
        credentialPool: [key1Ctx, key2Ctx],
      };

      const okRes = await runWithCloudflareRequestContext(
        { waitUntil: () => {}, childWaitUntilTasks: [] },
        () =>
          generateTextWithRoute(
            { primary: pooledPrimary, fallback: null },
            { messages: [{ role: 'user', content: 'تست سویچ کلید' }] },
          ),
      );
      expect(sawAlpha).toBe(true);
      expect(sawBravo).toBe(true);
      expect(okRes.result.text).toBe('موفق با کلید دوم');

      // Now simulate BOTH keys failing -> verify full redacted multi-key diagnostic trace
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        const auth = new Headers(init?.headers).get('authorization') ?? '';
        if (auth.includes(secret1)) {
          return new Response(`Invalid API key ${secret1}`, { status: 401 });
        }
        return new Response(`Rate limit exceeded for ${secret2}`, { status: 429 });
      }) as typeof fetch;

      let poolError: Error | null = null;
      try {
        await generateTextWithRoute(
          { primary: pooledPrimary, fallback: null },
          { messages: [{ role: 'user', content: 'تست لاگ خطا' }] },
        );
      } catch (err) {
        poolError = err as Error;
      }
      expect(poolError).toBeTruthy();
      expect(poolError!.message).toContain('#1 [HF Space Test · Key-Alpha (hf_sec...1111)');
      expect(poolError!.message).toContain('#2 [HF Space Test · Key-Bravo (hf_sec...2222)');
      expect(poolError!.message).not.toContain(secret1);
      expect(poolError!.message).not.toContain(secret2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 15_000);
});
