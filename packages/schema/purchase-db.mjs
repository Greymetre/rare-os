// Database side of the purchase loop (AV-5): proposals from planning (rule AV-01), approval into
// purchase orders, and goods receipts that post stock. Runs inside a company-scoped transaction.
import { proposalAction, receiptProblems } from '../engines/purchase.mjs';
import { multiplyDecimal, parseQuantity } from './quantity.mjs';
import { nextOrderNo, postMovements, writeOrder } from './demand-stock-db.mjs';

const CHUNK = 1000;
const key = (siteId, itemId) => `${siteId}|${itemId}`;
const err = (column, message) => ({ column, message });

// ---------- Proposals from planning (AV-01) ----------

// Brings pending system proposals in line with the run that just became current.
export async function syncProposals(db, tenantId, run) {
  const wanted = new Map(
    (
      await db.query(
        `SELECT r.site_id,r.item_id,r.supplier_id,u.id AS unit_id,r.recommended_purchase_qty AS quantity,
           r.recommended_qty/r.recommended_purchase_qty AS factor,to_char(r.due_date,'YYYY-MM-DD') AS due,
           r.zone,r.nfp,r.top_of_green
         FROM planning_results r JOIN units u ON lower(u.code)=lower(r.purchase_unit)
         WHERE r.run_id=$1 AND r.status='planned' AND r.recommended_kind='BUY'
           AND r.supplier_id IS NOT NULL AND r.recommended_purchase_qty > 0`,
        [run.id],
      )
    ).rows.map((w) => [
      key(w.site_id, w.item_id),
      { ...w, supplierId: w.supplier_id, unitId: w.unit_id, quantity: Number(w.quantity) },
    ]),
  );
  const pending = new Map(
    (
      await db.query(
        "SELECT *,to_char(due_date,'YYYY-MM-DD') AS due_date FROM purchase_proposals WHERE status='PROPOSED'",
      )
    ).rows.map((p) => [key(p.site_id, p.item_id), p]),
  );
  const rejected = new Map(
    (
      await db.query(
        "SELECT DISTINCT ON (site_id,item_id) * FROM purchase_proposals WHERE status='REJECTED' ORDER BY site_id,item_id,proposal_no DESC",
      )
    ).rows.map((p) => [key(p.site_id, p.item_id), p]),
  );
  const plan = { create: [], update: [], keep: [], withdraw: [] };
  for (const k of new Set([...wanted.keys(), ...pending.keys()])) {
    const action = proposalAction({
      pending: pending.get(k) ?? null,
      wanted: wanted.get(k) ?? null,
      lastRejected: rejected.get(k) ?? null,
    });
    if (action === 'none') continue;
    plan[action].push({ wanted: wanted.get(k), pending: pending.get(k) });
  }
  const round = (v) => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 1 });
  const reason = (w) =>
    `Net flow ${round(w.nfp)} is in the ${w.zone} zone; top of green ${round(w.top_of_green)}.`;
  for (let i = 0; i < plan.create.length; i += CHUNK) {
    const part = plan.create.slice(i, i + CHUNK).map((c) => c.wanted);
    const numbers = (
      await db.query(
        "SELECT next_number('purchase_proposal') AS n FROM generate_series(1,$1) ORDER BY 1",
        [part.length],
      )
    ).rows.map((r) => r.n);
    await db.query(
      `INSERT INTO purchase_proposals(id,tenant_id,proposal_no,site_id,item_id,supplier_id,purchase_unit_id,unit_factor,quantity,due_date,source,run_no,zone,nfp,top_of_green,note)
       SELECT gen_random_uuid(),$1,p.no,p.site,p.item,p.supplier,p.unit,p.factor,p.qty,p.due,'SYSTEM',$2,p.zone,p.nfp,p.tog,p.note
       FROM unnest($3::bigint[],$4::uuid[],$5::uuid[],$6::uuid[],$7::uuid[],$8::numeric[],$9::numeric[],$10::date[],$11::text[],$12::numeric[],$13::numeric[],$14::text[])
         AS p(no,site,item,supplier,unit,factor,qty,due,zone,nfp,tog,note)`,
      [
        tenantId,
        run.run_no,
        numbers,
        part.map((w) => w.site_id),
        part.map((w) => w.item_id),
        part.map((w) => w.supplierId),
        part.map((w) => w.unitId),
        part.map((w) => w.factor),
        part.map((w) => w.quantity),
        part.map((w) => w.due),
        part.map((w) => w.zone),
        part.map((w) => w.nfp),
        part.map((w) => w.top_of_green),
        part.map(reason),
      ],
    );
  }
  for (const { wanted: w, pending: p } of plan.update)
    await db.query(
      `UPDATE purchase_proposals SET supplier_id=$2,purchase_unit_id=$3,unit_factor=$4,quantity=$5,due_date=$6,run_no=$7,
         zone=$8,nfp=$9,top_of_green=$10,note=$11,changed_by=NULL,changed_by_subject=NULL,version=version+1,updated_at=now()
       WHERE id=$1`,
      [
        p.id,
        w.supplierId,
        w.unitId,
        w.factor,
        w.quantity,
        w.due,
        run.run_no,
        w.zone,
        w.nfp,
        w.top_of_green,
        reason(w),
      ],
    );
  // Kept proposals move to the current run so they can be approved against it.
  const kept = plan.keep.filter((k) => k.pending.source === 'SYSTEM').map((k) => k.pending.id);
  if (kept.length)
    await db.query(
      'UPDATE purchase_proposals SET run_no=$2,zone=v.zone,nfp=v.nfp FROM (SELECT r.item_id,r.site_id,r.zone,r.nfp FROM planning_results r WHERE r.run_id=$3) v WHERE purchase_proposals.id=ANY($1::uuid[]) AND v.item_id=purchase_proposals.item_id AND v.site_id=purchase_proposals.site_id',
      [kept, run.run_no, run.id],
    );
  if (plan.withdraw.length)
    await db.query(
      `UPDATE purchase_proposals SET status='WITHDRAWN',decided_at=now(),run_no=$2,version=version+1,updated_at=now(),
         decision_note='No longer needed: the latest calculation shows enough stock and supply.'
       WHERE id=ANY($1::uuid[])`,
      [plan.withdraw.map((w) => w.pending.id), run.run_no],
    );
  return {
    created: plan.create.length,
    updated: plan.update.length,
    withdrawn: plan.withdraw.length,
  };
}

// ---------- Listing and detail ----------

const PROPOSAL_SELECT = `SELECT p.id,p.proposal_no,p.site_id,s.code AS plant,p.item_id,i.code AS item,i.name AS item_name,
    p.supplier_id,sup.code AS supplier,sup.name AS supplier_name,u.code AS unit,p.purchase_unit_id,p.unit_factor,p.quantity,
    bu.code AS base_unit,to_char(p.due_date,'YYYY-MM-DD') AS due_date,p.status,p.source,p.run_no,p.zone,p.nfp,p.top_of_green,
    p.note,p.changed_by_subject,p.decided_at,p.decision_note,p.po_id,po.po_no,p.version,p.created_at,p.updated_at,
    cu.name AS changed_by_name,du.name AS decided_by_name
  FROM purchase_proposals p JOIN sites s ON s.id=p.site_id JOIN items i ON i.id=p.item_id JOIN units bu ON bu.id=i.base_unit_id
  JOIN suppliers sup ON sup.id=p.supplier_id JOIN units u ON u.id=p.purchase_unit_id
  LEFT JOIN purchase_orders po ON po.id=p.po_id
  LEFT JOIN app_users cu ON cu.id=p.changed_by LEFT JOIN app_users du ON du.id=p.decided_by`;

export async function proposalDetail(db, id) {
  return (await db.query(PROPOSAL_SELECT + ' WHERE p.id=$1', [id])).rows[0] ?? null;
}

export async function listProposals(
  db,
  siteId,
  { status = 'PROPOSED', q = '', cursor = null, limit = 25 },
) {
  const params = [siteId, status, q];
  let where =
    'p.site_id=$1 AND ($2::text IS NULL OR p.status=$2) AND (starts_with(lower(i.code),$3) OR starts_with(lower(sup.code),$3))';
  if (cursor) {
    params.push(cursor);
    where += ` AND p.proposal_no < $${params.length}::bigint`;
  }
  params.push(limit + 1);
  const rows = (
    await db.query(
      `${PROPOSAL_SELECT} WHERE ${where} ORDER BY p.proposal_no DESC LIMIT $${params.length}`,
      params,
    )
  ).rows;
  const counts = Object.fromEntries(
    (
      await db.query(
        'SELECT status,count(*)::int AS n FROM purchase_proposals WHERE site_id=$1 GROUP BY status',
        [siteId],
      )
    ).rows.map((r) => [r.status, r.n]),
  );
  const items = rows.slice(0, limit);
  return {
    items,
    counts,
    nextCursor: rows.length > limit ? String(items[items.length - 1].proposal_no) : null,
  };
}

// ---------- Decisions ----------

// Creates the purchase order for an approved proposal. The order is open supply, not stock.
export async function approveProposal(db, tenantId, actor, proposal, today) {
  const supplier = (
    await db.query('SELECT active,code FROM suppliers WHERE id=$1', [proposal.supplier_id])
  ).rows[0];
  if (!supplier?.active)
    return {
      error: `Supplier ${supplier?.code ?? ''} is inactive. Reject the proposal or raise one for another supplier.`,
    };
  const poNo = await nextOrderNo(db, 'purchase_orders');
  const due = proposal.due_date < today ? today : proposal.due_date;
  const poId = await writeOrder(db, 'purchase_orders', tenantId, {
    existing: null,
    value: {
      site_id: proposal.site_id,
      po_no: poNo,
      supplier_id: proposal.supplier_id,
      order_date: today,
      lines: [
        {
          line_no: 10,
          item_id: proposal.item_id,
          unit_id: proposal.purchase_unit_id,
          unit_factor: proposal.unit_factor,
          quantity: proposal.quantity,
          received_quantity: '0',
          due_date: due,
        },
      ],
    },
  });
  await db.query("UPDATE purchase_orders SET source='PROPOSAL',proposal_id=$2 WHERE id=$1", [
    poId,
    proposal.id,
  ]);
  await db.query(
    `UPDATE purchase_proposals SET status='APPROVED',po_id=$2,decided_by=$3,decided_by_subject=$4,decided_at=now(),
       version=version+1,updated_at=now() WHERE id=$1`,
    [proposal.id, poId, actor.id, actor.actor_subject],
  );
  return { poId, poNo };
}

export async function rejectProposal(db, actor, proposal, reason) {
  await db.query(
    `UPDATE purchase_proposals SET status='REJECTED',decision_note=$2,decided_by=$3,decided_by_subject=$4,decided_at=now(),
       version=version+1,updated_at=now() WHERE id=$1`,
    [proposal.id, reason, actor.id, actor.actor_subject],
  );
}

// Quantity or due date changed by a person: they become its author and cannot approve it.
export async function changeProposal(db, actor, proposal, { quantity, due_date, note }) {
  const decimals = (
    await db.query('SELECT decimals FROM units WHERE id=$1', [proposal.purchase_unit_id])
  ).rows[0].decimals;
  const q = parseQuantity(quantity, decimals, { label: 'Quantity' });
  if (q.error) return { errors: [err('quantity', `${q.error} (unit ${proposal.unit})`)] };
  if (Number(q.value) <= 0)
    return { errors: [err('quantity', 'Quantity must be greater than 0.')] };
  await db.query(
    `UPDATE purchase_proposals SET quantity=$2,due_date=$3,note=$4,changed_by=$5,changed_by_subject=$6,
       version=version+1,updated_at=now() WHERE id=$1`,
    [proposal.id, q.value, due_date, note, actor.id, actor.actor_subject],
  );
  return { errors: [] };
}

// A proposal raised by a person for an item's preferred supplier.
export async function createManualProposal(
  db,
  tenantId,
  actor,
  siteId,
  { item, quantity, due_date, note },
) {
  const source = (
    await db.query(
      `SELECT i.id AS item_id,i.code,i.make_buy,i.active,x.supplier_id,x.purchase_unit_id,u.code AS unit,u.decimals,
         s.active AS supplier_active,s.code AS supplier
       FROM items i LEFT JOIN item_suppliers x ON x.item_id=i.id AND x.preferred AND x.active
       LEFT JOIN suppliers s ON s.id=x.supplier_id LEFT JOIN units u ON u.id=x.purchase_unit_id
       WHERE lower(i.code)=lower($1)`,
      [item],
    )
  ).rows[0];
  if (!source) return { errors: [err('item', `Item ${item} was not found.`)] };
  if (!source.active) return { errors: [err('item', `Item ${source.code} is inactive.`)] };
  if (source.make_buy !== 'BUY')
    return {
      errors: [err('item', `Item ${source.code} is MAKE. Purchase proposals are for BUY items.`)],
    };
  if (!source.supplier_id || !source.supplier_active)
    return {
      errors: [
        err(
          'item',
          `Item ${source.code} has no active preferred supplier. Set one in Item sourcing.`,
        ),
      ],
    };
  const q = parseQuantity(quantity, source.decimals, { label: 'Quantity' });
  if (q.error) return { errors: [err('quantity', `${q.error} (unit ${source.unit})`)] };
  if (Number(q.value) <= 0)
    return { errors: [err('quantity', 'Quantity must be greater than 0.')] };
  const factor = (
    await db.query(
      `SELECT CASE WHEN x.purchase_unit_id=i.base_unit_id THEN 1 ELSE coalesce(
         (SELECT factor FROM unit_conversions c WHERE c.active AND c.from_unit_id=x.purchase_unit_id AND c.to_unit_id=i.base_unit_id AND (c.item_id IS NULL OR c.item_id=i.id) ORDER BY c.item_id NULLS LAST LIMIT 1),
         1/(SELECT factor FROM unit_conversions c WHERE c.active AND c.to_unit_id=x.purchase_unit_id AND c.from_unit_id=i.base_unit_id AND (c.item_id IS NULL OR c.item_id=i.id) ORDER BY c.item_id NULLS LAST LIMIT 1)) END AS f
       FROM items i JOIN item_suppliers x ON x.item_id=i.id AND x.preferred AND x.active WHERE i.id=$1`,
      [source.item_id],
    )
  ).rows[0].f;
  if (!factor)
    return { errors: [err('item', `No unit conversion for the purchase unit ${source.unit}.`)] };
  const no = (await db.query("SELECT next_number('purchase_proposal') AS n")).rows[0].n;
  const row = (
    await db.query(
      `INSERT INTO purchase_proposals(id,tenant_id,proposal_no,site_id,item_id,supplier_id,purchase_unit_id,unit_factor,quantity,due_date,source,note,changed_by,changed_by_subject)
       VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,'MANUAL',$10,$11,$12) RETURNING id,proposal_no`,
      [
        tenantId,
        no,
        siteId,
        source.item_id,
        source.supplier_id,
        source.purchase_unit_id,
        factor,
        q.value,
        due_date,
        note,
        actor.id,
        actor.actor_subject,
      ],
    )
  ).rows[0];
  return { errors: [], id: row.id, proposalNo: row.proposal_no, supplier: source.supplier };
}

// ---------- Goods receipts ----------

export async function receiptsFor(db, poId) {
  return (
    await db.query(
      `SELECT r.id,r.receipt_no,to_char(r.receipt_date,'YYYY-MM-DD') AS receipt_date,l.code AS location,r.reference,r.created_at,
         (SELECT json_agg(json_build_object('line_no',pl.line_no,'quantity',gl.quantity,'unit',u.code) ORDER BY pl.line_no)
          FROM goods_receipt_lines gl JOIN purchase_order_lines pl ON pl.id=gl.po_line_id JOIN units u ON u.id=pl.unit_id
          WHERE gl.receipt_id=r.id) AS lines
       FROM goods_receipts r JOIN stock_locations l ON l.id=r.location_id WHERE r.po_id=$1 ORDER BY r.receipt_no`,
      [poId],
    )
  ).rows;
}

// body: { request_id, location, receipt_date, reference, lines: [{ line_no, quantity }] } (validated shape).
// Returns { errors } or { receiptNo, duplicate }.
export async function postReceipt(db, tenantId, actor, po, body, today) {
  const earlier = (
    await db.query('SELECT receipt_no,po_id FROM goods_receipts WHERE request_id=$1', [
      body.request_id,
    ])
  ).rows[0];
  if (earlier) {
    if (earlier.po_id !== po.id)
      return {
        errors: [err('request_id', 'This request id was already used for another receipt.')],
      };
    return { errors: [], receiptNo: earlier.receipt_no, duplicate: true };
  }
  const errors = [];
  if (po.status !== 'OPEN') errors.push(err('po', `Purchase order ${po.no} is cancelled.`));
  if (body.receipt_date > today)
    errors.push(err('receipt_date', 'Receipt date cannot be in the future.'));
  if (body.receipt_date < po.order_date)
    errors.push(err('receipt_date', 'Receipt date cannot be before the order date.'));
  const location = (
    await db.query(
      'SELECT id,code,active FROM stock_locations WHERE site_id=$1 AND lower(code)=lower($2)',
      [po.site_id, body.location],
    )
  ).rows[0];
  if (!location)
    errors.push(err('location', `Location ${body.location} was not found in plant ${po.plant}.`));
  else if (!location.active) errors.push(err('location', `Location ${location.code} is inactive.`));
  const orderLines = (
    await db.query(
      `SELECT l.id,l.line_no,l.status,l.quantity,l.received_quantity,l.unit_id,l.unit_factor,l.item_id,u.code AS unit,u.decimals,
         bu.decimals AS base_decimals,bu.code AS base_unit
       FROM purchase_order_lines l JOIN units u ON u.id=l.unit_id JOIN items i ON i.id=l.item_id JOIN units bu ON bu.id=i.base_unit_id
       WHERE l.po_id=$1 FOR UPDATE OF l`,
      [po.id],
    )
  ).rows;
  const lines = [];
  for (const l of body.lines) {
    const ol = orderLines.find((o) => o.line_no === l.line_no);
    const q = parseQuantity(l.quantity, ol ? ol.decimals : 6, {
      label: `Line ${l.line_no}: quantity`,
    });
    if (q.error) errors.push(err('lines', `${q.error}${ol ? ` (unit ${ol.unit})` : ''}`));
    else lines.push({ line_no: l.line_no, quantity: q.value, number: Number(q.value) });
  }
  for (const m of receiptProblems(
    lines.map((l) => ({ line_no: l.line_no, quantity: l.number })),
    orderLines,
  ))
    errors.push(err('lines', m));
  const movements = [];
  for (const l of lines) {
    const ol = orderLines.find((o) => o.line_no === l.line_no);
    if (!ol) continue;
    const base = multiplyDecimal(l.quantity, String(Number(ol.unit_factor)));
    if (parseQuantity(base, ol.base_decimals).error)
      errors.push(
        err(
          'lines',
          `Line ${l.line_no}: ${l.quantity} ${ol.unit} is ${base} ${ol.base_unit}, more decimals than ${ol.base_unit} allows.`,
        ),
      );
    movements.push({ ol, l, base });
  }
  if (errors.length) return { errors };
  const receiptNo = (await db.query("SELECT next_number('goods_receipt') AS n")).rows[0].n;
  const receiptId = (
    await db.query(
      `INSERT INTO goods_receipts(id,tenant_id,receipt_no,site_id,po_id,location_id,receipt_date,reference,request_id,created_by,created_by_subject)
       VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        tenantId,
        receiptNo,
        po.site_id,
        po.id,
        location.id,
        body.receipt_date,
        body.reference,
        body.request_id,
        actor.id,
        actor.actor_subject,
      ],
    )
  ).rows[0].id;
  const posted = await postMovements(
    db,
    tenantId,
    { id: actor.id, subject: actor.actor_subject },
    movements.map(({ ol, l, base }) => ({
      site_id: po.site_id,
      location_id: location.id,
      item_id: ol.item_id,
      movement_type: 'RECEIPT',
      base_quantity: base,
      entered_quantity: l.quantity,
      entered_unit_id: ol.unit_id,
      movement_date: body.receipt_date,
      reference: body.reference || `GRN-${receiptNo}`,
      reason: `Receipt against ${po.no}`,
      external_ref: `GRN-${receiptNo}-${l.line_no}`,
    })),
  );
  for (const [i, { ol, l, base }] of movements.entries()) {
    await db.query(
      'INSERT INTO goods_receipt_lines(tenant_id,receipt_id,po_line_id,quantity,base_quantity,movement_id) VALUES($1,$2,$3,$4,$5,$6)',
      [tenantId, receiptId, ol.id, l.quantity, base, posted[i].id],
    );
    await db.query(
      'UPDATE purchase_order_lines SET received_quantity=received_quantity+$2 WHERE id=$1',
      [ol.id, l.quantity],
    );
  }
  return { errors: [], receiptNo, duplicate: false };
}
