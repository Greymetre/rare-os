import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
test('restricted checkout becomes readable without exposing private configuration', () => {
  const script = resolve('scripts/deploy/prepare-source.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'rare-source-modes-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    mkdirSync(join(dir, 'db/migrations'), { recursive: true });
    mkdirSync(join(dir, '.local'), { mode: 0o700 });
    const sql = join(dir, 'db/migrations/009.sql');
    const executable = join(dir, 'run.sh');
    writeFileSync(sql, 'SELECT 1;', { mode: 0o600 });
    writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 });
    writeFileSync(join(dir, '.env'), 'fixture=private', { mode: 0o600 });
    writeFileSync(join(dir, '.local/backup'), 'private', { mode: 0o600 });
    chmodSync(join(dir, 'db'), 0o700);
    chmodSync(join(dir, 'db/migrations'), 0o700);
    execFileSync('git', ['add', 'db/migrations/009.sql', 'run.sh'], { cwd: dir });
    for (let i = 0; i < 2; i++) execFileSync(process.execPath, [script], { cwd: dir });
    const mode = (p) => statSync(join(dir, p)).mode & 0o777;
    assert.equal(mode('db/migrations/009.sql'), 0o644);
    assert.equal(mode('db/migrations'), 0o755);
    assert.equal(mode('db'), 0o755);
    assert.equal(mode('run.sh'), 0o744);
    assert.equal(mode('.env'), 0o600);
    assert.equal(mode('.local'), 0o700);
    assert.equal(mode('.local/backup'), 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
