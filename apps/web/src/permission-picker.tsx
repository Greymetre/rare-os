import { useEffect, useRef, useState } from 'react';
import { livePermissions, selectPermissions } from './permission-selection';
type Permission = { code: string; module: string; description: string };
const columns = ['View', 'Create', 'Edit', 'Delete', 'Other actions'];
const action = (code: string) =>
  ({ read: 'View', create: 'Create', update: 'Edit', delete: 'Delete' })[code.split('.')[1]] ||
  'Other actions';
function BulkCheck({
  label,
  codes,
  selected,
  disabled,
  onChange,
}: {
  label: string;
  codes: string[];
  selected: string[];
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const count = codes.filter((c) => selected.includes(c)).length;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = count > 0 && count < codes.length;
  }, [count, codes.length]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={codes.length > 0 && count === codes.length}
      disabled={disabled || !codes.length}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}
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
  const visible = catalog.filter(
    (p) =>
      (future || livePermissions.has(p.code)) &&
      `${p.module} ${p.description} ${p.code}`.toLowerCase().includes(query.toLowerCase()),
  );
  const groups = [...new Set(visible.map((p) => p.module))];
  const update = (codes: string[], enabled: boolean) =>
    onChange(selectPermissions(selected, codes, enabled, allowed));
  const editable = (items: Permission[]) =>
    items.map((p) => p.code).filter((c) => c !== 'dashboard.read' && allowed.includes(c));
  return (
    <div className="permission-picker">
      <div className="permission-summary">
        <strong>{selected.length} permissions selected</strong>
        <span>Choose each action this role can perform.</span>
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
          Show future modules
        </label>
      </div>
      <div className="permission-shortcuts">
        <button
          type="button"
          className="button"
          disabled={disabled}
          onClick={() => update(editable(visible), true)}
        >
          Select visible permissions
        </button>
        <button
          type="button"
          className="button"
          disabled={disabled}
          onClick={() => update(editable(visible), false)}
        >
          Clear visible optional permissions
        </button>
      </div>
      <p className="small">
        Required View permissions are included automatically. Removing a required permission also
        removes its dependent actions. Only permissions you hold can be granted.
      </p>
      <div className="permission-matrix-scroll">
        <table className="permission-matrix">
          <caption className="sr-only">Module and action permissions</caption>
          <thead>
            <tr>
              <th>Module</th>
              {columns.map((column) => {
                const codes = editable(visible.filter((p) => action(p.code) === column));
                return (
                  <th key={column}>
                    <label>
                      <BulkCheck
                        label={`Select visible ${column} permissions`}
                        codes={codes}
                        selected={selected}
                        disabled={disabled}
                        onChange={(v) => update(codes, v)}
                      />
                      {column}
                    </label>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const items = visible.filter((p) => p.module === group),
                codes = editable(items);
              return (
                <tr key={group} data-permission-module={group}>
                  <th scope="row">
                    <label>
                      <BulkCheck
                        label={`Select ${group} permissions`}
                        codes={codes}
                        selected={selected}
                        disabled={disabled}
                        onChange={(v) => update(codes, v)}
                      />
                      {group}
                    </label>
                    <small>
                      {items.filter((p) => selected.includes(p.code)).length}/{items.length}{' '}
                      selected
                    </small>
                    {items.every((p) => !livePermissions.has(p.code)) && (
                      <span className="badge">Not implemented yet</span>
                    )}
                  </th>
                  {columns.map((column) => (
                    <td key={column}>
                      {items.filter((p) => action(p.code) === column).length ? (
                        items
                          .filter((p) => action(p.code) === column)
                          .map((p) => (
                            <label className="matrix-choice" key={p.code} title={p.description}>
                              <input
                                type="checkbox"
                                aria-label={p.description}
                                checked={selected.includes(p.code)}
                                disabled={
                                  disabled ||
                                  p.code === 'dashboard.read' ||
                                  !allowed.includes(p.code)
                                }
                                onChange={(e) => update([p.code], e.target.checked)}
                              />
                              <span>
                                {column === 'Other actions' ? p.description : column}
                                {!allowed.includes(p.code) && <small>Not available to grant</small>}
                              </span>
                            </label>
                          ))
                      ) : (
                        <span className="muted" aria-label="Action not available">
                          —
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!visible.length && <p role="status">No matching permissions. Try another search.</p>}
      <p className="notice">
        Roles → Edit controls permission changes. Users → Edit does not grant role editing; changing
        a user's assigned role needs its own permission. Plant visibility is separate from plant
        editing. Company management is restricted to Platform Admin.
      </p>
    </div>
  );
}
