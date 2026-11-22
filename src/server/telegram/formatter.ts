import type { Api } from 'grammy';

export function escapeTelegramHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Converts basic Markdown (code fences, inline code, bold) into safe Telegram HTML.
 * Falls back gracefully to plain escaped text if anything looks unbalanced.
 */
export function formatMarkdownToTelegramHtml(raw: string): string {
  const segments: string[] = [];
  const fenceRegex = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      segments.push(formatInlineSegment(raw.slice(lastIndex, match.index)));
    }
    const lang = (match[1] ?? '').trim();
    const code = escapeTelegramHtml((match[2] ?? '').replace(/\n$/, ''));
    segments.push(
      lang
        ? `<pre><code class="language-${escapeTelegramHtml(lang)}">${code}</code></pre>`
        : `<pre>${code}</pre>`,
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < raw.length) {
    segments.push(formatInlineSegment(raw.slice(lastIndex)));
  }

  return segments.join('');
}

function formatInlineSegment(segment: string): string {
  const escaped = escapeTelegramHtml(segment);
  // Inline code `...`
  const withCode = escaped.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // Bold **...**
  const withBold = withCode.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  return withBold;
}

/**
 * Splits long text into Telegram-safe chunks (<= maxLength chars)
 * while preserving fenced code blocks across chunk boundaries.
 */
export function splitTelegramMessage(text: string, maxLength = 3900): string[] {
  const normalized = text.trim();
  if (!normalized) return [''];
  if (normalized.length <= maxLength) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;
  let openFenceLang: string | null = null;

  while (remaining.length > 0) {
    const prefix = openFenceLang !== null ? `\`\`\`${openFenceLang}\n` : '';
    const budget = Math.max(200, maxLength - prefix.length - 12);

    if (remaining.length <= budget) {
      chunks.push(prefix + remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n\n', budget);
    if (splitAt < budget * 0.4) {
      splitAt = remaining.lastIndexOf('\n', budget);
    }
    if (splitAt < budget * 0.4) {
      splitAt = remaining.lastIndexOf(' ', budget);
    }
    if (splitAt <= 0) {
      splitAt = budget;
    }

    let slice = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');

    // Track whether a triple-backtick fence is currently open
    const fenceMatches = slice.match(/```([a-zA-Z0-9_+-]*)/g) ?? [];
    for (const fm of fenceMatches) {
      if (openFenceLang === null) {
        openFenceLang = fm.slice(3);
      } else {
        openFenceLang = null;
      }
    }

    if (openFenceLang !== null) {
      slice += '\n```';
    }

    chunks.push(prefix + slice);
  }

  return chunks;
}

/**
 * Sends a possibly multi-part formatted response to a Telegram chat,
 * automatically falling back to plain text if HTML parsing fails.
 */
export async function sendFormattedTelegramResponse(params: {
  api: Api;
  chatId: number;
  text: string;
  editMessageId?: number | null;
  replyMarkup?: Record<string, unknown>;
}): Promise<number | null> {
  const chunks = splitTelegramMessage(params.text, 3800);
  let lastMessageId: number | null = params.editMessageId ?? null;

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx] ?? '';
    const isLast = idx === chunks.length - 1;
    const html = formatMarkdownToTelegramHtml(chunk);
    const extra: Record<string, unknown> = {
      parse_mode: 'HTML',
      ...(isLast && params.replyMarkup ? { reply_markup: params.replyMarkup } : {}),
    };

    if (idx === 0 && params.editMessageId) {
      try {
        await params.api.editMessageText(params.chatId, params.editMessageId, html, extra as never);
        lastMessageId = params.editMessageId;
        continue;
      } catch {
        try {
          await params.api.editMessageText(
            params.chatId,
            params.editMessageId,
            chunk,
            isLast && params.replyMarkup ? ({ reply_markup: params.replyMarkup } as never) : undefined,
          );
          lastMessageId = params.editMessageId;
          continue;
        } catch {
          // Fall through to sending a fresh message if original was deleted or identical
        }
      }
    }

    try {
      const sent = await params.api.sendMessage(params.chatId, html, extra as never);
      lastMessageId = sent.message_id;
    } catch {
      const sent = await params.api.sendMessage(
        params.chatId,
        chunk,
        isLast && params.replyMarkup ? ({ reply_markup: params.replyMarkup } as never) : undefined,
      );
      lastMessageId = sent.message_id;
    }
  }

  return lastMessageId;
}

/**
 * Creates a throttled streaming editor for Telegram messages (~1.2s interval)
 * so users see incremental output without triggering Telegram FloodWait limits.
 */
export function createThrottledStreamEditor(params: {
  api: Api;
  chatId: number;
  messageId: number;
  minIntervalMs?: number;
}) {
  const minInterval = params.minIntervalMs ?? 1200;
  let lastEditAt = 0;
  let lastText = '';

  return async (accumulated: string): Promise<void> => {
    const now = Date.now();
    if (now - lastEditAt < minInterval) return;
    const preview = accumulated.slice(0, 3800) + (accumulated.length > 3800 ? '…' : ' ▍');
    if (preview === lastText) return;
    lastEditAt = now;
    lastText = preview;
    try {
      await params.api.editMessageText(params.chatId, params.messageId, preview);
    } catch {
      // Ignore Telegram rate-limit or unchanged-text errors during streaming
    }
  };
}
