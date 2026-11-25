// Types for `field-payloads.mjs`. These exist so that a screen cannot call a builder without the
// fields it needs: a missing shop id or work type should be a red squiggle in the editor, not a
// blocked item in a rep's queue at six in the evening.

export type Fix = {
  latitude: number | null;
  longitude: number | null;
  accuracy_m: number | null;
};

export type OrderLine = { item_id: string; units: number };

export const SOURCE: 'DEVICE';

export function dayStart(args: {
  workTypeId: string;
  fix?: Fix;
  fileId?: string | null;
  note?: string;
}): Record<string, unknown>;

export function dayEnd(args: { fix?: Fix; version?: number }): Record<string, unknown>;

export function photo(args: { purpose: string; name?: string }): {
  purpose: string;
  name: string;
};

export function checkIn(args: {
  customerId: string;
  fix?: Fix;
  fileId?: string | null;
  note?: string;
}): Record<string, unknown>;

export function order(args: {
  customerId: string;
  visitId?: string | null;
  lines: OrderLine[];
  note?: string;
}): Record<string, unknown>;

export function receipt(args: {
  customerId: string;
  amount: number;
  mode: string;
  reference?: string;
  fix?: Fix;
  invoiceId?: string | null;
  receivedOn?: string;
  fileId?: string | null;
}): Record<string, unknown>;

export function checkOut(args: {
  visitId: string;
  version?: number;
  answers?: Record<string, string>;
  fix?: Fix;
}): Record<string, unknown>;

export const PAYLOAD_FOR: Record<string, (args: never) => Record<string, unknown>>;
