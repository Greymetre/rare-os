// AV-8 materials decisions (Nilkamal simulation handover, 21-Sep-2026): request a material expedite,
// approve it (maker-checker), record the supplier's confirmation, explore / quote a later date,
// and the Pending Orders to Plan.
import {
  applyLater,
  describeActions,
  describeLater,
  expeditePreview,
  laterPreview,
  listExpedites,
  listPending,
  loadExpediteActions,
  materialsContext,
  recordDecision,
  refreshBundles,
  writeExpediteBundle,
} from '../../../packages/schema/schedule-db.mjs';
import { ORDER_STATES } from '../../../packages/engines/materials-decisions.mjs';
import { Controller, Get, Post, Req, Param } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { access, scoped, fail } from './core.js';
import { id, body, mutate, audit } from './access.controller.js';
import { requirePlant } from './plants.controller.js';
import { freshContext } from './schedule.controller.js';

const ref = (v: unknown) => {
  const s = String(v ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$/.test(s))
    fail(400, 'VALIDATION_ERROR', 'Choose an order.');
  return s;
};
const isoDate = (v: unknown, label: string) => {
  const s = String(v ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s)))
    fail(400, 'VALIDATION_ERROR', `${label} must be a date (YYYY-MM-DD).`);
  return s;
};
const version = (v: unknown) => {
  if (!Number.isInteger(v) || Number(v) < 1)
    fail(400, 'VERSION_REQUIRED', 'Record version is missing. Refresh before saving.');
  return Number(v);
};

const currentRun = async (db: PoolClient) =>
  Number(
    (
      await db.query(
        'SELECT r.run_no FROM planning_state s JOIN planning_runs r ON r.id=s.current_run_id',
      )
    ).rows[0]?.run_no ?? 0,
  );

// Context of an action: its plant (assigned to the actor) and current row, locked.
async function actionFor(db: PoolClient, actor: any, actionId: string) {
  const a = (await db.query('SELECT * FROM expedite_actions WHERE id=$1 FOR UPDATE', [actionId]))
    .rows[0];
  if (!a) fail(404, 'NOT_FOUND', 'Expedite action not found.');
  const plant = await requirePlant(db, actor, a.site_id);
  return { a, plant };
}

@Controller('api')
export class MaterialsDecisionsController {
  // ---------- Expedite ----------
  @Get('plants/:plantId/expedites') async expedites(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      // A list: no need for an up-to-date calculation.
      const dc = {
        siteId: plant.id,
        actions: (await loadExpediteActions(db, plant.id)).get(plant.id) ?? [],
      };
      return { ...(await listExpedites(db, dc)), me: actor.id };
    });
  }

  @Post('plants/:plantId/expedite/preview') async expeditePreview(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    const order = ref(body(req, ['order']).order);
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const { dc, runNo, version: v } = await freshContext(db, plant.id, null);
      await materialsContext(db, dc);
      const p = await expeditePreview(db, dc, order);
      if (!p) fail(404, 'NOT_FOUND', `Order ${order} is not open in this plant.`);
      return {
        runNo,
        version: v,
        orders: p.ids,
        finish: p.snap
          ? p.ids.map((x: string) => ({
              order: x,
              finishDate: p.snap.times.get(x)
                ? dc.dates[Math.max(0, p.snap.times.get(x).ship - 1)]
                : null,
              promise: p.snap.times.get(x)
                ? dc.dates[Math.max(0, p.snap.times.get(x).prom - 1)]
                : null,
              materials: p.snap.materials.get(x)?.status ?? null,
            }))
          : [],
        actions: describeActions(dc, p.rows),
      };
    });
  }

  @Post('plants/:plantId/expedite/request') async expediteRequest(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const raw = body(req, ['order', 'runNo', 'version']);
    const order = ref(raw.order);
    return mutate(req, 'schedule.plan', async (db, actor) => {
      const plant = await requirePlant(db, actor, id(plantId));
      await db.query('SELECT 1 FROM planning_state FOR UPDATE');
      const { dc, runNo } = await freshContext(db, plant.id, raw);
      await materialsContext(db, dc);
      const p = await expeditePreview(db, dc, order);
      if (!p) fail(404, 'NOT_FOUND', `Order ${order} is not open in this plant.`);
      if (!p.rows.some((r: any) => r.type !== 'CANNOT_VALIDATE'))
        fail(
          409,
          'NOTHING_TO_EXPEDITE',
          p.rows.length
            ? 'Materials cannot be validated (no stock record, BOM or routing): there is nothing a supplier can confirm.'
            : 'Materials already cover this order at its release.',
        );
      const rows = describeActions(dc, p.rows);
      const d = await recordDecision(db, actor, plant.id, runNo, 'expedite_request', p.ids, {
        actions: rows,
      });
      const b = await writeExpediteBundle(db, actor, dc, p.ids, p.rows, d.no);
      await audit(db, actor, 'expedite.requested', 'expedite_bundle', b.bundleId, null, {
        orders: p.ids,
        actions: rows.map((r: any) => ({ type: r.type, component: r.component, qty: r.qty })),
      });
      return {
        decisionNo: d.no,
        bundleNo: b.bundleNo,
        message: `Decision #${d.no}: expedite bundle EXP-${b.bundleNo} requested for ${p.ids.join(', ')} (${rows.length} action(s)). A request is not supply: the order stays conditional until the supplier confirms.`,
      };
    });
  }

  @Post('expedite-actions/:actionId/approve') async approve(
    @Req() req: Request,
    @Param('actionId') actionId: string,
  ) {
    const v = version(body(req, ['version']).version);
    return mutate(req, 'purchase.expedite', async (db, actor) => {
      const { a, plant } = await actionFor(db, actor, id(actionId));
      if (a.version !== v)
        fail(409, 'STALE_RECORD', 'The action changed after you opened it. Refresh and try again.');
      if (a.kind === 'CANNOT_VALIDATE' || a.state !== 'requested')
        fail(409, 'INVALID_STATE', 'Only a requested expedite can be approved.');
      if (a.requested_by === actor.id)
        fail(403, 'SELF_APPROVAL', 'You requested this expedite: another person must approve it.');
      await db.query(
        "UPDATE expedite_actions SET state='approved',approved_by=$2,approved_at=now(),version=version+1,updated_at=now() WHERE id=$1",
        [a.id, actor.id],
      );
      await refreshBundles(db, plant.id);
      const d = await recordDecision(
        db,
        actor,
        plant.id,
        await currentRun(db),
        'expedite_approve',
        a.members,
        {
          action: Number(a.action_no),
        },
      );
      await audit(
        db,
        actor,
        'expedite.approved',
        'expedite_action',
        a.id,
        { state: a.state },
        { state: 'approved' },
      );
      return {
        decisionNo: d.no,
        message: `Expedite EA-${a.action_no} approved. No receipt is recorded: record the supplier's confirmation when it arrives.`,
      };
    });
  }

  @Post('expedite-actions/:actionId/reject') async reject(
    @Req() req: Request,
    @Param('actionId') actionId: string,
  ) {
    const raw = body(req, ['version', 'reason']);
    const v = version(raw.version);
    const reason = String(raw.reason ?? '').trim();
    if (!reason || reason.length > 300)
      fail(400, 'VALIDATION_ERROR', 'Give a reason (up to 300 characters).');
    return mutate(req, 'purchase.expedite', async (db, actor) => {
      const { a, plant } = await actionFor(db, actor, id(actionId));
      if (a.version !== v)
        fail(409, 'STALE_RECORD', 'The action changed after you opened it. Refresh and try again.');
      if (a.kind === 'CANNOT_VALIDATE' || ['rejected', 'superseded'].includes(a.state))
        fail(409, 'INVALID_STATE', 'This action cannot be rejected.');
      await db.query(
        `UPDATE expedite_actions SET state='rejected',reason=$2,confirmed_date=NULL,confirmed_qty=NULL,confirmation_ref=NULL,
           confirmed_by=NULL,confirmed_at=NULL,version=version+1,updated_at=now() WHERE id=$1`,
        [a.id, reason],
      );
      await refreshBundles(db, plant.id);
      const d = await recordDecision(
        db,
        actor,
        plant.id,
        await currentRun(db),
        'expedite_reject',
        a.members,
        {
          action: Number(a.action_no),
          reason,
        },
      );
      await audit(
        db,
        actor,
        'expedite.rejected',
        'expedite_action',
        a.id,
        { state: a.state },
        { state: 'rejected', reason },
      );
      return {
        decisionNo: d.no,
        message: `Expedite EA-${a.action_no} rejected. ${a.members.join(', ')}: decide again (quote a later date).`,
      };
    });
  }

  @Post('expedite-actions/:actionId/confirm') async confirm(
    @Req() req: Request,
    @Param('actionId') actionId: string,
  ) {
    const raw = body(req, ['version', 'date', 'qty', 'reference']);
    const v = version(raw.version);
    const date = isoDate(raw.date, 'Confirmed receipt date');
    const qty = Number(raw.qty);
    const reference = String(raw.reference ?? '').trim();
    if (!reference || reference.length > 120)
      fail(400, 'VALIDATION_ERROR', "Record the supplier's confirmation reference.");
    return mutate(req, 'purchase.expedite', async (db, actor) => {
      const { a, plant } = await actionFor(db, actor, id(actionId));
      if (a.version !== v)
        fail(409, 'STALE_RECORD', 'The action changed after you opened it. Refresh and try again.');
      if (a.kind === 'CANNOT_VALIDATE' || !['approved', 'late', 'confirmed'].includes(a.state))
        fail(409, 'INVALID_STATE', 'Approve the request before recording a confirmation.');
      const today = (
        await db.query('SELECT coalesce(as_of_date,current_date)::text AS d FROM planning_state')
      ).rows[0]?.d;
      if (today && date < today)
        fail(400, 'VALIDATION_ERROR', `The confirmed date cannot be before ${today}.`);
      if (!(qty > 0) || qty > Number(a.quantity) + 1e-6)
        fail(
          400,
          'VALIDATION_ERROR',
          `Confirmed quantity must be more than 0 and at most ${Number(a.quantity)}.`,
        );
      const required = (
        await db.query("SELECT to_char($1::date,'YYYY-MM-DD') AS d", [a.required_date])
      ).rows[0].d;
      const state = date <= required ? 'confirmed' : 'late';
      await db.query(
        `UPDATE expedite_actions SET state=$2,confirmed_date=$3,confirmed_qty=$4,confirmation_ref=$5,confirmed_by=$6,confirmed_at=now(),
           version=version+1,updated_at=now() WHERE id=$1`,
        [a.id, state, date, qty, reference, actor.id],
      );
      await refreshBundles(db, plant.id);
      const d = await recordDecision(
        db,
        actor,
        plant.id,
        await currentRun(db),
        'expedite_confirm',
        a.members,
        {
          action: Number(a.action_no),
          date,
          qty,
          reference,
          required,
          state,
        },
      );
      await audit(
        db,
        actor,
        'expedite.confirmed',
        'expedite_action',
        a.id,
        { state: a.state },
        { state, date, qty, reference },
      );
      return {
        decisionNo: d.no,
        state,
        message:
          state === 'confirmed'
            ? `EA-${a.action_no}: ${qty} confirmed for ${date} (needed by ${required}). Materials are rechecked in a few seconds.`
            : `EA-${a.action_no}: the supplier's date ${date} is after the required ${required}. ${a.members.join(', ')}: decide again (quote a later date).`,
      };
    });
  }

  // ---------- A later date ----------
  @Post('plants/:plantId/later/preview') async laterPreview(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    const raw = body(req, ['order', 'candidateDate']);
    const order = ref(raw.order);
    const candidate = raw.candidateDate ? isoDate(raw.candidateDate, 'Delivery date') : null;
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const { dc, runNo, version: v } = await freshContext(db, plant.id, null);
      await materialsContext(db, dc);
      if (candidate && candidate <= dc.today)
        fail(400, 'VALIDATION_ERROR', `Enter a date after the planning date ${dc.today}.`);
      const res = await laterPreview(db, dc, order, candidate);
      if (!res) fail(404, 'NOT_FOUND', `Order ${order} is not open in this plant.`);
      return {
        runNo,
        version: v,
        order,
        scheduled: res.scheduled,
        plan: res.plan ?? null,
        candidate,
        evaluated: res.evaluated,
        scenarios: describeLater(dc, res),
      };
    });
  }

  @Post('plants/:plantId/later/apply') async laterApply(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const raw = body(req, [
      'order',
      'candidateDate',
      'key',
      'mode',
      'release',
      'promise',
      'runNo',
      'version',
    ]);
    const order = ref(raw.order);
    const mode = String(raw.mode ?? '');
    if (!['propose', 'confirm', 'move'].includes(mode))
      fail(
        400,
        'VALIDATION_ERROR',
        'Choose propose, confirm and reschedule, or move down the queue.',
      );
    const candidate = raw.candidateDate ? isoDate(raw.candidateDate, 'Delivery date') : null;
    return mutate(req, 'schedule.plan', async (db, actor) => {
      const plant = await requirePlant(db, actor, id(plantId));
      await db.query('SELECT 1 FROM planning_state FOR UPDATE');
      const { dc, runNo } = await freshContext(db, plant.id, raw);
      await materialsContext(db, dc);
      const res = await laterPreview(db, dc, order, candidate);
      if (!res) fail(404, 'NOT_FOUND', `Order ${order} is not open in this plant.`);
      const view = describeLater(dc, res);
      const i = view.findIndex((s: any) => s.key === raw.key);
      if (i < 0 || view[i].release !== raw.release || view[i].promise !== raw.promise)
        fail(409, 'PLANNING_STALE', 'The dates changed since the preview. Review them again.');
      const s = res.scenarios[i];
      if (!s.capacityOK)
        fail(
          409,
          'NOT_SUPPORTED',
          'Full-route capacity does not support this date: it cannot be proposed or scheduled.',
        );
      if (mode === 'move' && !res.scheduled)
        fail(409, 'INVALID_STATE', 'A pending order is confirmed with its new date, not moved.');
      const kind =
        mode === 'propose' ? 'later_propose' : mode === 'confirm' ? 'later_confirm' : 'later_move';
      const d = await recordDecision(db, actor, plant.id, runNo, kind, [order], {
        scenario: { ...view[i], impact: undefined },
        impact: view[i].impact,
      });
      const r = await applyLater(db, actor, dc, order, res, s, mode, d.no);
      await audit(db, actor, 'schedule.' + kind, 'planning_decision', d.id, null, {
        order,
        ...r,
        mode,
      });
      return {
        decisionNo: d.no,
        message:
          mode === 'propose'
            ? `Decision #${d.no}: ${r.promise} proposed to the customer for ${order}. The order waits in Pending (original promise ${r.original} unchanged) and holds no capacity or material until confirmed.`
            : mode === 'confirm'
              ? `Decision #${d.no}: ${order} rescheduled with the accepted date ${r.promise}, released from ${r.release}. The schedule recalculates in a few seconds.`
              : `Decision #${d.no}: ${order} moved down the queue (release ${r.release}); the customer promise ${r.original} is kept.`,
      };
    });
  }

  // ---------- Pending Orders to Plan ----------
  @Get('plants/:plantId/pending') async pending(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      return {
        items: (await listPending(db, plant.id)).map((p: any) => ({
          ...p,
          state_label: ORDER_STATES[p.state] ?? p.state,
          quantity: p.quantity === null ? null : Number(p.quantity),
        })),
      };
    });
  }

  @Post('plants/:plantId/pending/:action') async pendingAction(
    @Req() req: Request,
    @Param('plantId') plantId: string,
    @Param('action') action: string,
  ) {
    if (!['ready', 'cancel'].includes(action)) fail(404, 'NOT_FOUND', 'Unknown action.');
    const raw = body(req, ['order', 'version']);
    const order = ref(raw.order);
    const v = version(raw.version);
    return mutate(req, 'schedule.plan', async (db, actor) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const p = (
        await db.query('SELECT * FROM order_plans WHERE site_id=$1 AND order_ref=$2 FOR UPDATE', [
          plant.id,
          order,
        ])
      ).rows[0];
      if (!p || !['awaiting_confirmation', 'ready_to_reschedule'].includes(p.state))
        fail(409, 'INVALID_STATE', `${order} is not waiting for a customer date.`);
      if (action === 'ready' && p.state !== 'awaiting_confirmation')
        fail(409, 'INVALID_STATE', `${order} is already ready to reschedule.`);
      if (p.version !== v)
        fail(409, 'STALE_RECORD', 'The order changed after you opened it. Refresh and try again.');
      const kind = action === 'ready' ? 'pending_ready' : 'pending_cancel';
      const d = await recordDecision(db, actor, plant.id, await currentRun(db), kind, [order], {});
      if (action === 'ready')
        await db.query(
          `UPDATE order_plans SET state='ready_to_reschedule',reason=$3,last_decision_no=$4,version=version+1,updated_at=now()
           WHERE site_id=$1 AND order_ref=$2`,
          [
            plant.id,
            order,
            'Customer accepted the date: review capacity and materials, then confirm and reschedule.',
            d.no,
          ],
        );
      else {
        await db.query(
          `UPDATE order_plans SET state='cancelled',reason=$3,last_decision_no=$4,version=version+1,updated_at=now()
           WHERE site_id=$1 AND order_ref=$2`,
          [plant.id, order, 'Planner cancelled the pending order.', d.no],
        );
        await db.query(
          `UPDATE production_orders SET status='CLOSED',version=version+1,updated_at=now()
           WHERE site_id=$1 AND coalesce(order_ref,order_no)=$2 AND status='OPEN'`,
          [plant.id, order],
        );
      }
      await audit(
        db,
        actor,
        'schedule.' + kind,
        'planning_decision',
        d.id,
        { state: p.state },
        { order },
      );
      return {
        decisionNo: d.no,
        message:
          action === 'ready'
            ? `Decision #${d.no}: ${order} is ready to reschedule. Review its dates and confirm.`
            : `Decision #${d.no}: ${order} cancelled.`,
      };
    });
  }
}
