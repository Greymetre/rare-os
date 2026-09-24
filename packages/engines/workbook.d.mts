export class WorkbookError extends Error {
  code: string;
}
export function workbookFormat(buffer: Buffer | Uint8Array): 'xlsx' | 'xls' | null;
export function decodeXml(text: string): string;
export function excelDate(serial: unknown, epoch1904?: boolean): string | null;
export function isDateFormat(code: unknown, formatText?: string | null): boolean;
export function columnIndex(reference: unknown): number;
export function openWorkbook(
  buffer: Buffer | Uint8Array,
  options?: { maxRows?: number; maxColumns?: number },
): {
  format: 'xlsx' | 'xls';
  sheets: { name: string; hidden: boolean }[];
  rows(
    sheetName?: string,
    options?: { maxRows?: number; maxColumns?: number },
  ): Generator<{ row: number; cells: string[] }>;
};
export function headerColumns(
  cells: string[],
): { index: number; name: string; occurrence: number; duplicate: boolean }[];
