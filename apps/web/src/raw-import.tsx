// AV-12 file import (Nilkamal simulation handover, 21-Sep-2026: "Import contracts and source
// traps"). An ERP export is uploaded as it is, one of its sheets is read, its columns are mapped
// to an import type, and the reading is reconciled before anything is committed. The mapping is
// always shown as a column position, because SAP repeats its header names.
import { useEffect, useState } from 'react';
import { useApi } from './api-client';
import { Messages } from './plant-model';

const MAX_BYTES = 40 * 1024 * 1024;
const TRANSFORMS: [string, string][] = [
  ['text', 'Text'],
  ['number', 'Number'],
  ['date', 'Date'],
  ['unit', 'Unit of measure'],
  ['upper', 'Text in capitals'],
];
const DATE_FORMATS: [string, string][] = [
  ['auto', 'Read what is unambiguous'],
  ['dmy', 'Day first (31/07/2026)'],
  ['mdy', 'Month first (07/31/2026)'],
  ['ymd', 'Year first (2026/07/31)'],
  ['serial', 'Excel day number'],
];
const OPERATORS: [string, string][] = [
  ['equals', 'is'],
  ['not_equals', 'is not'],
  ['blank', 'is blank'],
  ['not_blank', 'is not blank'],
  ['zero', 'is zero'],
  ['not_zero', 'is not zero'],
];
const num = (v: unknown) =>
  v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('en-IN');
// A field whose name says what it holds gets the obvious conversion the first time it is mapped.
const transformFor = (field: string) =>
  /date|_from|_to$/.test(field)
    ? 'date'
    : field === 'unit' || field === 'base_unit' || field === 'purchase_unit'
      ? 'unit'
      : /quantity|cost|minutes|pct|days|factor|moq|multiple|decimals|count|line_no|sequence/.test(
            field,
          )
        ? 'number'
        : 'text';

export function RawImport({
  csrf,
  permissions,
  kinds,
  onStaged,
}: {
  csrf: string;
  permissions: string[];
  kinds: { kind: string; label: string; canManage: boolean }[];
  onStaged: (batchId: string) => void;
}) {
  const call = useApi(csrf);
  const canImport = permissions.includes('imports.create');
  const importable = kinds.filter((k) => k.canManage);
  const [files, setFiles] = useState<any[]>([]),
    [fileId, setFileId] = useState(''),
    [file, setFile] = useState<File | null>(null),
    [fileKey, setFileKey] = useState(0),
    [sheet, setSheet] = useState(''),
    [headerRow, setHeaderRow] = useState('1'),
    [kind, setKind] = useState(importable[0]?.kind ?? ''),
    [preview, setPreview] = useState<any>(null),
    [columns, setColumns] = useState<Record<string, any>>({}),
    [options, setOptions] = useState<any>({
      decimal: 'auto',
      dateFormat: 'auto',
      skipBlankRows: true,
      aliases: '',
      filters: [] as any[],
      combine: [] as string[],
      sum: '',
    }),
    [saveAs, setSaveAs] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    call('imports/raw/files')
      .then((d) => live && setFiles(d.items))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [tick]);

  const chosen = files.find((f) => f.id === fileId);

  async function upload() {
    setError('');
    setNotice('');
    if (!file) return setError('Choose an .xlsx or .xls file first.');
    if (!/\.(xlsx|xls)$/i.test(file.name))
      return setError('Only .xlsx and .xls workbooks can be read here. CSV files go to Imports.');
    if (file.size > MAX_BYTES)
      return setError('This file is larger than 40 MB. Export fewer columns or split it.');
    setBusy(true);
    try {
      const r = await fetch('/api/imports/raw/files', {
        method: 'POST',
        headers: {
          'Content-Type': file.name.toLowerCase().endsWith('.xls')
            ? 'application/vnd.ms-excel'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'X-CSRF-Token': csrf,
          'X-File-Name': file.name,
        },
        body: await file.arrayBuffer(),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw Error(d.error?.message || 'Upload failed. Please retry.');
      setNotice(d.message);
      setFileId(d.id);
      setSheet(d.sheets[0]?.name ?? '');
      setPreview(null);
      setFile(null);
      setFileKey((k) => k + 1);
      setTick((x) => x + 1);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function read() {
    setBusy(true);
    setError('');
    setNotice('');
    call(
      `imports/raw/files/${fileId}/preview?sheet=${encodeURIComponent(sheet)}&headerRow=${headerRow}&kind=${kind}`,
    )
      .then((d) => {
        setPreview(d);
        setSheet(d.sheet);
        // Start from the suggestion; every column is a position, whatever it was matched by.
        setColumns(
          Object.fromEntries(
            Object.entries(d.suggestion?.columns ?? {}).map(([field, c]: any) => [
              field,
              { by: 'position', index: c.index, transform: transformFor(field) },
            ]),
          ),
        );
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }

  function loadMapping(mapping: any) {
    setColumns(
      Object.fromEntries(
        Object.entries(mapping.columns ?? {}).map(([field, c]: any) => [field, { ...c }]),
      ),
    );
    setOptions({
      decimal: mapping.options?.decimal ?? 'auto',
      dateFormat: mapping.options?.dateFormat ?? 'auto',
      skipBlankRows: mapping.options?.skipBlankRows !== false,
      aliases: Object.entries(mapping.options?.uomAliases ?? {})
        .map(([from, to]) => `${from}=${to}`)
        .join(', '),
      filters: mapping.options?.filters ?? [],
      combine: mapping.options?.combine ?? [],
      sum: mapping.options?.sum ?? '',
    });
    setNotice(`Mapping ${mapping.code} loaded. Check it against this sheet before staging.`);
  }

  function stage() {
    setBusy(true);
    setError('');
    setNotice('');
    const uomAliases: Record<string, string> = {};
    for (const pair of String(options.aliases || '').split(',')) {
      const [from, to] = pair.split('=').map((s: string) => s.trim());
      if (from && to) uomAliases[from.toUpperCase()] = to.toUpperCase();
    }
    call(`imports/raw/files/${fileId}/stage`, 'POST', {
      kind,
      sheet,
      headerRow: Number(headerRow),
      firstDataRow: Number(headerRow) + 1,
      columns,
      options: {
        decimal: options.decimal,
        dateFormat: options.dateFormat,
        skipBlankRows: options.skipBlankRows,
        uomAliases,
        filters: options.filters.filter((f: any) => f.field && f.op),
        combine: options.combine.filter((f: string) => columns[f]),
        sum: options.combine.length ? options.sum : '',
      },
      ...(saveAs ? { saveAs, saveName: saveAs } : {}),
    })
      .then((d) => {
        setNotice(d.message);
        onStaged(d.id);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }

  const setColumn = (field: string, patch: any) =>
    setColumns((c) => ({ ...c, [field]: { ...(c[field] ?? {}), ...patch } }));
  const unmap = (field: string) =>
    setColumns((c) => {
      const { [field]: _gone, ...rest } = c;
      return rest;
    });
  const mappedCount = Object.keys(columns).length;

  if (!canImport)
    return (
      <section className="panel">
        <p className="panel-body">
          You can see imports but not create them. Ask for the "Upload and commit import files"
          permission.
        </p>
      </section>
    );

  return (
    <>
      <Messages error={error} notice={notice} />
      <section className="panel company-form">
        <h2>Import a file from the ERP</h2>
        <p>
          1. Upload the export as it is (.xlsx or .xls, up to 40 MB) · 2. Choose the sheet and the
          row its headers are on · 3. Say which column feeds each field · 4. Read the reconciliation
          · 5. Commit. Nothing is saved until you commit, and the file itself is kept so every
          number can be traced back to its row.
        </p>
        <div className="toolbar">
          <label>
            Workbook
            <input
              key={fileKey}
              type="file"
              accept=".xlsx,.xls"
              disabled={busy}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <button className="button primary" disabled={busy || !file} onClick={() => void upload()}>
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Files uploaded</h2>
            <p className="panel-sub">
              The file stays here after it is imported, so a number can always be traced back to the
              row it came from.
            </p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Sheets</th>
                <th className="num">Size</th>
                <th className="num">Imports</th>
                <th>Uploaded</th>
                <th className="actions">Use</th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.id} data-file={f.file_name} className={f.id === fileId ? 'late' : ''}>
                  <td>
                    <strong>
                      #{f.file_no} {f.file_name}
                    </strong>
                    <div className="cell-sub">{f.file_format.toUpperCase()}</div>
                  </td>
                  <td>{(f.sheets ?? []).map((s: any) => s.name).join(', ')}</td>
                  <td className="num">{Math.max(1, Math.round(f.byte_size / 1024))} KB</td>
                  <td className="num">{f.batches}</td>
                  <td>{String(f.uploaded_at).slice(0, 10)}</td>
                  <td className="actions">
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => {
                        setFileId(f.id);
                        setSheet(f.sheets?.[0]?.name ?? '');
                        setPreview(null);
                      }}
                    >
                      Choose
                    </button>
                  </td>
                </tr>
              ))}
              {!files.length && (
                <tr>
                  <td colSpan={6}>No files uploaded yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {chosen && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Sheet and import type</h2>
              <p className="panel-sub">
                {chosen.file_name}: {(chosen.sheets ?? []).length} sheet(s). A workbook often holds
                one sheet per plant; each is imported on its own.
              </p>
            </div>
          </div>
          <div className="toolbar panel-body">
            <label>
              Sheet
              <select value={sheet} disabled={busy} onChange={(e) => setSheet(e.target.value)}>
                {(chosen.sheets ?? []).map((s: any) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                    {s.hidden ? ' (hidden)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Header row
              <input
                inputMode="numeric"
                value={headerRow}
                disabled={busy}
                onChange={(e) => setHeaderRow(e.target.value)}
              />
            </label>
            <label>
              Import type
              <select value={kind} disabled={busy} onChange={(e) => setKind(e.target.value)}>
                {importable.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <button className="button primary" disabled={busy || !sheet || !kind} onClick={read}>
              {busy ? 'Reading…' : 'Read this sheet'}
            </button>
          </div>
        </section>
      )}

      {preview && (
        <>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>{preview.sheet}: the first rows as the file has them</h2>
                <p className="panel-sub">
                  Columns are numbered.{' '}
                  {preview.duplicates.length > 0
                    ? `This sheet repeats ${preview.duplicates.join(', ')}, so those are chosen by number, not by name.`
                    : 'Nothing is changed here: this is the file itself.'}
                </p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Row</th>
                    {preview.header.map((h: any) => (
                      <th key={h.index} data-column={h.index + 1}>
                        {h.index + 1}. {h.name || '(no name)'}
                        {h.duplicate && <div className="cell-sub">repeat #{h.occurrence}</div>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r: any) => (
                    <tr key={r.row}>
                      <td>{r.row}</td>
                      {preview.header.map((h: any) => (
                        <td key={h.index}>{r.cells[h.index] ?? ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Which column feeds each field</h2>
                <p className="panel-sub">
                  {mappedCount} of {preview.fields.length} fields mapped. A field left out arrives
                  empty, and the import will say so if it is required.
                </p>
              </div>
            </div>
            {preview.mappings.length > 0 && (
              <div className="toolbar panel-body">
                <label>
                  Saved mapping
                  <select
                    value=""
                    onChange={(e) => {
                      const m = preview.mappings.find((x: any) => x.id === e.target.value);
                      if (m) loadMapping(m);
                    }}
                  >
                    <option value="">Choose…</option>
                    {preview.mappings.map((m: any) => (
                      <option key={m.id} value={m.id}>
                        {m.code} — {m.name}
                        {m.matches ? ' (same columns as this sheet)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Column in the file</th>
                    <th>Read as</th>
                    <th>Date format</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.fields.map((field: string) => {
                    const column = columns[field];
                    const value = !column
                      ? ''
                      : column.by === 'constant'
                        ? 'constant'
                        : String(column.index);
                    return (
                      <tr key={field} data-field={field}>
                        <td>
                          <strong>{field}</strong>
                        </td>
                        <td>
                          <select
                            aria-label={`Column for ${field}`}
                            value={value}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (v === '') unmap(field);
                              else if (v === 'constant')
                                setColumn(field, { by: 'constant', value: '' });
                              else
                                setColumn(field, {
                                  by: 'position',
                                  index: Number(v),
                                  transform: column?.transform ?? transformFor(field),
                                });
                            }}
                          >
                            <option value="">— not mapped —</option>
                            {preview.header.map((h: any) => (
                              <option key={h.index} value={h.index}>
                                {h.index + 1}. {h.name || '(no name)'}
                                {h.duplicate ? ` (repeat #${h.occurrence})` : ''}
                              </option>
                            ))}
                            <option value="constant">Same value for every row…</option>
                          </select>
                          {column?.by === 'constant' && (
                            <input
                              aria-label={`Value for ${field}`}
                              value={column.value ?? ''}
                              onChange={(e) => setColumn(field, { value: e.target.value })}
                            />
                          )}
                        </td>
                        <td>
                          {column && column.by !== 'constant' && (
                            <select
                              aria-label={`Read ${field} as`}
                              value={column.transform ?? 'text'}
                              onChange={(e) => setColumn(field, { transform: e.target.value })}
                            >
                              {TRANSFORMS.map(([v, label]) => (
                                <option key={v} value={v}>
                                  {label}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td>
                          {column?.transform === 'date' && (
                            <select
                              aria-label={`Date format for ${field}`}
                              value={column.format ?? ''}
                              onChange={(e) =>
                                setColumn(field, { format: e.target.value || undefined })
                              }
                            >
                              <option value="">Use the default below</option>
                              {DATE_FORMATS.map(([v, label]) => (
                                <option key={v} value={v}>
                                  {label}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>How to read the values, and which rows to leave out</h2>
                <p className="panel-sub">A blank cell is always left blank, never read as zero.</p>
              </div>
            </div>
            <div className="toolbar panel-body">
              <label>
                Decimals
                <select
                  value={options.decimal}
                  onChange={(e) => setOptions({ ...options, decimal: e.target.value })}
                >
                  <option value="auto">Read what is unambiguous</option>
                  <option value="dot">1,234.56</option>
                  <option value="comma">1.234,56</option>
                </select>
              </label>
              <label>
                Dates
                <select
                  value={options.dateFormat}
                  onChange={(e) => setOptions({ ...options, dateFormat: e.target.value })}
                >
                  {DATE_FORMATS.map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Unit aliases
                <input
                  value={options.aliases}
                  placeholder="EA=NOS, PC=NOS"
                  onChange={(e) => setOptions({ ...options, aliases: e.target.value })}
                />
              </label>
              <label className="toolbar">
                <input
                  type="checkbox"
                  checked={options.skipBlankRows}
                  onChange={(e) => setOptions({ ...options, skipBlankRows: e.target.checked })}
                />
                Skip empty rows
              </label>
            </div>
            {/* A sales export has a row per invoice line; a demand history holds one per day. */}
            <div className="panel-body">
              <p className="panel-sub">
                Rows that repeat: choose the fields that make two rows the same row. A column to add
                up is optional — without one the first row is kept and the repeats are counted.
                Nothing is combined unless you say so.
              </p>
              <div className="toolbar">
                {preview.fields
                  .filter((f: string) => columns[f])
                  .map((field: string) => (
                    <label className="toolbar" key={field}>
                      <input
                        type="checkbox"
                        checked={options.combine.includes(field)}
                        onChange={(e) =>
                          setOptions({
                            ...options,
                            combine: e.target.checked
                              ? [...options.combine, field]
                              : options.combine.filter((f: string) => f !== field),
                          })
                        }
                      />
                      {field}
                    </label>
                  ))}
              </div>
              {options.combine.length > 0 && (
                <div className="toolbar">
                  <label>
                    Add up (optional)
                    <select
                      value={options.sum}
                      onChange={(e) => setOptions({ ...options, sum: e.target.value })}
                    >
                      <option value="">Choose…</option>
                      {preview.fields
                        .filter((f: string) => columns[f]?.transform === 'number')
                        .map((field: string) => (
                          <option key={field} value={field}>
                            {field}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
              )}
            </div>
            <div className="table-wrap">
              <table>
                <caption>Rows to leave out</caption>
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Rule</th>
                    <th>Value</th>
                    <th className="actions">Remove</th>
                  </tr>
                </thead>
                <tbody>
                  {options.filters.map((f: any, i: number) => (
                    <tr key={i} data-filter={i}>
                      <td>
                        <select
                          aria-label={`Rule ${i + 1} field`}
                          value={f.field}
                          onChange={(e) => {
                            const filters = [...options.filters];
                            filters[i] = { ...f, field: e.target.value };
                            setOptions({ ...options, filters });
                          }}
                        >
                          <option value="">Choose…</option>
                          {Object.keys(columns).map((field) => (
                            <option key={field} value={field}>
                              {field}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          aria-label={`Rule ${i + 1} test`}
                          value={f.op}
                          onChange={(e) => {
                            const filters = [...options.filters];
                            filters[i] = { ...f, op: e.target.value };
                            setOptions({ ...options, filters });
                          }}
                        >
                          {OPERATORS.map(([v, label]) => (
                            <option key={v} value={v}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {['equals', 'not_equals'].includes(f.op) && (
                          <input
                            aria-label={`Rule ${i + 1} value`}
                            value={f.value ?? ''}
                            onChange={(e) => {
                              const filters = [...options.filters];
                              filters[i] = { ...f, value: e.target.value };
                              setOptions({ ...options, filters });
                            }}
                          />
                        )}
                      </td>
                      <td className="actions">
                        <button
                          className="button"
                          onClick={() =>
                            setOptions({
                              ...options,
                              filters: options.filters.filter((_: any, j: number) => j !== i),
                            })
                          }
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!options.filters.length && (
                    <tr>
                      <td colSpan={4}>
                        Every row under the header is imported. Add a rule to leave some out — for
                        example only one plant, or stock that is not zero.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="form-actions panel-body">
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  setOptions({
                    ...options,
                    filters: [...options.filters, { field: '', op: 'equals', value: '' }],
                  })
                }
              >
                Add a rule
              </button>
              <label>
                Save this mapping as
                <input
                  value={saveAs}
                  placeholder="MB52-STOCK"
                  onChange={(e) => setSaveAs(e.target.value)}
                />
              </label>
              <button
                className="button primary"
                disabled={busy || !mappedCount}
                onClick={stage}
                data-stage="1"
              >
                {busy ? 'Reading the sheet…' : 'Read the sheet and check it'}
              </button>
            </div>
          </section>
        </>
      )}
    </>
  );
}

// The reconciliation of one staged batch: what the file had, what was read from it, and what was
// left out. Shown next to the batch's own errors, before anything is committed.
export function Reconciliation({ batch }: { batch: any }) {
  const r = batch?.reconciliation ?? {};
  if (!r.sheetRows) return null;
  const lines: [string, unknown, string][] = [
    ['Rows in the sheet', r.sheetRows, `${r.fileName ?? ''} · ${r.sheet ?? ''}`],
    ['Under the header row', r.sourceRows, `header on row ${r.headerRow}`],
    [
      'Left out by a rule',
      r.removed ?? 0,
      (r.filtered ?? []).map((f: any) => `${f.count} × ${f.rule}`).join(', '),
    ],
    ['Empty rows skipped', r.blank ?? 0, ''],
    ['Added into another row', r.combined ?? 0, r.combined ? 'rows that repeat the same key' : ''],
    ['Read into this import', r.staged, ''],
    ['Ready to commit', r.mapped, ''],
    ['Rejected', r.failed, 'each with its reason below'],
    [
      'Unaccounted',
      r.unaccounted,
      r.unaccounted ? 'these rows never reached the mapping' : 'every row is accounted for',
    ],
  ];
  return (
    <section className="panel" data-recon="1">
      <div className="panel-heading">
        <div>
          <h2>What was read from the file</h2>
          <p className="panel-sub">
            Every row of the sheet is accounted for before anything is committed.
          </p>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <tbody>
            {lines.map(([label, value, note]) => (
              <tr key={label} data-recon-line={label}>
                <td>{label}</td>
                <td className="num">
                  <strong>{num(value)}</strong>
                </td>
                <td className="cell-sub">{note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(r.totals ?? []).length > 0 && (
        <div className="table-wrap">
          <table>
            <caption>Quantity per unit, never added across units</caption>
            <thead>
              <tr>
                <th>Unit</th>
                <th className="num">Rows</th>
                <th className="num">Quantity</th>
              </tr>
            </thead>
            <tbody>
              {r.totals.map((t: any) => (
                <tr key={t.unit} data-total={t.unit}>
                  <td>{t.unit}</td>
                  <td className="num">{num(t.rows)}</td>
                  <td className="num">{num(t.quantity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(r.reasons ?? []).length > 0 && (
        <div className="table-wrap">
          <table>
            <caption>Why rows were rejected</caption>
            <thead>
              <tr>
                <th className="num">Rows</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {r.reasons.map((x: any) => (
                <tr key={x.message}>
                  <td className="num">{num(x.count)}</td>
                  <td>{x.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
