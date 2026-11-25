// RCH-8: the screens that genuinely need a network, and say so.
//
// The day's own work — check in, order, photo, collect, check out — never goes through here. It
// goes into the outbox, because the plan's promise is that a whole beat can be worked with no
// signal.
//
// These are the other screens the client's designs give a rep: the month's register, leave, a
// missed punch, the tour plan. They are **not** queued, and that is a decision rather than an
// omission. Queueing a write means a reference column, a unique index and a migration so that a
// retry cannot duplicate it, which is what `client_ref` is for on the five kinds that have it.
// Applying for leave twice because a bus went through a tunnel is a worse outcome than being
// told to try again where there is signal — and unlike a visit, none of this is time-critical to
// the minute.
//
// So: read when there is a line, say plainly when there is not, and never pretend.

import { accessToken } from './auth';
import { API } from './config';

export type Fetched<T> = { data: T | null; offline: boolean; error: string; needsSignIn: boolean };

const OFFLINE: Fetched<never> = { data: null, offline: true, error: '', needsSignIn: false };

async function tokenOrState(): Promise<{ token: string } | { state: Fetched<never> }> {
  try {
    const token = await accessToken();
    if (!token) return { state: OFFLINE };
    return { token };
  } catch (problem) {
    return {
      state: {
        data: null,
        offline: false,
        needsSignIn: true,
        error: problem instanceof Error ? problem.message : 'Sign in again.',
      },
    };
  }
}

export async function get<T>(
  path: string,
  query: Record<string, string> = {},
): Promise<Fetched<T>> {
  const held = await tokenOrState();
  if ('state' in held) return held.state;
  const search = new URLSearchParams(query).toString();
  try {
    const res = await fetch(API + path + (search ? '?' + search : ''), {
      headers: { authorization: 'Bearer ' + held.token },
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok)
      return {
        data: null,
        offline: false,
        needsSignIn: res.status === 401,
        error: (body?.message as string) ?? 'The server refused this.',
      };
    return { data: body as T, offline: false, error: '', needsSignIn: false };
  } catch {
    return OFFLINE;
  }
}

export async function post<T>(path: string, payload: unknown): Promise<Fetched<T>> {
  const held = await tokenOrState();
  if ('state' in held) return held.state;
  try {
    const res = await fetch(API + path, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + held.token, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok)
      return {
        data: null,
        offline: false,
        needsSignIn: res.status === 401,
        error: (body?.message as string) ?? 'The server refused this.',
      };
    return { data: body as T, offline: false, error: '', needsSignIn: false };
  } catch {
    return OFFLINE;
  }
}

export const thisMonth = (): string => new Date().toISOString().slice(0, 7);
export const today = (): string => new Date().toISOString().slice(0, 10);
