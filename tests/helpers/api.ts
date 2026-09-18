import type { APIResponse } from '@playwright/test';

// The API allows 180 requests a minute per session. Long regression scenarios poll background
// imports and planning runs, so on a slow runner they can reach that limit: wait the time the API
// asks for and retry, as a real user would, instead of failing on RATE_LIMITED.
export async function withRateLimitRetry(send: () => Promise<APIResponse>): Promise<APIResponse> {
  for (let attempt = 0; ; attempt++) {
    const r = await send();
    if (r.status() !== 429 || attempt >= 3) return r;
    const body = await r.json().catch(() => ({}));
    const seconds = Number(body?.error?.retryAfterSeconds) || 5;
    await new Promise((done) => setTimeout(done, (seconds + 1) * 1000));
  }
}
