// RCH-7: one place that says what the field force is doing, what is waiting for somebody, what
// the system has noticed, and whether the company is ready to run on this.
//
// Two things on these screens are worth knowing before changing them.
//
// **A tile is a link, not a summary.** Every number here is the count of a list somebody can open
// and work through. They are the same count — read in the same request from the same query — so
// a tile and the screen it sends you to can never disagree about how much there is to do.
//
// **A proposal is never a button that does the thing.** It is a sentence about what was noticed,
// why it matters, and where a person goes to decide. The system has no way to act on one; the
// API has no route that would let it. "Go there" is the only action a proposal offers.
import { useEffect, useState } from 'react';
import { useApi } from './api-client';

const SEVERITY_LABEL: Record<string, string> = {
  DECIDE: 'Waiting for a decision',
  WARN: 'Worth acting on',
  WATCH: 'Worth a look',
};
const SEVERITY_PILL: Record<string, string> = {
  DECIDE: 'pending',
  WARN: 'missing',
  WATCH: 'off',
};

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = (d: string) => d.slice(0, 8) + '01';
const rupees = (v: unknown) =>
  v === null || v === undefined
    ? '—'
    : Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const stamp = (at: string | null) => (at ? new Date(at).toLocaleString() : '—');

// One proposal. It says what, how many, why it matters, and where to go — and nothing else,
// because there is nothing else it is allowed to do.
function ProposalRow({ row, onGo }: { row: any; onGo?: (tab: string) => void }) {
  return (
    <div className="check-row readiness-row" data-status={row.severity}>
      <span className={'status-pill ' + (SEVERITY_PILL[row.severity] ?? '')}>{row.count}</span>
      <div>
        <strong>{row.title}</strong>
        <p>{row.why}</p>
        <span className="hint">
          {row.module} → {row.screen}
        </span>
      </div>
      {onGo && (
        <button
          className="button"
          aria-label={`Go to ${row.screen} for ${row.title}`}
          onClick={() => onGo(row.screen)}
        >
          Go there
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The overview
// ---------------------------------------------------------------------------

export function ReachOverview({
  csrf,
  refreshKey,
  onGo,
}: {
  csrf: string;
  refreshKey: number;
  onGo?: (tab: string) => void;
}) {
  const call = useApi(csrf);
  const [date, setDate] = useState(today());
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setError('');
    setData(null);
    call(`reach/overview?date=${date}`)
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
  if (!data) return <p role="status">Reading the day…</p>;

  const bySeverity = ['DECIDE', 'WARN', 'WATCH'].map((severity) => ({
    severity,
    rows: data.proposals.filter((p: any) => p.severity === severity),
  }));

  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <h2>Reach overview</h2>
          <span className="badge">{data.queue.total} waiting</span>
        </div>

        <div className="filters">
          <label>
            Date
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>

        <div className="tiles">
          <div className="tile">
            <span className="tile-value">{data.today.started}</span>
            <span className="tile-label">Days started, of {data.today.reps}</span>
          </div>
          <div className="tile">
            <span className="tile-value">{data.today.still_out}</span>
            <span className="tile-label">Not ended yet</span>
          </div>
          <div className="tile">
            <span className="tile-value">{data.today.visits}</span>
            <span className="tile-label">Calls made</span>
          </div>
          <div className="tile">
            <span className="tile-value">{data.today.in_a_shop}</span>
            <span className="tile-label">In a shop now</span>
          </div>
          <div className="tile">
            <span className="tile-value">{data.today.orders}</span>
            <span className="tile-label">Orders taken</span>
          </div>
          <div className="tile">
            <span className="tile-value">{rupees(data.today.order_value)}</span>
            <span className="tile-label">Ordered</span>
          </div>
          <div className="tile">
            <span className="tile-value">{rupees(data.today.collected)}</span>
            <span className="tile-label">Collected</span>
          </div>
          <div className="tile">
            <span className="tile-value">{data.queue.total}</span>
            <span className="tile-label">Waiting for a decision</span>
          </div>
        </div>

        <p className="hint">
          Every number here is the size of a list somebody can open. Nothing on this screen is
          stored — it is counted from the same records the screens underneath it show, so a tile and
          the list it sends you to cannot drift apart.
        </p>
      </section>

      {data.proposals.length === 0 ? (
        <section className="panel">
          <div className="empty">
            <strong>Nothing is waiting, and nothing looks wrong.</strong>
            <p>
              The system says nothing when there is nothing to say. This is the whole of what it
              watches for: attendance nobody started, plans not sent in or not approved, check-ins
              away from the shop, reports left unfinished, customers and locations waiting for
              approval, KYC waiting to be checked, orders on hold, shops owing past their terms, and
              expense claims waiting at a desk.
            </p>
          </div>
        </section>
      ) : (
        bySeverity
          .filter((group) => group.rows.length)
          .map((group) => (
            <section className="panel" key={group.severity}>
              <div className="panel-heading">
                <h2>{SEVERITY_LABEL[group.severity]}</h2>
                <span className="badge">
                  {group.rows.reduce((sum: number, r: any) => sum + r.count, 0)}
                </span>
              </div>
              {group.rows.map((row: any) => (
                <ProposalRow key={row.code} row={row} onGo={onGo} />
              ))}
            </section>
          ))
      )}

      <section className="panel">
        <p className="hint">
          The system proposes; a person decides. Nothing on this screen has changed anything, and
          nothing on it can: there is no route behind any of these rows that writes. What is shown
          to you is also filtered by what you may actually do — a proposal pointing at a screen you
          cannot open would only be noise.
        </p>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// One queue for the whole module
// ---------------------------------------------------------------------------

export function ReachQueue({
  csrf,
  refreshKey,
  onGo,
}: {
  csrf: string;
  refreshKey: number;
  onGo?: (tab: string) => void;
}) {
  const call = useApi(csrf);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setError('');
    setData(null);
    call('reach/overview/queue')
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [refreshKey]);

  if (error)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!data) return <p role="status">Reading what is waiting…</p>;

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Waiting for a decision</h2>
        <span className="badge">{data.total}</span>
      </div>

      {data.rows.length === 0 ? (
        <div className="empty">
          <strong>Nothing is waiting for you.</strong>
          <p>
            Everything you have the right to decide has been decided. Somebody else may still have
            something of their own waiting.
          </p>
        </div>
      ) : (
        <>
          <p className="hint">
            Every module used to keep its own queue. This is all of them in one place, oldest
            problem first by how loudly it is asking — {data.modules.join(', ')}.
          </p>
          {data.rows.map((row: any) => (
            <ProposalRow key={row.code} row={row} onGo={onGo} />
          ))}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Going live
// ---------------------------------------------------------------------------

export function ReachCutover({ csrf, refreshKey }: { csrf: string; refreshKey: number }) {
  const call = useApi(csrf);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setError('');
    call('reach/overview/cutover')
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [refreshKey]);

  if (error)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!data) return <p role="status">Checking what is loaded…</p>;

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Going live</h2>
        <span className="badge">
          {data.done} / {data.total} ready
        </span>
      </div>

      <div className={data.ready ? 'notice' : 'error'} role="status">
        {data.ready
          ? 'Everything a company needs before Reach can carry real work is loaded.'
          : `Not ready yet: ${data.blockers.join('; ')}.`}
      </div>

      {data.steps.map((step: any) => (
        <div className="check-row readiness-row" key={step.key} data-status={step.status}>
          <span className={'status-pill ' + (step.status === 'ready' ? 'ready' : 'missing')}>
            {step.status === 'ready' ? 'Ready' : step.blocking ? 'Needed' : 'Optional'}
          </span>
          <div>
            <strong>{step.title}</strong>
            <p>{step.detail}</p>
          </div>
        </div>
      ))}

      <p className="hint">
        Each line is read from the data itself, never from somebody ticking a box. The
        client&rsquo;s own records come in through the same file import every other master uses —
        map the columns, reconcile what is already there, then commit — so going live is loading the
        last of it and watching these lines turn.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The whole module's audit trail
// ---------------------------------------------------------------------------

export function ReachAudit({ csrf, refreshKey }: { csrf: string; refreshKey: number }) {
  const call = useApi(csrf);
  const [from, setFrom] = useState(monthStart(today()));
  const [to, setTo] = useState(today());
  const [action, setAction] = useState('');
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setError('');
    setData(null);
    call(`reach/overview/audit?from=${from}&to=${to}${action ? '&action=' + action : ''}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [from, to, action, refreshKey]);

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Reach audit trail</h2>
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
          What happened
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">Everything</option>
            {(data?.kinds ?? []).map((k: any) => (
              <option key={k.action} value={k.action}>
                {k.action} ({k.n})
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {!data && !error && <p role="status">Reading the trail…</p>}

      {data && data.items.length === 0 && <p role="status">Nothing was recorded in this window.</p>}

      {data && data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>What</th>
              <th>Against</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((row: any) => (
              <tr key={row.id}>
                <td>{stamp(row.created_at)}</td>
                <td>{row.actor || '—'}</td>
                <td>{row.action}</td>
                <td>{row.entity_type}</td>
                <td className="hint">
                  {row.details ? JSON.stringify(row.details).slice(0, 160) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="hint">
        This is a window onto the one audit record the whole system keeps, not a second trail of
        Reach&rsquo;s own. There is only ever one answer to what happened.
      </p>
    </section>
  );
}
