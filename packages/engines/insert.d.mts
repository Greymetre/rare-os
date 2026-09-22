export function drumBook(units: any[], ctx: any): any;
export function placements(lines: any[], book: any): any;
export function insertedUnits(orderId: string, line: any, lots: any[], options: any): any[];
export function evaluatePlacement(s: any, orderId: string, book: any, rctx: any, env: any): any;
export function simulateInsert(lines: any[], orderId: string, book: any, rctx: any, env: any): any;
export function rushInsert(line: any, orderId: string, book: any, rctx: any, env: any): any;
export function sizeOfCode(code: string): number[] | null;
export function matchOddSize(
  family: string,
  size: number[],
  candidates: any[],
  routings: Map<string, any[]>,
  areaOps: string[],
): any;
export function inheritBom(lines: any[], sourceSize: number[], size: number[]): any;
