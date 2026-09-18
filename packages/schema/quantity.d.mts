export function parseQuantity(
  input: unknown,
  decimals: number,
  options?: { allowNegative?: boolean; label?: string },
): { value?: string; error?: string };
export function multiplyDecimal(a: string, b: string): string;
export function divideDecimal(a: string, b: string, scale?: number): string;
export function addDecimal(a: string, b: string): string;
