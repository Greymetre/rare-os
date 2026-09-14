import { existsSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (existsSync('.env')) {
  if (!/^IDENTITY_CLIENT_SECRET=.+/m.test(readFileSync('.env', 'utf8'))) {
    appendFileSync('.env', '\nIDENTITY_CLIENT_SECRET=' + randomBytes(24).toString('hex') + '\n');
  }
  console.log('.env already exists; existing credentials preserved.');
  process.exit(0);
}
const random = () => randomBytes(24).toString('hex');
const values = {
  APP_URL: 'http://localhost:4310',
  AUTH_URL: 'http://localhost:4311',
  DB_PASSWORD: random(),
  APP_DB_PASSWORD: random(),
  KEYCLOAK_DB_PASSWORD: random(),
  SESSION_SECRET: random(),
  OIDC_CLIENT_SECRET: random(),
  IDENTITY_CLIENT_SECRET: random(),
  KC_ADMIN_PASSWORD: random(),
  SEED_ADMIN_EMAIL: 'admin@rareos.local',
  SEED_ADMIN_PASSWORD: random(),
};
writeFileSync(
  '.env',
  Object.entries(values)
    .map(([k, v]) => k + '=' + v)
    .join('\n') + '\n',
  { mode: 0o600 },
);
console.log('Created .env with generated local credentials.');
