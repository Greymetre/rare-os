// RCH-8: the field app.
//
// The shape of this file follows from one decision, taken everywhere: **the rep's tap is the
// event, and the network is an afterthought.** Every action writes to IndexedDB and returns.
// Nothing awaits a response. The queue sends when it can, and the only place the network is ever
// mentioned to the rep is the bar across the top, which says how much is still on the phone.
//
// That is why there is no loading spinner anywhere in this app, and no error dialog that says
// "could not reach the server". Not reaching the server is the normal state of this app.
//
// What the shell itself owns: the day downloaded from the depot, the outbox, who is signed in,
// and four moments when it tries to send — when it opens, when the browser says the network
// came back, when the rep asks, and on a slow timer while anything is waiting.

import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { queueItem, LOCAL_PREFIX } from '../../../packages/engines/sync-queue.mjs';
import { beginSignIn, finishSignIn, rememberAuthBase, signOut, signedIn } from './auth';
import { allItems, putItem, readDay, writeDay, type Queued } from './store';
import { fetchDay, heartbeat, syncOnce } from './sync';
import { QueueBar, Queue, SignIn, Stop, Today } from './screens';
import './styles.css';

const APP_VERSION = '1.0.0';
// A phone's own name for itself, so a rep with a new handset does not look like a rep who
// stopped syncing. Made once and kept.
async function deviceRef(): Promise<string> {
  const held = await readDay<string>('deviceRef');
  if (held) return held;
  const made = crypto.randomUUID();
  await writeDay('deviceRef', made);
  return made;
}

const localId = () => LOCAL_PREFIX + crypto.randomUUID();

// Where the rep is standing, if the phone will say. Never blocks: a check-in without a fix is
// recorded without one, exactly as the server treats it. Refusing to record a visit because the
// GPS is slow would lose a real call.
function whereAmI(): Promise<{
  latitude: number | null;
  longitude: number | null;
  accuracy_m: number | null;
}> {
  return new Promise((resolve) => {
    if (!navigator.geolocation)
      return resolve({ latitude: null, longitude: null, accuracy_m: null });
    const give = (v: any) => resolve(v);
    const timer = setTimeout(
      () => give({ latitude: null, longitude: null, accuracy_m: null }),
      8000,
    );
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(timer);
        give({
          latitude: p.coords.latitude,
          longitude: p.coords.longitude,
          accuracy_m: Math.round(p.coords.accuracy),
        });
      },
      () => {
        clearTimeout(timer);
        give({ latitude: null, longitude: null, accuracy_m: null });
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    );
  });
}

function App() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState('');
  const [day, setDay] = useState<any>(null);
  const [stale, setStale] = useState(false);
  const [items, setItems] = useState<Queued[]>([]);
  const [view, setView] = useState<{ name: 'today' | 'stop' | 'queue'; customerId?: string }>({
    name: 'today',
  });
  const [online, setOnline] = useState(navigator.onLine);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => setItems(await allItems<Queued>()), []);

  // Order is the one thing the queue cannot work out for itself: a rep's day only reads
  // correctly if it arrives in the order it happened.
  //
  // The number is taken from what is actually in storage, never from React's copy. Checking in
  // with a photo queues two items one after the other, and React has not re-rendered in
  // between — reading the component's `items` there would hand both the same number and leave
  // their order to however IndexedDB felt like returning them.
  const push = useCallback(
    async (
      kind: string,
      payload: Record<string, unknown>,
      label: string,
      extra: Partial<Queued> = {},
    ) => {
      const stored = await allItems<Queued>();
      const item = {
        ...queueItem({
          kind,
          payload,
          localId: extra.localId ?? localId(),
          clientRef: crypto.randomUUID(),
          seq: stored.length ? Math.max(...stored.map((i) => i.seq)) + 1 : 0,
        }),
        label,
        ...extra,
      };
      await putItem(item);
      await reload();
      return item as Queued;
    },
    [reload],
  );

  // ---------- Starting up ----------

  useEffect(() => {
    (async () => {
      try {
        // Where the identity server lives. Cached, because this has to work on a phone that is
        // opened for the first time that morning with a weak line.
        const held = await readDay<string>('authUrl');
        if (!held) {
          const res = await fetch('/api/mobile/config');
          if (res.ok) {
            const cfg = await res.json();
            await writeDay('authUrl', cfg.authUrl);
            await rememberAuthBase(cfg.authUrl);
          }
        } else await rememberAuthBase(held);

        await finishSignIn().catch((e) => setAuthError(e.message));
        setAuthed(await signedIn());
      } catch (e: any) {
        setAuthError(e?.message ?? 'Could not start.');
      }
      const cached = await readDay<any>('today');
      if (cached) {
        setDay(cached);
        setStale(true);
      }
      await reload();
      setReady(true);
    })();
  }, []);

  // Once signed in: take the day, then try to send whatever is waiting.
  useEffect(() => {
    if (!authed || !ready) return;
    (async () => {
      const fresh = await fetchDay();
      if (fresh) {
        await writeDay('today', fresh);
        setDay(fresh);
        setStale(false);
      }
      await flush();
    })();
  }, [authed, ready]);

  // ---------- Sending ----------

  // `now` means the rep asked, or the network just came back: either way the waiting period the
  // earlier failures built up no longer describes anything true.
  const flush = useCallback(
    async (now = false) => {
      // Queueing something while the phone is plainly offline should not cost that item an
      // attempt. Every failed attempt lengthens the wait before the next one, so a day's work
      // entered in airplane mode would arrive at six o'clock already several minutes deep in a
      // backoff that was never measuring anything real.
      if (!navigator.onLine && !now) {
        setOnline(false);
        await reload();
        return;
      }
      setBusy(true);
      try {
        const outcome = await syncOnce({ ignoreBackoff: now });
        if (outcome.needsSignIn) setAuthed(false);
        setOnline(!outcome.offline && navigator.onLine);
        await reload();
        await heartbeat(await deviceRef(), APP_VERSION).catch(() => undefined);
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  useEffect(() => {
    const back = () => {
      setOnline(true);
      void flush(true);
    };
    const gone = () => setOnline(false);
    addEventListener('online', back);
    addEventListener('offline', gone);
    // A slow heartbeat rather than a fast poll: the browser already tells us when the network
    // returns, and this only catches the case where it comes back without saying so.
    const timer = setInterval(() => {
      if (navigator.onLine) void flush();
    }, 60000);
    return () => {
      removeEventListener('online', back);
      removeEventListener('offline', gone);
      clearInterval(timer);
    };
  }, [flush]);

  // ---------- What the rep does ----------

  const startDay = async (workTypeId: string) => {
    const at = await whereAmI();
    // 'DEVICE' is what the server calls a fix the handset produced, as against one somebody
    // typed or dropped on a pin. It is not a name for the kind of hardware, and inventing
    // 'MOBILE' for it is refused — rightly, since the distinction the column records is how
    // much the location can be trusted, not what it came from.
    await push(
      'attendance.start',
      { work_type_id: workTypeId, ...at, source: 'DEVICE' },
      'Day started',
    );
    void flush();
  };

  const endDay = async () => {
    const at = await whereAmI();
    await push(
      'attendance.end',
      { ...at, source: 'DEVICE', version: day?.day?.version ?? 1 },
      'Day ended',
    );
    void flush();
  };

  const checkIn = async (customerId: string, photo: File | null) => {
    const at = await whereAmI();
    let fileId: string | null = null;
    if (photo) {
      const shot = await push(
        'file.upload',
        // A photo of the shop, not of the rep. `shelf` has been an allowed purpose since RCH-0
        // and this is what it was for.
        { purpose: 'shelf', name: photo.name || 'photo.jpg' },
        'Photo',
        { localId: localId(), blob: photo, contentType: photo.type || 'image/jpeg' },
      );
      fileId = shot.localId;
    }
    await push(
      'visit.checkin',
      { customer_id: customerId, file_id: fileId, ...at, source: 'DEVICE' },
      'Check-in',
    );
    void flush();
  };

  const openVisitFor = (customerId: string) =>
    items.find(
      (i) =>
        i.kind === 'visit.checkin' &&
        i.payload.customer_id === customerId &&
        !items.some((c) => c.kind === 'visit.checkout' && c.payload.visit_id === i.localId),
    );

  const takeOrder = async (customerId: string, lines: { item_id: string; units: number }[]) => {
    const visit = openVisitFor(customerId);
    await push(
      'order.place',
      { customer_id: customerId, visit_id: visit?.localId ?? null, lines },
      'Order',
    );
    void flush();
  };

  const collect = async (customerId: string, amount: number, mode: string, reference: string) => {
    const at = await whereAmI();
    await push(
      'receipt.collect',
      // A collection records no visit: `trade_receipts` has no column for one, and the route
      // refuses fields it does not read. It still goes up after the check-in, because the queue
      // sends in the order the rep did things.
      {
        customer_id: customerId,
        amount,
        mode,
        reference,
        latitude: at.latitude,
        longitude: at.longitude,
      },
      'Collection',
    );
    void flush();
  };

  const checkOut = async (customerId: string, answers: Record<string, string>) => {
    const visit = openVisitFor(customerId);
    if (!visit) return;
    const at = await whereAmI();
    await push(
      'visit.checkout',
      {
        visit_id: visit.localId,
        version: 1,
        // Keyed by field, which is the shape `validateAnswers` reads. A list of pairs would be
        // refused field by field, and the rep would never learn why.
        report: answers,
        ...at,
        source: 'DEVICE',
      },
      'Check-out',
    );
    setView({ name: 'today' });
    void flush();
  };

  // ---------- Drawing ----------

  if (!ready) return <main className="screen center">Starting…</main>;
  if (!authed)
    return (
      <SignIn
        error={authError}
        onSignIn={async () => {
          const authUrl = (await readDay<string>('authUrl')) ?? '';
          if (!authUrl) return setAuthError('Connect once so the app can find the sign-in page.');
          await beginSignIn(authUrl);
        }}
      />
    );

  const stop = day?.stops?.find((s: any) => s.customer_id === view.customerId);

  return (
    <>
      <QueueBar
        items={items}
        online={online}
        busy={busy}
        onSend={() => void flush(true)}
        onOpen={() => setView({ name: 'queue' })}
      />
      {view.name === 'queue' && (
        <Queue
          items={items}
          busy={busy}
          onBack={() => setView({ name: 'today' })}
          onSend={() => void flush(true)}
        />
      )}
      {view.name === 'stop' && stop && (
        <Stop
          day={day}
          stop={stop}
          items={items}
          onBack={() => setView({ name: 'today' })}
          onCheckIn={(photo) => void checkIn(stop.customer_id, photo)}
          onOrder={(lines) => void takeOrder(stop.customer_id, lines)}
          onCollect={(a, m, r) => void collect(stop.customer_id, a, m, r)}
          onCheckOut={(answers) => void checkOut(stop.customer_id, answers)}
        />
      )}
      {(view.name === 'today' || (view.name === 'stop' && !stop)) && (
        <Today
          day={day}
          items={items}
          stale={stale}
          onStart={(w) => void startDay(w)}
          onEnd={() => void endDay()}
          onOpenStop={(customerId) => setView({ name: 'stop', customerId })}
        />
      )}
      <footer className="foot">
        <button className="link" onClick={() => void signOut().then(() => setAuthed(false))}>
          Sign out
        </button>
      </footer>
    </>
  );
}

// The service worker is what makes this installable and what makes opening the app with no
// signal show the app rather than the browser's dinosaur.
if ('serviceWorker' in navigator)
  addEventListener('load', () =>
    navigator.serviceWorker.register('/mobile/sw.js').catch(() => undefined),
  );

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
