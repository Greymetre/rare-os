export function penetration(
  planned: number,
  elapsed: number,
  bufferPct: number,
): { buffer: number; penetration: number; ok: boolean };
export function adherence(rows: any[]): { completions: number; inside: number; pct: number | null };
export function auditRows(completions: any[], standards: Map<string, number>, options?: any): any[];
export function correctedOperations(operations: any[], scale: number): any[];
export function atRisk(before: Map<string, any>, after: Map<string, any>): any[];
