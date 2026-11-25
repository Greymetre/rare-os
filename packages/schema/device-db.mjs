// RCH-8: what a phone has to be holding before the network goes away, and what it says when the
// network comes back.
//
// The whole of the mobile app's offline promise rests on one thing happening while there is
// still a signal: the phone must already have everything it needs to let a rep work. Not a
// cached page — the actual round, the actual shops, the actual prices for those shops today,
// the actual questions on the visit form. A rep standing in a market with no bars cannot be
// told "we could not load the price list".
//
// So this is deliberately one request and not eight. On a bad line eight requests is eight
// chances to fail halfway and leave the phone holding a day it cannot work, and a rep who has to
// guess which half loaded. One request either arrives or does not, and the phone knows which.
//
// Nothing here writes anything about a rep's work. The only write in this file is a heartbeat:
// counts of what a phone is still carrying, so that a rep who says "my day did not go in" can be
// answered with evidence instead of a shrug.

// The round, the shops on it, and everything needed to serve each one. The prices come per
// customer type rather than per shop because that is how the rate list is actually organised,
// and sending one copy per shop would multiply the payload for nothing.
export async function bootstrapFor(db, { repId, workDate }) {
  const rep = (
    await db.query(
      `SELECT r.id, r.code, r.name, r.hq_town, r.territory_id, g.code AS grade
         FROM field_reps r LEFT JOIN rep_grades g ON g.id=r.grade_id
        WHERE r.id=$1`,
      [repId],
    )
  ).rows[0];
  if (!rep) return null;

  const workTypes = (
    await db.query(
      `SELECT id, code, name, needs_location FROM work_types
        WHERE deleted_at IS NULL AND active ORDER BY code`,
    )
  ).rows;

  const stops = (
    await db.query(
      `SELECT o.customer_id, o.sequence, c.code, c.name, c.town, c.status,
              c.latitude, c.longitude, c.type_id, t.code AS type, t.name AS type_name,
              t.checkin_radius_m, d.beat_id, coalesce(b.code,'') AS beat
         FROM tour_plan_days d
         JOIN tour_plans p ON p.id=d.plan_id
         JOIN beats b ON b.id=d.beat_id
         JOIN beat_outlets o ON o.beat_id=d.beat_id
         JOIN trade_customers c ON c.id=o.customer_id
         JOIN customer_types t ON t.id=c.type_id
        WHERE p.rep_id=$1 AND d.work_date=$2 AND c.deleted_at IS NULL
        ORDER BY o.sequence`,
      [repId, workDate],
    )
  ).rows.map((r) => ({
    ...r,
    checkin_radius_m: r.checkin_radius_m === null ? null : Number(r.checkin_radius_m),
    latitude: r.latitude === null ? null : Number(r.latitude),
    longitude: r.longitude === null ? null : Number(r.longitude),
  }));

  // Only the types actually on today's round. A company with forty customer types should not
  // send thirty-nine price lists to a phone that will visit one kind of shop.
  const typeIds = [...new Set(stops.map((s) => s.type_id))];
  const prices = typeIds.length
    ? (
        await db.query(
          `SELECT p.type_id, p.item_id, p.rate, p.gst_pct, i.code AS item, i.name AS item_name,
                  coalesce(u.code,'') AS unit
             FROM price_list_items p
             JOIN items i ON i.id=p.item_id
             LEFT JOIN units u ON u.id=i.base_unit_id
            WHERE p.type_id = ANY($1::uuid[]) AND p.deleted_at IS NULL AND p.active
              AND p.from_date <= $2 AND (p.to_date IS NULL OR p.to_date >= $2)
            ORDER BY i.code`,
          [typeIds, workDate],
        )
      ).rows.map((r) => ({ ...r, rate: Number(r.rate), gst_pct: Number(r.gst_pct) }))
    : [];

  // What each shop owes is deliberately NOT worked out here. The outstanding is an aged figure
  // that `ageing()` produces from the invoices and the receipts, and writing a second version of
  // it in SQL — invoices minus receipts, say — would be a number that agrees with the web until
  // the day somebody changes how ageing works. The caller asks the real function, once per stop.

  // The day as the server already has it, so a phone that is opened a second time does not offer
  // to start a day that is already started.
  const day =
    (
      await db.query(
        `SELECT id, version, to_char(started_at,'HH24:MI') AS start_time,
              to_char(ended_at,'HH24:MI') AS end_time
         FROM attendance_days WHERE rep_id=$1 AND work_date=$2`,
        [repId, workDate],
      )
    ).rows[0] ?? null;

  const openVisits = (
    await db.query(
      `SELECT v.id, v.customer_id, v.version, v.client_ref,
              to_char(v.checked_in_at,'HH24:MI') AS checked_in_at
         FROM visits v
        WHERE v.rep_id=$1 AND v.visit_date=$2 AND v.checked_out_at IS NULL`,
      [repId, workDate],
    )
  ).rows;

  return {
    date: workDate,
    rep,
    work_types: workTypes,
    stops,
    prices,
    day,
    open_visits: openVisits,
  };
}

// A phone saying hello. Overwritten in place, because what matters is the last time it was heard
// from, not a history of every time it was.
export async function recordHeartbeat(
  db,
  tenantId,
  { id, repId, deviceRef, platform = '', appVersion = '', queued = 0, blocked = 0 },
) {
  const row = (
    await db.query(
      `INSERT INTO device_syncs(id,tenant_id,rep_id,device_ref,platform,app_version,queued,blocked)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant_id,rep_id,device_ref) DO UPDATE
         SET platform=EXCLUDED.platform, app_version=EXCLUDED.app_version,
             queued=EXCLUDED.queued, blocked=EXCLUDED.blocked,
             last_seen_at=now(), updated_at=now()
       RETURNING id, to_char(last_seen_at,'YYYY-MM-DD HH24:MI') AS last_seen_at`,
      [id, tenantId, repId, deviceRef, platform, appVersion, queued, blocked],
    )
  ).rows[0];
  return row;
}

// Every phone the company has heard from, newest first. This is the screen somebody opens when a
// rep says their day did not arrive: it answers whether the phone ever reached the server, and
// what it was still carrying when it did.
export async function devicesSeen(db, { limit = 100 } = {}) {
  return (
    await db.query(
      `SELECT d.id, d.device_ref, d.platform, d.app_version, d.queued, d.blocked,
              to_char(d.last_seen_at,'YYYY-MM-DD HH24:MI') AS last_seen_at,
              r.code AS rep, r.name AS rep_name
         FROM device_syncs d JOIN field_reps r ON r.id=d.rep_id
        ORDER BY d.last_seen_at DESC LIMIT $1`,
      [limit],
    )
  ).rows;
}
