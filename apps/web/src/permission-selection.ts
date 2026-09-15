import { requiredPermissions, livePermissionCodes } from '../../../packages/schema/permissions.mjs';
export { requiredPermissions };
export const livePermissions = new Set(livePermissionCodes);
export function selectPermissions(
  current: string[],
  codes: string[],
  enabled: boolean,
  allowed: string[],
) {
  const result = new Set(current);
  function grantable(code: string): boolean {
    return allowed.includes(code) && (requiredPermissions[code] || []).every(grantable);
  }
  function add(code: string) {
    if (!grantable(code)) return;
    result.add(code);
    for (const dependency of requiredPermissions[code] || []) add(dependency);
  }
  for (const code of codes) {
    if (enabled) add(code);
    else if (code !== 'dashboard.read' && allowed.includes(code)) result.delete(code);
  }
  if (!enabled) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [code, dependencies] of Object.entries(requiredPermissions))
        if (
          result.has(code) &&
          dependencies.some((d) => !result.has(d)) &&
          allowed.includes(code)
        ) {
          result.delete(code);
          changed = true;
        }
    }
  }
  if (allowed.includes('dashboard.read')) result.add('dashboard.read');
  return [...result];
}
