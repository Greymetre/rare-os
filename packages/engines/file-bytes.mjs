// RCH-0: what has to be true of an uploaded photo or document, decided from the bytes themselves.
// Pure: no filesystem, no database, no HTTP. The API turns a refusal here into a status code.
//
// Why read the bytes at all: the content type a browser sends is a claim, and the file name is a
// claim. The file is served back later with the type we stored, so the type has to be something
// the file really is. A script renamed to .jpg must be refused at the door, not discovered later.

// A phone photo scaled down on the phone is a few hundred kilobytes; a scanned KYC page is more.
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
// Refuse an image whose own header claims a size no camera produces: decoding it later would cost
// far more memory than the file size suggests.
export const MAX_PIXELS_PER_SIDE = 10000;
export const FILE_PURPOSES = ['selfie', 'kyc', 'receipt', 'shelf', 'other'];

const startsWith = (bytes, prefix) =>
  bytes.length > prefix.length && prefix.every((b, i) => bytes[i] === b);

function pngSize(b) {
  // The signature, then the IHDR chunk: its width and height are the first two big-endian words.
  return b.length >= 24 ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null;
}

function jpegSize(b) {
  // Walk the segment chain to the frame header, the only segment that carries the size.
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    const length = b.readUInt16BE(at + 2);
    if (length < 2) return null;
    // SOF0..SOF15, less the define-huffman-table, define-arithmetic and restart markers.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { height: b.readUInt16BE(at + 5), width: b.readUInt16BE(at + 7) };
    at += 2 + length;
  }
  return null;
}

function webpSize(b) {
  if (b.length < 30) return null;
  const chunk = b.toString('ascii', 12, 16);
  // Lossy: a 14-bit width and height follow the frame tag.
  if (chunk === 'VP8 ')
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  // Extended: 24-bit width and height, each stored one less than the real value.
  if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  // Lossless: 14 bits each, packed little-endian straight after the signature byte.
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

// The types a browser or a phone actually sends, each with the bytes it has to begin with.
const TYPES = {
  'image/jpeg': {
    ext: 'jpg',
    looksRight: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
    size: jpegSize,
  },
  'image/png': {
    ext: 'png',
    looksRight: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    size: pngSize,
  },
  'image/webp': {
    ext: 'webp',
    looksRight: (b) =>
      b.length > 16 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP',
    size: webpSize,
  },
  'application/pdf': {
    ext: 'pdf',
    looksRight: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]),
  },
};

export const UPLOAD_TYPES = Object.keys(TYPES);
export const UPLOAD_EXTENSIONS = UPLOAD_TYPES.map((t) => TYPES[t].ext);

export function isPurpose(value) {
  return typeof value === 'string' && FILE_PURPOSES.includes(value);
}

// Two levels of fan-out, so a company's photos never pile into one directory.
export function storageKey(sha256, ext) {
  return `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.${ext}`;
}

// A key only ever comes from one of our own rows, but it decides a path, so it is checked like
// input every time it is used.
const keyPattern = new RegExp(
  `^[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{64}\\.(${UPLOAD_EXTENSIONS.join('|')})$`,
);
export function isStorageKey(key) {
  return typeof key === 'string' && keyPattern.test(key);
}

// Returns { contentType, ext, pixelWidth, pixelHeight } for bytes that may be stored, or
// { error: { status, code, message } } with the reason they may not. Never throws on user data.
export function describeUpload(bytes, declaredType) {
  const refuse = (status, code, message) => ({ error: { status, code, message } });
  const type = String(declaredType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const def = TYPES[type];
  if (!def)
    return refuse(
      415,
      'UNSUPPORTED_FILE_TYPE',
      `Upload a JPEG, PNG or WebP image, or a PDF. This file is ${type || 'of an unknown type'}.`,
    );
  if (!bytes?.length)
    return refuse(400, 'EMPTY_FILE', 'This file is empty. Choose another and try again.');
  if (bytes.length > MAX_FILE_BYTES)
    return refuse(
      413,
      'FILE_TOO_LARGE',
      `This file is larger than ${MAX_FILE_BYTES / 1048576} MB. Take the photo again at a smaller size.`,
    );
  if (!def.looksRight(bytes))
    return refuse(
      415,
      'FILE_TYPE_MISMATCH',
      `This file is not really a ${type}. Choose the original photo or document.`,
    );
  const measured = def.size?.(bytes) ?? null;
  const known = measured && measured.width > 0 && measured.height > 0;
  if (known && (measured.width > MAX_PIXELS_PER_SIDE || measured.height > MAX_PIXELS_PER_SIDE))
    return refuse(
      413,
      'IMAGE_TOO_LARGE',
      `This image is larger than ${MAX_PIXELS_PER_SIDE} pixels on a side. Send a scaled-down photo.`,
    );
  return {
    contentType: type,
    ext: def.ext,
    pixelWidth: known ? measured.width : null,
    pixelHeight: known ? measured.height : null,
  };
}
