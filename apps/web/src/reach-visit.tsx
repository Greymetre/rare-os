// RCH-4: the field app, the day's calls and what a manager reads of them.
//
// The field app is drawn inside a phone-shaped frame on purpose. The milestone plan says this
// screen is the reference the mobile app will be written against, so it is built the way a phone
// will use it — one round, one stop at a time, big targets, and a check-in that goes through
// whether or not the location arrives.
//
// Nothing here decides anything the server has not already decided. A check-in 800 metres from
// the shop is recorded and flagged by the API; this screen shows the flag. It never refuses one.
import { useEffect, useState } from 'react';
import { useApi } from './api-client';
import { Modal } from './modal';
import { useLocation } from './reach-attendance';

const STATUS_LABEL: Record<string, string> = {
  OPEN: 'In the shop',
  SHORT: 'Short call',
  DONE: 'Done',
  PENDING: 'Not yet',
};
const STATUS_ORDER = ['DONE', 'SHORT', 'OPEN'];

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = (d: string) => d.slice(0, 8) + '01';
const clock = (at: string | null) =>
  at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';

function Pill({ status }: { status: string }) {
  return (
    <span className={'status-pill visit-' + status.toLowerCase()}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

// How far the check-in was from the shop, said in words a rep can act on.
function Distance({ visit }: { visit: any }) {
  if (visit.distance_m === null || visit.distance_m === undefined)
    return <span className="hint">not measured</span>;
  return (
    <span className={visit.out_of_fence ? 'field-error' : ''}>
      {visit.distance_m} m{visit.out_of_fence ? ' · flagged' : ''}
    </span>
  );
}

// The report form for one customer type, drawn from whatever the company asked for.
function ReportForm({
  form,
  answers,
  onChange,
  disabled,
  errors,
}: {
  form: any[];
  answers: Record<string, any>;
  onChange: (next: Record<string, any>) => void;
  disabled: boolean;
  errors: Record<string, string>;
}) {
  if (!form.length)
    return <p className="hint">This customer type asks no questions on the way out.</p>;
  return (
    <>
      {form.map((field) => (
        <label key={field.field_key}>
          {field.label}
          {field.required ? ' *' : ''}
          {field.input === 'select' ? (
            <select
              value={answers[field.field_key] ?? ''}
              disabled={disabled}
              onChange={(e) => onChange({ ...answers, [field.field_key]: e.target.value })}
            >
              <option value="">—</option>
              {field.choices.map((choice: string) => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
            </select>
          ) : field.input === 'bool' ? (
            <input
              type="checkbox"
              checked={!!answers[field.field_key]}
              disabled={disabled}
              onChange={(e) => onChange({ ...answers, [field.field_key]: e.target.checked })}
            />
          ) : field.input === 'textarea' ? (
            <textarea
              value={answers[field.field_key] ?? ''}
              disabled={disabled}
              rows={3}
              onChange={(e) => onChange({ ...answers, [field.field_key]: e.target.value })}
            />
          ) : (
            <input
              type={field.input === 'date' ? 'date' : 'text'}
              inputMode={field.input === 'number' ? 'decimal' : undefined}
              value={answers[field.field_key] ?? ''}
              disabled={disabled}
              onChange={(e) => onChange({ ...answers, [field.field_key]: e.target.value })}
            />
          )}
          {field.help && <span className="hint">{field.help}</span>}
          {errors[field.field_key] && (
            <span className="field-error">{errors[field.field_key]}</span>
          )}
        </label>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// The field app
// ---------------------------------------------------------------------------

export function FieldApp({ csrf, refreshKey }: { csrf: string; refreshKey: number }) {
  const call = useApi(csrf);
  const { place, asking, problem, ask } = useLocation();
  const [day, setDay] = useState<any>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [leaving, setLeaving] = useState<any>(null);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    setError('');
    call('reach/visits/my-day')
      .then((d) => live && setDay(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [refreshKey, revision]);

  // The location is asked for once when the screen opens. A refusal is not a blocker: the
  // check-in still goes through, and the distance is simply not measured.
  useEffect(() => {
    ask();
  }, []);

  function arrive(customerId: string) {
    setBusy(true);
    setError('');
    setNotice('');
    call('reach/visits/check-in', 'POST', {
      customer_id: customerId,
      ...(place ?? {}),
      // One reference per rep, shop and day, so a tap that is sent twice on a bad line is
      // answered with the visit that already exists instead of making a second one.
      client_ref: `${day.rep.code}-${customerId}-${day.date}`.slice(0, 80),
    })
      .then((d) => {
        setNotice(d.message);
        setRevision((x) => x + 1);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }

  function openCheckout(visit: any) {
    setFieldErrors({});
    setError('');
    call(`reach/visits/form/${visit.customer_id}`)
      .then((d) => {
        setLeaving({ ...visit, form: d.form, customer: d.customer });
        setAnswers(visit.report ?? {});
      })
      .catch((e) => setError(e.message));
  }

  function depart() {
    setBusy(true);
    setError('');
    setFieldErrors({});
    call(`reach/visits/${leaving.id}/check-out`, 'POST', {
      report: answers,
      ...(place ?? {}),
      version: leaving.version,
    })
      .then((d) => {
        setNotice(d.message);
        setLeaving(null);
        setRevision((x) => x + 1);
      })
      .catch((e) => {
        setError(e.fields?.length ? 'Answer the highlighted questions.' : e.message);
        setFieldErrors(Object.fromEntries((e.fields ?? []).map((f: any) => [f.column, f.message])));
      })
      .finally(() => setBusy(false));
  }

  if (error && !day)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!day) return <p role="status">Loading the round…</p>;

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Field app</h2>
        <span className="badge">
          {day.done} / {day.planned} stops
        </span>
      </div>

      <p className="hint">
        This is the screen the mobile app will be built against. A check-in is recorded whether or
        not the location arrives, and a check-in from outside the shop&rsquo;s radius is recorded
        and flagged — never refused.
      </p>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}

      {/* A phone-shaped frame: one round, one stop at a time, the way a phone will use it. */}
      <div className="field-phone">
        <div className="field-phone-head">
          <strong>{day.rep.code}</strong>
          <span>{day.date}</span>
        </div>

        <div className="field-phone-gps">
          {place ? (
            <span>Located to about {place.accuracy_m} m</span>
          ) : (
            <span className="hint">{problem || (asking ? 'Finding you…' : 'No location yet')}</span>
          )}
          <button className="text-button" disabled={asking} onClick={ask}>
            {asking ? 'Finding…' : 'Refresh'}
          </button>
        </div>

        <div className="field-phone-stops">
          {day.stops.length === 0 && (
            <p role="status">
              No round today. Anything you call on will be recorded as an unplanned call.
            </p>
          )}
          {day.stops.map((stop: any) => {
            const visit = stop.visits[0] ?? null;
            return (
              <div
                className="field-stop"
                key={stop.customer_id}
                data-status={stop.status}
                data-planned={stop.planned ? 'yes' : 'no'}
              >
                <div className="field-stop-who">
                  <strong>
                    {stop.sequence ? `${stop.sequence}. ` : ''}
                    {stop.code}
                  </strong>
                  <span>{stop.name}</span>
                  {!stop.planned && <span className="hint">not on today&rsquo;s round</span>}
                </div>
                <div className="field-stop-state">
                  <Pill status={stop.status} />
                  {visit && (
                    <span className="hint">
                      {clock(visit.checked_in_at)}
                      {visit.checked_out_at ? ` – ${clock(visit.checked_out_at)}` : ''}
                      {visit.minutes !== null ? ` · ${visit.minutes} min` : ''}
                    </span>
                  )}
                  {visit && <Distance visit={visit} />}
                  {visit && !visit.report_complete && visit.checked_out_at && (
                    <span className="field-error">report not finished</span>
                  )}
                </div>
                <div className="field-stop-do">
                  {!visit && (
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() => arrive(stop.customer_id)}
                    >
                      Check in
                    </button>
                  )}
                  {visit && !visit.checked_out_at && (
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() => openCheckout(visit)}
                    >
                      Check out
                    </button>
                  )}
                  {visit && visit.checked_out_at && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => openCheckout(visit)}
                    >
                      Report
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="field-phone-foot">
          <span>{day.summary.visits} calls</span>
          <span>{day.summary.minutes} min</span>
          {day.summary.outOfFence > 0 && (
            <span className="field-error">{day.summary.outOfFence} flagged</span>
          )}
          {day.summary.incomplete > 0 && (
            <span className="hint">{day.summary.incomplete} unfinished</span>
          )}
        </div>
      </div>

      {leaving && (
        <Modal
          title={`${leaving.checked_out_at ? 'Report for' : 'Leaving'} ${leaving.customer?.name ?? leaving.customer_name}`}
          onClose={() => setLeaving(null)}
        >
          <ReportForm
            form={leaving.form}
            answers={answers}
            onChange={setAnswers}
            disabled={busy}
            errors={fieldErrors}
          />
          <div className="toolbar">
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                leaving.checked_out_at
                  ? (setBusy(true),
                    setFieldErrors({}),
                    call(`reach/visits/${leaving.id}/report`, 'PUT', {
                      report: answers,
                      version: leaving.version,
                    })
                      .then((d) => {
                        setNotice(d.message);
                        setLeaving(null);
                        setRevision((x) => x + 1);
                      })
                      .catch((e) => {
                        setError(
                          e.fields?.length ? 'Answer the highlighted questions.' : e.message,
                        );
                        setFieldErrors(
                          Object.fromEntries(
                            (e.fields ?? []).map((f: any) => [f.column, f.message]),
                          ),
                        );
                      })
                      .finally(() => setBusy(false)))
                  : depart()
              }
            >
              {leaving.checked_out_at ? 'Save the report' : 'Check out'}
            </button>
            <button className="button" disabled={busy} onClick={() => setLeaving(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The day's calls
// ---------------------------------------------------------------------------

export function VisitList({
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
    call(`reach/visits?from=${from}&to=${to}${rep ? `&rep=${rep}` : ''}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [from, to, rep, refreshKey]);

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Visits</h2>
        {data && <span className="badge">{data.total}</span>}
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
          <a
            className="button"
            href={`/api/reach/visits/export.csv?from=${from}&to=${to}${rep ? `&rep=${rep}` : ''}`}
          >
            Visits CSV
          </a>
        )}
      </div>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {!data && !error && <p role="status">Reading the calls…</p>}

      {data && (
        <>
          <div className="tiles">
            {STATUS_ORDER.filter((s) => data.summary.totals[s]).map((s) => (
              <div className="tile" key={s}>
                <span className="tile-value">{data.summary.totals[s]}</span>
                <span className="tile-label">{STATUS_LABEL[s]}</span>
              </div>
            ))}
            <div className="tile">
              <span className="tile-value">{data.summary.outOfFence}</span>
              <span className="tile-label">Flagged</span>
            </div>
            <div className="tile">
              <span className="tile-value">{data.summary.incomplete}</span>
              <span className="tile-label">Report unfinished</span>
            </div>
            <div className="tile">
              <span className="tile-value">{data.summary.averageMinutes ?? '—'}</span>
              <span className="tile-label">Average minutes</span>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Customer</th>
                <th>Town</th>
                <th>Round</th>
                <th>In</th>
                <th>Out</th>
                <th>Minutes</th>
                <th>Distance</th>
                <th>Status</th>
                <th>Report</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((v: any) => (
                <tr key={v.id} data-status={v.status}>
                  <td>{v.visit_date}</td>
                  <td>
                    {v.customer} · {v.customer_name}
                  </td>
                  <td>{v.town}</td>
                  <td>{v.beat || '—'}</td>
                  <td>{clock(v.checked_in_at)}</td>
                  <td>{clock(v.checked_out_at)}</td>
                  <td>{v.minutes ?? '—'}</td>
                  <td>
                    <Distance visit={v} />
                  </td>
                  <td>
                    <Pill status={v.status} />
                  </td>
                  <td>
                    {v.report_complete ? (
                      'Complete'
                    ) : (
                      <span className="field-error">
                        {v.missing.length ? `missing ${v.missing.length}` : 'not written'}
                      </span>
                    )}
                  </td>
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
// Everyone's day
// ---------------------------------------------------------------------------

export function VisitBoard({ csrf, refreshKey }: { csrf: string; refreshKey: number }) {
  const call = useApi(csrf);
  const [date, setDate] = useState(today());
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setError('');
    setData(null);
    call(`reach/visits/board?date=${date}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [date, refreshKey]);

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Calls today</h2>
        {data && <span className="badge">{data.summary.visits}</span>}
      </div>

      <div className="filters">
        <label>
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {!data && !error && <p role="status">Reading the day…</p>}

      {data && (
        <>
          <div className="tiles">
            <div className="tile">
              <span className="tile-value">{data.reps.length}</span>
              <span className="tile-label">Reps out</span>
            </div>
            <div className="tile">
              <span className="tile-value">{data.summary.visits}</span>
              <span className="tile-label">Calls</span>
            </div>
            <div className="tile">
              <span className="tile-value">{data.summary.outOfFence}</span>
              <span className="tile-label">Flagged</span>
            </div>
            <div className="tile">
              <span className="tile-value">{data.summary.incomplete}</span>
              <span className="tile-label">Report unfinished</span>
            </div>
          </div>

          {data.reps.length === 0 ? (
            <p role="status">Nobody has called on anyone yet today.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Rep</th>
                  <th>Calls</th>
                  <th>Minutes</th>
                  <th>Average</th>
                  <th>Flagged</th>
                  <th>Unfinished</th>
                  <th>Shops</th>
                </tr>
              </thead>
              <tbody>
                {data.reps.map((r: any) => (
                  <tr key={r.rep_id}>
                    <td>
                      {r.rep} · {r.rep_name}
                    </td>
                    <td>{r.summary.visits}</td>
                    <td>{r.summary.minutes}</td>
                    <td>{r.summary.averageMinutes ?? '—'}</td>
                    <td>
                      {r.summary.outOfFence ? (
                        <span className="field-error">{r.summary.outOfFence}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{r.summary.incomplete || '—'}</td>
                    <td>{r.visits.map((v: any) => v.customer).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function VisitSetup({
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
    call('reach/visits/settings', 'PUT', {
      visit_dedupe_minutes: Number(form.visit_dedupe_minutes),
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

  if (!form) return <p role="status">Loading visit settings…</p>;

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Visit settings</h2>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}

      <label>
        Retry window in minutes
        <input
          value={form.visit_dedupe_minutes}
          disabled={busy || !canEdit}
          inputMode="numeric"
          onChange={(e) => setForm({ ...form, visit_dedupe_minutes: e.target.value })}
        />
        <span className="hint">
          How long after a check-in the same check-in may arrive again and still be the same visit.
          This is the window a dropped field connection needs; beyond it, a second call is a second
          call.
        </span>
        {fieldErrors.visit_dedupe_minutes && (
          <span className="field-error">{fieldErrors.visit_dedupe_minutes}</span>
        )}
      </label>

      <p className="hint">
        How close a check-in has to be is not set here: it belongs to the customer type, under
        Customer types, because a distributor&rsquo;s yard and a retailer&rsquo;s counter are not
        the same distance. A check-in beyond it is always recorded and flagged, never refused.
      </p>

      {canEdit && (
        <button className="button primary" disabled={busy} onClick={save}>
          Save visit settings
        </button>
      )}
    </section>
  );
}
