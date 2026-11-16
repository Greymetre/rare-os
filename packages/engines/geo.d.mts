export type Point = { latitude: number | string; longitude: number | string };
export function metresBetween(a: Point | null, b: Point | null): number | null;
export function geoDecision(input: {
  previous: Point | null;
  next: Point & { source: string; accuracy_m?: number | null };
  settings: { retag_approval_m: number; gps_verified_m: number };
}): { moved: number | null; needsApproval: boolean; verified: boolean };
