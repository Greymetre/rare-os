// RCH-2: marking a day, the register, leave and corrections.
//
// Two rules shape every route here. A rep marks their own day and nobody else's, so the rep is
// taken from the signed-in login rather than from the request body — a rep id in a payload is
// never trusted. And the register is never written: every status a screen shows is read out of
// the punches, the shift, the holiday list and the approved leave at the moment it is asked for.
import { Controller, Get, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { access, fail, scoped } from './core.js';
import { audit, body, id, mutate, text, version } from './access.controller.js';
import { toCsv } from '../../../packages/schema/imports.mjs';
import { datesBetween } from '../../../packages/engines/attendance.mjs';
import { saveReachSettings } from '../../../packages/schema/customers-db.mjs';
import {
  applyLeave,
  attendanceSettings,
  cancelLeave,
  dayBoard,
  decideEdit,
  decideLeave,
  endDay,
  findDay,
  findEdit,
  findRep,
  inFence,
  leaveBalance,
  listEdits,
  listLeave,
  overlappingLeave,
  PAYROLL_COLUMNS,
  payrollRows,
  registerFor,
  repForUser,
  requestEdit,
  startDay,
  todayFor,
} from '../../../packages/schema/attendance-db.mjs';

const GEO_SOURCES = ['DEVICE', 'TYPED', 'PIN'];
const LEAVE_DECISIONS = ['APPROVED', 'REJECTED'];
// A register may be asked for a year at a time and no more, so one request cannot walk the
// whole history of a company in a single call.
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

// A span the caller may ask for: both ends present, in order, and not longer than a year.
function spanOf(req: Request) {
  const from = isoDate(req.query.from, 'From');
  const to = isoDate(req.query.to, 'To');
  const days = datesBetween(from, to).length;
  if (!days) fail(400, 'VALIDATION_ERROR', 'The To date cannot be before the From date.');
  if (days > MAX_SPAN_DAYS)
    fail(400, 'RANGE_TOO_WIDE', `Ask for at most ${MAX_SPAN_DAYS} days at a time.`);
  return { from, to, days };
}

function coordinate(value: unknown, label: string, bound: number): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < -bound || n > bound)
    fail(400, 'VALIDATION_ERROR', `${label} must be a number between -${bound} and ${bound}.`);
  return n;
}

// Where a punch says it happened. The source is never inferred: a typed location has to say so.
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

@Controller('api')
export class ReachAttendanceController {
  // ---------- My own day ----------

  // Who the signed-in person is as a field rep. A login with no rep record cannot punch, and is
  // told so plainly rather than being handed an empty screen.
  private async me(db: any, actor: { id: string }) {
    const rep = await repForUser(db, actor.id);
    if (!rep)
      fail(
        403,
        'NOT_A_FIELD_REP',
        'This login is not linked to a field rep, so it cannot mark attendance. Ask an administrator to link it.',
      );
    // `fail` always throws, but it carries no explicit `never`, so TypeScript cannot see that.
    return rep!;
  }

  @Get('reach/attendance/my-day') async myDay(@Req() req: Request) {
    const actor = await access(req, 'reach.attend');
    return scoped(actor.tenant_id, async (db) => {
      const settings = await attendanceSettings(db);
      const rep = await this.me(db, actor);
      const date = await todayFor(db, settings);
      const day = await findDay(db, rep.id, date, settings);
      // The choices come with the screen. Listing the masters themselves needs reach.read, and a
      // rep marking their own day is not given the right to read everyone else's field data.
      const workTypes = (
        await db.query(
          'SELECT id,code,name,needs_location FROM work_types WHERE deleted_at IS NULL AND active ORDER BY lower(code)',
        )
      ).rows;
      return {
        date,
        rep: { code: rep.code, name: rep.name, shift: rep.shift_code },
        shift: rep.shift,
        day,
        workTypes,
        selfieRequired: settings.selfie_required,
        timezone: settings.timezone,
      };
    });
  }

  @Post('reach/attendance/start') async start(@Req() req: Request) {
    const raw = body(req, [
      'work_type_id',
      'latitude',
      'longitude',
      'accuracy_m',
      'source',
      'file_id',
      'note',
    ]);
    const workTypeId = id(raw.work_type_id);
    const at = placeOf(raw);
    // Optional text is absent far more often than it is blank, and `text` refuses undefined.
    const note = raw.note === undefined ? '' : text(raw.note, 'Note', 0, 300);
    const fileId = raw.file_id === undefined || raw.file_id === null ? null : id(raw.file_id);

    return mutate(req, 'reach.attend', async (db, actor) => {
      const settings = await attendanceSettings(db);
      const rep = await this.me(db, actor);
      const date = await todayFor(db, settings);
      if (await findDay(db, rep.id, date, settings))
        fail(409, 'ALREADY_STARTED', 'Your day has already been started. End it instead.');

      const work = (
        await db.query(
          'SELECT id,code,name,needs_location FROM work_types WHERE id=$1 AND deleted_at IS NULL AND active',
          [workTypeId],
        )
      ).rows[0];
      if (!work) fail(404, 'RECORD_NOT_FOUND', 'That work type was not found, or is inactive.');
      if (work.needs_location && at.latitude === null)
        fail(400, 'LOCATION_REQUIRED', `${work.name} needs a location before the day can start.`);
      if (settings.selfie_required && work.needs_location && !fileId)
        fail(400, 'SELFIE_REQUIRED', 'A selfie is needed before the day can start.');

      // The fence is judged against the rep's own territory anchor, once, now.
      const anchor =
        (
          await db.query(
            'SELECT latitude,longitude FROM trade_customers WHERE territory_id=$1 AND latitude IS NOT NULL AND deleted_at IS NULL LIMIT 1',
            [rep.territory_id],
          )
        ).rows[0] ?? null;

      const dayId = crypto.randomUUID();
      await startDay(db, actor.tenant_id, {
        id: dayId,
        repId: rep.id,
        workDate: date,
        workTypeId,
        at: { ...at, in_fence: inFence({ anchor, at, settings }) },
        fileId,
        note,
      });
      await audit(db, actor, 'attendance.started', 'attendance_days', dayId, null, {
        rep: rep.code,
        date,
        work_type: work.code,
        source: at.source,
      });
      return { id: dayId, date, message: `Day started for ${rep.code} on ${date}.` };
    });
  }

  @Post('reach/attendance/end') async end(@Req() req: Request) {
    const raw = body(req, ['latitude', 'longitude', 'accuracy_m', 'source', 'version']);
    const at = placeOf(raw);
    const v = version(raw.version);

    return mutate(req, 'reach.attend', async (db, actor) => {
      const settings = await attendanceSettings(db);
      const rep = await this.me(db, actor);
      const date = await todayFor(db, settings);
      const day = await findDay(db, rep.id, date, settings);
      if (!day) fail(409, 'NOT_STARTED', 'Your day has not been started yet.');
      if (day!.end_time) fail(409, 'ALREADY_ENDED', 'Your day has already been ended.');
      if (!(await endDay(db, { dayId: day!.id, version: v, at })))
        fail(409, 'STALE_RECORD', 'This day changed elsewhere. Refresh and try again.');
      await audit(db, actor, 'attendance.ended', 'attendance_days', day!.id, null, {
        rep: rep.code,
        date,
        source: at.source,
      });
      return { id: day!.id, date, message: `Day ended for ${rep.code} on ${date}.` };
    });
  }

  // ---------- The register ----------

  // A rep may always read their own register. Reading anyone else's needs reach.read.
  private async readableRep(db: any, actor: any, wanted: string | null) {
    if (!wanted) return this.me(db, actor);
    const rep = await findRep(db, wanted);
    if (!rep) fail(404, 'RECORD_NOT_FOUND', 'That field rep was not found.');
    const own = await repForUser(db, actor.id);
    if (own?.id !== rep!.id && !actor.permissions.includes('reach.read'))
      fail(403, 'FORBIDDEN', 'You may only read your own attendance.');
    return rep!;
  }

  @Get('reach/attendance/register') async register(@Req() req: Request) {
    const actor = await access(req, 'reach.attend');
    const { from, to } = spanOf(req);
    const wanted = req.query.rep === undefined ? null : id(req.query.rep);
    return scoped(actor.tenant_id, async (db) => {
      const settings = await attendanceSettings(db);
      const rep = await this.readableRep(db, actor, wanted);
      return registerFor(db, { repId: rep.id, from, to }, settings);
    });
  }

  @Get('reach/attendance/board') async board(@Req() req: Request) {
    const actor = await access(req, 'reach.read');
    const territoryId = req.query.territory === undefined ? null : id(req.query.territory);
    return scoped(actor.tenant_id, async (db) => {
      const settings = await attendanceSettings(db);
      const date =
        req.query.date === undefined
          ? await todayFor(db, settings)
          : isoDate(req.query.date, 'Date');
      return {
        ...(await dayBoard(db, { date, territoryId }, settings)),
        canApprove: actor.permissions.includes('reach.leave'),
      };
    });
  }

  // ---------- Leave ----------

  @Get('reach/attendance/leave') async leave(@Req() req: Request) {
    const actor = await access(req, 'reach.attend');
    const status = req.query.status === undefined ? null : text(req.query.status, 'Status', 0, 20);
    const mine = req.query.mine === 'true';
    return scoped(actor.tenant_id, async (db) => {
      const own = await repForUser(db, actor.id);
      // Without reach.read a person sees their own requests and nobody else's.
      const repId = mine || !actor.permissions.includes('reach.read') ? (own?.id ?? null) : null;
      if (!repId && !actor.permissions.includes('reach.read'))
        fail(403, 'NOT_A_FIELD_REP', 'This login is not linked to a field rep.');
      const year = Number(req.query.year) || new Date().getUTCFullYear();
      // As with the day, the leave types travel with the screen rather than making a rep ask
      // for the master list they are not allowed to read.
      const leaveTypes = (
        await db.query(
          'SELECT id,code,name,paid FROM leave_types WHERE deleted_at IS NULL AND active ORDER BY lower(code)',
        )
      ).rows;
      return {
        ...(await listLeave(db, { repId, status })),
        balance: own ? await leaveBalance(db, own.id, year) : [],
        leaveTypes,
        canApprove: actor.permissions.includes('reach.leave'),
      };
    });
  }

  @Post('reach/attendance/leave') async apply(@Req() req: Request) {
    const raw = body(req, ['leave_type_id', 'from_date', 'to_date', 'half_day', 'reason']);
    const leaveTypeId = id(raw.leave_type_id);
    const from = isoDate(raw.from_date, 'From');
    const to = isoDate(raw.to_date, 'To');
    const halfDay = raw.half_day === true;
    const reason = raw.reason === undefined ? '' : text(raw.reason, 'Reason', 0, 300);
    const errors: { column: string; message: string }[] = [];
    if (!datesBetween(from, to).length)
      errors.push({ column: 'to_date', message: 'Until cannot be earlier than From.' });
    if (halfDay && from !== to)
      errors.push({ column: 'half_day', message: 'Only a single day can be taken as a half day.' });
    if (errors.length) invalid(errors);

    return mutate(req, 'reach.attend', async (db, actor) => {
      const rep = await this.me(db, actor);
      const type = (
        await db.query(
          'SELECT id,code,name FROM leave_types WHERE id=$1 AND deleted_at IS NULL AND active',
          [leaveTypeId],
        )
      ).rows[0];
      if (!type) fail(404, 'RECORD_NOT_FOUND', 'That leave type was not found, or is inactive.');
      const clash = await overlappingLeave(db, { repId: rep.id, from, to });
      if (clash)
        fail(
          409,
          'ALREADY_EXISTS',
          `You already have leave from ${clash.from_date} to ${clash.to_date} covering those dates.`,
        );
      const leaveId = crypto.randomUUID();
      await applyLeave(db, actor.tenant_id, {
        id: leaveId,
        repId: rep.id,
        leaveTypeId,
        from,
        to,
        halfDay,
        reason,
      });
      await audit(db, actor, 'leave.applied', 'leave_requests', leaveId, null, {
        rep: rep.code,
        leave_type: type.code,
        from,
        to,
        half_day: halfDay,
      });
      return { id: leaveId, message: `Leave requested from ${from} to ${to}.` };
    });
  }

  @Post('reach/attendance/leave/:id/decide') async decide(
    @Req() req: Request,
    @Param('id') leaveId: string,
  ) {
    id(leaveId);
    const raw = body(req, ['status', 'reason', 'version']);
    const status = String(raw.status ?? '');
    if (!LEAVE_DECISIONS.includes(status))
      fail(400, 'VALIDATION_ERROR', 'A leave request is either approved or rejected.');
    const reason =
      raw.reason === undefined && status !== 'REJECTED'
        ? ''
        : text(raw.reason, 'Reason', status === 'REJECTED' ? 1 : 0, 300);
    const v = version(raw.version);

    return mutate(req, 'reach.leave', async (db, actor) => {
      if (!(await decideLeave(db, actor.id, { id: leaveId, version: v, status, reason })))
        fail(409, 'STALE_RECORD', 'This request was already decided, or changed elsewhere.');
      await audit(db, actor, 'leave.decided', 'leave_requests', leaveId, null, { status, reason });
      return { message: status === 'APPROVED' ? 'Leave approved.' : 'Leave rejected.' };
    });
  }

  @Patch('reach/attendance/leave/:id/cancel') async withdraw(
    @Req() req: Request,
    @Param('id') leaveId: string,
  ) {
    id(leaveId);
    const v = version(body(req, ['version']).version);
    return mutate(req, 'reach.attend', async (db, actor) => {
      const rep = await this.me(db, actor);
      const own = (await db.query('SELECT rep_id FROM leave_requests WHERE id=$1', [leaveId]))
        .rows[0];
      if (!own) fail(404, 'RECORD_NOT_FOUND', 'That leave request was not found.');
      // A rep withdraws their own request; approving or refusing someone else's is a decision.
      if (own.rep_id !== rep.id) fail(403, 'FORBIDDEN', 'You may only withdraw your own request.');
      if (!(await cancelLeave(db, { id: leaveId, version: v })))
        fail(409, 'STALE_RECORD', 'This request was already decided, or changed elsewhere.');
      await audit(db, actor, 'leave.cancelled', 'leave_requests', leaveId, null, { rep: rep.code });
      return { message: 'Leave request withdrawn.' };
    });
  }

  // ---------- Corrections ----------

  @Get('reach/attendance/corrections') async corrections(@Req() req: Request) {
    const actor = await access(req, 'reach.attend');
    const status =
      req.query.status === undefined ? 'PENDING' : text(req.query.status, 'Status', 0, 20);
    return scoped(actor.tenant_id, async (db) => {
      const settings = await attendanceSettings(db);
      const own = await repForUser(db, actor.id);
      const repId = actor.permissions.includes('reach.read') ? null : (own?.id ?? null);
      if (!repId && !actor.permissions.includes('reach.read'))
        fail(403, 'NOT_A_FIELD_REP', 'This login is not linked to a field rep.');
      return {
        ...(await listEdits(db, { repId, status: status || null }, settings)),
        canApprove: actor.permissions.includes('reach.leave'),
      };
    });
  }

  @Post('reach/attendance/corrections') async correct(@Req() req: Request) {
    const raw = body(req, ['work_date', 'start_time', 'end_time', 'reason']);
    const workDate = isoDate(raw.work_date, 'Date');
    const reason = text(raw.reason, 'Reason', 1, 300);
    const clock = (v: unknown, label: string) => {
      if (v === undefined || v === null || v === '') return null;
      const s = String(v).trim();
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s))
        fail(400, 'VALIDATION_ERROR', `${label} must be a time written as HH:MM.`);
      return s;
    };
    const start = clock(raw.start_time, 'Start time');
    const end = clock(raw.end_time, 'End time');
    if (!start && !end)
      fail(400, 'VALIDATION_ERROR', 'A correction must give a start time, an end time, or both.');

    return mutate(req, 'reach.attend', async (db, actor) => {
      const settings = await attendanceSettings(db);
      const rep = await this.me(db, actor);
      const today = await todayFor(db, settings);
      if (workDate > today)
        fail(400, 'VALIDATION_ERROR', 'A day in the future cannot be corrected.');
      const existing =
        (
          await db.query(
            'SELECT started_at,ended_at FROM attendance_days WHERE rep_id=$1 AND work_date=$2',
            [rep.id, workDate],
          )
        ).rows[0] ?? null;
      // The clock times are the company's own, so they are turned into instants by the database.
      const stamp = async (c: string | null) =>
        c === null
          ? null
          : (
              await db.query('SELECT ($1::date + $2::time) AT TIME ZONE $3 AS at', [
                workDate,
                c,
                settings.timezone,
              ])
            ).rows[0].at;

      const editId = crypto.randomUUID();
      try {
        await requestEdit(db, actor.tenant_id, {
          id: editId,
          repId: rep.id,
          workDate,
          startAt: await stamp(start),
          endAt: await stamp(end),
          reason,
          previous: existing,
        });
      } catch (e: any) {
        if (e?.code === '23505')
          fail(
            409,
            'ALREADY_EXISTS',
            'A correction for that day is already waiting for a decision.',
          );
        throw e;
      }
      await audit(db, actor, 'attendance.correction_requested', 'attendance_edits', editId, null, {
        rep: rep.code,
        date: workDate,
        start,
        end,
      });
      return { id: editId, message: `Correction requested for ${workDate}.` };
    });
  }

  @Post('reach/attendance/corrections/:id/decide') async decideCorrection(
    @Req() req: Request,
    @Param('id') editId: string,
  ) {
    id(editId);
    const raw = body(req, ['status', 'reason']);
    const status = String(raw.status ?? '');
    if (!LEAVE_DECISIONS.includes(status))
      fail(400, 'VALIDATION_ERROR', 'A correction is either approved or rejected.');
    const reason =
      raw.reason === undefined && status !== 'REJECTED'
        ? ''
        : text(raw.reason, 'Reason', status === 'REJECTED' ? 1 : 0, 300);

    return mutate(req, 'reach.leave', async (db, actor) => {
      const edit = await findEdit(db, editId);
      if (!edit) fail(404, 'RECORD_NOT_FOUND', 'That correction was not found.');
      if (edit.status !== 'PENDING')
        fail(409, 'STALE_RECORD', 'This correction was already decided.');
      // Approving may have to create the day, which needs a work type to attach it to.
      const fallback = (
        await db.query(
          'SELECT id FROM work_types WHERE deleted_at IS NULL AND active ORDER BY lower(code) LIMIT 1',
        )
      ).rows[0];
      if (status === 'APPROVED' && !fallback)
        fail(409, 'NO_WORK_TYPE', 'Add a work type before approving corrections.');
      if (
        !(await decideEdit(db, actor.id, actor.tenant_id, {
          edit,
          status,
          reason,
          workTypeId: fallback?.id,
        }))
      )
        fail(409, 'STALE_RECORD', 'This correction was already decided.');
      await audit(db, actor, 'attendance.correction_decided', 'attendance_edits', editId, null, {
        rep: edit.rep,
        date: edit.work_date,
        status,
        reason,
      });
      return { message: status === 'APPROVED' ? 'Correction applied.' : 'Correction rejected.' };
    });
  }

  // ---------- Payroll ----------

  @Get('reach/attendance/payroll.csv') async payroll(@Req() req: Request, @Res() res: Response) {
    const actor = await access(req, 'reach.read');
    const { from, to } = spanOf(req);
    const territoryId = req.query.territory === undefined ? null : id(req.query.territory);
    const rows = await scoped(actor.tenant_id, async (db) => {
      const settings = await attendanceSettings(db);
      return payrollRows(db, { from, to, territoryId }, settings);
    });
    const csv = toCsv([
      PAYROLL_COLUMNS,
      ...rows.map((r) => PAYROLL_COLUMNS.map((c: string) => String(r[c] ?? ''))),
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="attendance-${from}-to-${to}.csv"`);
    res.send(csv);
  }

  // ---------- Setup ----------

  @Put('reach/attendance/settings') async saveSettings(@Req() req: Request) {
    const raw = body(req, [
      'attendance_fence_m',
      'absent_after_minutes',
      'selfie_required',
      'timezone',
      'version',
    ]);
    if (!Number.isInteger(raw.version) || raw.version < 0)
      fail(400, 'VERSION_REQUIRED', 'Settings version is missing. Refresh before saving.');
    const errors: { column: string; message: string }[] = [];
    const bounds = { attendance_fence_m: [10, 10000], absent_after_minutes: [15, 1440] } as const;
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
    if (typeof raw.selfie_required !== 'boolean')
      errors.push({ column: 'selfie_required', message: 'Say yes or no.' });
    else value.selfie_required = raw.selfie_required;
    const zone = String(raw.timezone ?? '').trim();
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone }).format();
      value.timezone = zone;
    } catch {
      errors.push({
        column: 'timezone',
        message: 'Enter a valid timezone, for example Asia/Kolkata.',
      });
    }
    if (errors.length) invalid(errors);

    return mutate(req, 'reach.setup', async (db, actor) => {
      const current = await attendanceSettings(db);
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
      return { message: 'Attendance settings saved.' };
    });
  }
}
