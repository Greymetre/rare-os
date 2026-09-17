export const MAX_IMPORT_BYTES: number;
export const MAX_IMPORT_ROWS: number;
export class CsvError extends Error {
  code: string;
}
export type ImportError = { column: string; message: string };
export type ImportKind = {
  label: string;
  permission: string;
  columns: string[];
  example: string[][];
  validate(raw: Record<string, string>): { value: any; errors: ImportError[] };
  key(value: any): string;
};
export const IMPORT_KINDS: Record<string, ImportKind>;
export function parseCsv(
  input: string,
  options?: { maxRows?: number },
): { line: number; values: string[] }[];
export function toCsv(rows: unknown[][]): string;
export function importKind(kind: string): ImportKind | null;
export function templateCsv(kind: string): string;
export function readImport(
  kind: string,
  text: string,
): { line: number; data: Record<string, string>; columnCountError?: string }[];
export function validateRows(
  kind: string,
  rows: { line: number; data: Record<string, string>; columnCountError?: string }[],
): { line: number; value: any; errors: ImportError[] }[];
