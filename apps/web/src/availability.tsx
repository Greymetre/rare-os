import { Pager, usePaging } from './pager';
import { CycleTimeAudit, Downtime, Execution } from './execution';
import { Delivery, Today } from './delivery';
import { Network, PlanningTools } from './planning-tools';
import {
  ChangeoverSimulator,
  LeadTimeRealityList,
  MaterialsOverview,
  SchedulingOverview,
  StockAndService,
} from './overview';
import {
  Expedites,
  Gantt,
  InsertOrder,
  PendingOrders,
  PlanningSettings,
  ResourceLoad,
  Scheduler,
} from './schedule';
import { useEffect, useState } from 'react';
import { download, useApi } from './api-client';
import { Boms, Calendars, PlantPicker, PlantReadiness, Resources, Routings } from './plant-model';
import {
  CustomerOrders,
  DemandHistory,
  ProductionOrders,
  PurchaseOrders,
  Stock,
  StockLocations,
} from './demand-stock';
import { BufferBoard, BufferProfiles, BufferSettings, PurchaseProposals } from './planning';
import { MasterTable, display } from './master-table';
import type { FieldInfo, KindInfo } from './master-table';
import { FileImport, Imports, statusLabel } from './imports';

function Readiness({ csrf, refreshKey }: { csrf: string; refreshKey: number }) {
  const call = useApi(csrf);
  const [items, setItems] = useState<any[] | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setError('');
    call('availability/readiness')
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
  if (!items) return <p role="status">Checking planning data…</p>;
  const ready = items.filter((i) => i.status === 'ready').length;
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Planning data readiness</h2>
        <span className="badge">
          {ready} / {items.filter((i) => i.status !== 'info').length} ready
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

function Units({
  csrf,
  permissions,
  refreshKey,
}: {
  csrf: string;
  permissions: string[];
  refreshKey: number;
}) {
  const call = useApi(csrf);
  const canManage = permissions.includes('masters.manage');
  const page = usePaging();
  const [rows, setRows] = useState<any[]>([]),
    [form, setForm] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [next, setNext] = useState<string | null>(null),
    [total, setTotal] = useState<number | undefined>(undefined),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError('');
    call(
      'units?limit=' +
        page.size +
        '&q=' +
        encodeURIComponent(search) +
        (page.cursor ? '&after=' + page.cursor : ''),
    )
      .then((d) => {
        if (!live) return;
        setRows(d.items);
        setNext(d.nextCursor);
        setTotal(d.total);
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [search, page.cursor, page.size, revision, refreshKey]);
  return (
    <>
      <div className="toolbar">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            page.setCursors([]);
            setSearch(query);
          }}
        >
          <input
            aria-label="Unit search"
            placeholder="Code or name starts with…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />{' '}
          <button className="button" disabled={busy}>
            Search
          </button>
        </form>
        {canManage && (
          <button
            className="button primary"
            disabled={busy}
            onClick={() => setForm({ code: '', name: '', decimals: 0 })}
          >
            Create unit
          </button>
        )}
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
      {form && (
        <section className="panel company-form">
          <h2>{form.id ? 'Edit unit ' + form.code : 'New unit'}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              const payload = form.id
                ? {
                    name: form.name,
                    decimals: Number(form.decimals),
                    active: form.active,
                    version: form.version,
                  }
                : { code: form.code, name: form.name, decimals: Number(form.decimals) };
              void call(
                'units' + (form.id ? '/' + form.id : ''),
                form.id ? 'PATCH' : 'POST',
                payload,
              )
                .then((d) => {
                  setNotice(d.message);
                  setForm(null);
                  setRevision((x) => x + 1);
                })
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            {!form.id && (
              <label>
                Unit code
                <input
                  required
                  maxLength={20}
                  value={form.code}
                  disabled={busy}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                />
              </label>
            )}
            <label>
              Unit name
              <input
                required
                maxLength={60}
                value={form.name}
                disabled={busy}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label>
              Decimals
              <input
                required
                type="number"
                min={0}
                max={6}
                value={form.decimals}
                disabled={busy}
                onChange={(e) => setForm({ ...form, decimals: e.target.value })}
              />
            </label>
            {form.id && (
              <label>
                Status
                <select
                  value={String(form.active)}
                  disabled={busy}
                  onChange={(e) => setForm({ ...form, active: e.target.value === 'true' })}
                >
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </label>
            )}
            <button className="button primary" disabled={busy}>
              Save unit
            </button>{' '}
            <button type="button" className="button" disabled={busy} onClick={() => setForm(null)}>
              Cancel
            </button>
          </form>
        </section>
      )}
      <section className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Decimals</th>
              <th>Status</th>
              {canManage && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.code}</td>
                <td>{r.name}</td>
                <td>{r.decimals}</td>
                <td>{r.active ? 'Active' : 'Inactive'}</td>
                {canManage && (
                  <td>
                    <button
                      className="text-button"
                      aria-label={'Edit unit ' + r.code}
                      onClick={() => setForm(r)}
                    >
                      Edit
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {busy && <p role="status">Loading units…</p>}
        {!rows.length && !busy && (
          <div className="empty">
            {search
              ? 'No units match this search.'
              : canManage
                ? 'No units yet. Create NOS or KG, or import units from a CSV file.'
                : 'No units yet. Ask a planner or administrator to add them.'}
          </div>
        )}
        <Pager page={page} next={next} total={total} shown={rows.length} busy={busy} noun="units" />
      </section>
    </>
  );
}

// One planning tool per menu entry, with the handover's own names.
const TOOL_TABS: Record<string, string> = {
  'Month Shape': 'month',
  'Recommended Buffers': 'recommended',
  'Buffer vs MTO': 'mto',
  'Events & Seasons': 'events',
  'Scheme Intake': 'schemes',
  'Target Mode': 'target',
  'Space Mode': 'space',
  Assumptions: 'assumptions',
};

// The module's own menu: the two engines of the handover with their screens, then everything the
// demo keeps in its Masters module. Pure, so the shell can draw it in the sidebar.
function availabilityMenu(permissions: string[], kinds: KindInfo[]) {
  const order = ['items', 'suppliers', 'item_suppliers', 'customers', 'unit_conversions'];
  const has = (p: string) => permissions.includes(p);
  // The menu follows the Nilkamal simulation handover (21-Sep-2026): Availability is two engines,
  // Scheduling & Execution (TOC / DBR) and Materials Planning (DDMRP), with the demo's own screen
  // names. Everything the demo keeps in its Masters module sits in the third group here. Every
  // entry is gated by the permission its screen needs, so a menu never offers what a person
  // cannot open.
  const SCHEDULING: [string, string][] = [
    ['Overview', 'planning.read'],
    ['Capacity & Changeover', 'masters.read'],
    ['Product Routing', 'masters.read'],
    ['Changeover Simulator', 'planning.read'],
    ['Scheduler', 'planning.read'],
    ['Resource Load Graph', 'planning.read'],
    ['Buffer Board & Exceptions', 'planning.read'],
    ['Gantt View', 'planning.read'],
    ['Lead Time Reality', 'planning.read'],
    ['Release Schedule', 'planning.read'],
    ['Insert an order', 'planning.read'],
    ['Order OTIF', 'planning.read'],
    ['Execution Loop', 'planning.read'],
    ['Master-Data Audit', 'planning.read'],
    ['Work Orders & Downtime', 'planning.read'],
    ['Club / date scenarios', 'planning.read'],
    ['Pending Orders to Plan', 'planning.read'],
  ];
  const MATERIALS: [string, string][] = [
    ['Materials Overview', 'planning.read'],
    ['Stock & Service', 'inventory.read'],
    ['Recommended Buffers', 'planning.read'],
    ['Planning Priorities', 'planning.read'],
    ['Workbench', 'planning.read'],
    ['Demand History', 'orders.read'],
    ['Buffer vs MTO', 'planning.read'],
    ['Month Shape', 'planning.read'],
    ['Target Mode', 'planning.read'],
    ['Events & Seasons', 'planning.read'],
    ['Scheme Intake', 'planning.read'],
    ['Space Mode', 'planning.read'],
    ['Material expedites', 'planning.read'],
    ['Proposed Orders', 'purchase.read'],
    ['Alerts', 'planning.read'],
    ['Parts & Buffer Profiles', 'planning.read'],
    ['Buffers & POs', 'purchase.read'],
    ['Assumptions', 'planning.read'],
  ];
  const MASTERS: [string, string][] = [
    ['Readiness', 'masters.read'],
    ['Units', 'masters.read'],
    ...order
      .map((k) => kinds.find((x) => x.kind === k)?.label)
      .filter(Boolean)
      .map((label) => [label as string, 'masters.read'] as [string, string]),
    ['Calendars', 'masters.read'],
    ['BOMs', 'masters.read'],
    ['Stock locations', 'masters.read'],
    ['Stock', 'inventory.read'],
    ['Customer orders', 'orders.read'],
    ['Production orders', 'orders.read'],
    ['Purchase orders', 'purchase.read'],
    ['Plant planning', 'planning.read'],
    ['Network', 'planning.read'],
    ['Imports', 'masters.read'],
    ['File import', 'masters.read'],
  ];
  const allowed = (list: [string, string][]) => list.filter(([, p]) => has(p)).map(([t]) => t);
  // Screens that work on one plant show the plant picker above them.
  const companyWide = new Set([
    'Units',
    'BOMs',
    'Imports',
    'File import',
    'Network',
    'Parts & Buffer Profiles',
    ...order.map((k) => kinds.find((x) => x.kind === k)?.label).filter(Boolean),
  ] as string[]);
  const groups: [string, string, string[]][] = [
    ['Scheduling & Execution', 'TOC / DBR engine', allowed(SCHEDULING)],
    ['Materials Planning', 'DDMRP engine', allowed(MATERIALS)],
    ['Masters & setup', 'one dataset behind every screen', allowed(MASTERS)],
  ];
  return { groups, companyWide, order };
}

// The screen list lives in the shell's sidebar (the handover puts a module's screens under the
// module). When the shell passes onNav, this component reports its menu upwards and stops drawing
// its own tab strip; on its own it still works with the tabs, which is what the tests use.
export function Availability({
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
  const [ownTab, setOwnTab] = useState('Readiness');
  const tab = tabProp ?? ownTab;
  const setTab = onTab ?? setOwnTab;
  const [plantId, setPlantId] = useState<string | null>(null);
  const canManage = permissions.includes('masters.manage');
  const [kinds, setKinds] = useState<KindInfo[] | null>(null),
    [error, setError] = useState('');
  const call = useApi(csrf);
  const canRead = permissions.includes('masters.read');
  useEffect(() => {
    if (!canRead) return;
    let live = true;
    call('masters')
      .then((d) => live && setKinds(d.kinds))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [canRead, refreshKey]);
  // The menu is worked out as soon as the master data is known, and reported to the shell, which
  // draws it in the sidebar. This sits above the early returns: a hook may not be conditional.
  const menu = kinds ? availabilityMenu(permissions, kinds) : null;
  const menuKey = menu ? JSON.stringify(menu.groups) : '';
  useEffect(() => {
    if (menuKey) onNav?.(JSON.parse(menuKey));
  }, [menuKey, onNav]);
  if (!canRead)
    return (
      <section className="panel availability">
        <span className="badge">SETUP IN PROGRESS</span>
        <h2>Planning results will appear here.</h2>
        <p>
          Planning data is being prepared. Ask your company administrator for master data access to
          view readiness, masters and imports.
        </p>
      </section>
    );
  if (error)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!kinds) return <p role="status">Loading planning data…</p>;
  const { groups, companyWide, order } = menu!;
  const currentGroup = groups.find(([, , list]) => list.includes(tab)) ?? null;
  const has = (p: string) => permissions.includes(p);
  const current = kinds.find((k) => k.label === tab);
  return (
    <>
      {/* In the shell the screens live in the sidebar; here the engine being worked in is named,
          with its own screens as chips, exactly one engine at a time. */}
      {onNav ? (
        currentGroup && (
          <nav className="engine-bar" aria-label={`${currentGroup[0]} screens`}>
            <div className="engine-name">
              <span>Availability</span>
              <strong>{currentGroup[0]}</strong>
              <small>{currentGroup[1]}</small>
            </div>
            {/* The same screens as the sidebar, within reach of the content. They are plain
                buttons: the sidebar is the navigation, this is a shortcut. */}
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
        <nav className="module-nav" aria-label="Availability sections">
          {groups.map(([group, engine, list]) => (
            <div key={group} className="subtabs">
              <span className="subtabs-label">
                {group}
                <small>{engine}</small>
              </span>
              <div className="subtabs-tabs" role="tablist" aria-label={`Availability ${group}`}>
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
            </div>
          ))}
        </nav>
      )}
      {!companyWide.has(tab) && <PlantPicker csrf={csrf} value={plantId} onChange={setPlantId} />}
      {tab === 'Readiness' && <Readiness csrf={csrf} refreshKey={refreshKey} />}
      {tab === 'Readiness' && plantId && (
        <PlantReadiness csrf={csrf} plantId={plantId} refreshKey={refreshKey} />
      )}
      {tab === 'Calendars' && plantId && (
        <Calendars csrf={csrf} plantId={plantId} canManage={canManage} refreshKey={refreshKey} />
      )}
      {tab === 'Capacity & Changeover' && plantId && (
        <Resources csrf={csrf} plantId={plantId} canManage={canManage} refreshKey={refreshKey} />
      )}
      {tab === 'BOMs' && <Boms csrf={csrf} canManage={canManage} refreshKey={refreshKey} />}
      {tab === 'Product Routing' && plantId && (
        <Routings
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          canManage={canManage}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Stock locations' && plantId && (
        <StockLocations
          csrf={csrf}
          plantId={plantId}
          canManage={canManage}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Stock' && plantId && (
        <Stock
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Customer orders' && plantId && (
        <CustomerOrders
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Production orders' && plantId && (
        <ProductionOrders
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Buffers & POs' && plantId && (
        <PurchaseOrders
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Demand History' && plantId && (
        <DemandHistory key={plantId} csrf={csrf} plantId={plantId} refreshKey={refreshKey} />
      )}
      {tab === 'Parts & Buffer Profiles' && (
        <BufferProfiles csrf={csrf} canManage={has('buffers.manage')} refreshKey={refreshKey} />
      )}
      {tab === 'Workbench' && plantId && (
        <BufferSettings
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          canManage={has('buffers.manage')}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Buffer Board & Exceptions' && plantId && (
        <BufferBoard
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Overview' && plantId && (
        <SchedulingOverview key={plantId} csrf={csrf} plantId={plantId} refreshKey={refreshKey} />
      )}
      {tab === 'Stock & Service' && plantId && (
        <StockAndService key={plantId} csrf={csrf} plantId={plantId} refreshKey={refreshKey} />
      )}
      {tab === 'Materials Overview' && plantId && (
        <MaterialsOverview key={plantId} csrf={csrf} plantId={plantId} refreshKey={refreshKey} />
      )}
      {tab === 'Changeover Simulator' && plantId && (
        <ChangeoverSimulator key={plantId} csrf={csrf} plantId={plantId} refreshKey={refreshKey} />
      )}
      {tab === 'Lead Time Reality' && plantId && (
        <LeadTimeRealityList key={plantId} csrf={csrf} plantId={plantId} refreshKey={refreshKey} />
      )}
      {['Scheduler', 'Club / date scenarios'].includes(tab) && plantId && (
        <Scheduler
          key={plantId + tab}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
          focus={tab === 'Scheduler' ? 'schedule' : 'decisions'}
        />
      )}
      {tab === 'Insert an order' && plantId && (
        <InsertOrder
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Pending Orders to Plan' && plantId && (
        <PendingOrders
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Material expedites' && plantId && (
        <Expedites
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {['Planning Priorities', 'Release Schedule', 'Alerts'].includes(tab) && plantId && (
        <Today
          key={plantId + tab}
          csrf={csrf}
          plantId={plantId}
          refreshKey={refreshKey}
          focus={
            tab === 'Alerts' ? 'alerts' : tab === 'Release Schedule' ? 'releases' : 'priorities'
          }
        />
      )}
      {tab === 'Order OTIF' && plantId && (
        <Delivery key={plantId} csrf={csrf} plantId={plantId} refreshKey={refreshKey} />
      )}
      {tab === 'Execution Loop' && plantId && (
        <Execution
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Work Orders & Downtime' && plantId && (
        <Downtime
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Master-Data Audit' && plantId && (
        <CycleTimeAudit
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {TOOL_TABS[tab] && plantId && (
        <PlanningTools
          key={plantId + tab}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
          only={TOOL_TABS[tab]}
        />
      )}
      {tab === 'Network' && plantId && (
        <Network key={plantId} csrf={csrf} plantId={plantId} refreshKey={refreshKey} />
      )}
      {tab === 'Gantt View' && plantId && (
        <Gantt key={plantId} csrf={csrf} plantId={plantId} refreshKey={refreshKey} />
      )}
      {tab === 'Resource Load Graph' && plantId && (
        <ResourceLoad key={plantId} csrf={csrf} plantId={plantId} refreshKey={refreshKey} />
      )}
      {tab === 'Plant planning' && plantId && (
        <PlanningSettings
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          canManage={has('buffers.manage')}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Proposed Orders' && plantId && (
        <PurchaseProposals
          key={plantId}
          csrf={csrf}
          plantId={plantId}
          permissions={permissions}
          refreshKey={refreshKey}
        />
      )}
      {tab === 'Units' && <Units csrf={csrf} permissions={permissions} refreshKey={refreshKey} />}
      {current && (
        <MasterTable key={current.kind} csrf={csrf} info={current} refreshKey={refreshKey} />
      )}
      {tab === 'File import' && (
        <FileImport csrf={csrf} permissions={permissions} refreshKey={refreshKey} kinds={kinds} />
      )}
      {tab === 'Imports' && (
        <Imports csrf={csrf} permissions={permissions} refreshKey={refreshKey} kinds={kinds} />
      )}
    </>
  );
}
