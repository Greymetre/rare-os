// The footer under every table. A reader looking at 25 of 29,490 items needs to know that is what
// they are looking at: where they are, how far the list goes, and how much of it to show at once.
//
// Pages are reached by cursor, not by number — the list is read in order and each page hands over
// the key the next one starts from. So the pager keeps the cursors it has followed: their count is
// the page number, and going back a page is dropping the last one.
import { PAGE_SIZES } from '../../../packages/schema/paging.mjs';
import { useState } from 'react';

const count = (n: number) => n.toLocaleString('en-IN');

export type Paging = {
  cursors: string[];
  setCursors: (c: string[]) => void;
  size: number;
  setSize: (n: number) => void;
  cursor: string | undefined;
};

// Where a table is in its list. `cursor` is what the next request should carry; `size` goes with
// it, so a reader who asks for 100 rows keeps getting 100.
export function usePaging(initial = 25): Paging {
  const [cursors, setCursors] = useState<string[]>([]),
    [size, setSize] = useState(initial);
  return { cursors, setCursors, size, setSize, cursor: cursors[cursors.length - 1] };
}

export function Pager({
  page,
  next,
  total,
  shown,
  busy,
  noun = 'entries',
}: {
  page: Paging;
  next: string | null;
  total?: number;
  shown: number;
  busy?: boolean;
  noun?: string;
}) {
  const { cursors, setCursors, size, setSize } = page;
  const number = cursors.length + 1;
  // Only the last page can be short, so the total tells us how many pages there are. Without a
  // total — a list that cannot count itself — the page number stands on its own.
  const pages = total === undefined ? null : Math.max(1, Math.ceil(total / size));
  const first = cursors.length * size + 1;
  const last = cursors.length * size + shown;
  return (
    <div className="table-footer">
      <label className="page-size">
        Show
        <select
          value={size}
          disabled={busy}
          aria-label="Rows per page"
          onChange={(e) => {
            // A different size makes the cursors already followed meaningless: start again.
            setCursors([]);
            setSize(Number(e.target.value));
          }}
        >
          {PAGE_SIZES.map((n: number) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        {noun}
      </label>
      <p className="page-count" role="status">
        {shown === 0
          ? total
            ? `No ${noun} on this page`
            : `No ${noun}`
          : total === undefined
            ? `Showing ${count(first)}–${count(last)} · Page ${count(number)}`
            : `Showing ${count(first)}–${count(last)} of ${count(total)} ${noun} · Page ${count(number)} of ${count(pages!)}`}
      </p>
      <div className="page-buttons">
        <button
          className="button"
          disabled={!cursors.length || busy}
          onClick={() => setCursors([])}
        >
          First page
        </button>
        <button
          className="button"
          disabled={!cursors.length || busy}
          onClick={() => setCursors(cursors.slice(0, -1))}
        >
          Previous page
        </button>
        <button
          className="button"
          disabled={!next || busy}
          onClick={() => setCursors([...cursors, next!])}
        >
          Next page
        </button>
      </div>
    </div>
  );
}
