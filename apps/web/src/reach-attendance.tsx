// RCH-2: marking a day, reading the register, leave and corrections.
//
// Every status these screens show is calculated, never stored: the same engine the API uses reads
// the punches, the shift, the holiday list and the approved leave each time. So a corrected punch
// or a moved holiday changes last month's register too, which is the point.
import { useEffect, useState } from 'react';
import { useApi } from './api-client';
import { Modal } from './modal';
import { scaleDown } from './reach';

// The colour and wording a status carries wherever it is shown, so the board, the register and
// the payroll export cannot describe the same day differently.
const STATUS_LABEL: Record<string, string> = {
  PRESENT: 'Present',
  LATE: 'Late',
  HALF_DAY: 'Half day',
  LEAVE: 'Leave',
  ABSENT: 'Absent',
  WEEK_OFF: 'Week off',
  HOLIDAY: 'Holiday',
  OPEN: 'Not ended',
};
const STATUS_ORDER = [
  'PRESENT',
  'LATE',
  'HALF_DAY',
  'OPEN',
  'LEAVE',
  'ABSENT',
  'WEEK_OFF',
  'HOLIDAY',
];

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = (d: string) => d.slice(0, 8) + '01';

function Pill({ status }: { status: string }) {
  return (
    <span className={'status-pill attendance-' + status.toLowerCase()}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

// Where the browser says the device is. A refusal is not an error: the screen says what is
// missing and the caller decides what that means — a work type may need a location to start a
// day; a check-in is recorded whether or not one arrives. Exported so there is one of these in
// the app rather than one per screen.
export function useLocation() {
  const [place, setPlace] = useState<any>(null);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState('');
  function ask() {
    if (!navigator.geolocation) {
      setProblem('This browser cannot give a location.');
      return;
    }
    setAsking(true);
    setProblem('');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPlace({
          latitude: Number(pos.coords.latitude.toFixed(6)),
          longitude: Number(pos.coords.longitude.toFixed(6)),
          accuracy_m: Math.round(pos.coords.accuracy),
          source: 'DEVICE',
        });
        setAsking(false);
      },
      (e) => {
        setProblem(
          e.code === e.PERMISSION_DENIED
            ? 'Location permission was refused. Allow it so the location can be recorded.'
            : 'The location could not be read. Try again in the open.',
        );
        setAsking(false);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }
  return { place, asking, problem, ask };
}

// ---------------------------------------------------------------------------
// Start my day / end my day
// ---------------------------------------------------------------------------

export function MyDay({ csrf, refreshKey }: { csrf: string; refreshKey: number }) {
  const call = useApi(csrf);
  const [data, setData] = useState<any>(null);
  const [workTypes, setWorkTypes] = useState<any[]>([]);
  const [workType, setWorkType] = useState('');
  const [selfie, setSelfie] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const location = useLocation();

  useEffect(() => {
    let live = true;
    setError('');
    call('reach/attendance/my-day')
      .then((day) => {
        if (!live) return;
        setData(day);
        setWorkTypes(day.workTypes ?? []);
        setWorkType((w) => w || day.workTypes?.[0]?.id || '');
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [revision, refreshKey]);

  async function uploadSelfie(file: File) {
    setBusy(true);
    setError('');
    try {
      const { blob, type } = await scaleDown(file);
      const r = await fetch(
        `/api/files?purpose=selfie&name=${encodeURIComponent(file.name.slice(0, 200))}`,
        { method: 'POST', headers: { 'Content-Type': type, 'X-CSRF-Token': csrf }, body: blob },
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw Error(d.error?.message || 'The selfie could not be uploaded. Please retry.');
      setSelfie({ id: d.id, name: file.name });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function send(path: string, extra: Record<string, unknown>) {
    setBusy(true);
    setError('');
    setNotice('');
    call(`reach/attendance/${path}`, 'POST', {
      ...(location.place ?? { source: 'DEVICE' }),
      ...extra,
    })
      .then((d) => {
        setNotice(d.message);
        setSelfie(null);
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
  if (!data) return <p role="status">Loading your day…</p>;

  const chosen = workTypes.find((w) => w.id === workType);
  const needsPlace = chosen?.needs_location !== false;
  const needsSelfie = data.selfieRequired && needsPlace;
  const started = !!data.day;
  const ended = !!data.day?.end_time;

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>My day</h2>
        <span className="badge">{data.date}</span>
      </div>
      <p>
        {data.rep.name} ({data.rep.code})
        {data.shift
          ? ` · ${data.rep.shift} ${data.shift.starts_at}–${data.shift.ends_at}`
          : ' · no shift set, so lateness cannot be judged'}
      </p>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}

      {!started && (
        <div className="stack">
          <label>
            What are you doing today?
            <select value={workType} disabled={busy} onChange={(e) => setWorkType(e.target.value)}>
              {workTypes.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          {!workTypes.length && (
            <p role="status">No work types are set up yet. Add one under Field setup first.</p>
          )}

          {needsPlace && (
            <div>
              <button className="button" disabled={busy || location.asking} onClick={location.ask}>
                {location.asking ? 'Finding you…' : 'Use my location'}
              </button>
              {location.place && (
                <p role="status">
                  Location found, accurate to about {location.place.accuracy_m} m.
                </p>
              )}
              {location.problem && (
                <div className="error" role="alert">
                  {location.problem}
                </div>
              )}
            </div>
          )}

          {needsSelfie && (
            <label>
              Selfie
              <input
                type="file"
                accept="image/*"
                capture="user"
                disabled={busy}
                onChange={(e) => e.target.files?.[0] && uploadSelfie(e.target.files[0])}
              />
              {selfie && <span> {selfie.name} ready</span>}
            </label>
          )}

          <button
            className="button primary"
            disabled={
              busy || !workType || (needsPlace && !location.place) || (needsSelfie && !selfie)
            }
            onClick={() => send('start', { work_type_id: workType, file_id: selfie?.id ?? null })}
          >
            Start my day
          </button>
        </div>
      )}

      {started && (
        <table>
          <tbody>
            <tr>
              <th>Started</th>
              <td>
                {data.day.start_time} · {data.day.work_type}
                {data.day.start_in_fence === false && ' · outside the usual area'}
              </td>
            </tr>
            <tr>
              <th>Ended</th>
              <td>{data.day.end_time ?? 'not yet'}</td>
            </tr>
          </tbody>
        </table>
      )}

      {started && !ended && (
        <div className="stack">
          <button className="button" disabled={busy || location.asking} onClick={location.ask}>
            {location.asking ? 'Finding you…' : 'Use my location'}
          </button>
          {location.problem && (
            <div className="error" role="alert">
              {location.problem}
            </div>
          )}
          <button
            className="button primary"
            disabled={busy}
            onClick={() => send('end', { version: data.day.version })}
          >
            End my day
          </button>
        </div>
      )}

      {ended && <p role="status">Your day is finished. Thank you.</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Who is out today
// ---------------------------------------------------------------------------

export function DayBoard({ csrf, refreshKey }: { csrf: string; refreshKey: number }) {
  const call = useApi(csrf);
  const [date, setDate] = useState(today());
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setError('');
    call(`reach/attendance/board?date=${date}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [date, refreshKey]);

  if (error)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!data) return <p role="status">Loading the day board…</p>;

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Today</h2>
        <span className="badge">{data.rows.length} on the rolls</span>
      </div>
      <label>
        Date
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>

      <div className="tiles">
        {STATUS_ORDER.filter((s) => data.totals[s]).map((s) => (
          <div className="tile" key={s}>
            <span className="tile-value">{data.totals[s]}</span>
            <span className="tile-label">{STATUS_LABEL[s]}</span>
          </div>
        ))}
      </div>

      {data.remind > 0 && (
        <p role="status">
          {data.remind} {data.remind === 1 ? 'rep has' : 'reps have'} not been heard from since
          their shift ended. Someone should call them.
        </p>
      )}

      <table>
        <thead>
          <tr>
            <th>Rep</th>
            <th>Territory</th>
            <th>Status</th>
            <th>Started</th>
            <th>Ended</th>
            <th>Work</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r: any) => (
            <tr key={r.rep_id} data-status={r.status}>
              <td>
                {r.code} · {r.name}
              </td>
              <td>{r.territory}</td>
              <td>
                <Pill status={r.status} />
                {r.remind && <span className="badge"> no word yet</span>}
              </td>
              <td>
                {r.start_time ?? '—'}
                {r.in_fence === false && ' *'}
              </td>
              <td>{r.end_time ?? '—'}</td>
              <td>{r.work_type ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">* started outside the usual area.</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

export function Register({
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
    call(`reach/attendance/register?from=${from}&to=${to}${rep ? `&rep=${rep}` : ''}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [from, to, rep, refreshKey]);

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Register</h2>
        {data && <span className="badge">{data.paidDays} paid days</span>}
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
        {canReadAll && (
          <a className="button" href={`/api/reach/attendance/payroll.csv?from=${from}&to=${to}`}>
            Payroll CSV
          </a>
        )}
      </div>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {!data && !error && <p role="status">Reading the register…</p>}

      {data && (
        <>
          <div className="tiles">
            {STATUS_ORDER.filter((s) => data.totals[s]).map((s) => (
              <div className="tile" key={s}>
                <span className="tile-value">{data.totals[s]}</span>
                <span className="tile-label">{STATUS_LABEL[s]}</span>
              </div>
            ))}
          </div>
          {data.open.length > 0 && (
            <p role="status">
              {data.open.length} {data.open.length === 1 ? 'day was' : 'days were'} started but
              never ended. Ask for a correction so the register can settle.
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Status</th>
                <th>Worked</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r: any) => (
                <tr key={r.date} data-status={r.status}>
                  <td>{r.date}</td>
                  <td>
                    <Pill status={r.status} />
                  </td>
                  <td>
                    {r.workedMinutes === null
                      ? '—'
                      : `${Math.floor(r.workedMinutes / 60)}h ${r.workedMinutes % 60}m`}
                  </td>
                  <td>{r.holiday || r.leave || (r.late ? 'arrived after the grace' : '')}</td>
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
// Leave
// ---------------------------------------------------------------------------

export function LeaveScreen({
  csrf,
  permissions,
  refreshKey,
}: {
  csrf: string;
  permissions: string[];
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const canApprove = permissions.includes('reach.leave');
  const [data, setData] = useState<any>(null);
  const [types, setTypes] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<any>({ from_date: today(), to_date: today(), half_day: false });
  const [deciding, setDeciding] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let live = true;
    setError('');
    call('reach/attendance/leave')
      .then((d) => {
        if (!live) return;
        setData(d);
        setTypes(d.leaveTypes ?? []);
        setForm((f: any) => ({
          ...f,
          leave_type_id: f.leave_type_id || d.leaveTypes?.[0]?.id || '',
        }));
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [revision, refreshKey]);

  function run(p: Promise<any>) {
    setBusy(true);
    setError('');
    setNotice('');
    p.then((d) => {
      setNotice(d.message);
      setOpen(false);
      setDeciding(null);
      setReason('');
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
  if (!data) return <p role="status">Loading leave…</p>;

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Leave</h2>
        <button className="button primary" onClick={() => setOpen(true)}>
          Apply for leave
        </button>
      </div>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}

      {data.balance.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Leave type</th>
              <th className="num">Days a year</th>
              <th className="num">Taken</th>
              <th className="num">Left</th>
            </tr>
          </thead>
          <tbody>
            {data.balance.map((b: any) => (
              <tr key={b.id}>
                <td>
                  {b.name} {b.paid ? '' : '(unpaid)'}
                </td>
                <td className="num">{b.annual_quota}</td>
                <td className="num">{b.taken}</td>
                <td className="num">{b.left}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Requests</h3>
      {!data.items.length && <p role="status">No leave has been requested yet.</p>}
      {data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Rep</th>
              <th>Type</th>
              <th>From</th>
              <th>To</th>
              <th className="num">Days</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.items.map((l: any) => (
              <tr key={l.id}>
                <td>{l.rep}</td>
                <td>{l.leave_type_name}</td>
                <td>{l.from_date}</td>
                <td>{l.to_date}</td>
                <td className="num">{l.days}</td>
                <td>
                  {l.status}
                  {l.decision_reason ? ` · ${l.decision_reason}` : ''}
                </td>
                <td>
                  {l.status === 'PENDING' && canApprove && (
                    <button className="button" onClick={() => setDeciding(l)}>
                      Decide
                    </button>
                  )}
                  {l.status === 'PENDING' && !canApprove && (
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() =>
                        run(
                          call(`reach/attendance/leave/${l.id}/cancel`, 'PATCH', {
                            version: l.version,
                          }),
                        )
                      }
                    >
                      Withdraw
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {open && (
        <Modal title="Apply for leave" onClose={() => setOpen(false)}>
          <label>
            Leave type
            <select
              value={form.leave_type_id ?? ''}
              onChange={(e) => setForm({ ...form, leave_type_id: e.target.value })}
            >
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            From
            <input
              type="date"
              value={form.from_date}
              onChange={(e) => setForm({ ...form, from_date: e.target.value })}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={form.to_date}
              onChange={(e) => setForm({ ...form, to_date: e.target.value })}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.half_day}
              onChange={(e) => setForm({ ...form, half_day: e.target.checked })}
            />
            Half day only
          </label>
          <label>
            Reason
            <input
              value={form.reason ?? ''}
              maxLength={300}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          </label>
          <button
            className="button primary"
            disabled={busy || !form.leave_type_id}
            onClick={() => run(call('reach/attendance/leave', 'POST', form))}
          >
            Send request
          </button>
        </Modal>
      )}

      {deciding && (
        <Modal title={`Leave for ${deciding.rep}`} onClose={() => setDeciding(null)}>
          <p>
            {deciding.leave_type_name}, {deciding.from_date} to {deciding.to_date}.{' '}
            {deciding.reason}
          </p>
          <label>
            Reason (needed to refuse)
            <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button
            className="button primary"
            disabled={busy}
            onClick={() =>
              run(
                call(`reach/attendance/leave/${deciding.id}/decide`, 'POST', {
                  status: 'APPROVED',
                  reason,
                  version: deciding.version,
                }),
              )
            }
          >
            Approve
          </button>
          <button
            className="button"
            disabled={busy || !reason.trim()}
            onClick={() =>
              run(
                call(`reach/attendance/leave/${deciding.id}/decide`, 'POST', {
                  status: 'REJECTED',
                  reason,
                  version: deciding.version,
                }),
              )
            }
          >
            Refuse
          </button>
        </Modal>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

export function Corrections({
  csrf,
  permissions,
  refreshKey,
}: {
  csrf: string;
  permissions: string[];
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const canApprove = permissions.includes('reach.leave');
  const [status, setStatus] = useState('PENDING');
  const [data, setData] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<any>({ work_date: today(), start_time: '', end_time: '' });
  const [deciding, setDeciding] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let live = true;
    setError('');
    call(`reach/attendance/corrections?status=${status}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [status, revision, refreshKey]);

  function run(p: Promise<any>) {
    setBusy(true);
    setError('');
    setNotice('');
    p.then((d) => {
      setNotice(d.message);
      setOpen(false);
      setDeciding(null);
      setReason('');
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
  if (!data) return <p role="status">Loading corrections…</p>;

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Corrections</h2>
        <button className="button primary" onClick={() => setOpen(true)}>
          Ask for a correction
        </button>
      </div>
      <p>A punch that was missed or wrong. What was there before is kept on the record.</p>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}

      <label>
        Show
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="PENDING">Waiting</option>
          <option value="APPROVED">Applied</option>
          <option value="REJECTED">Refused</option>
          <option value="">All</option>
        </select>
      </label>

      {!data.items.length && <p role="status">Nothing here.</p>}
      {data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Rep</th>
              <th>Date</th>
              <th>Was</th>
              <th>Asked for</th>
              <th>Why</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.items.map((c: any) => (
              <tr key={c.id}>
                <td>{c.rep}</td>
                <td>{c.work_date}</td>
                <td>
                  {c.previous_start ?? '—'} – {c.previous_end ?? '—'}
                </td>
                <td>
                  {c.requested_start ?? '—'} – {c.requested_end ?? '—'}
                </td>
                <td>{c.reason}</td>
                <td>
                  {c.status}
                  {c.decision_reason ? ` · ${c.decision_reason}` : ''}
                </td>
                <td>
                  {c.status === 'PENDING' && canApprove && (
                    <button className="button" onClick={() => setDeciding(c)}>
                      Decide
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {open && (
        <Modal title="Ask for a correction" onClose={() => setOpen(false)}>
          <label>
            Day
            <input
              type="date"
              value={form.work_date}
              onChange={(e) => setForm({ ...form, work_date: e.target.value })}
            />
          </label>
          <label>
            Started at
            <input
              type="time"
              value={form.start_time}
              onChange={(e) => setForm({ ...form, start_time: e.target.value })}
            />
          </label>
          <label>
            Ended at
            <input
              type="time"
              value={form.end_time}
              onChange={(e) => setForm({ ...form, end_time: e.target.value })}
            />
          </label>
          <label>
            Why
            <input
              value={form.reason ?? ''}
              maxLength={300}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          </label>
          <button
            className="button primary"
            disabled={busy || !form.reason?.trim() || (!form.start_time && !form.end_time)}
            onClick={() => run(call('reach/attendance/corrections', 'POST', form))}
          >
            Send request
          </button>
        </Modal>
      )}

      {deciding && (
        <Modal title={`Correction for ${deciding.rep}`} onClose={() => setDeciding(null)}>
          <p>
            {deciding.work_date}: {deciding.previous_start ?? '—'}–{deciding.previous_end ?? '—'}{' '}
            becomes {deciding.requested_start ?? '—'}–{deciding.requested_end ?? '—'}.{' '}
            {deciding.reason}
          </p>
          <label>
            Reason (needed to refuse)
            <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button
            className="button primary"
            disabled={busy}
            onClick={() =>
              run(
                call(`reach/attendance/corrections/${deciding.id}/decide`, 'POST', {
                  status: 'APPROVED',
                  reason,
                }),
              )
            }
          >
            Apply it
          </button>
          <button
            className="button"
            disabled={busy || !reason.trim()}
            onClick={() =>
              run(
                call(`reach/attendance/corrections/${deciding.id}/decide`, 'POST', {
                  status: 'REJECTED',
                  reason,
                }),
              )
            }
          >
            Refuse
          </button>
        </Modal>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function AttendanceSetup({
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
    call('reach/attendance/settings', 'PUT', {
      attendance_fence_m: Number(form.attendance_fence_m),
      absent_after_minutes: Number(form.absent_after_minutes),
      selfie_required: !!form.selfie_required,
      timezone: String(form.timezone ?? '').trim(),
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

  if (!form) return <p role="status">Loading attendance settings…</p>;

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
        <h2>Attendance settings</h2>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}

      {number(
        'attendance_fence_m',
        'Attendance fence in metres',
        'A day started further than this from the territory is marked as outside the usual area. It is never refused on that ground alone.',
      )}
      {number(
        'absent_after_minutes',
        'Chase after minutes',
        'How long after a shift ends before a rep who never punched is proposed for a reminder.',
      )}
      <label>
        <input
          type="checkbox"
          checked={!!form.selfie_required}
          disabled={busy || !canEdit}
          onChange={(e) => setForm({ ...form, selfie_required: e.target.checked })}
        />
        A selfie is needed to start a field day
      </label>
      <label>
        Timezone
        <input
          value={form.timezone ?? ''}
          disabled={busy || !canEdit}
          onChange={(e) => setForm({ ...form, timezone: e.target.value })}
        />
        <span className="hint">
          Which midnight a working day belongs to, for example Asia/Kolkata. Every clock time on
          every attendance screen is read in this zone.
        </span>
        {fieldErrors.timezone && <span className="field-error">{fieldErrors.timezone}</span>}
      </label>

      {canEdit && (
        <button className="button primary" disabled={busy} onClick={save}>
          Save attendance settings
        </button>
      )}
    </section>
  );
}
