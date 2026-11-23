// RCH-6: what a rep spent on the road, and what the policy allows of it.
//
// Three rules shape every route here.
//
// **A policy version may only start in the future, and once it has started it is frozen.** Both
// halves are enforced here, because a table cannot see today's date. This is not ceremony: it is
// the whole reason the amounts can stay calculated rather than stored. Edit a version that is
// already governing claims and every approved amount under it moves.
//
// **The rep is the signed-in login.** A rep id in a request body is never read, so nobody files
// a claim in somebody else's name, and a rep reads their own claims and nobody else's unless
// they hold the right to read the module.
//
// **One person cannot approve a claim twice.** The manager stage and the finance stage are
// separate rights, and the same person may hold both — small companies do — but may not use both
// on the same claim. The engine refuses it, the controller refuses it, and the table refuses it.
// That is the milestone's own acceptance case and it is worth all three.
import { Controller, Get, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { access, fail, scoped } from './core.js';
import { audit, body, id, mutate, text, version } from './access.controller.js';
import { datesBetween } from '../../../packages/engines/attendance.mjs';
import { APPROVAL_STAGES, canDecide, policyIsOpen } from '../../../packages/engines/expense.mjs';
import { toCsv } from '../../../packages/schema/imports.mjs';
import { saveReachSettings } from '../../../packages/schema/customers-db.mjs';
import { repForUser, findRep, todayFor } from '../../../packages/schema/attendance-db.mjs';
import {
  addLine,
  categories,
  claimForPeriod,
  createPolicy,
  decideClaim,
  editLine,
  expenseRegister,
  expenseSettings,
  findCategory,
  findClaim,
  findLine,
  findPolicy,
  listClaims,
  openClaim,
  periodFor,
  policies,
  policyRates,
  priceClaim,
  removeLine,
  reopenClaim,
  savePolicyRates,
  submitClaim,
  updatePolicy,
} from '../../../packages/schema/expense-db.mjs';

const VEHICLES = ['', 'BIKE', 'CAR', 'PUBLIC', 'OTHER'];
const MAX_SPAN_DAYS = 366;
// A fortnight of expenses is a page of lines, not a bulk upload.
const MAX_LINES = 200;
const PAYOUT_COLUMNS = [
  'rep',
  'rep_name',
  'period_from',
  'period_to',
  'status',
  'lines',
  'claimed',
  'allowed',
  'disallowed',
  'manager',
  'finance',
];

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

function amount(value: unknown, label: string, { min = 0, max = 9999999 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max)
    fail(400, 'VALIDATION_ERROR', `${label} must be an amount between ${min} and ${max}.`);
  if (Math.round(n * 100) / 100 !== n)
    fail(400, 'VALIDATION_ERROR', `${label} cannot be finer than a paisa.`);
  return n;
}

// A money value a policy may leave unset. Null is "the policy says nothing about this", which is
// a different instruction from a limit of nought.
function optionalAmount(value: unknown, label: string) {
  if (value === null || value === undefined || value === '') return null;
  return amount(value, label);
}

function optionalRate(value: unknown, label: string) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 9999999)
    fail(400, 'VALIDATION_ERROR', `${label} must be a rate of nought or more.`);
  if (Math.round(n * 10000) / 10000 !== n)
    fail(400, 'VALIDATION_ERROR', `${label} may have at most four decimal places.`);
  return n;
}

@Controller('api')
export class ReachExpenseController {
  private async me(db: any, actor: { id: string }) {
    const rep = await repForUser(db, actor.id);
    if (!rep)
      fail(
        403,
        'NOT_A_FIELD_REP',
        'This login is not linked to a field rep, so it cannot make an expense claim. Ask an administrator to link it.',
      );
    return rep!;
  }

  // ---------- Setup: the categories and the policy versions ----------

  @Get('reach/expense/setup') async setup(@Req() req: Request) {
    const actor = await access(req, 'reach.read');
    return scoped(actor.tenant_id, async (db) => {
      const settings = await expenseSettings(db);
      const today = await todayFor(db, settings);
      const all = await policies(db);
      return {
        today,
        settings: {
          expense_fortnightly: settings.expense_fortnightly,
          expense_window_days: settings.expense_window_days,
          version: settings.version,
        },
        categories: await categories(db, { includeInactive: true }),
        // Whether each version may still be edited is worked out here rather than guessed at by
        // the screen, so the button and the route can never disagree about it.
        policies: all.map((p: any) => ({ ...p, open: policyIsOpen(p, today) })),
        canEdit: actor.permissions.includes('reach.setup'),
      };
    });
  }

  @Get('reach/expense/policies/:id') async onePolicy(
    @Req() req: Request,
    @Param('id') policyId: string,
  ) {
    id(policyId);
    const actor = await access(req, 'reach.read');
    return scoped(actor.tenant_id, async (db) => {
      const settings = await expenseSettings(db);
      const today = await todayFor(db, settings);
      const policy = await findPolicy(db, policyId);
      if (!policy) fail(404, 'RECORD_NOT_FOUND', 'That policy version was not found.');
      return {
        ...policy!,
        open: policyIsOpen(policy, today),
        rates: await policyRates(db, policyId),
        categories: await categories(db),
      };
    });
  }

  @Post('reach/expense/policies') async newPolicy(@Req() req: Request) {
    const raw = body(req, ['code', 'name', 'effective_from', 'note', 'copy_from']);
    const code = text(raw.code, 'Code', 1, 30);
    const name = text(raw.name, 'Name', 1, 120);
    const note = raw.note === undefined ? '' : text(raw.note, 'Note', 0, 300);
    const from = isoDate(raw.effective_from, 'Effective from');
    const copyFrom =
      raw.copy_from === undefined || raw.copy_from === null ? null : id(raw.copy_from);

    return mutate(req, 'reach.setup', async (db, actor) => {
      const settings = await expenseSettings(db);
      const today = await todayFor(db, settings);
      // The rule the whole module rests on. A version that starts today or earlier is already
      // governing claims, and its numbers could move an amount somebody has approved.
      if (from <= today)
        invalid([
          {
            column: 'effective_from',
            message: `A policy version has to start after today (${today}), so that an amount already approved can never change.`,
          },
        ]);
      const policyId = crypto.randomUUID();
      try {
        await createPolicy(db, actor.tenant_id, {
          id: policyId,
          code,
          name,
          effectiveFrom: from,
          note,
          actorId: actor.id,
        });
      } catch (e: any) {
        if (e?.code === '23505')
          fail(
            409,
            'ALREADY_EXISTS',
            'There is already a policy version with that code, or one that starts on that date.',
          );
        throw e;
      }
      // Starting from the version in force saves retyping a dozen rates to change one of them.
      let copied = 0;
      if (copyFrom) {
        const source = await findPolicy(db, copyFrom);
        if (!source) fail(404, 'RECORD_NOT_FOUND', 'The version to copy from was not found.');
        const rates = await policyRates(db, copyFrom);
        copied = await savePolicyRates(db, actor.tenant_id, policyId, rates);
      }
      await audit(db, actor, 'expense.policy_created', 'expense_policies', policyId, null, {
        code,
        effective_from: from,
        copied,
      });
      return {
        id: policyId,
        copied,
        message: copied
          ? `Policy ${code} created from ${copied} existing rates, starting ${from}.`
          : `Policy ${code} created, starting ${from}.`,
      };
    });
  }

  @Put('reach/expense/policies/:id') async savePolicy(
    @Req() req: Request,
    @Param('id') policyId: string,
  ) {
    id(policyId);
    const raw = body(req, ['name', 'effective_from', 'note', 'active', 'version']);
    const name = text(raw.name, 'Name', 1, 120);
    const note = raw.note === undefined ? '' : text(raw.note, 'Note', 0, 300);
    const from = isoDate(raw.effective_from, 'Effective from');
    const active = raw.active === undefined ? true : raw.active === true;
    const v = version(raw.version);

    return mutate(req, 'reach.setup', async (db, actor) => {
      const settings = await expenseSettings(db);
      const today = await todayFor(db, settings);
      const policy = await findPolicy(db, policyId);
      if (!policy) fail(404, 'RECORD_NOT_FOUND', 'That policy version was not found.');
      if (!policyIsOpen(policy, today))
        fail(
          409,
          'POLICY_IN_FORCE',
          `Policy ${policy!.code} started on ${policy!.effective_from} and cannot be changed. Create a new version instead — that is what keeps an approved amount from moving.`,
        );
      if (from <= today)
        invalid([
          {
            column: 'effective_from',
            message: `A policy version has to start after today (${today}).`,
          },
        ]);
      if (
        !(await updatePolicy(db, {
          id: policyId,
          version: v,
          name,
          effectiveFrom: from,
          note,
          active,
        }))
      )
        fail(409, 'STALE_RECORD', 'This policy changed elsewhere. Refresh and try again.');
      await audit(db, actor, 'expense.policy_changed', 'expense_policies', policyId, null, {
        code: policy!.code,
        effective_from: from,
        active,
      });
      return { message: `Policy ${policy!.code} saved.` };
    });
  }

  @Put('reach/expense/policies/:id/rates') async saveRates(
    @Req() req: Request,
    @Param('id') policyId: string,
  ) {
    id(policyId);
    const raw = body(req, ['rates']);
    if (!Array.isArray(raw.rates)) fail(400, 'VALIDATION_ERROR', 'The rates must be a list.');
    const rows = (raw.rates as any[]).map((row: any, index: number) => {
      if (!row || typeof row !== 'object')
        fail(400, 'VALIDATION_ERROR', `Rate ${index + 1} is not a rate.`);
      const rate = optionalRate(row.rate, `Rate ${index + 1}`);
      const cap = optionalAmount(row.cap, `Rate ${index + 1} limit`);
      const periodCap = optionalAmount(row.period_cap, `Rate ${index + 1} claim limit`);
      // A row that sets neither a rate nor a limit says nothing at all, and the table agrees.
      if (rate === null && cap === null && periodCap === null)
        invalid([
          {
            column: 'rate',
            message: `Rate ${index + 1} has to set a rate, a limit, or a limit for the whole claim.`,
          },
        ]);
      return {
        category_id: id(row.category_id),
        key: String(row.key ?? '')
          .trim()
          .toUpperCase()
          .slice(0, 30),
        rate,
        cap,
        period_cap: periodCap,
      };
    });
    const seen = new Set<string>();
    for (const row of rows) {
      const pair = `${row.category_id}|${row.key}`;
      if (seen.has(pair)) fail(400, 'VALIDATION_ERROR', 'The same category and key appear twice.');
      seen.add(pair);
    }

    return mutate(req, 'reach.setup', async (db, actor) => {
      const settings = await expenseSettings(db);
      const today = await todayFor(db, settings);
      const policy = await findPolicy(db, policyId);
      if (!policy) fail(404, 'RECORD_NOT_FOUND', 'That policy version was not found.');
      if (!policyIsOpen(policy, today))
        fail(
          409,
          'POLICY_IN_FORCE',
          `Policy ${policy!.code} started on ${policy!.effective_from} and its rates cannot be changed. Create a new version instead.`,
        );
      for (const row of rows)
        if (!(await findCategory(db, row.category_id)))
          fail(404, 'RECORD_NOT_FOUND', 'One of those expense categories was not found.');
      const saved = await savePolicyRates(db, actor.tenant_id, policyId, rows);
      await audit(db, actor, 'expense.rates_changed', 'expense_policies', policyId, null, {
        code: policy!.code,
        rates: saved,
      });
      return { message: `${saved} ${saved === 1 ? 'rate' : 'rates'} saved on ${policy!.code}.` };
    });
  }

  // ---------- The rep's own claim ----------

  @Get('reach/expense/my-claim') async myClaim(@Req() req: Request) {
    const actor = await access(req, 'reach.expense');
    return scoped(actor.tenant_id, async (db) => {
      const settings = await expenseSettings(db);
      const rep = await this.me(db, actor);
      const today = await todayFor(db, settings);
      const date = req.query.date === undefined ? today : isoDate(req.query.date, 'Date');
      const period = periodFor(date, settings);
      const claim = await claimForPeriod(db, rep.id, period!.from);
      return {
        today,
        period,
        // The list travels with the screen: reading the category master needs reach.read, and a
        // rep filling in a claim is not given the right to read every other master.
        categories: await categories(db),
        vehicles: VEHICLES.filter(Boolean),
        claim,
        priced: claim ? await priceClaim(db, claim, settings) : null,
      };
    });
  }

  @Post('reach/expense/my-claim/lines') async addMyLine(@Req() req: Request) {
    const raw = body(req, [
      'category_id',
      'spend_date',
      'km',
      'vehicle',
      'nights',
      'town',
      'claimed_amount',
      'file_id',
      'note',
    ]);
    const categoryId = id(raw.category_id);
    const spendDate = isoDate(raw.spend_date, 'Date');
    const vehicle = String(raw.vehicle ?? '')
      .trim()
      .toUpperCase();
    if (!VEHICLES.includes(vehicle))
      fail(400, 'VALIDATION_ERROR', 'That is not a way this system records travel.');
    const km = raw.km === undefined || raw.km === null || raw.km === '' ? 0 : Number(raw.km);
    if (!Number.isFinite(km) || km < 0 || km > 100000)
      fail(400, 'VALIDATION_ERROR', 'Kilometres must be a number from 0 to 100000.');
    const nights =
      raw.nights === undefined || raw.nights === null || raw.nights === '' ? 0 : Number(raw.nights);
    if (!Number.isInteger(nights) || nights < 0 || nights > 60)
      fail(400, 'VALIDATION_ERROR', 'Nights must be a whole number from 0 to 60.');
    const town = raw.town === undefined ? '' : text(raw.town, 'Town', 0, 80);
    const claimedAmount = amount(raw.claimed_amount, 'Amount');
    const fileId = raw.file_id === undefined || raw.file_id === null ? null : id(raw.file_id);
    const note = raw.note === undefined ? '' : text(raw.note, 'Note', 0, 300);

    return mutate(req, 'reach.expense', async (db, actor) => {
      const settings = await expenseSettings(db);
      const rep = await this.me(db, actor);
      const today = await todayFor(db, settings);
      if (spendDate > today)
        invalid([{ column: 'spend_date', message: 'An expense cannot be dated in the future.' }]);
      const category = await findCategory(db, categoryId);
      if (!category) fail(404, 'RECORD_NOT_FOUND', 'That expense category was not found.');
      if (!category!.active)
        fail(409, 'NOT_ALLOWED', `${category!.code} is no longer claimed for.`);

      // The claim is made by opening the screen, not by a separate button.
      const claim = await openClaim(db, actor.tenant_id, {
        repId: rep.id,
        date: spendDate,
        settings,
      });
      if (!claim) fail(400, 'VALIDATION_ERROR', 'That date is not in any claim period.');
      if (claim!.status !== 'DRAFT')
        fail(
          409,
          'CLAIM_SENT',
          `The claim for ${claim!.period_from} to ${claim!.period_to} has already been sent in. A line cannot be added to it now.`,
        );
      // A fortnight of expenses is a page of lines.
      if ((await priceClaim(db, claim!, settings)).count >= MAX_LINES)
        fail(400, 'VALIDATION_ERROR', `A claim may have at most ${MAX_LINES} lines.`);

      const lineId = crypto.randomUUID();
      await addLine(db, actor.tenant_id, {
        id: lineId,
        claimId: claim!.id,
        categoryId,
        spendDate,
        km,
        vehicle,
        nights,
        town,
        claimedAmount,
        fileId,
        note,
      });
      await audit(db, actor, 'expense.line_added', 'expense_lines', lineId, null, {
        rep: rep.code,
        category: category!.code,
        spend_date: spendDate,
        claimed: claimedAmount,
      });
      const priced = await priceClaim(db, claim!, settings);
      const row = priced.lines.find((l: any) => l.id === lineId);
      return {
        id: lineId,
        // What the policy makes of the line comes straight back, so a rep sees the answer before
        // they have to ask anybody. The plan's own words: the result shows before it is saved.
        allowed: row?.allowed ?? 0,
        reasons: row?.reasons ?? [],
        claim: { id: claim!.id, allowed: priced.allowed, claimed: priced.claimed },
        message: `Line added. The policy allows ${row?.allowed ?? 0} of ${claimedAmount}.`,
      };
    });
  }

  @Patch('reach/expense/lines/:id') async changeLine(
    @Req() req: Request,
    @Param('id') lineId: string,
  ) {
    id(lineId);
    const raw = body(req, [
      'category_id',
      'spend_date',
      'km',
      'vehicle',
      'nights',
      'town',
      'claimed_amount',
      'file_id',
      'note',
      'version',
    ]);
    const categoryId = id(raw.category_id);
    const spendDate = isoDate(raw.spend_date, 'Date');
    const vehicle = String(raw.vehicle ?? '')
      .trim()
      .toUpperCase();
    if (!VEHICLES.includes(vehicle))
      fail(400, 'VALIDATION_ERROR', 'That is not a way this system records travel.');
    const km = raw.km === undefined || raw.km === null || raw.km === '' ? 0 : Number(raw.km);
    if (!Number.isFinite(km) || km < 0 || km > 100000)
      fail(400, 'VALIDATION_ERROR', 'Kilometres must be a number from 0 to 100000.');
    const nights =
      raw.nights === undefined || raw.nights === null || raw.nights === '' ? 0 : Number(raw.nights);
    if (!Number.isInteger(nights) || nights < 0 || nights > 60)
      fail(400, 'VALIDATION_ERROR', 'Nights must be a whole number from 0 to 60.');
    const town = raw.town === undefined ? '' : text(raw.town, 'Town', 0, 80);
    const claimedAmount = amount(raw.claimed_amount, 'Amount');
    const fileId = raw.file_id === undefined || raw.file_id === null ? null : id(raw.file_id);
    const note = raw.note === undefined ? '' : text(raw.note, 'Note', 0, 300);
    const v = version(raw.version);

    return mutate(req, 'reach.expense', async (db, actor) => {
      const settings = await expenseSettings(db);
      const { claim } = await this.ownDraftLine(db, actor, lineId);
      if (spendDate < claim.period_from || spendDate > claim.period_to)
        invalid([
          {
            column: 'spend_date',
            message: `This claim covers ${claim.period_from} to ${claim.period_to}. Put an expense from another fortnight on its own claim.`,
          },
        ]);
      if (!(await findCategory(db, categoryId)))
        fail(404, 'RECORD_NOT_FOUND', 'That expense category was not found.');
      if (
        !(await editLine(db, {
          id: lineId,
          version: v,
          categoryId,
          spendDate,
          km,
          vehicle,
          nights,
          town,
          claimedAmount,
          fileId,
          note,
        }))
      )
        fail(409, 'STALE_RECORD', 'This line changed elsewhere. Refresh and try again.');
      await audit(db, actor, 'expense.line_changed', 'expense_lines', lineId, null, {
        spend_date: spendDate,
        claimed: claimedAmount,
      });
      const priced = await priceClaim(db, claim, settings);
      const row = priced.lines.find((l: any) => l.id === lineId);
      return {
        allowed: row?.allowed ?? 0,
        reasons: row?.reasons ?? [],
        message: `Line saved. The policy allows ${row?.allowed ?? 0} of ${claimedAmount}.`,
      };
    });
  }

  @Patch('reach/expense/lines/:id/remove') async dropLine(
    @Req() req: Request,
    @Param('id') lineId: string,
  ) {
    id(lineId);
    const raw = body(req, ['reason', 'version']);
    const reason = text(raw.reason, 'Reason', 1, 300);
    const v = version(raw.version);

    return mutate(req, 'reach.expense', async (db, actor) => {
      const { line } = await this.ownDraftLine(db, actor, lineId);
      if (!(await removeLine(db, { id: lineId, version: v, reason })))
        fail(409, 'STALE_RECORD', 'This line changed elsewhere. Refresh and try again.');
      await audit(db, actor, 'expense.line_withdrawn', 'expense_lines', lineId, null, {
        category: line.category,
        spend_date: line.spend_date,
        reason,
      });
      // The row stays. "Claimed and then withdrawn" is worth being able to see later.
      return { message: 'Line taken off the claim. Its record is kept.' };
    });
  }

  // One line of the signed-in rep's own claim, which must still be a draft.
  private async ownDraftLine(db: any, actor: any, lineId: string) {
    const rep = await this.me(db, actor);
    const line = await findLine(db, lineId);
    if (!line) fail(404, 'RECORD_NOT_FOUND', 'That line was not found.');
    const claim = await findClaim(db, line!.claim_id);
    if (!claim || claim.rep_id !== rep.id)
      fail(403, 'FORBIDDEN', 'You may only change your own claim.');
    if (claim!.status !== 'DRAFT')
      fail(409, 'CLAIM_SENT', 'This claim has already been sent in and cannot be changed.');
    return { rep, line: line!, claim: claim! };
  }

  @Post('reach/expense/my-claim/submit') async submit(@Req() req: Request) {
    const raw = body(req, ['claim_id', 'version']);
    const claimId = id(raw.claim_id);
    const v = version(raw.version);

    return mutate(req, 'reach.expense', async (db, actor) => {
      const settings = await expenseSettings(db);
      const rep = await this.me(db, actor);
      const claim = await findClaim(db, claimId);
      if (!claim) fail(404, 'RECORD_NOT_FOUND', 'That claim was not found.');
      if (claim!.rep_id !== rep.id) fail(403, 'FORBIDDEN', 'You may only send in your own claim.');
      const today = await todayFor(db, settings);
      const window = Number(settings.expense_window_days ?? 0);
      // A deadline the company set. Zero means there is none.
      if (window > 0 && datesBetween(claim!.period_to, today).length - 1 > window)
        fail(
          409,
          'TOO_LATE',
          `Claims for ${claim!.period_from} to ${claim!.period_to} closed ${window} days after the period ended.`,
        );

      const priced = await priceClaim(db, claim!, settings);
      if (!priced.count) fail(409, 'NOTHING_TO_SEND', 'This claim has no lines on it yet.');
      // A receipt the policy insists on stops the claim going in, rather than quietly zeroing
      // the line: the expense is real, the paperwork is what is missing.
      if (priced.blocked)
        fail(
          409,
          'RECEIPT_MISSING',
          `${priced.blocked} ${priced.blocked === 1 ? 'line needs' : 'lines need'} a receipt before this claim can be sent in.`,
        );
      if (!(await submitClaim(db, { id: claimId, version: v })))
        fail(409, 'STALE_RECORD', 'This claim changed elsewhere. Refresh and try again.');
      await audit(db, actor, 'expense.claim_submitted', 'expense_claims', claimId, null, {
        rep: rep.code,
        period: `${claim!.period_from}..${claim!.period_to}`,
        claimed: priced.claimed,
        allowed: priced.allowed,
      });
      return {
        message: `Claim for ${claim!.period_from} to ${claim!.period_to} sent in. The policy allows ${priced.allowed} of ${priced.claimed}.`,
      };
    });
  }

  @Post('reach/expense/claims/:id/reopen') async reopen(
    @Req() req: Request,
    @Param('id') claimId: string,
  ) {
    id(claimId);
    const v = version(body(req, ['version']).version);
    return mutate(req, 'reach.expense', async (db, actor) => {
      const rep = await this.me(db, actor);
      const claim = await findClaim(db, claimId);
      if (!claim) fail(404, 'RECORD_NOT_FOUND', 'That claim was not found.');
      if (claim!.rep_id !== rep.id) fail(403, 'FORBIDDEN', 'You may only reopen your own claim.');
      if (claim!.status !== 'REJECTED')
        fail(409, 'NOT_SENT_BACK', 'Only a claim that was sent back can be opened again.');
      if (!(await reopenClaim(db, { id: claimId, version: v })))
        fail(409, 'STALE_RECORD', 'This claim changed elsewhere. Refresh and try again.');
      await audit(db, actor, 'expense.claim_reopened', 'expense_claims', claimId, null, {
        rep: rep.code,
        was: claim!.reject_reason,
      });
      return { message: 'Claim opened again. Correct it and send it in once more.' };
    });
  }

  // ---------- Reading claims ----------

  @Get('reach/expense/claims') async claims(@Req() req: Request) {
    const actor = await access(req, 'reach.expense');
    const { from, to } = spanOf(req);
    const status = req.query.status === undefined ? null : text(req.query.status, 'Status', 0, 20);
    const wanted = req.query.rep === undefined ? null : id(req.query.rep);
    return scoped(actor.tenant_id, async (db) => {
      // Without the right to read the module, a person sees their own claims and nobody else's.
      let repId = wanted;
      const reads = ['reach.read', 'reach.expense_approve', 'reach.expense_finance'].some((p) =>
        actor.permissions.includes(p),
      );
      if (!reads) {
        const own = await repForUser(db, actor.id);
        if (wanted && wanted !== own?.id)
          fail(403, 'FORBIDDEN', 'You may only read your own claims.');
        repId = own?.id ?? null;
        if (!repId) fail(403, 'NOT_A_FIELD_REP', 'This login is not linked to a field rep.');
      } else if (wanted) {
        if (!(await findRep(db, wanted)))
          fail(404, 'RECORD_NOT_FOUND', 'That field rep was not found.');
      }
      return {
        ...(await listClaims(db, { repId, status: status || null, from, to })),
        canPass: actor.permissions.includes('reach.expense_approve'),
        canApprove: actor.permissions.includes('reach.expense_finance'),
      };
    });
  }

  @Get('reach/expense/claims/:id') async oneClaim(
    @Req() req: Request,
    @Param('id') claimId: string,
  ) {
    id(claimId);
    const actor = await access(req, 'reach.expense');
    return scoped(actor.tenant_id, async (db) => {
      const settings = await expenseSettings(db);
      const claim = await findClaim(db, claimId);
      if (!claim) fail(404, 'RECORD_NOT_FOUND', 'That claim was not found.');
      const own = await repForUser(db, actor.id);
      const reads = ['reach.read', 'reach.expense_approve', 'reach.expense_finance'].some((p) =>
        actor.permissions.includes(p),
      );
      if (!reads && own?.id !== claim!.rep_id)
        fail(403, 'FORBIDDEN', 'You may only read your own claims.');
      // Whether this person may act, and why not when they may not, is worked out here so the
      // screen never offers a button the route would refuse.
      const stages = APPROVAL_STAGES.filter((stage: string) =>
        actor.permissions.includes(
          stage === 'MANAGER' ? 'reach.expense_approve' : 'reach.expense_finance',
        ),
      ).map((stage: string) => ({
        stage,
        ...canDecide({
          claim: claim!,
          stage,
          actorId: actor.id,
          repUserId: claim!.rep_user_id,
        }),
      }));
      return { ...claim!, priced: await priceClaim(db, claim!, settings), stages };
    });
  }

  @Post('reach/expense/claims/:id/decide') async decide(
    @Req() req: Request,
    @Param('id') claimId: string,
  ) {
    id(claimId);
    const raw = body(req, ['stage', 'approve', 'note', 'reason', 'version']);
    const stage = String(raw.stage ?? '');
    if (!APPROVAL_STAGES.includes(stage as any))
      fail(400, 'VALIDATION_ERROR', 'A claim is decided by a manager or by finance.');
    if (typeof raw.approve !== 'boolean')
      fail(400, 'VALIDATION_ERROR', 'Say whether the claim is passed or sent back.');
    const approve = raw.approve as boolean;
    const note = raw.note === undefined ? '' : text(raw.note, 'Note', 0, 300);
    // Sending a claim back has to say why; the rep has to know what to correct.
    const reason = approve ? '' : text(raw.reason, 'Reason', 1, 300);
    const v = version(raw.version);
    const needs = stage === 'MANAGER' ? 'reach.expense_approve' : 'reach.expense_finance';

    return mutate(req, needs, async (db, actor) => {
      const claim = await findClaim(db, claimId);
      if (!claim) fail(404, 'RECORD_NOT_FOUND', 'That claim was not found.');
      // The milestone's own acceptance case, refused here before the table ever sees it.
      const verdict = canDecide({
        claim: claim!,
        stage,
        actorId: actor.id,
        repUserId: claim!.rep_user_id,
      });
      if (!verdict.allowed) fail(409, 'NOT_YOURS_TO_DECIDE', verdict.reason);
      if (
        !(await decideClaim(db, actor.id, {
          id: claimId,
          version: v,
          stage,
          approve,
          note,
          reason,
        }))
      )
        fail(409, 'STALE_RECORD', 'This claim changed elsewhere. Refresh and try again.');
      await audit(
        db,
        actor,
        approve ? 'expense.claim_passed' : 'expense.claim_sent_back',
        'expense_claims',
        claimId,
        null,
        { rep: claim!.rep, stage, reason },
      );
      return {
        message: approve
          ? stage === 'MANAGER'
            ? `Claim passed to finance.`
            : `Claim approved.`
          : `Claim sent back to ${claim!.rep}.`,
      };
    });
  }

  // ---------- The register and the payout ----------

  @Get('reach/expense/register') async register(@Req() req: Request) {
    const actor = await access(req, 'reach.read');
    const { from, to } = spanOf(req);
    const status = req.query.status === undefined ? null : text(req.query.status, 'Status', 0, 20);
    const repId = req.query.rep === undefined ? null : id(req.query.rep);
    return scoped(actor.tenant_id, async (db) => {
      const settings = await expenseSettings(db);
      if (repId && !(await findRep(db, repId)))
        fail(404, 'RECORD_NOT_FOUND', 'That field rep was not found.');
      return expenseRegister(db, { from, to, repId, status: status || null }, settings);
    });
  }

  // The payout file reads the same calculation the register reads, so the two can never disagree
  // about what a rep is owed.
  @Get('reach/expense/payout.csv') async payout(@Req() req: Request, @Res() res: Response) {
    const actor = await access(req, 'reach.read');
    const { from, to } = spanOf(req);
    const rows = await scoped(actor.tenant_id, async (db) => {
      const settings = await expenseSettings(db);
      // Only what finance has approved is paid. A claim still being argued over is not a payout.
      return expenseRegister(db, { from, to, status: 'APPROVED' }, settings);
    });
    const csv = toCsv([
      PAYOUT_COLUMNS,
      ...rows.rows.map((r: any) =>
        PAYOUT_COLUMNS.map((c: string) =>
          String(
            c === 'manager' ? r.manager_name : c === 'finance' ? r.finance_name : (r[c] ?? ''),
          ),
        ),
      ),
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="expenses-${from}-to-${to}.csv"`);
    res.send(csv);
  }

  // ---------- Settings ----------

  @Put('reach/expense/settings') async saveSettings(@Req() req: Request) {
    const raw = body(req, ['expense_fortnightly', 'expense_window_days', 'version']);
    if (!Number.isInteger(raw.version) || raw.version < 0)
      fail(400, 'VERSION_REQUIRED', 'Settings version is missing. Refresh before saving.');
    const errors: { column: string; message: string }[] = [];
    if (typeof raw.expense_fortnightly !== 'boolean')
      errors.push({ column: 'expense_fortnightly', message: 'Say yes or no.' });
    const days = raw.expense_window_days;
    if (!Number.isInteger(days) || days < 0 || days > 180)
      errors.push({
        column: 'expense_window_days',
        message: 'This must be a whole number of days from 0 to 180.',
      });
    if (errors.length) invalid(errors);

    return mutate(req, 'reach.setup', async (db, actor) => {
      const current = await expenseSettings(db);
      if (current.version !== Number(raw.version))
        fail(409, 'STALE_RECORD', 'These settings changed elsewhere. Refresh before saving.');
      const value = {
        expense_fortnightly: raw.expense_fortnightly,
        expense_window_days: days,
      };
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
      return { message: 'Expense settings saved.' };
    });
  }
}
