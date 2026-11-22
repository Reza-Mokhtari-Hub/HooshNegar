import { describe, expect, it } from 'vitest';
import {
  extractDocumentContent,
  validateAudioFile,
  validateUploadedFile,
} from './documentService.ts';

describe('Document & Audio File Validation', () => {
  it('blocks executable extensions and ELF/PE binary headers', () => {
    const exeCheck = validateUploadedFile({
      fileName: 'payload.exe',
      mimeType: 'application/octet-stream',
      sizeBytes: 120,
      maxSizeMb: 10,
    });
    expect(exeCheck.ok).toBe(false);

    const elfBuffer = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
    const disguisedCheck = validateUploadedFile({
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      sizeBytes: elfBuffer.byteLength,
      maxSizeMb: 10,
      buffer: elfBuffer,
    });
    expect(disguisedCheck.ok).toBe(false);
  });

  it('enforces plan file size limits and PDF magic bytes', () => {
    const oversized = validateUploadedFile({
      fileName: 'huge.txt',
      mimeType: 'text/plain',
      sizeBytes: 12 * 1024 * 1024,
      maxSizeMb: 10,
    });
    expect(oversized.ok).toBe(false);

    const fakePdf = validateUploadedFile({
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 16,
      maxSizeMb: 10,
      buffer: Buffer.from('NOT_A_PDF_HEADER'),
    });
    expect(fakePdf.ok).toBe(false);
  });

  it('extracts TXT and CSV document text safely without execution', async () => {
    const csvBuf = Buffer.from('name,score\nAli,98\nSara,95\n', 'utf8');
    const res = await extractDocumentContent({
      buffer: csvBuf,
      fileName: 'scores.csv',
      mimeType: 'text/csv',
      maxSizeMb: 5,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.kind).toBe('csv');
      expect(res.data.textContent).toContain('Ali,98');
    }
  });

  it('validates supported Telegram voice and audio formats', () => {
    expect(
      validateAudioFile({
        mimeType: 'audio/ogg',
        fileName: 'voice.ogg',
        sizeBytes: 24000,
        maxSizeMb: 10,
      }).ok,
    ).toBe(true);

    expect(
      validateAudioFile({
        mimeType: 'application/x-msdownload',
        fileName: 'malware.exe',
        sizeBytes: 24000,
        maxSizeMb: 10,
      }).ok,
    ).toBe(false);
  });
});
