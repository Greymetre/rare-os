import { env, internal, realm, fail } from './core.js';
let token = '',
  expires = 0;
async function identityToken() {
  if (token && Date.now() < expires) return token;
  const r = await fetch(internal + realm + '/protocol/openid-connect/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'rare-os-identity',
      client_secret: env.IDENTITY_CLIENT_SECRET || '',
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok)
    fail(
      503,
      'IDENTITY_UNAVAILABLE',
      'Account service is unavailable. Your changes are saved; retry account setup shortly.',
    );
  const data = (await r.json()) as { access_token: string; expires_in: number };
  token = data.access_token;
  expires = Date.now() + (data.expires_in - 20) * 1000;
  return token;
}
export async function identity(path: string, method = 'GET', body?: unknown): Promise<Response> {
  try {
    const r = await fetch(internal + '/admin' + realm + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + (await identityToken()),
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 401) {
      token = '';
      expires = 0;
    }
    if (r.status === 409)
      fail(
        409,
        'EMAIL_EXISTS',
        'This email is already associated with an identity account. Use a different email or contact your administrator.',
      );
    if (!r.ok && r.status !== 404)
      fail(
        503,
        'IDENTITY_UNAVAILABLE',
        'Account service could not complete this action. Retry shortly.',
      );
    return r;
  } catch (e) {
    if (e && typeof e === 'object' && 'getStatus' in e) throw e;
    fail(
      503,
      'IDENTITY_UNAVAILABLE',
      'Account service could not be reached. Your saved changes can be retried.',
    );
    throw e;
  }
}
export async function syncIdentity(account: any) {
  let id = account.identity_id;
  if (id.startsWith('pending:')) {
    const matches = (await (
      await identity('/users?exact=true&username=' + encodeURIComponent(account.email))
    ).json()) as any[];
    if (matches.length) {
      const match = matches[0];
      if (
        match.attributes?.rare_user_id?.[0] !== account.id ||
        match.attributes?.rare_tenant_id?.[0] !== account.tenant_id
      )
        fail(
          409,
          'EMAIL_EXISTS',
          'This email belongs to an existing identity account. Edit the pending user with a different email.',
        );
      id = match.id;
    } else {
      const result = await identity('/users', 'POST', {
        username: account.email,
        email: account.email,
        enabled: account.active,
        emailVerified: false,
        firstName: account.name.split(' ')[0],
        lastName: account.name.split(' ').slice(1).join(' '),
        requiredActions: ['VERIFY_EMAIL', 'UPDATE_PASSWORD'],
        attributes: { rare_user_id: [account.id], rare_tenant_id: [account.tenant_id] },
      });
      id = result.headers.get('location')?.split('/').pop();
      if (!id) throw Error('Missing identity location');
    }
  }
  const current = await identity('/users/' + encodeURIComponent(id));
  if (current.status === 404)
    fail(
      409,
      'IDENTITY_MISSING',
      'Identity account is missing. Contact the system administrator to restore it.',
    );
  // Membership activation and display names are company-local; never disable a shared login here.

  return id as string;
}
export async function sendActionEmail(id: string, invite: boolean, existing = false) {
  if (env.EMAIL_ENABLED !== 'true')
    fail(
      409,
      'EMAIL_NOT_CONFIGURED',
      'Email delivery is not configured. Ask the system administrator to configure SMTP.',
    );
  const qs = new URLSearchParams({
    client_id: 'rare-os-web',
    redirect_uri: env.APP_URL + '/api/auth/login',
    lifespan: '3600',
  });
  const response = await identity(
    '/users/' + encodeURIComponent(id) + '/execute-actions-email?' + qs,
    'PUT',
    invite
      ? existing
        ? ['VERIFY_EMAIL']
        : ['VERIFY_EMAIL', 'UPDATE_PASSWORD']
      : ['RARE_RESET_PASSWORD'],
  );
  if (response.status === 404)
    fail(409, 'IDENTITY_MISSING', 'Identity account is missing. Contact your administrator.');
}
