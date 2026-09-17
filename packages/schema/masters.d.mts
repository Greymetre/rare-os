export type MasterField = {
  name: string;
  label: string;
  type: 'code' | 'text' | 'enum' | 'int' | 'decimal' | 'email' | 'phone' | 'bool' | 'ref';
  required?: boolean;
  immutable?: boolean;
  max?: number;
  min?: number;
  options?: string[];
  decimals?: number;
  positive?: boolean;
  ref?: 'units' | 'items' | 'suppliers';
  default?: unknown;
};
export type MasterKind = {
  label: string;
  singular: string;
  permission: string;
  table: string;
  fields: MasterField[];
  key(value: any): string;
  title(value: any): string;
};
export const MASTER_KINDS: Record<string, MasterKind>;
export function masterKind(kind: string): MasterKind | null;
export function validateMaster(
  kind: string,
  raw: Record<string, unknown> | null | undefined,
): { value: any; errors: { column: string; message: string }[] };
