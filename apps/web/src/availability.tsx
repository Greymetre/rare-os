import { CycleTimeAudit, Downtime, Execution } from './execution';
import { Delivery, Today } from './delivery';
import { Network, PlanningTools } from './planning-tools';
import { RawImport, Reconciliation } from './raw-import';
import {
  ChangeoverSimulator,
  LeadTimeRealityList,
  MaterialsOverview,
  SchedulingOverview,
  StockAndService,
} from './overview';
import {
  Expedites,
  Gantt,
  InsertOrder,
  PendingOrders,
  PlanningSettings,
  ResourceLoad,
  Scheduler,
} from './schedule';
import { useEffect, useState } from 'react';
import { download, useApi } from './api-client';
import { Boms, Calendars, PlantPicker, PlantReadiness, Resources, Routings } from './plant-model';
import {
  CustomerOrders,
  DemandHistory,
  ProductionOrders,
  PurchaseOrders,
  Stock,
  StockLocations,
} from './demand-stock';
import { BufferBoard, BufferProfiles, BufferSettings, PurchaseProposals } from './planning';

type Batch = {
  id: string;
  batch_no: string;
  kind: string;
  file_name: string;
  status: string;
  total_rows: number;
  valid_rows: number;
  error_rows: number;
  summary: Record<string, number>;
  message: string;
  created_at: string;
  version: number;
};
const MAX_BYTES = 5 * 1024 * 1024;
const statusLabel: Record<string, string> = {
  validating: 'Checking',
  validated: 'Ready to review',
  committing: 'Saving',
  committed: 'Committed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  ready: 'Ready',
  missing: 'Missing',
  upcoming: 'Coming soon',
  info: 'Per plant',
};

function Readiness({ csrf, refreshKey }: { csrf: string; refreshKey: number }) {
  const call = useApi(csrf);
  const [items, setItems] = useState<any[] | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setError('');
    call('availability/readiness')
      .then((d) => live && setItems(d.items))
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
  if (!items) return <p role="status">Checking planning data…</p>;
  const ready = items.filter((i) => i.status === 'ready').length;
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Planning data readiness</h2>
        <span className="badge">
          {ready} / {items.filter((i) => i.status !== 'info').length} ready
        </span>
      </div>
      {items.map((i) => (
        <div className="check-row readiness-row" key={i.key} data-status={i.status}>
          <span className={'status-pill ' + i.status}>{statusLabel[i.status]}</span>
          <div>
            <strong>{i.title}</strong>
            <p>{i.detail}</p>
          </div>
        </div>
      ))}
    </section>
  );
}

function Units({
  csrf,
  permissions,
  refreshKey,
}: {
  csrf: string;
  permissions: string[];
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const canManage = permissions.includes('masters.manage');
  const [rows, setRows] = useState<any[]>([]),
    [form, setForm] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [after, setAfter] = useState<string | null>(null),
    [next, setNext] = useState<string | null>(null),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError('');
    call('units?q=' + encodeURIComponent(search) + (after ? '&after=' + after : ''))
      .then((d) => {
        if (!live) return;
        setRows(d.items);
        setNext(d.nextCursor);
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [search, after, revision, refreshKey]);
  return (
    <>
      <div className="toolbar">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setAfter(null);
            setSearch(query);
          }}
        >
          <input
            aria-label="Unit search"
            placeholder="Code or name starts with…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />{' '}
          <button className="button" disabled={busy}>
            Search
          </button>
        </form>
        {canManage && (
          <button
            className="button primary"
            disabled={busy}
            onClick={() => setForm({ code: '', name: '', decimals: 0 })}
          >
            Create unit
          </button>
        )}
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      {form && (
        <section className="panel company-form">
          <h2>{form.id ? 'Edit unit ' + form.code : 'New unit'}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              const payload = form.id
                ? {
                    name: form.name,
                    decimals: Number(form.decimals),
                    active: form.active,
                    version: form.version,
                  }
                : { code: form.code, name: form.name, decimals: Number(form.decimals) };
              void call(
                'units' + (form.id ? '/' + form.id : ''),
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
            }}
          >
            {!form.id && (
              <label>
                Unit code
                <input
                  required
                  maxLength={20}
                  value={form.code}
                  disabled={busy}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                />
              </label>
            )}
            <label>
              Unit name
              <input
                required
                maxLength={60}
                value={form.name}
                disabled={busy}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label>
              Decimals
              <input
                required
                type="number"
                min={0}
                max={6}
                value={form.decimals}
                disabled={busy}
                onChange={(e) => setForm({ ...form, decimals: e.target.value })}
              />
            </label>
            {form.id && (
              <label>
                Status
                <select
                  value={String(form.active)}
                  disabled={busy}
                  onChange={(e) => setForm({ ...form, active: e.target.value === 'true' })}
                >
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </label>
            )}
            <button className="button primary" disabled={busy}>
              Save unit
            </button>{' '}
            <button type="button" className="button" disabled={busy} onClick={() => setForm(null)}>
              Cancel
            </button>
          </form>
        </section>
      )}
      <section className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Decimals</th>
              <th>Status</th>
              {canManage && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.code}</td>
                <td>{r.name}</td>
                <td>{r.decimals}</td>
                <td>{r.active ? 'Active' : 'Inactive'}</td>
                {canManage && (
                  <td>
                    <button
                      className="text-button"
                      aria-label={'Edit unit ' + r.code}
                      onClick={() => setForm(r)}
                    >
                      Edit
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {busy && <p role="status">Loading units…</p>}
        {!rows.length && !busy && (
          <div className="empty">
            {search
              ? 'No units match this search.'
              : canManage
                ? 'No units yet. Create NOS or KG, or import units from a CSV file.'
                : 'No units yet. Ask a planner or administrator to add them.'}
          </div>
        )}
        <div className="table-footer">
          <button className="button" disabled={!after || busy} onClick={() => setAfter(null)}>
            First page
          </button>
          <button className="button" disabled={!next || busy} onClick={() => setAfter(next)}>
            Next page
          </button>
        </div>
      </section>
    </>
  );
}

function BatchDetail({
  csrf,
  batchId,
  canImport,
  onChanged,
}: {
  csrf: string;
  batchId: string;
  canImport: (kind: string) => boolean;
  onChanged: () => void;
}) {
  const call = useApi(csrf);
  const [batch, setBatch] = useState<Batch | null>(null),
    [rows, setRows] = useState<any[]>([]),
    [errorsOnly, setErrorsOnly] = useState(true),
    [afterLine, setAfterLine] = useState(0),
    [nextLine, setNextLine] = useState<number | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [tick, setTick] = useState(0);
  const inProgress = batch && ['validating', 'committing'].includes(batch.status);
  useEffect(() => {
    let live = true;
    call('imports/' + batchId)
      .then((b) => {
        if (!live) return;
        setBatch((old) => {
          if (old && old.status !== b.status && !['validating', 'committing'].includes(b.status))
            onChanged();
          return b;
        });
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [batchId, tick]);
  useEffect(() => {
    if (!inProgress) return;
    const t = setTimeout(() => setTick((x) => x + 1), 1500);
    return () => clearTimeout(t);
  }, [inProgress, tick]);
  useEffect(() => {
    if (!batch || inProgress) return;
    let live = true;
    call(`imports/${batchId}/rows?errors=${errorsOnly}&afterLine=${afterLine}`)
      .then((d) => {
        if (!live) return;
        setRows(d.items);
        setNextLine(d.nextCursor);
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [batchId, batch?.status, batch?.version, errorsOnly, afterLine]);
  function act(action: string) {
    if (!batch) return;
    setBusy(true);
    setError('');
    setNotice('');
    call(`imports/${batch.id}/${action}`, 'POST', { version: batch.version })
      .then((d) => {
        setNotice(d.message);
        setTick((x) => x + 1);
        onChanged();
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }
  if (!batch)
    return error ? (
      <div className="error" role="alert">
        {error}
      </div>
    ) : (
      <p role="status">Loading import…</p>
    );
  const s = batch.summary || {};
  return (
    <section
      className="panel company-form import-detail"
      aria-label={'Import batch ' + batch.batch_no}
    >
      <div className="panel-heading">
        <h2>
          Batch #{batch.batch_no} · {batch.file_name}
        </h2>
        <span className={'status-pill ' + batch.status}>{statusLabel[batch.status]}</span>
      </div>
      <p role="status">{batch.message}</p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && <div className="notice">{notice}</div>}
      {/* A batch read from a workbook accounts for every row of the sheet before it is committed. */}
      <Reconciliation batch={batch} />
      <div className="import-stats">
        <div>
          <span>Rows</span>
          <strong>{batch.total_rows}</strong>
        </div>
        <div>
          <span>Valid</span>
          <strong>{batch.valid_rows}</strong>
        </div>
        <div>
          <span>With errors</span>
          <strong className={batch.error_rows ? 'warning' : ''}>{batch.error_rows}</strong>
        </div>
        {batch.status === 'committed' ? (
          <div>
            <span>Created / updated / unchanged</span>
            <strong>
              {s.created ?? 0} / {s.updated ?? 0} / {s.unchanged ?? 0}
            </strong>
          </div>
        ) : (
          <div>
            <span>Will create / update / unchanged</span>
            <strong>
              {s.create ?? 0} / {s.update ?? 0} / {s.unchanged ?? 0}
            </strong>
          </div>
        )}
      </div>
      {canImport(batch.kind) && (
        <div className="table-footer">
          {batch.status === 'validated' && batch.error_rows === 0 && (
            <button className="button primary" disabled={busy} onClick={() => act('commit')}>
              Commit import
            </button>
          )}
          {batch.error_rows > 0 && (
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                download(`imports/${batch.id}/errors.csv`, 'errors.csv').catch((e) =>
                  setError(e.message),
                )
              }
            >
              Download error file
            </button>
          )}
          {['validated', 'failed'].includes(batch.status) && (
            <>
              <button className="button" disabled={busy} onClick={() => act('revalidate')}>
                Retry validation
              </button>
              <button className="button" disabled={busy} onClick={() => act('cancel')}>
                Cancel import
              </button>
            </>
          )}
        </div>
      )}
      {!inProgress && (
        <>
          <label className="permission-future">
            <input
              type="checkbox"
              checked={errorsOnly}
              onChange={(e) => {
                setAfterLine(0);
                setErrorsOnly(e.target.checked);
              }}
            />
            Show only rows with errors
          </label>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Values</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.line_no}>
                    <td>{r.line_no}</td>
                    <td>
                      {Object.entries(r.data)
                        .filter(([k]) => !k.startsWith('_'))
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(' · ')}
                    </td>
                    <td>
                      {r.errors.length
                        ? r.errors.map((e: any) => e.message).join(' ')
                        : r.action || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && (
              <div className="empty">
                {errorsOnly ? 'No rows with errors.' : 'No rows to preview.'}
              </div>
            )}
          </div>
          <div className="table-footer">
            <button className="button" disabled={!afterLine} onClick={() => setAfterLine(0)}>
              First rows
            </button>
            <button className="button" disabled={!nextLine} onClick={() => setAfterLine(nextLine!)}>
              More rows
            </button>
          </div>
        </>
      )}
    </section>
  );
}

type FieldInfo = {
  name: string;
  label: string;
  type: string;
  required: boolean;
  immutable: boolean;
  options?: string[];
  max?: number;
};
// One planning tool per menu entry, with the handover's own names.
const TOOL_TABS: Record<string, string> = {
  'Month Shape': 'month',
  'Recommended Buffers': 'recommended',
  'Buffer vs MTO': 'mto',
  'Events & Seasons': 'events',
  'Scheme Intake': 'schemes',
  'Target Mode': 'target',
  'Space Mode': 'space',
  Assumptions: 'assumptions',
};

type KindInfo = {
  kind: string;
  label: string;
  singular: string;
  canManage: boolean;
  fields: FieldInfo[];
};
const refHint: Record<string, string> = {
  base_unit: 'Unit code, e.g. KG',
  purchase_unit: 'Blank = item base unit',
  from_unit: 'Unit code, e.g. BOX',
  to_unit: 'Unit code, e.g. NOS',
  item: 'Item code',
  supplier: 'Supplier code',
};

function display(field: FieldInfo, value: unknown) {
  if (value === null || value === undefined || value === '') return '—';
  if (field.type === 'bool') return value ? 'Yes' : 'No';
  if (field.type === 'decimal') return String(Number(value));
  return String(value);
}

function MasterTable({
  csrf,
  info,
  refreshKey,
}: {
  csrf: string;
  info: KindInfo;
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const [rows, setRows] = useState<any[]>([]),
    [form, setForm] = useState<any>(null),
    [fieldErrors, setFieldErrors] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [cursors, setCursors] = useState<string[]>([]),
    [next, setNext] = useState<string | null>(null),
    [revision, setRevision] = useState(0);
  const cursor = cursors[cursors.length - 1];
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError('');
    call(`masters/${info.kind}?q=${encodeURIComponent(search)}${cursor ? '&cursor=' + cursor : ''}`)
      .then((d) => {
        if (!live) return;
        setRows(d.items);
        setNext(d.nextCursor);
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [info.kind, search, cursor, revision, refreshKey]);
  function open(row: any) {
    setFieldErrors({});
    setError('');
    if (!row) {
      const blank: any = {};
      for (const f of info.fields) blank[f.name] = f.type === 'bool' ? false : '';
      setForm(blank);
    } else {
      const copy: any = { id: row.id, version: row.version, active: row.active };
      for (const f of info.fields)
        copy[f.name] =
          f.type === 'bool'
            ? !!row[f.name]
            : row[f.name] === null || row[f.name] === undefined
              ? ''
              : f.type === 'decimal'
                ? String(Number(row[f.name]))
                : String(row[f.name]);
      setForm(copy);
    }
  }
  function save() {
    setBusy(true);
    setError('');
    setFieldErrors({});
    const payload: any = {};
    for (const f of info.fields) if (!(form.id && f.immutable)) payload[f.name] = form[f.name];
    if (form.id) Object.assign(payload, { active: form.active, version: form.version });
    call(`masters/${info.kind}${form.id ? '/' + form.id : ''}`, form.id ? 'PATCH' : 'POST', payload)
      .then((d) => {
        setNotice(d.message);
        setForm(null);
        setRevision((x) => x + 1);
      })
      .catch((e) => {
        setError(e.fields?.length ? 'Fix the highlighted fields and save again.' : e.message);
        setFieldErrors(Object.fromEntries((e.fields ?? []).map((f: any) => [f.column, f.message])));
      })
      .finally(() => setBusy(false));
  }
  return (
    <>
      <div className="toolbar">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setCursors([]);
            setSearch(query);
          }}
        >
          <input
            aria-label={`${info.label} search`}
            placeholder="Code starts with…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />{' '}
          <button className="button" disabled={busy}>
            Search
          </button>
        </form>
        {info.canManage && (
          <button className="button primary" disabled={busy} onClick={() => open(null)}>
            Create {info.singular}
          </button>
        )}
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      {form && (
        <section className="panel company-form">
          <h2>{form.id ? `Edit ${info.singular}` : `New ${info.singular}`}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            {info.fields.map((f) => {
              const locked = busy || (!!form.id && f.immutable);
              const set = (v: unknown) => setForm({ ...form, [f.name]: v });
              return (
                <label key={f.name}>
                  {f.label}
                  {f.required ? ' *' : ''}
                  {f.type === 'enum' ? (
                    <select
                      value={form[f.name]}
                      disabled={locked}
                      onChange={(e) => set(e.target.value)}
                    >
                      {!f.required && <option value="">—</option>}
                      {f.required && !form[f.name] && <option value="">Choose…</option>}
                      {f.options!.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : f.type === 'bool' ? (
                    <input
                      type="checkbox"
                      checked={!!form[f.name]}
                      disabled={locked}
                      onChange={(e) => set(e.target.checked)}
                    />
                  ) : (
                    <input
                      value={form[f.name]}
                      disabled={locked}
                      inputMode={['int', 'decimal'].includes(f.type) ? 'decimal' : undefined}
                      placeholder={refHint[f.name] ?? ''}
                      maxLength={f.max ?? 60}
                      onChange={(e) => set(e.target.value)}
                    />
                  )}
                  {fieldErrors[f.name] && <small className="warning">{fieldErrors[f.name]}</small>}
                </label>
              );
            })}
            {form.id && (
              <label>
                Status
                <select
                  value={String(form.active)}
                  disabled={busy}
                  onChange={(e) => setForm({ ...form, active: e.target.value === 'true' })}
                >
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </label>
            )}
            <button className="button primary" disabled={busy}>
              Save {info.singular}
            </button>{' '}
            <button type="button" className="button" disabled={busy} onClick={() => setForm(null)}>
              Cancel
            </button>
          </form>
        </section>
      )}
      <section className="panel table-wrap">
        <table>
          <thead>
            <tr>
              {info.fields.map((f) => (
                <th key={f.name}>{f.label}</th>
              ))}
              <th>Status</th>
              {info.canManage && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                {info.fields.map((f) => (
                  <td key={f.name}>{display(f, r[f.name])}</td>
                ))}
                <td>{r.active ? 'Active' : 'Inactive'}</td>
                {info.canManage && (
                  <td>
                    <button
                      className="text-button"
                      aria-label={`Edit ${info.singular} ${r.code ?? r.item ?? r.from_unit ?? ''}`}
                      onClick={() => open(r)}
                    >
                      Edit
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {busy && <p role="status">Loading {info.label.toLowerCase()}…</p>}
        {!rows.length && !busy && (
          <div className="empty">
            {search
              ? 'No records match this search.'
              : info.canManage
                ? `No ${info.label.toLowerCase()} yet. Create one or import a CSV file from Imports.`
                : `No ${info.label.toLowerCase()} yet.`}
          </div>
        )}
        <div className="table-footer">
          <button
            className="button"
            disabled={!cursors.length || busy}
            onClick={() => setCursors([])}
          >
            First page
          </button>
          <button
            className="button"
            disabled={!next || busy}
            onClick={() => setCursors([...cursors, next!])}
          >
            Next page
          </button>
        </div>
      </section>
    </>
  );
}

// The import types a person may use, with the permission each one asks for. Shared by the CSV
// screen and the file screen so both offer exactly the same list.
function importOptions(permissions: string[], kinds: KindInfo[]) {
  return [
    {
      kind: 'units',
      label: 'Units of measure',
      canManage: permissions.includes('masters.manage'),
    },
    ...kinds.map((k) => ({ kind: k.kind, label: k.label, canManage: k.canManage })),
    ...[
      ['resources', 'Resources'],
      ['boms', 'BOM lines'],
      ['routings', 'Routing operations'],
      ['stock_locations', 'Stock locations'],
    ].map(([kind, label]) => ({ kind, label, canManage: permissions.includes('masters.manage') })),
    {
      kind: 'stock_movements',
      label: 'Stock movements',
      canManage: permissions.includes('inventory.move') || permissions.includes('inventory.adjust'),
    },
    {
      kind: 'sales_orders',
      label: 'Customer order lines',
      canManage: permissions.includes('orders.create'),
    },
    {
      kind: 'production_orders',
      label: 'Production orders',
      canManage: permissions.includes('orders.create'),
    },
    {
      kind: 'purchase_orders',
      label: 'Purchase order lines',
      canManage: permissions.includes('purchase.create'),
    },
    {
      kind: 'demand_history',
      label: 'Demand history',
      canManage: permissions.includes('demand.import'),
    },
    {
      kind: 'buffer_settings',
      label: 'Buffer settings',
      canManage: permissions.includes('buffers.manage'),
    },
  ];
}

// AV-12: the same batch view as the CSV screen, under the file and mapping steps.
function FileImport({
  csrf,
  permissions,
  refreshKey,
  kinds,
}: {
  csrf: string;
  permissions: string[];
  refreshKey: number;
  kinds: KindInfo[];
}) {
  const options = importOptions(permissions, kinds);
  const canImport = (kind: string) =>
    permissions.includes('imports.create') && !!options.find((o) => o.kind === kind)?.canManage;
  const [selected, setSelected] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  return (
    <>
      <RawImport
        csrf={csrf}
        permissions={permissions}
        kinds={options}
        onStaged={(batchId) => setSelected(batchId)}
      />
      {selected && (
        <BatchDetail
          key={selected + revision}
          csrf={csrf}
          batchId={selected}
          canImport={canImport}
          onChanged={() => setRevision((x) => x + 1)}
        />
      )}
    </>
  );
}

function Imports({
  csrf,
  permissions,
  refreshKey,
  kinds,
}: {
  csrf: string;
  permissions: string[];
  refreshKey: number;
  kinds: KindInfo[];
}) {
  const call = useApi(csrf);
  const options = importOptions(permissions, kinds);
  const labelOf = (kind: string) => options.find((o) => o.kind === kind)?.label ?? kind;
  const canImport = (kind: string) =>
    permissions.includes('imports.create') && !!options.find((o) => o.kind === kind)?.canManage;
  const importable = options.filter((o) => canImport(o.kind));
  const [kind, setKind] = useState(importable[0]?.kind ?? 'units');
  const [batches, setBatches] = useState<Batch[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [file, setFile] = useState<File | null>(null),
    [fileKey, setFileKey] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [before, setBefore] = useState<string | null>(null),
    [next, setNext] = useState<string | null>(null),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    call('imports' + (before ? '?before=' + before : ''))
      .then((d) => {
        if (!live) return;
        setBatches(d.items);
        setNext(d.nextCursor);
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [before, revision, refreshKey]);
  async function upload() {
    setError('');
    setNotice('');
    if (!file) return setError('Choose a CSV file first.');
    if (!file.name.toLowerCase().endsWith('.csv'))
      return setError('Only .csv files can be imported. Save the sheet as CSV UTF-8.');
    if (file.size > MAX_BYTES)
      return setError('The file is larger than 5 MB. Split it into smaller files.');
    setBusy(true);
    try {
      const text = await file.text();
      const r = await fetch('/api/imports/' + kind, {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv', 'X-CSRF-Token': csrf, 'X-File-Name': file.name },
        body: text,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw Error(d.error?.message || 'Upload failed. Please retry.');
      setNotice(d.message);
      setSelected(d.id);
      setFile(null);
      setFileKey((k) => k + 1);
      setBefore(null);
      setRevision((x) => x + 1);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {importable.length > 0 && (
        <section className="panel company-form">
          <h2>Import data</h2>
          <p>
            1. Choose what to import · 2. Download its template · 3. Fill one row per record · 4.
            Upload the CSV · 5. Review errors and preview · 6. Commit. Nothing is saved until you
            commit. Import units first, then items and suppliers, then item sourcing; stock
            locations before stock movements. Stock movements need a unique external reference per
            row, so a file imported twice never posts stock twice.
          </p>
          <div className="toolbar">
            <label>
              Import type
              <select value={kind} disabled={busy} onChange={(e) => setKind(e.target.value)}>
                {importable.map((o) => (
                  <option key={o.kind} value={o.kind}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                download('imports/templates/' + kind, kind + '-template.csv').catch((e) =>
                  setError(e.message),
                )
              }
            >
              Download template
            </button>
            <label>
              CSV file
              <input
                key={fileKey}
                type="file"
                accept=".csv,text/csv"
                disabled={busy}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <button
              className="button primary"
              disabled={busy || !file}
              onClick={() => void upload()}
            >
              {busy ? 'Uploading…' : 'Upload and validate'}
            </button>
          </div>
        </section>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      {selected && (
        <BatchDetail
          key={selected}
          csrf={csrf}
          batchId={selected}
          canImport={canImport}
          onChanged={() => setRevision((x) => x + 1)}
        />
      )}
      <section className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>Batch</th>
              <th>Type</th>
              <th>File</th>
              <th>Rows</th>
              <th>Errors</th>
              <th>Status</th>
              <th>Uploaded</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id}>
                <td>#{b.batch_no}</td>
                <td>{labelOf(b.kind)}</td>
                <td>{b.file_name}</td>
                <td>{b.total_rows}</td>
                <td>{b.error_rows}</td>
                <td>
                  <span className={'status-pill ' + b.status}>{statusLabel[b.status]}</span>
                </td>
                <td>{new Date(b.created_at).toLocaleString()}</td>
                <td>
                  <button
                    className="text-button"
                    aria-label={'Open batch ' + b.batch_no}
                    onClick={() => setSelected(b.id)}
                  >
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!batches.length && (
          <div className="empty">
            {importable.length
              ? 'No imports yet. Download a template to start.'
              : 'No imports yet.'}
          </div>
        )}
        <div className="table-footer">
          <button className="button" disabled={!before} onClick={() => setBefore(null)}>
            Latest
          </button>
          <button className="button" disabled={!next} onClick={() => setBefore(next)}>
            Older imports
          </button>
        </div>
      </section>
    </>
  );
}

// The module's own menu: the two engines of the handover with their screens, then everything the
// demo keeps in its Masters module. Pure, so the shell can draw it in the sidebar.
function availabilityMenu(permissions: string[], kinds: KindInfo[]) {
  const order = ['items', 'suppliers', 'item_suppliers', 'customers', 'unit_conversions'];
  const has = (p: string) => permissions.includes(p);
  // The menu follows the Nilkamal simulation handover (21-Sep-2026): Availability is two engines,
  // Scheduling & Execution (TOC / DBR) and Materials Planning (DDMRP), with the demo's own screen
  // names. Everything the demo keeps in its Masters module sits in the third group here. Every
  // entry is gated by the permission its screen needs, so a menu never offers what a person
  // cannot open.
  const SCHEDULING: [string, string][] = [
    ['Overview', 'planning.read'],
    ['Capacity & Changeover', 'masters.read'],
    ['Product Routing', 'masters.read'],
    ['Changeover Simulator', 'planning.read'],
    ['Scheduler', 'planning.read'],
    ['Resource Load Graph', 'planning.read'],
    ['Buffer Board & Exceptions', 'planning.read'],
    ['Gantt View', 'planning.read'],
    ['Lead Time Reality', 'planning.read'],
    ['Release Schedule', 'planning.read'],
    ['Insert an order', 'planning.read'],
    ['Order OTIF', 'planning.read'],
    ['Execution Loop', 'planning.read'],
    ['Master-Data Audit', 'planning.read'],
    ['Work Orders & Downtime', 'planning.read'],
    ['Club / date scenarios', 'planning.read'],
    ['Pending Orders to Plan', 'planning.read'],
  ];
  const MATERIALS: [string, string][] = [
    ['Materials Overview', 'planning.read'],
    ['Stock & Service', 'inventory.read'],
    ['Recommended Buffers', 'planning.read'],
    ['Planning Priorities', 'planning.read'],
    ['Workbench', 'planning.read'],
    ['Demand History', 'orders.read'],
    ['Buffer vs MTO', 'planning.read'],
    ['Month Shape', 'planning.read'],
    ['Target Mode', 'planning.read'],
    ['Events & Seasons', 'planning.read'],
    ['Scheme Intake', 'planning.read'],
    ['Space Mode', 'planning.read'],
    ['Material expedites', 'planning.read'],
    ['Proposed Orders', 'purchase.read'],
    ['Alerts', 'planning.read'],
    ['Parts & Buffer Profiles', 'planning.read'],
    ['Buffers & POs', 'purchase.read'],
    ['Assumptions', 'planning.read'],
  ];
  const MASTERS: [string, string][] = [
    ['Readiness', 'masters.read'],
    ['Units', 'masters.read'],
    ...order
      .map((k) => kinds.find((x) => x.kind === k)?.label)
      .filter(Boolean)
      .map((label) => [label as string, 'masters.read'] as [string, string]),
    ['Calendars', 'masters.read'],
    ['BOMs', 'masters.read'],
    ['Stock locations', 'masters.read'],
    ['Stock', 'inventory.read'],
    ['Customer orders', 'orders.read'],
    ['Production orders', 'orders.read'],
    ['Purchase orders', 'purchase.read'],
    ['Plant planning', 'planning.read'],
    ['Network', 'planning.read'],
    ['Imports', 'masters.read'],
    ['File import', 'masters.read'],
  ];
  const allowed = (list: [string, string][]) => list.filter(([, p]) => has(p)).map(([t]) => t);
  // Screens that work on one plant show the plant picker above them.
  const companyWide = new Set([
    'Units',
    'BOMs',
    'Imports',
    'File import',
    'Network',
    'Parts & Buffer Profiles',
    ...order.map((k) => kinds.find((x) => x.kind === k)?.label).filter(Boolean),
  ] as string[]);
  const groups: [string, string, string[]][] = [
    ['Scheduling & Execution', 'TOC / DBR engine', allowed(SCHEDULING)],
    ['Materials Planning', 'DDMRP engine', allowed(MATERIALS)],
    ['Masters & setup', 'one dataset behind every screen', allowed(MASTERS)],
  ];
  return { groups, companyWide, order };
}

// The screen list lives in the shell's sidebar (the handover puts a module's screens under the
// module). When the shell passes onNav, this component reports its menu upwards and stops drawing
// its own tab strip; on its own it still works with the tabs, which is what the tests use.
export function Availability({
  csrf,
  permissions,
  refreshKey,
  tab: tabProp,
  onTab,
  onNav,
}: {
  csrf: string;
  permissions: string[];
  refreshKey: number;
  tab?: string;
  onTab?: (tab: string) => void;
  onNav?: (groups: [string, string, string[]][]) => void;
}) {
  const [ownTab, setOwnTab] = useState('Readiness');
  const tab = tabProp ?? ownTab;
  const setTab = onTab ?? setOwnTab;
  const [plantId, setPlantId] = useState<string | null>(null);
  const canManage = permissions.includes('masters.manage');
  const [kinds, setKinds] = useState<KindInfo[] | null>(null),
    [error, setError] = useState('');
  const call = useApi(csrf);
  const canRead = permissions.includes('masters.read');
  useEffect(() => {
    if (!canRead) return;
    let live = true;
    call('masters')
      .then((d) => live && setKinds(d.kinds))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [canRead, refreshKey]);
  // The menu is worked out as soon as the master data is known, and reported to the shell, which
  // draws it in the sidebar. This sits above the early returns: a hook may not be conditional.
  const menu = kinds ? availabilityMenu(permissions, kinds) : null;
  const menuKey = menu ? JSON.stringify(menu.groups) : '';
  useEffect(() => {
    if (menuKey) onNav?.(JSON.parse(menuKey));
  }, [menuKey, onNav]);
  if (!canRead)
    return (
      <section className="panel availability">
        <span className="badge">SETUP IN PROGRESS</span>
        <h2>Planning results will appear here.</h2>
        <p>
          Planning data is being prepared. Ask your company administrator for master data access to
          view readiness, masters and imports.
        </p>
      </section>
    );
  if (error)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!kinds) return <p role="status">Loading planning data…</p>;
  const { groups, companyWide, order } = menu!;
  const currentGroup = groups.find(([, , list]) => list.includes(tab)) ?? null;
  const has = (p: string) => permissions.includes(p);
  const current = kinds.find((k) => k.label === tab);
  return (
    <>
      {/* In the shell the screens live in the sidebar; here the engine being worked in is named,
          with its own screens as chips, exactly one engine at a time. */}
      {onNav ? (
        currentGroup && (
          <nav className="engine-bar" aria-label={`${currentGroup[0]} screens`}>
            <div className="engine-name">
              <span>Availability</span>
              <strong>{currentGroup[0]}</strong>
              <small>{currentGroup[1]}</small>
            </div>
            {/* The same screens as the sidebar, within reach of the content. They are plain
                buttons: the sidebar is the navigation, this is a shortcut. */}
            <div className="engine-chips">
              {currentGroup[2].map((t) => (
                <button
                  key={t}
                  aria-current={tab === t ? 'page' : undefined}
                  className={tab === t ? 'selected' : ''}
                  onClick={() => setTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </nav>
        )
      ) : (
        <nav className="module-nav" aria-label="Availability sections">
          {groups.map(([group, engine, list]) => (
            <div key={group} className="subtabs">
              <span className="subtabs-label">
                {group}
                <small>{engine}</small>
              </span>
              <div className="subtabs-tabs" role="tablist" aria-label={`Availability ${group}`}>
                {list.map((t) => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={tab === t}
                    className={tab === t ? 'selected' : ''}
                    onClick={() => setTab(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
      )}
      {!companyWide.has(tab) && <PlantPicker csrf={csrf} value={plantId} onChange={setPlantId} />}
      {tab === 'Readiness' && <Readiness csrf={csrf} refreshKey={refreshKey} />}
      {tab === 'Readiness' && plantId && (
        <PlantReadiness csrf={csrf} plantId={plantId} refreshKey={refreshKey} />
      )}
      {tab === 'Calendars' && plantId && (
        <Calendars csrf={csrf} plantId={plantId} canManage={canManage} refreshKey={refreshKey} />
      )}
      {tab === 'Capacity & Changeover' && plantId && (
        <Resources csrf={csrf} plantId={plantId} canManage={canManage} refreshKey={refreshKey} />
      )}
      {tab === 'BOMs' && <Boms csrf={csrf} canManage={canManage} refreshKey={refreshKey} />}
      {tab === 'Product Routing' && plantId && (
        <Routings
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          canManage={canManage}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Stock locations' && plantId && (
        <StockLocations
          csrf={csrf}
          plantId={plantId}
          canManage={canManage}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Stock' && plantId && (
        <Stock
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Customer orders' && plantId && (
        <CustomerOrders
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Production orders' && plantId && (
        <ProductionOrders
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Buffers & POs' && plantId && (
        <PurchaseOrders
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Demand History' && plantId && (
        <DemandHistory key={plantId} csrf={csrf} plantId={plantId} refreshKey={refreshKey} />
      )}
      {tab === 'Parts & Buffer Profiles' && (
        <BufferProfiles csrf={csrf} canManage={has('buffers.manage')} refreshKey={refreshKey} />
      )}
      {tab === 'Workbench' && plantId && (
        <BufferSettings
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          canManage={has('buffers.manage')}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Buffer Board & Exceptions' && plantId && (
        <BufferBoard
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Overview' && plantId && (
        <SchedulingOverview key={plantId} csrf={csrf} plantId={plantId} refreshKey={refreshKey} />
      )}
      {tab === 'Stock & Service' && plantId && (
        <StockAndService key={plantId} csrf={csrf} plantId={plantId} refreshKey={refreshKey} />
      )}
      {tab === 'Materials Overview' && plantId && (
        <MaterialsOverview key={plantId} csrf={csrf} plantId={plantId} refreshKey={refreshKey} />
      )}
      {tab === 'Changeover Simulator' && plantId && (
        <ChangeoverSimulator key={plantId} csrf={csrf} plantId={plantId} refreshKey={refreshKey} />
      )}
      {tab === 'Lead Time Reality' && plantId && (
        <LeadTimeRealityList key={plantId} csrf={csrf} plantId={plantId} refreshKey={refreshKey} />
      )}
      {['Scheduler', 'Club / date scenarios'].includes(tab) && plantId && (
        <Scheduler
          key={plantId + tab}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
          focus={tab === 'Scheduler' ? 'schedule' : 'decisions'}
        />
      )}
      {tab === 'Insert an order' && plantId && (
        <InsertOrder
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Pending Orders to Plan' && plantId && (
        <PendingOrders
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Material expedites' && plantId && (
        <Expedites
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {['Planning Priorities', 'Release Schedule', 'Alerts'].includes(tab) && plantId && (
        <Today
          key={plantId + tab}
          csrf={csrf}
          plantId={plantId}
          refreshKey={refreshKey}
          focus={
            tab === 'Alerts' ? 'alerts' : tab === 'Release Schedule' ? 'releases' : 'priorities'
          }
        />
      )}
      {tab === 'Order OTIF' && plantId && (
        <Delivery key={plantId} csrf={csrf} plantId={plantId} refreshKey={refreshKey} />
      )}
      {tab === 'Execution Loop' && plantId && (
        <Execution
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Work Orders & Downtime' && plantId && (
        <Downtime
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Master-Data Audit' && plantId && (
        <CycleTimeAudit
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {TOOL_TABS[tab] && plantId && (
        <PlanningTools
          key={plantId + tab}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
          only={TOOL_TABS[tab]}
        />
      )}
      {tab === 'Network' && plantId && (
        <Network key={plantId} csrf={csrf} plantId={plantId} refreshKey={refreshKey} />
      )}
      {tab === 'Gantt View' && plantId && (
        <Gantt key={plantId} csrf={csrf} plantId={plantId} refreshKey={refreshKey} />
      )}
      {tab === 'Resource Load Graph' && plantId && (
        <ResourceLoad key={plantId} csrf={csrf} plantId={plantId} refreshKey={refreshKey} />
      )}
      {tab === 'Plant planning' && plantId && (
        <PlanningSettings
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          canManage={has('buffers.manage')}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Proposed Orders' && plantId && (
        <PurchaseProposals
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Units' && <Units csrf={csrf} permissions={permissions} refreshKey={refreshKey} />}
      {current && (
        <MasterTable key={current.kind} csrf={csrf} info={current} refreshKey={refreshKey} />
      )}
      {tab === 'File import' && (
        <FileImport csrf={csrf} permissions={permissions} refreshKey={refreshKey} kinds={kinds} />
      )}
      {tab === 'Imports' && (
        <Imports csrf={csrf} permissions={permissions} refreshKey={refreshKey} kinds={kinds} />
      )}
    </>
  );
}
