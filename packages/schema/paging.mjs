// A page of a list has to say more than "here are 25 rows": how many rows there are altogether,
// which page this is, and how many pages there are. Only the total needs the database — the rest
// the reader's screen works out from it.
//
// The count runs over exactly the rows the list draws from, but never the cursor condition: the
// cursor says where this page starts, it is not part of what the reader is looking at.
export async function countRows(db, from, where, params) {
  const r = await db.query(`SELECT count(*)::int AS total FROM ${from} WHERE ${where}`, params);
  return r.rows[0].total;
}

// The page sizes a reader can choose. Anything else is refused rather than quietly rounded, so a
// link that asks for 10,000 rows cannot be used to pull a whole table in one request.
export const PAGE_SIZES = [10, 25, 50, 100];
export const DEFAULT_PAGE_SIZE = 25;
export function pageSize(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_PAGE_SIZE;
  const size = Number(value);
  return PAGE_SIZES.includes(size) ? size : null;
}
