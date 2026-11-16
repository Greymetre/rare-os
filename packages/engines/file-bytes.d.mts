export const MAX_FILE_BYTES: number;
export const MAX_PIXELS_PER_SIDE: number;
export const FILE_PURPOSES: string[];
export const UPLOAD_TYPES: string[];
export const UPLOAD_EXTENSIONS: string[];
export function isPurpose(value: unknown): boolean;
export function storageKey(sha256: string, ext: string): string;
export function isStorageKey(key: unknown): boolean;
// One shape rather than a union: `fail` throws but is not typed as never, so callers read the
// refusal, call fail, and then assert the rest — the same way the other controllers do.
export function describeUpload(
  bytes: Buffer,
  declaredType: unknown,
): {
  contentType?: string;
  ext?: string;
  pixelWidth?: number | null;
  pixelHeight?: number | null;
  error?: { status: number; code: string; message: string };
};
