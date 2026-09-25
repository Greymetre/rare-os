import { useEffect, useState } from 'react';
import { useApi } from './api-client';
import { Messages } from './plant-model';

// AV-11 screens (Nilkamal simulation handover, 21-Sep-2026): the questions asked before the plan is
// fixed — the month's shape, the buffer set a service level would need, which items deserve a buffer,
// events and schemes that the history has not seen, a sales target priced in stock and capacity, a
// space limit, the network of plants and the assumptions the plan rests on.

const num = (v: unknown, digits = 0) =>
  v === null || v === undefined || v === ''
    ? '—'
    : Number(v).toLocaleString('en-IN', { maximumFractionDigits: digits });
const TOOLS: [string, string][] = [
  ['month', 'Month shape'],
  ['recommended', 'Recommended buffers'],
  ['mto', 'Buffer vs MTO'],
  ['events', 'Events & seasons'],
  ['schemes', 'Scheme intake'],
  ['target', 'Target mode'],
  ['space', 'Space mode'],
  ['assumptions', 'Assumptions'],
];

// A bar chart drawn from the numbers themselves, so it reads the same in a screenshot.
function Bars({ rows, capacity }: { rows: any[]; capacity?: number | null }) {
  const max = Math.max(...rows.map((r) => r.value), capacity ?? 0, 1);
  return (
    <div className="bars" role="img" aria-label="Demand by day of the month against capacity">
      {rows.map((r, i) => (
        <span key={i} className="bar" title={`${r.title}`}>
          <i
            className={'bar-fill' + (r.over ? ' over' : '')}
            style={{ height: Math.round((r.value / max) * 100) + '%' }}
          />
          <em>{r.label}</em>
        </span>
      ))}
      {capacity ? (
        <span className="bar-line" style={{ bottom: Math.round((capacity / max) * 100) + '%' }}>
          capacity {num(capacity)}
        </span>
      ) : null}
    </div>
  );
}

export function PlanningTools({
  csrf,
  plantId,
  permissions,
  refreshKey,
  // Each tool is its own menu entry, so the screen usually opens on one and hides the selector.
  only,
}: {
  csrf: string;
  plantId: string;
  permissions: string[];
  refreshKey: number;
  only?: string;
}) {
  const call = useApi(csrf);
  const canEdit = permissions.includes('planning.tools');
  const [tool, setTool] = useState(only ?? 'month'),
    // The payload is kept with the tool it belongs to: a tool switch renders once before the effect
    // clears the old one, and every screen would then read the previous tool's shape.
    [loaded, setLoaded] = useState<{ tool: string; data: any }>({ tool: '', data: null }),
    [service, setService] = useState('0.9'),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [tick, setTick] = useState(0),
    [form, setForm] = useState<any>({}),
    [target, setTarget] = useState<any>({ family: '', from: '', to: '', units: '' });
  const path =
    tool === 'month'
      ? 'tools/month-shape'
      : tool === 'recommended'
        ? `tools/recommended-buffers?service=${service}`
        : tool === 'mto'
          ? 'tools/buffer-vs-mto'
          : tool === 'events'
            ? 'tools/events'
            : tool === 'schemes'
              ? 'tools/schemes'
              : tool === 'space'
                ? `tools/space?service=${service}`
                : tool === 'assumptions'
                  ? 'tools/assumptions'
                  : null;
  useEffect(() => {
    if (only && tool !== only) setTool(only);
  }, [only]);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setLoaded({ tool, data: null });
    setError('');
    call(`plants/${plantId}/${path}`)
      .then((d) => live && setLoaded({ tool, data: d }))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [plantId, refreshKey, tick, path, tool]);
  const data = loaded.tool === tool ? loaded.data : null;
  const setData = (d: any) => setLoaded({ tool, data: d });
  const save = (p: string, payload: any, method = 'POST') => {
    setBusy(true);
    setError('');
    call(`plants/${plantId}/${p}`, method, payload)
      .then((d) => {
        setNotice(d.message);
        setTick((x) => x + 1);
        setForm({});
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const f = (k: string, d = '') => form[k] ?? d;
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });
  return (
    <>
      <Messages error={error} notice={notice} />
      {(!only || tool === 'recommended' || tool === 'space') && (
        <section className="panel">
          <div className="toolbar view-switch">
            {!only && (
              <label>
                Tool
                <select value={tool} onChange={(e) => setTool(e.target.value)}>
                  {TOOLS.map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {(tool === 'recommended' || tool === 'space') && (
              <label>
                Service level
                <select value={service} onChange={(e) => setService(e.target.value)}>
                  <option value="0.85">85%</option>
                  <option value="0.9">90%</option>
                  <option value="0.95">95%</option>
                  <option value="0.98">98%</option>
                </select>
              </label>
            )}
          </div>
        </section>
      )}
      {data?.empty && <p className="panel-body">{data.empty}</p>}

      {tool === 'month' && data && !data.empty && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>The month's shape against {data.drum.code}</h2>
              <p className="panel-sub">
                The despatch profile spread over {data.workdays} working days at{' '}
                {num(data.drum.capacityPerDay)} minutes a day on the constraint. Red is work the day
                cannot take; level production is the same work every day, and the stock it carries.
              </p>
            </div>
          </div>
          <div className="zone-tiles schedule-tiles">
            <div className={'zone-tile ' + (data.shape.over ? 'red' : 'green')}>
              <strong>{num(data.shape.over)}</strong>
              <span>Minutes the month cannot make</span>
            </div>
            <div className="zone-tile">
              <strong>{num(data.shape.prebuildable)}</strong>
              <span>Minutes the quiet days could take</span>
            </div>
            <div className="zone-tile">
              <strong>{data.shape.lastThird}%</strong>
              <span>Despatched in the last third</span>
            </div>
            <div className="zone-tile">
              <strong>{num(data.level?.peakUnits)}</strong>
              <span>Stock at the level-production peak</span>
              <span className="cell-sub">
                day {data.level?.peakDay} · {data.level?.daysOfDemand} days of demand
              </span>
            </div>
          </div>
          <div className="panel-body">
            <Bars
              rows={data.shape.days.map((d: any) => ({
                label: d.day % 5 === 0 ? String(d.day) : '',
                value: d.required,
                over: d.over > 0,
                title: `day ${d.day}: ${d.pct}% of the month, ${num(d.required)} min against ${num(data.shape.capacityPerDay)}`,
              }))}
              capacity={data.shape.capacityPerDay}
            />
          </div>
        </section>
      )}

      {tool === 'recommended' && data && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Recommended buffers at {Math.round(data.service * 100)}% service</h2>
              <p className="panel-sub">
                Zones sized from this plant's own demand: yellow covers the lead time, red is the
                safety that service level asks for, green is the cycle. Demand read to {data.asOf}.
              </p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <caption>What each service level would hold</caption>
              <thead>
                <tr>
                  <th>Service</th>
                  <th className="num">Average stock</th>
                  <th className="num">Top of green</th>
                  <th className="num">Stock value</th>
                  <th className="num">Fill</th>
                </tr>
              </thead>
              <tbody>
                {data.curve.map((c: any) => (
                  <tr key={c.service} className={c.service === data.service ? 'late' : ''}>
                    <td>{Math.round(c.service * 100)}%</td>
                    <td className="num">{num(c.averageStock)}</td>
                    <td className="num">{num(c.topOfGreen)}</td>
                    <td className="num">{num(c.stockValue)}</td>
                    <td className="num">{c.fillPct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">ADU</th>
                  <th className="num">Variability</th>
                  <th className="num">Lead time</th>
                  <th className="num">Red top</th>
                  <th className="num">Yellow top</th>
                  <th className="num">Top of green</th>
                  <th className="num">Fill</th>
                  <th>Today</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.slice(0, 100).map((r: any) => (
                  <tr key={r.code} data-recommended={r.code}>
                    <td>
                      <strong>{r.code}</strong>
                      <div className="cell-sub">{r.name}</div>
                    </td>
                    <td className="num">{num(r.adu, 2)}</td>
                    <td className="num">{num(r.variability, 2)}</td>
                    <td className="num">{r.leadTimeDays}</td>
                    <td className="num">{num(r.topOfRed)}</td>
                    <td className="num">{num(r.topOfYellow)}</td>
                    <td className="num">{num(r.topOfGreen)}</td>
                    <td className="num">{r.fillPct}%</td>
                    <td>{r.policy ?? 'not buffered'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tool === 'mto' && data && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Buffer or made to order</h2>
              <p className="panel-sub">
                Items ordered often and steadily earn a buffer; rare or uneven ones cost less made
                to order. {data.counts.changes} of {data.counts.items} items disagree with today's
                setting.
              </p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Weeks ordered a year</th>
                  <th className="num">Weekly demand</th>
                  <th className="num">Variability</th>
                  <th>Today</th>
                  <th>Recommended</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.slice(0, 100).map((r: any) => (
                  <tr key={r.code} data-mto={r.code} className={r.change ? 'late' : ''}>
                    <td>
                      <strong>{r.code}</strong>
                    </td>
                    <td className="num">{r.ordersPerYear}</td>
                    <td className="num">{num(r.weeklyDemand, 1)}</td>
                    <td className="num">{num(r.variability, 2)}</td>
                    <td>{r.policy ?? 'not buffered'}</td>
                    <td>
                      <span
                        className={'status-pill ' + (r.recommend === 'BUFFER' ? 'ok' : 'pending')}
                      >
                        {r.recommend}
                      </span>
                    </td>
                    <td className="cell-sub">{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tool === 'events' && data && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Events and seasons</h2>
              <p className="panel-sub">
                Demand the history has not seen yet. Inside the window an item's zones are sized for
                the higher rate, and they rise its lead time earlier so the stock is there in time.
              </p>
            </div>
          </div>
          {canEdit && (
            <form
              className="form-grid panel-body"
              onSubmit={(e) => {
                e.preventDefault();
                save('tools/events', {
                  code: f('code'),
                  name: f('name'),
                  kind: f('kind', 'EVENT'),
                  from: f('from'),
                  to: f('to'),
                  uplift: Number(f('uplift')),
                  items: f('items')
                    .split(/[\s,]+/)
                    .filter(Boolean),
                  family: f('family'),
                  note: f('note'),
                });
              }}
            >
              <label>
                Code
                <input value={f('code')} onChange={set('code')} required />
              </label>
              <label>
                Name
                <input value={f('name')} onChange={set('name')} required />
              </label>
              <label>
                Kind
                <select value={f('kind', 'EVENT')} onChange={set('kind')}>
                  <option value="EVENT">Event</option>
                  <option value="SEASON">Season</option>
                </select>
              </label>
              <label>
                From
                <input type="date" value={f('from')} onChange={set('from')} required />
              </label>
              <label>
                To
                <input type="date" value={f('to')} onChange={set('to')} required />
              </label>
              <label>
                Uplift %
                <input inputMode="decimal" value={f('uplift')} onChange={set('uplift')} required />
              </label>
              <label>
                Items (blank = the whole plant)
                <input value={f('items')} onChange={set('items')} placeholder="CODE1, CODE2" />
              </label>
              <label>
                Or family
                <input value={f('family')} onChange={set('family')} />
              </label>
              <div className="form-actions">
                <button className="button primary" disabled={busy}>
                  Save event
                </button>
              </div>
            </form>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Window</th>
                  <th className="num">Uplift</th>
                  <th>Applies to</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((e: any) => (
                  <tr key={e.id} data-event={e.code}>
                    <td>
                      <strong>{e.code}</strong>
                      <div className="cell-sub">{e.kind}</div>
                    </td>
                    <td>{e.name}</td>
                    <td>
                      {e.from_date} → {e.to_date}
                    </td>
                    <td className="num">
                      {e.uplift_pct > 0 ? '+' : ''}
                      {e.uplift_pct}%
                    </td>
                    <td>{e.items.length ? e.items.join(', ') : e.family || 'every item'}</td>
                    <td>
                      <span className={'status-pill ' + (e.active ? 'ok' : 'pending')}>
                        {e.active ? 'Active' : 'Off'}
                      </span>
                    </td>
                  </tr>
                ))}
                {data.items.length === 0 && (
                  <tr>
                    <td colSpan={6}>No events or seasons yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tool === 'schemes' && data && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Scheme intake</h2>
              <p className="panel-sub">
                A scheme's expected volume is visible while it is proposed, and becomes demand the
                moment it is accepted.
              </p>
            </div>
          </div>
          {canEdit && (
            <form
              className="form-grid panel-body"
              onSubmit={(e) => {
                e.preventDefault();
                save('tools/schemes', {
                  code: f('code'),
                  name: f('name'),
                  item: f('item'),
                  from: f('from'),
                  to: f('to'),
                  units: Number(f('units')),
                  note: f('note'),
                });
              }}
            >
              <label>
                Code
                <input value={f('code')} onChange={set('code')} required />
              </label>
              <label>
                Name
                <input value={f('name')} onChange={set('name')} required />
              </label>
              <label>
                Item
                <input value={f('item')} onChange={set('item')} required />
              </label>
              <label>
                From
                <input type="date" value={f('from')} onChange={set('from')} required />
              </label>
              <label>
                To
                <input type="date" value={f('to')} onChange={set('to')} required />
              </label>
              <label>
                Expected units
                <input inputMode="decimal" value={f('units')} onChange={set('units')} required />
              </label>
              <div className="form-actions">
                <button className="button primary" disabled={busy}>
                  Record scheme
                </button>
              </div>
            </form>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Item</th>
                  <th>Window</th>
                  <th className="num">Expected units</th>
                  <th>State</th>
                  {canEdit && <th className="actions">Decision</th>}
                </tr>
              </thead>
              <tbody>
                {data.items.map((s: any) => (
                  <tr key={s.id} data-scheme={s.code}>
                    <td>
                      <strong>{s.code}</strong>
                      <div className="cell-sub">{s.name}</div>
                    </td>
                    <td>{s.item}</td>
                    <td>
                      {s.from_date} → {s.to_date}
                    </td>
                    <td className="num">{num(s.expected_units)}</td>
                    <td>
                      <span
                        className={
                          'status-pill ' +
                          (s.state === 'accepted'
                            ? 'ok'
                            : s.state === 'declined'
                              ? 'off'
                              : 'pending')
                        }
                      >
                        {s.state}
                      </span>
                      {s.decided_by && <div className="cell-sub">{s.decided_by}</div>}
                    </td>
                    {canEdit && (
                      <td className="actions">
                        {s.state === 'proposed' && (
                          <>
                            <button
                              className="button"
                              disabled={busy}
                              onClick={() =>
                                save(`tools/schemes/${s.id}/accept`, { version: s.version })
                              }
                            >
                              Accept
                            </button>
                            <button
                              className="text-button"
                              disabled={busy}
                              onClick={() =>
                                save(`tools/schemes/${s.id}/decline`, { version: s.version })
                              }
                            >
                              Decline
                            </button>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
                {data.items.length === 0 && (
                  <tr>
                    <td colSpan={canEdit ? 6 : 5}>No schemes yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tool === 'target' && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Target mode</h2>
              <p className="panel-sub">
                A sales target is neither accepted nor refused here: it is priced. Enter the period
                and the units, and the screen shows the buffers it needs, the stock that costs and
                what the constraint would have to do.
              </p>
            </div>
          </div>
          <form
            className="form-grid panel-body"
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              call(`plants/${plantId}/tools/target`, 'POST', {
                family: target.family,
                from: target.from,
                to: target.to,
                units: Number(target.units),
              })
                .then((d) => setData({ target: d }))
                .catch((err) => setError(err.message))
                .finally(() => setBusy(false));
            }}
          >
            <label>
              Family (blank = the whole plant)
              <input
                value={target.family}
                onChange={(e) => setTarget({ ...target, family: e.target.value })}
              />
            </label>
            <label>
              From
              <input
                type="date"
                value={target.from}
                onChange={(e) => setTarget({ ...target, from: e.target.value })}
                required
              />
            </label>
            <label>
              To
              <input
                type="date"
                value={target.to}
                onChange={(e) => setTarget({ ...target, to: e.target.value })}
                required
              />
            </label>
            <label>
              Target units
              <input
                inputMode="decimal"
                value={target.units}
                onChange={(e) => setTarget({ ...target, units: e.target.value })}
                required
              />
            </label>
            <div className="form-actions">
              <button className="button primary" disabled={busy}>
                Price the target
              </button>
            </div>
          </form>
          {data?.target && (
            <>
              <div className="zone-tiles schedule-tiles">
                <div className="zone-tile">
                  <strong>{num(data.target.historyUnits)}</strong>
                  <span>History in the same period</span>
                  <span className="cell-sub">
                    {data.target.days} days to {data.target.asOf}
                  </span>
                </div>
                <div className={'zone-tile ' + (data.target.ratio > 1 ? 'red' : 'green')}>
                  <strong>×{num(data.target.ratio, 2)}</strong>
                  <span>Target against history</span>
                </div>
                <div className="zone-tile">
                  <strong>{num(data.target.deltaStock)}</strong>
                  <span>Extra stock the buffers need</span>
                  <span className="cell-sub">{num(data.target.deltaValue)} at standard cost</span>
                </div>
                <div
                  className={
                    'zone-tile ' + ((data.target.utilisationPct ?? 0) > 100 ? 'red' : 'green')
                  }
                >
                  <strong>
                    {data.target.utilisationPct === null ? '—' : data.target.utilisationPct + '%'}
                  </strong>
                  <span>Constraint under the target</span>
                  <span className="cell-sub">
                    {data.target.drum?.code}
                    {data.target.addedMinutesPerDay
                      ? ` · +${num(data.target.addedMinutesPerDay)} min a day`
                      : ''}
                  </span>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="num">Top of green today</th>
                      <th className="num">Under the target</th>
                      <th className="num">Delta</th>
                      <th className="num">Extra stock value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.target.rows.slice(0, 60).map((r: any) => (
                      <tr key={r.code} data-target={r.code}>
                        <td>
                          <strong>{r.code}</strong>
                        </td>
                        <td className="num">{num(r.base.topOfGreen)}</td>
                        <td className="num">{num(r.target.topOfGreen)}</td>
                        <td className="num">
                          {r.deltaTopOfGreen > 0 ? '+' : ''}
                          {num(r.deltaTopOfGreen)}
                        </td>
                        <td className="num">{num(r.deltaValue)}</td>
                      </tr>
                    ))}
                    {data.target.rows.length === 0 && (
                      <tr>
                        <td colSpan={5}>The target is inside what the buffers already hold.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}

      {tool === 'space' && data && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Space mode</h2>
              <p className="panel-sub">
                When the store cannot hold the whole buffer set, green is trimmed first — red and
                yellow protect service, so they are trimmed last.
              </p>
            </div>
          </div>
          {canEdit && (
            <form
              className="form-grid panel-body"
              onSubmit={(e) => {
                e.preventDefault();
                save(
                  'tools/space',
                  { capacity: Number(f('capacity')), measure: 'UNITS', note: f('note') },
                  'PUT',
                );
              }}
            >
              <label>
                Space the plant has (units)
                <input
                  inputMode="decimal"
                  value={f('capacity', data.limit ? String(data.limit.capacity) : '')}
                  onChange={set('capacity')}
                  required
                />
              </label>
              <label>
                Note
                <input value={f('note', data.limit?.note ?? '')} onChange={set('note')} />
              </label>
              <div className="form-actions">
                <button className="button primary" disabled={busy}>
                  Save the limit
                </button>
              </div>
            </form>
          )}
          {data.fit && (
            <>
              <div className="zone-tiles schedule-tiles">
                <div className={'zone-tile ' + (data.fit.fits ? 'green' : 'red')}>
                  <strong>{data.fit.fits ? 'Fits' : 'Over'}</strong>
                  <span>The set against the space</span>
                </div>
                <div className="zone-tile">
                  <strong>{num(data.fit.need)}</strong>
                  <span>Top of green, whole set</span>
                </div>
                <div className="zone-tile">
                  <strong>{num(data.fit.capacity)}</strong>
                  <span>Space available</span>
                </div>
                <div className="zone-tile">
                  <strong>{data.fit.fits ? num(data.fit.spare) : num(data.fit.trimmed)}</strong>
                  <span>{data.fit.fits ? 'Spare' : 'Trimmed from green'}</span>
                  {!data.fit.fits && (
                    <span className="cell-sub">{data.fit.greenKept}% of green kept</span>
                  )}
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="num">Yellow top</th>
                      <th className="num">Top of green</th>
                      <th className="num">Fitted</th>
                      <th className="num">Trimmed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.fit.rows.slice(0, 60).map((r: any) => (
                      <tr key={r.code} data-space={r.code}>
                        <td>
                          <strong>{r.code}</strong>
                        </td>
                        <td className="num">{num(r.topOfYellow)}</td>
                        <td className="num">{num(r.topOfGreen)}</td>
                        <td className="num">{num(r.fitted)}</td>
                        <td className="num">{num(r.trimmed)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {!data.fit && (
            <p className="panel-body">Set the space this plant has to fit the set to it.</p>
          )}
        </section>
      )}

      {tool === 'assumptions' && data && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Assumption register</h2>
              <p className="panel-sub">
                Every number the plan rests on that nobody measured: what it is, where it is set,
                and whether the client has confirmed it.
              </p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Assumption</th>
                  <th>In force</th>
                  <th>Set in</th>
                  <th>Note</th>
                  <th>Confirmed</th>
                  {canEdit && <th className="actions">Action</th>}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r: any) => (
                  <tr key={r.code} data-assumption={r.code}>
                    <td>
                      <strong>{r.what}</strong>
                      <div className="cell-sub">{r.code}</div>
                    </td>
                    <td>{r.value}</td>
                    <td className="cell-sub">{r.where}</td>
                    <td>
                      {canEdit ? (
                        <input
                          value={f('note:' + r.code, r.note)}
                          onChange={set('note:' + r.code)}
                          placeholder="what the client said"
                        />
                      ) : (
                        r.note || '—'
                      )}
                    </td>
                    <td>
                      <span className={'status-pill ' + (r.confirmed ? 'ok' : 'pending')}>
                        {r.confirmed ? 'Confirmed' : 'Open'}
                      </span>
                    </td>
                    {canEdit && (
                      <td className="actions">
                        <button
                          className="button"
                          disabled={busy}
                          onClick={() =>
                            save(
                              'tools/assumptions',
                              {
                                code: r.code,
                                note: f('note:' + r.code, r.note),
                                confirmed: !r.confirmed,
                              },
                              'PUT',
                            )
                          }
                        >
                          {r.confirmed ? 'Reopen' : 'Confirm'}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

// Planning → Network: every plant, its constraint and how safely that resource is the constraint.
export function Network({
  csrf,
  plantId,
  refreshKey,
}: {
  csrf: string;
  plantId: string;
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const [data, setData] = useState<any>(null),
    [whatIf, setWhatIf] = useState<any>(null),
    [form, setForm] = useState({ resource: '', machines: '' }),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    call('network')
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [refreshKey]);
  const plant = (data?.plants ?? []).find((p: any) => p.id === plantId) ?? null;
  return (
    <>
      <Messages error={error} notice="" />
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Plants and their constraints</h2>
            <p className="panel-sub">
              The constraint is derived from each plant's own calculation. A small gap to the next
              resource means it does not take much to move it somewhere else.
            </p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Plant</th>
                <th className="num">Open orders</th>
                <th>Constraint</th>
                <th className="num">Utilisation</th>
                <th>Next resource</th>
                <th>Stability</th>
              </tr>
            </thead>
            <tbody>
              {(data?.plants ?? []).map((p: any) => (
                <tr key={p.id} data-plant={p.code}>
                  <td>
                    <strong>{p.code}</strong>
                    <div className="cell-sub">{p.name}</div>
                  </td>
                  <td className="num">{p.open_orders}</td>
                  <td>
                    {p.drum ? `${p.drum.code} ${p.drum.name}` : '—'}
                    {p.drum && <div className="cell-sub">{p.drum.machines} machine(s)</div>}
                  </td>
                  <td className="num">{p.drum ? p.drum.utilisationPct + '%' : '—'}</td>
                  <td>
                    {p.stability.next ? `${p.stability.next.code} ${p.stability.next.name}` : '—'}
                  </td>
                  <td>
                    <span className={'status-pill ' + (p.stability.stable ? 'ok' : 'pending')}>
                      {p.stability.gapPct === null
                        ? '—'
                        : p.stability.stable
                          ? `Stable (${p.stability.gapPct} pp clear)`
                          : `Close (${p.stability.gapPct} pp)`}
                    </span>
                  </td>
                </tr>
              ))}
              {data && data.plants.length === 0 && (
                <tr>
                  <td colSpan={6}>No calculated plant yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      {plant && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Machines and what-if: {plant.code}</h2>
              <p className="panel-sub">
                Change a machine count here to see whether the constraint moves. Nothing is saved.
              </p>
            </div>
          </div>
          <form
            className="form-grid panel-body"
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              call(`plants/${plantId}/tools/what-if`, 'POST', {
                resource: form.resource,
                machines: Number(form.machines),
              })
                .then((d) => setWhatIf(d))
                .catch((err) => setError(err.message))
                .finally(() => setBusy(false));
            }}
          >
            <label>
              Resource
              <select
                value={form.resource}
                onChange={(e) => setForm({ ...form, resource: e.target.value })}
                required
              >
                <option value="">Choose…</option>
                {plant.resources.map((r: any) => (
                  <option key={r.resourceId} value={r.code}>
                    {r.code} {r.name} ({r.machines} machines)
                  </option>
                ))}
              </select>
            </label>
            <label>
              Machines
              <input
                inputMode="numeric"
                value={form.machines}
                onChange={(e) => setForm({ ...form, machines: e.target.value })}
                required
              />
            </label>
            <div className="form-actions">
              <button className="button primary" disabled={busy}>
                Try it
              </button>
            </div>
          </form>
          {whatIf && (
            <div className="panel-body" data-what-if={whatIf.resource}>
              <p>
                <strong>
                  {whatIf.resource}: {whatIf.from} → {whatIf.to} machine(s)
                </strong>
              </p>
              <p>
                Constraint before: {whatIf.before?.code} at{' '}
                {Math.round((whatIf.before?.utilisation ?? 0) * 100)}%. After: {whatIf.after?.code}{' '}
                at {Math.round((whatIf.after?.utilisation ?? 0) * 100)}%.{' '}
                {whatIf.moved ? 'The constraint moves.' : 'The constraint stays where it is.'}
              </p>
            </div>
          )}
        </section>
      )}
    </>
  );
}
