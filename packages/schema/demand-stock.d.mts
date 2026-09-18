import type { MasterField } from './masters.mjs';
import type { GroupedImport } from './plant-model.mjs';
type Result = { value: any; errors: { column: string; message: string }[] };
export const STOCK_LOCATION_FIELDS: MasterField[];
export const MOVEMENT_TYPES: string[];
export const MOVEMENT_PERMISSIONS: Record<'OPENING' | 'RECEIPT' | 'ISSUE' | 'ADJUSTMENT', string>;
export const MOVEMENT_FIELDS: MasterField[];
export const SALES_ORDER_HEADER_FIELDS: MasterField[];
export const SALES_ORDER_LINE_FIELDS: MasterField[];
export const PURCHASE_ORDER_HEADER_FIELDS: MasterField[];
export const PURCHASE_ORDER_LINE_FIELDS: MasterField[];
export const DEMAND_HISTORY_FIELDS: MasterField[];
export function validateStockLocation(raw: any): Result;
export function validateMovement(raw: any, options?: { requireExternalRef?: boolean }): Result;
export function validateSalesOrder(raw: any, options?: { requireNumber?: boolean }): Result;
export function validatePurchaseOrder(raw: any, options?: { requireNumber?: boolean }): Result;
export function validateDemandHistory(raw: any): Result;
export const ORDER_IMPORTS: Record<
  'sales_orders' | 'purchase_orders',
  GroupedImport & { permission: string }
>;
