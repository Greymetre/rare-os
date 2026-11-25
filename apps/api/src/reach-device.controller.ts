// RCH-8: the two routes that exist only because the app lives on a phone.
//
// Everything else the mobile app does — starting a day, checking in, taking an order, collecting
// money, checking out — goes through the same routes the web uses. That is on purpose and it is
// worth defending: the moment the phone gets its own write path, there are two places a rule can
// be enforced and one of them will fall behind. A rep taking an order at a counter is doing the
// same thing as a clerk taking one at a desk.
//
// What the phone genuinely needs that a browser does not is only this:
//
// **Everything for the day, in one request.** A browser can fetch eight things as the person
// clicks around, because the person is sitting in a signal. A phone has one moment — usually
// the depot, usually in a hurry — to take the whole day with it. Eight requests on a weak line
// is eight chances to end up holding half a day, and a rep who cannot tell which half.
//
// **A way to say what it is still carrying.** Not the work itself: counts. When a rep says "I
// did all that and it never arrived", somebody needs to be able to answer from evidence —
// whether the phone ever reached us, when, and what it still had.
import { Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import crypto from 'node:crypto';
import { access, fail, scoped } from './core.js';
import { body, mutate, text } from './access.controller.js';
import { bootstrapFor, devicesSeen, recordHeartbeat } from '../../../packages/schema/device-db.mjs';
import { outstandingFor, tradeSettings } from '../../../packages/schema/trade-db.mjs';
import { visitFormFor, visitSettings } from '../../../packages/schema/visit-db.mjs';
import {
  attendanceSettings,
  repForUser,
  todayFor,
} from '../../../packages/schema/attendance-db.mjs';
import { OUTBOX_KINDS } from '../../../packages/engines/sync-queue.mjs';

@Controller('api')
export class ReachDeviceController {
  // ---------- Taking the day with you ----------

  @Get('reach/device/day') async day(@Req() req: Request) {
    // A rep marks their own attendance, so this is the right to be in the field at all. Each
    // thing the payload carries is behind the permission that governs it, below: a rep without
    // `reach.order` gets no price list, because they are not going to take an order.
    const actor = await access(req, 'reach.attend');
    return scoped(actor.tenant_id, async (db) => {
      const rep = await repForUser(db, actor.id);
      if (!rep)
        fail(
          404,
          'NOT_A_FIELD_REP',
          'This login is not linked to a field rep, so there is no round to load.',
        );

      const attendance = await attendanceSettings(db);
      const on =
        req.query.date === undefined
          ? await todayFor(db, attendance)
          : isoDay(req.query.date, 'Date');

      const loaded = await bootstrapFor(db, { repId: rep!.id, workDate: on });
      if (!loaded) fail(404, 'RECORD_NOT_FOUND', 'That field rep was not found.');

      const may = (right: string) => actor.permissions.includes(right);

      // The visit form as it stands now, one per kind of shop on the round. It travels with the
      // day because a rep cannot be asked to fill in questions the phone could not download, and
      // it is keyed by customer type because that is how the form is actually configured.
      const types = [...new Set(loaded!.stops.map((s: any) => s.type_id))];
      const forms: Record<string, unknown> = {};
      if (may('reach.visit'))
        for (const typeId of types) forms[typeId as string] = await visitFormFor(db, typeId);
      const visits = may('reach.visit') ? await visitSettings(db) : null;

      // The outstanding per shop, read through the one function that defines it. Not recomputed
      // on the phone and not reinvented in SQL here: one answer, from one place.
      let owing: Record<string, number> = {};
      if (may('reach.collect') || may('reach.order')) {
        const trade = await tradeSettings(db);
        for (const stop of loaded!.stops) {
          const owed = await outstandingFor(db, stop.customer_id, on, trade);
          owing[stop.customer_id] = owed.outstanding;
        }
      }

      return {
        ...loaded,
        prices: may('reach.order') ? loaded!.prices : [],
        forms,
        visit_settings: visits,
        outstanding: owing,
        // What this login may actually do, so the phone can hide what it cannot send rather than
        // letting a rep fill in a form that will be refused at six in the evening.
        permissions: OUTBOX_KINDS.filter((k) => may(k.permission)).map((k) => k.kind),
        // The server's clock, so a phone with a wrong date does not file a day against yesterday.
        server_date: on,
      };
    });
  }

  // ---------- What the phone is still carrying ----------

  @Post('reach/device/heartbeat') async heartbeat(@Req() req: Request) {
    const raw = body(req, ['device_ref', 'platform', 'app_version', 'queued', 'blocked']);
    const deviceRef = text(raw.device_ref, 'Device', 1, 80);
    const platform = raw.platform === undefined ? '' : text(raw.platform, 'Platform', 0, 40);
    const appVersion = raw.app_version === undefined ? '' : text(raw.app_version, 'Version', 0, 40);
    const count = (value: unknown, label: string) => {
      const n = Number(value ?? 0);
      if (!Number.isInteger(n) || n < 0 || n > 100000)
        fail(400, 'VALIDATION_ERROR', `${label} must be a whole number that is not negative.`);
      return n;
    };
    const queued = count(raw.queued, 'Queued');
    const blocked = count(raw.blocked, 'Blocked');

    return mutate(req, 'reach.attend', async (db, actor) => {
      const rep = await repForUser(db, actor.id);
      if (!rep) fail(404, 'NOT_A_FIELD_REP', 'This login is not linked to a field rep.');
      const row = await recordHeartbeat(db, actor.tenant_id, {
        id: crypto.randomUUID(),
        repId: rep!.id,
        deviceRef,
        platform,
        appVersion,
        queued,
        blocked,
      });
      // Deliberately not audited. A heartbeat is contact, not an action somebody took, and one
      // audit row per phone per few minutes would bury the record of real decisions.
      return { last_seen_at: row.last_seen_at, queued, blocked };
    });
  }

  // Who has been heard from. For the person answering "my day did not go in".
  @Get('reach/device/seen') async seen(@Req() req: Request) {
    const actor = await access(req, 'reach.read');
    return scoped(actor.tenant_id, async (db) => ({
      items: await devicesSeen(db, { limit: 100 }),
    }));
  }
}

function isoDay(value: unknown, label: string): string {
  const v = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v))
    fail(400, 'VALIDATION_ERROR', `${label} must be a date written as YYYY-MM-DD.`);
  return v;
}
