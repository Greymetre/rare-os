// RCH-7: the overview, one approval queue, the proposals, the audit trail and going live.
//
// Two rules, and both of them are the milestone's own acceptance criteria.
//
// **Every number comes from the evidence beneath it.** There is no overview table. A tile and the
// list a person opens under it are the same count, read from the same query in the same request,
// so they cannot disagree. Nothing in this controller stores a total.
//
// **A proposal never acts.** There is no route here that writes anything at all — not one. A
// proposal is a reading plus the name of the screen where a person does something about it, and
// the only way anything changes is somebody going to that screen and deciding. This file holds no
// `mutate` call, which is the plainest way to say it.
//
// What a person is shown is filtered by what they could actually do about it. A proposal
// pointing at a screen somebody cannot open is noise, and noise is how a dashboard stops being
// read.
import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import { access, fail, scoped } from './core.js';
import { text } from './access.controller.js';
import { datesBetween } from '../../../packages/engines/attendance.mjs';
import { PROPOSAL_KINDS } from '../../../packages/engines/reach-overview.mjs';
import {
  cutoverFor,
  overviewFor,
  reachAudit,
} from '../../../packages/schema/reach-overview-db.mjs';
import { attendanceSettings, todayFor } from '../../../packages/schema/attendance-db.mjs';

const MAX_SPAN_DAYS = 366;
const MAX_AUDIT_ROWS = 200;

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

@Controller('api')
export class ReachOverviewController {
  // ---------- The overview ----------

  @Get('reach/overview') async overview(@Req() req: Request) {
    const actor = await access(req, 'reach.read');
    return scoped(actor.tenant_id, async (db) => {
      const settings = await attendanceSettings(db);
      const on =
        req.query.date === undefined
          ? await todayFor(db, settings)
          : isoDate(req.query.date, 'Date');
      // The permissions travel into the reading, so what comes back is what this person can do
      // something about — not a longer list with half of it greyed out.
      return {
        ...(await overviewFor(db, { date: on, permissions: actor.permissions })),
        // Everything the system knows how to notice, so a screen can explain itself even on a
        // day when there is nothing to say.
        kinds: PROPOSAL_KINDS,
      };
    });
  }

  // The same queue, on its own, for the screen that works through it. It is deliberately the
  // same call: one calculation, two places it is shown.
  @Get('reach/overview/queue') async queue(@Req() req: Request) {
    const actor = await access(req, 'reach.read');
    return scoped(actor.tenant_id, async (db) => {
      const settings = await attendanceSettings(db);
      const on =
        req.query.date === undefined
          ? await todayFor(db, settings)
          : isoDate(req.query.date, 'Date');
      const view = await overviewFor(db, { date: on, permissions: actor.permissions });
      return { date: view.date, ...view.queue };
    });
  }

  // ---------- Going live ----------

  @Get('reach/overview/cutover') async cutover(@Req() req: Request) {
    const actor = await access(req, 'reach.read');
    return scoped(actor.tenant_id, async (db) => cutoverFor(db));
  }

  // ---------- The whole module's audit trail ----------

  // Reach's own window onto the shared audit record. It is a filter, not a second trail: one
  // record of what happened, so there is never a question of which one is right.
  @Get('reach/overview/audit') async audit(@Req() req: Request) {
    const actor = await access(req, 'audit.read');
    const { from, to } = spanOf(req);
    const action = req.query.action === undefined ? null : text(req.query.action, 'Action', 0, 60);
    const limit =
      req.query.limit === undefined
        ? 100
        : Math.min(Number(req.query.limit) || 100, MAX_AUDIT_ROWS);
    return scoped(actor.tenant_id, async (db) =>
      reachAudit(db, { from, to, action: action || null, limit }),
    );
  }
}
