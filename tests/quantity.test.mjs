import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuantity } from '../packages/schema/quantity.mjs';

test('quantities are exact decimal strings limited by the unit precision', () => {
  assert.deepEqual(parseQuantity('12', 0), { value: '12' });
  assert.deepEqual(parseQuantity('0012.500', 3), { value: '12.5' });
  for (const ambiguous of ['1,250.125', '1,5'])
    assert.match(parseQuantity(ambiguous, 3).error, /must not contain commas/);
  assert.deepEqual(
    parseQuantity(0.1 + 0.2, 6).error,
    'Quantity can have at most 6 decimal place(s) for this unit.',
  );
  assert.match(parseQuantity('2.5', 0).error, /whole number/);
  assert.match(parseQuantity('1.2345', 3).error, /at most 3 decimal/);
  assert.match(parseQuantity('-4', 3).error, /cannot be negative/);
  assert.deepEqual(parseQuantity('-4.50', 3, { allowNegative: true }), { value: '-4.5' });
  assert.deepEqual(parseQuantity('-0.000', 3, { allowNegative: true }), { value: '0' });
  for (const bad of ['', 'abc', '1e3', '12.', '.5', '1..2', null, undefined])
    assert.match(
      parseQuantity(bad, 3, { label: 'Stock' }).error,
      /Stock must be a number/,
      String(bad),
    );
  assert.match(parseQuantity('1234567890123', 0).error, /too large/);
  assert.match(parseQuantity('1', 7).error, /between 0 and 6/);
});
