// RCH-4: checking in, checking out, and the report a rep writes on the way out.
//
// The milestone plan calls this the heart of Reach, and the handover is explicit that it has to
// be solid on the server before a mobile app is written against it. So three rules are enforced
// here rather than left to a screen.
//
// **A check-in is never refused for being far away.** A rep standing 800 metres from the shop is
// recorded and flagged. Nothing in this file turns one away on that ground: refusing it would
// lose a real visit and teach the salesman to distrust the app. The only check-in this refuses is
// one to a shop that does not exist.
//
// **A repeat is the same visit.** A field connection drops and the app retries, so check-in is
// idempotent: it answers a repeat with the visit that already exists, and says so. A device may
// send its own reference to make that exact even across a long outage.
//
// **The rep is the signed-in login.** A rep id in a request body is never read, so nobody records
// a visit in somebody else's name.
import { Controller, Get, Param, Post, Put, Req, Res } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { access, fail, scoped } from './core.js';
import { audit, body, id, mutate, text, version } from './access.controller.js';
import { toCsv } from '../../../packages/schema/imports.mjs';
import { datesBetween } from '../../../packages/engines/attendance.mjs';
import { saveReachSettings } from '../../../packages/schema/customers-db.mjs';
import { repForUser, findRep, todayFor } from '../../../packages/schema/attendance-db.mjs';
import {
  amendReport,
  callableCustomer,
  checkIn,
  checkOut,
  checkReport,
  existingVisit,
  findVisit,
  listVisits,
  repDay,
  visitBoard,
  visitCsvRows,
  visitFormFor,
  visitSettings,
  VISIT_COLUMNS_CSV,
} from '../../../packages/schema/visit-db.mjs';

const GEO_SOURCES = ['DEVICE', 'TYPED', 'PIN'];
// One request may ask for a year of calls and no more, so it cannot walk a company's whole
// history in a single call.
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

function spanOf(req: Request) {
  const from = isoDate(req.query.from, 'From');
  const to = isoDate(req.query.to, 'To');
  const days = datesBetween(from, to).length;
  if (!days) fail(400, 'VALIDATION_ERROR', 'The To date cannot be before the From date.');
  if (days > MAX_SPAN_DAYS)
    fail(400, 'RANGE_TOO_WIDE', `Ask for at most ${MAX_SPAN_DAYS} days at a time.`);
  return { from, to };
}

function coordinate(value: unknown, label: string, bound: number): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < -bound || n > bound)
    fail(400, 'VALIDATION_ERROR', `${label} must be a number between -${bound} and ${bound}.`);
  return n;
}

// Where the device says it is. The source is never inferred: a typed location has to say so.
function placeOf(raw: Record<string, unknown>) {
  const source = String(raw.source ?? 'DEVICE');
  if (!GEO_SOURCES.includes(source))
    fail(400, 'VALIDATION_ERROR', 'The location source is not one this system accepts.');
  const accuracy =
    raw.accuracy_m === undefined || raw.accuracy_m === null ? null : Number(raw.accuracy_m);
  if (accuracy !== null && (!Number.isInteger(accuracy) || accuracy < 0 || accuracy > 100000))
    fail(400, 'VALIDATION_ERROR', 'Accuracy must be a whole number of metres.');
  return {
    latitude: coordinate(raw.latitude, 'Latitude', 90),
    longitude: coordinate(raw.longitude, 'Longitude', 180),
    accuracy_m: accuracy,
    source,
  };
}

// The answers, as sent. Only the shape is checked here; which of them the form actually asks for
// is the database layer's job, because only it knows this customer type's form.
function reportOf(raw: unknown) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw))
    fail(400, 'VALIDATION_ERROR', 'The report must be a set of answers.');
  return raw as Record<string, unknown>;
}

@Controller('api')
export class ReachVisitController {
  // Who the signed-in person is as a field rep. A login with no rep record cannot call on a shop,
  // and is told so plainly rather than handed an empty screen.
  private async me(db: any, actor: { id: string }) {
    const rep = await repForUser(db, actor.id);
    if (!rep)
      fail(
        403,
        'NOT_A_FIELD_REP',
        'This login is not linked to a field rep, so it cannot record a visit. Ask an administrator to link it.',
      );
    // `fail` always throws, but it carries no explicit `never`, so TypeScript cannot see that.
    return rep!;
  }

  // A rep may always read their own calls. Reading anyone else's needs reach.read.
  private async readableRep(db: any, actor: any, wanted: string | null) {
    if (!wanted) return this.me(db, actor);
    const rep = await findRep(db, wanted);
    if (!rep) fail(404, 'RECORD_NOT_FOUND', 'That field rep was not found.');
    const own = await repForUser(db, actor.id);
    if (own?.id !== rep!.id && !actor.permissions.includes('reach.read'))
      fail(403, 'FORBIDDEN', 'You may only read your own visits.');
    return rep!;
  }

  // ---------- The field app ----------

  @Get('reach/visits/my-day') async myDay(@Req() req: Request) {
    const actor = await access(req, 'reach.visit');
    return scoped(actor.tenant_id, async (db) => {
      const settings = await visitSettings(db);
      const rep = await this.me(db, actor);
      const date =
        req.query.date === undefined
          ? await todayFor(db, settings)
          : isoDate(req.query.date, 'Date');
      return {
        ...(await repDay(db, { repId: rep.id, workDate: date })),
        rep: { id: rep.id, code: rep.code, name: rep.name },
        timezone: settings.timezone,
      };
    });
  }

  // The questions this shop's type asks on the way out, so the field app can draw the form
  // without the right to read the form masters themselves.
  @Get('reach/visits/form/:customerId') async form(
    @Req() req: Request,
    @Param('customerId') customerId: string,
  ) {
    id(customerId);
    const actor = await access(req, 'reach.visit');
    return scoped(actor.tenant_id, async (db) => {
      const customer = await callableCustomer(db, customerId);
      if (!customer) fail(404, 'RECORD_NOT_FOUND', 'That customer was not found.');
      return {
        customer: {
          id: customer!.id,
          code: customer!.code,
          name: customer!.name,
          town: customer!.town,
          type: customer!.type,
          checkin_radius_m: customer!.checkin_radius_m,
          min_visit_minutes: customer!.min_visit_minutes,
        },
        form: await visitFormFor(db, customer!.type_id),
      };
    });
  }

  // ---------- Checking in ----------

  @Post('reach/visits/check-in') async arrive(@Req() req: Request) {
    const raw = body(req, [
      'customer_id',
      'latitude',
      'longitude',
      'accuracy_m',
      'source',
      'client_ref',
      'note',
    ]);
    const customerId = id(raw.customer_id);
    const at = placeOf(raw);
    const clientRef = raw.client_ref === undefined ? '' : text(raw.client_ref, 'Reference', 0, 80);
    const note = raw.note === undefined ? '' : text(raw.note, 'Note', 0, 300);

    return mutate(req, 'reach.visit', async (db, actor) => {
      const settings = await visitSettings(db);
      const rep = await this.me(db, actor);
      const date = await todayFor(db, settings);
      const customer = await callableCustomer(db, customerId);
      if (!customer) fail(404, 'RECORD_NOT_FOUND', 'That customer was not found.');

      // A retry on a bad line is answered with the visit that already exists. Nothing is written
      // and nothing is refused: the app gets back the same visit it was trying to create.
      const already = await existingVisit(db, {
        repId: rep.id,
        customerId,
        workDate: date,
        clientRef,
        settings,
      });
      if (already)
        return {
          id: already.id,
          repeated: true,
          out_of_fence: already.out_of_fence,
          distance_m: already.distance_m,
          message: `Already checked in at ${customer!.name}.`,
        };

      const visitId = crypto.randomUUID();
      const done = await checkIn(db, actor.tenant_id, {
        id: visitId,
        repId: rep.id,
        customer: customer!,
        workDate: date,
        at,
        clientRef,
        note,
      });
      await audit(db, actor, 'visit.checked_in', 'visits', visitId, null, {
        rep: rep.code,
        customer: customer!.code,
        date,
        distance_m: done.distance_m,
        out_of_fence: done.out_of_fence,
      });
      return {
        id: visitId,
        repeated: false,
        out_of_fence: done.out_of_fence,
        distance_m: done.distance_m,
        // A flagged check-in is still a check-in. The message says what was recorded, not that
        // anything was refused.
        message: done.out_of_fence
          ? `Checked in at ${customer!.name}, ${done.distance_m} m from the shop. It is recorded and flagged.`
          : `Checked in at ${customer!.name}.`,
      };
    });
  }

  // ---------- Checking out ----------

  @Post('reach/visits/:id/check-out') async leave(
    @Req() req: Request,
    @Param('id') visitId: string,
  ) {
    id(visitId);
    const raw = body(req, ['report', 'latitude', 'longitude', 'accuracy_m', 'source', 'version']);
    const at = placeOf(raw);
    const report = reportOf(raw.report);
    const v = version(raw.version);

    return mutate(req, 'reach.visit', async (db, actor) => {
      const rep = await this.me(db, actor);
      const visit = await findVisit(db, visitId);
      if (!visit) fail(404, 'RECORD_NOT_FOUND', 'That visit was not found.');
      if (visit!.rep_id !== rep.id)
        fail(403, 'FORBIDDEN', 'You may only check out of your own visit.');
      if (visit!.checked_out_at) fail(409, 'ALREADY_CLOSED', 'This visit has already ended.');

      const checked = await checkReport(db, visit!.type_id, report);
      if (checked.errors.length) invalid(checked.errors);
      if (!(await checkOut(db, { visitId, version: v, at, report: checked.value })))
        fail(409, 'STALE_RECORD', 'This visit changed elsewhere. Refresh and try again.');

      const after = await findVisit(db, visitId);
      await audit(db, actor, 'visit.checked_out', 'visits', visitId, null, {
        rep: rep.code,
        customer: visit!.customer,
        minutes: after?.minutes ?? null,
      });
      return {
        id: visitId,
        minutes: after?.minutes ?? null,
        status: after?.status,
        message: `Checked out of ${visit!.customer_name}.`,
      };
    });
  }

  // A report may be corrected after the visit has ended. The visit itself is never reopened:
  // when the rep left is what happened, and that stands.
  @Put('reach/visits/:id/report') async correct(@Req() req: Request, @Param('id') visitId: string) {
    id(visitId);
    const raw = body(req, ['report', 'version']);
    const report = reportOf(raw.report);
    const v = version(raw.version);

    return mutate(req, 'reach.visit', async (db, actor) => {
      const rep = await this.me(db, actor);
      const visit = await findVisit(db, visitId);
      if (!visit) fail(404, 'RECORD_NOT_FOUND', 'That visit was not found.');
      if (visit!.rep_id !== rep.id) fail(403, 'FORBIDDEN', 'You may only correct your own report.');
      if (!visit!.checked_out_at)
        fail(409, 'NOT_CLOSED', 'This visit has not ended yet. Check out instead.');

      const checked = await checkReport(db, visit!.type_id, report);
      if (checked.errors.length) invalid(checked.errors);
      if (!(await amendReport(db, { visitId, version: v, report: checked.value })))
        fail(409, 'STALE_RECORD', 'This visit changed elsewhere. Refresh and try again.');
      await audit(db, actor, 'visit.report_corrected', 'visits', visitId, null, {
        rep: rep.code,
        customer: visit!.customer,
      });
      return { id: visitId, message: 'Report saved.' };
    });
  }

  // ---------- Reading visits ----------

  @Get('reach/visits') async list(@Req() req: Request) {
    const actor = await access(req, 'reach.visit');
    const { from, to } = spanOf(req);
    const wanted = req.query.rep === undefined ? null : id(req.query.rep);
    const customerId = req.query.customer === undefined ? null : id(req.query.customer);
    return scoped(actor.tenant_id, async (db) => {
      const rep = await this.readableRep(db, actor, wanted);
      return {
        ...(await listVisits(db, { repId: rep.id, customerId, from, to })),
        rep: { id: rep.id, code: rep.code, name: rep.name },
      };
    });
  }

  @Get('reach/visits/one/:id') async one(@Req() req: Request, @Param('id') visitId: string) {
    id(visitId);
    const actor = await access(req, 'reach.visit');
    return scoped(actor.tenant_id, async (db) => {
      const visit = await findVisit(db, visitId);
      if (!visit) fail(404, 'RECORD_NOT_FOUND', 'That visit was not found.');
      const own = await repForUser(db, actor.id);
      if (own?.id !== visit!.rep_id && !actor.permissions.includes('reach.read'))
        fail(403, 'FORBIDDEN', 'You may only read your own visits.');
      return visit;
    });
  }

  @Get('reach/visits/board') async board(@Req() req: Request) {
    const actor = await access(req, 'reach.read');
    const territoryId = req.query.territory === undefined ? null : id(req.query.territory);
    return scoped(actor.tenant_id, async (db) => {
      const settings = await visitSettings(db);
      const date =
        req.query.date === undefined
          ? await todayFor(db, settings)
          : isoDate(req.query.date, 'Date');
      return visitBoard(db, { workDate: date, territoryId });
    });
  }

  @Get('reach/visits/export.csv') async csv(@Req() req: Request, @Res() res: Response) {
    const actor = await access(req, 'reach.read');
    const { from, to } = spanOf(req);
    const wanted = req.query.rep === undefined ? null : id(req.query.rep);
    const rows = await scoped(actor.tenant_id, async (db) =>
      visitCsvRows(db, { repId: wanted, from, to }),
    );
    const csv = toCsv([
      VISIT_COLUMNS_CSV,
      ...rows.map((r) => VISIT_COLUMNS_CSV.map((c: string) => String(r[c] ?? ''))),
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="visits-${from}-to-${to}.csv"`);
    res.send(csv);
  }

  // ---------- Setup ----------

  @Put('reach/visits/settings') async saveSettings(@Req() req: Request) {
    const raw = body(req, ['visit_dedupe_minutes', 'version']);
    if (!Number.isInteger(raw.version) || raw.version < 0)
      fail(400, 'VERSION_REQUIRED', 'Settings version is missing. Refresh before saving.');
    const minutes = raw.visit_dedupe_minutes;
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 240)
      invalid([
        {
          column: 'visit_dedupe_minutes',
          message: 'This must be a whole number from 0 to 240.',
        },
      ]);

    return mutate(req, 'reach.setup', async (db, actor) => {
      const current = await visitSettings(db);
      if (current.version !== Number(raw.version))
        fail(409, 'STALE_RECORD', 'These settings changed elsewhere. Refresh before saving.');
      await saveReachSettings(db, actor.tenant_id, { visit_dedupe_minutes: minutes });
      await audit(db, actor, 'reach.settings_changed', 'reach_settings', actor.tenant_id, null, {
        visit_dedupe_minutes: minutes,
      });
      return { message: 'Visit settings saved.' };
    });
  }
}
