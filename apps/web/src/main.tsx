import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { CompanyHub, type Membership } from './companies';
import { Security } from './security';
import { Plants } from './plants';
import { AccessManagement } from './access';
import { isLocalHost } from './environment';
import { Availability } from './availability';
type User = { name: string; email: string; company: string; role: string; permissions: string[] };
type Permission = { code: string; module: string; description: string };
type Overview = {
  sites: { id: string; name: string; code: string }[];
  permissions: Permission[];
  workerReady: boolean;
  setup: { title: string; done: boolean; detail: string }[];
};
type Row = {
  id: string;
  actor_name?: string;
  details?: unknown;
  name?: string;
  email?: string;
  role?: string;
  active?: boolean;
  permission_count?: number;
  action?: string;
  entity_type?: string;
  created_at?: string;
};
class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch('/api/' + path, init);
  } catch {
    throw new ApiError('Could not connect. Check your connection and retry.', 0);
  }
  const json = await r.json().catch(() => ({}));
  if (!r.ok)
    throw new ApiError(
      json.error?.message ||
        ([502, 503, 504].includes(r.status)
          ? 'The server is temporarily unavailable. Wait a few seconds, then retry the connection.'
          : 'Could not complete this request. Please retry.'),
      r.status,
    );
  return json as T;
}
function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">R</span>
      <span>
        RARE <b>OS</b>
        <small>by Greymetre</small>
      </span>
    </div>
  );
}
function App() {
  const [openingLogin, setOpeningLogin] = useState(false);
  useEffect(() => {
    const reset = () => setOpeningLogin(false);
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);
  const [companyContext, setCompanyContext] = useState<{
    memberships: Membership[];
    platformAdmin: boolean;
  } | null>(null);
  const [showCompanies, setShowCompanies] = useState(false);
  const [user, setUser] = useState<User | null>(null),
    [csrf, setCsrf] = useState(''),
    [boot, setBoot] = useState(true),
    [bootError, setBootError] = useState('');
  const [page, setPage] = useState('Overview'),
    [overview, setOverview] = useState<Overview | null>(null),
    [rows, setRows] = useState<Row[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [filter, setFilter] = useState('');
  const [requestVersion, setRequestVersion] = useState(0);
  const authError = new URLSearchParams(location.search).get('authError');
  async function loadUser() {
    setBoot(true);
    setBootError('');
    try {
      const d = await api<{
        user: User;
        csrfToken: string;
        memberships: Membership[];
        platformAdmin: boolean;
      }>('me');
      setCompanyContext({ memberships: d.memberships, platformAdmin: d.platformAdmin });
      setUser(d.user);
      setCsrf(d.csrfToken);
    } catch (e) {
      setUser(null);
      setCompanyContext(null);
      setCsrf('');
      if (e instanceof ApiError && e.status !== 401) setBootError(e.message);
    } finally {
      setBoot(false);
    }
  }
  useEffect(() => {
    void loadUser();
  }, []);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setBusy(true);
    setError('');
    setRows([]);
    setCursor(null);
    setFilter('');
    const path = page === 'Audit log' ? 'audit' : null;
    Promise.all([
      api<Overview>('dashboard'),
      path ? api<{ items: Row[]; nextCursor?: string }>(path) : Promise.resolve(null),
    ])
      .then(([d, list]) => {
        if (cancelled) return;
        setOverview(d);
        setRows(list?.items || []);
        setCursor(list?.nextCursor || null);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) {
          setUser(null);
          setCompanyContext(null);
          setCsrf('');
          setNotice(e.message);
        } else setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.email, page, requestVersion]);
  async function next() {
    if (!cursor) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ items: Row[]; nextCursor: string | null }>(
        (page === 'Audit log' ? 'audit?cursor=' : 'users?after=') + encodeURIComponent(cursor),
      );
      setRows(result.items);
      setCursor(result.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    try {
      const d = await api<{ message: string }>('auth/logout', {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrf },
      });
      setUser(null);
      setCompanyContext(null);
      setOverview(null);
      setNotice(d.message);
      history.replaceState(null, '', '/');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (boot)
    return (
      <div className="boot">
        <Brand />
        <p role="status">Connecting to your workspace…</p>
      </div>
    );
  if (companyContext && (showCompanies || !user))
    return (
      <CompanyHub
        csrf={csrf}
        {...companyContext}
        onClose={user ? () => setShowCompanies(false) : undefined}
        onLogout={() => void logout()}
      />
    );
  if (!user)
    return (
      <div className="login-page">
        <section className="login-story">
          <Brand />
          <div>
            <span className="eyebrow">YOUR OPERATIONS, CONNECTED</span>
            <h1>
              Clarity for every
              <br />
              working day.
            </h1>
            <p>Bring people, materials and production together in one workspace.</p>
            <div className="lever-list">
              <span>Range</span>
              <span className="active">Availability</span>
              <span>Reach</span>
              <span>Engagement</span>
            </div>
          </div>
          <small>RARE OS · Operations workspace</small>
        </section>
        <main className="login-panel">
          <div className={'login-card' + (openingLogin ? ' login-opening' : '')}>
            <span className="eyebrow">LET’S GET TO WORK</span>
            <h2>Welcome to RARE OS</h2>
            <p>Sign in with your company account to access your workspace.</p>
            {notice && (
              <div className="notice" role="status">
                {notice}
              </div>
            )}
            {authError && (
              <div className="error" role="alert">
                {authError === 'mfa'
                  ? 'Administrator access requires MFA. Sign in again to set up an authenticator or verify your code.'
                  : authError === 'access'
                    ? 'This account has no active workspace membership. If your admin email was corrected, use the latest invitation sent to the corrected email. You can sign in with another account below.'
                    : authError === 'expired'
                      ? 'Your sign-in link expired. Please start again.'
                      : 'Sign-in could not complete. Please retry or contact your administrator.'}
              </div>
            )}
            {bootError && (
              <div className="error" role="alert">
                {bootError}
                <button className="text-button" onClick={() => void loadUser()}>
                  Retry connection
                </button>
              </div>
            )}
            <a
              className="button primary full"
              href={
                authError === 'access' ? '/api/auth/login?switchAccount=true' : '/api/auth/login'
              }
              aria-disabled={openingLogin}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                if (openingLogin) return;
                setOpeningLogin(true);
                const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches
                  ? 0
                  : 180;
                window.setTimeout(
                  () =>
                    location.assign(
                      authError === 'access'
                        ? '/api/auth/login?switchAccount=true'
                        : '/api/auth/login',
                    ),
                  delay,
                );
              }}
            >
              {authError === 'access' ? 'Sign in with another account' : 'Sign in securely'}{' '}
              <span>→</span>
            </a>
            <div className="security-note">
              <span>◈</span> Protected with company access controls.
              <br />
              Your password is handled by the identity service.
            </div>
            <hr />
            <p className="small">
              Need access or a password reset?
              <br />
              Contact your company administrator. Use Forgot password on the sign-in screen to
              request a reset link.
            </p>
          </div>
        </main>
      </div>
    );
  const nav = [
    ['Overview', '◫', 'dashboard.read'],
    ['Security', '◈', 'dashboard.read'],
    ['Plants', '▦', 'sites.read'],
    ['Users', '♙', 'users.read'],
    ['Roles & permissions', '◇', 'roles.read'],
    ['Availability', '▤', 'masters.read|planning.read'],
    ['Audit log', '≡', 'audit.read'],
  ];
  return (
    <div className="shell">
      <aside>
        <Brand />
        <div className="workspace-label">WORKSPACE</div>
        <nav>
          {nav
            .filter((x) => x[2].split('|').some((p) => user.permissions.includes(p)))
            .map(([label, icon]) => (
              <button
                key={label}
                className={page === label ? 'selected' : ''}
                onClick={() => setPage(label)}
              >
                <span aria-hidden="true">{icon}</span>
                {label}
              </button>
            ))}
        </nav>
        <div className="phase-card">
          <span className="dot" /> FOUNDATION PHASE
          <p>
            Access ready.
            <br />
            Availability in setup.
          </p>
          {isLocalHost(window.location.hostname) && <small>Local development workspace</small>}
        </div>
        <div className="sidebar-footer">One dataset. Connected decisions.</div>
      </aside>
      <div className="main">
        <header>
          <div>
            <span className="workspace-name">{user.company}</span>
            {isLocalHost(window.location.hostname) && <span className="environment">LOCAL</span>}
            <button className="text-button" onClick={() => setShowCompanies(true)}>
              {companyContext?.platformAdmin ? 'Companies' : 'Switch company'}
            </button>
          </div>
          <div className="user-menu">
            <span className="avatar">
              {user.name
                .split(' ')
                .map((x) => x[0])
                .slice(0, 2)
                .join('')}
            </span>
            <div>
              <strong>{user.name}</strong>
              <small>{user.role}</small>
            </div>
            <button className="text-button" onClick={() => void logout()} disabled={busy}>
              Sign out
            </button>
          </div>
        </header>
        <main className="content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">WORKSPACE / {page.toUpperCase()}</span>
              <h1>{page === 'Overview' ? 'Your operations start here.' : page}</h1>
              <p>
                {page === 'Overview'
                  ? 'Your secure foundation is ready. Set up your plant before you begin planning.'
                  : page === 'Plants'
                    ? 'Manage plants and company-specific access.'
                    : page === 'Users'
                      ? 'People with access to this company workspace.'
                      : page === 'Roles & permissions'
                        ? 'Every action starts with the right access.'
                        : page === 'Audit log'
                          ? 'A traceable record of activity in your company.'
                          : page === 'Security'
                            ? 'Manage your sign-in protection and authenticator devices.'
                            : 'Build a dependable plan from your plant’s actual data.'}
              </p>
            </div>
            <button
              className="button"
              onClick={() => setRequestVersion((v) => v + 1)}
              disabled={busy}
            >
              ↻ Refresh
            </button>
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
              <button className="text-button" onClick={() => setRequestVersion((v) => v + 1)}>
                Retry
              </button>
            </div>
          )}
          {busy && (
            <div className="loading" role="status">
              Loading workspace data…
            </div>
          )}
          {!busy && !error && overview && (
            <>
              {page === 'Overview' && (
                <>
                  <div className="stats">
                    <div>
                      <span>YOUR ACCESS</span>
                      <strong>{user.role}</strong>
                      <small>Server-verified permissions</small>
                    </div>
                    <div>
                      <span>PERMISSIONS</span>
                      <strong>{overview.permissions.length}</strong>
                      <small>Assigned to your role</small>
                    </div>
                    <div>
                      <span>ASSIGNED SITES</span>
                      <strong>{overview.sites.length}</strong>
                      <small>
                        {overview.sites.length ? 'Ready for setup review' : 'Plant setup needed'}
                      </small>
                    </div>
                    <div>
                      <span>BACKGROUND SERVICE</span>
                      <strong className={overview.workerReady ? 'good' : 'warning'}>
                        {overview.workerReady ? 'Connected' : 'Unavailable'}
                      </strong>
                      <small>
                        {overview.workerReady
                          ? 'Foundation event worker'
                          : 'Contact your administrator'}
                      </small>
                    </div>
                  </div>
                  <div className="overview-grid">
                    <section className="panel">
                      <div className="panel-heading">
                        <h2>Workspace readiness</h2>
                        <span className="badge">
                          {overview.setup.filter((x) => x.done).length} / {overview.setup.length}{' '}
                          complete
                        </span>
                      </div>
                      <div className="checklist">
                        {overview.setup.map((x, i) => (
                          <div key={x.title} className="check-row">
                            <span className={'step ' + (x.done ? 'done' : '')}>
                              {x.done ? '✓' : i + 1}
                            </span>
                            <div>
                              <h3>{x.title}</h3>
                              <p>{x.detail}</p>
                            </div>
                            <span className={'status ' + (x.done ? 'ready' : '')}>
                              {x.done ? 'Ready' : 'Next'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </section>
                    <section className="panel next-panel">
                      <span className="eyebrow">NEXT MILESTONE</span>
                      <h2>
                        Know your plant.
                        <br />
                        Then plan your production.
                      </h2>
                      <p>
                        Availability needs your sites, products, BOM, routing, calendars and stock.
                      </p>
                      <button className="button primary" onClick={() => setPage('Availability')}>
                        View setup requirements →
                      </button>
                      <small>No sample production metrics are shown as real results.</small>
                    </section>
                  </div>
                </>
              )}
              {page === 'Security' && <Security />}
              {page === 'Plants' && (
                <Plants csrf={csrf} permissions={user.permissions} refreshKey={requestVersion} />
              )}
              {(page === 'Users' || page === 'Roles & permissions') && (
                <AccessManagement
                  key={page}
                  kind={page === 'Users' ? 'users' : 'roles'}
                  csrf={csrf}
                  permissions={user.permissions}
                  refreshKey={requestVersion}
                  onChanged={() => {
                    void api<{ user: User; csrfToken: string }>('me')
                      .then((d) => {
                        setUser(d.user);
                        setCsrf(d.csrfToken);
                      })
                      .catch(() => {
                        setUser(null);
                        setNotice('Your access changed. Please sign in again.');
                      });
                  }}
                />
              )}
              {page === 'Audit log' && (
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Recent activity</h2>
                    <span className="badge">Latest first</span>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Actor</th>
                          <th>Event</th>
                          <th>Entity</th>
                          <th>Time</th>
                          <th>Changes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((x) => (
                          <tr key={x.id}>
                            <td>{x.actor_name}</td>
                            <td>{x.action}</td>
                            <td>{x.entity_type}</td>
                            <td>{new Date(x.created_at!).toLocaleString()}</td>
                            <td>
                              <details>
                                <summary>View changes</summary>
                                <pre className="audit-details">
                                  {JSON.stringify(x.details, null, 2)}
                                </pre>
                              </details>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!rows.length && <div className="empty">No activity yet.</div>}
                  <div className="table-footer">
                    <span>{rows.length} records</span>
                    {cursor && (
                      <button className="button" onClick={() => void next()}>
                        Next page →
                      </button>
                    )}
                  </div>
                </section>
              )}
              {page === 'Availability' && (
                <Availability
                  csrf={csrf}
                  permissions={user.permissions}
                  refreshKey={requestVersion}
                />
              )}
            </>
          )}
          <footer>
            RARE OS <span>·</span> Range · Availability · Reach · Engagement
          </footer>
        </main>
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
