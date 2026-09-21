// Compares the local Nilkamal company with the Nilkamal simulation demo (21-Sep-2026 handover).
// Opens the demo HTML in a headless browser, reads its buffers and recommendations with fixed
// lead times (the demo's dynamic lead times need the scheduler, a later milestone), and checks
// every buffer of the current planning run: zones, on hand, on order, qualified demand, net
// flow, zone and order quantity.
//
// Run after scripts/load-nilkamal.mjs, with no other changes to the Nilkamal data:
//   node scripts/nilkamal-parity.mjs <handover folder>
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const handover = process.argv[2];
if (!handover) throw Error('Usage: node scripts/nilkamal-parity.mjs <handover folder>');
const html = path.resolve(handover, 'Demo_Build', 'RARE_OS_Nilkamal_v13_materials.html');

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
let demo;
try {
  const page = await browser.newPage();
  await page.goto('file://' + html);
  await page.waitForFunction(() => typeof materialsContext === 'function');
  demo = await page.evaluate(() => {
    TUNE.dynLt = 0;
    const cx = materialsContext();
    return {
      buffers: cx.buffers.map((b) => ({
        item: b.item,
        red: b.red,
        yel: b.yel,
        tog: b.tog,
        oh: b.oh,
        oo: b.ooNow,
        qd: b.qdNow,
        nfp: b.nfp,
        zone: b.zone,
      })),
      orders: proposedOrders().map((r) => ({ part: r.part, qty: r.qty })),
    };
  });
} finally {
  await browser.close();
}

const sql = `SELECT i.code,r.top_of_red,r.top_of_yellow,r.top_of_green,r.on_hand,r.open_supply,
  r.qualified_demand,r.nfp,r.zone,r.recommended_qty FROM planning_results r
  JOIN planning_state s ON s.current_run_id=r.run_id JOIN items i ON i.id=r.item_id
  JOIN tenants t ON t.id=r.tenant_id WHERE t.name='Nilkamal' AND r.status='planned'`;
const rows = new Map(
  execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'db',
      'psql',
      '-U',
      'rare_owner',
      '-d',
      'rare_os',
      '-At',
      '-F',
      '|',
      '-c',
      sql,
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('|'))
    .map((f) => [f[0], f]),
);
const n = (v) => (v === '' ? null : Number(v));
const close = (a, b) => a !== null && Math.abs(a - b) < 1e-6;
const problems = [];
for (const d of demo.buffers) {
  const r = rows.get(d.item);
  if (!r) {
    problems.push(`${d.item}: not planned in RARE OS`);
    continue;
  }
  const ours = {
    red: n(r[1]),
    yel: n(r[2]),
    tog: n(r[3]),
    oh: n(r[4]),
    oo: n(r[5]),
    qd: n(r[6]),
    nfp: n(r[7]),
  };
  for (const [k, v] of Object.entries(ours))
    if (!close(v, d[k])) problems.push(`${d.item} ${k}: RARE OS ${v}, demo ${d[k]}`);
  if (r[8] !== d.zone) problems.push(`${d.item} zone: RARE OS ${r[8]}, demo ${d.zone}`);
}
const recommended = [...rows.values()].filter((r) => r[9] !== '');
for (const o of demo.orders) {
  const r = rows.get(o.part);
  if (!r || !close(n(r[9]), o.qty))
    problems.push(`${o.part} order: RARE OS ${r?.[9] || 'none'}, demo ${o.qty}`);
}
if (recommended.length !== demo.orders.length)
  problems.push(
    `${recommended.length} recommendations in RARE OS, ${demo.orders.length} in the demo`,
  );
console.log(
  `${demo.buffers.length} buffers and ${demo.orders.length} order recommendations compared with the demo.`,
);
if (problems.length) {
  console.log(`${problems.length} difference(s):\n  ` + problems.slice(0, 40).join('\n  '));
  process.exit(1);
}
console.log('All match.');
