// What the demand itself says, before any plan is made (Nilkamal simulation handover, 21-Sep-2026:
// the Demand History screen): the months of history the plant actually has, the shape of its year,
// the difference between an order book and demand, and which items carry the revenue and which
// ones move unpredictably. Read-only; every number comes from demand_history and the open book.

const n = (v) => (v === null || v === undefined ? null : Number(v));
const round1 = (x) => Math.round(x * 10) / 10;

// Units invoiced per calendar month, finished goods only: a component's demand is derived from its
// parents and would be counted twice here.
export async function demandInsight(db, siteId, today) {
  const months = (
    await db.query(
      `SELECT to_char(date_trunc('month',h.demand_date),'YYYY-MM') AS month,
         sum(h.quantity) AS units, count(DISTINCT h.item_id)::int AS items
       FROM demand_history h JOIN items i ON i.id=h.item_id
       WHERE h.site_id=$1 AND i.item_type='FG'
       GROUP BY 1 ORDER BY 1`,
      [siteId],
    )
  ).rows.map((r) => ({ month: r.month, units: Math.round(Number(r.units)), items: r.items }));
  const total = months.reduce((a, m) => a + m.units, 0);
  const average = months.length ? total / months.length : 0;
  const peak = months.reduce((a, m) => (a && a.units >= m.units ? a : m), null);
  // The shape of the year: every April against every other April, on the plant's own average.
  const byCalendarMonth = new Map();
  for (const m of months) {
    const key = Number(m.month.slice(5, 7));
    const seen = byCalendarMonth.get(key) ?? { month: key, units: 0, years: 0 };
    seen.units += m.units;
    seen.years++;
    byCalendarMonth.set(key, seen);
  }
  const seasonal = [...byCalendarMonth.values()]
    .map((s) => ({
      month: s.month,
      years: s.years,
      average: Math.round(s.units / s.years),
      index: average > 0 ? Math.round((s.units / s.years / average) * 100) / 100 : null,
    }))
    .sort((a, b) => a.month - b.month);
  // An order book is not demand: what is open now, against what was invoiced in a year.
  const book = (
    await db.query(
      `SELECT count(*)::int AS orders,coalesce(sum(o.quantity),0) AS units
       FROM production_orders o WHERE o.site_id=$1 AND o.status='OPEN'`,
      [siteId],
    )
  ).rows[0];
  const lastYear = months.slice(-12).reduce((a, m) => a + m.units, 0);
  return {
    months,
    peak,
    average: Math.round(average),
    total,
    seasonal,
    book: {
      orders: book.orders,
      units: Math.round(Number(book.units)),
      invoicedLastYear: lastYear,
      // How many days of the last year's rate the open book holds.
      daysOfDemand: lastYear > 0 ? round1((Number(book.units) / lastYear) * 365) : null,
    },
    today,
  };
}

// ABC by what an item is worth in a year, XYZ by how steadily it moves. Both are read from the
// plant's own history; an item with no cost is counted in units only and said to be uncosted.
export async function abcXyz(db, siteId, weeks = 52) {
  const rows = (
    await db.query(
      // The weeks are summed first: joining them row by row would count every day of demand once
      // per week of the window.
      `WITH window_end AS (SELECT max(demand_date) AS d FROM demand_history WHERE site_id=$1),
       weekly AS (
         SELECT h.item_id, date_trunc('week',h.demand_date) AS wk, sum(h.quantity) AS units
           FROM demand_history h, window_end
          WHERE h.site_id=$1 AND h.demand_date > window_end.d - ($2 * 7)
          GROUP BY 1,2
       )
       SELECT i.code,i.name,i.item_type,i.standard_cost,
         sum(w.units) AS units, sum(w.units * w.units) AS sum_squares,
         count(*)::int AS active_weeks
       FROM weekly w JOIN items i ON i.id=w.item_id
       GROUP BY i.code,i.name,i.item_type,i.standard_cost
       ORDER BY 5 DESC`,
      [siteId, weeks],
    )
  ).rows.map((r) => {
    // Variability over the whole window, counting the weeks with no demand at all: a part that
    // sells in three weeks of the year is not steady just because those three weeks look alike.
    const units = Number(r.units);
    const mean = units / weeks;
    const variance = Math.max(0, Number(r.sum_squares) / weeks - mean * mean);
    return {
      code: r.code,
      name: r.name,
      type: r.item_type,
      units: Math.round(units),
      value: n(r.standard_cost) === null ? null : Math.round(units * Number(r.standard_cost)),
      activeWeeks: r.active_weeks,
      variability: mean > 0 ? round1(Math.sqrt(variance) / mean) : null,
    };
  });
  // A on the first 80% of the value, B to 95%, C the rest; uncosted items rank by units.
  const ranked = rows.slice().sort((a, b) => (b.value ?? b.units) - (a.value ?? a.units));
  const totalValue = ranked.reduce((a, r) => a + (r.value ?? r.units), 0);
  let running = 0;
  for (const r of ranked) {
    running += r.value ?? r.units;
    const share = totalValue > 0 ? running / totalValue : 1;
    r.abc = share <= 0.8 ? 'A' : share <= 0.95 ? 'B' : 'C';
    // X moves steadily, Y moves, Z is lumpy: the same thresholds the buffer decision uses.
    r.xyz =
      r.variability === null ? 'Z' : r.variability <= 0.5 ? 'X' : r.variability <= 1 ? 'Y' : 'Z';
  }
  const grid = {};
  for (const a of ['A', 'B', 'C'])
    for (const x of ['X', 'Y', 'Z'])
      grid[a + x] = ranked.filter((r) => r.abc === a && r.xyz === x).length;
  return {
    weeks,
    items: ranked.length,
    uncosted: ranked.filter((r) => r.value === null).length,
    totalValue,
    grid,
    top: ranked.slice(0, 25),
  };
}
