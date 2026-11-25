// RCH-8: what the whole app shares — the day downloaded before the rep left coverage, the
// outbox, and the four moments when sending is attempted.
//
// The shape of this file follows from one decision, taken everywhere: **the rep's tap is the
// event, and the network is an afterthought.** Every action writes to SQLite and returns.
// Nothing awaits a response. The queue sends when it can, and the only place the network is ever
// mentioned to the rep is the bar across the top, which says how much is still on the phone.
//
// That is why there is no spinner anywhere in this app and no dialog that says "could not reach
// the server". Not reaching the server is the normal state of this app.
//
// The four moments: when the app opens, when the phone says the network came back, when the rep
// asks, and on a slow timer while anything is waiting.

import * as Network from 'expo-network';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { queueItem } from '../../../packages/engines/sync-queue.mjs';
import { accessToken, isSignedIn, signOut as forgetTokens } from './auth';
import {
  allItems,
  clearDay,
  forgetSettled,
  nextSeq,
  putItems,
  readDay,
  writeDay,
  type Queued,
} from './db';
import { clientRef, deviceRef, localId } from './device';
import { fetchDay, heartbeat, syncOnce, type SyncOutcome } from './sync';

// ---------------------------------------------------------------------------
// The day, as `GET reach/device/day` sends it
// ---------------------------------------------------------------------------

export type Stop = {
  customer_id: string;
  sequence: number;
  code: string;
  name: string;
  town: string;
  status: string;
  type_id: string;
  type: string;
  type_name: string;
  checkin_radius_m: number | null;
  latitude: number | null;
  longitude: number | null;
  beat: string;
};

export type Price = {
  type_id: string;
  item_id: string;
  item: string;
  item_name: string;
  unit: string;
  rate: number;
  gst_pct: number;
};

// A question on the check-out report, in the shape `customerForm` builds and `validateAnswers`
// reads back. `descriptor` is the validator's own view of the field and the phone does not touch
// it — the server validates, and a second opinion here would be a second definition.
export type FormField = {
  field_key: string;
  label: string;
  section: string;
  order: number;
  input: string;
  help: string;
  required: boolean;
  choices: string[];
};

export type Day = {
  date: string;
  server_date: string;
  rep: { id: string; code: string; name: string; hq_town: string | null; grade: string | null };
  work_types: { id: string; code: string; name: string; needs_location: boolean }[];
  stops: Stop[];
  prices: Price[];
  day: { id: string; version: number; start_time: string | null; end_time: string | null } | null;
  open_visits: {
    id: string;
    customer_id: string;
    version: number;
    client_ref: string;
    checked_in_at: string;
  }[];
  forms: Record<string, FormField[] | null>;
  outstanding: Record<string, number>;
  permissions: string[];
};

type Shared = {
  ready: boolean;
  signedIn: boolean;
  day: Day | null;
  items: Queued[];
  outcome: SyncOutcome | null;
  may: (kind: string) => boolean;
  push: (
    kind: string,
    payload: Record<string, unknown>,
    label: string,
    extra?: Partial<Queued>,
  ) => Promise<Queued>;
  flush: (now?: boolean) => Promise<void>;
  refreshDay: () => Promise<void>;
  reload: () => Promise<void>;
  signedOut: () => Promise<void>;
  setSignedIn: (value: boolean) => void;
  openVisitFor: (customerId: string) => { id: string; version: number } | null;
};

const Ctx = createContext<Shared | null>(null);

export function useField(): Shared {
  const shared = useContext(Ctx);
  if (!shared) throw Error('useField used outside the provider');
  return shared;
}

export function FieldProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [day, setDay] = useState<Day | null>(null);
  const [items, setItems] = useState<Queued[]>([]);
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null);

  const reload = useCallback(async () => {
    setItems(await allItems());
  }, []);

  const flush = useCallback(
    async (now = false) => {
      // While plainly offline, a push must not burn an attempt: each failure lengthens the
      // backoff, and a day's work queued out of coverage would otherwise arrive at six in the
      // evening several minutes deep in a wait nobody asked for. A rep's explicit tap always
      // goes through.
      const state = await Network.getNetworkStateAsync().catch(() => null);
      if (state && state.isConnected === false && !now) {
        await reload();
        return;
      }
      const result = await syncOnce({ ignoreBackoff: now });
      setOutcome(result);
      if (result.needsSignIn) setSignedIn(false);
      await reload();
    },
    [reload],
  );

  const push = useCallback(
    async (
      kind: string,
      payload: Record<string, unknown>,
      label: string,
      extra: Partial<Queued> = {},
    ): Promise<Queued> => {
      // The sequence comes from storage, not from React state. Two pushes inside one handler —
      // a photo and the check-in that carries it — would otherwise be given the same number and
      // the queue would have no way to tell which the rep did first.
      const seq = await nextSeq();
      const item = {
        ...queueItem({
          kind,
          payload,
          localId: extra.localId ?? localId(),
          clientRef: clientRef(),
          seq,
        }),
        label,
        ...extra,
      } as Queued & { label: string };
      await putItems([item]);
      await reload();
      return item;
    },
    [reload],
  );

  const refreshDay = useCallback(async () => {
    const fresh = await fetchDay<Day>();
    if (fresh) {
      await writeDay('today', fresh);
      setDay(fresh);
      return;
    }
    // No line. What is already saved is the right thing to show — a perfectly good round should
    // not be replaced by an error because a tower was busy.
    const saved = await readDay<Day>('today');
    if (saved) setDay(saved);
  }, []);

  const signedOut = useCallback(async () => {
    await forgetTokens();
    await clearDay();
    setDay(null);
    setSignedIn(false);
    // The outbox is deliberately left alone. Unsent work belongs to the rep, not to the session.
    await reload();
  }, [reload]);

  // ---------- Opening ----------
  useEffect(() => {
    (async () => {
      const saved = await readDay<Day>('today');
      if (saved) setDay(saved);
      await reload();
      const already = await isSignedIn();
      setSignedIn(already);
      setReady(true);
      if (!already) return;
      // A token this app can use means the server is reachable, which is the only safe moment to
      // ask for a fresh day.
      try {
        if (await accessToken()) await refreshDay();
      } catch {
        setSignedIn(false);
        return;
      }
      await forgetSettled();
      await flush();
      void heartbeat(await deviceRef());
    })();
    // Runs once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- The network coming back ----------
  useEffect(() => {
    if (!signedIn) return;
    const subscription = Network.addNetworkStateListener((state) => {
      // `now` on purpose: the thing the backoff was waiting out has just ended, so the wait is
      // no longer meaningful.
      if (state.isConnected) void flush(true);
    });
    return () => subscription.remove();
  }, [signedIn, flush]);

  // ---------- A slow timer, only while something is waiting ----------
  useEffect(() => {
    if (!signedIn) return;
    const waiting = items.some((i) => i.state === 'QUEUED');
    if (!waiting) return;
    const timer = setInterval(() => void flush(), 30_000);
    return () => clearInterval(timer);
  }, [signedIn, items, flush]);

  const may = useCallback(
    (kind: string) => (day?.permissions ?? []).includes(kind),
    [day?.permissions],
  );

  // An open visit for a shop: either one the server already knows about, or a check-in still on
  // the phone that nothing has checked out yet. The second case is what lets a rep take an order
  // at a shop whose check-in has not left the handset.
  const openVisitFor = useCallback(
    (customerId: string) => {
      const queuedCheckIn = items.find(
        (i) =>
          i.kind === 'visit.checkin' &&
          i.payload.customer_id === customerId &&
          i.state !== 'BLOCKED' &&
          !items.some((c) => c.kind === 'visit.checkout' && c.payload.visit_id === i.localId),
      );
      if (queuedCheckIn)
        return {
          id: queuedCheckIn.serverId ?? queuedCheckIn.localId,
          version: 1,
        };
      const open = (day?.open_visits ?? []).find((v) => v.customer_id === customerId);
      return open ? { id: open.id, version: open.version } : null;
    },
    [items, day?.open_visits],
  );

  const shared = useMemo<Shared>(
    () => ({
      ready,
      signedIn,
      day,
      items,
      outcome,
      may,
      push,
      flush,
      refreshDay,
      reload,
      signedOut,
      setSignedIn,
      openVisitFor,
    }),
    [
      ready,
      signedIn,
      day,
      items,
      outcome,
      may,
      push,
      flush,
      refreshDay,
      reload,
      signedOut,
      openVisitFor,
    ],
  );

  return <Ctx.Provider value={shared}>{children}</Ctx.Provider>;
}
