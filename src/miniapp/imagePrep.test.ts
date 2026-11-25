import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseOutputMimeType,
  computeTargetDimensions,
  estimateBase64ByteLength,
  formatImageSizeLabel,
  isAllowedImageFile,
  normalizeImageMimeType,
  shouldOptimizeImage,
} from './imagePrep';

test('isAllowedImageFile accepts jpg/png/webp by mime or filename', () => {
  assert.equal(isAllowedImageFile({ type: 'image/jpeg', name: 'a.bin' }), true);
  assert.equal(isAllowedImageFile({ type: 'image/png', name: 'b' }), true);
  assert.equal(isAllowedImageFile({ type: 'image/webp', name: 'c' }), true);
  assert.equal(isAllowedImageFile({ type: '', name: 'photo.JPEG' }), true);
  assert.equal(isAllowedImageFile({ type: 'application/pdf', name: 'doc.pdf' }), false);
  assert.equal(isAllowedImageFile({ type: 'image/gif', name: 'anim.gif' }), false);
});

test('normalizeImageMimeType resolves canonical mime types', () => {
  assert.equal(normalizeImageMimeType('image/jpg'), 'image/jpeg');
  assert.equal(normalizeImageMimeType('', 'sample.png'), 'image/png');
  assert.equal(normalizeImageMimeType('', 'sample.WEBP'), 'image/webp');
  assert.equal(normalizeImageMimeType(undefined, undefined), 'image/jpeg');
});

test('computeTargetDimensions preserves aspect ratio within max dimension', () => {
  assert.deepEqual(computeTargetDimensions(1024, 1024, 1536), {
    width: 1024,
    height: 1024,
    resized: false,
  });

  assert.deepEqual(computeTargetDimensions(4000, 3000, 1536), {
    width: 1536,
    height: 1152,
    resized: true,
  });

  assert.deepEqual(computeTargetDimensions(1080, 3072, 1536), {
    width: 540,
    height: 1536,
    resized: true,
  });
});

test('chooseOutputMimeType switches oversized PNGs to WebP while keeping compact PNG lossless', () => {
  assert.equal(chooseOutputMimeType('image/png', 300 * 1024, false), 'image/png');
  assert.equal(chooseOutputMimeType('image/png', 2 * 1024 * 1024, true), 'image/webp');
  assert.equal(chooseOutputMimeType('image/jpeg', 3 * 1024 * 1024, true), 'image/jpeg');
  assert.equal(chooseOutputMimeType('image/webp', 3 * 1024 * 1024, true), 'image/webp');
});

test('shouldOptimizeImage detects large files or oversized resolutions', () => {
  assert.equal(shouldOptimizeImage({ sizeBytes: 400 * 1024, width: 1024, height: 1024 }), false);
  assert.equal(shouldOptimizeImage({ sizeBytes: 1500 * 1024, width: 1024, height: 1024 }), true);
  assert.equal(shouldOptimizeImage({ sizeBytes: 400 * 1024, width: 2048, height: 1024 }), true);
});

test('estimateBase64ByteLength and formatImageSizeLabel handle sizes cleanly', () => {
  const sample = Buffer.from('HelloWorld123').toString('base64');
  assert.equal(estimateBase64ByteLength(sample), 13);
  assert.equal(estimateBase64ByteLength(`data:image/png;base64,${sample}`), 13);
  assert.equal(estimateBase64ByteLength(''), 0);

  assert.ok(formatImageSizeLabel(512 * 1024).includes('کیلوبایت'));
  assert.ok(formatImageSizeLabel(2.5 * 1024 * 1024).includes('مگابایت'));
});
