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
  clear: ['ok', 'Clear to commit'],
  replenish: ['ok', 'Commit + replenish'],
  expedite: ['off', 'Expedite or quote later'],
  unknown: ['pending', 'Cannot validate'],
  gated: ['off', 'Gated'],
};
const REASONS: Record<string, (r: any) => string> = {
  cannot_validate: (r) => `Cannot validate stock / BOM / routing for ${r.orders.join(', ')}`,
  material_short: (r) =>
    'Material short at the grouped release: ' +
    r.components.map((c: any) => `${c.component} ${num(c.shortage, 3)}`).join('; '),
  members_late: (r) => `Members finish after their promise: ${r.orders.join(', ')}`,
  promises_broken: (r) => `Other promises become late or later: ${r.orders.join(', ')}`,
  pull_forward: (r) => `Pulls ${num(r.days, 3)} days forward; the limit is ${r.limit} day(s)`,
  no_saving: () => 'No measured setup saving',
  material_hurt: (r) => `Takes material from other orders: ${r.orders.join(', ')}`,
  already_adjacent: () => 'Already adjacent on the same machines: no new saving',
  separate_better: () => 'Running separately has lower carry / impact',
};
const DECISION_KINDS: Record<string, string> = {
  club: 'Club applied',
  declub: 'Declub',
  move: 'Moved by hand',
  release_manual: 'Released to computed order',
  insert: 'Order inserted',
  quote: 'Declined, date quoted',
  expedite_request: 'Expedite requested',
  expedite_approve: 'Expedite approved',
  expedite_reject: 'Expedite rejected',
  expedite_confirm: 'Supplier confirmation recorded',
  later_propose: 'Later date proposed',
  later_confirm: 'Confirmed and rescheduled',
  later_move: 'Moved down the queue',
  pending_ready: 'Customer date received',
  pending_cancel: 'Pending order cancelled',
};
// AV-8: an order's decision state (see packages/engines/materials-decisions.mjs).
const ORDER_STATES: Record<string, string> = {
  decision_required: 'Decision required: expedite or quote later',
  expedite_pending: 'Scheduled: expedite pending',
  conditional_expedite: 'Scheduled: conditional on confirmed expedite',
  material_clear: 'Scheduled: material clear',
  awaiting_confirmation: 'Awaiting customer date confirmation',
  ready_to_reschedule: 'Ready to reschedule',
  cancelled: 'Cancelled',
};
const ACTION_TYPES: Record<string, string> = {
  EXPEDITE_PO: 'Expedite existing PO',
  NEW_PO: 'Create expedited PO',
  CANNOT_VALIDATE: 'Cannot validate',
};
const ACTION_STATES: Record<string, [string, string]> = {
  requested: ['pending', 'Requested'],
  approved: ['pending', 'Approved: confirmation pending'],
  confirmed: ['ok', 'Confirmed by supplier'],
  late: ['off', 'Confirmed late'],
  rejected: ['off', 'Rejected'],
  superseded: ['pending', 'Superseded'],
  cannot_validate: ['off', 'Cannot validate'],
};
const reasonText = (r: any) => (REASONS[r.code] ?? (() => r.code))(r);
const insertEffect = (x: any) =>
  x.scenario?.key === 'decline'
    ? `${num(x.qty, 0)} ${x.item} declined for ${x.needDate}; quoted ${x.quoteDate}`
    : `${num(x.qty, 0)} ${x.item}: ${x.scenario?.label}; ${(x.lots ?? [])
        .map((l: any) => `${num(l.qty, 0)} on ${l.date}`)
        .join(
          ' + ',
        )}; finish ${x.finishDate ?? '—'}; ${MATERIAL[x.materials]?.[1] ?? x.materials}; ${x.promisesBroken} promise(s) later`;

// Time-phased material readiness of one order.
function ReadinessLines({ lines }: { lines: any[] }) {
  if (!lines?.length)
    return <p className="cell-sub">No BOM lines: materials cannot be validated.</p>;
  return (
    <div className="table-wrap">
      <table className="compact">
        <caption>
          Materials at release: stock on hand plus purchase lines due by the release day, minus what
          earlier-starting orders take first. Overdue purchase lines need a new date and do not
          count.
        </caption>
        <thead>
          <tr>
            <th>Component</th>
            <th className="num">Required</th>
            <th>Release</th>
            <th className="num">Available at release</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>
                <strong>{l.component}</strong>
                {l.zone && <span className={'zone-pill ' + l.zone}>{l.zone}</span>}
              </td>
              <td className="num">{num(l.requirement, 3)}</td>
              <td className="nowrap">{l.release}</td>
              <td className="num">
                {l.available === null ? 'not available' : num(l.available, 3)}
                {l.available !== null && (
                  <div className="cell-sub">
                    on hand {num(l.onHand, 3)} + due {num(l.timely, 3)} − earlier {num(l.before, 3)}
                  </div>
                )}
              </td>
              <td>
                {l.unknown ? (
                  <span className="status-pill pending">No stock position</span>
                ) : l.shortage > 1e-6 ? (
                  <span className="status-pill off">Short {num(l.shortage, 3)}</span>
                ) : (
                  <span className="status-pill ok">
                    Covered{l.replenish ? '; replenish buffer' : ''}
                  </span>
                )}
                {l.overdue > 0 && (
                  <div className="cell-sub">Overdue purchase lines: {num(l.overdue, 3)}</div>
                )}
                {l.later?.length > 0 && (
                  <div className="cell-sub">
                    Later receipts:{' '}
                    {l.later.map((p: any) => `${num(p.qty, 3)} on ${p.due}`).join(', ')}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ImpactReport({ impact, title }: { impact: any; title: string }) {
  if (!impact) return null;
  return (
    <div className="impact-report">
      <strong>{title}</strong>
      <p className="cell-sub">
        {impact.changed} order(s) change start or finish;{' '}
        {impact.broken.length
          ? `${impact.broken.length} promise(s) become late or later: ${impact.broken
              .map((b: any) => `${b.order} (promise ${b.promise}, now ${b.now})`)
              .join('; ')}`
          : 'no promise becomes late or later'}
        {impact.recovered?.length ? `; recovered: ${impact.recovered.join(', ')}` : ''}. Drum
        changeovers {impact.drum.before.changeovers} → {impact.drum.after.changeovers} (
        {num(impact.drum.delta, 0)} min); all resources {num(impact.changeoverDelta, 0)} min.
      </p>
      {impact.rows.length > 0 && (
        <details>
          <summary>Every changed order ({impact.rows.length})</summary>
          <table className="compact">
            <thead>
              <tr>
                <th>Order</th>
                <th className="num">Finish change (h)</th>
                <th>Finish day</th>
                <th>Promise</th>
                <th className="num">Slack after (h)</th>
              </tr>
            </thead>
            <tbody>
              {impact.rows.map((r: any) => (
                <tr key={r.order} className={r.newlyBroken ? 'late' : ''}>
                  <td>{r.order}</td>
                  <td className="num">{num((r.finishAfter - r.finishBefore) / 60, 2)}</td>
                  <td>{r.finishDate}</td>
                  <td>{r.promise}</td>
                  <td className="num">
                    {r.slipDays ? `${r.slipDays} d late` : num(r.slackAfter / 60, 2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

// Club / declub options for one item: preview first, apply one scenario.
function ClubOptions({ csrf, plantId, item, canPlan, onApplied, onClose }: any) {
  const call = useApi(csrf);
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setData(null);
    call(`plants/${plantId}/decisions/club-preview`, 'POST', { item })
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [item]);
  function apply(s: any) {
    setBusy(true);
    setError('');
    call(`plants/${plantId}/decisions/club`, 'POST', {
      item,
      key: s.key,
      orders: s.orders,
      runNo: data.runNo,
      version: data.version,
    })
      .then((d) => onApplied(d))
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }
  return (
    <section className="panel club-options" aria-label={`Club options for ${item}`}>
      <div className="panel-heading">
        <div>
          <h2>Club options for {item}</h2>
          <p className="panel-sub">
            Preview only: nothing changes until you apply a scenario. Same-item orders can run
            together when no other promise gets later, no member finishes late, materials are
            covered at the grouped release, the pull-forward stays within{' '}
            {data?.clubWindowDays ?? '…'} day(s) and a setup is really saved (all resources).
          </p>
        </div>
        <button className="button" onClick={onClose}>
          Close
        </button>
      </div>
      <Messages error={error} notice="" />
      {!data && !error && <p role="status">Evaluating every member set, release day and slot…</p>}
      {data && (
        <div className="scenario-grid">
          {data.scenarios.map((s: any) => (
            <article
              key={s.key}
              className={'scenario-card' + (s.key === data.recommended ? ' recommended' : '')}
            >
              <h3>
                {s.label}
                {s.key === data.recommended && <span className="chip">recommended</span>}
              </h3>
              <p>
                <strong>{s.orders.join(' + ')}</strong>
                {s.day && (
                  <span className="cell-sub">
                    {' '}
                    — released from {s.day}
                    {s.beforeId ? `, before ${s.beforeId}` : ', at the end'}
                  </span>
                )}
              </p>
              <dl className="facts">
                <div>
                  <dt>Setup saved (all resources)</dt>
                  <dd>{num(s.savedMin, 0)} min</dd>
                </div>
                <div>
                  <dt>Extra carry (pulled forward)</dt>
                  <dd>{num(s.carryUnits, 6)} unit-days</dd>
                </div>
                <div>
                  <dt>Finished stock waiting (total)</dt>
                  <dd>{num(s.fgCarryUnits, 6)} unit-days</dd>
                </div>
                <div>
                  <dt>Other orders</dt>
                  <dd>
                    {s.impact.changed} shift, {s.impact.broken.length} newly late
                  </dd>
                </div>
              </dl>
              <table className="compact">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th className="num">Qty</th>
                    <th>Promise</th>
                    <th>Finish</th>
                    <th>Materials</th>
                  </tr>
                </thead>
                <tbody>
                  {s.members.map((m: any) => (
                    <tr key={m.order}>
                      <td>{m.order}</td>
                      <td className="num">{num(m.qty)}</td>
                      <td>{m.promise}</td>
                      <td>{m.finishDate}</td>
                      <td>{MATERIAL[m.materials]?.[1] ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {s.reasons.length > 0 && (
                <ul className="messages">
                  {s.reasons.map((r: any, i: number) => (
                    <li key={i}>{reasonText(r)}</li>
                  ))}
                </ul>
              )}
              {s.excluded.length > 0 && (
                <p className="cell-sub">
                  Not included:{' '}
                  {s.excluded
                    .map((e: any) => `${e.order} (${e.reasons.map(reasonText).join('; ')})`)
                    .join(' · ')}
                </p>
              )}
              {canPlan && s.normal && (
                <button
                  className={'button' + (s.key === data.recommended ? ' primary' : '')}
                  disabled={busy}
                  onClick={() => apply(s)}
                >
                  {s.kind === 'declub' ? 'Apply declub' : 'Apply club'}
                </button>
              )}
              {s.conditional && (
                <p className="cell-sub">Needs an expedite before it can be applied (AV-8).</p>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------- AV-8: expedite and later date ----------
// Reference: Nilkamal simulation handover, Request material expedite / Explore or quote later date.

function ActionRows({ actions }: { actions: any[] }) {
  return (
    <table className="compact">
      <thead>
        <tr>
          <th>Action / component</th>
          <th className="num">Quantity</th>
          <th>Needed by</th>
          <th className="num">On hand / timely</th>
          <th>Existing PO / due</th>
          <th>Orders</th>
        </tr>
      </thead>
      <tbody>
        {actions.map((a: any) => (
          <tr key={a.key} data-action={a.key}>
            <td>
              <strong>{ACTION_TYPES[a.type] ?? a.type}</strong>
              <div className="cell-sub">{a.component ?? 'Missing BOM / routing'}</div>
            </td>
            <td className="num">{a.qty === null ? '—' : num(a.qty, 3)}</td>
            <td>{a.required ?? '—'}</td>
            <td className="num">
              {num(a.onHand, 3)} / {num(a.timely, 3)}
            </td>
            <td>
              {a.po ? `${a.po} / ${a.line}` : 'No adequate existing PO'}
              <div className="cell-sub">{a.currentDue ?? ''}</div>
            </td>
            <td>{(a.members ?? []).join(', ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ExpediteOptions({ csrf, plantId, order, canPlan, onDone, onClose }: any) {
  const call = useApi(csrf);
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setData(null);
    call(`plants/${plantId}/expedite/preview`, 'POST', { order })
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [order]);
  const requestable = data?.actions.some((a: any) => a.type !== 'CANNOT_VALIDATE');
  return (
    <section className="panel club-options" aria-label={`Expedite for ${order}`}>
      <div className="panel-heading">
        <div>
          <h2>Request material expedite: {data?.orders.join(' + ') ?? order}</h2>
          <p className="panel-sub">
            Preview only. A request (and its approval) is not supply: the order stays conditional
            until the supplier's confirmed date and quantity cover every release.
          </p>
        </div>
        <button className="button" onClick={onClose}>
          Close
        </button>
      </div>
      <Messages error={error} notice="" />
      {!data && !error && <p role="status">Checking materials at release…</p>}
      {data && (
        <div className="panel-body">
          {data.finish.map((f: any) => (
            <p key={f.order} className="cell-sub">
              {f.order}: forward finish {f.finishDate} · promise {f.promise} ·{' '}
              {MATERIAL[f.materials]?.[1] ?? f.materials}
            </p>
          ))}
          {data.actions.length ? (
            <ActionRows actions={data.actions} />
          ) : (
            <p>Materials already cover this order at its release.</p>
          )}
          {canPlan && requestable && (
            <div className="form-actions">
              <button
                className="button primary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError('');
                  call(`plants/${plantId}/expedite/request`, 'POST', {
                    order,
                    runNo: data.runNo,
                    version: data.version,
                  })
                    .then(onDone)
                    .catch((e) => setError(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                Create linked expedite bundle
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function LaterOptions({
  csrf,
  plantId,
  order,
  canPlan,
  onDone,
  onClose,
  candidate: initial,
}: any) {
  const call = useApi(csrf);
  const [data, setData] = useState<any>(null),
    [candidate, setCandidate] = useState(initial ?? ''),
    [asked, setAsked] = useState(initial ?? ''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setData(null);
    setError('');
    call(`plants/${plantId}/later/preview`, 'POST', {
      order,
      ...(asked ? { candidateDate: asked } : {}),
    })
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [order, asked]);
  function apply(s: any, mode: string) {
    setBusy(true);
    setError('');
    call(`plants/${plantId}/later/apply`, 'POST', {
      order,
      ...(asked ? { candidateDate: asked } : {}),
      key: s.key,
      mode,
      release: s.release,
      promise: s.promise,
      runNo: data.runNo,
      version: data.version,
    })
      .then(onDone)
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }
  return (
    <section className="panel club-options" aria-label={`Later date for ${order}`}>
      <div className="panel-heading">
        <div>
          <h2>Explore / quote a later date: {order}</h2>
          <p className="panel-sub">
            Preview only. A proposed date is a commercial alternative until the customer accepts it:
            the order then waits in Pending Orders, holding no capacity or material. Move down the
            queue keeps the original promise.
          </p>
        </div>
        <button className="button" onClick={onClose}>
          Close
        </button>
      </div>
      <Messages error={error} notice="" />
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setAsked(candidate);
        }}
      >
        <label>
          Planner-entered delivery date
          <input type="date" value={candidate} onChange={(e) => setCandidate(e.target.value)} />
        </label>
        <button className="button">Preview date</button>
      </form>
      {!data && !error && <p role="status">Trying release days and positions…</p>}
      {data && (
        <div className="scenario-grid">
          {data.scenarios.length === 0 && <p>No routed placement is available for this order.</p>}
          {data.scenarios.map((s: any, i: number) => (
            <article
              key={s.key}
              className={'scenario-card' + (i === 0 && s.normal ? ' recommended' : '')}
              data-later={s.key}
            >
              <h3>
                {s.label}
                <span className={'chip ' + (s.normal ? '' : 'warning')}>
                  {s.normal ? 'Supported' : 'Conditional'}
                </span>
              </h3>
              <dl className="facts">
                <div>
                  <dt>Proposed delivery</dt>
                  <dd>{s.promise}</dd>
                </div>
                <div>
                  <dt>Production release</dt>
                  <dd>{s.productionRelease}</dd>
                </div>
                <div>
                  <dt>Full-route finish</dt>
                  <dd>{s.finishDate}</dd>
                </div>
                <div>
                  <dt>Materials</dt>
                  <dd>{MATERIAL[s.status]?.[1] ?? s.status}</dd>
                </div>
                <div>
                  <dt>Position</dt>
                  <dd>{s.beforeId ? `before ${s.beforeId}` : 'at the end'}</dd>
                </div>
                <div>
                  <dt>Other orders</dt>
                  <dd>
                    {s.impact.changed} shift, {s.broken.length} later than promised
                  </dd>
                </div>
              </dl>
              <p className="cell-sub">
                Move down the queue keeps {s.originalPromise}:{' '}
                {s.moveSlip ? `${s.moveSlip} day(s) late` : `${num(s.moveSlackHours, 2)} h slack`}.
              </p>
              {(s.late ||
                s.broken.length > 0 ||
                s.materialHurt.length > 0 ||
                s.gaps.length > 0 ||
                s.unknown.length > 0) && (
                <ul className="messages">
                  {s.late && <li>Entered date is before the full-route finish {s.finishDate}.</li>}
                  {s.broken.length > 0 && (
                    <li>Existing promises worsened: {s.broken.join(', ')}</li>
                  )}
                  {s.materialHurt.length > 0 && (
                    <li>Would take material from: {s.materialHurt.join(', ')}</li>
                  )}
                  {s.gaps.map((g: any) => (
                    <li key={g.component}>
                      {g.component} short {num(g.shortage, 3)} at {g.release}
                    </li>
                  ))}
                  {s.unknown.length > 0 && <li>No stock record: {s.unknown.join(', ')}</li>}
                </ul>
              )}
              {canPlan && s.capacityOK && (
                <div className="form-actions">
                  <button className="button" disabled={busy} onClick={() => apply(s, 'propose')}>
                    Propose date to customer
                  </button>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => apply(s, 'confirm')}
                  >
                    Confirm and reschedule
                  </button>
                  {data.scheduled && (
                    <button className="button" disabled={busy} onClick={() => apply(s, 'move')}>
                      Move down queue
                    </button>
                  )}
                </div>
              )}
              {!s.capacityOK && (
                <p className="cell-sub warning-text">
                  Full-route capacity does not support this date: it cannot be proposed or
                  scheduled.
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

// Planning → Expedites: every request with its approval and supplier confirmation.
export function Expedites({
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
  const canAct = permissions.includes('purchase.expedite');
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [tick, setTick] = useState(0),
    [form, setForm] = useState<Record<string, any>>({});
  useEffect(() => {
    let live = true;
    call(`plants/${plantId}/expedites`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [plantId, refreshKey, tick]);
  function act(a: any, what: string, payload: any = {}) {
    setBusy(true);
    setError('');
    call(`expedite-actions/${a.id}/${what}`, 'POST', { version: a.version, ...payload })
      .then((d) => {
        setNotice(d.message);
        setTick((x) => x + 1);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }
  const f = (id: string) => form[id] ?? {};
  const set = (id: string, k: string, v: string) =>
    setForm({ ...form, [id]: { ...f(id), [k]: v } });
  return (
    <>
      <Messages error={error} notice={notice} />
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Material expedites</h2>
            <p className="panel-sub">
              Approval records intent only (and not by the person who requested it). Only a recorded
              supplier confirmation — date, quantity, reference — moves supply; a date after the
              need leaves the order for a new decision.
            </p>
          </div>
        </div>
        {data && data.actions.length === 0 && (
          <p className="panel-body">No expedite requests yet.</p>
        )}
        {data && data.actions.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Component</th>
                  <th className="num">Quantity</th>
                  <th>Needed by</th>
                  <th>Existing PO / due</th>
                  <th>Orders</th>
                  <th>State</th>
                  <th className="actions">Decision</th>
                </tr>
              </thead>
              <tbody>
                {data.actions.map((a: any) => {
                  const st = ACTION_STATES[a.state] ?? ['pending', a.state];
                  const mine = a.requestedById === data.me;
                  return (
                    <tr key={a.id} data-expedite={`EA-${a.no}`}>
                      <td>
                        <strong>EA-{a.no}</strong>
                        <div className="cell-sub">
                          {ACTION_TYPES[a.type] ?? a.type} · EXP-{a.bundles.join(', EXP-')}
                        </div>
                      </td>
                      <td>{a.component ?? '—'}</td>
                      <td className="num">{a.qty === null ? '—' : num(a.qty, 3)}</td>
                      <td>{a.required ?? '—'}</td>
                      <td>
                        {a.po ? `${a.po} / ${a.line}` : 'New purchase'}
                        <div className="cell-sub">{a.currentDue ?? ''}</div>
                      </td>
                      <td>{a.members.join(', ')}</td>
                      <td>
                        <span className={'status-pill ' + st[0]}>{st[1]}</span>
                        {a.confirmation && (
                          <div className="cell-sub">
                            {num(a.confirmation.qty, 3)} on {a.confirmation.date} ·{' '}
                            {a.confirmation.reference}
                          </div>
                        )}
                        {a.reason && <div className="cell-sub">{a.reason}</div>}
                        <div className="cell-sub">
                          Requested by {a.requestedBy ?? '—'}
                          {a.approvedBy ? ` · approved by ${a.approvedBy}` : ''}
                        </div>
                      </td>
                      <td className="actions">
                        {canAct && a.state === 'requested' && (
                          <button
                            className="button"
                            disabled={busy || mine}
                            title={mine ? 'You requested it: another person must approve.' : ''}
                            onClick={() => act(a, 'approve')}
                          >
                            Approve request
                          </button>
                        )}
                        {canAct && ['approved', 'late', 'confirmed'].includes(a.state) && (
                          <div className="confirm-form">
                            <label>
                              Confirmed receipt date
                              <input
                                type="date"
                                value={f(a.id).date ?? a.confirmation?.date ?? ''}
                                onChange={(e) => set(a.id, 'date', e.target.value)}
                              />
                            </label>
                            <label>
                              Confirmed quantity
                              <input
                                inputMode="decimal"
                                value={f(a.id).qty ?? a.confirmation?.qty ?? a.qty}
                                onChange={(e) => set(a.id, 'qty', e.target.value)}
                              />
                            </label>
                            <label>
                              Supplier reference
                              <input
                                value={f(a.id).reference ?? a.confirmation?.reference ?? ''}
                                onChange={(e) => set(a.id, 'reference', e.target.value)}
                              />
                            </label>
                            <button
                              className="button"
                              disabled={busy}
                              onClick={() =>
                                act(a, 'confirm', {
                                  date: f(a.id).date ?? a.confirmation?.date,
                                  qty: Number(f(a.id).qty ?? a.confirmation?.qty ?? a.qty),
                                  reference: f(a.id).reference ?? a.confirmation?.reference,
                                })
                              }
                            >
                              Record confirmed receipt
                            </button>
                          </div>
                        )}
                        {canAct &&
                          !['rejected', 'superseded', 'cannot_validate'].includes(a.state) && (
                            <button
                              className="text-button"
                              disabled={busy}
                              onClick={() => {
                                const reason = window.prompt('Why can it not arrive in time?');
                                if (reason) act(a, 'reject', { reason });
                              }}
                            >
                              Reject / cannot arrive
                            </button>
                          )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

// Planning → Pending orders: visible commercial demand without capacity or material.
export function PendingOrders({
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
  const canPlan = permissions.includes('schedule.plan');
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [review, setReview] = useState<any>(null),
    [tick, setTick] = useState(0),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    call(`plants/${plantId}/pending`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [plantId, refreshKey, tick]);
  function act(p: any, what: string) {
    setBusy(true);
    setError('');
    call(`plants/${plantId}/pending/${what}`, 'POST', { order: p.order_ref, version: p.version })
      .then((d) => {
        setNotice(d.message);
        setTick((x) => x + 1);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }
  return (
    <>
      <Messages error={error} notice={notice} />
      {review && (
        <LaterOptions
          csrf={csrf}
          plantId={plantId}
          order={review.order_ref}
          candidate={review.proposed_date}
          canPlan={canPlan}
          onClose={() => setReview(null)}
          onDone={(d: any) => {
            setReview(null);
            setNotice(d.message);
            setTick((x) => x + 1);
          }}
        />
      )}
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Pending orders to plan</h2>
            <p className="panel-sub">
              Visible commercial demand, excluded from committed capacity and material allocation
              until the new date is confirmed and the order rescheduled.
            </p>
          </div>
        </div>
        {data && data.items.length === 0 && (
          <p className="panel-body">No orders awaiting planning.</p>
        )}
        {data && data.items.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order / customer / item</th>
                  <th className="num">Quantity</th>
                  <th>Original / proposed</th>
                  <th>State</th>
                  <th>Gating materials</th>
                  <th className="actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((p: any) => (
                  <tr key={p.order_ref} data-pending={p.order_ref}>
                    <td>
                      <strong>{p.order_ref}</strong>
                      <div className="cell-sub">
                        {p.customer || '—'} · {p.item}
                      </div>
                    </td>
                    <td className="num">{num(p.quantity, 0)}</td>
                    <td>
                      Original {p.original_date}
                      <div className="cell-sub">Proposed {p.proposed_date}</div>
                    </td>
                    <td>
                      {p.state_label}
                      <div className="cell-sub">
                        #{p.last_decision_no}: {p.reason}
                      </div>
                    </td>
                    <td>
                      {(p.gating ?? []).length
                        ? p.gating
                            .map((g: any) =>
                              g.unknown
                                ? `${g.component} cannot validate`
                                : `${g.component} ${num(g.shortage, 3)}`,
                            )
                            .join(', ')
                        : '—'}
                    </td>
                    <td className="actions">
                      {canPlan && (
                        <>
                          <button className="button" disabled={busy} onClick={() => setReview(p)}>
                            Review / confirm and schedule
                          </button>
                          {p.state === 'awaiting_confirmation' && (
                            <button
                              className="text-button"
                              disabled={busy}
                              onClick={() => act(p, 'ready')}
                            >
                              Date confirmation received
                            </button>
                          )}
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() =>
                              window.confirm(`Cancel ${p.order_ref}?`) && act(p, 'cancel')
                            }
                          >
                            Decline / cancel
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

// The sequence, and the clubbing and date scenarios explored against it. The handover keeps those
// as two entries, so the screen opens on one part at a time; the overlays a decision raises
// (expedite, later date, impact) belong to both.
export function Scheduler({
  csrf,
  plantId,
  permissions,
  refreshKey,
  focus = 'all',
}: {
  csrf: string;
  plantId: string;
  permissions: string[];
  refreshKey: number;
  focus?: 'all' | 'schedule' | 'decisions';
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
    [tick, setTick] = useState(0),
    [open, setOpen] = useState<string | null>(null),
    [club, setClub] = useState<string | null>(null),
    [candidates, setCandidates] = useState<any>(null),
    [expedite, setExpedite] = useState<string | null>(null),
    [later, setLater] = useState<string | null>(null),
    [plan, setPlan] = useState<any>(null),
    [report, setReport] = useState<any>(null),
    [dragging, setDragging] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const canPlan = permissions.includes('schedule.plan') && view === 'current';
  useEffect(() => {
    let live = true;
    call(`plants/${plantId}/decisions`)
      .then((d) => live && setPlan(d))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [plantId, tick, refreshKey]);
  // A decision: the planning run it was judged on and the plant's decision version.
  useEffect(() => {
    if (focus === 'schedule') return;
    let live = true;
    setCandidates(null);
    call(`plants/${plantId}/decisions/club-candidates`)
      .then((d) => live && setCandidates(d))
      .catch(() => live && setCandidates({ empty: 'Clubbing could not be worked out yet.' }));
    return () => {
      live = false;
    };
  }, [plantId, focus, refreshKey, notice]);
  function decide(path: string, payload: any) {
    setBusy(true);
    setError('');
    call(`plants/${plantId}/decisions/${path}`, 'POST', {
      ...payload,
      runNo: data?.header?.run_no,
      version: plan?.version ?? 0,
    })
      .then((d) => {
        setNotice(d.message);
        setReport(d.impact);
        setTick((x) => x + 1);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }
  const move = (order: string, target: string, position: 'before' | 'after') =>
    decide('move', { order, target, position });
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
      {focus !== 'decisions' && (
        <section className="panel planning-status">
          <div className="panel-heading">
            <div>
              <h2>Scheduler</h2>
              <p className="panel-sub">
                Open production orders in sequence: due date first, same item within the grouping
                window run back to back unless that makes another order late. Every operation is
                timed forward on its machine; the drum is the most loaded resource.{' '}
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
          {plan?.manual && view === 'current' && (
            <div className="publish-bar">
              <p className="panel-sub">
                <span className="status-pill pending">Manual order of work</span> A planner set the
                sequence; new orders are placed by due date among them. Pinned clubs:{' '}
                {plan.groups.length}.
              </p>
              {canPlan && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => decide('release-manual', {})}
                >
                  Release to computed order
                </button>
              )}
            </div>
          )}
        </section>
      )}
      {report && (
        <section className="panel">
          <ImpactReport impact={report} title="Impact of the last decision" />
        </section>
      )}
      {expedite && (
        <ExpediteOptions
          csrf={csrf}
          plantId={plantId}
          order={expedite}
          canPlan={canPlan}
          onClose={() => setExpedite(null)}
          onDone={(d: any) => {
            setExpedite(null);
            setNotice(d.message);
            setTick((x) => x + 1);
          }}
        />
      )}
      {later && (
        <LaterOptions
          csrf={csrf}
          plantId={plantId}
          order={later}
          canPlan={canPlan}
          onClose={() => setLater(null)}
          onDone={(d: any) => {
            setLater(null);
            setNotice(d.message);
            setTick((x) => x + 1);
          }}
        />
      )}
      {club && (
        <ClubOptions
          csrf={csrf}
          plantId={plantId}
          item={club}
          canPlan={canPlan}
          onClose={() => setClub(null)}
          onApplied={(d: any) => {
            setClub(null);
            setNotice(d.message);
            setReport(d.impact);
            setTick((x) => x + 1);
          }}
        />
      )}
      {focus !== 'decisions' && (
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
                  {canPlan && <th className="actions">Plan</th>}
                </tr>
              </thead>
              <tbody>
                {(data?.items ?? []).map((o: any, i: number, list: any[]) => {
                  const m = MATERIAL[o.material_check];
                  const scheduled = o.status === 'scheduled';
                  const prev = list[i - 1]?.status === 'scheduled' ? list[i - 1] : null;
                  const next = list[i + 1]?.status === 'scheduled' ? list[i + 1] : null;
                  return [
                    <tr
                      key={o.id}
                      className={
                        (o.late_days > 0 ? 'late ' : '') +
                        (dragging && scheduled ? 'drop-target' : '')
                      }
                      draggable={canPlan && scheduled && !filter && !q}
                      onDragStart={(e) => {
                        setDragging(o.order_ref);
                        e.dataTransfer.setData('text/plain', o.order_ref);
                      }}
                      onDragEnd={() => setDragging(null)}
                      onDragOver={(e) => dragging && scheduled && e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        const from = e.dataTransfer.getData('text/plain');
                        setDragging(null);
                        if (!from || from === o.order_ref) return;
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        move(
                          from,
                          o.order_ref,
                          e.clientY < r.top + r.height / 2 ? 'before' : 'after',
                        );
                      }}
                    >
                      <td className="num">
                        {canPlan && scheduled && !filter && !q && (
                          <span className="grip" aria-hidden="true">
                            ⋮⋮
                          </span>
                        )}
                        {o.position}
                      </td>
                      <td>
                        <button
                          className="text-button cell-link"
                          aria-expanded={open === o.id}
                          aria-label={`Materials for ${o.order_no}`}
                          onClick={() => setOpen(open === o.id ? null : o.id)}
                        >
                          <strong>{o.order_no}</strong>
                        </button>
                        {o.plan_group && <div className="cell-sub pinned">Pinned club</div>}
                        {!o.plan_group && o.grouped_with && (
                          <div className="cell-sub">Grouped after {o.grouped_with}</div>
                        )}
                        {o.manual_placed && <div className="cell-sub">Placed by planner</div>}
                        {o.execution_state === 'released' && (
                          <div className="cell-sub">Released: running, not re-sequenced</div>
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
                        {o.plan_state && o.plan_state !== 'material_clear' && (
                          <div className="cell-sub plan-state">
                            <strong>{ORDER_STATES[o.plan_state] ?? o.plan_state}</strong>
                          </div>
                        )}
                        {o.messages?.[0] && scheduled && (
                          <div className="cell-sub">{o.messages[0]}</div>
                        )}
                      </td>
                      {canPlan && (
                        <td className="actions nowrap">
                          {scheduled && (
                            <>
                              <button
                                className="text-button"
                                aria-label={`Move ${o.order_no} up`}
                                disabled={busy || !prev || !!filter || !!q}
                                onClick={() => move(o.order_ref, prev.order_ref, 'before')}
                              >
                                ↑
                              </button>
                              <button
                                className="text-button"
                                aria-label={`Move ${o.order_no} down`}
                                disabled={busy || !next || !!filter || !!q}
                                onClick={() => move(o.order_ref, next.order_ref, 'after')}
                              >
                                ↓
                              </button>
                              <button
                                className="text-button"
                                aria-label={`Club options for ${o.item}`}
                                onClick={() => setClub(o.item)}
                              >
                                Club
                              </button>
                              {(['expedite', 'unknown'].includes(o.material_check) ||
                                o.late_days > 0) && (
                                <>
                                  {o.material_check === 'expedite' && (
                                    <button
                                      className="text-button"
                                      aria-label={`Request material expedite for ${o.order_ref}`}
                                      onClick={() => setExpedite(o.order_ref)}
                                    >
                                      Expedite
                                    </button>
                                  )}
                                  <button
                                    className="text-button"
                                    aria-label={`Explore a later date for ${o.order_ref}`}
                                    onClick={() => setLater(o.order_ref)}
                                  >
                                    Later date
                                  </button>
                                </>
                              )}
                            </>
                          )}
                        </td>
                      )}
                    </tr>,
                    open === o.id && (
                      <tr key={o.id + '-lines'} className="detail-row">
                        <td colSpan={canPlan ? 11 : 10}>
                          <ReadinessLines lines={o.material_lines} />
                        </td>
                      </tr>
                    ),
                  ];
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
      )}
      {focus !== 'schedule' && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Feasible clubbing</h2>
              <p className="panel-sub">
                Same-item lots this book could run back to back. A club is only offered when the
                material is there at the earlier release and no promise is pushed out; the rest are
                listed with the reason they are not. Nothing is grouped until you apply it.
                {candidates?.counts &&
                  ` ${candidates.counts.feasible} of ${candidates.counts.candidates} items can be clubbed today, saving ${candidates.counts.savedMinutes} setup minutes; the grouping window is ${candidates.clubWindowDays} day(s).`}
              </p>
            </div>
          </div>
          {!candidates && (
            <p className="panel-body" role="status">
              Working out the clubs…
            </p>
          )}
          {candidates?.items?.length === 0 && (
            <p className="panel-body">No item has more than one lot in this book.</p>
          )}
          {candidates?.items?.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Lots</th>
                    <th className="num">In the club</th>
                    <th className="num">Setup saved</th>
                    <th className="num">Carried</th>
                    <th className="num">Pulled forward</th>
                    <th>Verdict</th>
                    {canPlan && <th className="actions">Options</th>}
                  </tr>
                </thead>
                <tbody>
                  {candidates.items.map((c: any) => (
                    <tr key={c.item} data-club={c.item} className={c.feasible ? '' : 'late'}>
                      <td>
                        <strong>{c.item}</strong>
                      </td>
                      <td className="num">{c.lots}</td>
                      <td className="num">{c.clubbed}</td>
                      <td className="num">{Math.round(c.savedMinutes)} min</td>
                      <td className="num">{Math.round(c.carryUnits)}</td>
                      <td className="num">{Math.round(c.pullDays * 10) / 10} d</td>
                      <td>
                        <span
                          className={
                            'status-pill ' + (c.feasible ? 'ok' : c.conditional ? 'pending' : 'off')
                          }
                        >
                          {c.feasible
                            ? 'can be clubbed'
                            : c.conditional
                              ? 'only with an expedite'
                              : String(c.reason ?? 'separate is better').replace(/_/g, ' ')}
                        </span>
                      </td>
                      {canPlan && (
                        <td className="actions">
                          <button className="button" onClick={() => setClub(c.item)}>
                            See options
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {focus !== 'schedule' && plan?.items?.length > 0 && (
        <section className="panel">
          <h2>Planning decisions</h2>
          <div className="table-wrap">
            <table className="compact">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Decision</th>
                  <th>Orders</th>
                  <th>Run</th>
                  <th>By</th>
                  <th>When</th>
                  <th>Effect</th>
                </tr>
              </thead>
              <tbody>
                {plan.items.map((d: any) => (
                  <tr key={d.decision_no}>
                    <td>{d.decision_no}</td>
                    <td>{DECISION_KINDS[d.kind] ?? d.kind}</td>
                    <td>{d.orders.join(', ') || '—'}</td>
                    <td>#{d.run_no}</td>
                    <td>{d.decided_by ?? '—'}</td>
                    <td>{new Date(d.decided_at).toLocaleString()}</td>
                    <td className="cell-sub">
                      {d.kind === 'insert' || d.kind === 'quote' ? (
                        insertEffect(d.details)
                      ) : (
                        <>
                          {d.details?.scenario
                            ? `${num(d.details.scenario.savedMin, 0)} min saved; `
                            : d.kind === 'move'
                              ? `#${d.details.from} → #${d.details.to}; `
                              : ''}
                          {d.details?.impact?.changed ?? 0} changed,{' '}
                          {d.details?.impact?.broken?.length ?? 0} newly late
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
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
            area_operations: (d.area_operations ?? []).join(', '),
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
              area_operations: form.area_operations,
              execution_buffer_pct: String(form.execution_buffer_pct),
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
                Execution buffer (% of planned minutes)
                <input
                  inputMode="numeric"
                  value={form.execution_buffer_pct}
                  onChange={(e) => setForm({ ...form, execution_buffer_pct: e.target.value })}
                />
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
            <label>
              Area operations: operation codes whose minutes scale with the area of an odd size
              <input
                value={form.area_operations}
                placeholder="e.g. QU02, CU02"
                onChange={(e) => setForm({ ...form, area_operations: e.target.value })}
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

// ---------- Insert order (AV-7) ----------
// Reference: Nilkamal simulation handover, the Insert screen. A catalogue item or an odd size,
// a quantity and a need-by date (or the earliest date): the ways of saying yes, each checked on the
// drum, the full forward route and time-phased materials. Nothing changes until one is committed.

const INSERT_REASONS: Record<string, (r: any) => string> = {
  no_window: (r) =>
    `Needs ${num(r.need, 0)} drum minutes in one window; the largest free window is ${num(r.largest, 0)} min${r.date ? ' on ' + r.date : ''}.`,
  third_lot: (r) =>
    `Only ${num(r.placed, 0)} of ${num(r.qty, 0)} fit in two lots; the rest would need a third lot or a later date.`,
};

function InsertScenario({ s, recommended, canInsert, busy, onCommit, rush }: any) {
  const gate = s.meetsNeedBy === false || s.broken.length > 0;
  const m = s.materials;
  return (
    <article
      className={'scenario-card' + (recommended ? ' recommended' : '')}
      data-scenario={s.key}
    >
      <h3>
        {s.label}
        {recommended && <span className="chip">recommended</span>}
      </h3>
      <p>
        <strong>
          {s.lots.length
            ? s.lots.map((l: any) => `${num(l.qty, 0)} on ${l.date}`).join(' + ')
            : 'Not placed'}
        </strong>
        {s.front && <span className="cell-sub"> — ahead of every promise</span>}
        {rush && (
          <span className="cell-sub">
            {' '}
            — {s.rushBefore ? `before ${s.rushBefore}` : 'at the end of the book'}
          </span>
        )}
      </p>
      <dl className="facts">
        <div>
          <dt>{s.key === 'decline' || rush ? 'Quote' : 'Full-route finish'}</dt>
          <dd>{s.quoteDate ?? s.finishDate ?? '—'}</dd>
        </div>
        <div>
          <dt>Materials</dt>
          <dd>
            <span className={'status ' + (MATERIAL[m.status]?.[0] ?? 'pending')}>
              {MATERIAL[m.status]?.[1] ?? m.status}
            </span>
          </dd>
        </div>
        <div>
          <dt>Changeover (measured)</dt>
          <dd>{num(s.forwardChangeoverMin, 0)} min</dd>
        </div>
        <div>
          <dt>Finished stock waiting</dt>
          <dd>{num(s.forwardCarry, 1)} unit-days</dd>
        </div>
        <div>
          <dt>Other orders</dt>
          <dd>
            {s.forwardShifted} shift, {s.broken.length} later than promised
          </dd>
        </div>
        <div>
          <dt>Drum placement</dt>
          <dd>
            +{num(s.changeoverMin, 0)} min, {num(s.carryUnits, 0)} unit-days
          </dd>
        </div>
      </dl>
      {s.reasons.length > 0 && (
        <ul className="messages">
          {s.reasons.map((r: any, i: number) => (
            <li key={i}>{(INSERT_REASONS[r.code] ?? (() => r.code))(r)}</li>
          ))}
        </ul>
      )}
      {gate && (
        <p className="cell-sub warning-text">
          {s.meetsNeedBy === false ? 'Full-route delivery is after the need-by date. ' : ''}
          {s.broken.length > 0
            ? 'Later than promised: ' +
              s.broken
                .slice(0, 8)
                .map((b: any) => `${b.order} ${b.was} → ${b.now}`)
                .join('; ') +
              (s.broken.length > 8 ? ` and ${s.broken.length - 8} more` : '')
            : ''}
        </p>
      )}
      {(m.gaps.length > 0 || m.unknown.length > 0 || m.missingBom) && (
        <details>
          <summary>
            {m.gaps.length} material gap(s)
            {m.unknown.length ? `, ${m.unknown.length} component(s) without stock evidence` : ''}
          </summary>
          <table className="compact">
            <thead>
              <tr>
                <th>Component</th>
                <th>Release</th>
                <th className="num">Needed</th>
                <th className="num">Available</th>
                <th className="num">Short</th>
                <th>Later receipts</th>
              </tr>
            </thead>
            <tbody>
              {m.gaps.map((g: any, i: number) => (
                <tr key={i}>
                  <td>{g.component}</td>
                  <td>{g.release}</td>
                  <td className="num">{num(g.requirement, 3)}</td>
                  <td className="num">{num(g.available, 3)}</td>
                  <td className="num">{num(g.shortage, 3)}</td>
                  <td>
                    {g.later.map((p: any) => `${num(p.qty, 0)} on ${p.due}`).join(', ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {m.unknown.length > 0 && (
            <p className="cell-sub">No stock record: {m.unknown.join(', ')}</p>
          )}
          {m.missingBom && <p className="cell-sub">No BOM: materials cannot be checked.</p>}
        </details>
      )}
      {canInsert && s.feasible && (
        <button
          className={'button' + (recommended ? ' primary' : '')}
          disabled={busy}
          onClick={() => onCommit(s)}
        >
          {s.key === 'decline'
            ? 'Decline and log the quote'
            : m.gated
              ? 'Commit with material gate'
              : gate
                ? 'Commit with capacity warning'
                : 'Commit'}
        </button>
      )}
    </article>
  );
}

export function InsertOrder({
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
  const canInsert = permissions.includes('schedule.insert');
  const [opts, setOpts] = useState<any>(null),
    [form, setForm] = useState<any>({
      mode: 'catalogue',
      item: '',
      family: '',
      length: '',
      width: '',
      thickness: '',
      qty: '',
      needDate: '',
      intent: 'dated',
      customer: '',
    }),
    [data, setData] = useState<any>(null),
    [asked, setAsked] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    let live = true;
    call(`plants/${plantId}/insert/options`)
      .then((d) => live && setOpts(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [plantId, refreshKey]);
  const request = () => ({
    mode: form.mode,
    qty: Number(form.qty),
    intent: form.intent,
    ...(form.intent === 'dated' ? { needDate: form.needDate } : {}),
    ...(form.mode === 'catalogue'
      ? { item: form.item.trim() }
      : {
          family: form.family,
          length: Number(form.length),
          width: Number(form.width),
          thickness: Number(form.thickness),
        }),
  });
  function preview(e?: any) {
    e?.preventDefault();
    const req = request();
    setBusy(true);
    setError('');
    setNotice('');
    setData(null);
    call(`plants/${plantId}/insert/preview`, 'POST', req)
      .then((d) => {
        setData(d);
        setAsked(req);
      })
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false));
  }
  function commit(s: any) {
    setBusy(true);
    setError('');
    call(`plants/${plantId}/insert/commit`, 'POST', {
      ...asked,
      customer: form.customer.trim(),
      key: s.key,
      lots: s.lots,
      runNo: data.runNo,
      version: data.version,
    })
      .then((d) => {
        setNotice(d.message);
        setData(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false));
  }
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });
  const t = data?.target;
  const families = (opts?.families ?? []).filter((f: any) => f.standards > 0);
  return (
    <>
      <Messages error={error} notice={notice} />
      <section className="panel company-form">
        <h2>Insert an order</h2>
        <p className="panel-sub">
          Planning date {opts?.today ?? '…'}; constraint {opts?.drum ?? '…'}. The options are
          simulated on the current schedule: nothing changes until you commit one.
        </p>
        <form onSubmit={preview}>
          <fieldset disabled={busy}>
            <div className="form-grid">
              <label>
                Item
                <select value={form.mode} onChange={set('mode')}>
                  <option value="catalogue">Catalogue item</option>
                  <option value="oddsize">Odd size, made to order</option>
                </select>
              </label>
              {form.mode === 'catalogue' ? (
                <label>
                  Item code
                  <input value={form.item} onChange={set('item')} required />
                </label>
              ) : (
                <>
                  <label>
                    Family
                    <select value={form.family} onChange={set('family')} required>
                      <option value="">Choose…</option>
                      {families.map((f: any) => (
                        <option key={f.code} value={f.code}>
                          {f.name} ({f.code}, {f.standards} standards)
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Length (in)
                    <input
                      inputMode="decimal"
                      value={form.length}
                      onChange={set('length')}
                      required
                    />
                  </label>
                  <label>
                    Width (in)
                    <input
                      inputMode="decimal"
                      value={form.width}
                      onChange={set('width')}
                      required
                    />
                  </label>
                  <label>
                    Thickness (in)
                    <input
                      inputMode="decimal"
                      value={form.thickness}
                      onChange={set('thickness')}
                      required
                    />
                  </label>
                </>
              )}
              <label>
                Quantity
                <input inputMode="numeric" value={form.qty} onChange={set('qty')} required />
              </label>
              <label>
                Date
                <select value={form.intent} onChange={set('intent')}>
                  <option value="dated">Customer needs it by…</option>
                  <option value="rush">Earliest possible (rush quote)</option>
                </select>
              </label>
              {form.intent === 'dated' && (
                <label>
                  Need-by date
                  <input type="date" value={form.needDate} onChange={set('needDate')} required />
                </label>
              )}
              <label>
                Customer (optional)
                <input value={form.customer} onChange={set('customer')} maxLength={120} />
              </label>
            </div>
            <div className="form-actions">
              <button className="button primary">Show options</button>
            </div>
          </fieldset>
        </form>
      </section>
      {busy && !data && <p role="status">Simulating the options…</p>}
      {t && (
        <section className="panel" aria-label="Insert options">
          <div className="panel-heading">
            <div>
              <h2>
                Options for {num(asked.qty, 0)} {t.code}
                {asked.needDate ? ` by ${asked.needDate}` : ', earliest date'}
              </h2>
              <p className="panel-sub">
                {t.refused
                  ? t.refused
                  : t.class === 'oddsize'
                    ? `Odd size, made to order: not buffered. Timed from ${t.source} (${t.sourceSize.join('x')}), the nearest standard of ${t.family.name}${t.exactThickness ? '' : ' (no exact thickness; nearest taken)'}, area × ${num(t.scale, 4)} on ${t.areaOperations.join(', ') || 'no operations'}; ${t.bomLines} BOM lines inherited (metres by area, pieces as they are, the rest by volume). Marked estimated.`
                    : t.class === 'buffered'
                      ? `Buffered item: this order consumes the buffer — net flow ${num(t.buffer.nfp, 1)} (${t.buffer.zone}) falls to ${num(t.buffer.after.nfp, 1)} (${t.buffer.after.zone}). ${t.operations} operations, ${num(t.drumMinPerUnit, 3)} min per unit on ${t.drum}.`
                      : `Standard item, not buffered: it needs its own slot. ${t.operations} operations, ${num(t.drumMinPerUnit, 3)} min per unit on ${t.drum}.`}
              </p>
              {data.intent === 'rush' && (
                <p className="cell-sub">
                  {data.evaluated} insertion positions × supply dates evaluated; distinct trade-offs
                  shown.
                </p>
              )}
              {data.intent === 'dated' && !data.supported && data.scenarios.length > 0 && (
                <p className="cell-sub warning-text">
                  No unconditional commitment is supported: the recommended option keeps the drum
                  placement; check its material and capacity warnings.
                </p>
              )}
            </div>
          </div>
          <div className="scenario-grid">
            {data.scenarios.map((s: any) => (
              <InsertScenario
                key={s.key}
                s={s}
                recommended={s.key === data.recommended}
                canInsert={canInsert}
                busy={busy}
                onCommit={commit}
                rush={data.intent === 'rush'}
              />
            ))}
          </div>
        </section>
      )}
    </>
  );
}
