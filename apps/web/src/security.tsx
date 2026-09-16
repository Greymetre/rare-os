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
            Manage the authenticators that protect your login. These settings apply across all your
            companies.
          </p>
          {status.mfaRequired && (
            <p className="info">
              MFA is required for your administrator access, including admin access in another
              company. Keep at least one authenticator. You can add or replace devices, but cannot
              turn MFA off.
            </p>
          )}
          <a className="button primary" href={status.setupUrl}>
            {status.mfaEnabled ? 'Add authenticator' : 'Set up authenticator'}
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
          {status.mfaEnabled && (
            <>
              <h3>Your authenticators</h3>
              <ul className="mfa-device-list">
                {status.devices.map((d: any) => (
                  <li key={d.id}>
                    <strong>{d.name}</strong>
                    <span>Authenticator app</span>
                  </li>
                ))}
              </ul>
              <div className="mfa-actions">
                <a className="button" href={status.manageUrl}>
                  Remove a device
                </a>
                {!status.mfaRequired && (
                  <a className="button danger" href={status.disableUrl}>
                    Turn off MFA
                  </a>
                )}
              </div>
              <p>
                Adding a device keeps existing devices active. Removing a device disables only that
                entry.{' '}
                {status.mfaRequired
                  ? 'Administrator MFA must remain enabled.'
                  : 'Turning off MFA removes all authenticators and recovery codes after confirmation.'}
              </p>
              <p>You will verify your sign-in again before changing security settings.</p>
            </>
          )}
        </>
      )}
    </section>
  );
}
