import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import { requestLimits } from '../apps/api/src/rate-limits.ts';
test('API sessions, anonymous requests, health and login have independent quotas', async () => {
  const app = express();
  app.use(
    session({
      secret: 'test-only-secret-at-least-32-characters',
      resave: false,
      saveUninitialized: false,
    }),
  );
  app.get('/test/session', (req, res) => {
    req.session.subject = 'test-user';
    res.send('signed in');
  });
  app.use(...requestLimits(2, 2));
  app.get(/.*/, (req, res) => res.send('ok'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = (path, cookie) =>
    fetch(base + path, { headers: cookie ? { Cookie: cookie } : undefined });
  try {
    const cookies = [];
    for (let i = 0; i < 2; i++)
      cookies.push((await get('/test/session')).headers.get('set-cookie').split(';')[0]);
    assert.equal((await get('/api/users', cookies[0])).status, 200);
    assert.equal((await get('/api/users', cookies[0])).status, 200);
    assert.equal((await get('/api/users', cookies[0])).status, 429);
    assert.equal((await get('/api/users', cookies[1])).status, 200);
    for (let i = 0; i < 2; i++) assert.equal((await get('/api/me')).status, 200);
    assert.equal((await get('/api/me')).status, 429);
    assert.equal((await get('/api/health')).status, 200);
    for (let i = 0; i < 2; i++) assert.equal((await get('/api/auth/login')).status, 200);
    const limited = await fetch(base + '/api/auth/login', { headers: { Accept: 'text/html' } });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.match(await limited.text(), /Please wait before signing in again/);
    assert.equal((await get('/api/auth/callback')).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
