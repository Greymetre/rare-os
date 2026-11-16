// RCH-0 Reach: the field masters every later Reach screen reads, their readiness checklist, and
// the photo a field rep carries.
//
// The masters themselves are drawn by the shared MasterTable and loaded by the shared import
// screens, exactly as Availability's planning masters are: a record behaves the same wherever it
// is maintained. What is particular to Reach is here — the checklist, and the photo.
import { useEffect, useState } from 'react';
import { MasterTable } from './master-table';
import type { KindInfo } from './master-table';
import { FileImport, Imports, statusLabel } from './imports';
import { Modal } from './modal';
import { useApi } from './api-client';
import { Approvals, BeatRound, CustomerRegister, ReachSetup } from './reach-customers';

// The order the masters are set up in: a rep needs a grade and a territory to exist first, and a
// beat needs a territory. The customer's own shape is a separate concern, under Setup.
const FIELD_MASTERS = [
  'territories',
  'rep_grades',
  'field_reps',
  'leave_types',
  'holidays',
  'beats',
  'beat_assignments',
];
const CUSTOMER_SETUP = ['customer_types', 'customer_form_fields', 'customer_form_rules'];
const MASTER_ORDER = [...FIELD_MASTERS, ...CUSTOMER_SETUP];
// What a phone sends after the browser has scaled the photo down. A selfie does not need to be
// bigger than this, and a rep on a field connection should not have to upload more.
const PHOTO_MAX_SIDE = 1600;
const PHOTO_QUALITY = 0.82;

function Readiness({ csrf, refreshKey }: { csrf: string; refreshKey: number }) {
  const call = useApi(csrf);
  const [items, setItems] = useState<any[] | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setError('');
    call('reach/readiness')
      .then((d) => live && setItems(d.items))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [refreshKey]);
  if (error)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!items) return <p role="status">Checking field data…</p>;
  const ready = items.filter((i) => i.status === 'ready').length;
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Field data readiness</h2>
        <span className="badge">
          {ready} / {items.length} ready
        </span>
      </div>
      {items.map((i) => (
        <div className="check-row readiness-row" key={i.key} data-status={i.status}>
          <span className={'status-pill ' + i.status}>{statusLabel[i.status]}</span>
          <div>
            <strong>{i.title}</strong>
            <p>{i.detail}</p>
          </div>
        </div>
      ))}
    </section>
  );
}

// Scales the photo down in the browser before it is sent. A 12-megapixel phone photo is several
// megabytes; this makes it a few hundred kilobytes, which is what a field connection can manage.
// Anything the browser cannot decode as an image (a PDF, say) is sent through untouched.
async function scaleDown(file: File) {
  if (!file.type.startsWith('image/') || typeof createImageBitmap !== 'function')
    return { blob: file as Blob, type: file.type };
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return { blob: file as Blob, type: file.type };
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', PHOTO_QUALITY),
    );
    return blob ? { blob, type: 'image/jpeg' } : { blob: file as Blob, type: file.type };
  } catch {
    return { blob: file as Blob, type: file.type };
  }
}

// The photo of one field rep: what is there now, a new one, or none.
function RepPhoto({
  csrf,
  rep,
  canManage,
  canRead,
  onChanged,
}: {
  csrf: string;
  rep: any;
  canManage: boolean;
  canRead: boolean;
  onChanged: () => void;
}) {
  const call = useApi(csrf);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  async function upload(file: File) {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const { blob, type } = await scaleDown(file);
      const r = await fetch(
        `/api/files?purpose=selfie&name=${encodeURIComponent(file.name.slice(0, 200))}`,
        {
          method: 'POST',
          headers: { 'Content-Type': type, 'X-CSRF-Token': csrf },
          body: blob,
        },
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw Error(d.error?.message || 'The photo could not be uploaded. Please retry.');
      const saved = await call(`reach/field-reps/${rep.id}/photo`, 'PUT', { fileId: d.id });
      setNotice(saved.message);
      onChanged();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function clear() {
    setError('');
    setBusy(true);
    call(`reach/field-reps/${rep.id}/photo`, 'DELETE')
      .then((d) => {
        setNotice(d.message);
        onChanged();
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }
  return (
    <>
      <button
        className="text-button"
        aria-label={`Photo of field rep ${rep.code}`}
        onClick={() => {
          setError('');
          setNotice('');
          setOpen(true);
        }}
      >
        {rep.photo_file_id ? 'Photo' : 'Add photo'}
      </button>
      {open && (
        <Modal title={`Photo of ${rep.name}`} onClose={() => setOpen(false)}>
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
          {rep.photo_file_id && canRead ? (
            <img
              className="rep-photo"
              src={`/api/files/${rep.photo_file_id}`}
              alt={`Field rep ${rep.code}`}
            />
          ) : (
            <p>
              {rep.photo_file_id
                ? 'There is a photo, but you do not have permission to view it.'
                : 'No photo yet.'}
            </p>
          )}
          {canManage && (
            <label>
              Choose a photo
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void upload(file);
                }}
              />
              <small>
                The photo is scaled down to {PHOTO_MAX_SIDE} pixels in your browser before it is
                sent.
              </small>
            </label>
          )}
          <div className="modal-actions">
            <button className="button" disabled={busy} onClick={() => setOpen(false)}>
              Close
            </button>
            {canManage && rep.photo_file_id && (
              <button className="button destructive" disabled={busy} onClick={() => clear()}>
                Remove photo
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

// The module's own menu, drawn by the shell in the sidebar. Pure, and gated by the permission each
// screen needs, so the menu never offers what a person cannot open.
export function reachMenu(permissions: string[], kinds: KindInfo[]) {
  const has = (p: string) => permissions.includes(p);
  const labelsOf = (order: string[]) =>
    order
      .map((kind) => kinds.find((x) => x.kind === kind)?.label ?? '')
      .filter(Boolean)
      .map((label) => [label, 'reach.read'] as [string, string]);
  // The register, the rounds and the decisions: the screens the field organisation works in.
  const CUSTOMERS: [string, string][] = [
    ['Customer register', 'reach.read'],
    ['Beat round', 'reach.read'],
    ['Approvals', 'reach.approve'],
  ];
  const FIELD: [string, string][] = [
    ['Readiness', 'reach.read'],
    ...labelsOf(FIELD_MASTERS),
    ['Imports', 'reach.read'],
    ['File import', 'reach.read'],
  ];
  // What a customer is: its types, its questions, and the distances every tag is measured against.
  const SETUP: [string, string][] = [...labelsOf(CUSTOMER_SETUP), ['Reach settings', 'reach.read']];
  const allowed = (list: [string, string][]) => list.filter(([, p]) => has(p)).map(([t]) => t);
  const groups: [string, string, string[]][] = [
    ['Customers', 'the register, the rounds and the decisions', allowed(CUSTOMERS)],
    ['Field setup', 'the masters every Reach screen reads', allowed(FIELD)],
    ['Customer setup', 'the shape of a customer', allowed(SETUP)],
  ];
  return { groups: groups.filter(([, , list]) => list.length) };
}

// Mirrors Availability: when the shell passes onNav the screens live in the sidebar, and this
// component reports its menu upwards. On its own it draws its own tab strip, which is what the
// tests use.
export function Reach({
  csrf,
  permissions,
  refreshKey,
  tab: tabProp,
  onTab,
  onNav,
}: {
  csrf: string;
  permissions: string[];
  refreshKey: number;
  tab?: string;
  onTab?: (tab: string) => void;
  onNav?: (groups: [string, string, string[]][]) => void;
}) {
  const call = useApi(csrf);
  const [kinds, setKinds] = useState<KindInfo[] | null>(null),
    [error, setError] = useState(''),
    [ownTab, setOwnTab] = useState('Readiness'),
    [revision, setRevision] = useState(0);
  const tab = tabProp ?? ownTab;
  const setTab = onTab ?? setOwnTab;
  useEffect(() => {
    let live = true;
    call('masters')
      .then((d) => live && setKinds(d.kinds.filter((k: KindInfo) => k.module === 'Reach')))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [refreshKey]);
  const { groups } = reachMenu(permissions, kinds ?? []);
  const menuKey = JSON.stringify(groups);
  useEffect(() => {
    if (kinds) onNav?.(JSON.parse(menuKey));
  }, [menuKey, kinds, onNav]);
  if (error)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!kinds) return <p role="status">Loading Reach…</p>;
  if (!groups.some(([, , list]) => list.length))
    return (
      <section className="panel availability">
        <span className="badge">SETUP IN PROGRESS</span>
        <h2>Reach will appear here.</h2>
        <p>
          Ask your company administrator for Reach access to view the field masters and the
          readiness checklist.
        </p>
      </section>
    );
  const current = kinds.find((k) => k.label === tab);
  const currentGroup = groups.find(([, , list]) => list.includes(tab)) ?? groups[0];
  return (
    <>
      {/* In the shell the screens live in the sidebar; here the group being worked in is named,
          with its own screens as chips. On its own, the groups are drawn as sub-tabs. */}
      {onNav ? (
        currentGroup && (
          <nav className="engine-bar" aria-label={`${currentGroup[0]} screens`}>
            <div className="engine-name">
              <span>Reach</span>
              <strong>{currentGroup[0]}</strong>
              <small>{currentGroup[1]}</small>
            </div>
            <div className="engine-chips">
              {currentGroup[2].map((t) => (
                <button
                  key={t}
                  aria-current={tab === t ? 'page' : undefined}
                  className={tab === t ? 'selected' : ''}
                  onClick={() => setTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </nav>
        )
      ) : (
        <nav className="module-nav" aria-label="Reach sections">
          {groups.map(([group, engine, list]) => (
            <div key={group} className="subtabs">
              <span className="subtabs-label">
                {group}
                <small>{engine}</small>
              </span>
              {list.map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  className={tab === t ? 'selected' : ''}
                  onClick={() => setTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          ))}
        </nav>
      )}
      {tab === 'Readiness' && <Readiness csrf={csrf} refreshKey={refreshKey + revision} />}
      {tab === 'Customer register' && (
        <CustomerRegister
          csrf={csrf}
          permissions={permissions}
          refreshKey={refreshKey + revision}
        />
      )}
      {tab === 'Beat round' && (
        <BeatRound csrf={csrf} permissions={permissions} refreshKey={refreshKey + revision} />
      )}
      {tab === 'Approvals' && <Approvals csrf={csrf} refreshKey={refreshKey + revision} />}
      {tab === 'Reach settings' && (
        <ReachSetup csrf={csrf} permissions={permissions} refreshKey={refreshKey + revision} />
      )}
      {current && (
        <MasterTable
          key={current.kind}
          csrf={csrf}
          info={current}
          refreshKey={refreshKey + revision}
          rowActions={
            current.kind === 'field_reps'
              ? (row) => (
                  <RepPhoto
                    csrf={csrf}
                    rep={row}
                    canManage={current.canManage}
                    canRead={permissions.includes('files.read')}
                    onChanged={() => setRevision((x) => x + 1)}
                  />
                )
              : undefined
          }
        />
      )}
      {tab === 'Imports' && (
        <Imports
          csrf={csrf}
          permissions={permissions}
          refreshKey={refreshKey}
          kinds={kinds}
          module="Reach"
        />
      )}
      {tab === 'File import' && (
        <FileImport
          csrf={csrf}
          permissions={permissions}
          refreshKey={refreshKey}
          kinds={kinds}
          module="Reach"
        />
      )}
    </>
  );
}
