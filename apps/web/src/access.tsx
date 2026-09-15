import { PermissionPicker } from './permission-picker';
import { useEffect, useRef, useState, type FormEvent } from 'react';
type Permission = { code: string; module: string; description: string };
type Role = {
  id: string;
  name: string;
  version: number;
  is_system: boolean;
  assigned: boolean;
  permission_count: number;
  permissions?: string[];
  is_own?: boolean;
};
type Account = {
  id: string;
  name: string;
  email: string;
  role: string;
  role_id: string;
  active: boolean;
  version: number;
  sync_state: string;
  sync_error?: string;
  emailEditable?: boolean;
  invitation_sent_at?: string;
  first_login_at?: string;
};
type Settings = { emailEnabled: boolean; localEmail: boolean; inboxUrl: string | null };
async function request<T>(path: string, csrf: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch('/api/' + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw Error(data.error?.message || 'Request failed. Please retry.');
  return data;
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="access-dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="modal-title">
        <h2>{title}</h2>
        <button type="button" className="text-button" aria-label="Close form" onClick={onClose}>
          ✕
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function AccessManagement({
  kind,
  csrf,
  permissions,
  refreshKey,
  onChanged,
}: {
  kind: 'roles' | 'users';
  csrf: string;
  permissions: string[];
  refreshKey: number;
  onChanged: () => void;
}) {
  const manage = permissions.includes(kind + '.manage');
  const [plantUser, setPlantUser] = useState<Account | null>(null);
  const [rows, setRows] = useState<(Role | Account)[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [catalog, setCatalog] = useState<Permission[]>([]),
    [settings, setSettings] = useState<Settings | null>(null),
    [revision, setRevision] = useState(0),
    [filter, setFilter] = useState('');
  const [edit, setEdit] = useState<Role | Account | 'new' | null>(null),
    [remove, setRemove] = useState<Role | null>(null);
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError('');
    const path = kind + '?q=' + encodeURIComponent(search);
    Promise.all([
      request<{ items: (Role | Account)[]; nextCursor: string | null }>(path, csrf),
      kind === 'roles'
        ? request<{ items: Permission[] }>('permissions', csrf)
        : Promise.resolve(null),
      kind === 'users' ? request<Settings>('access-settings', csrf) : Promise.resolve(null),
    ])
      .then(([list, perms, config]) => {
        if (!live) return;
        setRows(list.items);
        setCursor(list.nextCursor);
        setCatalog(perms?.items || []);
        setSettings(config);
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [kind, csrf, search, revision, refreshKey]);
  async function next() {
    if (!cursor) return;
    setBusy(true);
    try {
      const d = await request<{ items: (Role | Account)[]; nextCursor: string | null }>(
        kind + '?after=' + cursor + '&q=' + encodeURIComponent(search),
        csrf,
      );
      setRows(d.items);
      setCursor(d.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function open(row: Role | Account) {
    setError('');
    try {
      setEdit(await request<Role | Account>(kind + '/' + row.id, csrf));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function action(row: Account, which: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const d = await request<{ message: string }>(
        'users/' + row.id + '/' + which,
        csrf,
        'POST',
        {},
      );
      setNotice(d.message);
      setRevision((x) => x + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function saved(message: string) {
    setEdit(null);
    setNotice(message);
    setRevision((x) => x + 1);
    onChanged();
  }
  async function deleteRole() {
    if (!remove) return;
    setBusy(true);
    setError('');
    try {
      const d = await request<{ message: string }>('roles/' + remove.id, csrf, 'DELETE', {
        version: remove.version,
      });
      setRemove(null);
      setNotice(d.message);
      setRevision((x) => x + 1);
    } catch (e) {
      setError((e as Error).message);
      setRemove(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="access-management">
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
          <button className="text-button" onClick={() => setRevision((x) => x + 1)}>
            Refresh records
          </button>
        </div>
      )}
      <section className="panel">
        <div className="panel-heading">
          <h2>{kind === 'roles' ? 'Company roles' : 'Company users'}</h2>
          {manage && (
            <button
              className="button primary"
              onClick={() => {
                setError('');
                setEdit('new');
              }}
            >
              {kind === 'roles' ? 'Create role' : 'Create user'}
            </button>
          )}
        </div>
        <form
          className="search-bar"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(query.trim());
          }}
        >
          <input
            aria-label={kind === 'roles' ? 'Search role name' : 'Search user email'}
            placeholder={kind === 'roles' ? 'Role name starts with…' : 'Email starts with…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={80}
          />
          <button className="button" disabled={busy}>
            Search
          </button>
          {search && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setSearch('');
                setQuery('');
              }}
            >
              Clear search
            </button>
          )}
        </form>
        {busy ? (
          <div className="loading" role="status">
            Loading…
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {(kind === 'roles'
                      ? ['Role', 'Permissions', 'Assigned', 'Actions']
                      : ['Name / email', 'Role', 'Status', 'Account setup', 'Actions']
                    ).map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    if (kind === 'roles') {
                      const x = row as Role;
                      return (
                        <tr key={x.id}>
                          <td>
                            <strong>{x.name}</strong>
                            {x.is_system && <span className="badge">Protected</span>}
                          </td>
                          <td>{x.permission_count}</td>
                          <td>{x.assigned ? 'Yes' : 'No'}</td>
                          <td>
                            <div className="row-actions">
                              <button
                                className="text-button"
                                onClick={() => void open(x)}
                                aria-label={
                                  (x.is_system || x.is_own || !manage ? 'View' : 'Edit') +
                                  ' role ' +
                                  x.name
                                }
                              >
                                {x.is_system || x.is_own || !manage ? 'View' : 'Edit'}
                              </button>
                              {manage && !x.is_system && !x.is_own && (
                                <button
                                  className="text-button danger"
                                  onClick={() => setRemove(x)}
                                  aria-label={'Delete role ' + x.name}
                                >
                                  Delete
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    }
                    const x = row as Account;
                    return (
                      <tr key={x.id}>
                        <td>
                          <strong>{x.name}</strong>
                          <div>{x.email}</div>
                        </td>
                        <td>{x.role}</td>
                        <td>
                          <span className={'status ' + (x.active ? 'ready' : '')}>
                            {x.active ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        <td>
                          <span className={'status ' + (x.sync_state === 'ready' ? 'ready' : '')}>
                            {x.sync_state === 'ready'
                              ? x.first_login_at
                                ? 'Onboarding complete'
                                : 'Ready'
                              : x.sync_state === 'failed'
                                ? 'Needs attention'
                                : 'Pending'}
                          </span>
                          {x.sync_error && <p className="inline-error">{x.sync_error}</p>}
                          {x.first_login_at ? (
                            <div
                              className="small muted"
                              title={new Date(x.first_login_at).toLocaleString()}
                            >
                              First login completed
                            </div>
                          ) : x.invitation_sent_at ? (
                            <div className="small muted">Invitation sent · First login pending</div>
                          ) : null}
                        </td>
                        <td>
                          {manage && (
                            <div className="row-actions">
                              <button
                                className="text-button"
                                aria-label={'Edit user ' + x.name}
                                onClick={() => void open(x)}
                              >
                                Edit
                              </button>
                              {permissions.includes('sites.manage') && (
                                <button
                                  className="text-button"
                                  aria-label={'Plant access for ' + x.name}
                                  onClick={() => setPlantUser(x)}
                                >
                                  Plant access
                                </button>
                              )}
                              {x.sync_state !== 'ready' ? (
                                <button
                                  className="text-button"
                                  onClick={() => void action(x, 'retry')}
                                >
                                  Retry setup
                                </button>
                              ) : (
                                x.active && (
                                  <>
                                    {!x.first_login_at && (
                                      <button
                                        className="text-button"
                                        disabled={!settings?.emailEnabled}
                                        aria-label={'Send invitation to ' + x.name}
                                        onClick={() => void action(x, 'invite')}
                                      >
                                        Send invitation
                                      </button>
                                    )}
                                    <button
                                      className="text-button"
                                      disabled={!settings?.emailEnabled}
                                      aria-label={'Reset password for ' + x.name}
                                      onClick={() => void action(x, 'reset-password')}
                                    >
                                      Reset password
                                    </button>
                                  </>
                                )
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!rows.length && (
              <div className="empty">
                {search
                  ? 'No matching records. Try a different prefix.'
                  : kind === 'roles'
                    ? 'No roles yet. Create a role to define access.'
                    : 'No users found in this company.'}
              </div>
            )}
            <div className="table-footer">
              <span>{rows.length} records on this page</span>
              <div className="row-actions">
                <button className="text-button" onClick={() => setRevision((x) => x + 1)}>
                  First page
                </button>
                {cursor && (
                  <button className="button" onClick={() => void next()}>
                    Next page →
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </section>
      {kind === 'users' && (
        <div className="notice access-note">
          {settings?.localEmail ? (
            <>
              Local email testing is enabled. Invitations and reset links stay in the{' '}
              <a href={settings.inboxUrl!} target="_blank" rel="noreferrer">
                test inbox
              </a>
              ; they are not sent to real mailboxes.
            </>
          ) : settings?.emailEnabled ? (
            'Invitation and password-reset emails use your configured email service.'
          ) : (
            'Email delivery is not configured. User accounts can be saved; configure SMTP before sending invitations.'
          )}{' '}
          Assign plant access from the user actions.
        </div>
      )}
      {kind === 'roles' && (
        <section className="panel permission-panel">
          <div className="panel-heading">
            <h2>Permission catalog</h2>
            <input
              aria-label="Filter permissions"
              placeholder="Filter permissions…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <p className="panel-note">
            Permissions come from the module seeder. Select them when creating a role.
          </p>
          <div className="permission-grid">
            {catalog
              .filter((p) =>
                (p.code + ' ' + p.description).toLowerCase().includes(filter.toLowerCase()),
              )
              .map((p) => (
                <div key={p.code}>
                  <span className="badge">{p.module}</span>
                  <h3>{p.description}</h3>
                  <code>{p.code}</code>
                </div>
              ))}
          </div>
        </section>
      )}
      {plantUser && (
        <PlantAccess
          user={plantUser}
          csrf={csrf}
          onClose={() => setPlantUser(null)}
          onSaved={(m) => {
            setPlantUser(null);
            saved(m);
          }}
        />
      )}
      {edit && kind === 'roles' && (
        <RoleForm
          initial={edit as Role | 'new'}
          csrf={csrf}
          catalog={catalog}
          allowed={permissions}
          canEdit={manage}
          onClose={() => setEdit(null)}
          onSaved={saved}
        />
      )}
      {edit && kind === 'users' && (
        <UserForm
          initial={edit as Account | 'new'}
          csrf={csrf}
          onClose={() => setEdit(null)}
          onSaved={saved}
        />
      )}
      {remove && (
        <Modal title="Delete role" onClose={() => !busy && setRemove(null)}>
          <p className="modal-body">
            Delete <strong>{remove.name}</strong>? A role assigned to any user cannot be deleted.
            Reassign those users first.
          </p>
          <div className="modal-actions">
            <button className="button" disabled={busy} onClick={() => setRemove(null)}>
              Cancel
            </button>
            <button
              className="button destructive"
              disabled={busy}
              onClick={() => void deleteRole()}
            >
              Confirm delete
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function RoleForm({
  initial,
  csrf,
  catalog,
  allowed,
  canEdit,
  onClose,
  onSaved,
}: {
  initial: Role | 'new';
  csrf: string;
  catalog: Permission[];
  allowed: string[];
  canEdit: boolean;
  onClose: () => void;
  onSaved: (m: string) => void;
}) {
  const existing = initial === 'new' ? null : initial,
    readonly = !canEdit || !!existing?.is_system || !!existing?.is_own;
  const [name, setName] = useState(existing?.name || ''),
    [selected, setSelected] = useState<string[]>(existing?.permissions || ['dashboard.read']),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await request<{ message: string }>(
        'roles' + (existing ? '/' + existing.id : ''),
        csrf,
        existing ? 'PATCH' : 'POST',
        { name, permissions: selected, ...(existing ? { version: existing.version } : {}) },
      );
      onSaved(data.message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={readonly ? 'View role' : existing ? 'Edit role' : 'Create role'}
      onClose={() => !busy && onClose()}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <label className="field">
            Role name
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={2}
              maxLength={80}
              disabled={readonly || busy}
            />
          </label>
          {readonly && (
            <div className="notice">
              {existing?.is_system
                ? 'Main Admin is protected. Its full access is maintained by the permission seeder.'
                : existing?.is_own
                  ? 'This is your assigned role. Ask another administrator to change its permissions.'
                  : 'You have read-only access to this role.'}
            </div>
          )}
          <PermissionPicker
            catalog={catalog}
            selected={selected}
            allowed={allowed}
            disabled={readonly || busy}
            onChange={setSelected}
          />
        </div>
        <div className="modal-actions">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            {readonly ? 'Close' : 'Cancel'}
          </button>
          {!readonly && (
            <button className="button primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save role'}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
function UserForm({
  initial,
  csrf,
  onClose,
  onSaved,
}: {
  initial: Account | 'new';
  csrf: string;
  onClose: () => void;
  onSaved: (m: string) => void;
}) {
  const old = initial === 'new' ? null : initial;
  const [name, setName] = useState(old?.name || ''),
    [email, setEmail] = useState(old?.email || ''),
    [roleId, setRoleId] = useState(old?.role_id || ''),
    [active, setActive] = useState(old?.active ?? true),
    [roles, setRoles] = useState<Role[]>([]),
    [q, setQ] = useState(''),
    [next, setNext] = useState<string | null>(null),
    [roleBusy, setRoleBusy] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const requestId = useRef(crypto.randomUUID());
  useEffect(() => {
    let live = true;
    setRoleBusy(true);
    const timer = setTimeout(() => {
      request<{ items: Role[]; nextCursor: string | null }>(
        'roles?limit=100&q=' + encodeURIComponent(q),
        csrf,
      )
        .then(async (d) => {
          if (old?.role_id && !d.items.some((x) => x.id === old.role_id)) {
            const selected = await request<Role>('roles/' + old.role_id, csrf);
            d.items.unshift(selected);
          }
          if (live) {
            setRoles(d.items);
            setNext(d.nextCursor);
          }
        })
        .catch((e) => {
          if (live) setError(e.message);
        })
        .finally(() => {
          if (live) setRoleBusy(false);
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, csrf, old?.role_id]);
  async function more() {
    if (!next) return;
    setRoleBusy(true);
    try {
      const d = await request<{ items: Role[]; nextCursor: string | null }>(
        'roles?limit=100&after=' + next + '&q=' + encodeURIComponent(q),
        csrf,
      );
      setRoles((r) => [...r, ...d.items.filter((x) => !r.some((y) => y.id === x.id))]);
      setNext(d.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRoleBusy(false);
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const payload = old
        ? { name, roleId, active, version: old.version, ...(old.emailEditable ? { email } : {}) }
        : { name, email, roleId, requestId: requestId.current };
      const result = await request<{ message: string }>(
        'users' + (old ? '/' + old.id : ''),
        csrf,
        old ? 'PATCH' : 'POST',
        payload,
      );
      onSaved(result.message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={old ? 'Edit user' : 'Create user'} onClose={() => !busy && onClose()}>
      <form onSubmit={submit}>
        <div className="modal-body">
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <label className="field">
            Full name
            <input
              autoFocus
              required
              minLength={2}
              maxLength={120}
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            Email address
            <input
              type="email"
              required
              maxLength={254}
              value={email}
              disabled={busy || (!!old && !old.emailEditable)}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          {old && (
            <p className="field-help">
              Existing login email is protected. Pending account email can be corrected before
              identity setup completes.
            </p>
          )}
          <label className="field">
            Find role
            <input
              placeholder="Role name starts with…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="field">
            Assign role
            <select
              required
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
              disabled={busy || roleBusy}
            >
              <option value="">{roleBusy ? 'Loading roles…' : 'Select a role'}</option>
              {roles.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          {next && (
            <button
              type="button"
              className="text-button"
              disabled={roleBusy}
              onClick={() => void more()}
            >
              Load more roles
            </button>
          )}
          {!roleBusy && !roles.length && (
            <p className="inline-error">
              No roles found. Create a role first or change your search.
            </p>
          )}
          {old && (
            <label className="field">
              Account status
              <select
                value={active ? 'active' : 'inactive'}
                disabled={busy}
                onChange={(e) => setActive(e.target.value === 'active')}
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>
          )}
          <div className="notice">
            {old
              ? 'Role changes and deactivation apply immediately. Affected users will need to sign in again.'
              : 'An invitation lets the user verify their email and set their own password. No password is stored in this form.'}
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="button primary" disabled={busy || roleBusy || !roleId}>
            {busy ? 'Saving account…' : old ? 'Save user' : 'Create user'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PlantAccess({
  user,
  csrf,
  onClose,
  onSaved,
}: {
  user: Account;
  csrf: string;
  onClose: () => void;
  onSaved: (m: string) => void;
}) {
  const [grant, setGrant] = useState<any>(null),
    [selected, setSelected] = useState<string[]>([]),
    [plants, setPlants] = useState<any[]>([]),
    [next, setNext] = useState<string | null>(null),
    [q, setQ] = useState(''),
    [search, setSearch] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setBusy(true);
    Promise.all([
      request<any>('users/' + user.id + '/plants', csrf),
      request<any>('plants?limit=100', csrf),
    ])
      .then(([g, p]) => {
        if (live) {
          setGrant(g);
          setSelected(g.plantIds);
          setPlants(p.items);
          setNext(p.nextCursor);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [user.id]);
  async function load(after?: string) {
    setBusy(true);
    setError('');
    try {
      const d = await request<any>(
        'plants?limit=100&q=' + encodeURIComponent(q) + (after ? '&after=' + after : ''),
        csrf,
      );
      setSearch(q);
      setPlants((old) => (after ? [...old, ...d.items] : d.items));
      setNext(d.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={'Plant access: ' + user.name} onClose={() => !busy && onClose()}>
      <div className="modal-body">
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {busy && <p role="status">Please wait…</p>}
        {grant?.allPlants ? (
          <p className="notice">
            This role has access to all company plants. Assign a limited role without Manage company
            sites to restrict plant access.
          </p>
        ) : (
          <>
            <p>
              Select the active plants this user may access. No selection means no plant access.{' '}
              {selected.length} selected.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void load();
              }}
            >
              <input
                aria-label="Find plant"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Plant name starts with…"
              />
              <button className="button" disabled={busy}>
                Search
              </button>
            </form>
            <button className="text-button" disabled={busy} onClick={() => setSelected([])}>
              Clear all selections
            </button>
            {plants.map((p) => (
              <label className="permission-option" key={p.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(p.id)}
                  disabled={busy || (!p.active && !selected.includes(p.id))}
                  onChange={() =>
                    setSelected((ids) =>
                      ids.includes(p.id) ? ids.filter((id) => id !== p.id) : [...ids, p.id],
                    )
                  }
                />
                {p.name} ({p.code}){!p.active ? ' — inactive; remove access before saving' : ''}
              </label>
            ))}
            {!plants.length && !busy && (
              <p>No matching plants. Create a plant first or change the search.</p>
            )}
            {next && (
              <button
                className="button"
                disabled={busy || q !== search}
                onClick={() => void load(next)}
              >
                Load more plants
              </button>
            )}
          </>
        )}
      </div>
      <div className="modal-actions">
        <button className="button" disabled={busy} onClick={onClose}>
          Close
        </button>
        {grant && !grant.allPlants && (
          <button
            className="button primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError('');
              void request<any>('users/' + user.id + '/plants', csrf, 'PUT', {
                plantIds: selected,
                version: grant.version,
              })
                .then((d) => onSaved(d.message))
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            Save plant access
          </button>
        )}
      </div>
    </Modal>
  );
}
