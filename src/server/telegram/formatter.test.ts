import { describe, expect, it } from 'vitest';
import {
  formatMarkdownToTelegramHtml,
  splitTelegramMessage,
} from './formatter.ts';

describe('Telegram Message Formatter & Splitter', () => {
  it('splits long messages while keeping code fences balanced per chunk', () => {
    const longCode = 'const x = 42;\n'.repeat(300);
    const input = `مقدمه فارسی:\n\n\`\`\`ts\n${longCode}\`\`\`\n\nپایان.`;
    const chunks = splitTelegramMessage(input, 800);

    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(820);
      const fenceCount = (chunk.match(/```/g) ?? []).length;
      expect(fenceCount % 2).toBe(0);
    }
  });

  it('safely escapes HTML entities while formatting bold and inline code', () => {
    const html = formatMarkdownToTelegramHtml('سلام **کاربر**! تگ `<script>` امن است.');
    expect(html).toContain('<b>کاربر</b>');
    expect(html).toContain('<code>&lt;script&gt;</code>');
    expect(html).not.toContain('<script>');
  });
});
