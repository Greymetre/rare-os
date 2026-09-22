export const READINESS_LABELS: Record<string, string>;
export function orderTimes(pass: any, dayMinutes: number): Map<string, any>;
export function materialReadiness(pass: any, ctx: any): Map<string, any>;
export function snapshot(seq: any[], ctx: any): any;
export function impact(before: any, after: any, id?: string | null): any;
export function evaluate(
  base: any,
  seq: any[],
  ids: string[],
  groups: any[],
  ctx: any,
  kind: string,
): any;
export function compareClub(
  current: any[],
  groups: any[],
  itemId: string,
  ctx: any,
  options?: any,
): any;
export function drumChangeovers(seq: any[], ctx: any): any;
