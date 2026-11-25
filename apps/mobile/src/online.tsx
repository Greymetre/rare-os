// A screen that needs a network, with the three states it can be in said once instead of in
// every file: loading, no line, or refused. A rep should never see a blank screen and wonder.
import { useCallback, useEffect, useState } from 'react';
import { get, type Fetched } from './net';
import { Big, Body, Card, Soft } from './ui';
import { colour } from './theme';

export function useOnline<T>(path: string, query: Record<string, string> = {}) {
  const key = JSON.stringify(query);
  const [state, setState] = useState<Fetched<T> | null>(null);
  const load = useCallback(async () => {
    setState(null);
    setState(await get<T>(path, JSON.parse(key) as Record<string, string>));
    // key is the stable form of query
  }, [path, key]);
  useEffect(() => {
    void load();
  }, [load]);
  return { state, reload: load };
}

export function Waiting({ state, reload }: { state: Fetched<unknown> | null; reload: () => void }) {
  if (!state)
    return (
      <Card>
        <Body>Asking the server…</Body>
      </Card>
    );
  if (state.offline)
    return (
      <Card style={{ borderColor: colour.waiting }}>
        <Body>This screen needs a network.</Body>
        <Soft>Your day's own work does not — it is saved on the phone and sent later.</Soft>
        <Big label="Try again" onPress={reload} tone="quiet" />
      </Card>
    );
  if (state.error)
    return (
      <Card style={{ borderColor: colour.stopped }}>
        <Body>{state.error}</Body>
        <Big label="Try again" onPress={reload} tone="quiet" />
      </Card>
    );
  return null;
}
