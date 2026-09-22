import { useEffect, useState } from 'react';
import { useApi } from './api-client';
import { Messages } from './plant-model';

// AV-6 screens: Scheduler (sequence and release schedule), Gantt, Resource load, plant planning
// settings and a made item's lead time at planned loading.

const num = (v: unknown, digits = 2) =>
  v === null || v === undefined || v === ''
    ? '—'
    : Number(v).toLocaleString('en-IN', { maximumFractionDigits: digits });
const pct = (v: unknown) => (v === null || v === undefined ? '—' : `${num(Number(v) * 100, 1)}%`);
const qs = (base: string, params: Record<string, string | number | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `${base}?${s}` : base;
};
const hue = (code: string) => {
  let h = 0;
  for (const c of code) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};

// Working minute -> date and clock time, through the plant's shifts.
function clock(header: any, minute: number | string | null) {
  if (minute === null || minute === undefined || !header?.day_minutes) return '—';
  const m = Number(minute);
  const D = header.day_minutes;
  const day = Math.min(header.dates.length - 1, Math.max(0, Math.floor(m / D + 1e-9)));
  let offset = m - day * D;
  let t = 0;
  for (const s of header.shifts ?? []) {
    if (offset <= s.minutes + 1e-9) {
      t = s.start + offset;
      break;
    }
    offset -= s.minutes;
    t = s.start + s.minutes;
  }
  t = Math.round(t) % 1440;
  const hh = String(Math.floor(t / 60)).padStart(2, '0'),
    mm = String(t % 60).padStart(2, '0');
  return `${header.dates[day] ?? ''} ${hh}:${mm}`;
}
const days = (minutes: unknown, header: any) =>
  minutes === null || minutes === undefined || !header?.day_minutes
    ? '—'
    : num(Number(minutes) / header.day_minutes, 2);

function ViewSwitch({ view, setView, publication }: any) {
  return (
    <div className="toolbar view-switch">
      <label>
        Show
        <select value={view} onChange={(e) => setView(e.target.value)}>
          <option value="current">Latest calculation</option>
          <option value="published" disabled={!publication}>
            {publication
              ? `Published plan (run #${publication.run_no})`
              : 'Published plan (none yet)'}
          </option>
        </select>
      </label>
    </div>
  );
}

function PublishBar({ data, permissions, csrf, onPublished }: any) {
  const call = useApi(csrf);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [note, setNote] = useState('');
  const pub = data?.publication;
  const runNo = data?.header?.run_no;
  const canPublish = permissions.includes('schedule.publish');
  return (
    <div className="publish-bar">
      <Messages error={error} notice="" />
      <p className="panel-sub">
        {pub ? (
          <>
            Published plan: run #{pub.run_no} by {pub.published_by ?? '—'} on{' '}
            {new Date(pub.published_at).toLocaleString()}
            {pub.note ? ` — “${pub.note}”` : ''}.{' '}
            {pub.current ? (
              <span className="status-pill ok">Matches the latest calculation</span>
            ) : (
              <span className="status-pill pending">The latest calculation differs</span>
            )}
          </>
        ) : (
          'No schedule published yet for this plant.'
        )}
      </p>
      {canPublish && runNo && !pub?.current && (
        <form
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            call(`plants/${data.plantId}/schedule/publish`, 'POST', { runNo, note })
              .then((d) => {
                setNote('');
                onPublished(d.message);
              })
              .catch((err) => setError(err.message))
              .finally(() => setBusy(false));
          }}
        >
          <input
            aria-label="Publish note"
            placeholder="Note (optional)"
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button className="button primary" disabled={busy || !data?.status?.upToDate}>
            Publish run #{runNo}
          </button>
        </form>
      )}
    </div>
  );
}

// ---------- Scheduler ----------

const MATERIAL: Record<string, [string, string]> = {
  clear: ['ok', 'Clear'],
  gated: ['off', 'Gated'],
  unknown: ['pending', 'Cannot validate'],
};

export function Scheduler({
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
  const [view, setView] = useState('current'),
    [filter, setFilter] = useState(''),
    [query, setQuery] = useState(''),
    [q, setQ] = useState(''),
    [cursors, setCursors] = useState<string[]>([]),
    [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    call(qs(`plants/${plantId}/schedule`, { view, filter, q, cursor: cursors[cursors.length - 1] }))
      .then((d) => live && setData({ ...d, plantId }))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [plantId, view, filter, q, cursors, tick, refreshKey]);
  // While a recalculation is pending, check again every few seconds.
  useEffect(() => {
    if (!data?.status || data.status.upToDate) return;
    const t = setTimeout(() => setTick((x) => x + 1), 3000);
    return () => clearTimeout(t);
  }, [data]);
  const h = data?.header;
  return (
    <>
      <Messages error={error} notice={notice} />
      <section className="panel planning-status">
        <div className="panel-heading">
          <div>
            <h2>Scheduler</h2>
            <p className="panel-sub">
              Open production orders in sequence: due date first, same item within the grouping
              window run back to back unless that makes another order late. Every operation is timed
              forward on its machine; the drum is the most loaded resource.{' '}
              {data?.status?.fixedDate && (
                <span className="status-pill pending">
                  Simulation: planning date fixed at {data.status.fixedDate}
                </span>
              )}{' '}
              {data?.status &&
                (data.status.upToDate ? (
                  <span className="status-pill ok">Up to date</span>
                ) : (
                  <span className="status-pill pending" role="status">
                    Recalculating…
                  </span>
                ))}
            </p>
          </div>
          <ViewSwitch
            view={view}
            setView={(v: string) => {
              setCursors([]);
              setView(v);
            }}
            publication={data?.publication}
          />
        </div>
        {h && (
          <div className="zone-tiles schedule-tiles">
            <div className="zone-tile">
              <strong>{h.orders}</strong>
              <span>Orders scheduled (run #{h.run_no})</span>
            </div>
            <div className={'zone-tile ' + (h.late ? 'red' : 'green')}>
              <strong>{h.late}</strong>
              <span>Late against promise</span>
            </div>
            <div className="zone-tile">
              <strong>{h.drum ?? '—'}</strong>
              <span>Drum{h.drum_name ? ` — ${h.drum_name}` : ''}</span>
            </div>
            <div className="zone-tile">
              <strong>{days(h.makespan_min, h)} d</strong>
              <span>Last finish, working days from {h.start_date}</span>
            </div>
            <div className="zone-tile">
              <strong>{num(h.changeover_saved_min, 0)} min</strong>
              <span>Drum changeover saved by grouping</span>
            </div>
            {h.unscheduled > 0 && (
              <div className="zone-tile missing">
                <strong>{h.unscheduled}</strong>
                <span>Not schedulable (no routing)</span>
              </div>
            )}
          </div>
        )}
        {h?.messages?.length > 0 && (
          <ul className="messages">
            {h.messages.map((m: string) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
        {data && (
          <PublishBar
            data={data}
            permissions={permissions}
            csrf={csrf}
            onPublished={(m: string) => {
              setNotice(m);
              setTick((x) => x + 1);
            }}
          />
        )}
      </section>
      <section className="panel">
        <div className="toolbar panel-toolbar">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setCursors([]);
              setQ(query.trim().toLowerCase());
            }}
          >
            <input
              aria-label="Schedule search"
              placeholder="Order or item starts with…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button className="button">Search</button>
          </form>
          <label>
            Show
            <select
              value={filter}
              onChange={(e) => {
                setCursors([]);
                setFilter(e.target.value);
              }}
            >
              <option value="">All orders in sequence</option>
              <option value="late">Late against promise</option>
              <option value="gated">Material gated or unknown</option>
              <option value="unscheduled">Not schedulable</option>
            </select>
          </label>
        </div>
        <div className="table-wrap">
          <table className="schedule-table">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Order</th>
                <th>Item</th>
                <th className="num">Quantity</th>
                <th>Release (start)</th>
                <th>Finish</th>
                <th>Promise</th>
                <th className="num">Slack (days)</th>
                <th>Status</th>
                <th>Materials</th>
              </tr>
            </thead>
            <tbody>
              {(data?.items ?? []).map((o: any) => {
                const m = MATERIAL[o.material_check];
                return (
                  <tr key={o.id} className={o.late_days > 0 ? 'late' : ''}>
                    <td className="num">{o.position}</td>
                    <td>
                      <strong>{o.order_no}</strong>
                      {o.grouped_with && (
                        <div className="cell-sub">Grouped after {o.grouped_with}</div>
                      )}
                    </td>
                    <td>
                      {o.item}
                      <div className="cell-sub">{o.item_name}</div>
                    </td>
                    <td className="num">
                      {num(o.quantity)} {o.unit}
                    </td>
                    <td className="nowrap">{clock(h, o.start_min)}</td>
                    <td className="nowrap">{clock(h, o.finish_min)}</td>
                    <td className="nowrap">{o.promise_date}</td>
                    <td className="num">{o.slack_min === null ? '—' : days(o.slack_min, h)}</td>
                    <td>
                      {o.status === 'unscheduled' ? (
                        <span className="status-pill off">Not schedulable</span>
                      ) : o.late_days > 0 ? (
                        <span className="status-pill off">
                          Late {o.late_days} day{o.late_days > 1 ? 's' : ''}
                        </span>
                      ) : (
                        <span className="status-pill ok">On time</span>
                      )}
                      {o.messages?.[0] && o.status === 'unscheduled' && (
                        <div className="cell-sub">{o.messages[0]}</div>
                      )}
                    </td>
                    <td>
                      {m ? <span className={'status-pill ' + m[0]}>{m[1]}</span> : '—'}
                      {o.material_check !== 'clear' &&
                        o.messages?.[0] &&
                        o.status !== 'unscheduled' && (
                          <div className="cell-sub">{o.messages[0]}</div>
                        )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!data && <p role="status">Loading schedule…</p>}
        {data && !data.items?.length && (
          <div className="empty">{data.empty ?? 'No orders match this view.'}</div>
        )}
        <div className="table-footer">
          <button className="button" disabled={!cursors.length} onClick={() => setCursors([])}>
            First page
          </button>
          <button
            className="button"
            disabled={!data?.nextCursor}
            onClick={() => setCursors([...cursors, data.nextCursor])}
          >
            Next page
          </button>
        </div>
      </section>
    </>
  );
}

// ---------- Gantt ----------

export function Gantt({
  csrf,
  plantId,
  refreshKey,
}: {
  csrf: string;
  plantId: string;
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const [view, setView] = useState('current'),
    [from, setFrom] = useState(0),
    [span, setSpan] = useState(7),
    [resource, setResource] = useState(''),
    [data, setData] = useState<any>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    call(qs(`plants/${plantId}/schedule/gantt`, { view, from, days: span, resource }))
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [plantId, view, from, span, resource, refreshKey]);
  const h = data?.header;
  const D = h?.day_minutes ?? 1;
  const t0 = from * D,
    t1 = (from + span) * D;
  const x = (t: number) => `${(Math.max(0, Math.min(t1, t) - t0) / (t1 - t0)) * 100}%`;
  const w = (a: number, b: number) =>
    `${Math.max(0.15, ((Math.min(t1, b) - Math.max(t0, a)) / (t1 - t0)) * 100)}%`;
  const lanes: { key: string; resource: any; machine: number }[] = [];
  for (const r of data?.resources ?? []) {
    if (resource && r.resource_id !== resource) continue;
    if (!resource && Number(r.run_min) === 0) continue;
    for (let m = 1; m <= r.machines; m++)
      lanes.push({ key: r.resource_id + '|' + m, resource: r, machine: m });
  }
  const blocks = new Map<string, any[]>();
  for (const b of data?.blocks ?? []) {
    const k = b.resource_id + '|' + b.machine;
    if (!blocks.has(k)) blocks.set(k, []);
    blocks.get(k)!.push(b);
  }
  const lastDay = Math.max(0, (h?.dates?.length ?? 1) - 1);
  return (
    <>
      <Messages error={error} notice="" />
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Gantt, machine level</h2>
            <p className="panel-sub">
              Every operation on its machine, in plant working time. Hatched blocks are changeovers.
              Hover a block for the order, item, quantity and times.
            </p>
          </div>
          <ViewSwitch view={view} setView={setView} publication={data?.publication} />
        </div>
        <div className="toolbar panel-toolbar">
          <label>
            Resource
            <select value={resource} onChange={(e) => setResource(e.target.value)}>
              <option value="">All loaded resources</option>
              {(data?.resources ?? []).map((r: any) => (
                <option key={r.resource_id} value={r.resource_id}>
                  {r.code} — {r.name}
                  {r.drum ? ' (drum)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            Days shown
            <select value={span} onChange={(e) => setSpan(Number(e.target.value))}>
              {[3, 7, 14, 31].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <div>
            <button
              className="button"
              disabled={from === 0}
              onClick={() => setFrom(Math.max(0, from - span))}
            >
              ← Earlier
            </button>{' '}
            <button
              className="button"
              disabled={from + span > lastDay}
              onClick={() => setFrom(from + span)}
            >
              Later →
            </button>
          </div>
        </div>
        {!data && <p role="status">Loading Gantt…</p>}
        {data && !h?.day_minutes && <div className="empty">{data.empty ?? 'No schedule.'}</div>}
        {h?.day_minutes > 0 && (
          <div className="gantt" role="img" aria-label="Machine Gantt chart">
            <div className="gantt-row gantt-axis">
              <div className="gantt-label" />
              <div className="gantt-track">
                {Array.from({ length: span }, (_, i) => (
                  <span
                    key={i}
                    className="gantt-day"
                    style={{ left: `${(i / span) * 100}%`, width: `${100 / span}%` }}
                  >
                    {h.dates[from + i] ?? ''}
                  </span>
                ))}
              </div>
            </div>
            {lanes.map((l) => (
              <div key={l.key} className={'gantt-row' + (l.resource.drum ? ' drum' : '')}>
                <div className="gantt-label">
                  <strong>{l.resource.code}</strong> #{l.machine}
                  {l.resource.drum && l.machine === 1 && <span className="chip">drum</span>}
                </div>
                <div className="gantt-track">
                  {Array.from({ length: span }, (_, i) => (
                    <span key={i} className="gantt-grid" style={{ left: `${(i / span) * 100}%` }} />
                  ))}
                  {(blocks.get(l.key) ?? []).flatMap((b: any) => {
                    const eff = Number(b.efficiency_pct) / 100;
                    const start = Number(b.start_min),
                      finish = Number(b.finish_min),
                      chg = Number(b.changeover_min) / eff;
                    const out = [];
                    if (chg > 0 && start > t0)
                      out.push(
                        <span
                          key={b.order_no + b.operation_code + 'c'}
                          className="gantt-block changeover"
                          style={{ left: x(start - chg), width: w(start - chg, start) }}
                          title={`Changeover to ${b.item}: ${num(b.changeover_min, 0)} min`}
                        />,
                      );
                    out.push(
                      <span
                        key={b.order_no + b.operation_code}
                        className="gantt-block"
                        style={{
                          left: x(start),
                          width: w(start, finish),
                          background: `hsl(${hue(b.item)},45%,48%)`,
                        }}
                        title={`${b.order_no} · ${b.item} × ${num(b.quantity)} · ${b.operation_code}\n${clock(h, start)} → ${clock(h, finish)}`}
                      >
                        {b.order_no}
                      </span>,
                    );
                    return out;
                  })}
                </div>
              </div>
            ))}
            {data.truncated && (
              <p className="cell-sub">
                Too many operations in this window: choose one resource or fewer days.
              </p>
            )}
          </div>
        )}
      </section>
    </>
  );
}

// ---------- Resource load ----------

export function ResourceLoad({
  csrf,
  plantId,
  refreshKey,
}: {
  csrf: string;
  plantId: string;
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const [view, setView] = useState('current'),
    [data, setData] = useState<any>(null),
    [open, setOpen] = useState<string | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    call(qs(`plants/${plantId}/schedule/resources`, { view }))
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [plantId, view, refreshKey]);
  const h = data?.header;
  const shown = Math.min(14, h?.dates?.length ?? 0);
  return (
    <>
      <Messages error={error} notice="" />
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Resource load</h2>
            <p className="panel-sub">
              Run and changeover minutes per resource from the machine allocation, and the busy
              share of each working day from the timed schedule. Utilisation is load over capacity
              from tomorrow to the latest promise (or the last finish, if later).
            </p>
          </div>
          <ViewSwitch view={view} setView={setView} publication={data?.publication} />
        </div>
        {!data && <p role="status">Loading resource load…</p>}
        {data && !data.items?.length && <div className="empty">{data.empty ?? 'No schedule.'}</div>}
        {data?.items?.length > 0 && (
          <div className="table-wrap">
            <table className="load-table">
              <thead>
                <tr>
                  <th>Resource</th>
                  <th className="num">Machines</th>
                  <th className="num">Run min</th>
                  <th className="num">Changeover min</th>
                  <th className="num">Changeovers</th>
                  <th className="num">Capacity/day</th>
                  <th className="num">Utilisation</th>
                  {Array.from({ length: shown }, (_, i) => (
                    <th key={i} className="num day-col">
                      {h.dates[i]?.slice(5)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map((r: any) => [
                  <tr
                    key={r.resource_id}
                    className={'clickable' + (r.drum ? ' drum' : '')}
                    onClick={() => setOpen(open === r.resource_id ? null : r.resource_id)}
                  >
                    <td>
                      <button
                        className="text-button cell-link"
                        aria-expanded={open === r.resource_id}
                      >
                        <strong>{r.code}</strong>
                      </button>{' '}
                      {r.drum && <span className="chip">drum</span>}
                      <div className="cell-sub">{r.name}</div>
                    </td>
                    <td className="num">{r.machines}</td>
                    <td className="num">{num(r.run_min, 0)}</td>
                    <td className="num">{num(r.changeover_min, 0)}</td>
                    <td className="num">{r.changeovers}</td>
                    <td className="num">{num(r.capacity_per_day, 0)}</td>
                    <td className="num">
                      <strong>{pct(r.utilization)}</strong>
                    </td>
                    {Array.from({ length: shown }, (_, i) => {
                      const v = Number(r.days?.[i] ?? 0);
                      return (
                        <td
                          key={i}
                          className="num load-cell"
                          style={{
                            background:
                              v > 0
                                ? `rgba(172,116,46,${Math.min(0.85, 0.12 + v * 0.7)})`
                                : undefined,
                          }}
                          title={`${h.dates[i]}: ${num(v * 100, 1)}% busy`}
                        >
                          {v > 0 ? Math.round(v * 100) : ''}
                        </td>
                      );
                    })}
                  </tr>,
                  open === r.resource_id && (
                    <tr key={r.resource_id + '-lanes'} className="detail-row">
                      <td colSpan={7 + shown}>
                        <table className="compact">
                          <thead>
                            <tr>
                              <th>Machine</th>
                              <th className="num">Run min</th>
                              <th className="num">Changeover min</th>
                              <th className="num">Changeovers</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.lanes.map((l: any) => (
                              <tr key={l.machine}>
                                <td>
                                  {r.code} #{l.machine}
                                </td>
                                <td className="num">{num(l.run, 0)}</td>
                                <td className="num">{num(l.changeover, 0)}</td>
                                <td className="num">{l.changeovers}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <p className="cell-sub">
                          Capacity = {r.machines} machine(s) × {h.day_minutes} working min/day ×{' '}
                          {num(r.efficiency_pct)}% efficiency; changeover{' '}
                          {num(r.changeover_minutes, 0)} min per item change
                          {r.planned_utilization_pct !== null
                            ? `; planned utilisation ${num(r.planned_utilization_pct)}% (lead time basis)`
                            : ''}
                          .
                        </p>
                      </td>
                    </tr>
                  ),
                ])}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

// ---------- Plant planning settings ----------

export function PlanningSettings({
  csrf,
  plantId,
  canManage,
  refreshKey,
}: {
  csrf: string;
  plantId: string;
  canManage: boolean;
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const [form, setForm] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    call(`plants/${plantId}/planning-settings`)
      .then(
        (d) =>
          live &&
          setForm({
            ...d,
            day_weights: d.day_weights ? d.day_weights.join(', ') : '',
          }),
      )
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [plantId, revision, refreshKey]);
  if (!form) return <Messages error={error} notice="" />;
  const weights = String(form.day_weights || '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  const factor = weights.length === 31 ? (weights[Number(form.profile_day) - 1] * 31) / 100 : null;
  return (
    <>
      <Messages error={error} notice={notice} />
      <section className="panel company-form">
        <h2>Plant planning settings</h2>
        <p className="panel-sub">
          How this plant groups orders on the scheduler and which lead time sizes the buffers of
          made items.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            call(`plants/${plantId}/planning-settings`, 'PUT', {
              club_window_days: String(form.club_window_days),
              lead_time_basis: form.lead_time_basis,
              profile_day: String(form.profile_day),
              day_weights: form.day_weights,
              version: Number(form.version),
            })
              .then((d) => {
                setNotice(d.message);
                setRevision((x) => x + 1);
              })
              .catch((err) => setError(err.message))
              .finally(() => setBusy(false));
          }}
        >
          <fieldset disabled={!canManage || busy}>
            <div className="form-grid">
              <label>
                Grouping window (days)
                <input
                  inputMode="numeric"
                  value={form.club_window_days}
                  onChange={(e) => setForm({ ...form, club_window_days: e.target.value })}
                />
              </label>
              <label>
                Lead time of made items
                <select
                  value={form.lead_time_basis}
                  onChange={(e) => setForm({ ...form, lead_time_basis: e.target.value })}
                >
                  <option value="FIXED">Master lead time (fixed)</option>
                  <option value="PLANNED_LOAD">Master plus queue at planned loading</option>
                </select>
              </label>
              <label>
                Day of the month for the profile
                <input
                  inputMode="numeric"
                  value={form.profile_day}
                  onChange={(e) => setForm({ ...form, profile_day: e.target.value })}
                />
              </label>
            </div>
            <label>
              Despatch profile: 31 shares of a month's volume, one per day (blank = level)
              <textarea
                rows={3}
                value={form.day_weights}
                onChange={(e) => setForm({ ...form, day_weights: e.target.value })}
              />
            </label>
            <p className="cell-sub">
              Same-item orders due within the grouping window run back to back when no other order
              becomes late (0 = strict due-date order). At planned loading, each routed resource
              adds a queue of processing × u / (1 − u), where u is its planned utilisation × the
              profile factor of the chosen day
              {factor !== null ? ` (${num(factor, 4)} on day ${form.profile_day})` : ''}; at 95% or
              more the zones stay on the master lead time.
            </p>
            {canManage && (
              <div className="form-actions">
                <button className="button primary">Save settings</button>
              </div>
            )}
          </fieldset>
        </form>
      </section>
    </>
  );
}

// ---------- Lead time reality (buffer board details of a made item) ----------

export function LeadTimeReality({
  csrf,
  plantId,
  itemId,
}: {
  csrf: string;
  plantId: string;
  itemId: string;
}) {
  const call = useApi(csrf);
  const [r, setR] = useState<any>(undefined);
  useEffect(() => {
    let live = true;
    call(`plants/${plantId}/lead-time/${itemId}`)
      .then((d) => live && setR(d.reality))
      .catch(() => live && setR(null));
    return () => {
      live = false;
    };
  }, [plantId, itemId]);
  if (!r) return null;
  return (
    <div className="table-wrap lead-time-reality">
      <table className="compact">
        <caption>
          Lead time down the routing at planned loading
          {r.basis === 'PLANNED_LOAD'
            ? ' (used for the zones)'
            : ' (shown only; the plant uses the master lead time)'}
          : {r.unbounded ? 'unbounded' : `${num(r.days, 2)} days`} = master {r.master_days} d +
          queue {num(r.queue_days, 2)} d, for a lot of {num(r.lot)}; day factor{' '}
          {num(r.day_factor, 4)}
        </caption>
        <thead>
          <tr>
            <th>Operation</th>
            <th>Resource</th>
            <th className="num">Utilisation</th>
            <th className="num">Processing (days)</th>
            <th className="num">Queue (days)</th>
          </tr>
        </thead>
        <tbody>
          {r.stations.map((s: any) => (
            <tr key={s.operation}>
              <td>{s.operation}</td>
              <td>{s.resource}</td>
              <td className="num">{pct(s.utilization)}</td>
              <td className="num">{num(s.proc_days, 4)}</td>
              <td className="num">{s.wait_days === null ? 'unbounded' : num(s.wait_days, 4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
