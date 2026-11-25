// RCH-8: what the rep actually looks at.
//
// Three things shape every screen here, and none of them are about looks.
//
// **Nothing on this app waits for the network to show a result.** A rep taps "Check in" and the
// check-in is done — written to the phone, shown as done, and queued. If it takes six hours to
// reach the server that is the queue's business, not the rep's. An app that spins while the
// signal is bad teaches a salesman to stop using it.
//
// **The queue is never hidden.** A number at the top of every screen says how much is still on
// the phone, and tapping it explains. A rep who goes home believing the day is in, when it is
// not, is the failure this whole milestone exists to prevent.
//
// **Everything is reachable with a thumb, in sunlight, one-handed.** Hence the large targets,
// the single column, and the deliberate lack of anything clever.

import { useEffect, useRef, useState } from 'react';
import { queueSummary } from '../../../packages/engines/sync-queue.mjs';
import type { Queued } from './store';

export const money = (v: unknown) =>
  v === null || v === undefined || v === ''
    ? '—'
    : Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------------------------------------------------------------------------
// The bar that is always there
// ---------------------------------------------------------------------------

export function QueueBar({
  items,
  online,
  busy,
  onSend,
  onOpen,
}: {
  items: Queued[];
  online: boolean;
  busy: boolean;
  onSend: () => void;
  onOpen: () => void;
}) {
  const view = queueSummary(items);
  const tone = view.blocked ? 'bad' : view.queued ? 'wait' : 'good';
  return (
    <div className={'queuebar ' + tone} role="status" aria-live="polite">
      <button className="queuebar-main" onClick={onOpen} aria-label="Open the queue">
        <span className="dot" aria-hidden="true" />
        <span data-testid="queue-headline">{view.headline}</span>
      </button>
      <button className="queuebar-send" onClick={onSend} disabled={busy || !online}>
        {busy ? 'Sending…' : online ? 'Send now' : 'Offline'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

export function SignIn({ onSignIn, error }: { onSignIn: () => void; error: string }) {
  return (
    <main className="screen center">
      <h1>RARE OS Field</h1>
      <p className="muted">
        Sign in once. After that the app works all day without a signal, and sends everything when
        one comes back.
      </p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <button className="big" onClick={onSignIn}>
        Sign in
      </button>
    </main>
  );
}

// ---------------------------------------------------------------------------
// The day
// ---------------------------------------------------------------------------

export function Today({
  day,
  items,
  onStart,
  onEnd,
  onOpenStop,
  stale,
}: {
  day: any;
  items: Queued[];
  onStart: (workTypeId: string) => void;
  onEnd: () => void;
  onOpenStop: (customerId: string) => void;
  stale: boolean;
}) {
  const [workType, setWorkType] = useState('');
  useEffect(() => {
    if (!workType && day?.work_types?.length) setWorkType(day.work_types[0].id);
  }, [day]);

  if (!day)
    return (
      <main className="screen">
        <p role="status">No day has been loaded onto this phone yet. Connect once to load it.</p>
      </main>
    );

  // A day is started if the server said so when it was downloaded, or if the phone has a start
  // sitting in its own queue. Both count: the rep did it either way.
  const startedLocally = items.some((i) => i.kind === 'attendance.start' && i.state !== 'BLOCKED');
  const started = Boolean(day.day?.start_time) || startedLocally;
  const endedLocally = items.some((i) => i.kind === 'attendance.end' && i.state !== 'BLOCKED');
  const ended = Boolean(day.day?.end_time) || endedLocally;

  const visitsFor = (customerId: string) =>
    items.filter((i) => i.kind === 'visit.checkin' && i.payload.customer_id === customerId);

  return (
    <main className="screen">
      <header className="dayhead">
        <div>
          <h1>{day.rep?.name ?? 'Today'}</h1>
          <p className="muted">
            {day.date} · {day.stops?.length ?? 0} stops
            {stale ? ' · loaded earlier' : ''}
          </p>
        </div>
      </header>

      {!started && (
        <section className="card">
          <h2>Start the day</h2>
          <label>
            What kind of day
            <select value={workType} onChange={(e) => setWorkType(e.target.value)}>
              {(day.work_types ?? []).map((w: any) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <button className="big" onClick={() => onStart(workType)} disabled={!workType}>
            Start day
          </button>
        </section>
      )}

      <section className="list">
        <h2>Your round</h2>
        {(day.stops ?? []).length === 0 && (
          <p className="muted">No plan for today. Anything you do will still be recorded.</p>
        )}
        {(day.stops ?? []).map((stop: any) => {
          const mine = visitsFor(stop.customer_id);
          const done = mine.some((v) =>
            items.some((i) => i.kind === 'visit.checkout' && i.payload.visit_id === v.localId),
          );
          const open = mine.length > 0 && !done;
          return (
            <button
              key={stop.customer_id}
              className={'stop ' + (done ? 'done' : open ? 'open' : '')}
              onClick={() => onOpenStop(stop.customer_id)}
            >
              <span className="seq">{stop.sequence}</span>
              <span className="stopbody">
                <strong>{stop.name}</strong>
                <small>
                  {stop.code} · {stop.town || '—'}
                </small>
              </span>
              <span className="state">{done ? 'Done' : open ? 'In shop' : ''}</span>
            </button>
          );
        })}
      </section>

      {started && !ended && (
        <section className="card">
          <button className="big ghost" onClick={onEnd}>
            End the day
          </button>
        </section>
      )}
      {ended && <p className="muted center">Day ended.</p>}
    </main>
  );
}

// ---------------------------------------------------------------------------
// One shop
// ---------------------------------------------------------------------------

export function Stop({
  day,
  stop,
  items,
  onBack,
  onCheckIn,
  onOrder,
  onCollect,
  onCheckOut,
}: {
  day: any;
  stop: any;
  items: Queued[];
  onBack: () => void;
  onCheckIn: (photo: File | null) => void;
  onOrder: (lines: { item_id: string; units: number }[]) => void;
  onCollect: (amount: number, mode: string, reference: string) => void;
  onCheckOut: (answers: Record<string, string>) => void;
}) {
  const [tab, setTab] = useState<'order' | 'collect' | 'close'>('order');
  const photo = useRef<HTMLInputElement>(null);

  const visit = items.find(
    (i) =>
      i.kind === 'visit.checkin' &&
      i.payload.customer_id === stop.customer_id &&
      !items.some((c) => c.kind === 'visit.checkout' && c.payload.visit_id === i.localId),
  );
  const prices = (day.prices ?? []).filter((p: any) => p.type_id === stop.type_id);
  const owed = day.outstanding?.[stop.customer_id];
  const form = day.forms?.[stop.type_id] ?? [];

  return (
    <main className="screen">
      <header className="dayhead">
        <button className="back" onClick={onBack} aria-label="Back to the round">
          ‹
        </button>
        <div>
          <h1>{stop.name}</h1>
          <p className="muted">
            {stop.code} · {stop.town || '—'} · owes {money(owed)}
          </p>
        </div>
      </header>

      {!visit ? (
        <section className="card">
          <h2>Check in</h2>
          <p className="muted">
            Recorded on this phone straight away, with wherever you are standing. It is sent when
            there is a signal.
          </p>
          <input
            ref={photo}
            type="file"
            accept="image/*"
            capture="environment"
            aria-label="Photo at the shop"
          />
          <button className="big" onClick={() => onCheckIn(photo.current?.files?.[0] ?? null)}>
            Check in
          </button>
        </section>
      ) : (
        <>
          <nav className="tabs">
            <button className={tab === 'order' ? 'on' : ''} onClick={() => setTab('order')}>
              Order
            </button>
            <button className={tab === 'collect' ? 'on' : ''} onClick={() => setTab('collect')}>
              Collect
            </button>
            <button className={tab === 'close' ? 'on' : ''} onClick={() => setTab('close')}>
              Check out
            </button>
          </nav>
          {tab === 'order' && <OrderPad prices={prices} onOrder={onOrder} />}
          {tab === 'collect' && <CollectPad owed={owed} onCollect={onCollect} />}
          {tab === 'close' && <ClosePad form={form} onCheckOut={onCheckOut} />}
        </>
      )}
    </main>
  );
}

function OrderPad({
  prices,
  onOrder,
}: {
  prices: any[];
  onOrder: (lines: { item_id: string; units: number }[]) => void;
}) {
  const [basket, setBasket] = useState<Record<string, number>>({});
  // `units` is what the order route calls it. The field name is not cosmetic: the route refuses
  // what it does not recognise, so a basket keyed on 'quantity' is a blocked order with a
  // message about a quantity of zero.
  const lines = Object.entries(basket)
    .filter(([, q]) => q > 0)
    .map(([item_id, units]) => ({ item_id, units }));
  // Priced on the phone from the rates that came down with the day, and priced again on the
  // server when it arrives. The phone's figure is what the rep tells the shopkeeper; the
  // server's is the one that counts, and the two agree because they use the same rate list.
  const total = lines.reduce((sum, l) => {
    const price = prices.find((p) => p.item_id === l.item_id);
    return sum + (price ? Number(price.rate) * l.units : 0);
  }, 0);

  if (!prices.length)
    return (
      <section className="card">
        <p className="muted">No price list came down for this kind of shop.</p>
      </section>
    );

  return (
    <section className="card">
      <h2>Order</h2>
      <div className="items">
        {prices.map((p: any) => (
          <div className="itemrow" key={p.item_id}>
            <span>
              <strong>{p.item_name}</strong>
              <small>
                {p.item} · {money(p.rate)}
              </small>
            </span>
            <input
              type="number"
              min={0}
              inputMode="numeric"
              aria-label={'Quantity of ' + p.item_name}
              value={basket[p.item_id] ?? ''}
              onChange={(e) =>
                setBasket({ ...basket, [p.item_id]: Math.max(0, Number(e.target.value) || 0) })
              }
            />
          </div>
        ))}
      </div>
      <p className="total">About {money(total)}</p>
      <button className="big" disabled={!lines.length} onClick={() => onOrder(lines)}>
        Take the order
      </button>
    </section>
  );
}

function CollectPad({
  owed,
  onCollect,
}: {
  owed: number | undefined;
  onCollect: (amount: number, mode: string, reference: string) => void;
}) {
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('CASH');
  const [reference, setReference] = useState('');
  const needsReference = ['CHEQUE', 'NEFT', 'UPI'].includes(mode);
  const value = Number(amount);
  const ready = value > 0 && (!needsReference || reference.trim().length > 0);
  return (
    <section className="card">
      <h2>Collect</h2>
      <p className="muted">Outstanding {money(owed)}</p>
      <label>
        Amount
        <input
          type="number"
          inputMode="decimal"
          min={0}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <label>
        How
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          {['CASH', 'UPI', 'CHEQUE', 'NEFT'].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      {needsReference && (
        <label>
          Number
          <input value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
      )}
      <button
        className="big"
        disabled={!ready}
        onClick={() => onCollect(value, mode, reference.trim())}
      >
        Record the collection
      </button>
    </section>
  );
}

function ClosePad({
  form,
  onCheckOut,
}: {
  form: any[];
  onCheckOut: (answers: Record<string, string>) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const missing = form
    .filter((f: any) => f.requirement === 'REQUIRED' && !String(answers[f.field_key] ?? '').trim())
    .map((f: any) => f.label_override || f.name);
  return (
    <section className="card">
      <h2>Check out</h2>
      {form.map((f: any) => (
        <label key={f.field_key}>
          {f.label_override || f.name}
          {f.requirement === 'REQUIRED' ? ' *' : ''}
          <input
            value={answers[f.field_key] ?? ''}
            onChange={(e) => setAnswers({ ...answers, [f.field_key]: e.target.value })}
          />
        </label>
      ))}
      {missing.length > 0 && (
        <p className="muted">
          The report is short of: {missing.join(', ')}. You can still check out — an incomplete
          report is recorded as incomplete, not refused.
        </p>
      )}
      <button className="big" onClick={() => onCheckOut(answers)}>
        Check out
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export function Queue({
  items,
  onBack,
  onSend,
  busy,
}: {
  items: Queued[];
  onBack: () => void;
  onSend: () => void;
  busy: boolean;
}) {
  const view = queueSummary(items);
  const label = (i: Queued) => i.label || i.kind;
  return (
    <main className="screen">
      <header className="dayhead">
        <button className="back" onClick={onBack} aria-label="Back">
          ‹
        </button>
        <div>
          <h1>On this phone</h1>
          <p className="muted" data-testid="queue-counts">
            {view.sent} sent · {view.queued} waiting · {view.blocked} stopped
          </p>
        </div>
      </header>

      {view.blocked > 0 && (
        <section className="card bad">
          <h2>Needs you</h2>
          {view.problems.map((p) => (
            <div className="problem" key={p.localId}>
              <strong>{p.title}</strong>
              <p>{p.why}</p>
            </div>
          ))}
        </section>
      )}

      <section className="list">
        {items.length === 0 && <p className="muted">Nothing has been done on this phone yet.</p>}
        {[...items]
          .sort((a, b) => a.seq - b.seq)
          .map((i) => (
            <div className={'qrow ' + i.state.toLowerCase()} key={i.localId}>
              <span className="state">
                {i.state === 'SENT' ? '✓' : i.state === 'BLOCKED' ? '!' : '…'}
              </span>
              <span className="stopbody">
                <strong>{label(i)}</strong>
                {i.lastError && <small>{i.lastError}</small>}
              </span>
            </div>
          ))}
      </section>

      <button className="big" onClick={onSend} disabled={busy}>
        {busy ? 'Sending…' : 'Send now'}
      </button>
    </main>
  );
}
