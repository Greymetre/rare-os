import { useEffect, useState } from 'react';
export function Security() {
  const [status, setStatus] = useState<any>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    fetch('/api/security')
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw Error(d.error?.message || 'Could not load security settings.');
        return d;
      })
      .then((d) => {
        if (live) setStatus(d);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, []);
  return (
    <section className="panel company-form">
      <h2>Account security</h2>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {!status && !error && <p role="status">Checking security settings…</p>}
      {status && (
        <>
          <p>
            Authenticator app: <strong>{status.mfaEnabled ? 'Enabled' : 'Not configured'}</strong>
          </p>
          <p>
            Use an authenticator app to protect your login with a one-time code. Keycloak handles
            setup and verifies your password and code.
          </p>
          <a className="button primary" href={status.setupUrl}>
            {status.mfaEnabled ? 'Manage authenticator' : 'Set up authenticator'}
          </a>
          <p>
            After setup, save recovery codes somewhere private so you can sign in if your phone is
            unavailable.
          </p>
          {status.mfaEnabled && (
            <a className="button" href={status.recoveryUrl}>
              Generate recovery codes
            </a>
          )}
          <p className="small">
            Sessions expire after 30 minutes of inactivity or {status.sessionHours} hours from
            sign-in. Signing out through the identity service also revokes the linked app session.
          </p>
          <p className="notice">
            Local enrollment is voluntary. Before production, all administrators must enroll and the
            deployment must enforce MFA. Never share your authenticator secret or recovery codes.
          </p>
        </>
      )}
    </section>
  );
}
