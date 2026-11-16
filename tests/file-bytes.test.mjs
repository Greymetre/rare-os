// RCH-0: a photo or a document is judged on its own bytes, not on what the browser called it.
// These are the rules that stand between an upload and the volume it would be written to.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FILE_PURPOSES,
  MAX_FILE_BYTES,
  MAX_PIXELS_PER_SIDE,
  UPLOAD_TYPES,
  describeUpload,
  isPurpose,
  isStorageKey,
  storageKey,
} from '../packages/engines/file-bytes.mjs';

const sha = 'a'.repeat(64);

function png(width, height) {
  const b = Buffer.alloc(30);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function jpeg(width, height) {
  const b = Buffer.alloc(39);
  Buffer.from([0xff, 0xd8]).copy(b, 0);
  // An APP0 segment first, so the walk has to step over something before the frame header.
  Buffer.from([0xff, 0xe0]).copy(b, 2);
  b.writeUInt16BE(16, 4);
  Buffer.from([0xff, 0xc0]).copy(b, 20);
  b.writeUInt16BE(17, 22);
  b[24] = 8;
  b.writeUInt16BE(height, 25);
  b.writeUInt16BE(width, 27);
  return b;
}

function webp(chunk, fill) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'ascii');
  b.write(chunk, 12, 'ascii');
  b.writeUInt32LE(10, 16);
  fill(b);
  return b;
}

const pdf = () => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(100)]);

test('a real JPEG, PNG and PDF are accepted, and their size is read from the file itself', () => {
  const p = describeUpload(png(640, 480), 'image/png');
  assert.equal(p.error, undefined);
  assert.deepEqual(
    [p.contentType, p.ext, p.pixelWidth, p.pixelHeight],
    ['image/png', 'png', 640, 480],
  );
  const j = describeUpload(jpeg(1024, 768), 'image/jpeg');
  assert.equal(j.error, undefined);
  assert.deepEqual([j.pixelWidth, j.pixelHeight], [1024, 768]);
  // A PDF has pages, not pixels.
  const d = describeUpload(pdf(), 'application/pdf');
  assert.equal(d.error, undefined);
  assert.deepEqual([d.ext, d.pixelWidth, d.pixelHeight], ['pdf', null, null]);
});

test('all three WebP shapes a phone or a canvas produces are measured', () => {
  const lossy = webp('VP8 ', (b) => {
    Buffer.from([0x9d, 0x01, 0x2a]).copy(b, 23);
    b.writeUInt16LE(320, 26);
    b.writeUInt16LE(240, 28);
  });
  const extended = webp('VP8X', (b) => {
    b.writeUIntLE(799, 24, 3);
    b.writeUIntLE(599, 27, 3);
  });
  const lossless = webp('VP8L', (b) => {
    b[20] = 0x2f;
    b.writeUInt32LE((99 << 14) | 49, 21);
  });
  assert.deepEqual(
    [lossy, extended, lossless].map((b) => {
      const r = describeUpload(b, 'image/webp');
      return [r.pixelWidth, r.pixelHeight];
    }),
    [
      [320, 240],
      [800, 600],
      [50, 100],
    ],
  );
});

test('the declared content type is normalised, and a type we do not serve is refused', () => {
  assert.equal(describeUpload(png(2, 2), ' IMAGE/PNG ; charset=binary').contentType, 'image/png');
  for (const type of ['text/html', 'application/zip', 'image/svg+xml', '', undefined, null]) {
    const r = describeUpload(png(2, 2), type);
    assert.equal(r.error?.status, 415, String(type));
    assert.equal(r.error?.code, 'UNSUPPORTED_FILE_TYPE', String(type));
  }
  assert.match(describeUpload(png(2, 2), 'text/html').error.message, /JPEG, PNG or WebP/);
});

test('a file that is not what it claims to be is refused before anything is written', () => {
  // The classic: a script renamed to .jpg, sent as an image.
  const script = Buffer.from('<?php system($_GET["c"]); ?>');
  const mismatch = describeUpload(script, 'image/jpeg');
  assert.equal(mismatch.error?.status, 415);
  assert.equal(mismatch.error?.code, 'FILE_TYPE_MISMATCH');
  // And the other way round: real PNG bytes sent as a PDF.
  assert.equal(describeUpload(png(2, 2), 'application/pdf').error?.code, 'FILE_TYPE_MISMATCH');
  assert.equal(describeUpload(pdf(), 'image/png').error?.code, 'FILE_TYPE_MISMATCH');
});

test('an empty, an oversized and a pixel-bomb upload are each refused with their own reason', () => {
  assert.equal(describeUpload(Buffer.alloc(0), 'image/png').error?.code, 'EMPTY_FILE');
  const huge = Buffer.alloc(MAX_FILE_BYTES + 1);
  png(2, 2).copy(huge, 0);
  const tooBig = describeUpload(huge, 'image/png');
  assert.equal(tooBig.error?.status, 413);
  assert.equal(tooBig.error?.code, 'FILE_TOO_LARGE');
  // A 50,000 x 50,000 header is 20 bytes of file and gigabytes of decoded image.
  const bomb = describeUpload(png(MAX_PIXELS_PER_SIDE + 1, 10), 'image/png');
  assert.equal(bomb.error?.status, 413);
  assert.equal(bomb.error?.code, 'IMAGE_TOO_LARGE');
  // A header we cannot read is stored without a size rather than refused.
  const unreadable = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(40)]);
  const r = describeUpload(unreadable, 'image/jpeg');
  assert.equal(r.error, undefined);
  assert.deepEqual([r.pixelWidth, r.pixelHeight], [null, null]);
});

test('a storage key is built from the bytes and never trusted on the way back', () => {
  assert.equal(storageKey(sha, 'jpg'), `aa/aa/${sha}.jpg`);
  assert.ok(isStorageKey(`aa/aa/${sha}.jpg`));
  for (const bad of [
    '../../../etc/passwd',
    `aa/aa/${sha}.exe`,
    `aa/aa/${sha}.jpg/../../../etc/passwd`,
    `AA/AA/${sha.toUpperCase()}.jpg`,
    `aa/${sha}.jpg`,
    `aa/aa/${sha}.jpg\u0000.png`,
    '',
    null,
    undefined,
    42,
  ])
    assert.equal(isStorageKey(bad), false, String(bad));
});

test('a file has to say what it is for, and the list matches what the database allows', () => {
  for (const purpose of FILE_PURPOSES) assert.ok(isPurpose(purpose), purpose);
  for (const bad of ['', 'SELFIE', 'payslip', null, 1, {}]) assert.equal(isPurpose(bad), false);
  assert.deepEqual(FILE_PURPOSES, ['selfie', 'kyc', 'receipt', 'shelf', 'other']);
  assert.deepEqual(UPLOAD_TYPES, ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
});
