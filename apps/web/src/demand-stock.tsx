import { useState } from 'react';
import { useApi } from './api-client';
import { LineTable, Messages, useList, type Column } from './plant-model';

const today = () => new Date().toISOString().slice(0, 10);
const num = (v: unknown) => (v === null || v === undefined || v === '' ? '' : String(Number(v)));
const LOCATION_TYPES: Record<string, string> = {
  STORES: 'Stores',
  PRODUCTION: 'Production',
  FINISHED: 'Finished goods',
  QUARANTINE: 'Quarantine',
};
const MOVEMENT_LABELS: Record<string, string> = {
  OPENING: 'Opening stock',
  RECEIPT: 'Receipt',
  ISSUE: 'Issue',
  ADJUSTMENT: 'Adjustment',
  REVERSAL: 'Reversal',
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

function SearchBox({
  label,
  placeholder,
  onSearch,
}: {
  label: string;
  placeholder: string;
  onSearch: (q: string) => void;
}) {
  const [query, setQuery] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(query.trim().toLowerCase());
      }}
    >
      <input
        aria-label={label}
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />{' '}
      <button className="button">Search</button>
    </form>
  );
}

const pagePath = (base: string, params: Record<string, string | null | undefined>) => {
  const q = Object.entries(params)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
    .join('&');
  return q ? `${base}?${q}` : base;
};

// ---------- Stock locations ----------

export function StockLocations({
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
    [notice, setNotice] = useState('');
  const list = useList(csrf, `plants/${plantId}/stock-locations`, [revision, refreshKey]);
  function save() {
    setBusy(true);
    setError('');
    const payload: any = {
      name: form.name,
      location_type: form.location_type,
      nettable: form.nettable,
    };
    if (form.id) Object.assign(payload, { active: form.active, version: form.version });
    else payload.code = form.code;
    call(
      form.id ? 'stock-locations/' + form.id : `plants/${plantId}/stock-locations`,
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
          <h2>{form.id ? `Edit location ${form.code}` : 'New stock location'}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <div className="form-grid">
              {!form.id && (
                <label>
                  Location code *
                  <input
                    value={form.code}
                    maxLength={40}
                    onChange={(e) => setForm({ ...form, code: e.target.value })}
                  />
                </label>
              )}
              <label>
                Location name *
                <input
                  value={form.name}
                  maxLength={120}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label>
                Location type
                <select
                  value={form.location_type}
                  onChange={(e) => setForm({ ...form, location_type: e.target.value })}
                >
                  {Object.entries(LOCATION_TYPES).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.nettable}
                  onChange={(e) => setForm({ ...form, nettable: e.target.checked })}
                />{' '}
                Counts as available stock for planning
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
                Save location
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
            <h2>Stock locations</h2>
            <p className="panel-sub">
              {list.busy
                ? 'Loading…'
                : `${list.items.length} location(s) · ${list.items.filter((l) => l.items_in_stock > 0).length} holding stock`}
            </p>
          </div>
          {canManage && !form && (
            <button
              className="button primary"
              onClick={() =>
                setForm({ code: '', name: '', location_type: 'STORES', nettable: true })
              }
            >
              Create location
            </button>
          )}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Location</th>
                <th>Type</th>
                <th>Planning</th>
                <th className="num">Items in stock</th>
                <th>Status</th>
                {canManage && <th className="actions">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {list.items.map((l) => (
                <tr key={l.id}>
                  <td>
                    <strong>{l.code}</strong>
                    <div className="cell-sub">{l.name}</div>
                  </td>
                  <td>
                    <span className="chip">
                      {LOCATION_TYPES[l.location_type] ?? l.location_type}
                    </span>
                  </td>
                  <td>
                    <span className={'status-pill ' + (l.nettable ? 'ok' : 'off')}>
                      {l.nettable ? 'Counts as available' : 'Not counted'}
                    </span>
                  </td>
                  <td className="num">{l.items_in_stock}</td>
                  <td>
                    <span className={'status-pill ' + (l.active ? 'ok' : 'off')}>
                      {l.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  {canManage && (
                    <td className="actions">
                      <button
                        className="text-button"
                        aria-label={'Edit location ' + l.code}
                        onClick={() => setForm({ ...l })}
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
            <strong>No stock locations in this plant yet.</strong>
            <p>
              Create a raw material store, a finished goods store and a quality hold so stock can be
              posted.
            </p>
          </div>
        )}
      </section>
    </>
  );
}

// ---------- Stock ----------

export function Stock({
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
  const canMove = permissions.includes('inventory.move');
  const canAdjust = permissions.includes('inventory.adjust');
  const types = [
    ...(canMove ? ['RECEIPT', 'ISSUE'] : []),
    ...(canAdjust ? ['OPENING', 'ADJUSTMENT'] : []),
  ];
  const [revision, setRevision] = useState(0),
    [form, setForm] = useState<any>(null),
    [reversing, setReversing] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [q, setQ] = useState(''),
    [location, setLocation] = useState(''),
    [cursors, setCursors] = useState<string[]>([]),
    [movementQ, setMovementQ] = useState(''),
    [movementCursors, setMovementCursors] = useState<string[]>([]);
  const locations = useList(csrf, `plants/${plantId}/stock-locations`, [refreshKey]);
  const active = locations.items.filter((l) => l.active);
  const balances = useList(
    csrf,
    pagePath(`plants/${plantId}/stock`, {
      q,
      location,
      cursor: cursors[cursors.length - 1],
    }),
    [revision, refreshKey],
  );
  const movements = useList(
    csrf,
    pagePath(`plants/${plantId}/stock/movements`, {
      q: movementQ,
      cursor: movementCursors[movementCursors.length - 1],
    }),
    [revision, refreshKey],
  );
  const done = (message: string) => {
    setNotice(message);
    setForm(null);
    setReversing(null);
    setCursors([]);
    setMovementCursors([]);
    setRevision((x) => x + 1);
  };
  function post() {
    setBusy(true);
    setError('');
    const quantity =
      form.movement_type === 'ADJUSTMENT' && form.direction === 'decrease'
        ? '-' + form.quantity
        : form.quantity;
    call(`plants/${plantId}/stock/movements`, 'POST', {
      location: form.location,
      item: form.item,
      movement_type: form.movement_type,
      quantity,
      unit: form.unit,
      movement_date: form.movement_date,
      reference: form.reference,
      reason: form.reason,
    })
      .then((d) => done(d.message))
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }
  function reverse() {
    setBusy(true);
    setError('');
    call(`stock-movements/${reversing.id}/reverse`, 'POST', { reason: reversing.reason })
      .then((d) => done(d.message))
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }
  const field = (key: string, label: string, props: any = {}) => (
    <label>
      {label}
      <input
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        {...props}
      />
    </label>
  );
  return (
    <>
      {!locations.busy && !active.length && (
        <div className="notice" role="status">
          This plant has no active stock location. Create one in Stock locations first.
        </div>
      )}
      <Messages error={error || balances.error || movements.error} notice={notice} />
      {form && (
        <section className="panel company-form">
          <h2>Post stock movement</h2>
          <p>
            Posted movements cannot be edited or deleted. A wrong movement is corrected by reversing
            it.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              post();
            }}
          >
            <div className="form-grid">
              <label>
                Movement type
                <select
                  value={form.movement_type}
                  onChange={(e) => setForm({ ...form, movement_type: e.target.value })}
                >
                  {types.map((t) => (
                    <option key={t} value={t}>
                      {MOVEMENT_LABELS[t]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Stock location
                <select
                  value={form.location}
                  onChange={(e) => setForm({ ...form, location: e.target.value })}
                >
                  {active.map((l) => (
                    <option key={l.id} value={l.code}>
                      {l.code} — {l.name}
                    </option>
                  ))}
                </select>
              </label>
              {field('item', 'Item code *')}
              {form.movement_type === 'ADJUSTMENT' && (
                <label>
                  Direction
                  <select
                    value={form.direction}
                    onChange={(e) => setForm({ ...form, direction: e.target.value })}
                  >
                    <option value="increase">Increase stock</option>
                    <option value="decrease">Decrease stock</option>
                  </select>
                </label>
              )}
              {field('quantity', 'Quantity *', { inputMode: 'decimal' })}
              {field('unit', 'Unit (blank = base unit)')}
              {field('movement_date', 'Movement date *', { type: 'date', max: today() })}
              {field('reference', 'Reference (GRN, issue slip…)', { maxLength: 60 })}
              {field('reason', form.movement_type === 'ADJUSTMENT' ? 'Reason *' : 'Reason', {
                maxLength: 200,
              })}
            </div>
            <div className="form-actions">
              <button className="button primary" disabled={busy}>
                Post movement
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
      {reversing && (
        <section className="panel company-form">
          <h2>Reverse movement #{reversing.movement_no}</h2>
          <p>
            A reversal posts the opposite quantity ({num(reversing.quantity)} {reversing.base_unit}{' '}
            of {reversing.item} at {reversing.location}) with today&apos;s date. The original stays
            in the ledger.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              reverse();
            }}
          >
            <label>
              Reason *
              <input
                value={reversing.reason}
                maxLength={200}
                onChange={(e) => setReversing({ ...reversing, reason: e.target.value })}
              />
            </label>
            <div className="form-actions">
              <button className="button primary" disabled={busy}>
                Post reversal
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setReversing(null)}
              >
                Cancel
              </button>
            </div>
          </form>
        </section>
      )}
      <section className="panel table-wrap">
        <div className="panel-heading">
          <div>
            <h2>Current stock</h2>
            <p className="panel-sub">Quantities in each item's base unit, from the stock ledger.</p>
          </div>
          {types.length > 0 && !form && (
            <button
              className="button primary"
              disabled={!active.length}
              title={active.length ? undefined : 'Create a stock location first'}
              onClick={() =>
                setForm({
                  movement_type: types[0],
                  location: active[0]?.code ?? '',
                  item: '',
                  quantity: '',
                  unit: '',
                  direction: 'increase',
                  movement_date: today(),
                  reference: '',
                  reason: '',
                })
              }
            >
              Post movement
            </button>
          )}
        </div>
        <div className="toolbar">
          <SearchBox
            label="Stock search"
            placeholder="Item code starts with…"
            onSearch={(v) => {
              setCursors([]);
              setQ(v);
            }}
          />
          <label>
            Location filter
            <select
              value={location}
              onChange={(e) => {
                setCursors([]);
                setLocation(e.target.value);
              }}
            >
              <option value="">All locations</option>
              {locations.items.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code}
                </option>
              ))}
            </select>
          </label>
        </div>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Item name</th>
              <th>Location</th>
              <th className="num">Quantity</th>
              <th>Unit</th>
              <th>Planning</th>
            </tr>
          </thead>
          <tbody>
            {balances.items.map((b) => (
              <tr key={b.location_id + b.item_id}>
                <td>
                  <strong>{b.item}</strong>
                </td>
                <td>{b.item_name}</td>
                <td>{b.location}</td>
                <td className="num">{num(b.quantity)}</td>
                <td>{b.unit}</td>
                <td>
                  <span className={'status-pill ' + (b.nettable ? 'ok' : 'off')}>
                    {b.nettable ? 'Counts as available' : 'Not counted'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {balances.busy && <p role="status">Loading stock…</p>}
        {!balances.items.length && !balances.busy && (
          <div className="empty">
            {q || location ? 'No stock matches this search.' : 'No stock recorded in this plant.'}
          </div>
        )}
        <Pager cursors={cursors} next={balances.next} setCursors={setCursors} />
      </section>
      <section className="panel table-wrap">
        <div className="panel-heading">
          <h2>Stock ledger</h2>
        </div>
        <div className="toolbar">
          <SearchBox
            label="Ledger search"
            placeholder="Item code starts with…"
            onSearch={(v) => {
              setMovementCursors([]);
              setMovementQ(v);
            }}
          />
        </div>
        <table>
          <thead>
            <tr>
              <th>No.</th>
              <th>Date</th>
              <th>Type</th>
              <th>Item</th>
              <th>Location</th>
              <th>Quantity</th>
              <th>Entered</th>
              <th>Reference</th>
              <th>Reason</th>
              {canAdjust && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {movements.items.map((m) => (
              <tr key={m.id}>
                <td>#{m.movement_no}</td>
                <td>{m.movement_date}</td>
                <td>
                  {MOVEMENT_LABELS[m.movement_type]}
                  {m.reverses_no && ` of #${m.reverses_no}`}
                  {m.reversed_by && ` (reversed by #${m.reversed_by})`}
                </td>
                <td>{m.item}</td>
                <td>{m.location}</td>
                <td>
                  {Number(m.quantity) > 0 ? '+' : ''}
                  {num(m.quantity)} {m.base_unit}
                </td>
                <td>
                  {num(m.entered_quantity)} {m.unit}
                </td>
                <td>{m.reference || m.external_ref || '—'}</td>
                <td>{m.reason || '—'}</td>
                {canAdjust && (
                  <td>
                    {m.movement_type !== 'REVERSAL' && !m.reversed_by && (
                      <button
                        className="text-button"
                        aria-label={'Reverse movement ' + m.movement_no}
                        onClick={() => {
                          setForm(null);
                          setReversing({ ...m, reason: '' });
                        }}
                      >
                        Reverse
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {movements.busy && <p role="status">Loading ledger…</p>}
        {!movements.items.length && !movements.busy && (
          <div className="empty">No stock movements in this plant yet.</div>
        )}
        <Pager cursors={movementCursors} next={movements.next} setCursors={setMovementCursors} />
      </section>
    </>
  );
}

// ---------- Customer and purchase orders ----------

type OrderConfig = {
  path: string;
  detailPath: string;
  noun: string;
  no: string;
  party: string;
  partyLabel: string;
  canCreate: boolean;
  canEdit: boolean;
  lineColumns: Column[];
  blankLine: (n: number) => any;
  listColumns: [string, string][];
  headerFields: (form: any, setForm: (f: any) => void) => React.ReactNode;
  blank: () => any;
  payload: (form: any) => any;
  // Extra section shown under an opened record, with a way to reload it.
  extra?: (form: any, reload: () => void) => React.ReactNode;
};

function Orders({
  csrf,
  config,
  refreshKey,
}: {
  csrf: string;
  config: OrderConfig;
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const [form, setForm] = useState<any>(null),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [q, setQ] = useState(''),
    [status, setStatus] = useState('OPEN'),
    [cursors, setCursors] = useState<string[]>([]),
    [cancelReason, setCancelReason] = useState<string | null>(null);
  const list = useList(
    csrf,
    pagePath(config.path, { q, status, cursor: cursors[cursors.length - 1] }),
    [revision, refreshKey],
  );
  const noun = config.noun.toLowerCase();
  const editable = form && (form.id ? config.canEdit && form.status === 'OPEN' : config.canCreate);
  const finish = (message: string) => {
    setNotice(message);
    setForm(null);
    setCancelReason(null);
    setRevision((x) => x + 1);
  };
  function save() {
    setBusy(true);
    setError('');
    const payload = config.payload(form);
    if (form.id) {
      delete payload[config.no];
      payload.version = form.version;
    }
    call(
      form.id ? `${config.detailPath}/${form.id}` : config.path,
      form.id ? 'PUT' : 'POST',
      payload,
    )
      .then((d) => finish(d.message))
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }
  function cancel() {
    setBusy(true);
    setError('');
    call(`${config.detailPath}/${form.id}/cancel`, 'POST', {
      reason: cancelReason,
      version: form.version,
    })
      .then((d) => finish(d.message))
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }
  function open(id: string) {
    setError('');
    call(`${config.detailPath}/${id}`)
      .then((o) =>
        setForm({
          ...o,
          [config.no]: o.no,
          lines: o.lines
            .filter((l: any) => l.status === 'OPEN' || o.status === 'CANCELLED')
            .map((l: any) => ({
              ...l,
              quantity: num(l.quantity),
              received_quantity: num(l.received_quantity),
            })),
        }),
      )
      .catch((e) => setError(e.message));
  }
  return (
    <>
      <Messages error={error || list.error} notice={notice} />
      {form ? (
        <section className="panel company-form">
          <h2>
            {form.id
              ? `${config.noun} ${form.no}${form.status === 'CANCELLED' ? ' (cancelled)' : ''}`
              : `New ${noun}`}
          </h2>
          {form.status === 'CANCELLED' && form.cancel_reason && (
            <p>Cancelled: {form.cancel_reason}</p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (editable) save();
            }}
          >
            <fieldset disabled={!editable} className="plain-fieldset">
              <div className="form-grid">
                {!form.id && (
                  <label>
                    {config.noun} number (blank = next number)
                    <input
                      value={form[config.no] ?? ''}
                      maxLength={40}
                      onChange={(e) => setForm({ ...form, [config.no]: e.target.value })}
                    />
                  </label>
                )}
                {config.headerFields(form, setForm)}
              </div>
              <h3>Lines</h3>
              <LineTable
                label="Line"
                rows={form.lines}
                blank={config.blankLine(
                  Math.max(0, ...form.lines.map((l: any) => Number(l.line_no) || 0)) + 10,
                )}
                onChange={(lines) => setForm({ ...form, lines })}
                columns={config.lineColumns}
              />
            </fieldset>
            {form.id && form.status === 'OPEN' && (
              <p className="panel-note">
                Removing a line cancels it; line numbers are never reused for a different item.
              </p>
            )}
            <div className="form-actions">
              {editable && (
                <button className="button primary" disabled={busy}>
                  Save {noun}
                </button>
              )}
              {form.id && form.status === 'OPEN' && config.canEdit && cancelReason === null && (
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => setCancelReason('')}
                >
                  Cancel {noun}
                </button>
              )}
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => {
                  setForm(null);
                  setCancelReason(null);
                }}
              >
                Close
              </button>
            </div>
          </form>
          {form.id && config.extra?.(form, () => open(form.id))}
          {cancelReason !== null && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                cancel();
              }}
            >
              <label>
                Cancellation reason *
                <input
                  value={cancelReason}
                  maxLength={200}
                  onChange={(e) => setCancelReason(e.target.value)}
                />
              </label>
              <div className="form-actions">
                <button className="button primary" disabled={busy}>
                  Confirm cancellation
                </button>
              </div>
            </form>
          )}
        </section>
      ) : (
        <>
          <div className="toolbar">
            <SearchBox
              label={`${config.noun} search`}
              placeholder={`${config.noun} or ${config.partyLabel.toLowerCase()} code starts with…`}
              onSearch={(v) => {
                setCursors([]);
                setQ(v);
              }}
            />
            <label>
              Status
              <select
                value={status}
                onChange={(e) => {
                  setCursors([]);
                  setStatus(e.target.value);
                }}
              >
                <option value="OPEN">Open</option>
                <option value="CANCELLED">Cancelled</option>
                <option value="">All</option>
              </select>
            </label>
            {config.canCreate && (
              <button
                className="button primary"
                onClick={() => {
                  setError('');
                  setForm(config.blank());
                }}
              >
                Create {noun}
              </button>
            )}
          </div>
          <section className="panel table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Number</th>
                  <th>{config.partyLabel}</th>
                  {config.listColumns.map(([key, label]) => (
                    <th key={label} className={numeric(key) ? 'num' : undefined}>
                      {label}
                    </th>
                  ))}
                  <th>Status</th>
                  <th className="actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <strong>{o.no}</strong>
                    </td>
                    <td>
                      <strong>{o.party}</strong>
                      <div className="cell-sub">{o.party_name}</div>
                    </td>
                    {config.listColumns.map(([key]) => (
                      <td key={key} className={numeric(key) ? 'num' : 'nowrap'}>
                        {typeof o[key] === 'boolean'
                          ? o[key]
                            ? 'Yes'
                            : 'No'
                          : key.includes('quantity')
                            ? num(o[key])
                            : (o[key] ?? '—')}
                      </td>
                    ))}
                    <td>
                      <span className={'status-pill ' + (o.status === 'OPEN' ? 'ok' : 'off')}>
                        {o.status === 'OPEN' ? 'Open' : 'Cancelled'}
                      </span>
                    </td>
                    <td className="actions">
                      <button
                        className="text-button"
                        aria-label={`Open ${noun} ${o.no}`}
                        onClick={() => open(o.id)}
                      >
                        {config.canEdit && o.status === 'OPEN' ? 'Edit' : 'View'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {list.busy && <p role="status">Loading…</p>}
            {!list.items.length && !list.busy && (
              <div className="empty">
                {q || status !== 'OPEN'
                  ? 'No records match this search.'
                  : `No open ${noun}s in this plant. Create one or import them from Imports.`}
              </div>
            )}
            <Pager cursors={cursors} next={list.next} setCursors={setCursors} />
          </section>
        </>
      )}
    </>
  );
}

const numeric = (key: string) => key.includes('quantity') || key.includes('lines');

const input = (
  form: any,
  setForm: (f: any) => void,
  key: string,
  label: string,
  props: any = {},
) => (
  <label key={key}>
    {label}
    <input
      value={form[key] ?? ''}
      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      {...props}
    />
  </label>
);

export function CustomerOrders({
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
  const config: OrderConfig = {
    path: `plants/${plantId}/sales-orders`,
    detailPath: 'sales-orders',
    noun: 'Order',
    no: 'order_no',
    party: 'customer',
    partyLabel: 'Customer',
    canCreate: permissions.includes('orders.create'),
    canEdit: permissions.includes('orders.update'),
    lineColumns: [
      { key: 'line_no', label: 'Line no.', inputMode: 'numeric' },
      { key: 'item', label: 'Item code' },
      { key: 'quantity', label: 'Quantity', inputMode: 'decimal' },
      { key: 'line_promise_date', label: 'Promise date (blank = order)', type: 'date' },
    ],
    blankLine: (n) => ({ line_no: String(n), item: '', quantity: '', line_promise_date: '' }),
    listColumns: [
      ['order_date', 'Order date'],
      ['promise_date', 'Promise date'],
      ['open_lines', 'Open lines'],
      ['open_quantity', 'Open quantity'],
      ['allow_partial', 'Partial delivery'],
    ],
    headerFields: (form, setForm) => (
      <>
        {input(form, setForm, 'customer', 'Customer code *')}
        {input(form, setForm, 'order_date', 'Order date *', { type: 'date' })}
        {input(form, setForm, 'promise_date', 'Promise date *', { type: 'date' })}
        <label>
          <input
            type="checkbox"
            checked={form.allow_partial}
            onChange={(e) => setForm({ ...form, allow_partial: e.target.checked })}
          />{' '}
          Partial delivery allowed
        </label>
        {input(form, setForm, 'customer_ref', 'Customer PO reference', { maxLength: 60 })}
      </>
    ),
    blank: () => ({
      order_no: '',
      customer: '',
      order_date: today(),
      promise_date: '',
      allow_partial: true,
      customer_ref: '',
      lines: [{ line_no: '10', item: '', quantity: '', line_promise_date: '' }],
    }),
    payload: (form) => ({
      order_no: form.order_no,
      customer: form.customer,
      order_date: form.order_date,
      promise_date: form.promise_date,
      allow_partial: form.allow_partial,
      customer_ref: form.customer_ref,
      lines: form.lines.map((l: any) => ({
        line_no: String(l.line_no),
        item: l.item,
        quantity: String(l.quantity),
        line_promise_date: l.line_promise_date ?? '',
      })),
    }),
  };
  return <Orders key={plantId} csrf={csrf} config={config} refreshKey={refreshKey} />;
}

export function PurchaseOrders({
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
  const canCreate = permissions.includes('purchase.create');
  const config: OrderConfig = {
    path: `plants/${plantId}/purchase-orders`,
    detailPath: 'purchase-orders',
    noun: 'Purchase order',
    no: 'po_no',
    party: 'supplier',
    partyLabel: 'Supplier',
    canCreate,
    canEdit: canCreate,
    lineColumns: [
      { key: 'line_no', label: 'Line no.', inputMode: 'numeric' },
      { key: 'item', label: 'Item code' },
      { key: 'quantity', label: 'Quantity', inputMode: 'decimal' },
      { key: 'unit', label: 'Unit (blank = base unit)' },
      { key: 'due_date', label: 'Due date', type: 'date' },
      { key: 'received_quantity', label: 'Received so far', readOnly: true },
    ],
    blankLine: (n) => ({
      line_no: String(n),
      item: '',
      quantity: '',
      unit: '',
      due_date: '',
      received_quantity: '0',
    }),
    listColumns: [
      ['order_date', 'Order date'],
      ['next_due', 'Next due'],
      ['open_lines', 'Open lines'],
    ],
    headerFields: (form, setForm) => (
      <>
        {input(form, setForm, 'supplier', 'Supplier code *')}
        {input(form, setForm, 'order_date', 'Order date *', { type: 'date' })}
      </>
    ),
    blank: () => ({
      po_no: '',
      supplier: '',
      order_date: today(),
      lines: [
        { line_no: '10', item: '', quantity: '', unit: '', due_date: '', received_quantity: '0' },
      ],
    }),
    payload: (form) => ({
      po_no: form.po_no,
      supplier: form.supplier,
      order_date: form.order_date,
      lines: form.lines.map((l: any) => ({
        line_no: String(l.line_no),
        item: l.item,
        quantity: String(l.quantity),
        unit: l.unit ?? '',
        due_date: l.due_date ?? '',
        received_quantity: String(l.received_quantity ?? '0'),
      })),
    }),
  };
  config.extra = (form, reload) => (
    <GoodsReceipts
      key={form.id + ':' + form.version}
      csrf={csrf}
      plantId={plantId}
      po={form}
      canReceive={permissions.includes('inventory.move')}
      onPosted={reload}
    />
  );
  return <Orders key={plantId} csrf={csrf} config={config} refreshKey={refreshKey} />;
}

// Receipts against an opened purchase order: what arrived, into which store, posted to stock.
function GoodsReceipts({
  csrf,
  plantId,
  po,
  canReceive,
  onPosted,
}: {
  csrf: string;
  plantId: string;
  po: any;
  canReceive: boolean;
  onPosted: () => void;
}) {
  const call = useApi(csrf);
  const received = po.lines.reduce((t: number, l: any) => t + Number(l.received_quantity), 0);
  const history = useList(csrf, `purchase-orders/${po.id}/receipts`, [po.version, received]);
  const locations = useList(csrf, `plants/${plantId}/stock-locations`, []);
  const active = locations.items.filter((l) => l.active);
  const open = po.lines.filter(
    (l: any) => l.status === 'OPEN' && Number(l.quantity) > Number(l.received_quantity),
  );
  const [form, setForm] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  function start() {
    setError('');
    setForm({
      request_id: crypto.randomUUID(),
      location: active.find((l) => l.location_type === 'STORES')?.code ?? active[0]?.code ?? '',
      receipt_date: today(),
      reference: '',
      quantities: Object.fromEntries(
        open.map((l: any) => [l.line_no, String(Number(l.quantity) - Number(l.received_quantity))]),
      ),
    });
  }
  function post() {
    setBusy(true);
    setError('');
    call(`purchase-orders/${po.id}/receipts`, 'POST', {
      request_id: form.request_id,
      location: form.location,
      receipt_date: form.receipt_date,
      reference: form.reference,
      lines: Object.entries(form.quantities)
        .filter(([, q]) => String(q).trim() !== '' && Number(q) !== 0)
        .map(([line_no, quantity]) => ({ line_no: Number(line_no), quantity })),
    })
      .then((d) => {
        setNotice(d.message);
        setForm(null);
        onPosted();
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }
  return (
    <div className="receipts">
      <h3>Goods received</h3>
      <Messages error={error} notice={notice} />
      {history.items.length ? (
        <table>
          <thead>
            <tr>
              <th>Receipt</th>
              <th>Date</th>
              <th>Location</th>
              <th>Reference</th>
              <th>Lines</th>
            </tr>
          </thead>
          <tbody>
            {history.items.map((r) => (
              <tr key={r.id}>
                <td>GRN-{r.receipt_no}</td>
                <td>{r.receipt_date}</td>
                <td>{r.location}</td>
                <td>{r.reference || '—'}</td>
                <td>
                  {(r.lines ?? [])
                    .map((l: any) => `Line ${l.line_no}: ${num(l.quantity)} ${l.unit}`)
                    .join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="panel-sub">
          Nothing received yet. The order counts as incoming supply, not stock.
        </p>
      )}
      {canReceive && po.status === 'OPEN' && open.length > 0 && !form && (
        <div className="form-actions">
          <button
            type="button"
            className="button primary"
            onClick={start}
            disabled={!active.length}
          >
            Receive goods
          </button>
        </div>
      )}
      {form && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            post();
          }}
        >
          <div className="form-grid">
            <label>
              Receive into
              <select
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
              >
                {active.map((l) => (
                  <option key={l.id} value={l.code}>
                    {l.code} — {l.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Receipt date
              <input
                type="date"
                max={today()}
                value={form.receipt_date}
                onChange={(e) => setForm({ ...form, receipt_date: e.target.value })}
              />
            </label>
            <label>
              Delivery note / GRN reference
              <input
                maxLength={60}
                value={form.reference}
                onChange={(e) => setForm({ ...form, reference: e.target.value })}
              />
            </label>
          </div>
          <table className="line-editor">
            <thead>
              <tr>
                <th>Line</th>
                <th>Item</th>
                <th className="num">Still due</th>
                <th>Received now</th>
              </tr>
            </thead>
            <tbody>
              {open.map((l: any) => (
                <tr key={l.line_no}>
                  <td>{l.line_no}</td>
                  <td>{l.item}</td>
                  <td className="num">
                    {num(Number(l.quantity) - Number(l.received_quantity))} {l.unit}
                  </td>
                  <td>
                    <input
                      aria-label={`Line ${l.line_no} received now`}
                      inputMode="decimal"
                      value={form.quantities[l.line_no] ?? ''}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          quantities: { ...form.quantities, [l.line_no]: e.target.value },
                        })
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="form-actions">
            <button className="button primary" disabled={busy}>
              Post receipt
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// ---------- Demand history ----------

export function DemandHistory({
  csrf,
  plantId,
  refreshKey,
}: {
  csrf: string;
  plantId: string;
  refreshKey: number;
}) {
  const [q, setQ] = useState(''),
    [cursors, setCursors] = useState<string[]>([]);
  const list = useList(
    csrf,
    pagePath(`plants/${plantId}/demand-history`, { q, cursor: cursors[cursors.length - 1] }),
    [refreshKey],
  );
  return (
    <>
      <Messages error={list.error} notice="" />
      <div className="toolbar">
        <SearchBox
          label="Demand history search"
          placeholder="Item code starts with…"
          onSearch={(v) => {
            setCursors([]);
            setQ(v);
          }}
        />
      </div>
      <section className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Item</th>
              <th>Item name</th>
              <th>Quantity</th>
              <th>Unit</th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((d) => (
              <tr key={d.demand_date + d.item}>
                <td>{d.demand_date}</td>
                <td>{d.item}</td>
                <td>{d.item_name}</td>
                <td>{num(d.quantity)}</td>
                <td>{d.unit}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.busy && <p role="status">Loading demand history…</p>}
        {!list.items.length && !list.busy && (
          <div className="empty">
            {q
              ? 'No demand history matches this search.'
              : 'No demand history in this plant. Import it from Imports → Demand history (one row per item and day).'}
          </div>
        )}
        <Pager cursors={cursors} next={list.next} setCursors={setCursors} />
      </section>
    </>
  );
}
