// RCH-3: the month a rep intends to walk, and how it read afterwards.
//
// Nothing a rep sees here about how the month turned out is stored anywhere. Followed, Partial,
// Deviated, Missed and Unplanned come from the same engine the API uses, over the plan, the
// visits and the attendance register, so leave approved after the plan was built takes the day
// out of the count without anybody rewriting last month.
//
// The month is the rep's own to build: a manager approves it or sends it back with a reason, and
// never types into it. After approval a day moves by request, and approving that request moves
// that one day.
import { useEffect, useState } from 'react';
import { useApi } from './api-client';
import { Modal } from './modal';

// The wording and colour a verdict carries wherever it is shown, so the plan, the board and the
// adherence screen cannot describe the same day differently.
const VERDICT_LABEL: Record<string, string> = {
  FOLLOWED: 'Followed',
  PARTIAL: 'Partial',
  DEVIATED: 'Deviated',
  MISSED: 'Missed',
  UNPLANNED: 'Unplanned',
  LEAVE: 'Leave',
  HOLIDAY: 'Holiday',
  WEEK_OFF: 'Week off',
  NOT_PLANNED: 'Not planned',
};
const VERDICT_ORDER = [
  'FOLLOWED',
  'PARTIAL',
  'DEVIATED',
  'MISSED',
  'UNPLANNED',
  'LEAVE',
  'HOLIDAY',
  'WEEK_OFF',
  'NOT_PLANNED',
];

const PLAN_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Waiting',
  APPROVED: 'Approved',
  SENT_BACK: 'Sent back',
  NONE: 'Not started',
  PENDING: 'Waiting',
  REJECTED: 'Rejected',
};

const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => today().slice(0, 7);
const monthStart = (d: string) => d.slice(0, 8) + '01';
// The month after this one, which is the month a rep is usually filling in.
const nextMonth = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 7);
};

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayName = (date: string) => WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()];

function Verdict({ status }: { status: string }) {
  return (
    <span className={'status-pill tour-' + status.toLowerCase()}>
      {VERDICT_LABEL[status] ?? status}
    </span>
  );
}

function PlanPill({ status }: { status: string }) {
  return (
    <span className={'status-pill plan-' + status.toLowerCase()}>
      {PLAN_LABEL[status] ?? status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// My plan
// ---------------------------------------------------------------------------

export function MyPlan({
  csrf,
  permissions,
  refreshKey,
}: {
  csrf: string;
  permissions: string[];
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const canReadAll = permissions.includes('reach.read');
  const [month, setMonth] = useState(nextMonth());
  const [rep, setRep] = useState('');
  const [reps, setReps] = useState<any[]>([]);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<any>(null);
  const [asking, setAsking] = useState<any>(null);

  useEffect(() => {
    if (!canReadAll) return;
    let live = true;
    call('masters/field_reps?limit=100')
      .then((d) => live && setReps(d.items ?? []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [refreshKey]);

  useEffect(() => {
    let live = true;
    setError('');
    setData(null);
    call(`reach/tour/plan?month=${month}${rep ? `&rep=${rep}` : ''}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [month, rep, refreshKey, revision]);

  const act = (promise: Promise<any>) => {
    setBusy(true);
    setError('');
    setNotice('');
    promise
      .then((d) => {
        setNotice(d.message);
        setEditing(null);
        setAsking(null);
        setRevision((x) => x + 1);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };

  if (error && !data)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!data) return <p role="status">Loading the tour plan…</p>;

  const plan = data.plan;
  const editable = plan && ['DRAFT', 'SENT_BACK'].includes(plan.status) && data.mine;
  const byRequest = plan && plan.status === 'APPROVED' && data.mine;
  const days: any[] = data.days ?? [];
  const fieldDays = days.filter((d) => d.beat_id);

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Tour plan</h2>
        {plan ? <PlanPill status={plan.status} /> : <PlanPill status="NONE" />}
      </div>

      <div className="filters">
        <label>
          Month
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </label>
        {canReadAll && (
          <label>
            Rep
            <select value={rep} onChange={(e) => setRep(e.target.value)}>
              <option value="">Me</option>
              {reps.map((r: any) => (
                <option key={r.id} value={r.id}>
                  {r.code} · {r.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="hint">
          A month is due by the {data.limits.due_day}th. At most {data.limits.max_outlets} outlets
          in a day, and {data.limits.field_days_pct}% of the working days in the field.
        </span>
      </div>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}

      {!plan && (
        <>
          <p>
            {data.mine
              ? `You have no plan for ${month} yet.`
              : `${data.rep.code} has no plan for ${month} yet.`}
          </p>
          {data.mine && (
            <button
              className="button primary"
              disabled={busy}
              onClick={() => act(call('reach/tour/plan', 'POST', { month }))}
            >
              Start this month
            </button>
          )}
        </>
      )}

      {plan && plan.status === 'SENT_BACK' && (
        <div className="notice" role="status">
          Sent back{plan.decided_by ? ` by ${plan.decided_by}` : ''}: {plan.decision_reason}
        </div>
      )}

      {plan && (
        <>
          <div className="tiles">
            <div className="tile">
              <span className="tile-value">{data.fieldDays}</span>
              <span className="tile-label">Field days</span>
            </div>
            <div className="tile">
              <span className="tile-value">{data.workingDays}</span>
              <span className="tile-label">Working days</span>
            </div>
            <div className="tile">
              <span className="tile-value">{data.fieldPct}%</span>
              <span className="tile-label">In the field</span>
            </div>
            <div className="tile">
              <span className="tile-value">
                {fieldDays.reduce((s, d) => s + Number(d.outlet_count || 0), 0)}
              </span>
              <span className="tile-label">Outlet calls</span>
            </div>
          </div>

          {data.checks.map((c: any) => (
            <div className="check-row" key={c.code} data-status={c.ok ? 'ready' : 'blocked'}>
              <span className={'status-pill ' + (c.ok ? 'ready' : 'blocked')}>
                {c.ok ? 'Ready' : 'Not yet'}
              </span>
              <div>
                <p>{c.message}</p>
              </div>
            </div>
          ))}

          <div className="toolbar">
            {editable && (
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  act(
                    call(`reach/tour/plan/${plan.id}/autofill`, 'POST', { version: plan.version }),
                  )
                }
              >
                Fill from the beat calendar
              </button>
            )}
            {editable && (
              <button
                className="button primary"
                disabled={busy || !data.ready}
                onClick={() =>
                  act(call(`reach/tour/plan/${plan.id}/submit`, 'POST', { version: plan.version }))
                }
              >
                Submit for approval
              </button>
            )}
            {editable && (
              <button
                className="button"
                disabled={busy}
                onClick={() => setEditing({ work_date: `${month}-01`, beat_id: '', objective: '' })}
              >
                Add or change a day
              </button>
            )}
          </div>

          {days.length === 0 ? (
            <p role="status">
              Nothing is laid out for {month} yet.
              {editable ? ' Fill it from the beat calendar, or add the days by hand.' : ''}
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Day</th>
                  <th>Round</th>
                  <th>Town</th>
                  <th>Outlets</th>
                  <th>Objective</th>
                  <th>From</th>
                  {(editable || byRequest) && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {days.map((d: any) => (
                  <tr key={d.work_date} data-beat={d.beat || ''}>
                    <td>{d.work_date}</td>
                    <td>{dayName(d.work_date)}</td>
                    <td>{d.beat || <span className="hint">not a field day</span>}</td>
                    <td>{d.town}</td>
                    <td>{d.outlet_count}</td>
                    <td>{d.objective}</td>
                    <td>{d.source === 'AUTO' ? 'Beat calendar' : 'Typed'}</td>
                    {(editable || byRequest) && (
                      <td>
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() =>
                            editable
                              ? setEditing({ ...d, beat_id: d.beat_id ?? '' })
                              : setAsking({ ...d, beat_id: d.beat_id ?? '', reason: '' })
                          }
                        >
                          {editable ? 'Change' : 'Ask to change'}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {editing && plan && (
        <Modal title="A day on the plan" onClose={() => setEditing(null)}>
          <label>
            Date
            <input
              type="date"
              value={editing.work_date}
              min={`${month}-01`}
              onChange={(e) => setEditing({ ...editing, work_date: e.target.value })}
            />
          </label>
          <label>
            Round
            <select
              value={editing.beat_id}
              onChange={(e) => setEditing({ ...editing, beat_id: e.target.value })}
            >
              <option value="">Not a field day</option>
              {data.beats.map((b: any) => (
                <option key={b.id} value={b.id}>
                  {b.code} · {b.town || b.name} · {b.outlet_count} outlets
                </option>
              ))}
            </select>
            <span className="hint">
              The town comes from the round, so a plan cannot name a town the round does not pass
              through.
            </span>
          </label>
          {editing.beat_id && (
            <label>
              Outlets
              <input
                inputMode="numeric"
                value={editing.outlet_count ?? ''}
                onChange={(e) => setEditing({ ...editing, outlet_count: e.target.value })}
              />
              <span className="hint">
                Leave it blank to plan the whole round. At most {data.limits.max_outlets}.
              </span>
            </label>
          )}
          <label>
            Objective
            <input
              value={editing.objective ?? ''}
              maxLength={200}
              onChange={(e) => setEditing({ ...editing, objective: e.target.value })}
            />
          </label>
          <div className="toolbar">
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                act(
                  call(`reach/tour/plan/${plan.id}/day`, 'PUT', {
                    work_date: editing.work_date,
                    beat_id: editing.beat_id || null,
                    outlet_count:
                      editing.beat_id && String(editing.outlet_count ?? '') !== ''
                        ? Number(editing.outlet_count)
                        : undefined,
                    objective: editing.objective ?? '',
                    version: plan.version,
                  }),
                )
              }
            >
              Save the day
            </button>
            <button className="button" disabled={busy} onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}

      {asking && plan && (
        <Modal title={`Ask to change ${asking.work_date}`} onClose={() => setAsking(null)}>
          <p>
            This month is approved, so the day moves only if it is approved too. What it says now is
            kept on the request.
          </p>
          <label>
            Round
            <select
              value={asking.beat_id}
              onChange={(e) => setAsking({ ...asking, beat_id: e.target.value })}
            >
              <option value="">Not a field day</option>
              {data.beats.map((b: any) => (
                <option key={b.id} value={b.id}>
                  {b.code} · {b.town || b.name} · {b.outlet_count} outlets
                </option>
              ))}
            </select>
          </label>
          <label>
            Objective
            <input
              value={asking.objective ?? ''}
              maxLength={200}
              onChange={(e) => setAsking({ ...asking, objective: e.target.value })}
            />
          </label>
          <label>
            Why
            <input
              value={asking.reason ?? ''}
              maxLength={300}
              onChange={(e) => setAsking({ ...asking, reason: e.target.value })}
            />
            <span className="hint">A day moves for a reason, and the reason is kept.</span>
          </label>
          <div className="toolbar">
            <button
              className="button primary"
              disabled={busy || !String(asking.reason ?? '').trim()}
              onClick={() =>
                act(
                  call(`reach/tour/plan/${plan.id}/change`, 'POST', {
                    work_date: asking.work_date,
                    beat_id: asking.beat_id || null,
                    objective: asking.objective ?? '',
                    reason: asking.reason,
                  }),
                )
              }
            >
              Send the request
            </button>
            <button className="button" disabled={busy} onClick={() => setAsking(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Everyone's month
// ---------------------------------------------------------------------------

export function PlanBoard({
  csrf,
  permissions,
  refreshKey,
}: {
  csrf: string;
  permissions: string[];
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const canApprove = permissions.includes('reach.plan_approve');
  const [month, setMonth] = useState(nextMonth());
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [deciding, setDeciding] = useState<any>(null);

  useEffect(() => {
    let live = true;
    setError('');
    setData(null);
    call(`reach/tour/plans?month=${month}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [month, refreshKey, revision]);

  function decide(status: string) {
    setBusy(true);
    setError('');
    setNotice('');
    call(`reach/tour/plan/${deciding.id}/decide`, 'POST', {
      status,
      reason: deciding.reason ?? '',
      version: deciding.version,
    })
      .then((d) => {
        setNotice(d.message);
        setDeciding(null);
        setRevision((x) => x + 1);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }

  if (error && !data)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!data) return <p role="status">Loading the month…</p>;

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Plans for the month</h2>
        <span className="badge">due by the {data.dueDay}th</span>
      </div>

      <div className="filters">
        <label>
          Month
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </label>
      </div>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}

      <div className="tiles">
        {['SUBMITTED', 'APPROVED', 'SENT_BACK', 'DRAFT', 'NONE']
          .filter((s) => data.totals[s])
          .map((s) => (
            <div className="tile" key={s}>
              <span className="tile-value">{data.totals[s]}</span>
              <span className="tile-label">{PLAN_LABEL[s]}</span>
            </div>
          ))}
      </div>

      <table>
        <thead>
          <tr>
            <th>Rep</th>
            <th>Territory</th>
            <th>Status</th>
            <th>Field days</th>
            <th>Outlet calls</th>
            <th>Submitted</th>
            {canApprove && <th>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r: any) => (
            <tr key={r.rep_id} data-status={r.status}>
              <td>
                {r.rep} · {r.rep_name}
              </td>
              <td>{r.territory}</td>
              <td>
                <PlanPill status={r.status} />
              </td>
              <td>{r.field_days}</td>
              <td>{r.outlets}</td>
              <td>{r.submitted_at ?? '—'}</td>
              {canApprove && (
                <td>
                  {r.status === 'SUBMITTED' ? (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => setDeciding({ ...r, reason: '' })}
                    >
                      Decide
                    </button>
                  ) : (
                    <span className="hint">{r.decision_reason || '—'}</span>
                  )}
                </td>
              )}
            </tr>
          ))}
          {data.missing.map((m: any) => (
            <tr key={m.rep_id} data-status="NONE">
              <td>
                {m.rep} · {m.rep_name}
              </td>
              <td>{m.territory}</td>
              <td>
                <PlanPill status="NONE" />
              </td>
              <td>0</td>
              <td>0</td>
              <td>—</td>
              {canApprove && <td />}
            </tr>
          ))}
        </tbody>
      </table>

      {deciding && (
        <Modal title={`${deciding.rep}'s plan for ${month}`} onClose={() => setDeciding(null)}>
          <p>
            {deciding.field_days} field days, {deciding.outlets} outlet calls.
          </p>
          <label>
            Reason
            <input
              value={deciding.reason ?? ''}
              maxLength={300}
              onChange={(e) => setDeciding({ ...deciding, reason: e.target.value })}
            />
            <span className="hint">
              Required to send a month back: a rep who is only told &ldquo;no&rdquo; learns nothing.
            </span>
          </label>
          <div className="toolbar">
            <button className="button primary" disabled={busy} onClick={() => decide('APPROVED')}>
              Approve
            </button>
            <button
              className="button"
              disabled={busy || !String(deciding.reason ?? '').trim()}
              onClick={() => decide('SENT_BACK')}
            >
              Send back
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Day change requests
// ---------------------------------------------------------------------------

export function PlanChanges({
  csrf,
  permissions,
  refreshKey,
}: {
  csrf: string;
  permissions: string[];
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const canApprove = permissions.includes('reach.plan_approve');
  const [status, setStatus] = useState('PENDING');
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [deciding, setDeciding] = useState<any>(null);

  useEffect(() => {
    let live = true;
    setError('');
    setData(null);
    call(`reach/tour/changes?status=${status}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [status, refreshKey, revision]);

  function decide(decision: string) {
    setBusy(true);
    setError('');
    setNotice('');
    call(`reach/tour/changes/${deciding.id}/decide`, 'POST', {
      status: decision,
      reason: deciding.decision_reason ?? '',
    })
      .then((d) => {
        setNotice(d.message);
        setDeciding(null);
        setRevision((x) => x + 1);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }

  if (error && !data)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!data) return <p role="status">Loading change requests…</p>;

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Day changes</h2>
        <span className="badge">{data.total}</span>
      </div>

      <div className="filters">
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="PENDING">Waiting</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
            <option value="">All</option>
          </select>
        </label>
      </div>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}

      {data.items.length === 0 ? (
        <p role="status">Nothing to show.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Rep</th>
              <th>Now</th>
              <th>Asked for</th>
              <th>Why</th>
              <th>Status</th>
              {canApprove && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {data.items.map((c: any) => (
              <tr key={c.id} data-status={c.status}>
                <td>{c.work_date}</td>
                <td>{c.rep}</td>
                <td>
                  {c.previous_beat || '—'}
                  {c.previous_town ? ` · ${c.previous_town}` : ''}
                </td>
                <td>
                  {c.beat || '—'}
                  {c.town ? ` · ${c.town}` : ''}
                </td>
                <td>{c.reason}</td>
                <td>
                  <PlanPill status={c.status} />
                </td>
                {canApprove && (
                  <td>
                    {c.status === 'PENDING' ? (
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => setDeciding({ ...c, decision_reason: '' })}
                      >
                        Decide
                      </button>
                    ) : (
                      <span className="hint">
                        {c.decided_by}
                        {c.decision_reason ? ` · ${c.decision_reason}` : ''}
                      </span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {deciding && (
        <Modal title={`${deciding.rep} · ${deciding.work_date}`} onClose={() => setDeciding(null)}>
          <p>
            {deciding.previous_beat || 'no round'} → {deciding.beat || 'no round'}.{' '}
            {deciding.reason}
          </p>
          <label>
            Reason
            <input
              value={deciding.decision_reason ?? ''}
              maxLength={300}
              onChange={(e) => setDeciding({ ...deciding, decision_reason: e.target.value })}
            />
            <span className="hint">Required to reject.</span>
          </label>
          <div className="toolbar">
            <button className="button primary" disabled={busy} onClick={() => decide('APPROVED')}>
              Approve the move
            </button>
            <button
              className="button"
              disabled={busy || !String(deciding.decision_reason ?? '').trim()}
              onClick={() => decide('REJECTED')}
            >
              Reject
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Plan vs actual
// ---------------------------------------------------------------------------

export function Adherence({
  csrf,
  permissions,
  refreshKey,
}: {
  csrf: string;
  permissions: string[];
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const canReadAll = permissions.includes('reach.read');
  const [from, setFrom] = useState(monthStart(today()));
  const [to, setTo] = useState(today());
  const [rep, setRep] = useState('');
  const [reps, setReps] = useState<any[]>([]);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!canReadAll) return;
    let live = true;
    call('masters/field_reps?limit=100')
      .then((d) => live && setReps(d.items ?? []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [refreshKey]);

  useEffect(() => {
    let live = true;
    setError('');
    setData(null);
    call(`reach/tour/adherence?from=${from}&to=${to}${rep ? `&rep=${rep}` : ''}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [from, to, rep, refreshKey]);

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Plan vs actual</h2>
        {data && (
          <span className="badge">
            {data.score === null ? 'nothing to score' : `${data.score}% followed`}
          </span>
        )}
      </div>

      <div className="filters">
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {canReadAll && (
          <label>
            Rep
            <select value={rep} onChange={(e) => setRep(e.target.value)}>
              <option value="">Me</option>
              {reps.map((r: any) => (
                <option key={r.id} value={r.id}>
                  {r.code} · {r.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {!data && !error && <p role="status">Reading the plan against the visits…</p>}

      {data && (
        <>
          <p className="hint">
            A day counts as followed once {data.followedPct}% of the planned round has been visited.
            Holidays, week-offs and leave are not held against anyone — including leave approved
            after the plan was built.
          </p>
          <div className="tiles">
            {VERDICT_ORDER.filter((s) => data.totals[s]).map((s) => (
              <div className="tile" key={s}>
                <span className="tile-value">{data.totals[s]}</span>
                <span className="tile-label">{VERDICT_LABEL[s]}</span>
              </div>
            ))}
            <div className="tile">
              <span className="tile-value">
                {data.visitedOutlets}/{data.plannedOutlets}
              </span>
              <span className="tile-label">Outlets covered</span>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Day</th>
                <th>Verdict</th>
                <th>Round</th>
                <th>Town</th>
                <th>Visited</th>
                <th>Off plan</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r: any) => (
                <tr key={r.date} data-status={r.status}>
                  <td>{r.date}</td>
                  <td>{dayName(r.date)}</td>
                  <td>
                    <Verdict status={r.status} />
                  </td>
                  <td>{r.beat || '—'}</td>
                  <td>{r.town || '—'}</td>
                  <td>
                    {r.planned ? `${r.visited}/${r.planned}` : r.visited || '—'}
                    {r.percent === null ? '' : ` · ${r.percent}%`}
                  </td>
                  <td>{r.offPlan || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function TourSetup({
  csrf,
  permissions,
  refreshKey,
}: {
  csrf: string;
  permissions: string[];
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const canEdit = permissions.includes('reach.setup');
  const [form, setForm] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let live = true;
    call('reach/settings')
      .then((d) => live && setForm(d.settings))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [revision, refreshKey]);

  function save() {
    setBusy(true);
    setError('');
    setNotice('');
    setFieldErrors({});
    call('reach/tour/settings', 'PUT', {
      plan_due_day: Number(form.plan_due_day),
      plan_max_outlets: Number(form.plan_max_outlets),
      plan_field_days_pct: Number(form.plan_field_days_pct),
      plan_followed_pct: Number(form.plan_followed_pct),
      version: form.version,
    })
      .then((d) => {
        setNotice(d.message);
        setRevision((x) => x + 1);
      })
      .catch((e) => {
        setError(e.fields?.length ? 'Fix the highlighted fields and save again.' : e.message);
        setFieldErrors(Object.fromEntries((e.fields ?? []).map((f: any) => [f.column, f.message])));
      })
      .finally(() => setBusy(false));
  }

  if (!form) return <p role="status">Loading tour plan settings…</p>;

  const number = (key: string, label: string, help: string) => (
    <label key={key}>
      {label}
      <input
        value={form[key]}
        disabled={busy || !canEdit}
        inputMode="numeric"
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
      <span className="hint">{help}</span>
      {fieldErrors[key] && <span className="field-error">{fieldErrors[key]}</span>}
    </label>
  );

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Tour plan settings</h2>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}

      {number(
        'plan_due_day',
        'Plan due on day',
        'The day of the month by which next month’s plan is expected.',
      )}
      {number(
        'plan_max_outlets',
        'Most outlets in a day',
        'A day asking for more than this is refused when it is typed, and flagged if the beat calendar proposes it.',
      )}
      {number(
        'plan_field_days_pct',
        'Field days as a percent of working days',
        'A month below this cannot be submitted. Holidays and the rep’s week-off are not counted as working days.',
      )}
      {number(
        'plan_followed_pct',
        'Followed at percent of the round',
        'How much of a planned round must be visited for the day to read as Followed. Below it, the day reads as Partial.',
      )}

      {canEdit && (
        <button className="button primary" disabled={busy} onClick={save}>
          Save tour plan settings
        </button>
      )}
    </section>
  );
}
