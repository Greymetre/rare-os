import { useEffect, useState } from 'react';
import { useApi } from './api-client';
import { Messages } from './plant-model';

// AV-9 screens (Nilkamal simulation handover, 21-Sep-2026): the execution loop on two events,
// the breakdown / downtime log with the promises it puts at risk, and the master-data self-audit.

const num = (v: unknown, digits = 2) =>
  v === null || v === undefined || v === ''
    ? '—'
    : Number(v).toLocaleString('en-IN', { maximumFractionDigits: digits });

function Gauge({ value }: { value: number | null }) {
  if (value === null) return <>—</>;
  const tone = value > 100 ? 'off' : value > 60 ? 'pending' : 'ok';
  return (
    <span className="gauge-cell">
      <span className="gauge" aria-hidden="true">
        <i className={'gauge-fill ' + tone} style={{ width: Math.min(100, value) + '%' }} />
      </span>
      {value}%
    </span>
  );
}

// Planning → Execution: release work, complete it, and see what the completions used of their
// protective buffer.
export function Execution({
  csrf,
  plantId,
  permissions,
  refreshKey,
}: {
  csrf: string;
  plantId: string;
  permissions: string[];
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const canRun = permissions.includes('production.execute');
  const [data, setData] = useState<any>(null),
    [schedule, setSchedule] = useState<any>(null),
    [form, setForm] = useState<Record<string, any>>({}),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    Promise.all([call(`plants/${plantId}/execution`), call(`plants/${plantId}/schedule`)])
      .then(([e, s]) => {
        if (!live) return;
        setData(e);
        setSchedule(s);
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [plantId, refreshKey, tick]);
  const act = (path: string, payload: any) => {
    setBusy(true);
    setError('');
    call(`plants/${plantId}/${path}`, 'POST', payload)
      .then((d) => {
        setNotice(d.message);
        setTick((x) => x + 1);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const f = (id: string) => form[id] ?? {};
  const set = (id: string, k: string, v: string) =>
    setForm({ ...form, [id]: { ...f(id), [k]: v } });
  const releasable = (schedule?.items ?? []).filter(
    (o: any) => o.status === 'scheduled' && o.execution_state === 'planned',
  );
  return (
    <>
      <Messages error={error} notice={notice} />
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Execution loop</h2>
            <p className="panel-sub">
              Two events and nothing else: a work order is released, and it is completed. The
              planned minutes of the schedule it was released from become the standard, and the
              elapsed work minutes say how much of the {data?.bufferPct ?? 25}% protective buffer it
              used. Released work keeps its place in the book.
            </p>
          </div>
        </div>
        {data && (
          <div className="zone-tiles schedule-tiles">
            <div className="zone-tile">
              <strong>{data.pct === null ? '—' : data.pct + '%'}</strong>
              <span>Schedule adherence</span>
              <span className="cell-sub">
                {data.inside} of {data.completions} completions inside plan + buffer
              </span>
            </div>
            <div className="zone-tile">
              <strong>{data.released}</strong>
              <span>Running now</span>
              <span className="cell-sub">released, not yet completed</span>
            </div>
            <div className="zone-tile">
              <strong>2 events</strong>
              <span>Telemetry needed</span>
              <span className="cell-sub">release and completion; no in-process scans</span>
            </div>
          </div>
        )}
      </section>
      {canRun && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Release work</h2>
              <p className="panel-sub">
                Scheduled orders that have not been released yet, in schedule order.
              </p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Order</th>
                  <th>Item</th>
                  <th className="num">Quantity</th>
                  <th>Promise</th>
                  <th>Materials</th>
                  <th className="actions">Release</th>
                </tr>
              </thead>
              <tbody>
                {releasable.slice(0, 25).map((o: any) => (
                  <tr key={o.id} data-release={o.order_no}>
                    <td className="num">{o.position}</td>
                    <td>
                      <strong>{o.order_no}</strong>
                    </td>
                    <td>{o.item}</td>
                    <td className="num">
                      {num(o.quantity)} {o.unit}
                    </td>
                    <td>{o.promise_date}</td>
                    <td>{o.material_check ?? '—'}</td>
                    <td className="actions">
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() =>
                          act('work-orders/release', {
                            order: o.order_no,
                            runNo: Number(schedule.header.run_no),
                          })
                        }
                      >
                        Release
                      </button>
                    </td>
                  </tr>
                ))}
                {releasable.length === 0 && (
                  <tr>
                    <td colSpan={7}>Every scheduled order has been released.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Work orders</h2>
            <p className="panel-sub">Released and completed work, newest release first.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Item</th>
                <th className="num">Quantity</th>
                <th>Released</th>
                <th>Completed</th>
                <th className="num">Planned min</th>
                <th className="num">Elapsed min</th>
                <th className="num">Buffer penetration</th>
                <th>Status</th>
                {canRun && <th className="actions">Complete</th>}
              </tr>
            </thead>
            <tbody>
              {(data?.items ?? []).map((o: any) => (
                <tr key={o.order_no} data-work={o.order_no}>
                  <td>
                    <strong>{o.order_no}</strong>
                    <div className="cell-sub">
                      {o.source === 'MAKE'
                        ? 'Buffer replenishment'
                        : o.source === 'INSERTED'
                          ? 'Inserted order'
                          : 'Imported'}
                    </div>
                  </td>
                  <td>
                    {o.item}
                    <div className="cell-sub">{o.item_name}</div>
                  </td>
                  <td className="num">
                    {num(o.completed_quantity ?? o.quantity)}
                    {o.completed_quantity !== null && o.completed_quantity < o.quantity && (
                      <div className="cell-sub">of {num(o.quantity)}</div>
                    )}
                  </td>
                  <td>
                    {o.released_date}
                    <div className="cell-sub">{o.released_by}</div>
                  </td>
                  <td>
                    {o.completed_date ?? '—'}
                    <div className="cell-sub">{o.completed_by}</div>
                  </td>
                  <td className="num">{num(o.planned_minutes, 0)}</td>
                  <td className="num">{num(o.elapsed_work_minutes, 0)}</td>
                  <td className="num">
                    <Gauge value={o.penetration} />
                  </td>
                  <td>
                    {o.execution_state === 'released' ? (
                      <span className="status-pill pending">Released</span>
                    ) : o.inside_buffer ? (
                      <span className="status-pill ok">Inside buffer</span>
                    ) : (
                      <span className="status-pill off">Buffer blown</span>
                    )}
                  </td>
                  {canRun && (
                    <td className="actions">
                      {o.execution_state === 'released' && (
                        <div className="confirm-form">
                          <label>
                            Completed on
                            <input
                              type="date"
                              value={f(o.order_no).date ?? ''}
                              onChange={(e) => set(o.order_no, 'date', e.target.value)}
                            />
                          </label>
                          <label>
                            Quantity
                            <input
                              inputMode="decimal"
                              value={f(o.order_no).quantity ?? o.quantity}
                              onChange={(e) => set(o.order_no, 'quantity', e.target.value)}
                            />
                          </label>
                          <label>
                            Elapsed work minutes
                            <input
                              inputMode="decimal"
                              value={f(o.order_no).elapsed ?? ''}
                              placeholder={String(Math.round(o.planned_minutes ?? 0))}
                              onChange={(e) => set(o.order_no, 'elapsed', e.target.value)}
                            />
                          </label>
                          <button
                            className="button"
                            disabled={busy}
                            onClick={() =>
                              act('work-orders/complete', {
                                order: o.order_no,
                                date: f(o.order_no).date,
                                quantity: Number(f(o.order_no).quantity ?? o.quantity),
                                elapsed: Number(f(o.order_no).elapsed),
                              })
                            }
                          >
                            Record completion
                          </button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {data && data.items.length === 0 && (
                <tr>
                  <td colSpan={canRun ? 10 : 9}>No work has been released yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

// Planning → Downtime: log a stoppage and see the promises it puts at risk.
export function Downtime({
  csrf,
  plantId,
  permissions,
  refreshKey,
}: {
  csrf: string;
  plantId: string;
  permissions: string[];
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const canRun = permissions.includes('production.execute');
  const [data, setData] = useState<any>(null),
    [resources, setResources] = useState<any[]>([]),
    [form, setForm] = useState({ resource: '', machine: '', date: '', minutes: '', reason: '' }),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    Promise.all([call(`plants/${plantId}/downtime`), call(`plants/${plantId}/schedule/resources`)])
      .then(([d, r]) => {
        if (!live) return;
        setData(d);
        setResources(r.items ?? []);
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [plantId, refreshKey, tick]);
  const done = (d: any) => {
    setNotice(d.message);
    setTick((x) => x + 1);
  };
  return (
    <>
      <Messages error={error} notice={notice} />
      {canRun && (
        <section className="panel company-form">
          <h2>Log a breakdown</h2>
          <p className="panel-sub">
            Minutes lost on a resource on a day. The schedule loses them, and the promises that
            become late are listed below: nothing is scripted.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              call(`plants/${plantId}/downtime`, 'POST', {
                ...form,
                minutes: Number(form.minutes),
                machine: form.machine === '' ? null : Number(form.machine),
              })
                .then(done)
                .catch((err) => setError(err.message))
                .finally(() => setBusy(false));
            }}
          >
            <fieldset disabled={busy}>
              <div className="form-grid">
                <label>
                  Resource
                  <select
                    value={form.resource}
                    onChange={(e) => setForm({ ...form, resource: e.target.value })}
                    required
                  >
                    <option value="">Choose…</option>
                    {resources.map((r: any) => (
                      <option key={r.resource_id} value={r.code}>
                        {r.code} {r.name} {r.drum ? '(drum)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Machine (blank = the whole resource)
                  <input
                    inputMode="numeric"
                    value={form.machine}
                    onChange={(e) => setForm({ ...form, machine: e.target.value })}
                  />
                </label>
                <label>
                  Date
                  <input
                    type="date"
                    value={form.date}
                    onChange={(e) => setForm({ ...form, date: e.target.value })}
                    required
                  />
                </label>
                <label>
                  Minutes lost
                  <input
                    inputMode="numeric"
                    value={form.minutes}
                    onChange={(e) => setForm({ ...form, minutes: e.target.value })}
                    required
                  />
                </label>
                <label>
                  Reason
                  <input
                    value={form.reason}
                    onChange={(e) => setForm({ ...form, reason: e.target.value })}
                    maxLength={200}
                    required
                  />
                </label>
              </div>
              <div className="form-actions">
                <button className="button primary">Log downtime</button>
              </div>
            </fieldset>
          </form>
        </section>
      )}
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Promises at risk</h2>
            <p className="panel-sub">
              {data?.atRisk?.previous
                ? `Calculation #${data.atRisk.runNo} against #${data.atRisk.previous}: orders that are late now and were not, or later than they were.`
                : 'Two calculations are needed to compare.'}
            </p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Promise</th>
                <th>Was finishing</th>
                <th>Now finishing</th>
                <th className="num">Days late</th>
              </tr>
            </thead>
            <tbody>
              {(data?.atRisk?.items ?? []).map((r: any) => (
                <tr key={r.order} data-at-risk={r.order}>
                  <td>
                    <strong>{r.order}</strong>
                  </td>
                  <td>{r.promise}</td>
                  <td>{r.was}</td>
                  <td>{r.now}</td>
                  <td className="num">{r.days}</td>
                </tr>
              ))}
              {data && (data.atRisk?.items ?? []).length === 0 && (
                <tr>
                  <td colSpan={5}>No promise is newly at risk.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Breakdown log</h2>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Resource</th>
                <th>Date</th>
                <th className="num">Minutes</th>
                <th>Reason</th>
                <th>State</th>
                {canRun && <th className="actions">Action</th>}
              </tr>
            </thead>
            <tbody>
              {(data?.items ?? []).map((d: any) => (
                <tr key={d.id} data-downtime={'DT-' + d.event_no}>
                  <td>
                    <strong>DT-{d.event_no}</strong>
                    <div className="cell-sub">{d.logged_by}</div>
                  </td>
                  <td>
                    {d.resource}
                    <div className="cell-sub">
                      {d.resource_name}
                      {d.machine ? ` · machine ${d.machine}` : ' · every machine'}
                    </div>
                  </td>
                  <td>{d.event_date}</td>
                  <td className="num">{num(d.minutes, 0)}</td>
                  <td>{d.reason}</td>
                  <td>
                    <span className={'status-pill ' + (d.state === 'open' ? 'off' : 'ok')}>
                      {d.state === 'open' ? 'Stopped' : 'Back'}
                    </span>
                  </td>
                  {canRun && (
                    <td className="actions">
                      {d.state === 'open' && (
                        <button
                          className="button"
                          disabled={busy}
                          onClick={() => {
                            setBusy(true);
                            call(`plants/${plantId}/downtime/${d.id}/close`, 'POST', {})
                              .then(done)
                              .catch((e) => setError(e.message))
                              .finally(() => setBusy(false));
                          }}
                        >
                          Machine is back
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {data && data.items.length === 0 && (
                <tr>
                  <td colSpan={canRun ? 7 : 6}>Nothing logged.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

// Planning → Cycle time audit: the maintained standards against what production actually took.
export function CycleTimeAudit({
  csrf,
  plantId,
  permissions,
  refreshKey,
}: {
  csrf: string;
  plantId: string;
  permissions: string[];
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const canAdopt = permissions.includes('masters.cycle_time');
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    call(`plants/${plantId}/cycle-time-audit`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [plantId, refreshKey, tick]);
  const flagged = (data?.rows ?? []).filter((r: any) => r.flagged);
  return (
    <>
      <Messages error={error} notice={notice} />
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Master-data self-audit</h2>
            <p className="panel-sub">
              Maintained cycle times against what production actually took, from completed work
              orders alone. A standard is flagged when it has at least{' '}
              {data?.rule?.minCompletions ?? 5} completions, every one of them is on the same side
              of the standard, and the drift is {data?.rule?.driftPct ?? 10}% or more. Adopting a
              correction writes a new routing revision; it is audited and the old one is kept.
            </p>
          </div>
        </div>
        {data && (
          <div className="zone-tiles schedule-tiles">
            <div className="zone-tile">
              <strong>{data.rows.length}</strong>
              <span>Items audited</span>
              <span className="cell-sub">of {data.items} routed items</span>
            </div>
            <div className="zone-tile">
              <strong>{flagged.length}</strong>
              <span>Standards flagged</span>
              <span className="cell-sub">
                {flagged
                  .map((r: any) => `${r.item} ${r.drift > 0 ? '+' : ''}${r.drift}%`)
                  .join(' · ') || 'none'}
              </span>
            </div>
            <div className="zone-tile">
              <strong>{data.completions}</strong>
              <span>Evidence</span>
              <span className="cell-sub">completed work orders</span>
            </div>
          </div>
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Standard (min/unit)</th>
                <th className="num">Actual</th>
                <th className="num">Completions</th>
                <th className="num">Drift</th>
                <th>Consistency</th>
                {canAdopt && <th className="actions">Action</th>}
              </tr>
            </thead>
            <tbody>
              {(data?.rows ?? []).map((r: any) => (
                <tr key={r.item} data-audit={r.item}>
                  <td>
                    <strong>{r.item}</strong>
                    {r.adoptedAt && (
                      <div className="cell-sub">
                        corrected {new Date(r.adoptedAt).toLocaleDateString()}
                      </div>
                    )}
                  </td>
                  <td className="num">{num(r.standard, 3)}</td>
                  <td className="num">{num(r.actual, 2)}</td>
                  <td className="num">{r.completions}</td>
                  <td className="num">
                    {r.drift > 0 ? '+' : ''}
                    {r.drift}%
                  </td>
                  <td>
                    {r.flagged ? (
                      <span className="status-pill off">Consistently wrong</span>
                    ) : r.consistent ? (
                      <span className="status-pill pending">Consistent, small</span>
                    ) : (
                      <span className="status-pill ok">Inside noise</span>
                    )}
                  </td>
                  {canAdopt && (
                    <td className="actions">
                      {r.flagged && (
                        <button
                          className="button"
                          disabled={busy}
                          onClick={() => {
                            setBusy(true);
                            setError('');
                            call(`plants/${plantId}/cycle-time-audit/adopt`, 'POST', {
                              item: r.item,
                            })
                              .then((d) => {
                                setNotice(d.message);
                                setTick((x) => x + 1);
                              })
                              .catch((e) => setError(e.message))
                              .finally(() => setBusy(false));
                          }}
                        >
                          Adopt {num(r.actual, 2)}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {data && data.rows.length === 0 && (
                <tr>
                  <td colSpan={canAdopt ? 7 : 6}>
                    No completed work orders yet: complete some work and the audit builds itself.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
