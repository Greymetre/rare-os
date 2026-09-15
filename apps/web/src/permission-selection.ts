export const requiredPermissions: Record<string, string[]> = {
  'users.manage': ['users.read', 'roles.read'],
  'roles.manage': ['roles.read'],
  'sites.manage': ['sites.read'],
};
export const livePermissions = new Set([
  'dashboard.read',
  'users.read',
  'users.manage',
  'roles.read',
  'roles.manage',
  'sites.read',
  'sites.manage',
  'audit.read',
]);
export function selectPermissions(
  current: string[],
  codes: string[],
  enabled: boolean,
  allowed: string[],
) {
  const result = new Set(current);
  function add(code: string) {
    if (!allowed.includes(code)) return;
    result.add(code);
    for (const dependency of requiredPermissions[code] || []) add(dependency);
  }
  for (const code of codes) {
    if (enabled) add(code);
    else if (code !== 'dashboard.read' && allowed.includes(code)) result.delete(code);
  }
  if (!enabled) {
    for (const [code, dependencies] of Object.entries(requiredPermissions))
      if (dependencies.some((d) => !result.has(d)) && allowed.includes(code)) result.delete(code);
  }
  if (allowed.includes('dashboard.read')) result.add('dashboard.read');
  return [...result];
}
