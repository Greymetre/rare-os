// Compares the local Nilkamal company with the Nilkamal simulation demo (21-Sep-2026 handover).
// Opens the demo HTML in a headless browser with its default settings (lead time at today's
// loading) and checks the current planning run:
//  - every buffer: zones, on hand, on order, qualified demand, net flow, zone, order quantity;
//  - the schedule: sequence, drum, every operation's machine, start and finish, finish day and
//    slack of every order, and run / changeover minutes per resource and machine.
// Demo times are effective machine-minutes (a day = 1440 x efficiency); ours are plant minutes.
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
    deriveDrum();
    const cx = materialsContext();
    const fp = forwardPass();
    const times = decisionOrderTimes(fp);
    return {
      day: fp.DAY,
      drum: drumSt().op,
      sequence: drumStarts().map((u) => u.id),
      ops: Object.values(fp.units).flatMap((x) =>
        x.ops.map((o) => ({
          id: x.u.id,
          op: SEED.stations[o.pos].op,
          k: o.k,
          start: o.start,
          finish: o.finish,
        })),
      ),
      times: Object.values(times).map((t) => ({
        id: t.id,
        ship: t.ship - AS_OF_DAY,
        slack: t.slack,
      })),
      loads: fp.allocs.map((a) => ({
        op: a.st.op,
        run: a.run,
        chg: a.chg,
        n: a.nChg,
        lanes: a.lanes.map((l) => [l.run, l.chg]),
      })),
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
      readiness: Object.fromEntries(
        Object.entries(decisionLive().materials).map(([id, r]) => [id, r.status]),
      ),
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
const close = (a, b) => a !== null && Math.abs(a - b) < 1e-4;
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
// ---------- Schedule ----------
const psql = (q) =>
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
      q,
    ],
    {
      encoding: 'utf8',
    },
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('|'));
const run = `(SELECT current_run_id FROM planning_state s JOIN tenants t ON t.id=s.tenant_id WHERE t.name='Nilkamal')`;
const [plant] = psql(
  `SELECT r.code,sp.day_minutes,(SELECT count(*) FROM schedule_orders WHERE run_id=${run}) FROM schedule_plants sp LEFT JOIN resources r ON r.id=sp.drum_resource_id WHERE sp.run_id=${run}`,
);
if (!plant) problems.push('No schedule in the current run');
else {
  const D = Number(plant[1]);
  if (plant[0] !== demo.drum) problems.push(`drum: RARE OS ${plant[0]}, demo ${demo.drum}`);
  const seq = psql(
    `SELECT o.order_no FROM schedule_orders s JOIN production_orders o ON o.id=s.production_order_id WHERE s.run_id=${run} ORDER BY s.position`,
  ).map((r) => r[0]);
  if (JSON.stringify(seq) !== JSON.stringify(demo.sequence))
    problems.push('sequence differs from the demo');
  const ops = new Map(
    psql(
      `SELECT o.order_no,x.operation_code,x.machine,x.start_min,x.finish_min,r.efficiency_pct FROM schedule_operations x
       JOIN production_orders o ON o.id=x.production_order_id JOIN resources r ON r.id=x.resource_id WHERE x.run_id=${run}`,
    ).map((r) => [r[0] + '|' + r[1], r]),
  );
  for (const d of demo.ops) {
    const r = ops.get(d.id + '|' + d.op);
    const f = r ? Number(r[5]) / 100 : 1;
    if (
      !r ||
      Number(r[2]) !== d.k ||
      Math.abs(Number(r[3]) * f - d.start) > 1e-3 ||
      Math.abs(Number(r[4]) * f - d.finish) > 1e-3
    )
      problems.push(
        `${d.id} ${d.op}: RARE OS ${r ? `m${r[2]} ${(Number(r[3]) * f).toFixed(2)}-${(Number(r[4]) * f).toFixed(2)}` : 'none'}, demo m${d.k} ${d.start.toFixed(2)}-${d.finish.toFixed(2)}`,
      );
  }
  const orders = new Map(
    psql(
      `SELECT o.order_no,s.finish_date - sp.start_date + 1,s.slack_min FROM schedule_orders s JOIN production_orders o ON o.id=s.production_order_id
       JOIN schedule_plants sp ON sp.run_id=s.run_id AND sp.site_id=s.site_id WHERE s.run_id=${run}`,
    ).map((r) => [r[0], r]),
  );
  for (const t of demo.times) {
    const r = orders.get(t.id);
    if (!r || Number(r[1]) !== t.ship || Math.abs(Number(r[2]) * (demo.day / D) - t.slack) > 1e-2)
      problems.push(
        `${t.id} finish day / slack: RARE OS ${r?.[1]} / ${r ? (Number(r[2]) * (demo.day / D)).toFixed(2) : '-'}, demo ${t.ship} / ${t.slack.toFixed(2)}`,
      );
  }
  const loads = new Map(
    psql(
      `SELECT r.code,s.run_min,s.changeover_min,s.changeovers,s.lanes FROM schedule_resources s JOIN resources r ON r.id=s.resource_id WHERE s.run_id=${run}`,
    ).map((r) => [r[0], r]),
  );
  for (const a of demo.loads) {
    const r = loads.get(a.op);
    const lanes = r ? JSON.parse(r[4]) : [];
    if (
      !r ||
      !close(Number(r[1]), a.run) ||
      !close(Number(r[2]), a.chg) ||
      Number(r[3]) !== a.n ||
      a.lanes.some(
        (l, i) =>
          !lanes[i] ||
          Math.abs(lanes[i].run - l[0]) > 1e-3 ||
          Math.abs(lanes[i].changeover - l[1]) > 1e-3,
      )
    )
      problems.push(
        `${a.op} load: RARE OS ${r?.slice(1, 4).join('/')}, demo ${a.run}/${a.chg}/${a.n}`,
      );
  }
  const LABELS = {
    expedite: 'Expedite or quote later',
    unknown: 'Cannot validate materials',
    replenish: 'Commit + replenish',
    clear: 'Clear to commit',
  };
  const ready = new Map(
    psql(
      `SELECT o.order_no,s.material_check FROM schedule_orders s JOIN production_orders o ON o.id=s.production_order_id WHERE s.run_id=${run}`,
    ),
  );
  for (const [id, status] of Object.entries(demo.readiness))
    if (LABELS[ready.get(id)] !== status)
      problems.push(`${id} materials: RARE OS ${ready.get(id)}, demo ${status}`);
  console.log(
    `${seq.length} scheduled orders, ${demo.ops.length} operations and ${Object.keys(demo.readiness).length} material readiness results compared with the demo.`,
  );
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
