// Quantities are exact decimal strings (PostgreSQL numeric(18,6)); never JavaScript floats.
// A unit's `decimals` limits precision, e.g. NOS = 0 (whole pieces), KG = 3 (grams).

const MAX_INTEGER_DIGITS = 12;

export function parseQuantity(input, decimals, { allowNegative = false, label = 'Quantity' } = {}) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6)
    return { error: 'Unit decimals must be between 0 and 6.' };
  const text = typeof input === 'number' ? String(input) : String(input ?? '').trim();
  // "1,5" may mean 1.5 or 15 depending on the writer, so separators are rejected, not guessed.
  if (text.includes(','))
    return { error: `${label} must not contain commas. Write 1250.5, not 1,250.5.` };
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return { error: `${label} must be a number, for example 12 or 12.5.` };
  const [, sign, whole, fraction = ''] = match;
  if (sign && !allowNegative) return { error: `${label} cannot be negative.` };
  const integer = whole.replace(/^0+(?=\d)/, '');
  if (integer.length > MAX_INTEGER_DIGITS) return { error: `${label} is too large.` };
  const trimmed = fraction.replace(/0+$/, '');
  if (trimmed.length > decimals)
    return {
      error:
        decimals === 0
          ? `${label} must be a whole number for this unit.`
          : `${label} can have at most ${decimals} decimal place(s) for this unit.`,
    };
  const value =
    (sign && (integer !== '0' || trimmed) ? '-' : '') + integer + (trimmed ? '.' + trimmed : '');
  return { value };
}
