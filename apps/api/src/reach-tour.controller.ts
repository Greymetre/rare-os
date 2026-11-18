// RCH-3: the month a rep intends to walk, and how it read afterwards.
//
// Three rules shape every route here.
//
// A rep builds their own month and nobody else's: the rep is taken from the signed-in login, so
// a rep id in a request body is never trusted, and a manager approves a month or sends it back
// rather than editing it. That was a deliberate answer to question 8 of the milestone plan —
// letting a manager type into someone else's plan makes the adherence number meaningless.
//
// A month stops being editable once it is submitted. After it is approved, a day moves by
// request, and approving that request moves that one day and nothing else.
//
// And nothing about how the month turned out is ever written. Followed, Partial, Deviated,
// Missed and Unplanned are read from the plan, the visits and the attendance register at the
// moment they are asked for.
import { Controller, Get, Param, Post, Put, Req } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import type { Request } from 'express';
import { access, fail, scoped } from './core.js';
import { audit, body, id, mutate, text, version } from './access.controller.js';
import { datesBetween } from '../../../packages/engines/attendance.mjs';
import { monthSpan } from '../../../packages/engines/tour-plan.mjs';
import { saveReachSettings } from '../../../packages/schema/customers-db.mjs';
import { repForUser, findRep } from '../../../packages/schema/attendance-db.mjs';
import {
  adherenceFor,
  autoFillPlan,
  beatsForRep,
  checksFor,
  createPlan,
  decideDayChange,
  decidePlan,
  EDITABLE,
  findChange,
  findPlan,
  findPlanById,
  listChanges,
  planBoard,
  planDays,
  planSettings,
  requestDayChange,
  savePlanDay,
  submitPlan,
  touchPlan,
} from '../../../packages/schema/tour-db.mjs';

const PLAN_DECISIONS = ['APPROVED', 'SENT_BACK'];
const CHANGE_DECISIONS = ['APPROVED', 'REJECTED'];
// Adherence may be asked for a year at a time and no more, so one request cannot walk the whole
// history of a company in a single call.
const MAX_SPAN_DAYS = 366;

function invalid(errors: { column: string; message: string }[]): never {
  throw new HttpException(
    { code: 'VALIDATION_ERROR', message: errors.map((e) => e.message).join(' '), fields: errors },
    400,
  );
}

function isoDate(value: unknown, label: string): string {
  const v = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || datesBetween(v, v).length !== 1)
    fail(400, 'VALIDATION_ERROR', `${label} must be a date written as YYYY-MM-DD.`);
  return v;
}

// A month a caller may ask for. Written as YYYY-MM, because a plan is a month and not a span.
function isoMonth(value: unknown, label = 'Month'): string {
  const v = String(value ?? '').trim();
  if (!monthSpan(v)) fail(400, 'VALIDATION_ERROR', `${label} must be written as YYYY-MM.`);
  return v;
}

function spanOf(req: Request) {
  const from = isoDate(req.query.from, 'From');
  const to = isoDate(req.query.to, 'To');
  const days = datesBetween(from, to).length;
  if (!days) fail(400, 'VALIDATION_ERROR', 'The To date cannot be before the From date.');
  if (days > MAX_SPAN_DAYS)
    fail(400, 'RANGE_TOO_WIDE', `Ask for at most ${MAX_SPAN_DAYS} days at a time.`);
  return { from, to };
}

@Controller('api')
export class ReachTourController {
  // Who the signed-in person is as a field rep. A login with no rep record has no month to
  // build, and is told so plainly rather than handed an empty calendar.
  private async me(db: any, actor: { id: string }) {
    const rep = await repForUser(db, actor.id);
    if (!rep)
      fail(
        403,
        'NOT_A_FIELD_REP',
        'This login is not linked to a field rep, so it has no tour plan. Ask an administrator to link it.',
      );
    // `fail` always throws, but it carries no explicit `never`, so TypeScript cannot see that.
    return rep!;
  }

  // A rep may always read their own month. Reading anyone else's needs reach.read.
  private async readableRep(db: any, actor: any, wanted: string | null) {
    if (!wanted) return this.me(db, actor);
    const rep = await findRep(db, wanted);
    if (!rep) fail(404, 'RECORD_NOT_FOUND', 'That field rep was not found.');
    const own = await repForUser(db, actor.id);
    if (own?.id !== rep!.id && !actor.permissions.includes('reach.read'))
      fail(403, 'FORBIDDEN', 'You may only read your own tour plan.');
    return rep!;
  }

  // The plan a write is aimed at, confirmed to be the signed-in rep's own and still editable.
  // A manager decides a month; they never type into it.
  private async ownEditablePlan(db: any, actor: any, planId: string) {
    const plan = await findPlanById(db, planId);
    if (!plan) fail(404, 'RECORD_NOT_FOUND', 'That tour plan was not found.');
    const rep = await this.me(db, actor);
    if (plan!.rep_id !== rep.id)
      fail(403, 'FORBIDDEN', 'A tour plan is built by the rep who walks it.');
    if (!EDITABLE.includes(plan!.status))
      fail(
        409,
        'PLAN_LOCKED',
        plan!.status === 'APPROVED'
          ? 'This month is approved. Ask for a day change instead of editing it.'
          : 'This month is waiting for a decision and cannot be changed.',
      );
    return { plan: plan!, rep };
  }

  // ---------- One rep's month ----------

  @Get('reach/tour/plan') async plan(@Req() req: Request) {
    const actor = await access(req, 'reach.plan');
    const month = isoMonth(req.query.month);
    const wanted = req.query.rep === undefined ? null : id(req.query.rep);
    return scoped(actor.tenant_id, async (db) => {
      const settings = await planSettings(db);
      const rep = await this.readableRep(db, actor, wanted);
      const plan = await findPlan(db, { repId: rep.id, month });
      const span = monthSpan(month)!;
      const own = await repForUser(db, actor.id);
      // The rounds travel with the screen. Listing beats needs reach.read, and a rep building
      // their own month is not given the right to read everyone else's field data.
      const beats = await beatsForRep(db, rep.id, span.from, span.to);
      // The days and the checks are read together: judging the month means reading it.
      const read = plan
        ? await checksFor(db, plan, settings)
        : {
            days: [],
            holidays: [],
            checks: [],
            ready: false,
            workingDays: 0,
            fieldDays: 0,
            fieldPct: 0,
          };
      return {
        month,
        rep: { id: rep.id, code: rep.code, name: rep.name },
        plan,
        ...read,
        beats,
        limits: {
          due_day: settings.plan_due_day,
          max_outlets: settings.plan_max_outlets,
          field_days_pct: settings.plan_field_days_pct,
          followed_pct: settings.plan_followed_pct,
        },
        mine: own?.id === rep.id,
        canApprove: actor.permissions.includes('reach.plan_approve'),
      };
    });
  }

  @Post('reach/tour/plan') async start(@Req() req: Request) {
    const raw = body(req, ['month', 'note']);
    const month = isoMonth(raw.month);
    const note = raw.note === undefined ? '' : text(raw.note, 'Note', 0, 300);

    return mutate(req, 'reach.plan', async (db, actor) => {
      const rep = await this.me(db, actor);
      if (await findPlan(db, { repId: rep.id, month }))
        fail(409, 'ALREADY_EXISTS', `You already have a plan for ${month}.`);
      const planId = crypto.randomUUID();
      await createPlan(db, actor.tenant_id, { id: planId, repId: rep.id, month, note });
      await audit(db, actor, 'tour_plan.started', 'tour_plans', planId, null, {
        rep: rep.code,
        month,
      });
      return { id: planId, month, message: `Tour plan started for ${month}.` };
    });
  }

  @Post('reach/tour/plan/:id/autofill') async autofill(
    @Req() req: Request,
    @Param('id') planId: string,
  ) {
    id(planId);
    const v = version(body(req, ['version']).version);

    return mutate(req, 'reach.plan', async (db, actor) => {
      const { plan, rep } = await this.ownEditablePlan(db, actor, planId);
      if (plan.version !== v)
        fail(409, 'STALE_RECORD', 'This month changed elsewhere. Refresh and try again.');
      const filled = await autoFillPlan(db, actor.tenant_id, plan);
      if (!(await touchPlan(db, { id: planId, version: v })))
        fail(409, 'STALE_RECORD', 'This month changed elsewhere. Refresh and try again.');
      await audit(db, actor, 'tour_plan.autofilled', 'tour_plans', planId, null, {
        rep: rep.code,
        month: plan.month,
        days: filled.written,
        kept: filled.kept,
      });
      return {
        ...filled,
        message: filled.written
          ? `${filled.written} ${filled.written === 1 ? 'day' : 'days'} laid out from the beat calendar.`
          : 'The beat calendar had nothing to propose for this month.',
      };
    });
  }

  @Put('reach/tour/plan/:id/day') async setDay(@Req() req: Request, @Param('id') planId: string) {
    id(planId);
    const raw = body(req, ['work_date', 'beat_id', 'outlet_count', 'objective', 'version']);
    const workDate = isoDate(raw.work_date, 'Date');
    const beatId = raw.beat_id === undefined || raw.beat_id === null ? null : id(raw.beat_id);
    const objective = raw.objective === undefined ? '' : text(raw.objective, 'Objective', 0, 200);
    const v = version(raw.version);

    return mutate(req, 'reach.plan', async (db, actor) => {
      const settings = await planSettings(db);
      const { plan, rep } = await this.ownEditablePlan(db, actor, planId);
      if (plan.version !== v)
        fail(409, 'STALE_RECORD', 'This month changed elsewhere. Refresh and try again.');
      const span = monthSpan(plan.month)!;
      if (workDate < span.from || workDate > span.to)
        fail(400, 'VALIDATION_ERROR', `That date is not in ${plan.month}.`);

      const day = await this.dayFrom(db, rep.id, span, { beatId, raw, settings });
      await savePlanDay(db, actor.tenant_id, { planId, workDate, ...day, source: 'MANUAL' });
      if (!(await touchPlan(db, { id: planId, version: v })))
        fail(409, 'STALE_RECORD', 'This month changed elsewhere. Refresh and try again.');
      await audit(db, actor, 'tour_plan.day_set', 'tour_plan_days', planId, null, {
        rep: rep.code,
        date: workDate,
        beat: day.beat ?? '',
        outlets: day.outletCount,
      });
      return {
        message: beatId
          ? `${workDate} is now ${day.beat}.`
          : `${workDate} is no longer a field day.`,
      };
    });
  }

  // What a day is to become. The town is never typed: it comes from the round, so a plan cannot
  // claim a rep was sent to a town the round does not pass through.
  private async dayFrom(
    db: any,
    repId: string,
    span: { from: string; to: string },
    {
      beatId,
      raw,
      settings,
    }: { beatId: string | null; raw: Record<string, unknown>; settings: any },
  ) {
    if (!beatId)
      return { beatId: null, town: '', outletCount: 0, objective: String(raw.objective ?? '') };

    const beats = await beatsForRep(db, repId, span.from, span.to);
    const beat = beats.find((b: any) => b.id === beatId);
    if (!beat) fail(404, 'RECORD_NOT_FOUND', 'That round is not one this rep holds in this month.');

    const cap = Number(settings.plan_max_outlets);
    const asked =
      raw.outlet_count === undefined || raw.outlet_count === null
        ? beat!.outlet_count
        : Number(raw.outlet_count);
    if (!Number.isInteger(asked) || asked < 0 || asked > 500)
      invalid([{ column: 'outlet_count', message: 'Outlets must be a whole number.' }]);
    if (asked > cap)
      invalid([
        {
          column: 'outlet_count',
          message: `This company plans at most ${cap} outlets in a day.`,
        },
      ]);
    return {
      beatId,
      beat: beat!.code,
      town: beat!.town,
      outletCount: asked,
      objective: raw.objective === undefined ? '' : String(raw.objective),
    };
  }

  @Post('reach/tour/plan/:id/submit') async submit(
    @Req() req: Request,
    @Param('id') planId: string,
  ) {
    id(planId);
    const v = version(body(req, ['version']).version);

    return mutate(req, 'reach.plan', async (db, actor) => {
      const settings = await planSettings(db);
      const { plan, rep } = await this.ownEditablePlan(db, actor, planId);
      if (plan.version !== v)
        fail(409, 'STALE_RECORD', 'This month changed elsewhere. Refresh and try again.');
      const checks = await checksFor(db, plan, settings);
      if (!checks.ready)
        fail(
          400,
          'PLAN_NOT_READY',
          checks.checks
            .filter((c: any) => !c.ok)
            .map((c: any) => c.message)
            .join(' '),
        );
      if (!(await submitPlan(db, actor.id, { id: planId, version: v })))
        fail(409, 'STALE_RECORD', 'This month changed elsewhere. Refresh and try again.');
      await audit(db, actor, 'tour_plan.submitted', 'tour_plans', planId, null, {
        rep: rep.code,
        month: plan.month,
        field_days: checks.fieldDays,
      });
      return { message: `${plan.month} submitted for approval.` };
    });
  }

  @Post('reach/tour/plan/:id/decide') async decide(
    @Req() req: Request,
    @Param('id') planId: string,
  ) {
    id(planId);
    const raw = body(req, ['status', 'reason', 'version']);
    const status = String(raw.status ?? '');
    if (!PLAN_DECISIONS.includes(status))
      fail(400, 'VALIDATION_ERROR', 'A tour plan is either approved or sent back.');
    // Sending a month back without saying why teaches the rep nothing, so the reason is required.
    const reason =
      raw.reason === undefined && status !== 'SENT_BACK'
        ? ''
        : text(raw.reason, 'Reason', status === 'SENT_BACK' ? 1 : 0, 300);
    const v = version(raw.version);

    return mutate(req, 'reach.plan_approve', async (db, actor) => {
      const plan = await findPlanById(db, planId);
      if (!plan) fail(404, 'RECORD_NOT_FOUND', 'That tour plan was not found.');
      if (plan!.status !== 'SUBMITTED')
        fail(409, 'STALE_RECORD', 'This month is not waiting for a decision.');
      if (!(await decidePlan(db, actor.id, { id: planId, version: v, status, reason })))
        fail(409, 'STALE_RECORD', 'This month changed elsewhere. Refresh and try again.');
      await audit(db, actor, 'tour_plan.decided', 'tour_plans', planId, null, {
        rep: plan!.rep,
        month: plan!.month,
        status,
        reason,
      });
      return {
        message: status === 'APPROVED' ? `${plan!.month} approved.` : `${plan!.month} sent back.`,
      };
    });
  }

  // ---------- Everyone's month ----------

  @Get('reach/tour/plans') async plans(@Req() req: Request) {
    const actor = await access(req, 'reach.read');
    const month = isoMonth(req.query.month);
    const territoryId = req.query.territory === undefined ? null : id(req.query.territory);
    const status = req.query.status === undefined ? null : text(req.query.status, 'Status', 0, 20);
    return scoped(actor.tenant_id, async (db) => {
      const settings = await planSettings(db);
      return {
        ...(await planBoard(db, { month, territoryId, status: status || null })),
        dueDay: settings.plan_due_day,
        canApprove: actor.permissions.includes('reach.plan_approve'),
      };
    });
  }

  // ---------- Moving one day of an approved month ----------

  @Get('reach/tour/changes') async changes(@Req() req: Request) {
    const actor = await access(req, 'reach.plan');
    const status =
      req.query.status === undefined ? 'PENDING' : text(req.query.status, 'Status', 0, 20);
    const mine = req.query.mine === 'true';
    return scoped(actor.tenant_id, async (db) => {
      const own = await repForUser(db, actor.id);
      // Without reach.read a person sees their own requests and nobody else's.
      const repId = mine || !actor.permissions.includes('reach.read') ? (own?.id ?? null) : null;
      if (!repId && !actor.permissions.includes('reach.read'))
        fail(403, 'NOT_A_FIELD_REP', 'This login is not linked to a field rep.');
      return {
        ...(await listChanges(db, { repId, status: status || null })),
        canApprove: actor.permissions.includes('reach.plan_approve'),
      };
    });
  }

  @Post('reach/tour/plan/:id/change') async askChange(
    @Req() req: Request,
    @Param('id') planId: string,
  ) {
    id(planId);
    const raw = body(req, ['work_date', 'beat_id', 'outlet_count', 'objective', 'reason']);
    const workDate = isoDate(raw.work_date, 'Date');
    const beatId = raw.beat_id === undefined || raw.beat_id === null ? null : id(raw.beat_id);
    const reason = text(raw.reason, 'Reason', 1, 300);

    return mutate(req, 'reach.plan', async (db, actor) => {
      const settings = await planSettings(db);
      const plan = await findPlanById(db, planId);
      if (!plan) fail(404, 'RECORD_NOT_FOUND', 'That tour plan was not found.');
      const rep = await this.me(db, actor);
      if (plan!.rep_id !== rep.id)
        fail(403, 'FORBIDDEN', 'A day is moved by the rep who walks it.');
      // A month that is still editable is edited, not requested.
      if (plan!.status !== 'APPROVED')
        fail(409, 'PLAN_NOT_APPROVED', 'Only an approved month moves a day by request.');
      const span = monthSpan(plan!.month)!;
      if (workDate < span.from || workDate > span.to)
        fail(400, 'VALIDATION_ERROR', `That date is not in ${plan!.month}.`);

      const day = await this.dayFrom(db, rep.id, span, { beatId, raw, settings });
      const previous =
        (await planDays(db, planId)).find((d: any) => d.work_date === workDate) ?? null;

      const changeId = crypto.randomUUID();
      try {
        await requestDayChange(db, actor.tenant_id, {
          id: changeId,
          planId,
          repId: rep.id,
          workDate,
          beatId: day.beatId,
          town: day.town,
          outletCount: day.outletCount,
          objective: day.objective,
          reason,
          previous,
        });
      } catch (e: any) {
        if (e?.code === '23505')
          fail(409, 'ALREADY_EXISTS', 'A change for that day is already waiting for a decision.');
        throw e;
      }
      await audit(db, actor, 'tour_plan.change_requested', 'tour_plan_changes', changeId, null, {
        rep: rep.code,
        date: workDate,
        from: previous?.beat ?? '',
        to: day.beat ?? '',
      });
      return { id: changeId, message: `A change to ${workDate} was requested.` };
    });
  }

  @Post('reach/tour/changes/:id/decide') async decideChange(
    @Req() req: Request,
    @Param('id') changeId: string,
  ) {
    id(changeId);
    const raw = body(req, ['status', 'reason']);
    const status = String(raw.status ?? '');
    if (!CHANGE_DECISIONS.includes(status))
      fail(400, 'VALIDATION_ERROR', 'A change request is either approved or rejected.');
    const reason =
      raw.reason === undefined && status !== 'REJECTED'
        ? ''
        : text(raw.reason, 'Reason', status === 'REJECTED' ? 1 : 0, 300);

    return mutate(req, 'reach.plan_approve', async (db, actor) => {
      const change = await findChange(db, changeId);
      if (!change) fail(404, 'RECORD_NOT_FOUND', 'That change request was not found.');
      if (change!.status !== 'PENDING')
        fail(409, 'STALE_RECORD', 'This request was already decided.');
      if (
        !(await decideDayChange(db, actor.id, actor.tenant_id, { change: change!, status, reason }))
      )
        fail(409, 'STALE_RECORD', 'This request was already decided, or changed elsewhere.');
      await audit(db, actor, 'tour_plan.change_decided', 'tour_plan_changes', changeId, null, {
        rep: change!.rep,
        date: change!.work_date,
        status,
        reason,
      });
      return {
        message: status === 'APPROVED' ? `${change!.work_date} moved.` : 'Change request rejected.',
      };
    });
  }

  // ---------- Plan vs actual ----------

  @Get('reach/tour/adherence') async adherence(@Req() req: Request) {
    const actor = await access(req, 'reach.plan');
    const { from, to } = spanOf(req);
    const wanted = req.query.rep === undefined ? null : id(req.query.rep);
    return scoped(actor.tenant_id, async (db) => {
      const settings = await planSettings(db);
      const rep = await this.readableRep(db, actor, wanted);
      return adherenceFor(db, { repId: rep.id, from, to }, settings);
    });
  }

  // ---------- Setup ----------

  @Put('reach/tour/settings') async saveSettings(@Req() req: Request) {
    const raw = body(req, [
      'plan_due_day',
      'plan_max_outlets',
      'plan_field_days_pct',
      'plan_followed_pct',
      'version',
    ]);
    if (!Number.isInteger(raw.version) || raw.version < 0)
      fail(400, 'VERSION_REQUIRED', 'Settings version is missing. Refresh before saving.');
    const bounds = {
      plan_due_day: [1, 28],
      plan_max_outlets: [1, 100],
      plan_field_days_pct: [0, 100],
      plan_followed_pct: [1, 100],
    } as const;
    const errors: { column: string; message: string }[] = [];
    const value: Record<string, unknown> = {};
    for (const [key, [low, high]] of Object.entries(bounds)) {
      const given = raw[key];
      if (!Number.isInteger(given) || given < low || given > high)
        errors.push({
          column: key,
          message: `This must be a whole number from ${low} to ${high}.`,
        });
      else value[key] = given;
    }
    if (errors.length) invalid(errors);

    return mutate(req, 'reach.setup', async (db, actor) => {
      const current = await planSettings(db);
      if (current.version !== Number(raw.version))
        fail(409, 'STALE_RECORD', 'These settings changed elsewhere. Refresh before saving.');
      await saveReachSettings(db, actor.tenant_id, value);
      await audit(
        db,
        actor,
        'reach.settings_changed',
        'reach_settings',
        actor.tenant_id,
        null,
        value,
      );
      return { message: 'Tour plan settings saved.' };
    });
  }
}
