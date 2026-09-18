import { approvalProblem } from '../../../packages/engines/purchase.mjs';
import { orderDetail } from '../../../packages/schema/demand-stock-db.mjs';
import { planningStatus } from '../../../packages/schema/planning-db.mjs';
import {
  approveProposal,
  changeProposal,
  createManualProposal,
  listProposals,
  postReceipt,
  proposalDetail,
  receiptsFor,
  rejectProposal,
} from '../../../packages/schema/purchase-db.mjs';
import { validateFields } from '../../../packages/schema/masters.mjs';
import { Controller, Get, Post, Patch, Req, Param } from '@nestjs/common';
import type { Request } from 'express';
import { access, scoped, fail } from './core.js';
import { id, text, body, version, mutate, audit } from './access.controller.js';
import { requirePlant } from './plants.controller.js';
import { invalid, loaded, today } from './plant-model.controller.js';

const STATUSES = ['PROPOSED', 'APPROVED', 'REJECTED', 'WITHDRAWN'];
const dateField = (name: string, label: string) => ({
  name,
  label,
  type: 'date' as const,
  required: true,
});

function proposalInput(raw: any, withItem: boolean) {
  const { value, errors } = validateFields(
    [
      ...(withItem
        ? [{ name: 'item', label: 'Item code', type: 'ref' as const, ref: 'items', required: true }]
        : []),
      { name: 'quantity', label: 'Quantity', type: 'text' as const, required: true, max: 20 },
      dateField('due_date', 'Due date'),
      { name: 'note', label: 'Note', type: 'text' as const, max: 300 },
    ],
    raw,
  );
  if (errors.length) invalid(errors);
  if (value.due_date < today())
    invalid([{ column: 'due_date', message: 'Due date cannot be in the past.' }]);
  return value;
}

@Controller('api')
export class PurchaseController {
  @Get('plants/:plantId/purchase-proposals') async proposals(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'purchase.read');
    const status = req.query.status === undefined ? 'PROPOSED' : String(req.query.status) || null;
    if (status && !STATUSES.includes(status))
      fail(400, 'VALIDATION_ERROR', 'Unknown proposal status.');
    const q =
      req.query.q === undefined ? '' : String(req.query.q).trim().toLowerCase().slice(0, 40);
    const cursor =
      req.query.cursor === undefined
        ? null
        : /^[1-9][0-9]{0,17}$/.test(String(req.query.cursor))
          ? String(req.query.cursor)
          : fail(400, 'INVALID_CURSOR', 'This page link is invalid. Return to the first page.');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      return listProposals(db, plant.id, { status, q, cursor });
    });
  }

  @Get('purchase-proposals/:id') async proposal(
    @Req() req: Request,
    @Param('id') proposalId: string,
  ) {
    const actor = await access(req, 'purchase.read');
    return scoped(actor.tenant_id, async (db) => {
      const p: any = await loaded(await proposalDetail(db, id(proposalId)), 'purchase proposal');
      await requirePlant(db, actor, p.site_id);
      return p;
    });
  }

  @Post('plants/:plantId/purchase-proposals') async raise(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    id(plantId);
    const input = proposalInput(body(req, ['item', 'quantity', 'due_date', 'note']), true);
    return mutate(req, 'purchase.create', async (db, actor) => {
      const plant = await requirePlant(db, actor, plantId);
      const pending = (
        await db.query(
          "SELECT p.proposal_no FROM purchase_proposals p JOIN items i ON i.id=p.item_id WHERE p.site_id=$1 AND lower(i.code)=lower($2) AND p.status='PROPOSED'",
          [plant.id, input.item],
        )
      ).rows[0];
      if (pending)
        fail(
          409,
          'ALREADY_PROPOSED',
          `Proposal #${pending.proposal_no} is already pending for ${input.item}. Change that one instead.`,
        );
      const r = await createManualProposal(db, actor.tenant_id, actor, plant.id, input);
      if (r.errors.length) invalid(r.errors);
      await audit(db, actor, 'purchase_proposal.raised', 'purchase_proposal', r.id!, null, input);
      return {
        id: r.id,
        message: `Proposal #${r.proposalNo} raised for ${input.item} from ${r.supplier}. Another person must approve it.`,
      };
    });
  }

  @Patch('purchase-proposals/:id') async change(
    @Req() req: Request,
    @Param('id') proposalId: string,
  ) {
    id(proposalId);
    const raw = body(req, ['quantity', 'due_date', 'note', 'version']);
    const v = version(raw.version);
    const input = proposalInput(raw, false);
    return mutate(req, 'purchase.create', async (db, actor) => {
      const p: any = await loaded(await proposalDetail(db, proposalId), 'purchase proposal');
      await requirePlant(db, actor, p.site_id);
      if (p.status !== 'PROPOSED')
        fail(
          409,
          'PROPOSAL_CLOSED',
          `Proposal #${p.proposal_no} is already ${p.status.toLowerCase()}.`,
        );
      if (p.version !== v)
        fail(
          409,
          'STALE_RECORD',
          `Proposal #${p.proposal_no} changed elsewhere. Refresh before saving.`,
        );
      const r = await changeProposal(db, actor, p, input);
      if (r.errors.length) invalid(r.errors);
      await audit(db, actor, 'purchase_proposal.changed', 'purchase_proposal', p.id, p, input);
      return { message: `Proposal #${p.proposal_no} saved. Someone else must approve it now.` };
    });
  }

  @Post('purchase-proposals/:id/approve') async approve(
    @Req() req: Request,
    @Param('id') proposalId: string,
  ) {
    id(proposalId);
    const v = version(body(req, ['version']).version);
    return mutate(req, 'purchase.approve', async (db, actor) => {
      const p: any = await loaded(await proposalDetail(db, proposalId), 'purchase proposal');
      await requirePlant(db, actor, p.site_id);
      await db.query('SELECT 1 FROM purchase_proposals WHERE id=$1 FOR UPDATE', [p.id]);
      const status = await planningStatus(db);
      const problem = approvalProblem({
        proposal: p,
        actorSubject: actor.actor_subject,
        version: v,
        planning: { upToDate: status.upToDate, currentRunNo: status.current?.run_no },
      });
      if (problem) fail(409, 'APPROVAL_NOT_ALLOWED', problem);
      const r = await approveProposal(db, actor.tenant_id, actor, p, today());
      if (r.error) fail(409, 'APPROVAL_NOT_ALLOWED', r.error);
      await audit(db, actor, 'purchase_proposal.approved', 'purchase_proposal', p.id, p, {
        po: r.poNo,
      });
      return {
        poId: r.poId,
        message: `Proposal #${p.proposal_no} approved. Purchase order ${r.poNo} created for ${Number(p.quantity)} ${p.unit} of ${p.item} from ${p.supplier}. It counts as incoming supply until goods are received.`,
      };
    });
  }

  // Approves several proposals against the same, up-to-date calculation in one step.
  @Post('plants/:plantId/purchase-proposals/approve') async approveMany(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    id(plantId);
    const items = body(req, ['items']).items;
    if (!Array.isArray(items) || !items.length || items.length > 200)
      fail(400, 'VALIDATION_ERROR', 'Choose between 1 and 200 proposals to approve.');
    const chosen = (items as any[]).map((x) => ({ id: id(x?.id), version: version(x?.version) }));
    return mutate(req, 'purchase.approve', async (db, actor) => {
      const plant = await requirePlant(db, actor, plantId);
      const status = await planningStatus(db);
      const planning = { upToDate: status.upToDate, currentRunNo: status.current?.run_no };
      const proposals: any[] = [];
      for (const c of chosen) {
        const p: any = await loaded(await proposalDetail(db, c.id), 'purchase proposal');
        if (p.site_id !== plant.id)
          fail(400, 'VALIDATION_ERROR', 'All proposals must belong to this plant.');
        await db.query('SELECT 1 FROM purchase_proposals WHERE id=$1 FOR UPDATE', [p.id]);
        const problem = approvalProblem({
          proposal: p,
          actorSubject: actor.actor_subject,
          version: c.version,
          planning,
        });
        if (problem) fail(409, 'APPROVAL_NOT_ALLOWED', problem + ' Nothing was approved.');
        proposals.push(p);
      }
      const orders: string[] = [];
      for (const p of proposals) {
        const r = await approveProposal(db, actor.tenant_id, actor, p, today());
        if (r.error) fail(409, 'APPROVAL_NOT_ALLOWED', r.error + ' Nothing was approved.');
        orders.push(r.poNo!);
        await audit(db, actor, 'purchase_proposal.approved', 'purchase_proposal', p.id, p, {
          po: r.poNo,
        });
      }
      return {
        message: `${proposals.length} proposal(s) approved. Purchase orders ${orders.join(', ')} created; they count as incoming supply until goods are received.`,
      };
    });
  }

  @Post('purchase-proposals/:id/reject') async reject(
    @Req() req: Request,
    @Param('id') proposalId: string,
  ) {
    id(proposalId);
    const raw = body(req, ['version', 'reason']);
    const v = version(raw.version);
    const reason = text(raw.reason, 'Reason', 3, 300);
    return mutate(req, 'purchase.approve', async (db, actor) => {
      const p: any = await loaded(await proposalDetail(db, proposalId), 'purchase proposal');
      await requirePlant(db, actor, p.site_id);
      if (p.status !== 'PROPOSED')
        fail(
          409,
          'PROPOSAL_CLOSED',
          `Proposal #${p.proposal_no} is already ${p.status.toLowerCase()}.`,
        );
      if (p.version !== v)
        fail(
          409,
          'STALE_RECORD',
          `Proposal #${p.proposal_no} changed after you opened it. Review it again.`,
        );
      await rejectProposal(db, actor, p, reason);
      await audit(db, actor, 'purchase_proposal.rejected', 'purchase_proposal', p.id, p, {
        reason,
      });
      return {
        message: `Proposal #${p.proposal_no} rejected. It is not raised again unless the need changes.`,
      };
    });
  }

  // ---------- Goods receipts ----------
  @Get('purchase-orders/:id/receipts') async receipts(
    @Req() req: Request,
    @Param('id') poId: string,
  ) {
    const actor = await access(req, 'purchase.read');
    return scoped(actor.tenant_id, async (db) => {
      const po: any = await loaded(
        await orderDetail(db, 'purchase_orders', id(poId)),
        'purchase order',
      );
      await requirePlant(db, actor, po.site_id);
      return { items: await receiptsFor(db, po.id) };
    });
  }

  @Post('purchase-orders/:id/receipts') async receive(
    @Req() req: Request,
    @Param('id') poId: string,
  ) {
    id(poId);
    const raw = body(req, ['request_id', 'location', 'receipt_date', 'reference', 'lines']);
    const requestId = id(raw.request_id);
    const { value, errors } = validateFields(
      [
        { name: 'location', label: 'Location code', type: 'ref', ref: 'locations', required: true },
        dateField('receipt_date', 'Receipt date'),
        { name: 'reference', label: 'Reference (GRN / delivery note)', type: 'text', max: 60 },
      ],
      raw,
    );
    if (errors.length) invalid(errors);
    if (!Array.isArray(raw.lines) || raw.lines.length > 999)
      fail(400, 'VALIDATION_ERROR', 'Provide the received quantity per line.');
    const lines = (raw.lines as any[])
      .filter((l) => l && String(l.quantity ?? '').trim() !== '')
      .map((l) => {
        const lineNo = Number(l.line_no);
        if (!Number.isInteger(lineNo) || lineNo < 1)
          fail(400, 'VALIDATION_ERROR', 'Each line needs its line number.');
        return { line_no: lineNo, quantity: String(l.quantity).trim() };
      });
    return mutate(req, 'inventory.move', async (db, actor) => {
      const po: any = await loaded(
        await orderDetail(db, 'purchase_orders', poId),
        'purchase order',
      );
      await requirePlant(db, actor, po.site_id);
      const r = await postReceipt(
        db,
        actor.tenant_id,
        actor,
        po,
        { ...value, request_id: requestId, lines },
        today(),
      );
      if (r.errors.length) invalid(r.errors);
      if (!r.duplicate)
        await audit(db, actor, 'goods_receipt.posted', 'purchase_order', po.id, null, {
          receipt: r.receiptNo,
          lines,
        });
      return {
        receiptNo: r.receiptNo,
        message: r.duplicate
          ? `Receipt GRN-${r.receiptNo} was already recorded. Nothing was received twice.`
          : `Receipt GRN-${r.receiptNo} posted against ${po.no}. Stock updated.`,
      };
    });
  }
}
