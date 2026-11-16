// AV-12 / RCH-0: the import screens. A module hands in the masters its own people may load, so
// the same two screens — a CSV import and an ERP workbook import — serve Availability's planning
// masters and Reach's field masters without either knowing about the other.
import { useEffect, useRef, useState } from 'react';
import { download, useApi } from './api-client';
import { RawImport, Reconciliation } from './raw-import';
import type { KindInfo } from './master-table';

export type Batch = {
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
export const MAX_BYTES = 5 * 1024 * 1024;
export const statusLabel: Record<string, string> = {
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

export function BatchDetail({
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

// The import types a person may use, with the permission each one asks for. Shared by the CSV
// screen and the file screen so both offer exactly the same list.
export function importOptions(permissions: string[], kinds: KindInfo[], module = 'Availability') {
  const mine = kinds
    .filter((k) => k.module === module)
    .map((k) => ({ kind: k.kind, label: k.label, canManage: k.canManage }));
  // Reach has field masters and nothing else to import yet. Availability also has the imports
  // that are not masters at all: stock movements, orders, demand history, buffer settings.
  if (module !== 'Availability') return mine;
  return [
    {
      kind: 'units',
      label: 'Units of measure',
      canManage: permissions.includes('masters.manage'),
    },
    ...mine,
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
export function FileImport({
  csrf,
  permissions,
  refreshKey,
  kinds,
  module = 'Availability',
}: {
  csrf: string;
  permissions: string[];
  refreshKey: number;
  kinds: KindInfo[];
  module?: string;
}) {
  const options = importOptions(permissions, kinds, module);
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

export function Imports({
  csrf,
  permissions,
  refreshKey,
  kinds,
  module = 'Availability',
}: {
  csrf: string;
  permissions: string[];
  refreshKey: number;
  module?: string;
  kinds: KindInfo[];
}) {
  const call = useApi(csrf);
  const options = importOptions(permissions, kinds, module);
  const mineOnly = new Set(options.map((o) => o.kind));
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
        // The batch list is company-wide; this screen shows only the kinds it offers, so a
        // Reach import and a planning import never appear on each other's screen.
        setBatches(d.items.filter((b: Batch) => mineOnly.has(b.kind)));
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
            commit.{' '}
            {module === 'Availability'
              ? `Import units first, then items and suppliers, then item sourcing; stock locations
                 before stock movements. Stock movements need a unique external reference per row,
                 so a file imported twice never posts stock twice.`
              : `Import territories and rep grades before field reps: a rep needs both of them to
                 exist already.`}
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
