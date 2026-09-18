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

// Exact decimal arithmetic on canonical strings (BigInt), for unit conversions.
const SCALE = 12;
function toScaled(text) {
  const [, sign, whole, fraction = ''] = /^(-)?(\d+)(?:\.(\d+))?$/.exec(String(text));
  const digits = BigInt(whole + fraction.padEnd(SCALE, '0').slice(0, SCALE));
  return sign ? -digits : digits;
}
function fromScaled(value, scale = SCALE) {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale),
    fraction = digits.slice(-scale).replace(/0+$/, '');
  return (negative ? '-' : '') + whole + (fraction ? '.' + fraction : '');
}
// a × b, exact up to 12 decimal places (inputs have at most 12).
export function multiplyDecimal(a, b) {
  return fromScaled((toScaled(a) * toScaled(b)) / 10n ** BigInt(SCALE));
}
// a ÷ b rounded half-up to `scale` decimal places.
export function divideDecimal(a, b, scale = SCALE) {
  const n = toScaled(a) * 10n ** BigInt(scale),
    d = toScaled(b);
  if (d === 0n) throw Error('Division by zero');
  let q = n / d;
  const r = n % d;
  if ((r < 0n ? -r : r) * 2n >= (d < 0n ? -d : d)) q += n < 0n !== d < 0n ? -1n : 1n;
  return fromScaled(q, scale);
}
export function addDecimal(a, b) {
  return fromScaled(toScaled(a) + toScaled(b));
}
