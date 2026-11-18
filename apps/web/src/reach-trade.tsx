// RCH-5: Customer 360 — the shop's whole trading picture, the order taken in front of it, and
// the paperwork behind it.
//
// Nothing drawn here is a stored verdict. The outstanding, the ageing, the credit hold and the
// KYC state are read from the evidence every time the screen loads, which is why banking a
// collection or verifying a document changes what is shown with nothing to find and rewrite.
//
// Two buttons are driven by a permission rather than by a setting. "Raise invoice" appears only
// where `reach.invoice` is granted; granted to nobody, every bill arrives from an ERP and is
// recorded here instead, and no setting anywhere says which of the two worlds a company lives in.
// "Release" is its own right as well, because taking a held order off hold is somebody's decision
// and is recorded with their reason.
//
// A held order is never a refusal. The screen says what the hold is for and leaves the order
// where it is: a rep told "no" with no record of why stops trusting the app.
import { useEffect, useMemo, useState } from 'react';
import { useApi } from './api-client';
import { Modal } from './modal';
import { useLocation } from './reach-attendance';
import { scaleDown } from './reach';

const PAYMENT_MODES = ['CASH', 'CHEQUE', 'UPI', 'NEFT', 'ADJUSTMENT'];
// A cheque or a transfer without its number cannot be traced to a bank line; the API refuses one,
// so the screen says so before it is sent.
const MODES_NEEDING_REFERENCE = ['CHEQUE', 'NEFT', 'UPI'];
const ORDER_STATUSES = ['HELD', 'PLACED', 'ROUTED', 'CANCELLED'];
const INVOICE_SOURCES: [string, string][] = [
  ['MANUAL', 'Entered by hand'],
  ['ERP', 'From the ERP'],
  ['IMPORT', 'From an import'],
];
const SOURCE_LABEL: Record<string, string> = {
  MANUAL: 'By hand',
  ERP: 'ERP',
  IMPORT: 'Import',
  RAISED: 'Raised here',
};
const KYC_LABEL: Record<string, string> = {
  VERIFIED: 'Verified',
  PENDING: 'Waiting',
  MISSING: 'Not given',
  REJECTED: 'Rejected',
};
const KYC_PILL: Record<string, string> = {
  VERIFIED: 'ok',
  PENDING: 'pending',
  MISSING: 'missing',
  REJECTED: 'missing',
};
const ORDER_PILL: Record<string, string> = {
  PLACED: 'ok',
  ROUTED: 'ok',
  HELD: 'pending',
  CANCELLED: 'off',
  DRAFT: 'off',
};
const BILL_PILL: Record<string, string> = {
  PAID: 'ok',
  PART_PAID: 'pending',
  OPEN: 'missing',
  CANCELLED: 'off',
};
const TIMELINE_LABEL: Record<string, string> = {
  VISIT: 'Visit',
  ORDER: 'Order',
  INVOICE: 'Bill',
  RECEIPT: 'Collection',
  KYC: 'Document',
  GEO: 'Location',
};

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = (d: string) => d.slice(0, 8) + '01';
// Money is printed the way an Indian invoice prints it, to the paisa, and a thing that is not a
// number at all is a dash rather than a zero: "no limit" and "a limit of nought" are not the same.
const rupees = (v: unknown) =>
  v === null || v === undefined || v === ''
    ? '—'
    : Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const count = (v: unknown) => Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const stamp = (at: string | null) => (at ? new Date(at).toLocaleString() : '—');
// A blank box means "not given", which is not the same instruction as zero.
const orNull = (v: string) => (String(v ?? '').trim() === '' ? null : Number(v));

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

// Every cancellation in this module asks for a reason, because every one of them is a record of
// somebody's decision rather than a tidy-up.
function ReasonDialog({
  title,
  prompt,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  prompt: string;
  confirmLabel: string;
  busy: boolean;
  error: string;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Modal title={title} onClose={onClose}>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <p>{prompt}</p>
      <label>
        Reason
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="modal-actions">
        <button className="button" disabled={busy} onClick={onClose}>
          Close
        </button>
        <button
          className="button primary"
          disabled={busy || !reason.trim()}
          onClick={() => onConfirm(reason.trim())}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Picking the shop
// ---------------------------------------------------------------------------

function CustomerPicker({
  csrf,
  heading,
  refreshKey,
  onPick,
}: {
  csrf: string;
  heading: string;
  refreshKey: number;
  onPick: (customer: any) => void;
}) {
  const call = useApi(csrf);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setError('');
    setRows(null);
    call(`reach/customers?limit=20${search ? '&q=' + encodeURIComponent(search) : ''}`)
      .then((d) => live && setRows(d.items))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [search, refreshKey]);

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>{heading}</h2>
      </div>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(query.trim());
        }}
      >
        <label>
          Find a customer
          <input
            value={query}
            placeholder="Code, name or town"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button className="button" type="submit">
          Search
        </button>
      </form>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {!rows && !error && <p role="status">Reading the register…</p>}
      {rows && rows.length === 0 && <p role="status">No customer matched that.</p>}
      {rows && rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Type</th>
              <th>Town</th>
              <th>Status</th>
              <th className="actions">Open</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c: any) => (
              <tr key={c.id}>
                <td>{c.code}</td>
                <td>{c.name}</td>
                <td>{c.type_name}</td>
                <td>{c.town || '—'}</td>
                <td>
                  <span className={'status-pill ' + (c.status === 'ACTIVE' ? 'ok' : 'off')}>
                    {c.status}
                  </span>
                </td>
                <td className="actions">
                  <button
                    className="text-button"
                    aria-label={`Open customer ${c.code}`}
                    onClick={() => onPick(c)}
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
  );
}

// ---------------------------------------------------------------------------
// Customer 360
// ---------------------------------------------------------------------------

// What this screen may offer is read from the signed-in person's rights as the API reports them,
// not from the list the shell holds, so the button and the route it calls can never disagree.
export function Customer360({ csrf, refreshKey }: { csrf: string; refreshKey: number }) {
  const call = useApi(csrf);
  const [picked, setPicked] = useState<any>(null);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState('');
  const [scrapping, setScrapping] = useState<any>(null);
  const [dialogError, setDialogError] = useState('');

  const customerId = picked?.id ?? null;

  useEffect(() => {
    if (!customerId) return;
    let live = true;
    setError('');
    setData(null);
    call(`reach/trade/customer/${customerId}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [customerId, revision, refreshKey]);

  function done(message: string) {
    setDialog('');
    setScrapping(null);
    setDialogError('');
    setNotice(message);
    setRevision((x) => x + 1);
  }

  function scrap(reason: string) {
    setBusy(true);
    setDialogError('');
    const path =
      scrapping.kind === 'invoice'
        ? `reach/trade/invoices/${scrapping.row.id}/cancel`
        : `reach/trade/receipts/${scrapping.row.id}/cancel`;
    call(path, 'PATCH', { reason, version: scrapping.row.version })
      .then((d) => done(d.message))
      .catch((e) => setDialogError(e.message))
      .finally(() => setBusy(false));
  }

  if (!customerId)
    return (
      <CustomerPicker
        csrf={csrf}
        heading="Customer 360"
        refreshKey={refreshKey}
        onPick={(c) => {
          setNotice('');
          setPicked(c);
        }}
      />
    );

  const c = data?.customer;
  const can = data?.can ?? {};
  const owing = data?.outstanding;

  return (
    <>
      <div className="toolbar">
        <button
          className="button"
          onClick={() => {
            setPicked(null);
            setData(null);
            setNotice('');
          }}
        >
          Another customer
        </button>
        {data && can.order && (
          <span className="hint">Orders are taken on the Take order screen.</span>
        )}
      </div>
      <Banner error={error} notice={notice} />
      {!data && !error && <p role="status">Reading the customer…</p>}

      {data && (
        <>
          <section className="panel">
            <div className="panel-heading">
              <h2>
                {c.code} · {c.name}
              </h2>
              <span className={'status-pill ' + (c.status === 'ACTIVE' ? 'ok' : 'off')}>
                {c.status}
              </span>
            </div>
            <p className="hint">
              {c.type_name} · {c.town || 'no town'} · beat {c.beat || '—'} · rep {c.rep || '—'} ·
              read as at {data.asOf}
            </p>

            <div className="tiles">
              <div className="tile">
                <span className="tile-value">{rupees(owing.outstanding)}</span>
                <span className="tile-label">Outstanding</span>
              </div>
              <div className="tile">
                <span className="tile-value">{rupees(data.credit.available)}</span>
                <span className="tile-label">Left to sell</span>
              </div>
              <div className="tile">
                <span className="tile-value">{owing.oldestDays ?? '—'}</span>
                <span className="tile-label">Oldest bill, days</span>
              </div>
              <div className="tile">
                <span className="tile-value">{data.dso ?? '—'}</span>
                <span className="tile-label">DSO</span>
              </div>
              <div className="tile">
                <span className="tile-value">{rupees(data.sales.thisMonth.amount)}</span>
                <span className="tile-label">Sold this month</span>
              </div>
              <div className="tile">
                <span className="tile-value">{data.visits.visits}</span>
                <span className="tile-label">Visits</span>
              </div>
            </div>

            <div className={data.credit.hold ? 'error' : 'notice'} role="status">
              {data.credit.message}
              {data.credit.hold ? ' A new order would be taken and held.' : ''}
            </div>
          </section>

          {/* ---------- Credit ---------- */}
          <section className="panel">
            <div className="panel-heading">
              <h2>Credit</h2>
              {can.terms && (
                <button
                  className="button"
                  onClick={() => {
                    setDialogError('');
                    setDialog('terms');
                  }}
                >
                  Change terms
                </button>
              )}
            </div>
            <table>
              <thead>
                <tr>
                  <th>Term</th>
                  <th className="num">Value</th>
                  <th>Where it comes from</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Credit limit</td>
                  <td className="num">
                    {data.credit.limit === null ? 'No limit' : rupees(data.credit.limit)}
                  </td>
                  <td>{c.terms.from.credit_limit === 'customer' ? 'This shop' : 'Its type'}</td>
                </tr>
                <tr>
                  <td>Credit days</td>
                  <td className="num">{data.credit.creditDays ?? '—'}</td>
                  <td>{c.terms.from.credit_days === 'customer' ? 'This shop' : 'Its type'}</td>
                </tr>
                <tr>
                  <td>Stop selling after, days</td>
                  <td className="num">{data.credit.holdDays ?? 'Never'}</td>
                  <td>{c.terms.from.hold_days === 'customer' ? 'This shop' : 'Its type'}</td>
                </tr>
                <tr>
                  <td>Exposure now</td>
                  <td className="num">{rupees(data.credit.exposure)}</td>
                  <td>What is owed, plus anything being ordered</td>
                </tr>
              </tbody>
            </table>
            {data.credit.reasons.length > 0 && (
              <p className="hint">
                On hold for: {data.credit.reasons.join(', ')}. A hold clears by itself the moment
                the reason does — nothing has to be reset.
              </p>
            )}
            <p className="hint">
              Credit days are the terms the company sells on. Stop-selling days are the age at which
              it stops; a type with no stop rule never holds for age, however old the bill.
            </p>
          </section>

          {/* ---------- KYC ---------- */}
          <section className="panel">
            <div className="panel-heading">
              <h2>Paperwork</h2>
              <span className={'status-pill ' + (KYC_PILL[data.kyc.status] ?? '')}>
                {KYC_LABEL[data.kyc.status] ?? data.kyc.status}
              </span>
              {can.kyc && data.kyc.rows.length > 0 && (
                <button
                  className="button"
                  onClick={() => {
                    setDialogError('');
                    setDialog('kyc');
                  }}
                >
                  Upload a document
                </button>
              )}
            </div>
            {data.kyc.rows.length === 0 ? (
              <p className="hint">
                This customer type asks for no documents, so its paperwork counts as in order.
              </p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>Asked for</th>
                    <th>Number</th>
                    <th>Status</th>
                    <th>Uploaded</th>
                    <th>Decided by</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {data.kyc.rows.map((row: any) => (
                    <tr key={row.code}>
                      <td>
                        {row.code} · {row.name}
                      </td>
                      <td>{row.required ? 'Must have' : 'Optional'}</td>
                      <td>{row.number || '—'}</td>
                      <td>
                        <span className={'status-pill ' + (KYC_PILL[row.status] ?? '')}>
                          {KYC_LABEL[row.status] ?? row.status}
                        </span>
                      </td>
                      <td>{row.uploaded_at ? stamp(row.uploaded_at) : '—'}</td>
                      <td>{row.decided_by || '—'}</td>
                      <td>{row.decision_reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* ---------- Money owed ---------- */}
          <section className="panel">
            <div className="panel-heading">
              <h2>Money owed</h2>
              <span className="badge">{owing.invoices} open</span>
              {can.invoice && (
                <button
                  className="button"
                  onClick={() => {
                    setDialogError('');
                    setDialog('bill');
                  }}
                >
                  Record a bill
                </button>
              )}
              {can.collect && (
                <button
                  className="button primary"
                  onClick={() => {
                    setDialogError('');
                    setDialog('collect');
                  }}
                >
                  Collect
                </button>
              )}
            </div>

            <div className="tiles">
              {owing.labels.map((label: string) => (
                <div className="tile" key={label}>
                  <span className="tile-value">{rupees(owing.totals[label])}</span>
                  <span className="tile-label">{label} days</span>
                </div>
              ))}
              <div className="tile">
                <span className="tile-value">{rupees(owing.unapplied)}</span>
                <span className="tile-label">Collected, no bill</span>
              </div>
            </div>

            {owing.rows.length === 0 ? (
              <p role="status">No bill has been recorded against this shop yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Bill</th>
                    <th>Date</th>
                    <th>Due</th>
                    <th className="num">Amount</th>
                    <th className="num">Settled</th>
                    <th className="num">Still owed</th>
                    <th className="num">Age</th>
                    <th>Status</th>
                    <th>Raised by</th>
                    <th className="actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {owing.rows.map((b: any) => (
                    <tr key={b.id}>
                      <td>{b.invoice_no}</td>
                      <td>{b.invoice_date}</td>
                      <td>{b.due_date || '—'}</td>
                      <td className="num">{rupees(b.amount)}</td>
                      <td className="num">{rupees(b.applied)}</td>
                      <td className="num">{rupees(b.outstanding)}</td>
                      <td className="num">{b.age_days ?? '—'}</td>
                      <td>
                        <span className={'status-pill ' + (BILL_PILL[b.status] ?? '')}>
                          {b.status === 'PART_PAID' ? 'Part paid' : b.status}
                        </span>
                      </td>
                      <td>{SOURCE_LABEL[b.source] ?? b.source}</td>
                      <td className="actions">
                        {can.invoice && (
                          <button
                            className="text-button warning"
                            aria-label={`Cancel bill ${b.invoice_no}`}
                            onClick={() => {
                              setDialogError('');
                              setScrapping({ kind: 'invoice', row: b });
                            }}
                          >
                            Cancel
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h3>Collections</h3>
            {owing.receipts.length === 0 ? (
              <p className="hint">Nothing has been collected from this shop yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th>Date</th>
                    <th className="num">Amount</th>
                    <th>How</th>
                    <th>Reference</th>
                    <th>Rep</th>
                    <th>Against</th>
                    <th>Status</th>
                    <th className="actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {owing.receipts.map((r: any) => (
                    <tr key={r.id}>
                      <td>{r.receipt_no}</td>
                      <td>{r.received_on}</td>
                      <td className="num">{rupees(r.amount)}</td>
                      <td>{r.mode}</td>
                      <td>{r.reference || '—'}</td>
                      <td>{r.rep || '—'}</td>
                      <td>
                        {r.invoice_id
                          ? (owing.rows.find((b: any) => b.id === r.invoice_id)?.invoice_no ??
                            'a bill')
                          : 'On account'}
                      </td>
                      <td>
                        <span
                          className={'status-pill ' + (r.status === 'CANCELLED' ? 'off' : 'ok')}
                        >
                          {r.status === 'CANCELLED' ? 'Cancelled' : 'Recorded'}
                        </span>
                      </td>
                      <td className="actions">
                        {can.collect && r.status !== 'CANCELLED' && (
                          <button
                            className="text-button warning"
                            aria-label={`Cancel receipt ${r.receipt_no}`}
                            onClick={() => {
                              setDialogError('');
                              setScrapping({ kind: 'receipt', row: r });
                            }}
                          >
                            Cancel
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* ---------- Sales ---------- */}
          <section className="panel">
            <div className="panel-heading">
              <h2>What it buys</h2>
            </div>
            <div className="tiles">
              <div className="tile">
                <span className="tile-value">{rupees(data.sales.thisMonth.amount)}</span>
                <span className="tile-label">{data.sales.thisMonth.month}</span>
              </div>
              <div className="tile">
                <span className="tile-value">
                  {data.sales.lastMonth ? rupees(data.sales.lastMonth.amount) : '—'}
                </span>
                <span className="tile-label">{data.sales.lastMonth?.month ?? 'Last month'}</span>
              </div>
              <div className="tile">
                <span className="tile-value">
                  {data.sales.growthPct === null ? '—' : data.sales.growthPct + '%'}
                </span>
                <span className="tile-label">Growth</span>
              </div>
              <div className="tile">
                <span className="tile-value">{rupees(data.sales.financialYear.amount)}</span>
                <span className="tile-label">Year from {data.sales.financialYear.from}</span>
              </div>
            </div>
            {data.sales.topItems.length === 0 ? (
              <p className="hint">Nothing has been billed to this shop yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Units</th>
                    <th className="num">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sales.topItems.map((i: any) => (
                    <tr key={i.item_id}>
                      <td>
                        {i.code} · {i.name}
                      </td>
                      <td className="num">{count(i.units)}</td>
                      <td className="num">{rupees(i.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* ---------- History ---------- */}
          <section className="panel">
            <div className="panel-heading">
              <h2>History</h2>
              <span className="badge">{data.timeline.length}</span>
            </div>
            {data.timeline.length === 0 ? (
              <p role="status">Nothing has happened at this shop yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>What</th>
                    <th>Reference</th>
                    <th>Detail</th>
                    <th>Who</th>
                  </tr>
                </thead>
                <tbody>
                  {data.timeline.map((e: any) => (
                    <tr key={e.kind + e.record_id}>
                      <td>{stamp(e.at)}</td>
                      <td>{TIMELINE_LABEL[e.kind] ?? e.kind}</td>
                      <td>{e.ref || '—'}</td>
                      <td>{e.what}</td>
                      <td>{e.who || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {data && dialog === 'terms' && (
        <TermsDialog
          csrf={csrf}
          customer={c}
          error={dialogError}
          onError={setDialogError}
          onSaved={done}
          onClose={() => setDialog('')}
        />
      )}
      {data && dialog === 'kyc' && (
        <KycUploadDialog
          csrf={csrf}
          customer={c}
          rows={data.kyc.rows}
          error={dialogError}
          onError={setDialogError}
          onSaved={done}
          onClose={() => setDialog('')}
        />
      )}
      {data && dialog === 'bill' && (
        <RecordBillDialog
          csrf={csrf}
          customer={c}
          error={dialogError}
          onError={setDialogError}
          onSaved={done}
          onClose={() => setDialog('')}
        />
      )}
      {data && dialog === 'collect' && (
        <CollectDialog
          csrf={csrf}
          customer={c}
          bills={owing.open}
          error={dialogError}
          onError={setDialogError}
          onSaved={done}
          onClose={() => setDialog('')}
        />
      )}
      {scrapping && (
        <ReasonDialog
          title={
            scrapping.kind === 'invoice'
              ? `Cancel bill ${scrapping.row.invoice_no}`
              : `Cancel receipt ${scrapping.row.receipt_no}`
          }
          prompt={
            scrapping.kind === 'invoice'
              ? 'The bill stops being owed. Its number stays used — that is what a gapless series means.'
              : 'The money stops counting as collected, so the bill it settled is owed again.'
          }
          confirmLabel="Cancel it"
          busy={busy}
          error={dialogError}
          onConfirm={scrap}
          onClose={() => {
            setScrapping(null);
            setDialogError('');
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The dialogs Customer 360 opens
// ---------------------------------------------------------------------------

// A blank box here hands the question back to the customer type. That is a different instruction
// from a limit of zero, so the form keeps the two apart instead of helpfully filling one in.
function TermsDialog({
  csrf,
  customer,
  error,
  onError,
  onSaved,
  onClose,
}: {
  csrf: string;
  customer: any;
  error: string;
  onError: (message: string) => void;
  onSaved: (message: string) => void;
  onClose: () => void;
}) {
  const call = useApi(csrf);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [form, setForm] = useState({
    credit_limit: customer.terms.credit_limit ?? '',
    credit_days: customer.terms.credit_days ?? '',
    hold_days: customer.terms.hold_days ?? '',
  });

  function save() {
    setBusy(true);
    onError('');
    setFieldErrors({});
    call(`reach/trade/customer/${customer.id}/terms`, 'PUT', {
      credit_limit: orNull(String(form.credit_limit)),
      credit_days: orNull(String(form.credit_days)),
      hold_days: orNull(String(form.hold_days)),
      version: customer.version,
    })
      .then((d) => onSaved(d.message))
      .catch((e) => {
        onError(e.fields?.length ? 'Fix the highlighted fields and save again.' : e.message);
        setFieldErrors(Object.fromEntries((e.fields ?? []).map((f: any) => [f.column, f.message])));
      })
      .finally(() => setBusy(false));
  }

  const box = (key: 'credit_limit' | 'credit_days' | 'hold_days', label: string, help: string) => (
    <label>
      {label}
      <input
        value={String((form as any)[key])}
        inputMode="decimal"
        disabled={busy}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
      <span className="hint">{help}</span>
      {fieldErrors[key] && <span className="field-error">{fieldErrors[key]}</span>}
    </label>
  );

  return (
    <Modal title={`Terms for ${customer.code}`} onClose={onClose}>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <p className="hint">
        Leave a box empty and this shop follows its customer type. Nought is a real answer and means
        nought.
      </p>
      {box('credit_limit', 'Credit limit', 'What may be owed at any one time.')}
      {box('credit_days', 'Credit days', 'The terms the company sells on.')}
      {box(
        'hold_days',
        'Stop selling after, days',
        'The age at which a bill puts new orders on hold. Empty means it never does.',
      )}
      <div className="modal-actions">
        <button className="button" disabled={busy} onClick={onClose}>
          Close
        </button>
        <button className="button primary" disabled={busy} onClick={save}>
          Save terms
        </button>
      </div>
    </Modal>
  );
}

// Uploading is a separate act from deciding. A rejected document is re-uploaded here and waits
// for somebody with the right to look at it again.
function KycUploadDialog({
  csrf,
  customer,
  rows,
  error,
  onError,
  onSaved,
  onClose,
}: {
  csrf: string;
  customer: any;
  rows: any[];
  error: string;
  onError: (message: string) => void;
  onSaved: (message: string) => void;
  onClose: () => void;
}) {
  const call = useApi(csrf);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [fileId, setFileId] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [form, setForm] = useState({
    kyc_type_id: rows[0]?.kyc_type_id ?? '',
    number: '',
    valid_to: '',
  });

  async function attach(file: File) {
    setBusy(true);
    onError('');
    try {
      const { blob, type } = await scaleDown(file);
      const r = await fetch(
        `/api/files?purpose=kyc&name=${encodeURIComponent(file.name.slice(0, 200))}`,
        { method: 'POST', headers: { 'Content-Type': type, 'X-CSRF-Token': csrf }, body: blob },
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw Error(d.error?.message || 'The scan could not be uploaded. Please retry.');
      setFileId(d.id);
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
    call(`reach/trade/customer/${customer.id}/kyc`, 'POST', {
      kyc_type_id: form.kyc_type_id,
      file_id: fileId,
      number: form.number.trim(),
      valid_to: form.valid_to || null,
    })
      .then((d) => onSaved(d.message))
      .catch((e) => {
        onError(e.fields?.length ? 'Fix the highlighted fields and save again.' : e.message);
        setFieldErrors(Object.fromEntries((e.fields ?? []).map((f: any) => [f.column, f.message])));
      })
      .finally(() => setBusy(false));
  }

  return (
    <Modal title={`Upload a document for ${customer.code}`} onClose={onClose}>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <label>
        Document
        <select
          value={form.kyc_type_id}
          disabled={busy}
          onChange={(e) => setForm({ ...form, kyc_type_id: e.target.value })}
        >
          {rows.map((r: any) => (
            <option key={r.code} value={r.kyc_type_id}>
              {r.code} · {r.name}
              {r.required ? ' (must have)' : ''}
            </option>
          ))}
        </select>
      </label>
      <label>
        Number
        <input
          value={form.number}
          disabled={busy}
          onChange={(e) => setForm({ ...form, number: e.target.value.toUpperCase() })}
        />
        <span className="hint">
          A GSTIN or a PAN is checked here by the same rule the customer form uses.
        </span>
        {fieldErrors.number && <span className="field-error">{fieldErrors.number}</span>}
      </label>
      <label>
        Valid until
        <input
          type="date"
          value={form.valid_to}
          disabled={busy}
          onChange={(e) => setForm({ ...form, valid_to: e.target.value })}
        />
        <span className="hint">Leave empty for a document that does not expire.</span>
      </label>
      <label>
        Scan
        <input
          type="file"
          accept="image/*,application/pdf"
          disabled={busy}
          onChange={(e) => e.target.files?.[0] && attach(e.target.files[0])}
        />
        <span className="hint">
          {fileId ? `Attached: ${fileName}` : 'Optional. A photo is shrunk before it is sent.'}
        </span>
      </label>
      <div className="modal-actions">
        <button className="button" disabled={busy} onClick={onClose}>
          Close
        </button>
        <button className="button primary" disabled={busy || !form.kyc_type_id} onClick={save}>
          Upload
        </button>
      </div>
    </Modal>
  );
}

// A bill raised somewhere else. Its number is whatever that document says, and no series is
// touched: the two numbering authorities stay told apart for ever.
function RecordBillDialog({
  csrf,
  customer,
  error,
  onError,
  onSaved,
  onClose,
}: {
  csrf: string;
  customer: any;
  error: string;
  onError: (message: string) => void;
  onSaved: (message: string) => void;
  onClose: () => void;
}) {
  const call = useApi(csrf);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [form, setForm] = useState({
    invoice_no: '',
    invoice_date: today(),
    due_date: '',
    amount: '',
    taxable: '',
    gst: '',
    source: 'ERP',
    note: '',
  });

  function save() {
    setBusy(true);
    onError('');
    setFieldErrors({});
    call(`reach/trade/customer/${customer.id}/invoice`, 'POST', {
      invoice_no: form.invoice_no.trim(),
      invoice_date: form.invoice_date,
      due_date: form.due_date || null,
      amount: Number(form.amount),
      taxable: orNull(form.taxable),
      gst: orNull(form.gst),
      source: form.source,
      note: form.note.trim(),
    })
      .then((d) => onSaved(d.message))
      .catch((e) => {
        onError(e.fields?.length ? 'Fix the highlighted fields and save again.' : e.message);
        setFieldErrors(Object.fromEntries((e.fields ?? []).map((f: any) => [f.column, f.message])));
      })
      .finally(() => setBusy(false));
  }

  const box = (key: keyof typeof form, label: string, type = 'text', help = '') => (
    <label>
      {label}
      <input
        type={type}
        value={String(form[key])}
        inputMode={type === 'text' ? undefined : undefined}
        disabled={busy}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
      {help && <span className="hint">{help}</span>}
      {fieldErrors[key as string] && (
        <span className="field-error">{fieldErrors[key as string]}</span>
      )}
    </label>
  );

  return (
    <Modal title={`Record a bill for ${customer.code}`} onClose={onClose}>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <p className="hint">
        This records a bill that was raised somewhere else. Its number is kept exactly as that
        document has it.
      </p>
      {box('invoice_no', 'Bill number')}
      {box('invoice_date', 'Bill date', 'date')}
      {box('due_date', 'Due date', 'date', 'Leave empty to let the credit days decide.')}
      {box('amount', 'Amount')}
      {box('taxable', 'Taxable value', 'text', 'Optional. Left empty when the document is silent.')}
      {box('gst', 'GST', 'text', 'Optional.')}
      <label>
        Where it came from
        <select
          value={form.source}
          disabled={busy}
          onChange={(e) => setForm({ ...form, source: e.target.value })}
        >
          {INVOICE_SOURCES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {box('note', 'Note')}
      <div className="modal-actions">
        <button className="button" disabled={busy} onClick={onClose}>
          Close
        </button>
        <button
          className="button primary"
          disabled={busy || !form.invoice_no.trim() || !form.amount}
          onClick={save}
        >
          Record the bill
        </button>
      </div>
    </Modal>
  );
}

// Money taken at the counter. It is recorded against one bill, or on account, and the screen
// reads the outstanding again afterwards so the rep sees the effect rather than trusting it.
function CollectDialog({
  csrf,
  customer,
  bills,
  error,
  onError,
  onSaved,
  onClose,
}: {
  csrf: string;
  customer: any;
  bills: any[];
  error: string;
  onError: (message: string) => void;
  onSaved: (message: string) => void;
  onClose: () => void;
}) {
  const call = useApi(csrf);
  const { place, asking, problem, ask } = useLocation();
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [fileId, setFileId] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [form, setForm] = useState({
    amount: '',
    mode: 'CASH',
    reference: '',
    invoice_id: '',
    received_on: today(),
    note: '',
  });
  const needsReference = MODES_NEEDING_REFERENCE.includes(form.mode);

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
      if (!r.ok) throw Error(d.error?.message || 'The proof could not be uploaded. Please retry.');
      setFileId(d.id);
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
    call(`reach/trade/customer/${customer.id}/receipt`, 'POST', {
      amount: Number(form.amount),
      mode: form.mode,
      reference: form.reference.trim(),
      invoice_id: form.invoice_id || null,
      received_on: form.received_on,
      file_id: fileId,
      latitude: place?.latitude ?? null,
      longitude: place?.longitude ?? null,
      note: form.note.trim(),
    })
      .then((d) => onSaved(d.message))
      .catch((e) => {
        onError(e.fields?.length ? 'Fix the highlighted fields and save again.' : e.message);
        setFieldErrors(Object.fromEntries((e.fields ?? []).map((f: any) => [f.column, f.message])));
      })
      .finally(() => setBusy(false));
  }

  return (
    <Modal title={`Collect from ${customer.code}`} onClose={onClose}>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <label>
        Amount
        <input
          value={form.amount}
          inputMode="decimal"
          disabled={busy}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
        />
        {fieldErrors.amount && <span className="field-error">{fieldErrors.amount}</span>}
      </label>
      <label>
        How
        <select
          value={form.mode}
          disabled={busy}
          onChange={(e) => setForm({ ...form, mode: e.target.value })}
        >
          {PAYMENT_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <label>
        Reference{needsReference ? ' *' : ''}
        <input
          value={form.reference}
          disabled={busy}
          onChange={(e) => setForm({ ...form, reference: e.target.value })}
        />
        <span className="hint">
          {needsReference
            ? 'A cheque or a transfer needs its number, or it cannot be traced to a bank line.'
            : 'Optional for cash.'}
        </span>
        {fieldErrors.reference && <span className="field-error">{fieldErrors.reference}</span>}
      </label>
      <label>
        Against
        <select
          value={form.invoice_id}
          disabled={busy}
          onChange={(e) => setForm({ ...form, invoice_id: e.target.value })}
        >
          <option value="">On account — oldest bill first</option>
          {bills.map((b: any) => (
            <option key={b.id} value={b.id}>
              {b.invoice_no} · {rupees(b.outstanding)} owed
            </option>
          ))}
        </select>
      </label>
      <label>
        Received on
        <input
          type="date"
          value={form.received_on}
          disabled={busy}
          onChange={(e) => setForm({ ...form, received_on: e.target.value })}
        />
        {fieldErrors.received_on && <span className="field-error">{fieldErrors.received_on}</span>}
      </label>
      <label>
        Proof
        <input
          type="file"
          accept="image/*,application/pdf"
          disabled={busy}
          onChange={(e) => e.target.files?.[0] && attach(e.target.files[0])}
        />
        <span className="hint">{fileId ? `Attached: ${fileName}` : 'Optional.'}</span>
      </label>
      <label>
        Note
        <input
          value={form.note}
          disabled={busy}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
        />
      </label>
      <p className="hint">
        {place
          ? `Location attached: ${place.latitude}, ${place.longitude}.`
          : 'A location is optional, and the collection is recorded with or without one.'}
      </p>
      {problem && <p className="field-error">{problem}</p>}
      <div className="modal-actions">
        <button className="button" disabled={busy || asking} onClick={ask}>
          {asking ? 'Reading location…' : 'Attach my location'}
        </button>
        <button className="button" disabled={busy} onClick={onClose}>
          Close
        </button>
        <button
          className="button primary"
          disabled={busy || !form.amount || (needsReference && !form.reference.trim())}
          onClick={save}
        >
          Record the collection
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Taking an order
// ---------------------------------------------------------------------------

// What this screen may offer is read from the signed-in person's rights as the API reports them,
// not from the list the shell holds, so the button and the route it calls can never disagree.
export function TakeOrder({ csrf, refreshKey }: { csrf: string; refreshKey: number }) {
  const call = useApi(csrf);
  const [picked, setPicked] = useState<any>(null);
  const [price, setPrice] = useState<any>(null);
  const [filter, setFilter] = useState('');
  const [basket, setBasket] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<any>(null);
  const [placed, setPlaced] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const customerId = picked?.id ?? null;

  useEffect(() => {
    if (!customerId) return;
    let live = true;
    setError('');
    setPrice(null);
    call(`reach/trade/customer/${customerId}/price`)
      .then((d) => live && setPrice(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [customerId, refreshKey]);

  // What the basket is, as the API wants it: only the lines somebody actually typed a number on.
  const lines = useMemo(
    () =>
      Object.entries(basket)
        .filter(([, units]) => Number(units) > 0)
        .map(([item_id, units]) => ({ item_id, units: Number(units) })),
    [basket],
  );

  const shown = useMemo(() => {
    if (!price) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return price.items;
    return price.items.filter(
      (i: any) =>
        String(i.item).toLowerCase().includes(needle) ||
        String(i.item_name).toLowerCase().includes(needle),
    );
  }, [price, filter]);

  function ask(path: string, after: (d: any) => void) {
    setBusy(true);
    setError('');
    call(`reach/trade/customer/${customerId}/${path}`, 'POST', { lines })
      .then(after)
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }

  function restart() {
    setBasket({});
    setQuote(null);
    setPlaced(null);
    setError('');
  }

  if (!customerId)
    return (
      <CustomerPicker
        csrf={csrf}
        heading="Take an order"
        refreshKey={refreshKey}
        onPick={(c) => {
          restart();
          setPicked(c);
        }}
      />
    );

  return (
    <>
      <div className="toolbar">
        <button
          className="button"
          onClick={() => {
            setPicked(null);
            setPrice(null);
            restart();
          }}
        >
          Another customer
        </button>
        <span className="hint">
          {picked.code} · {picked.name} · {picked.type_name}
        </span>
      </div>
      <Banner error={error} />
      {!price && !error && <p role="status">Reading this type&rsquo;s price list…</p>}

      {placed && (
        <section className="panel">
          <div className="panel-heading">
            <h2>Order {placed.order_no}</h2>
            <span className={'status-pill ' + (ORDER_PILL[placed.status] ?? '')}>
              {placed.status === 'HELD' ? 'Held' : 'Placed'}
            </span>
          </div>
          <div className={placed.status === 'HELD' ? 'error' : 'notice'} role="status">
            {placed.message}
          </div>
          {placed.status === 'HELD' && (
            <p className="hint">
              The order is recorded, not refused. Somebody with the right to release holds can let
              it through with a reason, or it clears by itself when the reason does.
            </p>
          )}
          <button className="button primary" onClick={restart}>
            Take another order
          </button>
        </section>
      )}

      {price && !placed && (
        <>
          <section className="panel">
            <div className="panel-heading">
              <h2>Price list for {picked.type_name}</h2>
              <span className="badge">{price.items.length}</span>
            </div>
            {price.items.length === 0 ? (
              <div className="empty">
                <strong>No price is set for this customer type today.</strong>
                <p>
                  Add rows to the Price list master under Customer setup. Without a rate an order
                  cannot be priced, so none can be taken.
                </p>
              </div>
            ) : (
              <>
                <div className="filters">
                  <label>
                    Find an item
                    <input
                      value={filter}
                      placeholder="Code or name"
                      onChange={(e) => setFilter(e.target.value)}
                    />
                  </label>
                  <span className="hint">Rates as at {price.date}.</span>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="num">Rate</th>
                      <th className="num">GST %</th>
                      <th className="num">Quantity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((i: any) => (
                      <tr key={i.item_id}>
                        <td>
                          {i.item} · {i.item_name}
                        </td>
                        <td className="num">{Number(i.rate).toFixed(4)}</td>
                        <td className="num">{Number(i.gst_pct ?? 0).toFixed(2)}</td>
                        <td className="num">
                          <input
                            className="qty"
                            aria-label={`Quantity of ${i.item}`}
                            inputMode="decimal"
                            value={basket[i.item_id] ?? ''}
                            onChange={(e) => {
                              setQuote(null);
                              setBasket({ ...basket, [i.item_id]: e.target.value });
                            }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>

          <section className="panel">
            <div className="panel-heading">
              <h2>The basket</h2>
              <span className="badge">{lines.length}</span>
              <button
                className="button"
                disabled={busy || !lines.length}
                onClick={() => ask('quote', setQuote)}
              >
                Price it
              </button>
              <button
                className="button primary"
                disabled={busy || !lines.length}
                onClick={() => ask('order', setPlaced)}
              >
                Place the order
              </button>
            </div>

            {!lines.length && <p role="status">Type a quantity against an item above.</p>}

            {quote && (
              <>
                <div className={quote.credit.hold ? 'error' : 'notice'} role="status">
                  {quote.credit.message}
                  {quote.credit.hold ? ' The order would be taken and held.' : ''}
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="num">Units</th>
                      <th className="num">Rate</th>
                      <th className="num">Gross</th>
                      <th className="num">Discount</th>
                      <th className="num">Free</th>
                      <th className="num">Taxable</th>
                      <th className="num">GST</th>
                      <th className="num">Total</th>
                      <th>Scheme</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quote.lines.map((l: any) => (
                      <tr key={l.item_id}>
                        <td>
                          {l.item} · {l.item_name}
                        </td>
                        <td className="num">{count(l.units)}</td>
                        <td className="num">{Number(l.rate).toFixed(4)}</td>
                        <td className="num">{rupees(l.gross)}</td>
                        <td className="num">{rupees(l.discount)}</td>
                        <td className="num">{count(l.free_units)}</td>
                        <td className="num">{rupees(l.taxable)}</td>
                        <td className="num">{rupees(l.gst)}</td>
                        <td className="num">{rupees(l.total)}</td>
                        <td>{l.scheme || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th>Totals</th>
                      <th className="num">{count(quote.totals.units)}</th>
                      <th />
                      <th className="num">{rupees(quote.totals.gross)}</th>
                      <th className="num">{rupees(quote.totals.discount)}</th>
                      <th className="num">{count(quote.totals.free_units)}</th>
                      <th className="num">{rupees(quote.totals.taxable)}</th>
                      <th className="num">{rupees(quote.totals.gst)}</th>
                      <th className="num">{rupees(quote.totals.total)}</th>
                      <th />
                    </tr>
                  </tfoot>
                </table>
                <p className="hint">
                  Free units are given, not billed. Paperwork reads{' '}
                  {KYC_LABEL[quote.kyc] ?? quote.kyc}.
                </p>
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The order book
// ---------------------------------------------------------------------------

export function OrderList({
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
  const [status, setStatus] = useState('');
  const [rep, setRep] = useState('');
  const [reps, setReps] = useState<any[]>([]);
  const [data, setData] = useState<any>(null);
  const [open, setOpen] = useState<any>(null);
  const [acting, setActing] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);

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
    const query = `from=${from}&to=${to}${status ? '&status=' + status : ''}${rep ? '&rep=' + rep : ''}`;
    call(`reach/trade/orders?${query}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [from, to, status, rep, revision, refreshKey]);

  function reload(message: string) {
    setNotice(message);
    setActing('');
    setDialogError('');
    setOpen(null);
    setRevision((x) => x + 1);
  }

  function act(path: string, method: string, payload: unknown) {
    setBusy(true);
    setDialogError('');
    call(path, method, payload)
      .then((d) => reload(d.message))
      .catch((e) => setDialogError(e.message))
      .finally(() => setBusy(false));
  }

  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <h2>Orders</h2>
          {data && <span className="badge">{data.total}</span>}
          {data && <span className="badge">{rupees(data.value)}</span>}
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
              {ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          {canReadAll && (
            <label>
              Rep
              <select value={rep} onChange={(e) => setRep(e.target.value)}>
                <option value="">Everyone</option>
                {reps.map((r: any) => (
                  <option key={r.id} value={r.id}>
                    {r.code} · {r.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <Banner error={error} notice={notice} />
        {!data && !error && <p role="status">Reading the order book…</p>}

        {data && data.items.length === 0 && <p role="status">No order in this window.</p>}

        {data && data.items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Date</th>
                <th>Customer</th>
                <th>Rep</th>
                <th className="num">Total</th>
                <th>Status</th>
                <th>Why held</th>
                <th className="actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((o: any) => (
                <tr key={o.id} data-status={o.status}>
                  <td>{o.order_no}</td>
                  <td>{o.order_date}</td>
                  <td>
                    {o.customer} · {o.customer_name}
                  </td>
                  <td>{o.rep || '—'}</td>
                  <td className="num">{rupees(o.total)}</td>
                  <td>
                    <span className={'status-pill ' + (ORDER_PILL[o.status] ?? '')}>
                      {o.status}
                    </span>
                  </td>
                  <td>{o.hold_reasons.length ? o.hold_reasons.join(', ') : '—'}</td>
                  <td className="actions">
                    <button
                      className="text-button"
                      aria-label={`Open order ${o.order_no}`}
                      onClick={() => {
                        setDialogError('');
                        call(`reach/trade/orders/${o.id}`)
                          .then(setOpen)
                          .catch((e) => setError(e.message));
                      }}
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
        <Modal title={`Order ${open.order_no}`} onClose={() => setOpen(null)}>
          {dialogError && (
            <div className="error" role="alert">
              {dialogError}
            </div>
          )}
          <p className="hint">
            {open.customer} · {open.customer_name} · {open.order_date} · rep {open.rep || '—'} ·
            route {open.route}
            {open.external_ref ? ` · reference ${open.external_ref}` : ''}
          </p>
          {open.status === 'HELD' && (
            <div className="error" role="status">
              Held for: {open.hold_reasons.join(', ') || 'a reason no longer recorded'}.
            </div>
          )}
          {open.release_reason && <p className="hint">Released because: {open.release_reason}</p>}
          {open.billed && (
            <p className="hint">
              Billed as {open.billed.invoice_no} ({open.billed.status}).
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Units</th>
                <th className="num">Rate</th>
                <th className="num">Free</th>
                <th className="num">Taxable</th>
                <th className="num">GST</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {open.lines.map((l: any) => (
                <tr key={l.line_no}>
                  <td>
                    {l.item} · {l.item_name}
                  </td>
                  <td className="num">{count(l.units)}</td>
                  <td className="num">{Number(l.rate).toFixed(4)}</td>
                  <td className="num">{count(l.free_units)}</td>
                  <td className="num">{rupees(l.taxable)}</td>
                  <td className="num">{rupees(l.gst)}</td>
                  <td className="num">{rupees(l.total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>Totals</th>
                <th />
                <th />
                <th />
                <th className="num">{rupees(open.taxable)}</th>
                <th className="num">{rupees(open.gst)}</th>
                <th className="num">{rupees(open.total)}</th>
              </tr>
            </tfoot>
          </table>
          <div className="modal-actions">
            <button className="button" disabled={busy} onClick={() => setOpen(null)}>
              Close
            </button>
            {open.status === 'HELD' && data?.canRelease && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => setActing('release')}
              >
                Release
              </button>
            )}
            {open.status === 'PLACED' && (
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  act(`reach/trade/orders/${open.id}/route`, 'POST', {
                    external_ref: '',
                    version: open.version,
                  })
                }
              >
                Send to {open.route}
              </button>
            )}
            {data?.canInvoice && ['PLACED', 'ROUTED'].includes(open.status) && !open.billed && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => setActing('invoice')}
              >
                Raise invoice
              </button>
            )}
            {open.status !== 'CANCELLED' && (
              <button
                className="button destructive"
                disabled={busy}
                onClick={() => setActing('cancel')}
              >
                Cancel order
              </button>
            )}
          </div>
        </Modal>
      )}

      {open && acting === 'release' && (
        <ReasonDialog
          title={`Release order ${open.order_no}`}
          prompt={`Held for: ${open.hold_reasons.join(', ') || 'no reason recorded'}. Releasing it is your decision and is recorded against your name.`}
          confirmLabel="Release it"
          busy={busy}
          error={dialogError}
          onConfirm={(reason) =>
            act(`reach/trade/orders/${open.id}/release`, 'POST', {
              reason,
              version: open.version,
            })
          }
          onClose={() => setActing('')}
        />
      )}
      {open && acting === 'cancel' && (
        <ReasonDialog
          title={`Cancel order ${open.order_no}`}
          prompt="The order stops counting. It stays on the record with the reason."
          confirmLabel="Cancel it"
          busy={busy}
          error={dialogError}
          onConfirm={(reason) =>
            act(`reach/trade/orders/${open.id}/cancel`, 'PATCH', {
              reason,
              version: open.version,
            })
          }
          onClose={() => setActing('')}
        />
      )}
      {open && acting === 'invoice' && (
        <RaiseInvoiceDialog
          order={open}
          busy={busy}
          error={dialogError}
          onConfirm={(payload) => act(`reach/trade/orders/${open.id}/invoice`, 'POST', payload)}
          onClose={() => setActing('')}
        />
      )}
    </>
  );
}

// Raising a bill here takes the next number out of this module's own series, which restarts each
// financial year. Cancelling one later does not give the number back.
function RaiseInvoiceDialog({
  order,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  order: any;
  busy: boolean;
  error: string;
  onConfirm: (payload: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    prefix: 'INV',
    invoice_date: today(),
    due_date: '',
    note: '',
  });
  return (
    <Modal title={`Raise an invoice for ${order.order_no}`} onClose={onClose}>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <p className="hint">
        {order.customer} · {rupees(order.total)}. The number comes from this system&rsquo;s own
        series and is never reused, even if the bill is cancelled afterwards.
      </p>
      <label>
        Series prefix
        <input
          value={form.prefix}
          disabled={busy}
          onChange={(e) => setForm({ ...form, prefix: e.target.value.toUpperCase() })}
        />
        <span className="hint">Letters, numbers and - _ . / — for example INV or INV/RTK.</span>
      </label>
      <label>
        Invoice date
        <input
          type="date"
          value={form.invoice_date}
          disabled={busy}
          onChange={(e) => setForm({ ...form, invoice_date: e.target.value })}
        />
      </label>
      <label>
        Due date
        <input
          type="date"
          value={form.due_date}
          disabled={busy}
          onChange={(e) => setForm({ ...form, due_date: e.target.value })}
        />
        <span className="hint">Leave empty to let the credit days decide.</span>
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
          disabled={busy || !form.prefix.trim()}
          onClick={() =>
            onConfirm({
              prefix: form.prefix.trim(),
              invoice_date: form.invoice_date,
              due_date: form.due_date || null,
              note: form.note.trim(),
            })
          }
        >
          Raise it
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// The KYC queue
// ---------------------------------------------------------------------------

export function KycQueue({
  csrf,
  permissions,
  refreshKey,
}: {
  csrf: string;
  permissions: string[];
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const canRead = permissions.includes('files.read');
  const [status, setStatus] = useState('PENDING');
  const [data, setData] = useState<any>(null);
  const [deciding, setDeciding] = useState<any>(null);
  const [verdict, setVerdict] = useState('VERIFIED');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let live = true;
    setError('');
    setData(null);
    call(`reach/trade/kyc?status=${status}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [status, revision, refreshKey]);

  function decide() {
    setBusy(true);
    setDialogError('');
    call(`reach/trade/kyc/${deciding.id}/decide`, 'POST', {
      status: verdict,
      reason: reason.trim(),
      version: deciding.version,
    })
      .then((d) => {
        setNotice(d.message);
        setDeciding(null);
        setReason('');
        setRevision((x) => x + 1);
      })
      .catch((e) => setDialogError(e.message))
      .finally(() => setBusy(false));
  }

  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <h2>Paperwork to check</h2>
          {data && <span className="badge">{data.total}</span>}
        </div>

        <div className="filters">
          <label>
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="PENDING">Waiting</option>
              <option value="VERIFIED">Verified</option>
              <option value="REJECTED">Rejected</option>
              <option value="">All</option>
            </select>
          </label>
        </div>

        <Banner error={error} notice={notice} />
        {!data && !error && <p role="status">Reading the queue…</p>}
        {data && data.items.length === 0 && (
          <p role="status">
            {status === 'PENDING' ? 'Nothing is waiting to be checked.' : 'Nothing here.'}
          </p>
        )}

        {data && data.items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Type</th>
                <th>Document</th>
                <th>Number</th>
                <th>Uploaded</th>
                <th>Status</th>
                <th>Reason</th>
                <th className="actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((d: any) => (
                <tr key={d.id}>
                  <td>
                    {d.customer} · {d.customer_name}
                  </td>
                  <td>{d.type}</td>
                  <td>
                    {d.kyc_type} · {d.kyc_type_name}
                  </td>
                  <td>{d.number || '—'}</td>
                  <td>{d.uploaded_at}</td>
                  <td>
                    <span className={'status-pill ' + (KYC_PILL[d.status] ?? '')}>
                      {KYC_LABEL[d.status] ?? d.status}
                    </span>
                  </td>
                  <td>{d.decision_reason || '—'}</td>
                  <td className="actions">
                    {d.file_id && canRead && (
                      <a
                        className="text-button"
                        href={`/api/files/${d.file_id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Scan
                      </a>
                    )}
                    {data.canDecide && d.status === 'PENDING' && (
                      <button
                        className="text-button"
                        aria-label={`Decide ${d.kyc_type} for ${d.customer}`}
                        onClick={() => {
                          setDialogError('');
                          setVerdict('VERIFIED');
                          setReason('');
                          setDeciding(d);
                        }}
                      >
                        Decide
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">
          A verified document is not a stored verdict about the customer. Whether its paperwork is
          in order is worked out from what its type asks for every time anything reads it, so an
          order held for KYC clears the moment the last document here is verified.
        </p>
      </section>

      {deciding && (
        <Modal
          title={`${deciding.kyc_type} for ${deciding.customer}`}
          onClose={() => setDeciding(null)}
        >
          {dialogError && (
            <div className="error" role="alert">
              {dialogError}
            </div>
          )}
          <p className="hint">
            {deciding.customer_name} · number {deciding.number || 'not given'} · uploaded{' '}
            {deciding.uploaded_at}
          </p>
          <label>
            Decision
            <select value={verdict} disabled={busy} onChange={(e) => setVerdict(e.target.value)}>
              <option value="VERIFIED">Verified</option>
              <option value="REJECTED">Rejected</option>
            </select>
          </label>
          <label>
            Reason{verdict === 'REJECTED' ? ' *' : ''}
            <textarea
              rows={3}
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
            />
            <span className="hint">
              {verdict === 'REJECTED'
                ? 'A rejection has to say why, so the shop knows what to send again.'
                : 'Optional.'}
            </span>
          </label>
          <div className="modal-actions">
            <button className="button" disabled={busy} onClick={() => setDeciding(null)}>
              Close
            </button>
            <button
              className="button primary"
              disabled={busy || (verdict === 'REJECTED' && !reason.trim())}
              onClick={decide}
            >
              Save the decision
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function TradeSetup({
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
  const canInvoice = permissions.includes('reach.invoice');
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
    call('reach/trade/settings', 'PUT', {
      ageing_buckets: String(form.ageing_buckets).trim(),
      fy_start_month: Number(form.fy_start_month),
      dso_window_days: Number(form.dso_window_days),
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

  if (error && !form)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!form) return <p role="status">Loading Customer 360 settings…</p>;

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Customer 360 settings</h2>
      </div>
      <Banner error={error} notice={notice} />

      <label>
        Ageing buckets
        <input
          value={form.ageing_buckets}
          disabled={busy || !canEdit}
          onChange={(e) => setForm({ ...form, ageing_buckets: e.target.value })}
        />
        <span className="hint">
          Days separated by commas, each larger than the one before — 30,60,90 reads as 0-30, 31-60,
          61-90 and 91 and over.
        </span>
        {fieldErrors.ageing_buckets && (
          <span className="field-error">{fieldErrors.ageing_buckets}</span>
        )}
      </label>

      <label>
        Financial year starts in month
        <input
          value={form.fy_start_month}
          inputMode="numeric"
          disabled={busy || !canEdit}
          onChange={(e) => setForm({ ...form, fy_start_month: e.target.value })}
        />
        <span className="hint">
          4 for April, which is the Indian financial year. The invoice series restarts with it.
        </span>
        {fieldErrors.fy_start_month && (
          <span className="field-error">{fieldErrors.fy_start_month}</span>
        )}
      </label>

      <label>
        DSO window in days
        <input
          value={form.dso_window_days}
          inputMode="numeric"
          disabled={busy || !canEdit}
          onChange={(e) => setForm({ ...form, dso_window_days: e.target.value })}
        />
        <span className="hint">
          How far back sales are counted when working out how many days&rsquo; selling is tied up in
          what is owed.
        </span>
        {fieldErrors.dso_window_days && (
          <span className="field-error">{fieldErrors.dso_window_days}</span>
        )}
      </label>

      <p className="hint">
        A credit limit is not set here: it belongs to the customer type, under Customer types, and
        one shop may be given its own on its Customer 360 screen. What a document check asks for
        belongs to KYC documents and KYC by type; what an item costs belongs to the Price list and
        Schemes.
      </p>

      <p className="hint">
        {canInvoice
          ? 'Your login may raise invoices from this system, so an order can be billed here and gets a number from this system’s own series.'
          : 'No invoice can be raised from this system with your login. Bills raised elsewhere are recorded against a customer by anyone holding the invoice right.'}{' '}
        Which of the two a company does is decided by the <code>reach.invoice</code> permission
        alone — there is no setting here to change and nothing to deploy.
      </p>

      {canEdit && (
        <button className="button primary" disabled={busy} onClick={save}>
          Save Customer 360 settings
        </button>
      )}
    </section>
  );
}
