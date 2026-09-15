import { useState } from 'react';
import { livePermissions, selectPermissions } from './permission-selection';
type Permission = { code: string; module: string; description: string };
const help: Record<string, string> = {
  Dashboard: 'Workspace overview. Required for sign-in. Account security is personal to each user.',
  Users:
    'Manage creates and edits users, assigns existing roles, and sends invitations or password resets.',
  Roles:
    'View shows roles. Manage creates, edits and deletes custom roles. A user cannot edit their own assigned role.',
  Plants:
    'Manage creates and edits plants and includes access to all company plants. Assigning plants also requires Users → Manage.',
  'Audit log': 'View company-wide administrative history. No editing or deletion.',
};
const names: Record<string, string> = {
  dashboard: 'Dashboard',
  users: 'Users',
  roles: 'Roles',
  sites: 'Plants',
  audit: 'Audit log',
};
export function PermissionPicker({
  catalog,
  selected,
  allowed,
  disabled,
  onChange,
}: {
  catalog: Permission[];
  selected: string[];
  allowed: string[];
  disabled: boolean;
  onChange: (value: string[]) => void;
}) {
  const [query, setQuery] = useState(''),
    [future, setFuture] = useState(false);
  const futureCount = selected.filter((c) => !livePermissions.has(c)).length;
  const visible = catalog.filter(
    (p) =>
      (future || livePermissions.has(p.code)) &&
      `${names[p.code.split('.')[0]] || p.module} ${p.description} ${p.code}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const groups = [...new Set(visible.map((p) => names[p.code.split('.')[0]] || p.module))];
  const update = (codes: string[], enabled: boolean) =>
    onChange(selectPermissions(selected, codes, enabled, allowed));
  return (
    <div className="permission-picker">
      <div className="permission-summary">
        <strong>{selected.length} permissions selected</strong>
        <span>Choose what this role can see and manage.</span>
      </div>
      <div className="permission-tools">
        <label className="field">
          Search modules or actions
          <input
            placeholder="Search users, roles, plants…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label className="permission-future">
          <input type="checkbox" checked={future} onChange={(e) => setFuture(e.target.checked)} />
          Show future modules{futureCount > 0 ? ` (${futureCount} selected)` : ''}
        </label>
      </div>
      <div className="permission-shortcuts">
        <button
          type="button"
          className="button"
          disabled={disabled}
          onClick={() =>
            update(
              visible.filter((p) => p.code.endsWith('.read')).map((p) => p.code),
              true,
            )
          }
        >
          Select visible view permissions
        </button>
        <button
          type="button"
          className="button"
          disabled={disabled}
          onClick={() =>
            update(
              visible.map((p) => p.code),
              false,
            )
          }
        >
          Clear visible optional permissions
        </button>
      </div>
      <p className="small">
        Manage automatically includes the required View permissions. Removing View also removes
        dependent Manage permissions. You can only grant your own permissions.
      </p>
      <div className="permission-cards">
        {groups.map((group) => {
          const items = visible.filter((p) => (names[p.code.split('.')[0]] || p.module) === group);
          const planned = items.every((p) => !livePermissions.has(p.code));
          return (
            <fieldset className="permission-card" key={group} disabled={disabled}>
              <legend>
                {group}{' '}
                <span className="permission-count">
                  {items.filter((p) => selected.includes(p.code)).length}/{items.length}
                </span>
              </legend>
              <p className="small">
                {help[group] ||
                  'Reserved permissions for a future module. Selecting them does not enable an unfinished feature.'}
              </p>
              {planned && <span className="badge">Not implemented yet</span>}
              {items.map((p) => (
                <label className="permission-choice" key={p.code}>
                  <input
                    type="checkbox"
                    checked={selected.includes(p.code)}
                    disabled={p.code === 'dashboard.read' || !allowed.includes(p.code)}
                    onChange={(e) => update([p.code], e.target.checked)}
                  />
                  <span>
                    <strong>
                      {p.code.endsWith('.read')
                        ? 'View'
                        : p.code.endsWith('.manage')
                          ? 'Manage'
                          : p.code.split('.')[1].replaceAll('_', ' ')}
                    </strong>
                    <span>{p.description}</span>
                    <code>{p.code}</code>
                    {!allowed.includes(p.code) && <small>You cannot grant this permission.</small>}
                  </span>
                </label>
              ))}
            </fieldset>
          );
        })}
      </div>
      {!visible.length && (
        <p role="status">No matching permissions. Try another search or show future modules.</p>
      )}
      <p className="notice">
        To hide Roles &amp; permissions, leave both Roles permissions off. Users → Manage requires
        Roles → View to select an existing role, but does not allow editing role permissions.
        Platform company access is separate and cannot be granted here.
      </p>
    </div>
  );
}
