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
import {
  AttendanceSetup,
  Corrections,
  DayBoard,
  LeaveScreen,
  MyDay,
  Register,
} from './reach-attendance';
import { Adherence, MyPlan, PlanBoard, PlanChanges, TourSetup } from './reach-tour';
import { FieldApp, VisitBoard, VisitList, VisitSetup } from './reach-visit';
import { Customer360, KycQueue, OrderList, TakeOrder, TradeSetup } from './reach-trade';
import { ExpenseClaims, ExpenseRegister, ExpenseSetup, MyExpenses } from './reach-expense';
import { ReachAudit, ReachCutover, ReachOverview, ReachQueue } from './reach-overview';

// The order the masters are set up in: a rep needs a grade and a territory to exist first, and a
// beat needs a territory. The customer's own shape is a separate concern, under Setup.
const FIELD_MASTERS = [
  'territories',
  'rep_grades',
  'shifts',
  'work_types',
  'field_reps',
  'leave_types',
  'holidays',
  'beats',
  'beat_assignments',
];
const CUSTOMER_SETUP = [
  'customer_types',
  'customer_form_fields',
  'customer_form_rules',
  'visit_form_fields',
  'visit_form_rules',
  'kyc_types',
  'kyc_rules',
  'price_list_items',
  'trade_schemes',
  'expense_categories',
];
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
export async function scaleDown(file: File) {
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
  // RCH-7. Where a manager starts: what is happening, what is waiting, and whether the company
  // is ready to run on this at all.
  const OVERVIEW: [string, string][] = [
    ['Overview', 'reach.read'],
    ['Waiting for a decision', 'reach.read'],
    ['Going live', 'reach.read'],
    ['Reach audit trail', 'audit.read'],
  ];
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
  // What a rep does with their own day, and what a manager reads of everyone's. My day and the
  // register are a rep's own, so they need only the right to mark attendance.
  const ATTENDANCE: [string, string][] = [
    ['My day', 'reach.attend'],
    ['Today', 'reach.read'],
    ['Register', 'reach.attend'],
    ['Leave', 'reach.attend'],
    ['Corrections', 'reach.attend'],
  ];
  // The month a rep intends to walk and how it read afterwards. The plan and the adherence are a
  // rep's own, so they need only the right to build a plan; the board reads everybody's.
  const TOUR: [string, string][] = [
    ['My plan', 'reach.plan'],
    ['Plans', 'reach.read'],
    ['Day changes', 'reach.plan'],
    ['Plan vs actual', 'reach.plan'],
  ];
  // What a rep does in front of the shop, and what a manager reads of it afterwards. The field
  // app and the rep's own calls need only the right to visit; the board reads everybody's.
  const VISITS: [string, string][] = [
    ['Field app', 'reach.visit'],
    ['Visits', 'reach.visit'],
    ['Calls today', 'reach.read'],
  ];
  // The shop's whole trading picture, the order taken in front of it and the paperwork behind it.
  // Customer 360 is a manager's read; taking an order and banking money are the rep's own rights,
  // and checking paperwork is a separate desk again.
  const TRADE: [string, string][] = [
    ['Customer 360', 'reach.read'],
    ['Take order', 'reach.order'],
    ['Orders', 'reach.order'],
    ['Paperwork', 'reach.read'],
  ];
  // What a rep spent on the road. Making a claim is a rep's own right, like marking their own
  // day; passing one and paying it are two further rights, deliberately apart.
  const EXPENSES: [string, string][] = [
    ['My expenses', 'reach.expense'],
    ['Expense claims', 'reach.expense_approve'],
    ['Expense register', 'reach.read'],
  ];
  // What a customer is: its types, its questions, and the distances every tag is measured against.
  const SETUP: [string, string][] = [
    ...labelsOf(CUSTOMER_SETUP),
    ['Reach settings', 'reach.read'],
    ['Attendance settings', 'reach.read'],
    ['Tour plan settings', 'reach.read'],
    ['Visit settings', 'reach.read'],
    ['Customer 360 settings', 'reach.read'],
    ['Expense policy', 'reach.read'],
  ];
  const allowed = (list: [string, string][]) => list.filter(([, p]) => has(p)).map(([t]) => t);
  const groups: [string, string, string[]][] = [
    ['Overview', 'what is happening, and what is waiting for somebody', allowed(OVERVIEW)],
    ['Customers', 'the register, the rounds and the decisions', allowed(CUSTOMERS)],
    ['Attendance', 'the working day, leave and what it adds up to', allowed(ATTENDANCE)],
    ['Tour plan', 'the month ahead, and how the last one read', allowed(TOUR)],
    ['Field work', 'the round as it is walked, and the report at each door', allowed(VISITS)],
    ['Trade', 'what the shop owes, orders and pays', allowed(TRADE)],
    ['Expenses', 'what the road cost, and who signed for it', allowed(EXPENSES)],
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
    [ownTab, setOwnTab] = useState('Overview'),
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
  // The module opens on the readiness checklist, which needs reach.read. A rep who holds only
  // their own rights would land on a screen that answers 403 before they had touched anything,
  // so the module opens on the first screen their permissions actually unlock.
  const screens = groups.flatMap(([, , list]) => list);
  useEffect(() => {
    if (kinds && screens.length && !screens.includes(tab)) setTab(screens[0]);
  }, [menuKey, kinds, tab]);
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
      {tab === 'My day' && <MyDay csrf={csrf} refreshKey={refreshKey + revision} />}
      {tab === 'Today' && <DayBoard csrf={csrf} refreshKey={refreshKey + revision} />}
      {tab === 'Register' && (
        <Register csrf={csrf} permissions={permissions} refreshKey={refreshKey + revision} />
      )}
      {tab === 'Leave' && (
        <LeaveScreen csrf={csrf} permissions={permissions} refreshKey={refreshKey + revision} />
      )}
      {tab === 'Corrections' && (
        <Corrections csrf={csrf} permissions={permissions} refreshKey={refreshKey + revision} />
      )}
      {tab === 'Attendance settings' && (
        <AttendanceSetup csrf={csrf} permissions={permissions} refreshKey={refreshKey + revision} />
      )}
      {tab === 'My plan' && (
        <MyPlan csrf={csrf} permissions={permissions} refreshKey={refreshKey + revision} />
      )}
      {tab === 'Plans' && (
        <PlanBoard csrf={csrf} permissions={permissions} refreshKey={refreshKey + revision} />
      )}
      {tab === 'Day changes' && (
        <PlanChanges csrf={csrf} permissions={permissions} refreshKey={refreshKey + revision} />
      )}
      {tab === 'Plan vs actual' && (
        <Adherence csrf={csrf} permissions={permissions} refreshKey={refreshKey + revision} />
      )}
      {tab === 'Tour plan settings' && (
        <TourSetup csrf={csrf} permissions={permissions} refreshKey={refreshKey + revision} />
      )}
      {tab === 'Field app' && <FieldApp csrf={csrf} refreshKey={refreshKey + revision} />}
      {tab === 'Visits' && (
        <VisitList csrf={csrf} permissions={permissions} refreshKey={refreshKey + revision} />
      )}
      {tab === 'Calls today' && <VisitBoard csrf={csrf} refreshKey={refreshKey + revision} />}
      {tab === 'Visit settings' && (
        <VisitSetup csrf={csrf} permissions={permissions} refreshKey={refreshKey + revision} />
      )}
      {tab === 'Customer 360' && <Customer360 csrf={csrf} refreshKey={refreshKey + revision} />}
      {tab === 'Take order' && <TakeOrder csrf={csrf} refreshKey={refreshKey + revision} />}
      {tab === 'Orders' && (
        <OrderList csrf={csrf} permissions={permissions} refreshKey={refreshKey + revision} />
      )}
      {tab === 'Paperwork' && (
        <KycQueue csrf={csrf} permissions={permissions} refreshKey={refreshKey + revision} />
      )}
      {tab === 'Customer 360 settings' && (
        <TradeSetup csrf={csrf} permissions={permissions} refreshKey={refreshKey + revision} />
      )}
      {tab === 'My expenses' && <MyExpenses csrf={csrf} refreshKey={refreshKey + revision} />}
      {tab === 'Expense claims' && (
        <ExpenseClaims csrf={csrf} permissions={permissions} refreshKey={refreshKey + revision} />
      )}
      {tab === 'Expense register' && (
        <ExpenseRegister csrf={csrf} refreshKey={refreshKey + revision} />
      )}
      {tab === 'Expense policy' && (
        <ExpenseSetup csrf={csrf} permissions={permissions} refreshKey={refreshKey + revision} />
      )}
      {tab === 'Overview' && (
        <ReachOverview csrf={csrf} refreshKey={refreshKey + revision} onGo={setTab} />
      )}
      {tab === 'Waiting for a decision' && (
        <ReachQueue csrf={csrf} refreshKey={refreshKey + revision} onGo={setTab} />
      )}
      {tab === 'Going live' && <ReachCutover csrf={csrf} refreshKey={refreshKey + revision} />}
      {tab === 'Reach audit trail' && <ReachAudit csrf={csrf} refreshKey={refreshKey + revision} />}
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
