import test from 'node:test';
import assert from 'node:assert/strict';
import { addDecimal, divideDecimal, multiplyDecimal } from '../packages/schema/quantity.mjs';
import {
  validateDemandHistory,
  validateMovement,
  validatePurchaseOrder,
  validateSalesOrder,
  validateStockLocation,
  ORDER_IMPORTS,
} from '../packages/schema/demand-stock.mjs';
import { readImport, validateRows } from '../packages/schema/imports.mjs';
import { groupRows } from '../packages/schema/plant-model.mjs';

const messages = (r) => r.errors.map((e) => e.message).join(' | ');

test('exact decimal arithmetic for unit conversions and running balances', () => {
  assert.equal(multiplyDecimal('2.5', '25'), '62.5');
  assert.equal(multiplyDecimal('0.001', '0.001'), '0.000001');
  assert.equal(multiplyDecimal('-1.5', '2'), '-3');
  assert.equal(divideDecimal('1', '3'), '0.333333333333');
  assert.equal(divideDecimal('2', '3', 2), '0.67');
  assert.equal(divideDecimal('-2', '3', 2), '-0.67');
  assert.equal(addDecimal('150', '-30.5'), '119.5');
  assert.equal(addDecimal('0.1', '0.2'), '0.3');
  assert.equal(addDecimal('4', '-4.000001'), '-0.000001');
});

test('stock movements: signs, reasons and file references', () => {
  const base = {
    plant: 'P1',
    location: 'STORE',
    item: 'RM-1',
    quantity: '10',
    movement_date: '2026-09-17',
  };
  assert.deepEqual(validateMovement({ ...base, movement_type: 'receipt' }).errors, []);
  assert.equal(
    validateMovement({ ...base, movement_type: 'receipt' }).value.movement_type,
    'RECEIPT',
  );
  assert.match(
    messages(validateMovement({ ...base, movement_type: 'ISSUE', quantity: '-3' })),
    /cannot be negative. Use an ISSUE/,
  );
  assert.match(
    messages(validateMovement({ ...base, movement_type: 'OPENING', quantity: '0' })),
    /not be zero/,
  );
  assert.match(
    messages(validateMovement({ ...base, movement_type: 'ADJUSTMENT', quantity: '-3' })),
    /Reason is required/,
  );
  assert.deepEqual(
    validateMovement({ ...base, movement_type: 'ADJUSTMENT', quantity: '-3', reason: 'Count' })
      .value.quantity,
    '-3',
  );
  assert.match(
    messages(validateMovement({ ...base, movement_type: 'REVERSAL' })),
    /one of: OPENING, RECEIPT, ISSUE, ADJUSTMENT/,
  );
  assert.match(
    messages(validateMovement({ ...base, movement_type: 'RECEIPT' }, { requireExternalRef: true })),
    /External reference is required/,
  );
  assert.match(
    messages(validateMovement({ ...base, movement_type: 'RECEIPT', external_ref: 'bad ref' })),
    /External reference must be/,
  );
  assert.match(
    messages(validateMovement({ ...base, movement_type: 'RECEIPT', quantity: '1,000' })),
    /commas/,
  );
});

test('customer orders: generated numbers in forms, dates, duplicate lines and line promise defaults', () => {
  const order = {
    plant: 'P1',
    order_no: '',
    customer: 'C1',
    order_date: '2026-09-17',
    promise_date: '2026-10-01',
    lines: [
      { line_no: '20', item: 'FG-2', quantity: '5', line_promise_date: '2026-10-09' },
      { line_no: '10', item: 'FG-1', quantity: '2' },
    ],
  };
  const ok = validateSalesOrder(order);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.order_no, null);
  assert.deepEqual(
    ok.value.lines.map((l) => [l.line_no, l.line_promise_date]),
    [
      [10, '2026-10-01'],
      [20, '2026-10-09'],
    ],
  );
  assert.equal(ok.value.allow_partial, true);
  assert.match(
    messages(validateSalesOrder(order, { requireNumber: true })),
    /Order number is required/,
  );
  assert.match(
    messages(
      validateSalesOrder({
        ...order,
        promise_date: '2026-09-01',
        lines: [
          { line_no: '10', item: 'FG-1', quantity: '0' },
          { line_no: '10', item: 'FG-2', quantity: '1', line_promise_date: '2026-09-02' },
        ],
      }),
    ),
    /Promise date must be on or after the order date.*Line 10: Quantity must be greater than 0.*Line number 10 is used more than once.*Line 10: promise date must be on or after/,
  );
  assert.match(messages(validateSalesOrder({ ...order, lines: [] })), /Add at least one line/);
});

test('purchase orders: received within ordered, due after order date', () => {
  const po = {
    plant: 'P1',
    po_no: 'PO-1',
    supplier: 'S1',
    order_date: '2026-09-10',
    lines: [{ line_no: '1', item: 'RM-1', quantity: '10', unit: 'BOX', due_date: '2026-09-30' }],
  };
  const ok = validatePurchaseOrder(po);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.lines[0].received_quantity, '0');
  assert.match(
    messages(
      validatePurchaseOrder({
        ...po,
        lines: [{ ...po.lines[0], received_quantity: '11', due_date: '2026-09-01' }],
      }),
    ),
    /received quantity cannot be more than the ordered quantity.*due date must be on or after/,
  );
});

test('locations and demand history field rules', () => {
  assert.deepEqual(
    validateStockLocation({ plant: 'P1', code: 'QC', name: 'Hold', nettable: 'no' }).value,
    {
      plant: 'P1',
      code: 'QC',
      name: 'Hold',
      location_type: 'STORES',
      nettable: false,
    },
  );
  assert.match(
    messages(
      validateDemandHistory({ plant: 'P1', item: 'FG', demand_date: '2026-02-30', quantity: '-1' }),
    ),
    /must be a date.*cannot be negative/,
  );
});

test('order CSV files group lines by order number and flag duplicates', () => {
  const header =
    'plant,order_no,customer,order_date,promise_date,allow_partial,customer_ref,line_no,item,quantity,line_promise_date';
  const rows = readImport(
    'sales_orders',
    [
      header,
      'P1,SO-1,C1,2026-09-17,2026-10-01,yes,,1,FG-1,5,',
      'P1,so-1,C1,2026-09-17,2026-10-01,yes,,2,FG-2,3,',
      'P1,SO-1,C1,2026-09-17,2026-10-01,yes,,2,FG-3,1,',
      'P1,SO-2,C1,2026-09-18,2026-10-02,no,,1,FG-1,1,',
    ].join('\n'),
  );
  const checked = validateRows('sales_orders', rows);
  assert.match(checked[2].errors[0].message, /Duplicate line 2 for SO-1; first used on line 3/);
  const groups = groupRows(ORDER_IMPORTS.sales_orders, rows);
  assert.deepEqual(
    groups.map((g) => [g.raw.order_no, g.raw.lines.length, g.mismatch.size]),
    [
      ['SO-1', 3, 0],
      ['SO-2', 1, 0],
    ],
  );
  const movements = validateRows(
    'stock_movements',
    readImport(
      'stock_movements',
      'plant,location,item,movement_type,quantity,unit,movement_date,reference,reason,external_ref\nP1,S,RM,RECEIPT,1,,2026-09-17,,,R1\nP1,S,RM,RECEIPT,1,,2026-09-17,,,R1\n',
    ),
  );
  // Same external reference twice is reported by the database layer with the line number.
  assert.deepEqual(
    movements.map((r) => r.errors),
    [[], []],
  );
});
