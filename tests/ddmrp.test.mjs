import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bufferZones,
  effectiveAdu,
  orderQuantity,
  planPlant,
  supersedes,
  zoneOf,
} from '../packages/engines/ddmrp.mjs';

// Prototype buffer profiles (prototype/RARE_OS_Base_Demo.html, buffer_profiles seed).
const BP_RM_SHORT = { red_base_pct: 30, red_safety_pct: 0, green_pct: 35 };

test('prototype: SUP-INT buffer sizes from ADU x DLT, TOG = 1.65 x yellow, linear in volume', () => {
  const z = bufferZones({ adu: 12.5, dlt: 8, profile: BP_RM_SHORT });
  assert.equal(z.yellow, 100);
  assert.ok(Math.abs(z.topOfGreen / z.yellow - 1.65) < 1e-9);
  const small = bufferZones({ adu: 10, dlt: 7, profile: BP_RM_SHORT });
  const large = bufferZones({ adu: 20, dlt: 7, profile: BP_RM_SHORT });
  assert.ok(Math.abs(large.topOfGreen - 2 * small.topOfGreen) < 1e-9);
});

test('red safety, order cycle and MOQ shape the zones', () => {
  const profile = { red_base_pct: 50, red_safety_pct: 50, green_pct: 50, order_cycle_days: 10 };
  const z = bufferZones({ adu: 10, dlt: 4, profile, moq: 0 });
  assert.deepEqual([z.red, z.yellow, z.green], [30, 40, 100]);
  assert.equal(bufferZones({ adu: 10, dlt: 4, profile, moq: 500 }).green, 500);
});

test('prototype seeded buffers: net flow and zone per item', () => {
  // [item, red top, yellow top, TOG, on hand, on order, qualified demand, NFP, zone]
  const seed = [
    ['FGa', 90, 210, 300, 340, 0, 120, 220, 'green'],
    ['FGd', 30, 70, 100, 90, 0, 40, 50, 'yellow'],
    ['RMb', 300, 560, 1420, 520, 300, 480, 340, 'yellow'],
    ['RMh', 400, 900, 1250, 1700, 0, 760, 940, 'green'],
  ];
  for (const [item, red, yellow, tog, oh, oo, qd, nfp, zone] of seed) {
    const zones = { topOfRed: red, topOfYellow: yellow, topOfGreen: tog };
    assert.equal(oh + oo - qd, nfp, item);
    assert.equal(zoneOf(nfp, zones), zone, item);
  }
  // The prototype called everything above top of yellow green; above TOG is now called out.
  assert.equal(zoneOf(301, { topOfRed: 90, topOfYellow: 210, topOfGreen: 300 }), 'excess');
  assert.equal(zoneOf(0, { topOfRed: 90, topOfYellow: 210, topOfGreen: 300 }), 'breach');
});

test('order sizing: back to top of green, MOQ, multiples and unit decimals', () => {
  assert.equal(orderQuantity(1880, { multiple: 50 }), 1900);
  assert.equal(orderQuantity(12, { moq: 100, multiple: 10 }), 100);
  assert.equal(orderQuantity(101, { moq: 100, multiple: 10 }), 110);
  assert.equal(orderQuantity(3.2, { decimals: 0 }), 4);
  assert.equal(orderQuantity(0), 0);
  assert.equal(orderQuantity(-5, { moq: 100 }), 0);
});

test('effective ADU flows down the BOM, including through unbuffered sub-assemblies', () => {
  const usage = new Map([
    ['FG', [{ componentId: 'SFG', qtyPer: 2 }]],
    ['SFG', [{ componentId: 'RM', qtyPer: 3 }]],
  ]);
  const adu = effectiveAdu(
    new Map([
      ['FG', 10],
      ['RM', 5],
    ]),
    usage,
  );
  assert.deepEqual([adu.get('FG'), adu.get('SFG'), adu.get('RM')], [10, 20, 65]);
  const overridden = effectiveAdu(new Map([['FG', 10]]), usage, new Map([['SFG', 1]]));
  assert.equal(overridden.get('RM'), 3);
});

const base = (overrides = {}) => ({
  today: '2026-07-07',
  settings: [
    {
      itemId: 'FGb',
      code: 'FGb',
      policy: 'BUFFER',
      makeBuy: 'MAKE',
      leadTimeDays: 4,
      decimals: 0,
      profile: { red_base_pct: 50, red_safety_pct: 0, green_pct: 50, spike_threshold_pct: 50 },
    },
    {
      itemId: 'RMb',
      code: 'RMb',
      policy: 'BUFFER',
      makeBuy: 'BUY',
      leadTimeDays: null,
      decimals: 3,
      profile: { red_base_pct: 30, red_safety_pct: 0, green_pct: 35, spike_threshold_pct: 50 },
      source: {
        moq: 0,
        multiple: 50,
        factor: 1,
        unit: 'KG',
        leadTimeDays: 14,
        supplierId: 'SUP-2',
      },
    },
    { itemId: 'FGx', code: 'FGx', policy: 'MTO', makeBuy: 'MAKE', decimals: 0, profile: null },
  ],
  adu: new Map([
    ['FGb', 27],
    ['RMb', 40],
    ['FGx', 5],
  ]),
  usage: new Map([
    ['FGb', [{ componentId: 'RMb', qtyPer: 2 }]],
    ['FGx', [{ componentId: 'RMb', qtyPer: 1 }]],
  ]),
  onHand: new Map([
    ['FGb', 360],
    ['RMb', 520],
  ]),
  supply: new Map([['RMb', 300]]),
  demand: [],
  ...overrides,
});
const rowOf = (rows, id) => rows.find((r) => r.itemId === id);

test('prototype spike: a large FGb order inside the horizon qualifies RMb and breaches it', () => {
  const quiet = rowOf(planPlant(base()), 'RMb');
  assert.equal(quiet.dlt, 14);
  assert.equal(quiet.zone, 'green');
  const rows = planPlant(base({ demand: [{ itemId: 'FGb', due: '2026-07-18', qty: 400 }] }));
  const fgb = rowOf(rows, 'FGb');
  assert.equal(fgb.qualifiedDemand, 0, 'FGb order is beyond the FGb lead time: not qualified');
  const spike = planPlant(base({ demand: [{ itemId: 'FGb', due: '2026-07-10', qty: 400 }] }));
  assert.deepEqual(
    [rowOf(spike, 'FGb').spikeDemand, rowOf(spike, 'RMb').qualifiedDemand],
    [400, 800],
  );
  assert.equal(rowOf(spike, 'RMb').zone, 'red');
  // Prototype: 480 already qualified (here a past-due make-to-order line) + the 800 spike need.
  const breached = rowOf(
    planPlant(
      base({
        demand: [
          { itemId: 'FGb', due: '2026-07-10', qty: 400 },
          { itemId: 'FGx', due: '2026-07-06', qty: 480 },
        ],
      }),
    ),
    'RMb',
  );
  assert.deepEqual([breached.qualifiedDemand, breached.nfp, breached.zone], [1280, -460, 'breach']);
  // Sized back to top of green in 50s: 924 - (-460) = 1384 -> 1400.
  assert.equal(breached.recommended.qty, 1400);
  // With the prototype's RMb zones (TOG 1420) the same position needs PO 1900.
  assert.equal(orderQuantity(1420 - -460, { multiple: 50 }), 1900);
});

test('small future orders do not qualify; past due always does', () => {
  const rows = planPlant(
    base({
      demand: [
        { itemId: 'FGb', due: '2026-07-09', qty: 10 },
        { itemId: 'FGb', due: '2026-07-05', qty: 25 },
        { itemId: 'FGb', due: '2026-07-07', qty: 5 },
      ],
    }),
  );
  assert.equal(rowOf(rows, 'FGb').qualifiedDemand, 30);
  assert.equal(rowOf(rows, 'RMb').qualifiedDemand, 0, 'buffered FG decouples its components');
});

test('make-to-order demand passes to components inside their horizon only', () => {
  const rows = planPlant(
    base({
      demand: [
        { itemId: 'FGx', due: '2026-07-15', qty: 100 },
        { itemId: 'FGx', due: '2026-08-30', qty: 70 },
      ],
    }),
  );
  const fgx = rowOf(rows, 'FGx');
  assert.equal(fgx.status, 'not_applicable');
  assert.equal(fgx.zone, null);
  const rmb = rowOf(rows, 'RMb');
  assert.deepEqual([rmb.qualifiedDemand, rmb.outsideHorizon], [100, 70]);
});

test('recommendation: BUY in purchase units to top of green; nothing when green', () => {
  const low = base();
  low.onHand.set('RMb', 100);
  low.supply.set('RMb', 0);
  const rmb = rowOf(planPlant(low), 'RMb');
  // yellow 560, red 168, green 196, TOG 924 -> need 824 -> 850 in 50s
  assert.equal(rmb.zones.topOfGreen, 924);
  assert.equal(rmb.zone, 'red');
  assert.deepEqual(rmb.recommended, {
    kind: 'BUY',
    qty: 850,
    purchaseQty: 850,
    purchaseUnit: 'KG',
    supplierId: 'SUP-2',
    due: '2026-07-21',
  });
  assert.equal(rmb.onHandAlert, 'low');
  const boxes = base();
  boxes.onHand.set('RMb', 100);
  boxes.supply.set('RMb', 0);
  boxes.settings[1].source = {
    ...boxes.settings[1].source,
    factor: 25,
    unit: 'BOX',
    multiple: 4,
    decimals: 0,
  };
  const inBoxes = rowOf(planPlant(boxes), 'RMb').recommended;
  assert.deepEqual([inBoxes.purchaseQty, inBoxes.qty], [36, 900]);
  const fgb = rowOf(planPlant(base()), 'FGb');
  assert.equal(fgb.zone, 'excess');
  assert.equal(fgb.recommended, null);
});

test('missing data is reported, never shown as a zero buffer', () => {
  const input = base();
  input.adu.set('FGb', 0);
  input.settings[1].source = null;
  const rows = planPlant(input);
  const fgb = rowOf(rows, 'FGb');
  assert.equal(fgb.status, 'missing');
  assert.equal(fgb.zones, null);
  assert.match(fgb.messages.join(' '), /No usage/);
  assert.match(rowOf(rows, 'RMb').messages.join(' '), /No lead time/);
});

test('an older run never replaces a result from newer inputs', () => {
  assert.equal(supersedes(null, 3), true);
  assert.equal(supersedes(5, 5), true);
  assert.equal(supersedes(7, 5), false);
});
