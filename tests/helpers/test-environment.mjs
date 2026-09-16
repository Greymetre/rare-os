import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Evaluated when Playwright loads its config, before any test can write data or stop services.
export function assertDisposableStack(environment, marker, values, cwd) {
  const project = environment.COMPOSE_PROJECT_NAME || '';
  if (
    environment.RARE_E2E_DISPOSABLE_STACK !== 'true' ||
    !/^rare-regression-[a-z0-9]+-[a-f0-9]{8}$/.test(project) ||
    marker.project !== project ||
    !marker.nonce ||
    marker.nonce !== environment.RARE_E2E_NONCE ||
    environment.COMPOSE_FILE !== resolve(cwd, 'compose.yaml') ||
    environment.COMPOSE_ENV_FILES !== resolve(cwd, '.env')
  )
    throw Error('Browser tests require an isolated stack. Run npm run test:regression.');
  const ports = [];
  for (const key of ['APP_URL', 'AUTH_URL', 'MAILPIT_URL']) {
    const url = new URL(values[key]);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== 'localhost' ||
      !url.port ||
      ['4310', '4311', '4312'].includes(url.port) ||
      url.username ||
      url.password
    )
      throw Error('Refusing browser tests against a normal development or external service.');
    ports.push(url.port);
  }
  if (new Set(ports).size !== 3) throw Error('Test services must have separate ports.');
}
export function loadTestEnvironment() {
  try {
    const values = Object.fromEntries(
      readFileSync('.env', 'utf8')
        .trim()
        .split('\n')
        .map((line) => {
          const i = line.indexOf('=');
          return [line.slice(0, i), line.slice(i + 1)];
        }),
    );
    const marker = JSON.parse(readFileSync('.local/regression-stack.json', 'utf8'));
    assertDisposableStack(process.env, marker, values, process.cwd());
    return values;
  } catch (error) {
    throw Error('Use npm run test:regression to create a disposable test stack. ' + error.message);
  }
}
