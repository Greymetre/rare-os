// RCH-1: how far apart two points on the ground are, in metres.
//
// Everything the field app and the approvals queue decide rests on this one number: whether a
// check-in counts as being at the shop, whether a re-tag needs the Sales Head, and whether two
// shops tagged yards apart are really the same shop entered twice. Pure, so those decisions can
// be tested without a device, a map or a database.

const EARTH_RADIUS_M = 6371008.8; // IUGG mean radius
const rad = (deg) => (deg * Math.PI) / 180;

// Great-circle distance, rounded to the metre. The haversine form is used rather than the simpler
// law of cosines because the distances here are small, where that form loses precision.
export function metresBetween(a, b) {
  for (const point of [a, b])
    if (
      !point ||
      !Number.isFinite(Number(point.latitude)) ||
      !Number.isFinite(Number(point.longitude))
    )
      return null;
  const lat1 = rad(Number(a.latitude)),
    lat2 = rad(Number(b.latitude));
  const dLat = lat2 - lat1,
    dLon = rad(Number(b.longitude) - Number(a.longitude));
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

// What a new or moved tag means, given the company's settings and where the tag was before.
// - moved: how far from the previous tag, or null for a first tag
// - needsApproval: the move is further than the company allows without a decision
// - verified: a device fix accurate enough to stand as proof; typed and dropped pins never are
export function geoDecision({ previous, next, settings }) {
  const moved = previous ? metresBetween(previous, next) : null;
  const accuracy =
    next.accuracy_m === null || next.accuracy_m === undefined ? null : Number(next.accuracy_m);
  return {
    moved,
    needsApproval: moved !== null && moved > Number(settings.retag_approval_m),
    verified:
      next.source === 'DEVICE' && accuracy !== null && accuracy <= Number(settings.gps_verified_m),
  };
}
