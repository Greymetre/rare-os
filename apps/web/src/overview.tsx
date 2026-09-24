// The screens the Nilkamal simulation handover (21-Sep-2026) opens each engine with, plus the two
// it asks questions with: what a different grouping window would do, and the lead time every made
// item is actually running at. All of them read the calculation already in force — nothing here
// changes a plan.
import { useEffect, useState } from 'react';
import { useApi } from './api-client';
import { Messages } from './plant-model';

const num = (v: unknown, digits = 0) =>
  v === null || v === undefined || v === ''
    ? '—'
    : Number(v).toLocaleString('en-IN', { maximumFractionDigits: digits });

function useView(csrf: string, path: string | null, deps: unknown[]) {
  const call = useApi(csrf);
  const [data, setData] = useState<any>(null),
    [error, setError] = useState('');
  useEffect(() => {
    if (!path) return;
    let live = true;
    setData(null);
    setError('');
    call(path)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, deps);
  return { data, error };
}

function Calculation({ c }: { c: any }) {
  if (!c) return null;
  return (
    <p className="panel-sub">
      Calculation #{c.runNo} · simulation date {c.asOf} ·{' '}
      {c.upToDate ? 'up to date' : 'inputs changed: recalculating…'}
    </p>
  );
}

// ---------- Scheduling & Execution ----------

export function SchedulingOverview({
  csrf,
  plantId,
  refreshKey,
}: {
  csrf: string;
  plantId: string;
  refreshKey: number;
}) {
  const { data, error } = useView(csrf, `plants/${plantId}/overview/scheduling`, [
    plantId,
    refreshKey,
  ]);
  return (
    <>
      <Messages error={error} notice="" />
      {data?.empty && <p className="panel-body">{data.empty}</p>}
      {data && !data.empty && (
        <>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>
                  {data.plant.code} {data.plant.name}: the open book
                </h2>
                <Calculation c={data.calculation} />
              </div>
            </div>
            <div className="zone-tiles schedule-tiles">
              <div className="zone-tile">
                <strong>{num(data.orders.scheduled)}</strong>
                <span>Orders scheduled</span>
              </div>
              <div className={'zone-tile ' + (data.orders.late ? 'red' : 'green')}>
                <strong>{num(data.orders.late)}</strong>
                <span>Finishing after their promise</span>
              </div>
              <div className={'zone-tile ' + (data.orders.materialShort ? 'red' : 'green')}>
                <strong>{num(data.orders.materialShort)}</strong>
                <span>Material short at release</span>
              </div>
              <div className={'zone-tile ' + (data.orders.unscheduled ? 'red' : 'green')}>
                <strong>{num(data.orders.unscheduled)}</strong>
                <span>Not schedulable</span>
              </div>
              <div className="zone-tile">
                <strong>{num(data.execution.released)}</strong>
                <span>Work released</span>
              </div>
              <div className={'zone-tile ' + (data.execution.downtimeOpen ? 'red' : 'green')}>
                <strong>{num(data.execution.downtimeOpen)}</strong>
                <span>Machines down</span>
              </div>
            </div>
            <p className="panel-body">
              {data.drum ? (
                <>
                  The constraint is{' '}
                  <strong>
                    {data.drum.code} {data.drum.name}
                  </strong>{' '}
                  at {data.drum.utilisationPct}% of its {num(data.drum.capacityPerDay)} minutes a
                  day; everything else is subordinated to it. Releases start{' '}
                  {data.orders.firstRelease}, the book finishes {data.orders.lastFinish}.
                </>
              ) : (
                'No resource is loaded yet.'
              )}{' '}
              {data.decisions} planner decision(s) are recorded against this calculation.
            </p>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Station load, open book</h2>
                <p className="panel-sub">Find the constraint, then subordinate to it.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Station</th>
                    <th className="num">Machines</th>
                    <th className="num">Run minutes</th>
                    <th className="num">Changeover</th>
                    <th className="num">Load</th>
                  </tr>
                </thead>
                <tbody>
                  {data.stations.map((s: any) => (
                    <tr key={s.code} data-station={s.code} className={s.drum ? 'late' : ''}>
                      <td>
                        <strong>{s.code}</strong> {s.name}
                        {s.drum && <div className="cell-sub">the constraint</div>}
                      </td>
                      <td className="num">{s.machines}</td>
                      <td className="num">{num(s.runMinutes)}</td>
                      <td className="num">{num(s.changeoverMinutes)}</td>
                      <td className="num">{s.utilisationPct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}

export function ChangeoverSimulator({
  csrf,
  plantId,
  refreshKey,
}: {
  csrf: string;
  plantId: string;
  refreshKey: number;
}) {
  const { data, error } = useView(csrf, `plants/${plantId}/club-windows`, [plantId, refreshKey]);
  return (
    <>
      <Messages error={error} notice="" />
      {data?.empty && <p className="panel-body">{data.empty}</p>}
      {data && !data.empty && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Changeover simulator</h2>
              <p className="panel-sub">
                What each grouping window would do to this book of {num(data.orders)} orders: setup
                minutes saved against promises put at risk. The window in force is {data.live}{' '}
                day(s). Nothing here is saved — change it in Plant planning.
              </p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Grouping window</th>
                  <th className="num">Clubs</th>
                  <th className="num">Orders clubbed</th>
                  <th className="num">Changeovers</th>
                  <th className="num">Changeover minutes</th>
                  <th className="num">Against today</th>
                  <th className="num">Late promises</th>
                  <th className="num">Book length</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r: any) => (
                  <tr
                    key={r.windowDays}
                    data-window={r.windowDays}
                    className={r.live ? 'late' : ''}
                  >
                    <td>
                      {r.windowDays === 0
                        ? 'None — run in promise order'
                        : `${r.windowDays}-day window`}
                      {r.live && <div className="cell-sub">the live scheduler setting</div>}
                    </td>
                    <td className="num">{num(r.groups)}</td>
                    <td className="num">{num(r.grouped)}</td>
                    <td className="num">{num(r.changeovers)}</td>
                    <td className="num">{num(r.changeoverMinutes)}</td>
                    <td className="num">
                      {r.deltaChangeover === 0
                        ? '—'
                        : `${r.deltaChangeover > 0 ? '+' : ''}${num(r.deltaChangeover)}`}
                    </td>
                    <td className="num">
                      {num(r.lateOrders)}
                      {r.deltaLate !== 0 && (
                        <div className="cell-sub">
                          {r.deltaLate > 0 ? '+' : ''}
                          {r.deltaLate} against today
                        </div>
                      )}
                    </td>
                    <td className="num">{num(r.makespanDays, 1)} d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="panel-body">
            A club is only proposed when the same item is already inside the window and carrying the
            earlier order does not push another promise out. When every window reads the same, this
            book has no grouping that keeps its promises.
          </p>
        </section>
      )}
    </>
  );
}

export function LeadTimeRealityList({
  csrf,
  plantId,
  refreshKey,
}: {
  csrf: string;
  plantId: string;
  refreshKey: number;
}) {
  const { data, error } = useView(csrf, `plants/${plantId}/lead-time`, [plantId, refreshKey]);
  return (
    <>
      <Messages error={error} notice="" />
      {data && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Lead time reality</h2>
              <p className="panel-sub">
                The lead time a made item is running at once the queue at its stations is counted,
                against the master lead time its buffer is sized on. {data.counts.stretched} of{' '}
                {data.counts.items} item(s) are running longer than their master.
                {data.counts.unbounded > 0 &&
                  ` ${data.counts.unbounded} cannot be bounded at all: a routed resource is at 95% or more.`}
              </p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Master</th>
                  <th className="num">At today's loading</th>
                  <th className="num">Stretch</th>
                  <th className="num">ADU</th>
                  <th className="num">Top of green</th>
                  <th>Zone</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r: any) => (
                  <tr
                    key={r.item}
                    data-lead-time={r.item}
                    className={r.factor > 1.05 ? 'late' : ''}
                  >
                    <td>
                      <strong>{r.item}</strong>
                      <div className="cell-sub">{r.name}</div>
                    </td>
                    <td className="num">{num(r.masterDays, 2)} d</td>
                    <td className="num">{num(r.liveDays, 2)} d</td>
                    <td className="num">
                      {r.unbounded ? 'unbounded' : `${num((r.factor - 1) * 100, 0)}%`}
                    </td>
                    <td className="num">{num(r.adu, 2)}</td>
                    <td className="num">{num(r.topOfGreen)}</td>
                    <td>
                      <span className={'status-pill ' + (r.zone === 'green' ? 'ok' : 'pending')}>
                        {r.zone}
                      </span>
                    </td>
                  </tr>
                ))}
                {!data.rows.length && (
                  <tr>
                    <td colSpan={7}>
                      No made item has a calculated lead time yet: the buffers are bought items, or
                      the plan has not run.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

// ---------- Materials Planning ----------

export function MaterialsOverview({
  csrf,
  plantId,
  refreshKey,
}: {
  csrf: string;
  plantId: string;
  refreshKey: number;
}) {
  const { data, error } = useView(csrf, `plants/${plantId}/overview/materials`, [
    plantId,
    refreshKey,
  ]);
  const zone = (name: string) => data?.zones?.[name] ?? 0;
  return (
    <>
      <Messages error={error} notice="" />
      {data?.empty && <p className="panel-body">{data.empty}</p>}
      {data && !data.empty && (
        <>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>
                  {data.plant.code} {data.plant.name}: where the buffers stand
                </h2>
                <Calculation c={data.calculation} />
              </div>
            </div>
            <div className="zone-tiles">
              <div className="zone-tile">
                <strong>{num(data.buffered)}</strong>
                <span>Buffered items</span>
              </div>
              <div className={'zone-tile ' + (zone('breach') ? 'red' : 'green')}>
                <strong>{num(zone('breach'))}</strong>
                <span>Net flow at or below zero</span>
              </div>
              <div className={'zone-tile ' + (zone('red') ? 'red' : 'green')}>
                <strong>{num(zone('red'))}</strong>
                <span>In the red zone</span>
              </div>
              <div className="zone-tile yellow">
                <strong>{num(zone('yellow'))}</strong>
                <span>In the yellow zone</span>
              </div>
              <div className="zone-tile green">
                <strong>{num(zone('green') + zone('excess'))}</strong>
                <span>Green or above</span>
              </div>
              <div className="zone-tile">
                <strong>{num(data.recommended)}</strong>
                <span>Orders recommended</span>
              </div>
            </div>
            <p className="panel-body">
              {num(data.proposals.open)} purchase proposal(s) waiting and{' '}
              {num(data.proposals.approved)} approved; {num(data.expedites.waiting)} expedite(s)
              with no confirmed supply; {num(data.schemes.proposed)} scheme(s) proposed and{' '}
              {num(data.schemes.accepted)} accepted.
              {data.missing > 0 &&
                ` ${num(data.missing)} buffered item(s) cannot be calculated: lead time or usage is missing.`}
              {data.eventSized > 0 &&
                ` ${num(data.eventSized)} item(s) have their zones sized for an event.`}
            </p>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Stock on hand</h2>
                <p className="panel-sub">
                  Per unit of measure: kilograms, numbers, metres and litres are never added into
                  one figure.
                </p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Unit</th>
                    <th>Item type</th>
                    <th className="num">Items</th>
                    <th className="num">On hand</th>
                  </tr>
                </thead>
                <tbody>
                  {data.onHand.map((r: any) => (
                    <tr key={r.unit + r.type} data-on-hand={r.unit + '-' + r.type}>
                      <td>{r.unit}</td>
                      <td>{r.type}</td>
                      <td className="num">{num(r.items)}</td>
                      <td className="num">{num(r.quantity, 3)}</td>
                    </tr>
                  ))}
                  {!data.onHand.length && (
                    <tr>
                      <td colSpan={4}>No stock recorded in this plant yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}
