import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bufferZones,
  cvSafetyPct,
  effectiveSeries,
  weeklyZones,
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

// ---------- WEEKLY method (Nilkamal simulation handover, 21-Sep-2026) ----------

const WEEKLY = {
  method: 'WEEKLY',
  red_base_pct: 50,
  order_cycle_days: 7,
  zone_weeks: 4,
  cv_weeks: 4,
};

test('weekly zones: 13-week style mean, CV safety bands, whole-week lead time, 0.1 then whole units', () => {
  assert.deepEqual(
    [cvSafetyPct(0.499), cvSafetyPct(0.5), cvSafetyPct(0.999), cvSafetyPct(1)],
    [30, 50, 50, 70],
  );
  // Mean 70/week; blocks 60/80 -> CV 0.143 -> 30% safety. 10 days rounds to 1 week.
  const z = weeklyZones({
    weeks: [70, 70, 70, 70],
    blocks: [60, 80, 60, 80],
    leadTimeDays: 10,
    profile: WEEKLY,
  });
  assert.deepEqual([z.cv, z.safety, z.zoneDays], [0.143, 30, 7]);
  // red = 70 x 0.5 x 1.3 = 45.5 -> 46 (0.1 kept, then whole units); yellow top 115.5 -> 116; TOG 185.5 -> 186
  assert.deepEqual([z.topOfRed, z.topOfYellow, z.topOfGreen], [46, 116, 186]);
  // 2 days is at least one week; 18 days is three weeks; volatile demand gets 70%.
  assert.equal(
    weeklyZones({ weeks: [7], blocks: [7, 7], leadTimeDays: 2, profile: WEEKLY }).zoneDays,
    7,
  );
  const v = weeklyZones({ weeks: [70], blocks: [0, 0, 0, 280], leadTimeDays: 18, profile: WEEKLY });
  assert.deepEqual([v.zoneDays, v.safety, v.topOfRed], [21, 70, 179]);
});

test('weekly series explode through the BOM like ADU', () => {
  const usage = new Map([
    [
      'FG',
      [
        { componentId: 'RM', qtyPer: 2 },
        { componentId: 'RM', qtyPer: 0.5 },
      ],
    ],
  ]);
  const s = effectiveSeries(new Map([['FG', [10, 20]]]), usage, 2);
  assert.deepEqual(s.get('RM'), [25, 50]);
});

// FG made (lead time 2 days, 100/week); RM bought in 50s, 10-day lead time, 2.5 per FG.
const weeklyPlant = (overrides = {}) => {
  const usage = new Map([['FG', [{ componentId: 'RM', qtyPer: 2.5 }]]]);
  const fgWeeks = [100, 100, 100, 100];
  return {
    today: '2026-07-27',
    settings: [
      {
        itemId: 'FG',
        code: 'FG',
        makeBuy: 'MAKE',
        decimals: 0,
        policy: 'BUFFER',
        leadTimeDays: 2,
        aduOverride: null,
        profile: { ...WEEKLY, order_multiple: 10, moq_adu_days: 1.5 },
      },
      {
        itemId: 'RM',
        code: 'RM',
        makeBuy: 'BUY',
        decimals: 3,
        policy: 'BUFFER',
        leadTimeDays: null,
        aduOverride: null,
        profile: WEEKLY,
        source: {
          moq: 50,
          multiple: 50,
          factor: 1,
          unit: 'KG',
          decimals: 3,
          leadTimeDays: 10,
          supplierId: 'S1',
        },
      },
    ],
    adu: new Map([
      ['FG', 100 / 7],
      ['RM', 250 / 7],
    ]),
    usage,
    onHand: new Map([
      ['FG', 60],
      ['RM', 700],
    ]),
    supply: new Map([['RM', 100]]),
    demand: [],
    productionOrders: [
      { ref: 'WO-1', itemId: 'FG', code: 'FG', due: '2026-07-30', qty: 40 },
      { ref: 'WO-2', itemId: 'FG', code: 'FG', due: '2026-08-10', qty: 30 },
    ],
    series: new Map([
      ['FG', { weeks: fgWeeks, blocks: fgWeeks }],
      ['RM', { weeks: fgWeeks.map((x) => x * 2.5), blocks: fgWeeks.map((x) => x * 2.5) }],
    ]),
    stockKnown: new Set(['FG', 'RM']),
    ...overrides,
  };
};

test('weekly plant: lead-time demand on made items, production orders and planned make orders on components', () => {
  const [fg, rm] = planPlant(weeklyPlant());
  // FG: ADU 14.286; qualified = ADU x 2 days = 28.6; production orders are not FG supply here.
  assert.deepEqual([fg.adu, fg.leadTimeDemand, fg.openSupply, fg.nfp], [14.286, 28.6, 0, 31.4]);
  // Zones: red 50 x 1.3 = 65, yellow top 165, TOG 265 -> red; make to TOG in 10s, at least MOQ 20.
  assert.deepEqual([fg.zones.topOfRed, fg.zone, fg.recommended.qty], [65, 'red', 240]);
  // RM: WO-1 (due in 3 days) qualifies 100; WO-2 is 14 days out, beyond the 10-day lead time.
  // The FG order of 240 less the 70 already scheduled adds 170 x 2.5 = 425.
  assert.deepEqual([rm.productionDemand, rm.outsideHorizon, rm.plannedMakeDemand], [100, 75, 425]);
  assert.equal(rm.nfp, 700 + 100 - 525);
  // Earliest parent need: the planned make order (today + 2 days) less 10 days, already past.
  assert.equal(rm.requiredDate, '2026-07-19');
  assert.equal(rm.recommended.due, '2026-07-27');
  assert.ok(rm.messages.some((m) => /has passed/.test(m)));
  assert.deepEqual(
    rm.drivers.map((d) => [d.kind, d.ref, d.qty]),
    [
      ['planned', 'FG', 425],
      ['production', 'WO-1', 100],
    ],
  );
  // No excess zone in the weekly method: far above TOG is still green.
  const [, full] = planPlant(
    weeklyPlant({
      onHand: new Map([
        ['FG', 5000],
        ['RM', 99999],
      ]),
    }),
  );
  assert.equal(full.zone, 'green');
});

test('weekly plant: an item without any stock record is unknown, not zero', () => {
  const [, rm] = planPlant(weeklyPlant({ stockKnown: new Set(['FG']) }));
  assert.equal(rm.status, 'missing');
  assert.match(rm.messages[0], /No stock position/);
});

test('standard plant: open production orders are supply of their item and demand on components', () => {
  const [fg] = planPlant(
    weeklyPlant({
      settings: weeklyPlant().settings.map((s) => ({
        ...s,
        profile: { red_base_pct: 50, green_pct: 50 },
      })),
      series: new Map(),
    }),
  );
  assert.equal(fg.openSupply, 70);
});
