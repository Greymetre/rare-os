import { useEffect, useState } from 'react';
import { useApi } from './api-client';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const today = () => new Date().toISOString().slice(0, 10);
const num = (v: unknown) => (v === null || v === undefined || v === '' ? '' : String(Number(v)));

export function Messages({ error, notice }: { error: string; notice: string }) {
  return (
    <>
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
    </>
  );
}

export function useList(csrf: string, path: string | null, deps: unknown[]) {
  const call = useApi(csrf);
  const [items, setItems] = useState<any[]>([]),
    [next, setNext] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (!path) return;
    let live = true;
    setBusy(true);
    setError('');
    call(path)
      .then((d) => {
        if (!live) return;
        setItems(d.items);
        setNext(d.nextCursor ?? null);
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [path, ...deps]);
  return { items, next, busy, error };
}

export function PlantPicker({
  csrf,
  value,
  onChange,
}: {
  csrf: string;
  value: string | null;
  onChange: (id: string) => void;
}) {
  const { items, busy, error } = useList(csrf, 'plants?limit=100', []);
  const active = items.filter((p) => p.active);
  useEffect(() => {
    if (!value && active.length) onChange(active[0].id);
  }, [active.length]);
  if (error)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!busy && !active.length)
    return (
      <div className="notice" role="status">
        No active plant is assigned to you. Create a plant or ask for plant access to set up
        calendars, resources and routings.
      </div>
    );
  return (
    <div className="plant-picker">
      <label>
        Plant
        <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          {active.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.code})
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function PlantReadiness({
  csrf,
  plantId,
  refreshKey,
}: {
  csrf: string;
  plantId: string;
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const [data, setData] = useState<any>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setData(null);
    call(`plants/${plantId}/readiness`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [plantId, refreshKey]);
  if (error)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!data) return <p role="status">Checking plant setup…</p>;
  const ready = data.items.filter((i: any) => i.status === 'ready').length;
  const counted = data.items.filter((i: any) => i.status !== 'info').length;
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Plant setup: {data.plant.name}</h2>
        <span className="badge">
          {ready} / {counted} ready
        </span>
      </div>
      {data.items.map((i: any) => (
        <div className="check-row readiness-row" key={i.key} data-status={i.status}>
          <span className={'status-pill ' + i.status}>
            {i.status === 'ready' ? 'Ready' : i.status === 'info' ? 'Info' : 'Missing'}
          </span>
          <div>
            <strong>{i.title}</strong>
            <p>{i.detail}</p>
          </div>
        </div>
      ))}
    </section>
  );
}

// ---------- Calendars ----------

export function Calendars({
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
  const list = useList(csrf, `plants/${plantId}/calendars`, [revision, refreshKey]);
  async function edit(id?: string) {
    setError('');
    if (!id)
      return setForm({
        code: '',
        name: '',
        days: [true, true, true, true, true, true, false],
        is_default: !list.items.length,
        shifts: [{ name: 'General', start_time: '09:00', end_time: '17:30', break_minutes: 30 }],
        holidays: [],
      });
    const c = await call('calendars/' + id);
    setForm({ ...c, days: c.working_days.split('').map((d: string) => d === '1') });
  }
  function save() {
    setBusy(true);
    setError('');
    const payload: any = {
      name: form.name,
      working_days: form.days,
      is_default: form.is_default,
      shifts: form.shifts.map((s: any) => ({ ...s, break_minutes: String(s.break_minutes ?? '') })),
      holidays: form.holidays,
    };
    if (form.id) Object.assign(payload, { active: form.active, version: form.version });
    else payload.code = form.code;
    call(
      form.id ? 'calendars/' + form.id : `plants/${plantId}/calendars`,
      form.id ? 'PUT' : 'POST',
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
  const setShift = (i: number, key: string, v: unknown) =>
    setForm({
      ...form,
      shifts: form.shifts.map((s: any, n: number) => (n === i ? { ...s, [key]: v } : s)),
    });
  const setHoliday = (i: number, key: string, v: unknown) =>
    setForm({
      ...form,
      holidays: form.holidays.map((h: any, n: number) => (n === i ? { ...h, [key]: v } : h)),
    });
  return (
    <>
      {canManage && !form && (
        <div className="toolbar">
          <span />
          <button className="button primary" onClick={() => void edit()}>
            Create calendar
          </button>
        </div>
      )}
      <Messages error={error || list.error} notice={notice} />
      {form && (
        <section className="panel company-form">
          <h2>{form.id ? `Edit calendar ${form.code}` : 'New calendar'}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            {!form.id && (
              <label>
                Calendar code *
                <input
                  value={form.code}
                  maxLength={40}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                />
              </label>
            )}
            <label>
              Calendar name *
              <input
                value={form.name}
                maxLength={120}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <fieldset className="day-picker">
              <legend>Working days</legend>
              {DAYS.map((d, i) => (
                <label key={d}>
                  <input
                    type="checkbox"
                    checked={form.days[i]}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        days: form.days.map((x: boolean, n: number) =>
                          n === i ? e.target.checked : x,
                        ),
                      })
                    }
                  />
                  {d}
                </label>
              ))}
            </fieldset>
            <label>
              <input
                type="checkbox"
                checked={form.is_default}
                onChange={(e) => setForm({ ...form, is_default: e.target.checked })}
              />{' '}
              Default calendar for this plant
            </label>
            <h3>Shifts</h3>
            <table className="line-editor">
              <thead>
                <tr>
                  <th>Shift</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Break (min)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {form.shifts.map((s: any, i: number) => (
                  <tr key={i}>
                    <td>
                      <input
                        aria-label={`Shift ${i + 1} name`}
                        value={s.name}
                        onChange={(e) => setShift(i, 'name', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Shift ${i + 1} start`}
                        type="time"
                        value={s.start_time}
                        onChange={(e) => setShift(i, 'start_time', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Shift ${i + 1} end`}
                        type="time"
                        value={s.end_time}
                        onChange={(e) => setShift(i, 'end_time', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Shift ${i + 1} break`}
                        inputMode="numeric"
                        value={s.break_minutes}
                        onChange={(e) => setShift(i, 'break_minutes', e.target.value)}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() =>
                          setForm({
                            ...form,
                            shifts: form.shifts.filter((_: any, n: number) => n !== i),
                          })
                        }
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              type="button"
              className="button"
              onClick={() =>
                setForm({
                  ...form,
                  shifts: [
                    ...form.shifts,
                    { name: '', start_time: '', end_time: '', break_minutes: 0 },
                  ],
                })
              }
            >
              Add shift
            </button>
            <h3>Holidays</h3>
            <table className="line-editor">
              <tbody>
                {form.holidays.map((h: any, i: number) => (
                  <tr key={i}>
                    <td>
                      <input
                        aria-label={`Holiday ${i + 1} date`}
                        type="date"
                        value={h.holiday_date}
                        onChange={(e) => setHoliday(i, 'holiday_date', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Holiday ${i + 1} name`}
                        value={h.name}
                        onChange={(e) => setHoliday(i, 'name', e.target.value)}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() =>
                          setForm({
                            ...form,
                            holidays: form.holidays.filter((_: any, n: number) => n !== i),
                          })
                        }
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              type="button"
              className="button"
              onClick={() =>
                setForm({ ...form, holidays: [...form.holidays, { holiday_date: '', name: '' }] })
              }
            >
              Add holiday
            </button>
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
            <div className="form-actions">
              <button className="button primary" disabled={busy}>
                Save calendar
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
      <section className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Working days</th>
              <th>Shifts</th>
              <th>Minutes/day</th>
              <th>Holidays</th>
              <th>Default</th>
              <th>Status</th>
              {canManage && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {list.items.map((c) => (
              <tr key={c.id}>
                <td>{c.code}</td>
                <td>{c.name}</td>
                <td>{DAYS.filter((_, i) => c.working_days[i] === '1').join(', ')}</td>
                <td>{c.shift_count}</td>
                <td>{c.day_minutes}</td>
                <td>{c.holidays}</td>
                <td>{c.is_default ? 'Yes' : '—'}</td>
                <td>{c.active ? 'Active' : 'Inactive'}</td>
                {canManage && (
                  <td>
                    <button
                      className="text-button"
                      aria-label={'Edit calendar ' + c.code}
                      onClick={() => void edit(c.id).catch((e) => setError(e.message))}
                    >
                      Edit
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {list.busy && <p role="status">Loading calendars…</p>}
        {!list.items.length && !list.busy && (
          <div className="empty">
            No calendar for this plant yet. The first calendar you create becomes the plant default.
          </div>
        )}
      </section>
    </>
  );
}

// ---------- Resources ----------

export function Resources({
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
  const list = useList(csrf, `plants/${plantId}/resources`, [revision, refreshKey]);
  const calendars = useList(csrf, `plants/${plantId}/calendars`, [refreshKey]);
  function save() {
    setBusy(true);
    setError('');
    const payload: any = {
      name: form.name,
      resource_type: form.resource_type,
      machine_count: String(form.machine_count),
      efficiency_pct: String(form.efficiency_pct),
      changeover_minutes: String(form.changeover_minutes),
      calendar: form.calendar || '',
    };
    if (form.id) Object.assign(payload, { active: form.active, version: form.version });
    else payload.code = form.code;
    call(
      form.id ? 'resources/' + form.id : `plants/${plantId}/resources`,
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
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        {...props}
      />
    </label>
  );
  return (
    <>
      {canManage && !form && (
        <div className="toolbar">
          <span />
          <button
            className="button primary"
            onClick={() =>
              setForm({
                code: '',
                name: '',
                resource_type: 'MACHINE',
                machine_count: 1,
                efficiency_pct: 100,
                changeover_minutes: 0,
                calendar: '',
              })
            }
          >
            Create resource
          </button>
        </div>
      )}
      <Messages error={error || list.error} notice={notice} />
      {form && (
        <section className="panel company-form">
          <h2>{form.id ? `Edit resource ${form.code}` : 'New resource'}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            {!form.id && field('code', 'Resource code *', { maxLength: 40 })}
            {field('name', 'Resource name *', { maxLength: 120 })}
            <label>
              Resource type
              <select
                value={form.resource_type}
                onChange={(e) => setForm({ ...form, resource_type: e.target.value })}
              >
                {['MACHINE', 'LINE', 'MANUAL'].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
            {field('machine_count', 'Machines *', { inputMode: 'numeric' })}
            {field('efficiency_pct', 'Efficiency %', { inputMode: 'decimal' })}
            {field('changeover_minutes', 'Changeover minutes', { inputMode: 'decimal' })}
            <label>
              Calendar
              <select
                value={form.calendar ?? ''}
                onChange={(e) => setForm({ ...form, calendar: e.target.value })}
              >
                <option value="">Plant default</option>
                {calendars.items
                  .filter((c) => c.active)
                  .map((c) => (
                    <option key={c.id} value={c.code}>
                      {c.code} — {c.name}
                    </option>
                  ))}
              </select>
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
            <div className="form-actions">
              <button className="button primary" disabled={busy}>
                Save resource
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
      <section className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Type</th>
              <th>Machines</th>
              <th>Efficiency %</th>
              <th>Changeover min</th>
              <th>Calendar</th>
              <th>Capacity min/day</th>
              <th>Status</th>
              {canManage && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {list.items.map((r) => (
              <tr key={r.id}>
                <td>{r.code}</td>
                <td>{r.name}</td>
                <td>{r.resource_type}</td>
                <td>{r.machine_count}</td>
                <td>{num(r.efficiency_pct)}</td>
                <td>{num(r.changeover_minutes)}</td>
                <td>{r.calendar ?? (r.calendar_used ? `${r.calendar_used} (default)` : '—')}</td>
                <td>
                  {r.capacity_minutes_per_day === null
                    ? 'No calendar'
                    : Math.round(r.capacity_minutes_per_day)}
                </td>
                <td>{r.active ? 'Active' : 'Inactive'}</td>
                {canManage && (
                  <td>
                    <button
                      className="text-button"
                      aria-label={'Edit resource ' + r.code}
                      onClick={() =>
                        setForm({
                          ...r,
                          efficiency_pct: num(r.efficiency_pct),
                          changeover_minutes: num(r.changeover_minutes),
                          calendar: r.calendar ?? '',
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
        {list.busy && <p role="status">Loading resources…</p>}
        {!list.items.length && !list.busy && (
          <div className="empty">
            No resources in this plant yet. Create machines or lines, or import them.
          </div>
        )}
      </section>
    </>
  );
}

// ---------- Document editors (BOMs and routings) ----------

export type Column = {
  key: string;
  label: string;
  width?: string;
  inputMode?: 'decimal' | 'numeric';
  type?: 'date';
  readOnly?: boolean;
};

export function LineTable({
  label,
  columns,
  rows,
  onChange,
  blank,
}: {
  label: string;
  columns: Column[];
  rows: any[];
  onChange: (rows: any[]) => void;
  blank: any;
}) {
  return (
    <>
      <div className="table-wrap">
        <table className="line-editor">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.key}>
                    <input
                      aria-label={`${label} ${i + 1} ${c.label}`}
                      value={row[c.key] ?? ''}
                      inputMode={c.inputMode}
                      type={c.type}
                      readOnly={c.readOnly}
                      className={c.readOnly ? 'readonly' : undefined}
                      onChange={(e) =>
                        onChange(
                          rows.map((r, n) => (n === i ? { ...r, [c.key]: e.target.value } : r)),
                        )
                      }
                    />
                  </td>
                ))}
                <td>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onChange(rows.filter((_, n) => n !== i))}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="button" onClick={() => onChange([...rows, { ...blank }])}>
        Add {label.toLowerCase()}
      </button>
    </>
  );
}

function DocumentList({
  csrf,
  path,
  title,
  columns,
  canManage,
  onCreate,
  onEdit,
  deps,
  emptyText,
}: {
  csrf: string;
  path: string;
  title: string;
  columns: [string, string][];
  canManage: boolean;
  onCreate: () => void;
  onEdit: (id: string) => void;
  deps: unknown[];
  emptyText: string;
}) {
  const [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors[cursors.length - 1];
  const list = useList(
    csrf,
    `${path}?q=${encodeURIComponent(search)}${cursor ? '&cursor=' + cursor : ''}`,
    deps,
  );
  return (
    <>
      <div className="toolbar">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setCursors([]);
            setSearch(query.toLowerCase());
          }}
        >
          <input
            aria-label={`${title} search`}
            placeholder="Item code starts with…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />{' '}
          <button className="button">Search</button>
        </form>
        {canManage && (
          <button className="button primary" onClick={onCreate}>
            Create {title.toLowerCase()}
          </button>
        )}
      </div>
      {list.error && (
        <div className="error" role="alert">
          {list.error}
        </div>
      )}
      <section className="panel table-wrap">
        <table>
          <thead>
            <tr>
              {columns.map(([, label]) => (
                <th key={label}>{label}</th>
              ))}
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((r) => (
              <tr key={r.id}>
                {columns.map(([key]) => (
                  <td key={key}>{r[key] ?? '—'}</td>
                ))}
                <td>{r.active ? 'Active' : 'Inactive'}</td>
                <td>
                  <button
                    className="text-button"
                    aria-label={`Open ${title} ${r.parent_item ?? r.item} ${r.revision}`}
                    onClick={() => onEdit(r.id)}
                  >
                    {canManage ? 'Edit' : 'View'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.busy && <p role="status">Loading…</p>}
        {!list.items.length && !list.busy && (
          <div className="empty">{search ? 'No records match this search.' : emptyText}</div>
        )}
        <div className="table-footer">
          <button className="button" disabled={!cursors.length} onClick={() => setCursors([])}>
            First page
          </button>
          <button
            className="button"
            disabled={!list.next}
            onClick={() => setCursors([...cursors, list.next!])}
          >
            Next page
          </button>
        </div>
      </section>
    </>
  );
}

export function Boms({
  csrf,
  canManage,
  refreshKey,
}: {
  csrf: string;
  canManage: boolean;
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const [form, setForm] = useState<any>(null),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const blankLine = { component_item: '', quantity: '', unit: '', scrap_pct: '0' };
  function save() {
    setBusy(true);
    setError('');
    const lines = form.lines.map((l: any) => ({
      ...l,
      quantity: String(l.quantity),
      scrap_pct: String(l.scrap_pct ?? ''),
    }));
    const payload: any = {
      effective_from: form.effective_from,
      effective_to: form.effective_to || '',
      base_quantity: String(form.base_quantity),
      lines,
    };
    if (form.id) Object.assign(payload, { active: form.active, version: form.version });
    else Object.assign(payload, { parent_item: form.parent_item, revision: form.revision });
    call(form.id ? 'boms/' + form.id : 'boms', form.id ? 'PUT' : 'POST', payload)
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
      <Messages error={error} notice={notice} />
      {form ? (
        <section className="panel company-form">
          <h2>{form.id ? `BOM ${form.parent_item} ${form.revision}` : 'New BOM'}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (canManage) save();
            }}
          >
            {!form.id && (
              <>
                <label>
                  Parent item code *
                  <input
                    value={form.parent_item}
                    onChange={(e) => setForm({ ...form, parent_item: e.target.value })}
                  />
                </label>
                <label>
                  BOM revision *
                  <input
                    value={form.revision}
                    maxLength={20}
                    onChange={(e) => setForm({ ...form, revision: e.target.value })}
                  />
                </label>
              </>
            )}
            <label>
              Effective from *
              <input
                type="date"
                value={form.effective_from}
                onChange={(e) => setForm({ ...form, effective_from: e.target.value })}
              />
            </label>
            <label>
              Effective to
              <input
                type="date"
                value={form.effective_to ?? ''}
                onChange={(e) => setForm({ ...form, effective_to: e.target.value })}
              />
            </label>
            <label>
              Base quantity (components below make this many units)
              <input
                inputMode="decimal"
                value={form.base_quantity}
                onChange={(e) => setForm({ ...form, base_quantity: e.target.value })}
              />
            </label>
            <h3>Components</h3>
            <LineTable
              label="Line"
              rows={form.lines}
              blank={blankLine}
              onChange={(lines) => setForm({ ...form, lines })}
              columns={[
                { key: 'component_item', label: 'Component item' },
                { key: 'quantity', label: 'Quantity', inputMode: 'decimal' },
                { key: 'unit', label: 'Unit (blank = base unit)' },
                { key: 'scrap_pct', label: 'Scrap %', inputMode: 'decimal' },
              ]}
            />
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
            <div className="form-actions">
              {canManage && (
                <button className="button primary" disabled={busy}>
                  Save BOM
                </button>
              )}
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setForm(null)}
              >
                {canManage ? 'Cancel' : 'Close'}
              </button>
            </div>
          </form>
        </section>
      ) : (
        <DocumentList
          csrf={csrf}
          path="boms"
          title="BOM"
          canManage={canManage}
          deps={[revision, refreshKey]}
          emptyText="No BOMs yet. Create one for each MAKE item, or import BOM lines."
          columns={[
            ['parent_item', 'Parent item'],
            ['item_name', 'Item name'],
            ['revision', 'Revision'],
            ['effective_from', 'From'],
            ['effective_to', 'To'],
            ['line_count', 'Lines'],
          ]}
          onCreate={() => {
            setError('');
            setForm({
              parent_item: '',
              revision: 'V1',
              effective_from: today(),
              effective_to: '',
              base_quantity: '1',
              lines: [{ ...blankLine }],
            });
          }}
          onEdit={(id) =>
            void call('boms/' + id)
              .then((b) =>
                setForm({
                  ...b,
                  base_quantity: num(b.base_quantity),
                  lines: b.lines.map((l: any) => ({
                    ...l,
                    quantity: num(l.quantity),
                    scrap_pct: num(l.scrap_pct),
                  })),
                }),
              )
              .catch((e) => setError(e.message))
          }
        />
      )}
    </>
  );
}

export function Routings({
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
  const [form, setForm] = useState<any>(null),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const blankOp = {
    sequence: '',
    operation_code: '',
    description: '',
    resource: '',
    setup_minutes: '0',
    run_minutes_per_unit: '',
  };
  function save() {
    setBusy(true);
    setError('');
    const operations = form.operations.map((o: any) => ({
      ...o,
      sequence: String(o.sequence),
      setup_minutes: String(o.setup_minutes ?? ''),
      run_minutes_per_unit: String(o.run_minutes_per_unit ?? ''),
    }));
    const payload: any = {
      effective_from: form.effective_from,
      effective_to: form.effective_to || '',
      operations,
    };
    if (form.id) Object.assign(payload, { active: form.active, version: form.version });
    else Object.assign(payload, { item: form.item, revision: form.revision });
    call(
      form.id ? 'routings/' + form.id : `plants/${plantId}/routings`,
      form.id ? 'PUT' : 'POST',
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
      <Messages error={error} notice={notice} />
      {form ? (
        <section className="panel company-form">
          <h2>{form.id ? `Routing ${form.item} ${form.revision}` : 'New routing'}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (canManage) save();
            }}
          >
            {!form.id && (
              <>
                <label>
                  Item code *
                  <input
                    value={form.item}
                    onChange={(e) => setForm({ ...form, item: e.target.value })}
                  />
                </label>
                <label>
                  Routing revision *
                  <input
                    value={form.revision}
                    maxLength={20}
                    onChange={(e) => setForm({ ...form, revision: e.target.value })}
                  />
                </label>
              </>
            )}
            <label>
              Effective from *
              <input
                type="date"
                value={form.effective_from}
                onChange={(e) => setForm({ ...form, effective_from: e.target.value })}
              />
            </label>
            <label>
              Effective to
              <input
                type="date"
                value={form.effective_to ?? ''}
                onChange={(e) => setForm({ ...form, effective_to: e.target.value })}
              />
            </label>
            <h3>Operations (run in sequence order)</h3>
            <LineTable
              label="Operation"
              rows={form.operations}
              blank={blankOp}
              onChange={(operations) => setForm({ ...form, operations })}
              columns={[
                { key: 'sequence', label: 'Sequence', inputMode: 'numeric' },
                { key: 'operation_code', label: 'Operation code' },
                { key: 'description', label: 'Description' },
                { key: 'resource', label: 'Resource code' },
                { key: 'setup_minutes', label: 'Setup min', inputMode: 'decimal' },
                { key: 'run_minutes_per_unit', label: 'Run min/unit', inputMode: 'decimal' },
              ]}
            />
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
            <div className="form-actions">
              {canManage && (
                <button className="button primary" disabled={busy}>
                  Save routing
                </button>
              )}
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setForm(null)}
              >
                {canManage ? 'Cancel' : 'Close'}
              </button>
            </div>
          </form>
        </section>
      ) : (
        <DocumentList
          csrf={csrf}
          path={`plants/${plantId}/routings`}
          title="Routing"
          canManage={canManage}
          deps={[revision, refreshKey, plantId]}
          emptyText="No routings in this plant yet. Create one for each MAKE item, or import routing operations."
          columns={[
            ['item', 'Item'],
            ['item_name', 'Item name'],
            ['revision', 'Revision'],
            ['effective_from', 'From'],
            ['effective_to', 'To'],
            ['operation_count', 'Operations'],
            ['run_minutes_per_unit', 'Run min/unit'],
          ]}
          onCreate={() => {
            setError('');
            setForm({
              item: '',
              revision: 'V1',
              effective_from: today(),
              effective_to: '',
              operations: [{ ...blankOp, sequence: '10' }],
            });
          }}
          onEdit={(id) =>
            void call('routings/' + id)
              .then((r) =>
                setForm({
                  ...r,
                  operations: r.operations.map((o: any) => ({
                    ...o,
                    setup_minutes: num(o.setup_minutes),
                    run_minutes_per_unit: num(o.run_minutes_per_unit),
                  })),
                }),
              )
              .catch((e) => setError(e.message))
          }
        />
      )}
    </>
  );
}
