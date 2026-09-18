import type { MasterField } from './masters.mjs';
type Result = { value: any; errors: { column: string; message: string; line?: number }[] };
export const RESOURCE_FIELDS: MasterField[];
export const CALENDAR_FIELDS: MasterField[];
export const BOM_HEADER_FIELDS: MasterField[];
export const BOM_LINE_FIELDS: MasterField[];
export const ROUTING_HEADER_FIELDS: MasterField[];
export const ROUTING_OPERATION_FIELDS: MasterField[];
export function validateResource(raw: unknown): Result;
export function validateCalendar(raw: any): Result;
export function validateBom(raw: any): Result;
export function validateRouting(raw: any): Result;
export const GROUPED_IMPORTS: Record<
  string,
  {
    label: string;
    headerFields: MasterField[];
    lineFields: MasterField[];
    linesKey: string;
    groupKey(raw: any): string;
    validate(raw: any): Result;
    example: string[][];
  }
>;
export type GroupedImport = {
  label: string;
  headerFields: MasterField[];
  lineFields: MasterField[];
  linesKey: string;
  groupKey(raw: any): string;
  validate(raw: any): Result;
  example: string[][];
  permission?: string;
};
export function groupRows(
  kind: string | GroupedImport,
  rows: { line: number; data: Record<string, string> }[],
): {
  key: string;
  rows: { line: number; data: Record<string, string> }[];
  raw: any;
  mismatch: Map<number, string>;
}[];
