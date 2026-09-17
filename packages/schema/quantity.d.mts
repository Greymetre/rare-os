export function parseQuantity(
  input: unknown,
  decimals: number,
  options?: { allowNegative?: boolean; label?: string },
): { value?: string; error?: string };
