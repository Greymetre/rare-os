export type MasterField = {
  name: string;
  label: string;
  type:
    | 'code'
    | 'text'
    | 'enum'
    | 'int'
    | 'decimal'
    | 'email'
    | 'phone'
    | 'bool'
    | 'ref'
    | 'date'
    | 'revision';
  required?: boolean;
  immutable?: boolean;
  max?: number;
  min?: number;
  options?: string[];
  decimals?: number;
  positive?: boolean;
  ref?: string;
  maxValue?: number;
  belowValue?: number;
  default?: unknown;
};
export type MasterKind = {
  label: string;
  singular: string;
  // Which module maintains this master, so a module's screens offer only its own.
  module: string;
  permission: string;
  // Reading and removing can need their own permissions; without them, reading falls back to
  // masters.read and the kind cannot be removed at all.
  readPermission?: string;
  deletePermission?: string;
  softDelete?: boolean;
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
export function validateFields(
  fields: MasterField[],
  raw: Record<string, unknown> | null | undefined,
): { value: any; errors: { column: string; message: string }[] };
