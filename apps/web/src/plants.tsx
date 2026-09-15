import { useEffect, useState } from 'react';
export function Plants({
  csrf,
  permissions,
  refreshKey,
}: {
  csrf: string;
  permissions: string[];
  refreshKey: number;
}) {
  const canCreate = permissions.includes('sites.create');
  const canEdit = permissions.includes('sites.update');
  const [rows, setRows] = useState<any[]>([]),
    [form, setForm] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [search, setSearch] = useState(''),
    [query, setQuery] = useState(''),
    [after, setAfter] = useState<string | null>(null),
    [next, setNext] = useState<string | null>(null),
    [revision, setRevision] = useState(0);
  async function call(path: string, method = 'GET', data?: unknown) {
    const r = await fetch('/api/' + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const d = await r.json();
    if (!r.ok) throw Error(d.error?.message || 'Could not load plants. Retry.');
    return d;
  }
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError('');
    call('plants?q=' + encodeURIComponent(search) + (after ? '&after=' + after : ''))
      .then((d) => {
        if (!cancelled) {
          setRows(d.items);
          setNext(d.nextCursor);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [search, after, revision, refreshKey]);
  return (
    <>
      <div className="table-footer">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setAfter(null);
            setSearch(query);
          }}
        >
          <input
            aria-label="Plant search"
            placeholder="Plant name starts with…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />{' '}
          <button className="button" disabled={busy}>
            Search
          </button>
        </form>
        {canCreate && (
          <button
            className="button primary"
            disabled={busy}
            onClick={() => setForm({ code: '', name: '', location: '', timezone: 'Asia/Kolkata' })}
          >
            Create plant
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
      {busy && <p role="status">Loading plants…</p>}
      {form && (
        <section className="panel company-form">
          <h2>{form.id ? 'Edit plant' : 'New plant'}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              const { id, tenant_id, code, ...rest } = form;
              void call(
                'plants' + (id ? '/' + id : ''),
                id ? 'PATCH' : 'POST',
                id
                  ? {
                      name: rest.name,
                      location: rest.location,
                      timezone: rest.timezone,
                      active: rest.active,
                      version: rest.version,
                    }
                  : { ...rest, code },
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
            {['code', 'name', 'location', 'timezone'].map((k) => (
              <label key={k}>
                {
                  (
                    {
                      code: 'Plant code',
                      name: 'Plant name',
                      location: 'Location',
                      timezone: 'Timezone',
                    } as any
                  )[k]
                }
                <input
                  required
                  value={form[k]}
                  disabled={busy || (k === 'code' && !!form.id)}
                  maxLength={k === 'location' ? 200 : k === 'name' ? 120 : k === 'code' ? 30 : 80}
                  onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                />
              </label>
            ))}
            {form.id && (
              <label>
                Status
                <select
                  disabled={busy || !permissions.includes('sites.change_status')}
                  value={String(form.active)}
                  onChange={(e) => setForm({ ...form, active: e.target.value === 'true' })}
                >
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </label>
            )}
            <button className="button primary" disabled={busy}>
              Save plant
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
              <th>Plant</th>
              <th>Code</th>
              <th>Location</th>
              <th>Timezone</th>
              <th>Status</th>
              {canEdit && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>{r.code}</td>
                <td>{r.location}</td>
                <td>{r.timezone}</td>
                <td>{r.active ? 'Active' : 'Inactive'}</td>
                {canEdit && (
                  <td>
                    <button
                      className="text-button"
                      aria-label={'Edit plant ' + r.name}
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
        {!rows.length && !busy && (
          <div className="empty">
            {canCreate
              ? 'No plants yet. Create your first plant.'
              : 'No active plants assigned. Ask your company administrator for plant access.'}
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
      <p className="notice">
        {permissions.includes('sites.read_all')
          ? 'This role can access all company plants. To limit access, remove Access all company plants and assign individual plants from Users.'
          : 'Only your assigned active plants are shown. Business modules will use the same plant access checks.'}
      </p>
    </>
  );
}
