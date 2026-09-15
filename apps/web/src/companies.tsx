import { useEffect, useState } from 'react';
export type Membership = { tenant_id: string; company: string; code: string };
export function CompanyHub({
  csrf,
  platformAdmin,
  memberships,
  onClose,
  onLogout,
}: {
  csrf: string;
  platformAdmin: boolean;
  memberships: Membership[];
  onClose?: () => void;
  onLogout: () => void;
}) {
  const [rows, setRows] = useState<any[]>([]),
    [after, setAfter] = useState<string | null>(null),
    [next, setNext] = useState<string | null>(null),
    [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [form, setForm] = useState<any>(null),
    [admin, setAdmin] = useState<any>(null),
    [correctedEmail, setCorrectedEmail] = useState('');
  async function call(path: string, method = 'GET', data?: unknown) {
    const r = await fetch('/api/' + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const d = await r.json();
    if (!r.ok) throw Error(d.error?.message || 'Could not complete action. Retry.');
    return d;
  }
  useEffect(() => {
    if (!platformAdmin) return;
    let cancelled = false;
    setBusy(true);
    setError('');
    call(
      'platform/companies?limit=25&q=' +
        encodeURIComponent(search) +
        (after ? '&after=' + after : ''),
    )
      .then((d) => {
        if (!cancelled) {
          setRows(d.items);
          setNext(d.nextCursor);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [platformAdmin, after, search, revision]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="content company-hub">
      <div className="page-heading">
        <div>
          <span className="eyebrow">
            RARE OS / {platformAdmin ? 'PLATFORM ADMIN' : 'WORKSPACES'}
          </span>
          <h1>{platformAdmin ? 'Company management' : 'Select your company'}</h1>
          <p>Each company has its own users, roles and business data.</p>
        </div>
        <div>
          {onClose && (
            <button className="button" onClick={onClose}>
              Back to workspace
            </button>
          )}{' '}
          <button className="button" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      {busy && <p role="status">Please wait…</p>}
      <section className="panel">
        <div className="panel-heading">
          <h2>Your companies</h2>
        </div>
        <div className="company-options">
          {memberships.length ? (
            memberships.map((m) => (
              <button
                key={m.tenant_id}
                className="button"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await call('session/company', 'POST', { companyId: m.tenant_id });
                    location.href = '/';
                  })
                }
              >
                {m.company} ({m.code})
              </button>
            ))
          ) : (
            <p>
              No active company membership. Contact your administrator, or sign in again after
              access changes.
            </p>
          )}
        </div>
      </section>
      {platformAdmin && (
        <>
          <div className="table-footer">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setAfter(null);
                setSearch(query);
              }}
            >
              <input
                aria-label="Company name search"
                placeholder="Company name starts with…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />{' '}
              <button className="button" disabled={busy}>
                Search
              </button>
            </form>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => {
                setAdmin(null);
                setForm({
                  requestId: crypto.randomUUID(),
                  name: '',
                  code: '',
                  contactEmail: '',
                  adminName: '',
                  adminEmail: '',
                });
              }}
            >
              Create company
            </button>
          </div>
          {form && (
            <section className="panel company-form">
              <h2>{form.id ? 'Edit company' : 'New company'}</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void action(async () => {
                    const d = await call(
                      'platform/companies' + (form.id ? '/' + form.id : ''),
                      form.id ? 'PATCH' : 'POST',
                      form.id
                        ? {
                            name: form.name,
                            contactEmail: form.contactEmail,
                            active: form.active,
                            version: form.version,
                          }
                        : form,
                    );
                    if (d.emailFailed) setError(d.message);
                    else setNotice(d.message);
                    setForm(null);
                    setRevision((x) => x + 1);
                  });
                }}
              >
                {(form.id
                  ? ['name', 'contactEmail']
                  : ['name', 'code', 'contactEmail', 'adminName', 'adminEmail']
                ).map((key) => (
                  <label key={key}>
                    {
                      (
                        {
                          name: 'Company name',
                          code: 'Company code',
                          contactEmail: 'Contact email',
                          adminName: 'Admin full name',
                          adminEmail: 'Admin email',
                        } as any
                      )[key]
                    }
                    <input
                      required
                      maxLength={key.includes('mail') ? 254 : key === 'code' ? 30 : 120}
                      type={key.includes('mail') ? 'email' : 'text'}
                      value={form[key]}
                      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                    />
                  </label>
                ))}
                <p>
                  Contact email is for company communication. Invitations go to the separate Admin
                  email shown in Admin setup.
                </p>
                {form.id && (
                  <label>
                    Status
                    <select
                      value={String(form.active)}
                      onChange={(e) => setForm({ ...form, active: e.target.value === 'true' })}
                    >
                      <option value="true">Active</option>
                      <option value="false">Inactive — block company access</option>
                    </select>
                  </label>
                )}
                {!form.id && (
                  <p>
                    An existing admin email adds this company to the same login. The existing
                    password stays unchanged. After signing in again, the user selects a company;
                    roles and plant access are separate. A duplicate email within the same company
                    is not allowed.
                  </p>
                )}
                <button className="button primary" disabled={busy}>
                  Save company
                </button>{' '}
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => setForm(null)}
                >
                  Cancel
                </button>
              </form>
            </section>
          )}
          <section className="panel table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Code</th>
                  <th>Contact</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td>{r.code}</td>
                    <td>{r.contact_email}</td>
                    <td>{r.active ? 'Active' : 'Inactive'}</td>
                    <td>
                      <button
                        className="text-button"
                        disabled={busy || !r.active}
                        aria-label={'Open company ' + r.name}
                        onClick={() =>
                          void action(async () => {
                            await call('platform/companies/' + r.id + '/open', 'POST', {});
                            location.href = '/';
                          })
                        }
                      >
                        Open company
                      </button>
                      <button
                        className="text-button"
                        disabled={busy}
                        aria-label={'Edit company ' + r.name}
                        onClick={() => {
                          setAdmin(null);
                          setForm({ ...r, contactEmail: r.contact_email });
                        }}
                      >
                        Edit
                      </button>{' '}
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            setForm(null);
                            setCorrectedEmail('');
                            setAdmin({
                              ...(await call('platform/companies/' + r.id + '/onboarding')),
                              companyId: r.id,
                              company: r.name,
                            });
                          })
                        }
                      >
                        Admin setup
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && !busy && <div className="empty">No companies found.</div>}
            <div className="table-footer">
              <button className="button" disabled={busy || !after} onClick={() => setAfter(null)}>
                First page
              </button>
              <button className="button" disabled={busy || !next} onClick={() => setAfter(next)}>
                Next page
              </button>
            </div>
          </section>
          {admin && (
            <section className="panel company-form">
              <h2>Admin setup: {admin.company}</h2>
              <p>
                {admin.name} — Invitation recipient: <strong>{admin.email}</strong>
              </p>
              <p>
                Editing the company Contact email does not change this login or invitation
                recipient.
              </p>
              {admin.delivery?.action === 'company.admin_invitation_failed' && (
                <div className="error" role="alert">
                  Last invitation failed for {admin.delivery.details.recipient}.{' '}
                  {admin.delivery.details.reason ||
                    'Check SMTP configuration, then retry after one minute.'}
                </div>
              )}
              {admin.delivery?.action === 'company.admin_invited' && (
                <p>
                  Last email:{' '}
                  {admin.delivery.details.status === 'captured'
                    ? 'Captured in local inbox'
                    : 'Accepted by SMTP; inbox delivery is not confirmed'}{' '}
                  — {admin.delivery.details.recipient}
                </p>
              )}
              {admin.sharedLogin && (
                <div className="notice" role="status">
                  Existing account — use your existing password. This company has its own role and
                  plant access. Sign out and sign in again to select the newly added company. A
                  password reset changes this login for every company.
                </div>
              )}
              {!admin.first_login_at && !admin.sharedLogin && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void action(async () => {
                      const d = await call(
                        'platform/companies/' + admin.companyId + '/admin-email',
                        'PATCH',
                        { email: correctedEmail, version: admin.version },
                      );
                      setNotice(d.message);
                      setCorrectedEmail('');
                      setAdmin({
                        ...admin,
                        ...(await call('platform/companies/' + admin.companyId + '/onboarding')),
                      });
                    });
                  }}
                >
                  <label>
                    Correct admin email
                    <input
                      type="email"
                      required
                      maxLength={254}
                      value={correctedEmail}
                      onChange={(e) => setCorrectedEmail(e.target.value)}
                      placeholder="Correct recipient email"
                    />
                  </label>
                  <p>
                    For an unused login only. If email verification or password setup is already
                    complete, create the intended admin from Users. Saving does not send email; send
                    the invitation after checking the recipient.
                  </p>
                  <button className="button" disabled={busy || !correctedEmail}>
                    Save corrected email
                  </button>
                </form>
              )}
              <p>
                Account:{' '}
                {admin.first_login_at && admin.sync_state === 'ready'
                  ? 'Onboarding complete'
                  : admin.sync_state}
                . {admin.sync_error}
              </p>
              <p>
                {admin.invitation_sent_at
                  ? 'Last invitation: ' + new Date(admin.invitation_sent_at).toLocaleString()
                  : 'Invitation not sent yet.'}
              </p>
              {admin.first_login_at && (
                <p>First login completed: {new Date(admin.first_login_at).toLocaleString()}</p>
              )}
              {(admin.first_login_at
                ? admin.sync_state !== 'ready'
                  ? ['retry']
                  : []
                : ['retry', 'invite']
              ).map((kind) => (
                <button
                  key={kind}
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const d = await call(
                        'platform/companies/' + admin.companyId + '/' + kind,
                        'POST',
                        {},
                      );
                      if (d.emailFailed) setError(d.message);
                      else setNotice(d.message);
                      setAdmin({
                        ...admin,
                        ...(await call('platform/companies/' + admin.companyId + '/onboarding')),
                      });
                    })
                  }
                >
                  {kind === 'retry' ? 'Retry account setup' : 'Send invitation'}
                </button>
              ))}
            </section>
          )}
          {location.hostname === 'localhost' && (
            <p>
              Local invitation testing:{' '}
              <a href="http://localhost:4312" target="_blank" rel="noreferrer">
                Open local inbox
              </a>
              . Production requires configured SMTP.
            </p>
          )}
        </>
      )}
    </main>
  );
}
