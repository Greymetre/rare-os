// RCH-6: the rep's claim, the two desks that decide it, the register and the policy.
//
// Nothing on these screens works out what a line is worth. The server does, from the policy
// version in force on that line's own date, and the screen prints the answer.
//
// That is a deliberate choice and worth the note. The milestone plan asks for the policy's result
// to appear before the rep commits, and the obvious way to do it would be to price the line in
// the browser as they type. It would be wrong often enough to matter: a daily allowance depends
// on what the attendance register says about that day and on which town the tour plan sent the
// rep to, and a browser knows neither. A number that is usually right is worse than no number,
// because a rep learns to trust it. So a line is added, priced by the server, and shown with what
// the policy allows beside what was asked for — and it stays editable, or can be taken off
// altogether, until the claim is sent in.
import { useEffect, useMemo, useState } from 'react';
import { useApi, download } from './api-client';
import { Modal } from './modal';
import { scaleDown } from './reach';

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Being filled in',
  SUBMITTED: 'With the manager',
  MANAGER_OK: 'With finance',
  APPROVED: 'Approved',
  REJECTED: 'Sent back',
};
const STATUS_PILL: Record<string, string> = {
  DRAFT: 'off',
  SUBMITTED: 'pending',
  MANAGER_OK: 'pending',
  APPROVED: 'ok',
  REJECTED: 'missing',
};
const PLACE_LABEL: Record<string, string> = {
  HQ: 'At headquarters',
  EX_HQ: 'Out of headquarters',
  OUTSTATION: 'Away overnight',
};
// The same sentences the engine gives, printed as they are.
const REASON_LABEL: Record<string, string> = {
  NOT_AT_WORK: 'the register says the rep was not at work that day',
  NO_RATE: 'the policy sets no rate for this',
  NO_POLICY: 'no policy version was in force on that date',
  CAPPED: 'the policy caps this',
  PERIOD_CAPPED: 'the policy caps this over the whole claim',
  RECEIPT_MISSING: 'a receipt is needed above the policy limit',
};
const BASIS_HELP: Record<string, string> = {
  KM: 'Kilometres, at the rate for the vehicle.',
  DAILY: 'One day’s allowance, at the rate for where the day was spent.',
  NIGHTLY: 'Nights away, at the rate for this rep’s grade.',
  ACTUAL: 'What was actually spent, up to the policy’s limit.',
};

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = (d: string) => d.slice(0, 8) + '01';
const rupees = (v: unknown) =>
  v === null || v === undefined || v === ''
    ? '—'
    : Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Banner({ error, notice }: { error?: string; notice?: string }) {
  return (
    <>
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="notice" role="status">
          {notice}
        </div>
      ) : null}
    </>
  );
}

function Pill({ status }: { status: string }) {
  return (
    <span className={'status-pill ' + (STATUS_PILL[status] ?? '')}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

// Why a line is not simply what was asked for. Shown on the line itself, because an approver
// reading a total should never have to guess where the difference went.
function Reasons({ reasons }: { reasons: string[] }) {
  if (!reasons?.length) return <span className="hint">—</span>;
  return (
    <span className={reasons.includes('RECEIPT_MISSING') ? 'field-error' : 'hint'}>
      {reasons.map((r) => REASON_LABEL[r] ?? r).join('; ')}
    </span>
  );
}

// The priced lines of one claim. The same table serves the rep filling it in and the two desks
// deciding it, so nobody is reading a different set of numbers from anybody else.
function LineTable({
  priced,
  onEdit,
  onRemove,
}: {
  priced: any;
  onEdit?: (line: any) => void;
  onRemove?: (line: any) => void;
}) {
  if (!priced?.lines?.length) return <p role="status">No lines on this claim yet.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>What</th>
          <th>Where</th>
          <th className="num">Units</th>
          <th className="num">Rate</th>
          <th className="num">Asked</th>
          <th className="num">Allowed</th>
          <th>Why not</th>
          {(onEdit || onRemove) && <th className="actions">Actions</th>}
        </tr>
      </thead>
      <tbody>
        {priced.lines.map((l: any) => (
          <tr key={l.id}>
            <td>{l.spend_date}</td>
            <td>
              {l.category} · {l.category_name}
            </td>
            <td>
              {l.place ? (
                <>
                  {PLACE_LABEL[l.place] ?? l.place}
                  {l.town ? ` · ${l.town}` : ''}
                  {l.town_source === 'PLAN' ? '' : ' · as typed'}
                </>
              ) : (
                (l.town ?? '—')
              )}
            </td>
            <td className="num">
              {l.basis === 'KM'
                ? `${l.units} km`
                : l.basis === 'NIGHTLY'
                  ? `${l.units} nights`
                  : '—'}
            </td>
            <td className="num">{l.rate === null ? '—' : Number(l.rate).toFixed(4)}</td>
            <td className="num">{rupees(l.claimed)}</td>
            <td className={'num' + (l.allowed < l.claimed ? ' field-error' : '')}>
              {rupees(l.allowed)}
            </td>
            <td>
              <Reasons reasons={l.reasons} />
            </td>
            {(onEdit || onRemove) && (
              <td className="actions">
                {onEdit && (
                  <button
                    className="text-button"
                    aria-label={`Edit the ${l.category} line of ${l.spend_date}`}
                    onClick={() => onEdit(l)}
                  >
                    Edit
                  </button>
                )}
                {onRemove && (
                  <button
                    className="text-button warning"
                    aria-label={`Take off the ${l.category} line of ${l.spend_date}`}
                    onClick={() => onRemove(l)}
                  >
                    Take off
                  </button>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th colSpan={5}>Totals</th>
          <th className="num">{rupees(priced.claimed)}</th>
          <th className="num">{rupees(priced.allowed)}</th>
          <th>{priced.disallowed ? `${rupees(priced.disallowed)} not allowed` : ''}</th>
          {(onEdit || onRemove) && <th />}
        </tr>
      </tfoot>
    </table>
  );
}

// ---------------------------------------------------------------------------
// The rep's own claim
// ---------------------------------------------------------------------------

export function MyExpenses({ csrf, refreshKey }: { csrf: string; refreshKey: number }) {
  const call = useApi(csrf);
  const [date, setDate] = useState(today());
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<any>(null);
  const [dropping, setDropping] = useState<any>(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    let live = true;
    setError('');
    setData(null);
    call(`reach/expense/my-claim?date=${date}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [date, revision, refreshKey]);

  const reload = (message: string) => {
    setNotice(message);
    setEditing(null);
    setDropping(null);
    setReason('');
    setRevision((x) => x + 1);
  };

  function submit() {
    setBusy(true);
    setError('');
    call('reach/expense/my-claim/submit', 'POST', {
      claim_id: data.claim.id,
      version: data.claim.version,
    })
      .then((d) => reload(d.message))
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }

  function reopen() {
    setBusy(true);
    setError('');
    call(`reach/expense/claims/${data.claim.id}/reopen`, 'POST', { version: data.claim.version })
      .then((d) => reload(d.message))
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }

  function drop() {
    setBusy(true);
    setError('');
    call(`reach/expense/lines/${dropping.id}/remove`, 'PATCH', {
      reason: reason.trim(),
      version: dropping.version,
    })
      .then((d) => reload(d.message))
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }

  if (error && !data)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!data) return <p role="status">Reading your claim…</p>;

  const draft = !data.claim || data.claim.status === 'DRAFT';

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>My expenses</h2>
        {data.claim && <Pill status={data.claim.status} />}
      </div>

      <div className="filters">
        <label>
          A day in the period
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <span className="hint">
          Claim for {data.period.from} to {data.period.to}.
        </span>
      </div>

      <Banner error={error} notice={notice} />

      {data.claim?.status === 'REJECTED' && (
        <div className="error" role="status">
          Sent back: {data.claim.reject_reason}
        </div>
      )}

      {data.priced && (
        <div className="tiles">
          <div className="tile">
            <span className="tile-value">{data.priced.count}</span>
            <span className="tile-label">Lines</span>
          </div>
          <div className="tile">
            <span className="tile-value">{rupees(data.priced.claimed)}</span>
            <span className="tile-label">Asked for</span>
          </div>
          <div className="tile">
            <span className="tile-value">{rupees(data.priced.allowed)}</span>
            <span className="tile-label">Policy allows</span>
          </div>
          <div className="tile">
            <span className="tile-value">{data.priced.blocked}</span>
            <span className="tile-label">Need a receipt</span>
          </div>
        </div>
      )}

      {draft && (
        <LineForm
          csrf={csrf}
          categories={data.categories}
          vehicles={data.vehicles}
          period={data.period}
          today={data.today}
          onSaved={reload}
          onError={setError}
        />
      )}

      <LineTable
        priced={data.priced}
        onEdit={draft ? (l) => setEditing(l) : undefined}
        onRemove={
          draft
            ? (l) => {
                setReason('');
                setDropping(l);
              }
            : undefined
        }
      />

      {data.claim && draft && data.priced?.count > 0 && (
        <>
          {data.priced.blocked > 0 && (
            <p className="field-error">
              {data.priced.blocked}{' '}
              {data.priced.blocked === 1 ? 'line needs its receipt' : 'lines need their receipts'}{' '}
              before this claim can go in. The money is not in question — the paperwork is.
            </p>
          )}
          <button className="button primary" disabled={busy} onClick={submit}>
            Send this claim in
          </button>
        </>
      )}
      {data.claim?.status === 'REJECTED' && (
        <button className="button" disabled={busy} onClick={reopen}>
          Open it again to correct it
        </button>
      )}

      {editing && (
        <LineForm
          csrf={csrf}
          categories={data.categories}
          vehicles={data.vehicles}
          period={data.period}
          today={data.today}
          line={editing}
          onSaved={reload}
          onError={setError}
          onClose={() => setEditing(null)}
        />
      )}

      {dropping && (
        <Modal title={`Take off the ${dropping.category} line`} onClose={() => setDropping(null)}>
          <p>
            The line comes off this claim. Its record is kept, with your reason — a claim that was
            made and then withdrawn is worth being able to see later.
          </p>
          <label>
            Reason
            <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="modal-actions">
            <button className="button" disabled={busy} onClick={() => setDropping(null)}>
              Close
            </button>
            <button className="button destructive" disabled={busy || !reason.trim()} onClick={drop}>
              Take it off
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

// One line, added or corrected. Drawn as a dialog when it is correcting an existing line and
// inline when it is adding a new one, because adding is the thing a rep does ten times in a row.
function LineForm({
  csrf,
  categories,
  vehicles,
  period,
  today: todayIso,
  line = null,
  onSaved,
  onError,
  onClose,
}: {
  csrf: string;
  categories: any[];
  vehicles: string[];
  period: { from: string; to: string };
  today: string;
  line?: any;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
  onClose?: () => void;
}) {
  const call = useApi(csrf);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [fileName, setFileName] = useState('');
  const [form, setForm] = useState({
    category_id: line?.category_id ?? categories[0]?.id ?? '',
    spend_date: line?.spend_date ?? (todayIso > period.to ? period.to : todayIso),
    km: line?.km ? String(line.km) : '',
    vehicle: line?.vehicle ?? '',
    nights: line?.nights ? String(line.nights) : '',
    town: line?.town ?? '',
    claimed_amount: line?.claimed ? String(line.claimed) : '',
    file_id: line?.file_id ?? null,
    note: line?.note ?? '',
  });

  const category = useMemo(
    () => categories.find((c) => c.id === form.category_id) ?? null,
    [categories, form.category_id],
  );

  async function attach(file: File) {
    setBusy(true);
    onError('');
    try {
      const { blob, type } = await scaleDown(file);
      const r = await fetch(
        `/api/files?purpose=receipt&name=${encodeURIComponent(file.name.slice(0, 200))}`,
        { method: 'POST', headers: { 'Content-Type': type, 'X-CSRF-Token': csrf }, body: blob },
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok)
        throw Error(d.error?.message || 'The receipt could not be uploaded. Please retry.');
      setForm((f) => ({ ...f, file_id: d.id }));
      setFileName(file.name);
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function save() {
    setBusy(true);
    onError('');
    setFieldErrors({});
    const payload: Record<string, unknown> = {
      category_id: form.category_id,
      spend_date: form.spend_date,
      km: form.km === '' ? 0 : Number(form.km),
      vehicle: form.vehicle,
      nights: form.nights === '' ? 0 : Number(form.nights),
      town: form.town.trim(),
      claimed_amount: Number(form.claimed_amount),
      file_id: form.file_id,
      note: form.note.trim(),
    };
    const request = line
      ? call(`reach/expense/lines/${line.id}`, 'PATCH', { ...payload, version: line.version })
      : call('reach/expense/my-claim/lines', 'POST', payload);
    request
      .then((d) => onSaved(d.message))
      .catch((e) => {
        onError(e.fields?.length ? 'Fix the highlighted fields and save again.' : e.message);
        setFieldErrors(Object.fromEntries((e.fields ?? []).map((f: any) => [f.column, f.message])));
      })
      .finally(() => setBusy(false));
  }

  const fields = (
    <>
      <label>
        What
        <select
          value={form.category_id}
          disabled={busy}
          onChange={(e) => setForm({ ...form, category_id: e.target.value })}
        >
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} · {c.name}
            </option>
          ))}
        </select>
        {category && <span className="hint">{BASIS_HELP[category.basis] ?? ''}</span>}
      </label>
      <label>
        Date
        <input
          type="date"
          value={form.spend_date}
          min={period.from}
          max={period.to}
          disabled={busy}
          onChange={(e) => setForm({ ...form, spend_date: e.target.value })}
        />
        {fieldErrors.spend_date && <span className="field-error">{fieldErrors.spend_date}</span>}
      </label>
      {category?.basis === 'KM' && (
        <>
          <label>
            Kilometres
            <input
              value={form.km}
              inputMode="decimal"
              disabled={busy}
              onChange={(e) => setForm({ ...form, km: e.target.value })}
            />
          </label>
          <label>
            Vehicle
            <select
              value={form.vehicle}
              disabled={busy}
              onChange={(e) => setForm({ ...form, vehicle: e.target.value })}
            >
              <option value="">—</option>
              {vehicles.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {category?.basis === 'NIGHTLY' && (
        <label>
          Nights
          <input
            value={form.nights}
            inputMode="numeric"
            disabled={busy}
            onChange={(e) => setForm({ ...form, nights: e.target.value })}
          />
        </label>
      )}
      {(category?.basis === 'DAILY' || category?.basis === 'NIGHTLY') && (
        <label>
          Town
          <input
            value={form.town}
            disabled={busy}
            onChange={(e) => setForm({ ...form, town: e.target.value })}
          />
          <span className="hint">
            Where your tour plan sent you that day is what decides the rate. This is used only on a
            day the plan says nothing about.
          </span>
        </label>
      )}
      <label>
        Amount you are claiming
        <input
          value={form.claimed_amount}
          inputMode="decimal"
          disabled={busy}
          onChange={(e) => setForm({ ...form, claimed_amount: e.target.value })}
        />
        {fieldErrors.claimed_amount && (
          <span className="field-error">{fieldErrors.claimed_amount}</span>
        )}
      </label>
      <label>
        Receipt
        <input
          type="file"
          accept="image/*,application/pdf"
          disabled={busy}
          onChange={(e) => e.target.files?.[0] && attach(e.target.files[0])}
        />
        <span className="hint">
          {form.file_id
            ? `Attached${fileName ? ': ' + fileName : ''}`
            : category?.receipt_above !== null && category?.receipt_above !== undefined
              ? `Needed above ${rupees(category.receipt_above)}.`
              : 'Optional.'}
        </span>
      </label>
      <label>
        Note
        <input
          value={form.note}
          disabled={busy}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
        />
      </label>
    </>
  );

  if (line)
    return (
      <Modal title={`Correct the ${line.category} line`} onClose={onClose ?? (() => {})}>
        {fields}
        <div className="modal-actions">
          <button className="button" disabled={busy} onClick={onClose}>
            Close
          </button>
          <button className="button primary" disabled={busy || !form.claimed_amount} onClick={save}>
            Save the line
          </button>
        </div>
      </Modal>
    );

  return (
    <section className="company-form">
      <h3>Add a line</h3>
      {fields}
      <button
        className="button primary"
        disabled={busy || !form.claimed_amount || !form.category_id}
        onClick={save}
      >
        Add it
      </button>{' '}
      <span className="hint">
        What the policy allows appears the moment the line is added, and the line can be corrected
        or taken off until the claim goes in.
      </span>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The two desks
// ---------------------------------------------------------------------------

export function ExpenseClaims({
  csrf,
  permissions,
  refreshKey,
}: {
  csrf: string;
  permissions: string[];
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const canPass = permissions.includes('reach.expense_approve');
  const canApprove = permissions.includes('reach.expense_finance');
  const [from, setFrom] = useState(monthStart(today()));
  const [to, setTo] = useState(today());
  const [status, setStatus] = useState(canPass ? 'SUBMITTED' : canApprove ? 'MANAGER_OK' : '');
  const [data, setData] = useState<any>(null);
  const [open, setOpen] = useState<any>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let live = true;
    setError('');
    setData(null);
    call(`reach/expense/claims?from=${from}&to=${to}${status ? '&status=' + status : ''}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [from, to, status, revision, refreshKey]);

  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <h2>Expense claims</h2>
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
          <label>
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              {Object.entries(STATUS_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <Banner error={error} notice={notice} />
        {!data && !error && <p role="status">Reading the claims…</p>}
        {data && data.items.length === 0 && <p role="status">Nothing here.</p>}

        {data && data.items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Rep</th>
                <th>Period</th>
                <th>Status</th>
                <th>Passed by</th>
                <th>Approved by</th>
                <th className="actions">Open</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((c: any) => (
                <tr key={c.id} data-status={c.status}>
                  <td>
                    {c.rep} · {c.rep_name}
                  </td>
                  <td>
                    {c.period_from} to {c.period_to}
                  </td>
                  <td>
                    <Pill status={c.status} />
                  </td>
                  <td>{c.manager_name || '—'}</td>
                  <td>{c.finance_name || '—'}</td>
                  <td className="actions">
                    <button
                      className="text-button"
                      aria-label={`Open the claim of ${c.rep} for ${c.period_from}`}
                      onClick={() =>
                        call(`reach/expense/claims/${c.id}`)
                          .then(setOpen)
                          .catch((e) => setError(e.message))
                      }
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {open && (
        <ClaimDialog
          csrf={csrf}
          claim={open}
          onClose={() => setOpen(null)}
          onDone={(message) => {
            setNotice(message);
            setOpen(null);
            setRevision((x) => x + 1);
          }}
        />
      )}
    </>
  );
}

// One claim, read in full, with whichever decision this person may actually take. A stage the
// signed-in person may not act on says why, rather than simply not being there.
function ClaimDialog({
  csrf,
  claim,
  onClose,
  onDone,
}: {
  csrf: string;
  claim: any;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const call = useApi(csrf);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const open = (claim.stages ?? []).find((s: any) => s.allowed) ?? null;
  const blocked = (claim.stages ?? []).filter((s: any) => !s.allowed);

  function decide(approve: boolean) {
    setBusy(true);
    setError('');
    call(`reach/expense/claims/${claim.id}/decide`, 'POST', {
      stage: open.stage,
      approve,
      note: note.trim(),
      reason: approve ? '' : reason.trim(),
      version: claim.version,
    })
      .then((d) => onDone(d.message))
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }

  return (
    <Modal title={`${claim.rep} · ${claim.period_from} to ${claim.period_to}`} onClose={onClose}>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <p className="hint">
        {claim.rep_name} · based at {claim.hq_town || 'no headquarters set'} · grade{' '}
        {claim.grade || '—'} · <Pill status={claim.status} />
      </p>
      {claim.manager_name && (
        <p className="hint">
          Passed by {claim.manager_name}. {claim.manager_note}
        </p>
      )}
      {claim.reject_reason && <p className="field-error">Sent back: {claim.reject_reason}</p>}

      <LineTable priced={claim.priced} />

      {blocked.map((s: any) => (
        <p className="hint" key={s.stage}>
          {s.reason}
        </p>
      ))}

      {open && (
        <>
          <label>
            Note
            <input value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} />
          </label>
          <label>
            Reason, if sending it back
            <textarea
              rows={2}
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
            />
            <span className="hint">The rep has to know what to correct.</span>
          </label>
        </>
      )}

      <div className="modal-actions">
        <button className="button" disabled={busy} onClick={onClose}>
          Close
        </button>
        {open && (
          <button
            className="button destructive"
            disabled={busy || !reason.trim()}
            onClick={() => decide(false)}
          >
            Send it back
          </button>
        )}
        {open && (
          <button className="button primary" disabled={busy} onClick={() => decide(true)}>
            {open.stage === 'MANAGER' ? 'Pass it to finance' : 'Approve it'}
          </button>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

export function ExpenseRegister({ csrf, refreshKey }: { csrf: string; refreshKey: number }) {
  const call = useApi(csrf);
  const [from, setFrom] = useState(monthStart(today()));
  const [to, setTo] = useState(today());
  const [status, setStatus] = useState('');
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setError('');
    setData(null);
    call(`reach/expense/register?from=${from}&to=${to}${status ? '&status=' + status : ''}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [from, to, status, refreshKey]);

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Expense register</h2>
        {data && <span className="badge">{data.totals.claims}</span>}
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
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {Object.entries(STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button"
          onClick={() =>
            download(
              `reach/expense/payout.csv?from=${from}&to=${to}`,
              `rare-os-expenses-${from}-to-${to}.csv`,
            ).catch((e) => setError(e.message))
          }
        >
          Payout CSV
        </button>
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
            <div className="tile">
              <span className="tile-value">{data.totals.claims}</span>
              <span className="tile-label">Claims</span>
            </div>
            <div className="tile">
              <span className="tile-value">{rupees(data.totals.claimed)}</span>
              <span className="tile-label">Asked for</span>
            </div>
            <div className="tile">
              <span className="tile-value">{rupees(data.totals.allowed)}</span>
              <span className="tile-label">Policy allows</span>
            </div>
          </div>

          <p className="hint">
            The payout file carries only what finance has approved, and it is produced from this
            same calculation — so the file and this screen can never disagree about what a rep is
            owed.
          </p>

          {data.rows.length === 0 ? (
            <p role="status">No claim in this window.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Rep</th>
                  <th>Period</th>
                  <th>Status</th>
                  <th className="num">Lines</th>
                  <th className="num">Asked</th>
                  <th className="num">Allowed</th>
                  <th className="num">Not allowed</th>
                  <th>Passed by</th>
                  <th>Approved by</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r: any) => (
                  <tr key={r.id}>
                    <td>
                      {r.rep} · {r.rep_name}
                    </td>
                    <td>
                      {r.period_from} to {r.period_to}
                    </td>
                    <td>
                      <Pill status={r.status} />
                    </td>
                    <td className="num">{r.lines}</td>
                    <td className="num">{rupees(r.claimed)}</td>
                    <td className="num">{rupees(r.allowed)}</td>
                    <td className="num">{r.disallowed ? rupees(r.disallowed) : '—'}</td>
                    <td>{r.manager_name || '—'}</td>
                    <td>{r.finance_name || '—'}</td>
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
// The policy
// ---------------------------------------------------------------------------

export function ExpenseSetup({
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
  const [data, setData] = useState<any>(null);
  const [open, setOpen] = useState<any>(null);
  const [making, setMaking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [settings, setSettings] = useState<any>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    setError('');
    call('reach/expense/setup')
      .then((d) => {
        if (!live) return;
        setData(d);
        setSettings(d.settings);
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [revision, refreshKey]);

  const reload = (message: string) => {
    setNotice(message);
    setOpen(null);
    setMaking(false);
    setRevision((x) => x + 1);
  };

  function saveSettings() {
    setBusy(true);
    setError('');
    setFieldErrors({});
    call('reach/expense/settings', 'PUT', {
      expense_fortnightly: settings.expense_fortnightly === true,
      expense_window_days: Number(settings.expense_window_days),
      version: settings.version,
    })
      .then((d) => reload(d.message))
      .catch((e) => {
        setError(e.fields?.length ? 'Fix the highlighted fields and save again.' : e.message);
        setFieldErrors(Object.fromEntries((e.fields ?? []).map((f: any) => [f.column, f.message])));
      })
      .finally(() => setBusy(false));
  }

  if (error && !data)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!data || !settings) return <p role="status">Loading the expense policy…</p>;

  const inForce = data.policies.find((p: any) => !p.open && p.active) ?? null;

  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <h2>Expense policy</h2>
          <span className="badge">{data.policies.length}</span>
          {canEdit && (
            <button className="button primary" onClick={() => setMaking(true)}>
              New version
            </button>
          )}
        </div>

        <Banner error={error} notice={notice} />

        <p className="hint">
          A version is a dated set of rates. <strong>It can only start after today</strong>, and
          from the day it begins it can no longer be changed. That is what keeps an amount somebody
          has already approved from moving under them — and it is the reason this module can work
          out every claim afresh instead of storing the answer.
        </p>

        {data.policies.length === 0 ? (
          <div className="empty">
            <strong>No policy version yet.</strong>
            <p>
              Until one is in force, a claim can be typed but nothing can be worked out from it:
              nobody can be told what they earn before the company has said so.
            </p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Starts</th>
                <th className="num">Rates</th>
                <th>Standing</th>
                <th className="actions">Open</th>
              </tr>
            </thead>
            <tbody>
              {data.policies.map((p: any) => (
                <tr key={p.id}>
                  <td>{p.code}</td>
                  <td>{p.name}</td>
                  <td>{p.effective_from}</td>
                  <td className="num">{p.rates}</td>
                  <td>
                    {!p.active ? (
                      <span className="status-pill off">Switched off</span>
                    ) : p.open ? (
                      <span className="status-pill pending">Starts later · can be changed</span>
                    ) : p.id === inForce?.id ? (
                      <span className="status-pill ok">In force · frozen</span>
                    ) : (
                      <span className="status-pill off">Superseded · frozen</span>
                    )}
                  </td>
                  <td className="actions">
                    <button
                      className="text-button"
                      aria-label={`Open policy ${p.code}`}
                      onClick={() =>
                        call(`reach/expense/policies/${p.id}`)
                          .then(setOpen)
                          .catch((e) => setError(e.message))
                      }
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className="hint">
          The categories themselves — what may be claimed, and whether a line is worked out from
          kilometres, days, nights or what was actually spent — are a master, under{' '}
          <strong>Expense categories</strong>.
        </p>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>Expense settings</h2>
        </div>
        <label>
          Claims cover
          <select
            value={settings.expense_fortnightly ? 'FORTNIGHT' : 'MONTH'}
            disabled={busy || !canEdit}
            onChange={(e) =>
              setSettings({ ...settings, expense_fortnightly: e.target.value === 'FORTNIGHT' })
            }
          >
            <option value="FORTNIGHT">A fortnight — the 1st to the 15th, then the rest</option>
            <option value="MONTH">A whole month</option>
          </select>
          <span className="hint">
            This shapes the claims made from now on. Claims already made keep the period they were
            made for.
          </span>
        </label>
        <label>
          Days to send a claim in after the period ends
          <input
            value={settings.expense_window_days}
            inputMode="numeric"
            disabled={busy || !canEdit}
            onChange={(e) => setSettings({ ...settings, expense_window_days: e.target.value })}
          />
          <span className="hint">Nought means there is no deadline.</span>
          {fieldErrors.expense_window_days && (
            <span className="field-error">{fieldErrors.expense_window_days}</span>
          )}
        </label>
        {canEdit && (
          <button className="button primary" disabled={busy} onClick={saveSettings}>
            Save expense settings
          </button>
        )}
      </section>

      {making && (
        <NewPolicyDialog
          csrf={csrf}
          today={data.today}
          policies={data.policies}
          onSaved={reload}
          onClose={() => setMaking(false)}
        />
      )}
      {open && (
        <PolicyDialog
          csrf={csrf}
          policy={open}
          canEdit={canEdit}
          onSaved={reload}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

function NewPolicyDialog({
  csrf,
  today: todayIso,
  policies,
  onSaved,
  onClose,
}: {
  csrf: string;
  today: string;
  policies: any[];
  onSaved: (message: string) => void;
  onClose: () => void;
}) {
  const call = useApi(csrf);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const tomorrow = new Date(Date.parse(todayIso + 'T00:00:00Z') + 86400000)
    .toISOString()
    .slice(0, 10);
  const [form, setForm] = useState({
    code: '',
    name: '',
    effective_from: tomorrow,
    note: '',
    copy_from: policies.find((p: any) => !p.open && p.active)?.id ?? '',
  });

  function save() {
    setBusy(true);
    setError('');
    setFieldErrors({});
    call('reach/expense/policies', 'POST', {
      code: form.code.trim(),
      name: form.name.trim(),
      effective_from: form.effective_from,
      note: form.note.trim(),
      copy_from: form.copy_from || null,
    })
      .then((d) => onSaved(d.message))
      .catch((e) => {
        setError(e.fields?.length ? 'Fix the highlighted fields and save again.' : e.message);
        setFieldErrors(Object.fromEntries((e.fields ?? []).map((f: any) => [f.column, f.message])));
      })
      .finally(() => setBusy(false));
  }

  return (
    <Modal title="New policy version" onClose={onClose}>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <label>
        Code
        <input
          value={form.code}
          disabled={busy}
          onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
        />
      </label>
      <label>
        Name
        <input
          value={form.name}
          disabled={busy}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </label>
      <label>
        Starts on
        <input
          type="date"
          value={form.effective_from}
          min={tomorrow}
          disabled={busy}
          onChange={(e) => setForm({ ...form, effective_from: e.target.value })}
        />
        <span className="hint">
          Has to be after today ({todayIso}). A version that started already is what claims have
          been measured against.
        </span>
        {fieldErrors.effective_from && (
          <span className="field-error">{fieldErrors.effective_from}</span>
        )}
      </label>
      <label>
        Start from the rates of
        <select
          value={form.copy_from}
          disabled={busy}
          onChange={(e) => setForm({ ...form, copy_from: e.target.value })}
        >
          <option value="">Nothing — type them all</option>
          {policies.map((p: any) => (
            <option key={p.id} value={p.id}>
              {p.code} · from {p.effective_from}
            </option>
          ))}
        </select>
        <span className="hint">Changing one rate should not mean retyping a dozen.</span>
      </label>
      <label>
        Note
        <input
          value={form.note}
          disabled={busy}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
        />
      </label>
      <div className="modal-actions">
        <button className="button" disabled={busy} onClick={onClose}>
          Close
        </button>
        <button
          className="button primary"
          disabled={busy || !form.code.trim() || !form.name.trim()}
          onClick={save}
        >
          Create it
        </button>
      </div>
    </Modal>
  );
}

// One version's rates. Editable only while the version has not started; otherwise the same table
// is shown read-only, with the reason it cannot be touched.
function PolicyDialog({
  csrf,
  policy,
  canEdit,
  onSaved,
  onClose,
}: {
  csrf: string;
  policy: any;
  canEdit: boolean;
  onSaved: (message: string) => void;
  onClose: () => void;
}) {
  const call = useApi(csrf);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rows, setRows] = useState<any[]>(
    policy.rates.map((r: any) => ({
      category_id: r.category_id,
      key: r.key,
      rate: r.rate ?? '',
      cap: r.cap ?? '',
      period_cap: r.period_cap ?? '',
    })),
  );
  const editable = policy.open && canEdit;
  const categoryOf = (id: string) => policy.categories.find((c: any) => c.id === id) ?? null;

  function save() {
    setBusy(true);
    setError('');
    call(`reach/expense/policies/${policy.id}/rates`, 'PUT', {
      rates: rows.map((r) => ({
        category_id: r.category_id,
        key: r.key,
        rate: r.rate === '' ? null : Number(r.rate),
        cap: r.cap === '' ? null : Number(r.cap),
        period_cap: r.period_cap === '' ? null : Number(r.period_cap),
      })),
    })
      .then((d) => onSaved(d.message))
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }

  const set = (index: number, key: string, value: string) =>
    setRows(rows.map((r, i) => (i === index ? { ...r, [key]: value } : r)));

  return (
    <Modal title={`Policy ${policy.code} · from ${policy.effective_from}`} onClose={onClose}>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {!policy.open && (
        <p className="hint">
          This version started on {policy.effective_from} and is frozen. Claims were measured
          against these numbers, so changing them would move amounts that have already been
          approved. Make a new version instead — it can start from these rates.
        </p>
      )}

      <table>
        <thead>
          <tr>
            <th>Category</th>
            <th>Key</th>
            <th className="num">Rate</th>
            <th className="num">Limit per line</th>
            <th className="num">Limit per claim</th>
            {editable && <th className="actions">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, index) => {
            const category = categoryOf(r.category_id);
            return (
              <tr key={index}>
                <td>
                  {editable ? (
                    <select
                      aria-label={`Category of rate ${index + 1}`}
                      value={r.category_id}
                      onChange={(e) => set(index, 'category_id', e.target.value)}
                    >
                      {policy.categories.map((c: any) => (
                        <option key={c.id} value={c.id}>
                          {c.code} · {c.basis}
                        </option>
                      ))}
                    </select>
                  ) : (
                    `${category?.code ?? ''} · ${category?.basis ?? ''}`
                  )}
                </td>
                <td>
                  {editable ? (
                    <input
                      aria-label={`Key of rate ${index + 1}`}
                      value={r.key}
                      onChange={(e) => set(index, 'key', e.target.value.toUpperCase())}
                    />
                  ) : (
                    r.key || '—'
                  )}
                </td>
                {(['rate', 'cap', 'period_cap'] as const).map((field) => (
                  <td className="num" key={field}>
                    {editable ? (
                      <input
                        className="qty"
                        aria-label={`${field} of rate ${index + 1}`}
                        inputMode="decimal"
                        value={r[field]}
                        onChange={(e) => set(index, field, e.target.value)}
                      />
                    ) : r[field] === '' ? (
                      '—'
                    ) : (
                      String(r[field])
                    )}
                  </td>
                ))}
                {editable && (
                  <td className="actions">
                    <button
                      className="text-button warning"
                      aria-label={`Remove rate ${index + 1}`}
                      onClick={() => setRows(rows.filter((_, i) => i !== index))}
                    >
                      Remove
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>

      {editable && (
        <p className="hint">
          The key is the thing the rate depends on: the vehicle for kilometres (BIKE, CAR), where
          the day was spent for a daily allowance (HQ, EX_HQ, OUTSTATION), the rep&rsquo;s grade
          code for a night&rsquo;s lodging, and nothing at all for a category claimed at actuals.
        </p>
      )}

      <div className="modal-actions">
        <button className="button" disabled={busy} onClick={onClose}>
          Close
        </button>
        {editable && (
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              setRows([
                ...rows,
                {
                  category_id: policy.categories[0]?.id ?? '',
                  key: '',
                  rate: '',
                  cap: '',
                  period_cap: '',
                },
              ])
            }
          >
            Add a rate
          </button>
        )}
        {editable && (
          <button className="button primary" disabled={busy} onClick={save}>
            Save the rates
          </button>
        )}
      </div>
    </Modal>
  );
}
