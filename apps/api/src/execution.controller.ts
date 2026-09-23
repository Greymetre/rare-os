// AV-9 execution (Nilkamal simulation handover, 21-Sep-2026): release a make order from a buffer
// recommendation, run work orders on two events (release and completion), log a breakdown and see
// which promises it puts at risk, and audit the maintained cycle times against what production took.
import {
  adoptCycleTime,
  atRiskOrders,
  completeWork,
  cycleTimeAudit,
  cycleTimeAuditOptions,
  listDowntime,
  listExecution,
  logDowntime,
  makeRecommendation,
  releaseMakeOrder,
  releaseWork,
  workOrder,
} from '../../../packages/schema/execution-db.mjs';
import {
  planningDate,
  plantPlanning,
  recordDecision,
} from '../../../packages/schema/schedule-db.mjs';
import { planningStatus } from '../../../packages/schema/planning-db.mjs';
import { Controller, Get, Post, Req, Param } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { access, scoped, fail } from './core.js';
import { id, body, mutate, audit } from './access.controller.js';
import { requirePlant } from './plants.controller.js';

const num = (v: unknown, label: string, min: number, max: number) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max)
    fail(400, 'VALIDATION_ERROR', `${label} must be a number from ${min} to ${max}.`);
  return n;
};
const isoDate = (v: unknown, label: string) => {
  const s = String(v ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s)))
    fail(400, 'VALIDATION_ERROR', `${label} must be a date (YYYY-MM-DD).`);
  return s;
};
// Execution acts on the calculation the planner is looking at.
async function currentRun(db: PoolClient, raw: any) {
  const status = await planningStatus(db);
  if (!status.upToDate)
    fail(
      409,
      'PLANNING_STALE',
      'The schedule is being recalculated. Review it again in a few seconds.',
    );
  const runNo = Number(status.current.run_no);
  if (raw?.runNo !== undefined && Number(raw.runNo) !== runNo)
    fail(
      409,
      'PLANNING_STALE',
      `Calculation #${raw.runNo} is no longer current. Review run #${runNo} again.`,
    );
  return runNo;
}
const bufferPct = async (db: PoolClient, siteId: string) =>
  Number((await plantPlanning(db, siteId)).execution_buffer_pct ?? 25);

@Controller('api')
export class ExecutionController {
  // ---------- Make order release ----------
  @Post('plants/:plantId/make-orders/release') async releaseMake(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const raw = body(req, ['item', 'runNo']);
    const code = String(raw.item ?? '').trim();
    return mutate(req, 'production.execute', async (db, actor) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const runNo = await currentRun(db, raw);
      const item = (await db.query('SELECT id,code FROM items WHERE lower(code)=lower($1)', [code]))
        .rows[0];
      if (!item) fail(404, 'NOT_FOUND', `Item ${code} is not in the item master.`);
      const rec = await makeRecommendation(db, plant.id, item.id);
      if (!rec || rec.recommended_kind !== 'MAKE' || !(Number(rec.recommended_qty) > 0))
        fail(409, 'NO_RECOMMENDATION', `${item.code} has no make recommendation in run #${runNo}.`);
      const d = await recordDecision(db, actor, plant.id, runNo, 'make_release', [], {
        item: item.code,
        qty: Number(rec.recommended_qty),
        due: rec.due,
        zone: rec.zone,
      });
      const order = await releaseMakeOrder(db, actor, plant.id, rec, d.no);
      await audit(db, actor, 'production.make_released', 'production_order', order, null, {
        plant: plant.code,
        item: item.code,
        qty: Number(rec.recommended_qty),
        due: rec.due,
      });
      return {
        decisionNo: d.no,
        order,
        message: `Decision #${d.no}: make order ${order} for ${Number(rec.recommended_qty)} ${item.code} due ${rec.due} (${rec.zone}). It is in the book and the schedule recalculates in a few seconds.`,
      };
    });
  }

  // ---------- The two events ----------
  @Get('plants/:plantId/execution') async execution(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      return listExecution(db, plant.id, await bufferPct(db, plant.id));
    });
  }

  @Post('plants/:plantId/work-orders/release') async release(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const raw = body(req, ['order', 'runNo']);
    const orderNo = String(raw.order ?? '').trim();
    return mutate(req, 'production.execute', async (db, actor) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const runNo = await currentRun(db, raw);
      const order = await workOrder(db, plant.id, orderNo);
      if (!order) fail(404, 'NOT_FOUND', `Order ${orderNo} is not in this plant.`);
      if (order.execution_state !== 'planned')
        fail(409, 'INVALID_STATE', `${orderNo} is already ${order.execution_state}.`);
      if (order.status !== 'OPEN') fail(409, 'INVALID_STATE', `${orderNo} is closed.`);
      const today = await planningDate(db);
      const r = await releaseWork(db, actor, plant.id, order, today);
      if (r.planned === null)
        fail(
          409,
          'NOT_SCHEDULED',
          `${orderNo} is not on the calculated schedule: it cannot be released.`,
        );
      await audit(
        db,
        actor,
        'production.released',
        'production_order',
        order.id,
        { state: 'planned' },
        {
          state: 'released',
          plannedMinutes: r.planned,
          runNo,
        },
      );
      return {
        release: r.release,
        plannedMinutes: r.planned,
        message: `${orderNo} released with ${Math.round(r.planned ?? 0)} planned work minutes. Released work keeps its place in the book and is not re-sequenced.`,
      };
    });
  }

  @Post('plants/:plantId/work-orders/complete') async complete(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const raw = body(req, ['order', 'date', 'quantity', 'elapsed']);
    const orderNo = String(raw.order ?? '').trim();
    const date = isoDate(raw.date, 'Completion date');
    const elapsed = num(raw.elapsed, 'Elapsed work minutes', 0, 10_000_000);
    return mutate(req, 'production.execute', async (db, actor) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const order = await workOrder(db, plant.id, orderNo);
      if (!order) fail(404, 'NOT_FOUND', `Order ${orderNo} is not in this plant.`);
      if (order.execution_state !== 'released')
        fail(409, 'INVALID_STATE', `Release ${orderNo} before completing it.`);
      const quantity = num(raw.quantity, 'Completed quantity', 0.000001, Number(order.quantity));
      const today = await planningDate(db);
      if (date < order.released_date.toISOString().slice(0, 10))
        fail(400, 'VALIDATION_ERROR', 'The completion cannot be before the release.');
      if (date > today) fail(400, 'VALIDATION_ERROR', `The completion cannot be after ${today}.`);
      await completeWork(db, actor, order, { date, quantity, elapsed });
      const short = quantity < Number(order.quantity) - 1e-6;
      await audit(
        db,
        actor,
        'production.completed',
        'production_order',
        order.id,
        { state: 'released' },
        {
          state: 'completed',
          date,
          quantity,
          elapsed,
        },
      );
      const planned = Number(order.planned_minutes ?? 0);
      const pct = planned > 0 ? Math.round(((elapsed - planned) / planned) * 100) : null;
      return {
        message: `${orderNo} completed on ${date}: ${quantity} of ${Number(order.quantity)}${short ? ' (short: the order is closed)' : ''}, ${Math.round(elapsed)} work minutes against ${Math.round(planned)} planned${pct === null ? '' : ` (${pct > 0 ? '+' : ''}${pct}%)`}. The schedule recalculates in a few seconds.`,
      };
    });
  }

  // ---------- Downtime ----------
  @Get('plants/:plantId/downtime') async downtime(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      return { items: await listDowntime(db, plant.id), atRisk: await atRiskOrders(db, plant.id) };
    });
  }

  @Post('plants/:plantId/downtime') async logStop(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const raw = body(req, ['resource', 'machine', 'date', 'minutes', 'reason']);
    const date = isoDate(raw.date, 'Downtime date');
    const minutes = num(raw.minutes, 'Minutes lost', 1, 1440);
    const reason = String(raw.reason ?? '').trim();
    if (!reason || reason.length > 200)
      fail(400, 'VALIDATION_ERROR', 'Give the reason (up to 200 characters).');
    return mutate(req, 'production.execute', async (db, actor) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const resource = (
        await db.query(
          'SELECT id,code,machine_count FROM resources WHERE site_id=$1 AND lower(code)=lower($2)',
          [plant.id, String(raw.resource ?? '').trim()],
        )
      ).rows[0];
      if (!resource) fail(404, 'NOT_FOUND', `Resource ${raw.resource} is not in this plant.`);
      const machine =
        raw.machine === undefined || raw.machine === null || raw.machine === ''
          ? null
          : num(raw.machine, 'Machine', 1, Number(resource.machine_count));
      const d = await recordDecision(
        db,
        actor,
        plant.id,
        await currentRun(db, null),
        'downtime',
        [],
        {
          resource: resource.code,
          machine,
          date,
          minutes,
          reason,
        },
      );
      const e = await logDowntime(db, actor, plant.id, {
        resourceId: resource.id,
        machine,
        date,
        minutes,
        reason,
      });
      await audit(db, actor, 'production.downtime', 'downtime_event', e.id, null, {
        plant: plant.code,
        resource: resource.code,
        machine,
        date,
        minutes,
        reason,
      });
      return {
        decisionNo: d.no,
        event: e.no,
        message: `DT-${e.no}: ${minutes} minutes lost on ${resource.code}${machine ? ' machine ' + machine : ''} on ${date}. The schedule recalculates; check which promises are now at risk.`,
      };
    });
  }

  @Post('plants/:plantId/downtime/:eventId/close') async closeStop(
    @Req() req: Request,
    @Param('plantId') plantId: string,
    @Param('eventId') eventId: string,
  ) {
    body(req, []);
    return mutate(req, 'production.execute', async (db, actor) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const e = (
        await db.query('SELECT * FROM downtime_events WHERE id=$1 AND site_id=$2 FOR UPDATE', [
          id(eventId),
          plant.id,
        ])
      ).rows[0];
      if (!e) fail(404, 'NOT_FOUND', 'Downtime event not found.');
      if (e.state === 'closed') fail(409, 'INVALID_STATE', 'This event is already closed.');
      await db.query("UPDATE downtime_events SET state='closed',updated_at=now() WHERE id=$1", [
        e.id,
      ]);
      await audit(
        db,
        actor,
        'production.downtime_closed',
        'downtime_event',
        e.id,
        { state: 'open' },
        {
          state: 'closed',
        },
      );
      return {
        message: `DT-${Number(e.event_no)} closed: the machine is back and the schedule recalculates.`,
      };
    });
  }

  // ---------- Master-data self-audit ----------
  @Get('plants/:plantId/cycle-time-audit') async auditList(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const today = await planningDate(db);
      const a = await cycleTimeAudit(db, plant.id, today, cycleTimeAuditOptions);
      return {
        ...a,
        rows: a.rows.map((r: any) => ({
          item: r.item,
          standard: r.standard,
          actual: r.actual,
          completions: r.completions,
          drift: r.drift,
          consistent: r.consistent,
          flagged: r.flagged,
          proposed: r.actual,
          adoptedAt: r.adoptedAt,
        })),
        rule: cycleTimeAuditOptions,
      };
    });
  }

  @Post('plants/:plantId/cycle-time-audit/adopt') async adopt(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const raw = body(req, ['item']);
    const code = String(raw.item ?? '').trim();
    return mutate(req, 'masters.cycle_time', async (db, actor) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const today = await planningDate(db);
      const a = await cycleTimeAudit(db, plant.id, today, cycleTimeAuditOptions);
      const row = a.rows.find((r: any) => String(r.item).toLowerCase() === code.toLowerCase());
      if (!row) fail(404, 'NOT_FOUND', `${code} has no completed work orders to audit.`);
      if (!row.flagged)
        fail(
          409,
          'NOT_FLAGGED',
          `${code} is inside the audit rule (${row.completions} completions, ${row.drift}% drift): there is nothing to correct.`,
        );
      const d = await recordDecision(
        db,
        actor,
        plant.id,
        await currentRun(db, null),
        'cycle_time_adopt',
        [],
        {
          item: row.item,
          standard: row.standard,
          actual: row.actual,
          drift: row.drift,
          completions: row.completions,
        },
      );
      const w = await adoptCycleTime(db, actor, plant.id, row, today);
      await audit(
        db,
        actor,
        'masters.cycle_time_adopted',
        'routing',
        w.routingId,
        {
          perUnit: row.standard,
        },
        { perUnit: row.actual, revision: w.revision, completions: row.completions },
      );
      return {
        decisionNo: d.no,
        revision: w.revision,
        message: `Decision #${d.no}: ${row.item} cycle time corrected from ${row.standard} to ${row.actual} min per unit (${row.drift > 0 ? '+' : ''}${row.drift}% over ${row.completions} completions) as routing ${w.revision}. The schedule recalculates in a few seconds.`,
      };
    });
  }
}
