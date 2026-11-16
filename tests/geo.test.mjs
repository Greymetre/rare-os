// RCH-1: distance on the ground, and what a tag means once it is measured. Every location
// decision in Reach rests on these two functions, so they are checked against known distances
// rather than against themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { geoDecision, metresBetween } from '../packages/engines/geo.mjs';

const KOLKATA = { latitude: 22.5726, longitude: 88.3639 };
const settings = { gps_verified_m: 50, retag_approval_m: 100 };

test('distance matches the known length of a degree, and is symmetric', () => {
  // A hundredth of a degree of latitude is 1113 m anywhere on Earth, within a metre.
  const north = { latitude: 22.5826, longitude: 88.3639 };
  assert.ok(Math.abs(metresBetween(KOLKATA, north) - 1113) <= 2);
  assert.equal(metresBetween(KOLKATA, north), metresBetween(north, KOLKATA));
  assert.equal(metresBetween(KOLKATA, KOLKATA), 0);
  // A degree of longitude shortens with latitude: about 102.8 km at 22.57 degrees north.
  const east = { latitude: 22.5726, longitude: 89.3639 };
  assert.ok(Math.abs(metresBetween(KOLKATA, east) - 102800) < 400);
  // Numbers as strings, which is how Postgres returns a numeric column.
  assert.equal(metresBetween({ latitude: '22.5726', longitude: '88.3639' }, north), 1112);
});

test('a missing or unusable point has no distance rather than a wrong one', () => {
  for (const bad of [null, undefined, {}, { latitude: 1 }, { latitude: 'x', longitude: 1 }])
    assert.equal(metresBetween(KOLKATA, bad), null, JSON.stringify(bad));
  assert.equal(metresBetween(null, null), null);
});

test('the first tag of a shop moves nothing and needs nobody', () => {
  const first = geoDecision({
    previous: null,
    next: { ...KOLKATA, source: 'TYPED' },
    settings,
  });
  assert.deepEqual(first, { moved: null, needsApproval: false, verified: false });
});

test('only a device fix inside the company limit stands as proof', () => {
  const at = (source, accuracy) =>
    geoDecision({ previous: KOLKATA, next: { ...KOLKATA, source, accuracy_m: accuracy }, settings })
      .verified;
  assert.equal(at('DEVICE', 20), true);
  assert.equal(at('DEVICE', 50), true, 'exactly at the limit counts');
  assert.equal(at('DEVICE', 51), false);
  // A typed point or a dropped pin has no measured error, so it is never proof.
  assert.equal(at('TYPED', 5), false);
  assert.equal(at('PIN', 5), false);
  assert.equal(at('DEVICE', null), false, 'a fix with no accuracy proves nothing');
});

test('a move needs approval only beyond the limit, and the limit itself does not', () => {
  const move = (latitude) =>
    geoDecision({
      previous: KOLKATA,
      next: { latitude, longitude: KOLKATA.longitude, source: 'PIN' },
      settings,
    });
  // About 56 m north: a correction a rep makes themselves.
  assert.deepEqual(move(22.5731), { moved: 56, needsApproval: false, verified: false });
  // About 1112 m north: far past what a rep may do alone.
  const far = move(22.5826);
  assert.equal(far.moved, 1112);
  assert.equal(far.needsApproval, true);
  // Exactly at the limit is still the rep's own to make.
  const exact = geoDecision({
    previous: KOLKATA,
    next: { latitude: 22.5726, longitude: 88.36487, source: 'PIN' },
    settings,
  });
  assert.equal(exact.moved, 100);
  assert.equal(exact.needsApproval, false);
  // Raising the limit in Setup is what decides it, not anything hard-coded.
  assert.equal(
    geoDecision({
      previous: KOLKATA,
      next: { latitude: 22.5826, longitude: 88.3639, source: 'PIN' },
      settings: { ...settings, retag_approval_m: 2000 },
    }).needsApproval,
    false,
  );
});
