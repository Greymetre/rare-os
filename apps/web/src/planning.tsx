import { LeadTimeReality } from './schedule';
import { useEffect, useState } from 'react';
import { useApi } from './api-client';
import { Messages, useList } from './plant-model';

const num = (v: unknown, digits = 2) =>
  v === null || v === undefined || v === ''
    ? '—'
    : Number(v).toLocaleString('en-IN', { maximumFractionDigits: digits });
const ZONE_LABELS: Record<string, string> = {
  breach: 'Stock-out risk',
  red: 'Red',
  yellow: 'Yellow',
  green: 'Green',
  excess: 'Above top of green',
  missing: 'Needs data',
  not_applicable: 'Made to order',
};
const pagePath = (base: string, params: Record<string, string | null | undefined>) => {
  const q = Object.entries(params)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
    .join('&');
  return q ? `${base}?${q}` : base;
};

function Pager({
  cursors,
  next,
  setCursors,
}: {
  cursors: string[];
  next: string | null;
  setCursors: (c: string[]) => void;
}) {
  return (
    <div className="table-footer">
      <button className="button" disabled={!cursors.length} onClick={() => setCursors([])}>
        First page
      </button>
      <button className="button" disabled={!next} onClick={() => setCursors([...cursors, next!])}>
        Next page
      </button>
    </div>
  );
}

// ---------- Buffer profiles ----------

const PROFILE_BLANK = {
  code: '',
  name: '',
  red_base_pct: '50',
  red_safety_pct: '0',
  green_pct: '50',
  order_cycle_days: '',
  spike_threshold_pct: '50',
  adu_window_days: '90',
  method: 'STANDARD',
  zone_weeks: '13',
  cv_weeks: '52',
  order_multiple: '',
  moq_adu_days: '',
};

export function BufferProfiles({
  csrf,
  canManage,
  refreshKey,
}: {
  csrf: string;
  canManage: boolean;
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const [revision, setRevision] = useState(0),
    [form, setForm] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const list = useList(csrf, 'buffer-profiles', [revision, refreshKey]);
  function save() {
    setBusy(true);
    setError('');
    const payload: any = Object.fromEntries(
      Object.keys(PROFILE_BLANK)
        .filter((k) => k !== 'code')
        .map((k) => [k, String(form[k] ?? '')]),
    );
    if (form.id) Object.assign(payload, { active: form.active, version: form.version });
    else payload.code = form.code;
    call(
      form.id ? 'buffer-profiles/' + form.id : 'buffer-profiles',
      form.id ? 'PATCH' : 'POST',
      payload,
    )
      .then((d) => {
        setNotice(d.message);
        setForm(null);
        setRevision((x) => x + 1);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }
  const field = (key: string, label: string, props: any = {}) => (
    <label>
      {label}
      <input
        value={form[key] ?? ''}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        {...props}
      />
    </label>
  );
  const clean = (v: unknown) => (v === null || v === undefined ? '' : String(Number(v)));
  return (
    <>
      <Messages error={error || list.error} notice={notice} />
      {form && (
        <section className="panel company-form">
          <h2>{form.id ? `Edit profile ${form.code}` : 'New buffer profile'}</h2>
          <p className="panel-sub">
            {form.method === 'WEEKLY'
              ? 'Weekly (Nilkamal) method: yellow = mean of the last zone weeks × lead time in whole weeks. Red = yellow × red base % × (1 + safety), where safety is 30%, 50% or 70% for demand variability (CV) below 0.5, below 1.0 or above. Green = the weekly mean over the order cycle (one week if blank). Demand is read up to the latest history date.'
              : 'Yellow = average daily usage × lead time. Red = yellow × red base % × (1 + safety %). Green = the larger of yellow × green %, usage over the order cycle, and the supplier MOQ.'}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <div className="form-grid">
              {!form.id && field('code', 'Profile code *', { maxLength: 40 })}
              {field('name', 'Profile name *', { maxLength: 120 })}
              <label>
                Zone method
                <select
                  value={form.method}
                  onChange={(e) => setForm({ ...form, method: e.target.value })}
                >
                  <option value="STANDARD">Standard (daily usage)</option>
                  <option value="WEEKLY">Weekly with variability safety (Nilkamal)</option>
                </select>
              </label>
              {field('red_base_pct', 'Red base % of yellow *', { inputMode: 'decimal' })}
              {field('red_safety_pct', 'Red safety % (variability)', { inputMode: 'decimal' })}
              {field('green_pct', 'Green % of yellow *', { inputMode: 'decimal' })}
              {field('order_cycle_days', 'Order cycle (days)', { inputMode: 'numeric' })}
              {field('spike_threshold_pct', 'Spike threshold % of red', { inputMode: 'decimal' })}
              {field('adu_window_days', 'Usage window (days)', { inputMode: 'numeric' })}
              {form.method === 'WEEKLY' && (
                <>
                  {field('zone_weeks', 'Zone weeks', { inputMode: 'numeric' })}
                  {field('cv_weeks', 'Variability weeks', { inputMode: 'numeric' })}
                  {field('order_multiple', 'Order multiple (made items)', {
                    inputMode: 'decimal',
                  })}
                  {field('moq_adu_days', 'Minimum order (days of usage)', {
                    inputMode: 'decimal',
                  })}
                </>
              )}
              {form.id && (
                <label>
                  Status
                  <select
                    value={String(form.active)}
                    onChange={(e) => setForm({ ...form, active: e.target.value === 'true' })}
                  >
                    <option value="true">Active</option>
                    <option value="false">Inactive</option>
                  </select>
                </label>
              )}
            </div>
            <div className="form-actions">
              <button className="button primary" disabled={busy}>
                Save profile
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setForm(null)}
              >
                Cancel
              </button>
            </div>
          </form>
        </section>
      )}
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Buffer profiles</h2>
            <p className="panel-sub">
              How big each zone is, relative to usage over the lead time. Items share a profile.
            </p>
          </div>
          {canManage && !form && (
            <button className="button primary" onClick={() => setForm({ ...PROFILE_BLANK })}>
              Create profile
            </button>
          )}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Profile</th>
                <th>Method</th>
                <th className="num">Red base %</th>
                <th className="num">Red safety %</th>
                <th className="num">Green %</th>
                <th className="num">Order cycle</th>
                <th className="num">Spike %</th>
                <th className="num">Usage window</th>
                <th className="num">Items</th>
                <th>Status</th>
                {canManage && <th className="actions">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {list.items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.code}</strong>
                    <div className="cell-sub">{p.name}</div>
                  </td>
                  <td>
                    {p.method === 'WEEKLY' ? (
                      <>
                        Weekly
                        <div className="cell-sub">
                          {p.zone_weeks} wk zones · CV over {p.cv_weeks} wk
                          {p.order_multiple ? ` · multiple ${num(p.order_multiple)}` : ''}
                        </div>
                      </>
                    ) : (
                      'Standard'
                    )}
                  </td>
                  <td className="num">{num(p.red_base_pct)}</td>
                  <td className="num">{p.method === 'WEEKLY' ? 'by CV' : num(p.red_safety_pct)}</td>
                  <td className="num">{p.method === 'WEEKLY' ? '—' : num(p.green_pct)}</td>
                  <td className="num">{p.order_cycle_days ? p.order_cycle_days + ' d' : '—'}</td>
                  <td className="num">{num(p.spike_threshold_pct)}</td>
                  <td className="num">{p.adu_window_days} d</td>
                  <td className="num">{p.items}</td>
                  <td>
                    <span className={'status-pill ' + (p.active ? 'ok' : 'off')}>
                      {p.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  {canManage && (
                    <td className="actions">
                      <button
                        className="text-button"
                        aria-label={'Edit profile ' + p.code}
                        onClick={() =>
                          setForm({
                            ...p,
                            red_base_pct: clean(p.red_base_pct),
                            red_safety_pct: clean(p.red_safety_pct),
                            green_pct: clean(p.green_pct),
                            spike_threshold_pct: clean(p.spike_threshold_pct),
                            order_cycle_days: p.order_cycle_days ?? '',
                            order_multiple:
                              p.order_multiple === null ? '' : clean(p.order_multiple),
                            moq_adu_days: p.moq_adu_days === null ? '' : clean(p.moq_adu_days),
                          })
                        }
                      >
                        Edit
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!list.items.length && !list.busy && (
          <div className="empty">
            <strong>No buffer profiles yet.</strong>
            <p>
              Start with one profile for bought materials and one for finished goods, for example
              red 50 %, green 50 %.
            </p>
          </div>
        )}
      </section>
    </>
  );
}

// ---------- Buffer settings ----------

export function BufferSettings({
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
  const [revision, setRevision] = useState(0),
    [form, setForm] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [query, setQuery] = useState(''),
    [q, setQ] = useState(''),
    [cursors, setCursors] = useState<string[]>([]);
  const profiles = useList(csrf, 'buffer-profiles', [refreshKey]);
  const list = useList(
    csrf,
    pagePath(`plants/${plantId}/buffer-settings`, { q, cursor: cursors[cursors.length - 1] }),
    [revision, refreshKey],
  );
  const activeProfiles = profiles.items.filter((p) => p.active);
  function save() {
    setBusy(true);
    setError('');
    const payload: any = {
      policy: form.policy,
      profile: form.policy === 'BUFFER' ? form.profile : '',
      lead_time_days: String(form.lead_time_days ?? ''),
      adu_override: String(form.adu_override ?? ''),
      reference_lot: String(form.reference_lot ?? ''),
    };
    if (form.id) Object.assign(payload, { active: form.active, version: form.version });
    else payload.item = form.item;
    call(
      form.id ? 'buffer-settings/' + form.id : `plants/${plantId}/buffer-settings`,
      form.id ? 'PATCH' : 'POST',
      payload,
    )
      .then((d) => {
        setNotice(d.message);
        setForm(null);
        setRevision((x) => x + 1);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }
  return (
    <>
      <Messages error={error || list.error} notice={notice} />
      {form && (
        <section className="panel company-form">
          <h2>{form.id ? `Buffer setting for ${form.item}` : 'New buffer setting'}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <div className="form-grid">
              {!form.id && (
                <label>
                  Item code *
                  <input
                    value={form.item}
                    onChange={(e) => setForm({ ...form, item: e.target.value })}
                  />
                </label>
              )}
              <label>
                Policy
                <select
                  value={form.policy}
                  onChange={(e) => setForm({ ...form, policy: e.target.value })}
                >
                  <option value="BUFFER">Buffer (stocked)</option>
                  <option value="MTO">Made or bought to order</option>
                </select>
              </label>
              {form.policy === 'BUFFER' && (
                <label>
                  Buffer profile *
                  <select
                    value={form.profile}
                    onChange={(e) => setForm({ ...form, profile: e.target.value })}
                  >
                    <option value="">Choose a profile</option>
                    {activeProfiles.map((p) => (
                      <option key={p.id} value={p.code}>
                        {p.code} — {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Lead time (days)
                <input
                  inputMode="numeric"
                  placeholder="Blank = preferred supplier's lead time"
                  value={form.lead_time_days ?? ''}
                  onChange={(e) => setForm({ ...form, lead_time_days: e.target.value })}
                />
              </label>
              <label>
                Average daily usage override
                <input
                  inputMode="decimal"
                  placeholder="Blank = from demand history and BOMs"
                  value={form.adu_override ?? ''}
                  onChange={(e) => setForm({ ...form, adu_override: e.target.value })}
                />
              </label>
              <label>
                Reference lot (made items)
                <input
                  inputMode="decimal"
                  placeholder="Blank = 1.5 days of usage"
                  value={form.reference_lot ?? ''}
                  onChange={(e) => setForm({ ...form, reference_lot: e.target.value })}
                />
              </label>
              {form.id && (
                <label>
                  Status
                  <select
                    value={String(form.active)}
                    onChange={(e) => setForm({ ...form, active: e.target.value === 'true' })}
                  >
                    <option value="true">Active</option>
                    <option value="false">Inactive</option>
                  </select>
                </label>
              )}
            </div>
            <div className="form-actions">
              <button className="button primary" disabled={busy}>
                Save setting
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setForm(null)}
              >
                Cancel
              </button>
            </div>
          </form>
        </section>
      )}
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Buffer settings</h2>
            <p className="panel-sub">
              Which items this plant keeps in stock (buffer) and which it makes or buys only for an
              order. Import many at once from Imports → Buffer settings.
            </p>
          </div>
          {canManage && !form && (
            <button
              className="button primary"
              onClick={() =>
                setForm({
                  item: '',
                  policy: 'BUFFER',
                  profile: activeProfiles[0]?.code ?? '',
                  lead_time_days: '',
                  adu_override: '',
                  reference_lot: '',
                })
              }
            >
              Add item
            </button>
          )}
        </div>
        <div className="toolbar panel-toolbar">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setCursors([]);
              setQ(query.trim().toLowerCase());
            }}
          >
            <input
              aria-label="Buffer settings search"
              placeholder="Item code starts with…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button className="button">Search</button>
          </form>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Make / buy</th>
                <th>Policy</th>
                <th>Profile</th>
                <th className="num">Lead time</th>
                <th className="num">ADU override</th>
                <th>Status</th>
                {canManage && <th className="actions">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {list.items.map((b) => (
                <tr key={b.id}>
                  <td>
                    <strong>{b.item}</strong>
                    <div className="cell-sub">{b.item_name}</div>
                  </td>
                  <td>{b.make_buy}</td>
                  <td>
                    <span className="chip">{b.policy === 'BUFFER' ? 'Buffer' : 'To order'}</span>
                  </td>
                  <td>{b.profile ?? '—'}</td>
                  <td className="num">
                    {b.lead_time_days === null ? 'Supplier' : b.lead_time_days + ' d'}
                  </td>
                  <td className="num">{num(b.adu_override)}</td>
                  <td>
                    <span className={'status-pill ' + (b.active ? 'ok' : 'off')}>
                      {b.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  {canManage && (
                    <td className="actions">
                      <button
                        className="text-button"
                        aria-label={'Edit buffer setting ' + b.item}
                        onClick={() =>
                          setForm({
                            ...b,
                            profile: b.profile ?? '',
                            lead_time_days: b.lead_time_days ?? '',
                            adu_override:
                              b.adu_override === null ? '' : String(Number(b.adu_override)),
                            reference_lot:
                              b.reference_lot === null ? '' : String(Number(b.reference_lot)),
                          })
                        }
                      >
                        Edit
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.busy && <p role="status">Loading…</p>}
        {!list.items.length && !list.busy && (
          <div className="empty">
            <strong>
              {q ? 'No settings match this search.' : 'No buffered items in this plant.'}
            </strong>
            <p>Add the materials and products this plant keeps in stock.</p>
          </div>
        )}
        <Pager cursors={cursors} next={list.next} setCursors={setCursors} />
      </section>
    </>
  );
}

// ---------- Buffer board ----------

// Red / yellow / green bands scaled to top of green, with a marker at the net flow position.
function BufferBar({ row }: { row: any }) {
  const tog = Number(row.top_of_green);
  if (!tog) return null;
  const scale = Math.max(tog, Number(row.nfp)) * 1.05;
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / scale) * 100))}%`;
  const red = Number(row.top_of_red),
    yellow = Number(row.top_of_yellow);
  return (
    <div className="buffer-bar" aria-hidden="true">
      <span className="band red" style={{ width: pct(red) }} />
      <span className="band yellow" style={{ left: pct(red), width: pct(yellow - red) }} />
      <span className="band green" style={{ left: pct(yellow), width: pct(tog - yellow) }} />
      <span className="marker" style={{ left: pct(Number(row.nfp)) }} />
    </div>
  );
}

export function BufferBoard({
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
  const [status, setStatus] = useState<any>(null),
    [tick, setTick] = useState(0),
    [zone, setZone] = useState(''),
    [query, setQuery] = useState(''),
    [q, setQ] = useState(''),
    [cursors, setCursors] = useState<string[]>([]),
    [open, setOpen] = useState<string | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  // AV-9: a make recommendation becomes a production order in the book.
  const releaseMake = (item: string) => {
    setBusy(true);
    setError('');
    call(`plants/${plantId}/make-orders/release`, 'POST', {
      item,
      runNo: Number(status?.current?.run_no),
    })
      .then((d) => {
        setNotice(d.message);
        setTick((x) => x + 1);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const board = useList(
    csrf,
    pagePath(`plants/${plantId}/buffers`, { zone, q, cursor: cursors[cursors.length - 1] }),
    [refreshKey, status?.current?.id],
  );
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    let live = true;
    call('planning/status')
      .then((d) => live && setStatus(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [tick, refreshKey]);
  // While a recalculation is pending, check again every few seconds.
  useEffect(() => {
    if (!status || status.upToDate) return;
    const t = setTimeout(() => setTick((x) => x + 1), 3000);
    return () => clearTimeout(t);
  }, [status]);
  useEffect(() => {
    let live = true;
    call(`plants/${plantId}/buffers`)
      .then((d) => live && setCounts(d.counts))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [plantId, status?.current?.id, refreshKey]);
  function runNow() {
    setBusy(true);
    setError('');
    call('planning/runs', 'POST', {})
      .then((d) => {
        setNotice(d.message);
        setTick((x) => x + 1);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }
  const current = status?.current;
  const tiles = ['breach', 'red', 'yellow', 'green', 'excess', 'missing'];
  return (
    <>
      <Messages error={error || board.error} notice={notice} />
      <section className="panel planning-status">
        <div className="panel-heading">
          <div>
            <h2>Buffer board</h2>
            <p className="panel-sub">
              {!status
                ? 'Checking…'
                : current
                  ? `Run #${current.run_no}, calculated ${new Date(current.finished_at).toLocaleString()} for ${current.as_of}.`
                  : 'Not calculated yet.'}{' '}
              {status?.fixedDate && (
                <span className="status-pill pending">
                  Simulation: planning date fixed at {status.fixedDate}
                </span>
              )}{' '}
              {status &&
                (status.upToDate ? (
                  <span className="status-pill ok">Up to date</span>
                ) : (
                  <span className="status-pill pending" role="status">
                    {status.queued ? 'Recalculating…' : 'Data changed, recalculating shortly…'}
                  </span>
                ))}
            </p>
          </div>
          {permissions.includes('planning.run') && (
            <button className="button" disabled={busy} onClick={runNow}>
              Run now
            </button>
          )}
        </div>
        <div className="zone-tiles">
          {tiles.map((k) => (
            <button
              key={k}
              className={'zone-tile ' + k + (zone === k ? ' selected' : '')}
              aria-pressed={zone === k}
              onClick={() => {
                setCursors([]);
                setZone(zone === k ? '' : k);
              }}
            >
              <strong>{counts[k] ?? 0}</strong>
              <span>{ZONE_LABELS[k]}</span>
            </button>
          ))}
        </div>
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
              aria-label="Buffer board search"
              placeholder="Item code starts with…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button className="button">Search</button>
          </form>
          <label>
            Show
            <select
              value={zone}
              onChange={(e) => {
                setCursors([]);
                setZone(e.target.value);
              }}
            >
              <option value="">All items, most urgent first</option>
              {Object.entries(ZONE_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="table-wrap">
          <table className="board">
            <thead>
              <tr>
                <th>Item</th>
                <th>Zone</th>
                <th>Net flow vs buffer</th>
                <th className="num">Net flow</th>
                <th className="num">On hand</th>
                <th className="num">Open supply</th>
                <th className="num">Qualified demand</th>
                <th className="num">Top of green</th>
                <th>Suggested order</th>
              </tr>
            </thead>
            <tbody>
              {board.items.map((r) => {
                const key = r.item_id;
                const label = r.status === 'planned' ? r.zone : r.status;
                return [
                  <tr
                    key={key}
                    className="clickable"
                    onClick={() => setOpen(open === key ? null : key)}
                  >
                    <td>
                      <button
                        className="text-button cell-link"
                        aria-expanded={open === key}
                        aria-label={`Details for ${r.item}`}
                      >
                        <strong>{r.item}</strong>
                      </button>
                      <div className="cell-sub">
                        {r.item_name} · {r.make_buy === 'BUY' ? 'Bought' : 'Made'}
                      </div>
                    </td>
                    <td>
                      <span className={'zone-pill ' + label}>{ZONE_LABELS[label]}</span>
                      {r.on_hand_alert && (
                        <div className="cell-sub alert-text">
                          {r.on_hand_alert === 'stockout' ? 'No stock on hand' : 'On hand in red'}
                        </div>
                      )}
                    </td>
                    <td>
                      {r.status === 'planned' ? (
                        <>
                          <BufferBar row={r} />
                          <div className="cell-sub">{num(r.priority_pct, 0)}% of top of green</div>
                        </>
                      ) : (
                        <span className="cell-sub">{r.messages?.[0]}</span>
                      )}
                    </td>
                    <td className="num">
                      <strong>{num(r.nfp)}</strong>
                    </td>
                    <td className="num">{num(r.on_hand)}</td>
                    <td className="num">{num(r.open_supply)}</td>
                    <td className="num">{num(r.qualified_demand)}</td>
                    <td className="num">{num(r.top_of_green, 1)}</td>
                    <td className="nowrap">
                      {r.recommended_qty !== null ? (
                        <>
                          <strong>
                            {r.recommended_kind === 'MAKE' ? 'Make ' : 'Buy '}
                            {r.recommended_purchase_qty !== null
                              ? `${num(r.recommended_purchase_qty)} ${r.purchase_unit}`
                              : `${num(r.recommended_qty)} ${r.unit}`}
                          </strong>
                          <div className="cell-sub">
                            {r.supplier ? r.supplier + ' · ' : ''}by {r.due_date}
                          </div>
                          {r.pending_proposal_no && (
                            <div className="cell-sub proposal-flag">
                              Proposal #{r.pending_proposal_no} waiting for approval
                            </div>
                          )}
                          {r.recommended_kind === 'MAKE' &&
                            permissions.includes('production.execute') && (
                              <button
                                className="text-button"
                                disabled={busy}
                                aria-label={`Release a make order for ${r.item}`}
                                onClick={() => releaseMake(r.item)}
                              >
                                Release make order
                              </button>
                            )}
                        </>
                      ) : (
                        <span className="cell-sub">—</span>
                      )}
                    </td>
                  </tr>,
                  open === key && (
                    <tr key={key + '-detail'} className="detail-row">
                      <td colSpan={9}>
                        <dl className="facts">
                          <div>
                            <dt>Average daily usage</dt>
                            <dd>
                              {num(r.adu, 3)} {r.unit}/day
                            </dd>
                          </div>
                          <div>
                            <dt>Lead time</dt>
                            <dd>
                              {r.dlt === null ? '—' : r.dlt + ' days'}
                              {r.lead_time_factor !== null &&
                                ` · ${num(r.lead_time_live, 2)} days at planned loading (zones × ${num(r.lead_time_factor, 3)})`}
                              {r.cv !== null && r.zone_days
                                ? ` (zones on ${r.zone_days / 7} week${r.zone_days === 7 ? '' : 's'})`
                                : ''}
                            </dd>
                          </div>
                          {r.cv !== null && (
                            <div>
                              <dt>Weekly usage and variability</dt>
                              <dd>
                                {num(Number(r.zone_adu) * 7, 1)} {r.unit}/week · CV {num(r.cv, 3)} →
                                red safety {num(r.safety_pct, 0)}%
                              </dd>
                            </div>
                          )}
                          <div>
                            <dt>Zones (top of red / yellow / green)</dt>
                            <dd>
                              {num(r.top_of_red, 1)} / {num(r.top_of_yellow, 1)} /{' '}
                              {num(r.top_of_green, 1)}
                            </dd>
                          </div>
                          <div>
                            <dt>Net flow</dt>
                            <dd>
                              {num(r.on_hand)} on hand + {num(r.open_supply)} open supply −{' '}
                              {num(r.qualified_demand)} qualified demand = {num(r.nfp)}
                            </dd>
                          </div>
                          {Number(r.lead_time_demand) > 0 && (
                            <div>
                              <dt>Of which usage over lead time</dt>
                              <dd>{num(r.lead_time_demand)}</dd>
                            </div>
                          )}
                          {Number(r.production_demand) > 0 && (
                            <div>
                              <dt>Of which open production orders</dt>
                              <dd>{num(r.production_demand)}</dd>
                            </div>
                          )}
                          {Number(r.planned_make_demand) > 0 && (
                            <div>
                              <dt>Of which planned make orders</dt>
                              <dd>{num(r.planned_make_demand)}</dd>
                            </div>
                          )}
                          {r.required_date && (
                            <div>
                              <dt>Needed by</dt>
                              <dd>{r.required_date} (earliest parent need less lead time)</dd>
                            </div>
                          )}
                          <div>
                            <dt>Of which spikes</dt>
                            <dd>{num(r.spike_demand)}</dd>
                          </div>
                          <div>
                            <dt>Demand beyond lead time</dt>
                            <dd>{num(r.outside_horizon)} (not counted yet)</dd>
                          </div>
                        </dl>
                        {r.make_buy === 'MAKE' && r.policy === 'BUFFER' && (
                          <LeadTimeReality csrf={csrf} plantId={plantId} itemId={r.item_id} />
                        )}
                        {r.drivers?.length > 0 && (
                          <div className="table-wrap">
                            <table className="compact">
                              <caption>Demand that qualifies here</caption>
                              <thead>
                                <tr>
                                  <th>Driven by</th>
                                  <th>Parent item</th>
                                  <th className="num">Quantity</th>
                                  <th>Parent needed</th>
                                  <th>Needed here by</th>
                                </tr>
                              </thead>
                              <tbody>
                                {r.drivers.slice(0, 12).map((d: any) => (
                                  <tr key={d.kind + d.ref}>
                                    <td>
                                      {d.kind === 'production'
                                        ? 'Production order ' + d.ref
                                        : d.kind === 'order'
                                          ? 'Inserted order ' + d.ref
                                          : 'Planned make order'}
                                    </td>
                                    <td>{d.item ?? d.ref}</td>
                                    <td className="num">{num(d.qty)}</td>
                                    <td>{d.need}</td>
                                    <td>{d.requiredDate}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {r.drivers.length > 12 && (
                              <p className="cell-sub">
                                and {r.drivers.length - 12} more parent order(s).
                              </p>
                            )}
                          </div>
                        )}
                        {r.messages?.length > 0 && (
                          <ul className="messages">
                            {r.messages.map((m: string) => (
                              <li key={m}>{m}</li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
        {board.busy && <p role="status">Loading buffers…</p>}
        {!board.items.length && !board.busy && (
          <div className="empty">
            <strong>
              {current ? 'No items match this view.' : 'Buffers have not been calculated yet.'}
            </strong>
            <p>
              {current
                ? 'Choose another zone or clear the search.'
                : 'Add buffer settings for this plant; the calculation starts automatically.'}
            </p>
          </div>
        )}
        <Pager cursors={cursors} next={board.next} setCursors={setCursors} />
      </section>
    </>
  );
}

// ---------- Purchase proposals (rule AV-01) ----------

const PROPOSAL_TABS: [string, string][] = [
  ['PROPOSED', 'Waiting for approval'],
  ['APPROVED', 'Approved'],
  ['REJECTED', 'Rejected'],
  ['WITHDRAWN', 'Withdrawn'],
];

export function PurchaseProposals({
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
  const canApprove = permissions.includes('purchase.approve');
  const canChange = permissions.includes('purchase.create');
  const [status, setStatus] = useState('PROPOSED'),
    [revision, setRevision] = useState(0),
    [cursors, setCursors] = useState<string[]>([]),
    [selected, setSelected] = useState<Record<string, number>>({}),
    [editing, setEditing] = useState<any>(null),
    [rejecting, setRejecting] = useState<any>(null),
    [raising, setRaising] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const list = useList(
    csrf,
    pagePath(`plants/${plantId}/purchase-proposals`, {
      status,
      cursor: cursors[cursors.length - 1],
    }),
    [revision, refreshKey],
  );
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    let live = true;
    call(`plants/${plantId}/purchase-proposals`)
      .then((d) => live && setCounts(d.counts))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [plantId, revision, refreshKey]);
  const done = (message: string) => {
    setNotice(message);
    setSelected({});
    setEditing(null);
    setRejecting(null);
    setRaising(null);
    setRevision((x) => x + 1);
  };
  function act(path: string, payload: any) {
    setBusy(true);
    setError('');
    setNotice('');
    call(path, 'POST', payload)
      .then((d) => done(d.message))
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }
  function saveEdit() {
    setBusy(true);
    setError('');
    call('purchase-proposals/' + editing.id, 'PATCH', {
      quantity: String(editing.quantity),
      due_date: editing.due_date,
      note: editing.note ?? '',
      version: editing.version,
    })
      .then((d) => done(d.message))
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }
  const chosen = Object.entries(selected).map(([id, version]) => ({ id, version }));
  const pending = status === 'PROPOSED';
  return (
    <>
      <Messages error={error || list.error} notice={notice} />
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Purchase proposals</h2>
            <p className="panel-sub">
              Suggested from the buffers: bought items at or below top of yellow, sized back to top
              of green with the supplier&apos;s MOQ and order multiple. Approving creates a purchase
              order; it counts as incoming supply, not stock, until goods are received.
            </p>
          </div>
          {canChange && !raising && (
            <button
              className="button"
              onClick={() => setRaising({ item: '', quantity: '', due_date: '', note: '' })}
            >
              Raise proposal
            </button>
          )}
        </div>
        <div className="subtabs proposal-tabs" role="tablist" aria-label="Proposal status">
          {PROPOSAL_TABS.map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={status === k}
              className={status === k ? 'selected' : ''}
              onClick={() => {
                setCursors([]);
                setSelected({});
                setStatus(k);
              }}
            >
              {label} <span className="count">{counts[k] ?? 0}</span>
            </button>
          ))}
        </div>
        {raising && (
          <form
            className="company-form inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              act(`plants/${plantId}/purchase-proposals`, raising);
            }}
          >
            <h3>Raise a proposal</h3>
            <div className="form-grid">
              {[
                ['item', 'Item code *', {}],
                ['quantity', 'Quantity (purchase unit) *', { inputMode: 'decimal' }],
                ['due_date', 'Needed by *', { type: 'date' }],
                ['note', 'Why', { maxLength: 300 }],
              ].map(([key, label, props]: any) => (
                <label key={key}>
                  {label}
                  <input
                    value={raising[key]}
                    onChange={(e) => setRaising({ ...raising, [key]: e.target.value })}
                    {...props}
                  />
                </label>
              ))}
            </div>
            <p className="panel-sub">
              Uses the item&apos;s preferred supplier. Someone else must approve it.
            </p>
            <div className="form-actions">
              <button className="button primary" disabled={busy}>
                Raise proposal
              </button>
              <button type="button" className="button" onClick={() => setRaising(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
        {pending && canApprove && (
          <div className="toolbar panel-toolbar">
            <span className="panel-sub">{chosen.length} selected</span>
            <button
              className="button primary"
              disabled={busy || !chosen.length}
              onClick={() => act(`plants/${plantId}/purchase-proposals/approve`, { items: chosen })}
            >
              Approve selected
            </button>
          </div>
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {pending && canApprove && <th aria-label="Select" />}
                <th>Proposal</th>
                <th>Item</th>
                <th>Supplier</th>
                <th className="num">Quantity</th>
                <th>Needed by</th>
                <th>Why</th>
                <th>{pending ? 'Raised by' : 'Decision'}</th>
                {pending && (canApprove || canChange) && <th className="actions">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {list.items.map((p) => [
                <tr key={p.id}>
                  {pending && canApprove && (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select proposal ${p.proposal_no}`}
                        checked={p.id in selected}
                        onChange={(e) => {
                          const next = { ...selected };
                          if (e.target.checked) next[p.id] = p.version;
                          else delete next[p.id];
                          setSelected(next);
                        }}
                      />
                    </td>
                  )}
                  <td>
                    <strong>#{p.proposal_no}</strong>
                  </td>
                  <td>
                    <strong>{p.item}</strong>
                    <div className="cell-sub">{p.item_name}</div>
                  </td>
                  <td>
                    {p.supplier}
                    <div className="cell-sub">{p.supplier_name}</div>
                  </td>
                  <td className="num">
                    <strong>
                      {num(p.quantity)} {p.unit}
                    </strong>
                    {p.unit !== p.base_unit && (
                      <div className="cell-sub">
                        = {num(Number(p.quantity) * Number(p.unit_factor))} {p.base_unit}
                      </div>
                    )}
                  </td>
                  <td className="nowrap">{p.due_date}</td>
                  <td>
                    {p.zone && <span className={'zone-pill ' + p.zone}>{ZONE_LABELS[p.zone]}</span>}
                    <div className="cell-sub">{p.note || '—'}</div>
                  </td>
                  <td>
                    {pending ? (
                      p.source === 'SYSTEM' && !p.changed_by_name ? (
                        <span className="cell-sub">Planning run #{p.run_no}</span>
                      ) : (
                        <span className="cell-sub">{p.changed_by_name ?? 'Platform admin'}</span>
                      )
                    ) : (
                      <>
                        <span className={'status-pill ' + (p.status === 'APPROVED' ? 'ok' : 'off')}>
                          {p.status === 'APPROVED' ? `PO ${p.po_no}` : p.status.toLowerCase()}
                        </span>
                        <div className="cell-sub">
                          {p.decided_by_name ?? (p.status === 'WITHDRAWN' ? 'Planning' : '')}
                          {p.decision_note ? ' · ' + p.decision_note : ''}
                        </div>
                      </>
                    )}
                  </td>
                  {pending && (canApprove || canChange) && (
                    <td className="actions nowrap">
                      {canApprove && (
                        <button
                          className="text-button"
                          aria-label={`Approve proposal ${p.proposal_no}`}
                          disabled={busy}
                          onClick={() =>
                            act(`purchase-proposals/${p.id}/approve`, { version: p.version })
                          }
                        >
                          Approve
                        </button>
                      )}
                      {canApprove && (
                        <button
                          className="text-button"
                          aria-label={`Reject proposal ${p.proposal_no}`}
                          onClick={() => setRejecting({ ...p, reason: '' })}
                        >
                          Reject
                        </button>
                      )}
                      {canChange && (
                        <button
                          className="text-button"
                          aria-label={`Change proposal ${p.proposal_no}`}
                          onClick={() => setEditing({ ...p, quantity: num(p.quantity, 6) })}
                        >
                          Change
                        </button>
                      )}
                    </td>
                  )}
                </tr>,
                editing?.id === p.id && (
                  <tr key={p.id + '-edit'} className="detail-row">
                    <td colSpan={9}>
                      <form
                        className="company-form inline-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          saveEdit();
                        }}
                      >
                        <div className="form-grid">
                          <label>
                            Quantity ({p.unit})
                            <input
                              inputMode="decimal"
                              value={editing.quantity}
                              onChange={(e) => setEditing({ ...editing, quantity: e.target.value })}
                            />
                          </label>
                          <label>
                            Needed by
                            <input
                              type="date"
                              value={editing.due_date}
                              onChange={(e) => setEditing({ ...editing, due_date: e.target.value })}
                            />
                          </label>
                          <label>
                            Why changed
                            <input
                              maxLength={300}
                              value={editing.note}
                              onChange={(e) => setEditing({ ...editing, note: e.target.value })}
                            />
                          </label>
                        </div>
                        <p className="panel-sub">
                          After you change it, someone else must approve it.
                        </p>
                        <div className="form-actions">
                          <button className="button primary" disabled={busy}>
                            Save change
                          </button>
                          <button type="button" className="button" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                        </div>
                      </form>
                    </td>
                  </tr>
                ),
                rejecting?.id === p.id && (
                  <tr key={p.id + '-reject'} className="detail-row">
                    <td colSpan={9}>
                      <form
                        className="company-form inline-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          act(`purchase-proposals/${p.id}/reject`, {
                            version: p.version,
                            reason: rejecting.reason,
                          });
                        }}
                      >
                        <label>
                          Reason for rejecting *
                          <input
                            maxLength={300}
                            value={rejecting.reason}
                            onChange={(e) => setRejecting({ ...rejecting, reason: e.target.value })}
                          />
                        </label>
                        <div className="form-actions">
                          <button className="button primary" disabled={busy}>
                            Reject proposal
                          </button>
                          <button
                            type="button"
                            className="button"
                            onClick={() => setRejecting(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    </td>
                  </tr>
                ),
              ])}
            </tbody>
          </table>
        </div>
        {list.busy && <p role="status">Loading proposals…</p>}
        {!list.items.length && !list.busy && (
          <div className="empty">
            <strong>{pending ? 'Nothing waiting for approval.' : 'No proposals here yet.'}</strong>
            <p>
              {pending
                ? 'Bought items get a proposal automatically when their buffer drops to yellow or below.'
                : 'Decided proposals appear here.'}
            </p>
          </div>
        )}
        <Pager cursors={cursors} next={list.next} setCursors={setCursors} />
      </section>
    </>
  );
}
