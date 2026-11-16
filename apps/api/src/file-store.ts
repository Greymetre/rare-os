// RCH-0: where a photo or a document actually lives.
//
// Planning data belongs in Postgres; a company's selfies, KYC documents and expense receipts do
// not. Thousands of photos in the database would sit in every backup of the planning data and in
// every restore drill. So the bytes go on a disk volume and only the handle stays in a row.
//
// What may be stored at all is decided by packages/engines/file-bytes.mjs, from the bytes
// themselves. This file is the part that touches the disk: the path is derived from the bytes' own
// sha256 and never from anything a caller sent, so there is no path to traverse, and the same
// photo uploaded twice is kept once.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { describeUpload, isStorageKey, storageKey } from '../../../packages/engines/file-bytes.mjs';
import { env, fail } from './core.js';

export {
  FILE_PURPOSES,
  MAX_FILE_BYTES,
  UPLOAD_TYPES,
  isPurpose,
} from '../../../packages/engines/file-bytes.mjs';

// The root of the volume. Kept in the environment so a developer machine and the server can differ.
const root = resolve(env.FILE_STORE_DIR || '/var/lib/rare-os/files');

// Everything that has to be true of an upload before a row is written for it.
export function inspect(bytes: Buffer, declaredType: string) {
  const checked = describeUpload(bytes, declaredType);
  if (checked.error) fail(checked.error.status, checked.error.code, checked.error.message);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    contentType: checked.contentType!,
    sha256,
    storageKey: storageKey(sha256, checked.ext!),
    byteSize: bytes.length,
    pixelWidth: checked.pixelWidth ?? null,
    pixelHeight: checked.pixelHeight ?? null,
  };
}

export function pathOf(key: string) {
  if (!isStorageKey(key)) fail(500, 'FILE_UNREADABLE', 'This file could not be read.');
  const full = resolve(root, key);
  // Belt and braces: the pattern already forbids leaving the root, and this proves it.
  if (!full.startsWith(root + sep)) fail(500, 'FILE_UNREADABLE', 'This file could not be read.');
  return full;
}

// Writes the bytes once. Identical bytes are already there, so a repeat upload costs only a stat.
export async function save(key: string, bytes: Buffer) {
  const full = pathOf(key);
  try {
    if ((await stat(full)).size === bytes.length) return;
  } catch {
    // not there yet
  }
  await mkdir(dirname(full), { recursive: true, mode: 0o750 });
  // Write beside the target and rename, so a reader never sees a half-written photo. The staging
  // name comes from the file's own name, never from the key, which carries directory separators.
  const staging = join(dirname(full), `.${basename(full)}.part`);
  await writeFile(staging, bytes, { mode: 0o640 });
  await rename(staging, full);
}

export async function sizeOnDisk(key: string) {
  try {
    return (await stat(pathOf(key))).size;
  } catch {
    return null;
  }
}

export function readStream(key: string) {
  return createReadStream(pathOf(key));
}

export const storageRoot = root;
