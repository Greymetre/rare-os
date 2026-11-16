// RCH-1 screens: the customer register, one customer with its location, the beat round, the
// approvals queue and the Reach settings.
//
// A customer's form is not written here. It comes from the API as sections of fields, built from
// the company's own types and its form-by-type matrix, so a company that adds a question sees it
// on this screen without anything being rebuilt.
import { useEffect, useMemo, useState } from 'react';
import { Pager, usePaging } from './pager';
import { Modal } from './modal';
import { download, useApi } from './api-client';

type FormField = {
  field_key: string;
  label: string;
  section: string;
  input: string;
  help: string;
  required: boolean;
  choices: string[];
};
type Section = { section: string; fields: FormField[] };

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Active',
  DORMANT: 'Dormant',
  AWAITING_APPROVAL: 'Awaiting approval',
  REJECTED: 'Rejected',
};
const SOURCE_LABEL: Record<string, string> = {
  DEVICE: 'Device fix',
  TYPED: 'Typed',
  PIN: 'Dropped pin',
};

const metres = (value: number | null) => (value === null ? '—' : `${value} m`);
const coordinate = (value: unknown) =>
  value === null || value === undefined ? '' : Number(value).toFixed(6);

function Banner({ error, notice }: { error: string; notice: string }) {
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

// One answer on a customer's form, drawn from what its type asks.
function Answer({
  field,
  value,
  disabled,
  error,
  onChange,
}: {
  field: FormField;
  value: any;
  disabled: boolean;
  error?: string;
  onChange: (value: unknown) => void;
}) {
  const label = field.label + (field.required ? ' *' : '');
  return (
    <label>
      {label}
      {field.input === 'select' ? (
        <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          <option value="">{field.required ? 'Choose…' : '—'}</option>
          {field.choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      ) : field.input === 'bool' ? (
        <input
          type="checkbox"
          checked={!!value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
      ) : field.input === 'textarea' ? (
        <textarea
          value={value ?? ''}
          rows={3}
          maxLength={1000}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          value={value ?? ''}
          disabled={disabled}
          inputMode={field.input === 'number' ? 'decimal' : undefined}
          maxLength={field.input === 'textarea' ? 1000 : 200}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.help && !error && <small>{field.help}</small>}
      {error && <small className="warning">{error}</small>}
    </label>
  );
}

// The customer form: what every type has in common, then its own questions by section.
function CustomerForm({
  sections,
  form,
  fieldErrors,
  busy,
  editing,
  onChange,
}: {
  sections: Section[];
  form: any;
  fieldErrors: Record<string, string>;
  busy: boolean;
  editing: boolean;
  onChange: (next: any) => void;
}) {
  const set = (key: string, value: unknown) => onChange({ ...form, [key]: value });
  const setAnswer = (key: string, value: unknown) =>
    onChange({ ...form, answers: { ...form.answers, [key]: value } });
  return (
    <>
      <label>
        Customer code *
        <input
          value={form.code ?? ''}
          disabled={busy || editing}
          maxLength={40}
          onChange={(e) => set('code', e.target.value)}
        />
        {fieldErrors.code && <small className="warning">{fieldErrors.code}</small>}
      </label>
      <label>
        Name *
        <input
          value={form.name ?? ''}
          disabled={busy}
          maxLength={160}
          onChange={(e) => set('name', e.target.value)}
        />
        {fieldErrors.name && <small className="warning">{fieldErrors.name}</small>}
      </label>
      <label>
        Territory code *
        <input
          value={form.territory ?? ''}
          disabled={busy}
          maxLength={40}
          onChange={(e) => set('territory', e.target.value)}
        />
        {fieldErrors.territory && <small className="warning">{fieldErrors.territory}</small>}
      </label>
      <label>
        Beat code
        <input
          value={form.beat ?? ''}
          disabled={busy}
          maxLength={40}
          onChange={(e) => set('beat', e.target.value)}
        />
        <small>A type that is visited on a beat needs one.</small>
        {fieldErrors.beat && <small className="warning">{fieldErrors.beat}</small>}
      </label>
      <label>
        Town
        <input
          value={form.town ?? ''}
          disabled={busy}
          maxLength={80}
          onChange={(e) => set('town', e.target.value)}
        />
      </label>
      <label>
        Phone
        <input
          value={form.phone ?? ''}
          disabled={busy}
          maxLength={20}
          onChange={(e) => set('phone', e.target.value)}
        />
        {fieldErrors.phone && <small className="warning">{fieldErrors.phone}</small>}
      </label>
      <label>
        Rep code
        <input
          value={form.rep ?? ''}
          disabled={busy}
          maxLength={40}
          onChange={(e) => set('rep', e.target.value)}
        />
        {fieldErrors.rep && <small className="warning">{fieldErrors.rep}</small>}
      </label>
      <label>
        Buys from
        <input
          value={form.buys_from ?? ''}
          disabled={busy}
          maxLength={40}
          onChange={(e) => set('buys_from', e.target.value)}
        />
        <small>The distributor above a dealer or a retailer.</small>
        {fieldErrors.buys_from && <small className="warning">{fieldErrors.buys_from}</small>}
      </label>
      <label>
        Planning account
        <input
          value={form.sales_customer ?? ''}
          disabled={busy}
          maxLength={40}
          onChange={(e) => set('sales_customer', e.target.value)}
        />
        <small>Where this is also an account a sales order is raised against.</small>
        {fieldErrors.sales_customer && (
          <small className="warning">{fieldErrors.sales_customer}</small>
        )}
      </label>
      {sections.map((section) => (
        <fieldset key={section.section} className="form-section">
          <legend>{section.section}</legend>
          {section.fields.map((field) => (
            <Answer
              key={field.field_key}
              field={field}
              value={form.answers?.[field.field_key]}
              disabled={busy}
              error={fieldErrors[field.field_key]}
              onChange={(value) => setAnswer(field.field_key, value)}
            />
          ))}
        </fieldset>
      ))}
    </>
  );
}

// A to-scale plane around the tag: the check-in radius, the neighbours, and a move waiting for a
// decision. No map behind it, so nothing here depends on an outside service.
function GeoPlane({
  centre,
  radius,
  neighbours,
  pending,
}: {
  centre: { latitude: number; longitude: number } | null;
  radius: number;
  neighbours: { code: string; latitude: number; longitude: number }[];
  pending: { latitude: number; longitude: number; moved_m: number | null } | null;
}) {
  if (!centre) return <p>No location yet.</p>;
  // The plane shows everything that matters: the radius, every neighbour, and the proposed move.
  const points = [...neighbours, ...(pending ? [pending] : [])];
  const offsets = points.map((p) => ({
    ...p,
    east:
      (Number(p.longitude) - centre.longitude) *
      111320 *
      Math.cos((centre.latitude * Math.PI) / 180),
    north: (Number(p.latitude) - centre.latitude) * 110540,
  }));
  const span = Math.max(radius * 1.3, ...offsets.map((o) => Math.hypot(o.east, o.north) * 1.3), 30);
  const scale = 100 / span;
  return (
    <figure className="geo-plane">
      <svg
        viewBox="-110 -110 220 220"
        role="img"
        aria-label={`Location plane, ${Math.round(span)} m across`}
      >
        <circle className="geo-radius" cx="0" cy="0" r={Math.min(100, radius * scale)} />
        <line x1="-105" y1="0" x2="105" y2="0" />
        <line x1="0" y1="-105" x2="0" y2="105" />
        {offsets.map((o, index) => (
          <g key={('code' in o && o.code) || 'pending-' + index}>
            {!('code' in o) && (
              <line className="geo-move" x1="0" y1="0" x2={o.east * scale} y2={-o.north * scale} />
            )}
            <circle
              className={'code' in o ? 'geo-neighbour' : 'geo-pending'}
              cx={o.east * scale}
              cy={-o.north * scale}
              r="4"
            />
          </g>
        ))}
        <circle className="geo-tag" cx="0" cy="0" r="5" />
      </svg>
      <figcaption>
        The circle is the {radius} m check-in radius. The plane is about {Math.round(span * 2)} m
        across.
        {pending && ` The outlined point is a move of ${pending.moved_m} m waiting for approval.`}
      </figcaption>
    </figure>
  );
}

// Tagging one shop: typed coordinates, this device's location, or the pending request.
function GeoPanel({
  csrf,
  customer,
  geo,
  canManage,
  onChanged,
}: {
  csrf: string;
  customer: any;
  geo: any;
  canManage: boolean;
  onChanged: () => void;
}) {
  const call = useApi(csrf);
  const [latitude, setLatitude] = useState(coordinate(customer.latitude));
  const [longitude, setLongitude] = useState(coordinate(customer.longitude));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [nearby, setNearby] = useState<any[]>([]);
  const centre =
    customer.latitude === null
      ? null
      : { latitude: Number(customer.latitude), longitude: Number(customer.longitude) };

  function save(source: 'TYPED' | 'DEVICE' | 'PIN', accuracy: number | null) {
    setBusy(true);
    setError('');
    setNotice('');
    call(`reach/customers/${customer.id}/geo`, 'POST', {
      latitude: Number(latitude),
      longitude: Number(longitude),
      source,
      ...(accuracy === null ? {} : { accuracy_m: accuracy }),
      reason,
    })
      .then((d) => {
        setNotice(d.message);
        setNearby(d.nearby ?? []);
        onChanged();
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }

  function useDevice() {
    setError('');
    if (!navigator.geolocation) return setError('This browser will not give a location.');
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLatitude(position.coords.latitude.toFixed(6));
        setLongitude(position.coords.longitude.toFixed(6));
        setBusy(false);
        setNotice(
          `This device reports a fix accurate to about ${Math.round(position.coords.accuracy)} m. Save it to tag the shop.`,
        );
      },
      (failure) => {
        setBusy(false);
        setError('This device would not give a location: ' + failure.message);
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Location</h2>
        <span className="badge">
          {customer.latitude === null
            ? 'Not tagged'
            : customer.geo_verified
              ? 'Verified by a device fix'
              : (SOURCE_LABEL[customer.geo_source] ?? 'Tagged')}
        </span>
      </div>
      <Banner error={error} notice={notice} />
      <div className="geo-layout">
        <GeoPlane
          centre={centre}
          radius={Number(customer.checkin_radius_m)}
          neighbours={nearby.map((n) => ({
            code: n.code,
            latitude: Number(n.latitude),
            longitude: Number(n.longitude),
          }))}
          pending={
            geo.pending
              ? {
                  latitude: Number(geo.pending.latitude),
                  longitude: Number(geo.pending.longitude),
                  moved_m: geo.pending.moved_m,
                }
              : null
          }
        />
        <div>
          {geo.pending && (
            <p role="status">
              A move of {metres(geo.pending.moved_m)} is waiting for approval, asked for on{' '}
              {new Date(geo.pending.created_at).toLocaleString()}. Until it is decided, the shop
              stays where it is.
            </p>
          )}
          {canManage && !geo.pending && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                save('TYPED', null);
              }}
            >
              <label>
                Latitude
                <input
                  value={latitude}
                  disabled={busy}
                  inputMode="decimal"
                  onChange={(e) => setLatitude(e.target.value)}
                />
              </label>
              <label>
                Longitude
                <input
                  value={longitude}
                  disabled={busy}
                  inputMode="decimal"
                  onChange={(e) => setLongitude(e.target.value)}
                />
              </label>
              <label>
                Why it is moving
                <input
                  value={reason}
                  disabled={busy}
                  maxLength={300}
                  placeholder="The shop moved two doors down"
                  onChange={(e) => setReason(e.target.value)}
                />
                <small>
                  A move of more than {geo.settings.retag_approval_m} m needs approval before it
                  takes effect.
                </small>
              </label>
              <button className="button primary" disabled={busy}>
                Save this location
              </button>{' '}
              <button type="button" className="button" disabled={busy} onClick={useDevice}>
                Use this device
              </button>
            </form>
          )}
          {nearby.length > 0 && (
            <div className="notice" role="status">
              Tagged within {geo.settings.duplicate_within_m} m of{' '}
              {nearby.map((n) => `${n.code} (${n.metres} m)`).join(', ')}. Check it is not the same
              shop entered twice.
            </div>
          )}
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Source</th>
            <th>Moved</th>
            <th>Status</th>
            <th>Asked by</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {geo.history.map((entry: any) => (
            <tr key={entry.id}>
              <td>{new Date(entry.created_at).toLocaleString()}</td>
              <td>
                {SOURCE_LABEL[entry.source] ?? entry.source}
                {entry.accuracy_m !== null && ` ±${entry.accuracy_m} m`}
              </td>
              <td>{metres(entry.moved_m)}</td>
              <td>{entry.status}</td>
              <td>{entry.requested_by || '—'}</td>
              <td>{entry.decision_reason || entry.reason || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!geo.history.length && <div className="empty">This shop has never been tagged.</div>}
    </section>
  );
}

// One customer: its answers, its location and the round it is on.
function CustomerDetail({
  csrf,
  customerId,
  permissions,
  onClose,
  onChanged,
}: {
  csrf: string;
  customerId: string;
  permissions: string[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const call = useApi(csrf);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    call(`reach/customers/${customerId}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [customerId, revision]);
  if (error)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!data) return <p role="status">Loading customer…</p>;
  const c = data.customer;
  const reload = () => {
    setRevision((x) => x + 1);
    onChanged();
  };
  return (
    <>
      <div className="toolbar">
        <button className="button" onClick={onClose}>
          ← Back to the register
        </button>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>
            {c.code} · {c.name}
          </h2>
          <span className="badge">{STATUS_LABEL[c.status] ?? c.status}</span>
        </div>
        <div className="check-row">
          <div>
            <strong>{c.type_name}</strong>
            <p>
              Territory {c.territory}
              {c.beat ? ` · beat ${c.beat}, stop ${c.beat_sequence ?? '—'}` : ' · not on a beat'}
              {c.town ? ` · ${c.town}` : ''}
              {c.rep ? ` · rep ${c.rep_name}` : ' · no rep'}
              {c.buys_from ? ` · buys from ${c.buys_from}` : ''}
            </p>
            {c.decision_reason && <p className="warning">{c.decision_reason}</p>}
          </div>
        </div>
        {data.sections.map((section: Section) => (
          <div className="check-row" key={section.section}>
            <div>
              <strong>{section.section}</strong>
              <dl className="answer-list">
                {section.fields.map((field) => (
                  <div key={field.field_key}>
                    <dt>{field.label}</dt>
                    <dd>
                      {c.attrs?.[field.field_key] === true
                        ? 'Yes'
                        : c.attrs?.[field.field_key] === false
                          ? 'No'
                          : (c.attrs?.[field.field_key] ?? '—') || '—'}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        ))}
        {!data.sections.length && (
          <div className="empty">
            This type asks no questions yet. Place its fields on the form in Setup.
          </div>
        )}
      </section>
      <GeoPanel
        csrf={csrf}
        customer={c}
        geo={data.geo}
        canManage={permissions.includes('reach.manage')}
        onChanged={reload}
      />
      {data.beat.length > 0 && (
        <section className="panel table-wrap">
          <div className="panel-heading">
            <h2>The round this shop is on</h2>
            <span className="badge">{data.beat.length} stops</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Stop</th>
                <th>Code</th>
                <th>Name</th>
                <th>Town</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.beat.map((stop: any) => (
                <tr key={stop.customer_id} className={stop.customer_id === c.id ? 'linked' : ''}>
                  <td>{stop.sequence}</td>
                  <td>{stop.code}</td>
                  <td>{stop.name}</td>
                  <td>{stop.town || '—'}</td>
                  <td>{STATUS_LABEL[stop.status] ?? stop.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

export function CustomerRegister({
  csrf,
  permissions,
  refreshKey,
}: {
  csrf: string;
  permissions: string[];
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const canManage = permissions.includes('reach.manage');
  const canRemove = permissions.includes('reach.delete');
  const page = usePaging();
  const [rows, setRows] = useState<any[]>([]);
  const [tiles, setTiles] = useState<any>(null);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [next, setNext] = useState<string | null>(null);
  const [types, setTypes] = useState<any[]>([]);
  const [filters, setFilters] = useState({
    type: '',
    status: '',
    beat: '',
    territory: '',
    geo: '',
  });
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState<any>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  const queryString = useMemo(() => {
    const parts = new URLSearchParams();
    parts.set('limit', String(page.size));
    if (search) parts.set('q', search);
    for (const [key, value] of Object.entries(filters)) if (value) parts.set(key, value);
    return parts.toString();
  }, [page.size, search, filters]);

  useEffect(() => {
    let live = true;
    call('reach/customer-types')
      .then((d) => live && setTypes(d.items))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [refreshKey]);

  useEffect(() => {
    let live = true;
    setBusy(true);
    setError('');
    call(`reach/customers?${queryString}${page.cursor ? '&cursor=' + page.cursor : ''}`)
      .then((d) => {
        if (!live) return;
        setRows(d.items);
        setTiles(d.tiles);
        setTotal(d.total);
        setNext(d.nextCursor);
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [queryString, page.cursor, revision, refreshKey]);

  function openForm(row: any) {
    setFieldErrors({});
    setError('');
    const typeCode = row ? row.type : types[0]?.code;
    if (!typeCode) return setError('Create a customer type in Setup first.');
    const typeId = row ? row.type_id : types.find((t) => t.code === typeCode)?.id;
    call(`reach/customer-form/${typeId}`)
      .then((d) => {
        setSections(d.sections);
        setForm(
          row
            ? {
                id: row.id,
                version: row.version,
                type: row.type,
                code: row.code,
                name: row.name,
                territory: row.territory,
                beat: row.beat ?? '',
                town: row.town,
                phone: row.phone,
                rep: row.rep ?? '',
                buys_from: row.buys_from ?? '',
                sales_customer: row.sales_customer ?? '',
                answers: { ...(row.attrs ?? {}) },
              }
            : { type: typeCode, answers: {} },
        );
      })
      .catch((e) => setError(e.message));
  }

  // Changing the type on a new customer changes the questions, so the form is fetched again.
  function changeType(typeCode: string) {
    const typeId = types.find((t) => t.code === typeCode)?.id;
    if (!typeId) return;
    call(`reach/customer-form/${typeId}`)
      .then((d) => {
        setSections(d.sections);
        setForm((current: any) => ({ ...current, type: typeCode, answers: {} }));
      })
      .catch((e) => setError(e.message));
  }

  function save() {
    setBusy(true);
    setError('');
    setFieldErrors({});
    const payload: any = {
      name: form.name ?? '',
      territory: form.territory ?? '',
      beat: form.beat ?? '',
      town: form.town ?? '',
      phone: form.phone ?? '',
      rep: form.rep ?? '',
      buys_from: form.buys_from ?? '',
      sales_customer: form.sales_customer ?? '',
      answers: form.answers ?? {},
    };
    if (form.id) payload.version = form.version;
    else Object.assign(payload, { code: form.code ?? '', type: form.type });
    call(`reach/customers${form.id ? '/' + form.id : ''}`, form.id ? 'PATCH' : 'POST', payload)
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

  function remove() {
    setBusy(true);
    setError('');
    call(`reach/customers/${removing.id}`, 'DELETE', { version: removing.version, reason })
      .then((d) => {
        setNotice(d.message);
        setRemoving(null);
        setReason('');
        setRevision((x) => x + 1);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }

  function setStatus(row: any, status: string) {
    setBusy(true);
    setError('');
    call(`reach/customers/${row.id}/status`, 'POST', { status, version: row.version })
      .then((d) => {
        setNotice(d.message);
        setRevision((x) => x + 1);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }

  if (open)
    return (
      <CustomerDetail
        csrf={csrf}
        customerId={open}
        permissions={permissions}
        onClose={() => setOpen(null)}
        onChanged={() => setRevision((x) => x + 1)}
      />
    );

  const filterSelect = (name: keyof typeof filters, label: string, options: [string, string][]) => (
    <label className="inline-field">
      {label}
      <select
        value={filters[name]}
        disabled={busy}
        onChange={(e) => {
          page.setCursors([]);
          setFilters({ ...filters, [name]: e.target.value });
        }}
      >
        <option value="">All</option>
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <>
      {tiles && (
        <section className="panel tile-row">
          {[
            ['On the register', tiles.total],
            ['Active', tiles.active],
            ['Awaiting approval', tiles.awaiting],
            ['Dormant', tiles.dormant],
            ['Location tagged', tiles.tagged],
            ['Verified by a device', tiles.verified],
            ['No rep', tiles.unassigned],
          ].map(([label, value]) => (
            <div className="tile" key={label as string}>
              <strong>{value as number}</strong>
              <span>{label as string}</span>
            </div>
          ))}
        </section>
      )}
      <div className="toolbar">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            page.setCursors([]);
            setSearch(query);
          }}
        >
          <input
            aria-label="Customer search"
            placeholder="Code or name starts with…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />{' '}
          <button className="button" disabled={busy}>
            Search
          </button>
        </form>
        {filterSelect(
          'type',
          'Type',
          types.map((t) => [t.code, t.name] as [string, string]),
        )}
        {filterSelect('status', 'Status', Object.entries(STATUS_LABEL) as [string, string][])}
        {filterSelect('geo', 'Location', [
          ['tagged', 'Tagged'],
          ['untagged', 'Not tagged'],
          ['verified', 'Verified'],
        ])}
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            download(`reach/customers.csv?${queryString}`, 'rare-os-customers.csv').catch((e) =>
              setError(e.message),
            )
          }
        >
          Download CSV
        </button>
        {canManage && (
          <button className="button primary" disabled={busy} onClick={() => openForm(null)}>
            Create customer
          </button>
        )}
      </div>
      <Banner error={error} notice={notice} />
      {form && (
        <section className="panel company-form">
          <h2>{form.id ? `Edit ${form.code}` : 'New customer'}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <label>
              Customer type *
              <select
                value={form.type}
                disabled={busy || !!form.id}
                onChange={(e) => changeType(e.target.value)}
              >
                {types.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.name}
                  </option>
                ))}
              </select>
              <small>
                The type decides the questions below, and cannot change once the customer exists.
              </small>
            </label>
            <CustomerForm
              sections={sections}
              form={form}
              fieldErrors={fieldErrors}
              busy={busy}
              editing={!!form.id}
              onChange={setForm}
            />
            <button className="button primary" disabled={busy}>
              Save customer
            </button>{' '}
            <button type="button" className="button" disabled={busy} onClick={() => setForm(null)}>
              Cancel
            </button>
          </form>
        </section>
      )}
      {removing && (
        <Modal
          title={`Remove customer ${removing.code}`}
          onClose={() => {
            setRemoving(null);
            setReason('');
          }}
        >
          <p>
            It goes off the register and off its beat. The record itself is kept, so anything that
            already refers to it still reads, and the code is free to use again.
          </p>
          <label>
            Reason (optional)
            <input
              value={reason}
              disabled={busy}
              maxLength={200}
              placeholder="Shop closed"
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
              <th>Code</th>
              <th>Name</th>
              <th>Type</th>
              <th>Territory</th>
              <th>Beat</th>
              <th>Stop</th>
              <th>Town</th>
              <th>Rep</th>
              <th>Location</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.code}</td>
                <td>{row.name}</td>
                <td>{row.type_name}</td>
                <td>{row.territory}</td>
                <td>{row.beat ?? '—'}</td>
                <td>{row.beat_sequence ?? '—'}</td>
                <td>{row.town || '—'}</td>
                <td>{row.rep ?? '—'}</td>
                <td>
                  {row.latitude === null ? 'Not tagged' : row.geo_verified ? 'Verified' : 'Tagged'}
                </td>
                <td>{STATUS_LABEL[row.status] ?? row.status}</td>
                <td>
                  <button
                    className="text-button"
                    aria-label={`Open customer ${row.code}`}
                    onClick={() => setOpen(row.id)}
                  >
                    Open
                  </button>
                  {canManage && (
                    <button
                      className="text-button"
                      aria-label={`Edit customer ${row.code}`}
                      onClick={() => openForm(row)}
                    >
                      Edit
                    </button>
                  )}
                  {canManage && row.status === 'ACTIVE' && (
                    <button
                      className="text-button"
                      aria-label={`Make customer ${row.code} dormant`}
                      onClick={() => setStatus(row, 'DORMANT')}
                    >
                      Dormant
                    </button>
                  )}
                  {canManage && row.status === 'DORMANT' && (
                    <button
                      className="text-button"
                      aria-label={`Make customer ${row.code} active`}
                      onClick={() => setStatus(row, 'ACTIVE')}
                    >
                      Activate
                    </button>
                  )}
                  {canRemove && (
                    <button
                      className="text-button warning"
                      aria-label={`Remove customer ${row.code}`}
                      onClick={() => {
                        setReason('');
                        setError('');
                        setRemoving(row);
                      }}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {busy && <p role="status">Loading customers…</p>}
        {!rows.length && !busy && (
          <div className="empty">
            {search || Object.values(filters).some(Boolean)
              ? 'No customers match this search.'
              : canManage
                ? 'No customers yet. Create one, or import the beat outlets.'
                : 'No customers yet.'}
          </div>
        )}
        <Pager
          page={page}
          next={next}
          total={total}
          shown={rows.length}
          busy={busy}
          noun="customers"
        />
      </section>
    </>
  );
}

// The round itself: which shops, in which order. The order is what the rep walks, so it is
// arranged here and nowhere else.
export function BeatRound({
  csrf,
  permissions,
  refreshKey,
}: {
  csrf: string;
  permissions: string[];
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const canManage = permissions.includes('reach.manage');
  const [beats, setBeats] = useState<any[]>([]);
  const [chosen, setChosen] = useState('');
  const [round, setRound] = useState<any>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let live = true;
    call('masters/beats?limit=100')
      .then((d) => {
        if (!live) return;
        setBeats(d.items);
        setChosen((current) => current || d.items[0]?.id || '');
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [refreshKey]);

  useEffect(() => {
    if (!chosen) return;
    let live = true;
    setBusy(true);
    setError('');
    call(`reach/beats/${chosen}/outlets`)
      .then((d) => {
        if (!live) return;
        setRound(d);
        setOrder(d.items.map((o: any) => o.customer_id));
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [chosen, revision, refreshKey]);

  function move(index: number, by: number) {
    const next = [...order];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
  }

  function saveOrder() {
    setBusy(true);
    setError('');
    call(`reach/beats/${chosen}/outlets`, 'PUT', { order })
      .then((d) => {
        setNotice(d.message);
        setRevision((x) => x + 1);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }

  const stops = round?.items ?? [];
  const byId = new Map(stops.map((o: any) => [o.customer_id, o]));
  const changed = stops.length > 0 && order.some((id, i) => stops[i]?.customer_id !== id);

  return (
    <>
      <div className="toolbar">
        <label className="inline-field">
          Beat
          <select value={chosen} disabled={busy} onChange={(e) => setChosen(e.target.value)}>
            {beats.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} · {b.name}
              </option>
            ))}
          </select>
        </label>
        {canManage && changed && (
          <button className="button primary" disabled={busy} onClick={() => saveOrder()}>
            Save this order
          </button>
        )}
        {canManage && changed && (
          <button
            className="button"
            disabled={busy}
            onClick={() => setOrder(stops.map((o: any) => o.customer_id))}
          >
            Undo
          </button>
        )}
      </div>
      <Banner error={error} notice={notice} />
      {!beats.length && !busy && (
        <div className="empty">No beats yet. Create one under Field setup.</div>
      )}
      {round && (
        <section className="panel">
          <div className="panel-heading">
            <h2>
              {round.beat.code} · {round.beat.name}
            </h2>
            <span className="badge">{stops.length} stops</span>
          </div>
          <div className="check-row">
            <div>
              <strong>
                {round.beat.frequency === 'WEEKLY'
                  ? `Every week on ${round.beat.run_days.split(',').join(', ')}`
                  : `${round.beat.week_parity === 'ODD' ? 'Odd' : 'Even'} weeks on ${round.beat.run_days.split(',').join(', ')}`}
              </strong>
              <p>
                Territory {round.beat.territory}
                {round.beat.rep ? ` · walked by ${round.beat.rep_name}` : ' · no rep holds it yet'}
              </p>
            </div>
          </div>
        </section>
      )}
      {round && (
        <section className="panel table-wrap">
          <table>
            <thead>
              <tr>
                <th>Stop</th>
                <th>Code</th>
                <th>Name</th>
                <th>Type</th>
                <th>Town</th>
                <th>Location</th>
                {canManage && <th>Move</th>}
              </tr>
            </thead>
            <tbody>
              {order.map((customerId, index) => {
                const stop: any = byId.get(customerId);
                if (!stop) return null;
                return (
                  <tr key={customerId}>
                    <td>{index + 1}</td>
                    <td>{stop.code}</td>
                    <td>{stop.name}</td>
                    <td>{stop.type}</td>
                    <td>{stop.town || '—'}</td>
                    <td>{stop.latitude === null ? 'Not tagged' : 'Tagged'}</td>
                    {canManage && (
                      <td>
                        <button
                          className="text-button"
                          aria-label={`Move ${stop.code} earlier`}
                          disabled={busy || index === 0}
                          onClick={() => move(index, -1)}
                        >
                          ↑
                        </button>
                        <button
                          className="text-button"
                          aria-label={`Move ${stop.code} later`}
                          disabled={busy || index === order.length - 1}
                          onClick={() => move(index, 1)}
                        >
                          ↓
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!stops.length && !busy && (
            <div className="empty">
              No stops yet. A customer joins this round when its type is visited on a beat, it is
              active, and this beat is the one on its record.
            </div>
          )}
        </section>
      )}
    </>
  );
}

// New accounts and location moves waiting for a decision.
export function Approvals({ csrf, refreshKey }: { csrf: string; refreshKey: number }) {
  const call = useApi(csrf);
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [decide, setDecide] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let live = true;
    setError('');
    call('reach/approvals')
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [revision, refreshKey]);

  function send(approve: boolean) {
    setBusy(true);
    setError('');
    const path =
      decide.kind === 'account'
        ? `reach/approvals/accounts/${decide.row.id}`
        : `reach/approvals/retags/${decide.row.id}`;
    const payload: any = { approve, reason };
    if (decide.kind === 'account') payload.version = decide.row.version;
    call(path, 'POST', payload)
      .then((d) => {
        setNotice(d.message);
        setDecide(null);
        setReason('');
        setRevision((x) => x + 1);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }

  if (error && !data)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!data) return <p role="status">Loading approvals…</p>;
  const waiting = data.accounts.length + data.retags.length;
  return (
    <>
      <Banner error={error} notice={notice} />
      <section className="panel">
        <div className="panel-heading">
          <h2>Waiting for a decision</h2>
          <span className="badge">{waiting}</span>
        </div>
        {!waiting && <div className="empty">Nothing is waiting. Everything has been decided.</div>}
      </section>
      {data.accounts.length > 0 && (
        <section className="panel table-wrap">
          <div className="panel-heading">
            <h2>New accounts</h2>
            <span className="badge">{data.accounts.length}</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Type</th>
                <th>Territory</th>
                <th>Town</th>
                <th>Asked</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {data.accounts.map((row: any) => (
                <tr key={row.id}>
                  <td>{row.code}</td>
                  <td>{row.name}</td>
                  <td>{row.type}</td>
                  <td>{row.territory}</td>
                  <td>{row.town || '—'}</td>
                  <td>{new Date(row.created_at).toLocaleDateString()}</td>
                  <td>
                    <button
                      className="text-button"
                      aria-label={`Decide account ${row.code}`}
                      onClick={() => {
                        setReason('');
                        setDecide({ kind: 'account', row });
                      }}
                    >
                      Decide
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {data.retags.length > 0 && (
        <section className="panel table-wrap">
          <div className="panel-heading">
            <h2>Location moves</h2>
            <span className="badge">{data.retags.length}</span>
          </div>
          <p className="small">
            A move of more than {data.settings.retag_approval_m} m needs a decision. Until then the
            shop stays where it was.
          </p>
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Moved</th>
                <th>Source</th>
                <th>Asked by</th>
                <th>Reason</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {data.retags.map((row: any) => (
                <tr key={row.id}>
                  <td>{row.code}</td>
                  <td>{row.name}</td>
                  <td>{metres(row.moved_m)}</td>
                  <td>
                    {SOURCE_LABEL[row.source] ?? row.source}
                    {row.accuracy_m !== null && ` ±${row.accuracy_m} m`}
                  </td>
                  <td>{row.requested_by || '—'}</td>
                  <td>{row.reason || '—'}</td>
                  <td>
                    <button
                      className="text-button"
                      aria-label={`Decide the move of ${row.code}`}
                      onClick={() => {
                        setReason('');
                        setDecide({ kind: 'retag', row });
                      }}
                    >
                      Decide
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {decide && (
        <Modal
          title={
            decide.kind === 'account'
              ? `Account ${decide.row.code}`
              : `Move ${decide.row.code} by ${decide.row.moved_m} m`
          }
          onClose={() => setDecide(null)}
        >
          <p>
            {decide.kind === 'account'
              ? 'Approving puts this account on the register, and on its beat if its type is visited on one. Rejecting keeps the record with the reason.'
              : 'Approving moves the shop to where it was tagged. Rejecting leaves it where it is. Either way the request is closed with your reason.'}
          </p>
          <label>
            Reason
            <input
              value={reason}
              disabled={busy}
              maxLength={300}
              placeholder="Needed when rejecting"
              onChange={(e) => setReason(e.target.value)}
            />
            <small>A rejection has to say why: the person who asked will read it.</small>
          </label>
          <div className="modal-actions">
            <button className="button destructive" disabled={busy} onClick={() => send(false)}>
              Reject
            </button>
            <button className="button primary" disabled={busy} onClick={() => send(true)}>
              Approve
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

// The four distances and days every location decision is measured against.
export function ReachSetup({
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
    setFieldErrors({});
    setNotice('');
    call('reach/settings', 'PUT', {
      gps_verified_m: Number(form.gps_verified_m),
      duplicate_within_m: Number(form.duplicate_within_m),
      retag_approval_m: Number(form.retag_approval_m),
      kyc_reminder_days: Number(form.kyc_reminder_days),
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

  if (!form) return <p role="status">Loading Reach settings…</p>;
  const field = (key: string, label: string, help: string) => (
    <label key={key}>
      {label}
      <input
        value={form[key]}
        disabled={busy || !canEdit}
        inputMode="numeric"
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
      {fieldErrors[key] ? (
        <small className="warning">{fieldErrors[key]}</small>
      ) : (
        <small>{help}</small>
      )}
    </label>
  );
  return (
    <>
      <Banner error={error} notice={notice} />
      <section className="panel company-form">
        <div className="panel-heading">
          <h2>Reach settings</h2>
          <span className="badge">
            {form.version === 0 ? 'Never changed' : `Version ${form.version}`}
          </span>
        </div>
        <p className="small">
          Every location decision is measured against these. A check-in radius and a credit hold
          belong to a customer type, not here, because they differ by type.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          {field(
            'gps_verified_m',
            'A device fix counts as verified within (m)',
            'Tighter means fewer tags stand as proof. The handover suggests 50 m.',
          )}
          {field(
            'duplicate_within_m',
            'Two shops this close are a possible duplicate (m)',
            'Only a warning on screen; nothing is blocked. The handover suggests 30 m.',
          )}
          {field(
            'retag_approval_m',
            'A move further than this needs approval (m)',
            'Below this a rep corrects a tag themselves. The handover suggests 100 m.',
          )}
          {field(
            'kyc_reminder_days',
            'Remind when missing papers have blocked ordering for (days)',
            'Read by the KYC work of a later milestone. The handover suggests 7 days.',
          )}
          {canEdit ? (
            <button className="button primary" disabled={busy}>
              Save settings
            </button>
          ) : (
            <p role="status">You can see these settings but not change them.</p>
          )}
        </form>
      </section>
    </>
  );
}
