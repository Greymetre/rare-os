// AV-10 delivery (Nilkamal simulation handover, 21-Sep-2026: Order OTIF, Buffer Board & Exceptions,
// Alerts, Planning Priorities and the Release Schedule): what the current calculation promises,
// what it is about to deliver, and the planner's day. Read-only, with CSV of every list.
import {
  DELIVERY_EXPORTS,
  deliveryCsv,
  deliveryView,
} from '../../../packages/schema/delivery-db.mjs';
import { planningStatus } from '../../../packages/schema/planning-db.mjs';
import { toCsv } from '../../../packages/schema/imports.mjs';
import { Controller, Get, Req, Res, Param } from '@nestjs/common';
import type { Request, Response } from 'express';
import { access, scoped, fail } from './core.js';
import { id } from './access.controller.js';
import { requirePlant } from './plants.controller.js';

@Controller('api')
export class DeliveryController {
  @Get('plants/:plantId/delivery') async delivery(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const status = await planningStatus(db);
      const view = await deliveryView(db, plant.id);
      return {
        ...view,
        // The stale-data indicator: what the numbers were calculated from, and whether inputs moved.
        calculation: {
          runNo: status.current ? Number(status.current.run_no) : null,
          calculatedAt: status.current?.finished_at ?? null,
          upToDate: status.upToDate,
          recalculating: status.queued,
          fixedDate: status.fixedDate ?? null,
        },
      };
    });
  }

  @Get('plants/:plantId/delivery/:kind.csv') async exportCsv(
    @Req() req: Request,
    @Res() res: Response,
    @Param('plantId') plantId: string,
    @Param('kind') kind: string,
  ) {
    if (!DELIVERY_EXPORTS.includes(kind)) fail(404, 'NOT_FOUND', 'Unknown export.');
    const actor = await access(req, 'planning.read');
    const { csv, plant } = await scoped(actor.tenant_id, async (db) => {
      const p = await requirePlant(db, actor, id(plantId));
      const view = await deliveryView(db, p.id);
      if (view.empty) fail(409, 'NO_SCHEDULE', view.empty);
      return { csv: toCsv(deliveryCsv(kind, view)), plant: p };
    });
    res
      .status(200)
      .setHeader('Content-Type', 'text/csv; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename="${plant.code}-${kind}.csv"`)
      .send(csv);
  }
}
