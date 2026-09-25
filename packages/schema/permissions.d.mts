export const permissions: string[][];
export const requiredPermissions: Record<string, string[]>;
export const livePermissionCodes: string[];
export const permissionScreens: Record<string, [string, string]>;
export function permissionPlacement(
  code: string,
  module?: string,
): { module: string; screens: string };
