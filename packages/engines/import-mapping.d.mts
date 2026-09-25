export const SOURCE_ALIASES: Record<string, string[]>;
export function columnScore(field: string, header: string): number;
export function suggestMapping(
  fields: string[],
  header: any[],
  options?: { threshold?: number },
): { columns: Record<string, any>; unmatched: string[]; unused: any[] };
export function headerFingerprint(header: any[]): string;
export function resolveMapping(
  mapping: any,
  header: any[],
): { columns: Record<string, any>; problems: { field: string; message: string }[] };
export function parseNumber(
  text: unknown,
  options?: { decimal?: string },
): { value: string; blank?: boolean; issue?: string };
export function parseDate(
  text: unknown,
  options?: { format?: string },
): { value: string; blank?: boolean; issue?: string };
export function normaliseUnit(
  text: unknown,
  aliases?: Record<string, string>,
): { value: string; blank?: boolean; alias?: string };
export function mapRow(
  resolved: any,
  cells: string[],
  options?: any,
): {
  values: Record<string, string>;
  sources: Record<string, any>;
  issues: { field: string; column: number; message: string }[];
};
export function isBlankRow(cells: string[]): boolean;
export function translate(
  value: unknown,
  map?: Record<string, string>,
): { value: string; from?: string };
export const FILTER_OPERATORS: string[];
export function describeFilter(filter: { field: string; op: string; value?: string }): string;
export function rowPasses(
  values: Record<string, string>,
  filters?: { field: string; op: string; value?: string }[],
): { ok: boolean; rule?: string };
export function reconcile(input: any): any;
