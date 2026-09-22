export function expediteRows(
  snap: any,
  ids: string[],
  supply: Map<string, any[]>,
  asOf: string,
): any[];
export function mergeActions(existing: any[], rows: any[]): any[];
export const confirmationState: (action: any, date: string) => string;
export function confirmedSupply(supply: Map<string, any[]>, actions: any[]): Map<string, any[]>;
export const ORDER_STATES: Record<string, string>;
export const PENDING: string[];
export function orderState(id: string, material: any, plan: any, actions: any[]): string;
export function bundleState(list: any[]): string;
export function laterDates(options: any): any;
