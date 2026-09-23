import { useEffect, useState } from 'react';
import { useApi } from './api-client';
import { Messages } from './plant-model';

// AV-10 screens (Nilkamal simulation handover, 21-Sep-2026): the planner's day (what to order, to
// release and to watch) and delivery (order-level OTIF, the time buffer of every promise, promises
// projected against the ones given, and the release schedule). Every list exports to CSV.

const num = (v: unknown, digits = 2) =>
  v === null || v === undefined || v === ''
    ? '—'
    : Number(v).toLocaleString('en-IN', { maximumFractionDigits: digits });
const SEVERITY: Record<string, [string, string]> = {
  critical: ['off', 'Critical'],
  high: ['off', 'High'],
  medium: ['pending', 'Medium'],
  low: ['ok', 'Low'],
};
const MATERIAL: Record<string, string> = {
  clear: 'Clear',
  replenish: 'Commit + replenish',
  expedite: 'Expedite or quote later',
  unknown: 'Cannot validate',
};
const BUFFER_ZONE: Record<string, [string, string]> = {
  green: ['ok', 'Protected'],
  yellow: ['pending', 'Watch'],
  red: ['off', 'Expedite zone'],
  penetrated: ['off', 'Penetrated'],
};

// What the numbers were calculated from, and whether the inputs have moved since.
function Calculation({ c }: { c: any }) {
  if (!c) return null;
  return (
    <p className="cell-sub">
      {c.runNo ? `Calculation #${c.runNo}` : 'No calculation yet'}
      {c.calculatedAt ? ` · ${new Date(c.calculatedAt).toLocaleString()}` : ''}
      {c.fixedDate ? ` · simulation date ${c.fixedDate}` : ''}
      {!c.upToDate && (
        <strong className="warning-text">
          {' '}
          · inputs changed{c.recalculating ? ': recalculating…' : ': recalculating shortly'}
        </strong>
      )}
    </p>
  );
}

function Exports({ plantId, kinds }: { plantId: string; kinds: [string, string][] }) {
  return (
    <div className="toolbar">
      {kinds.map(([kind, label]) => (
        <a key={kind} className="button" href={`/api/plants/${plantId}/delivery/${kind}.csv`}>
          Export {label} (CSV)
        </a>
      ))}
    </div>
  );
}

function useDelivery(csrf: string, plantId: string, refreshKey: number) {
  const call = useApi(csrf);
  const [data, setData] = useState<any>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    call(`plants/${plantId}/delivery`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [plantId, refreshKey]);
  return { data, error };
}

// Planning → Today: the planner's day and the exceptions behind it.
export function Today({
  csrf,
  plantId,
  refreshKey,
}: {
  csrf: string;
  plantId: string;
  refreshKey: number;
}) {
  const { data, error } = useDelivery(csrf, plantId, refreshKey);
  const day = data?.day;
  return (
    <>
      <Messages error={error} notice="" />
      {data?.empty && <p className="panel-body">{data.empty}</p>}
      {data && !data.empty && (
        <>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Today, {data.today}</h2>
                <Calculation c={data.calculation} />
              </div>
            </div>
            <div className="zone-tiles schedule-tiles">
              <div className="zone-tile">
                <strong>{day.order.length}</strong>
                <span>To order</span>
              </div>
              <div className="zone-tile">
                <strong>{day.make.length}</strong>
                <span>To release</span>
              </div>
              <div className={'zone-tile ' + (data.counts.critical ? 'red' : 'green')}>
                <strong>{data.counts.critical}</strong>
                <span>Critical alerts</span>
              </div>
              <div className={'zone-tile ' + (data.counts.penetrated ? 'red' : 'green')}>
                <strong>{data.counts.penetrated}</strong>
                <span>Promises penetrated</span>
              </div>
            </div>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Order today</h2>
                <p className="panel-sub">Bought items the board recommends; overdue dates first.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Quantity</th>
                    <th>Needed by</th>
                    <th>Zone</th>
                  </tr>
                </thead>
                <tbody>
                  {day.order.map((r: any) => (
                    <tr key={r.item} data-order-today={r.item} className={r.overdue ? 'late' : ''}>
                      <td>
                        <strong>{r.item}</strong>
                      </td>
                      <td className="num">
                        {num(r.qty)} {r.unit}
                      </td>
                      <td>{r.due ?? '—'}</td>
                      <td>{r.zone}</td>
                    </tr>
                  ))}
                  {day.order.length === 0 && (
                    <tr>
                      <td colSpan={4}>Nothing to order today.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Release today</h2>
                <p className="panel-sub">
                  Work whose release date has arrived. A hold means its materials are not ready.
                </p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Item</th>
                    <th className="num">Quantity</th>
                    <th>Release by</th>
                    <th>Promise</th>
                    <th>Materials</th>
                  </tr>
                </thead>
                <tbody>
                  {day.make.map((r: any) => (
                    <tr key={r.order} data-release-today={r.order} className={r.hold ? 'late' : ''}>
                      <td>
                        <strong>{r.order}</strong>
                      </td>
                      <td>{r.item}</td>
                      <td className="num">{num(r.qty)}</td>
                      <td>{r.releaseDate}</td>
                      <td>{r.promise}</td>
                      <td>
                        {r.hold ? (
                          <span className="status-pill off">
                            Hold: {MATERIAL[r.material] ?? r.material}
                          </span>
                        ) : (
                          <span className="status-pill ok">Release on date</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {day.make.length === 0 && (
                    <tr>
                      <td colSpan={6}>Nothing to release today.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Alerts</h2>
                <p className="panel-sub">
                  {data.counts.alerts} exception(s) from this calculation: stock, promises,
                  materials, suppliers, customers and machines.
                </p>
              </div>
            </div>
            <Exports
              plantId={plantId}
              kinds={[
                ['alerts', 'alerts'],
                ['day-list', "today's list"],
              ]}
            />
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Subject</th>
                    <th>What</th>
                  </tr>
                </thead>
                <tbody>
                  {data.alerts.slice(0, 100).map((a: any, i: number) => {
                    const s = SEVERITY[a.severity] ?? ['pending', a.severity];
                    return (
                      <tr key={i} data-alert={a.kind + ':' + a.subject}>
                        <td>
                          <span className={'status-pill ' + s[0]}>{s[1]}</span>
                        </td>
                        <td>
                          <strong>{a.subject}</strong>
                          {a.item && <div className="cell-sub">{a.item}</div>}
                        </td>
                        <td>{a.message}</td>
                      </tr>
                    );
                  })}
                  {data.alerts.length === 0 && (
                    <tr>
                      <td colSpan={3}>
                        No exceptions: every buffer and promise is inside its plan.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}

// Planning → Delivery: OTIF, the time buffer of every promise and the release schedule.
export function Delivery({
  csrf,
  plantId,
  refreshKey,
}: {
  csrf: string;
  plantId: string;
  refreshKey: number;
}) {
  const { data, error } = useDelivery(csrf, plantId, refreshKey);
  const [late, setLate] = useState(false);
  const orders = (data?.orders ?? []).filter((o: any) => !late || o.lateDays > 0);
  return (
    <>
      <Messages error={error} notice="" />
      {data?.empty && <p className="panel-body">{data.empty}</p>}
      {data && !data.empty && (
        <>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Order-level OTIF</h2>
                <p className="panel-sub">
                  An order is on time when every one of its lots is finished by the promise: one
                  late lot makes the whole order late, which is what the customer feels.
                </p>
                <Calculation c={data.calculation} />
              </div>
            </div>
            <div className="zone-tiles schedule-tiles">
              <div className={'zone-tile ' + ((data.otif.orderPct ?? 0) >= 85 ? 'green' : 'red')}>
                <strong>{data.otif.orderPct === null ? '—' : data.otif.orderPct + '%'}</strong>
                <span>OTIF by order</span>
                <span className="cell-sub">
                  {data.otif.onTime} of {data.otif.total} orders on time
                </span>
              </div>
              <div className="zone-tile">
                <strong>{data.otif.lotPct === null ? '—' : data.otif.lotPct + '%'}</strong>
                <span>By production lot</span>
                <span className="cell-sub">
                  {data.otif.lotsOnTime} of {data.otif.lots} lots — the flattering number
                </span>
              </div>
              <div className={'zone-tile ' + (data.counts.gated ? 'red' : 'green')}>
                <strong>{data.counts.gated}</strong>
                <span>Orders gated by material</span>
              </div>
              <div className="zone-tile">
                <strong>{data.otif.unscheduled}</strong>
                <span>Not schedulable</span>
              </div>
            </div>
            <Exports
              plantId={plantId}
              kinds={[
                ['otif', 'OTIF'],
                ['time-buffer', 'time buffer'],
                ['release-schedule', 'release schedule'],
              ]}
            />
          </section>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Promises: given against projected</h2>
                <p className="panel-sub">
                  The time buffer is the runway a promise has; what is left of it is its slack.
                </p>
              </div>
              <label className="toolbar">
                <input type="checkbox" checked={late} onChange={(e) => setLate(e.target.checked)} />
                Late only
              </label>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Order</th>
                    <th>Item</th>
                    <th className="num">Quantity</th>
                    <th>Release by</th>
                    <th>Promised</th>
                    <th>Projected</th>
                    <th className="num">Buffer used</th>
                    <th>Protection</th>
                    <th>Materials</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o: any) => {
                    const z = o.buffer
                      ? (BUFFER_ZONE[o.buffer.zone] ?? ['pending', o.buffer.zone])
                      : null;
                    return (
                      <tr
                        key={o.order}
                        data-promise={o.order}
                        className={o.lateDays > 0 ? 'late' : ''}
                      >
                        <td className="num">{o.position}</td>
                        <td>
                          <strong>{o.order}</strong>
                          {o.lots > 1 && <div className="cell-sub">{o.lots} lots</div>}
                          {o.state !== 'planned' && <div className="cell-sub">{o.state}</div>}
                        </td>
                        <td>
                          {o.item}
                          <div className="cell-sub">{o.itemName}</div>
                        </td>
                        <td className="num">
                          {num(o.qty)} {o.unit}
                        </td>
                        <td>{o.releaseDate ?? '—'}</td>
                        <td>{o.promise}</td>
                        <td>
                          {o.finishDate ?? '—'}
                          {o.lateDays > 0 && (
                            <div className="cell-sub warning-text">{o.lateDays} day(s) late</div>
                          )}
                        </td>
                        <td className="num">{o.buffer ? o.buffer.consumed + '%' : '—'}</td>
                        <td>{z ? <span className={'status-pill ' + z[0]}>{z[1]}</span> : '—'}</td>
                        <td>{MATERIAL[o.material] ?? '—'}</td>
                      </tr>
                    );
                  })}
                  {orders.length === 0 && (
                    <tr>
                      <td colSpan={10}>Nothing to show.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}
