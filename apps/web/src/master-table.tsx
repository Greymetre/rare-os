// The one master screen every master uses: search, create, edit, remove, and a page of rows.
// Both Availability's planning masters and Reach's field masters are drawn by this, so a record
// behaves the same wherever it is maintained.
import { Pager, usePaging } from './pager';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useApi } from './api-client';
import { Modal } from './modal';

export type FieldInfo = {
  name: string;
  label: string;
  type: string;
  required: boolean;
  immutable: boolean;
  options?: string[];
  max?: number;
};

export type KindInfo = {
  kind: string;
  label: string;
  singular: string;
  // The module that maintains it: 'Availability' or 'Reach'.
  module: string;
  canManage: boolean;
  // Whether this kind keeps removed records at all, and whether this person may remove one.
  removable?: boolean;
  canRemove?: boolean;
  fields: FieldInfo[];
};
const refHint: Record<string, string> = {
  base_unit: 'Unit code, e.g. KG',
  purchase_unit: 'Blank = item base unit',
  from_unit: 'Unit code, e.g. BOX',
  to_unit: 'Unit code, e.g. NOS',
  item: 'Item code',
  supplier: 'Supplier code',
  parent: 'Blank = this is a top-level territory',
  grade: 'Grade code, e.g. SO',
  territory: 'Territory code, e.g. EAST-T1',
  user: 'Blank until the rep has a login; then the email they sign in with',
};

export function display(field: FieldInfo, value: unknown) {
  if (value === null || value === undefined || value === '') return '—';
  if (field.type === 'bool') return value ? 'Yes' : 'No';
  if (field.type === 'decimal') return String(Number(value));
  return String(value);
}

export function MasterTable({
  csrf,
  info,
  refreshKey,
  rowActions,
}: {
  csrf: string;
  info: KindInfo;
  refreshKey: number;
  // An action only one kind has, drawn next to Edit. Reach uses it for a rep's photo.
  rowActions?: (row: any) => ReactNode;
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
    [next, setNext] = useState<string | null>(null),
    [total, setTotal] = useState<number | undefined>(undefined),
    [removing, setRemoving] = useState<any>(null),
    [reason, setReason] = useState(''),
    [revision, setRevision] = useState(0);
  const page = usePaging();
  // Edit is for everyone who maintains the kind; Remove needs its own permission, and only exists
  // for kinds that keep what they remove.
  const canRemove = !!info.canRemove && !!info.removable;
  const hasActions = info.canManage || canRemove || !!rowActions;
  // Enough to tell one row from another, for a screen reader and for the removal dialog's title.
  // A code is enough where there is one. A holiday has no code, and one date can carry both a
  // national and a regional holiday, so a holiday is named by its date and its name together.
  const rowLabel = (r: any) =>
    r.code ??
    (r.holiday_date ? `${r.holiday_date} ${r.name}` : null) ??
    r.item ??
    r.from_unit ??
    '';
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError('');
    call(
      `masters/${info.kind}?limit=${page.size}&q=${encodeURIComponent(search)}${
        page.cursor ? '&cursor=' + page.cursor : ''
      }`,
    )
      .then((d) => {
        if (!live) return;
        setRows(d.items);
        setNext(d.nextCursor);
        setTotal(d.total);
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [info.kind, search, page.cursor, page.size, revision, refreshKey]);
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
  function remove() {
    setBusy(true);
    setError('');
    call(`masters/${info.kind}/${removing.id}`, 'DELETE', {
      version: removing.version,
      reason,
    })
      .then((d) => {
        setNotice(d.message);
        setRemoving(null);
        setReason('');
        setRevision((x) => x + 1);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
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
            page.setCursors([]);
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
      {removing && (
        <Modal
          title={`Remove ${info.singular} ${rowLabel(removing)}`}
          onClose={() => {
            setRemoving(null);
            setReason('');
          }}
        >
          <p>
            It goes off this list. The record itself is kept, so anything that already refers to it
            still reads, and the code is free to use again.
          </p>
          <label>
            Reason (optional)
            <input
              value={reason}
              disabled={busy}
              maxLength={200}
              placeholder="Left the company, duplicate record…"
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="modal-actions">
            <button
              className="button"
              disabled={busy}
              onClick={() => {
                setRemoving(null);
                setReason('');
              }}
            >
              Keep it
            </button>
            <button className="button destructive" disabled={busy} onClick={() => remove()}>
              Confirm remove
            </button>
          </div>
        </Modal>
      )}
      <section className="panel table-wrap">
        <table>
          <thead>
            <tr>
              {info.fields.map((f) => (
                <th key={f.name}>{f.label}</th>
              ))}
              <th>Status</th>
              {hasActions && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                {info.fields.map((f) => (
                  <td key={f.name}>{display(f, r[f.name])}</td>
                ))}
                <td>{r.active ? 'Active' : 'Inactive'}</td>
                {hasActions && (
                  <td>
                    {info.canManage && (
                      <button
                        className="text-button"
                        aria-label={`Edit ${info.singular} ${rowLabel(r)}`}
                        onClick={() => open(r)}
                      >
                        Edit
                      </button>
                    )}
                    {rowActions?.(r)}
                    {canRemove && (
                      <button
                        className="text-button warning"
                        aria-label={`Remove ${info.singular} ${rowLabel(r)}`}
                        onClick={() => {
                          setReason('');
                          setError('');
                          setRemoving(r);
                        }}
                      >
                        Remove
                      </button>
                    )}
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
        <Pager
          page={page}
          next={next}
          total={total}
          shown={rows.length}
          busy={busy}
          noun={info.label.toLowerCase()}
        />
      </section>
    </>
  );
}
