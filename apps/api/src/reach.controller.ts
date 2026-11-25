// RCH-0 Reach foundation: the readiness checklist for the field masters, and the photos and
// documents those masters and every later Reach screen hang off.
//
// The masters themselves need no code here: they are registered in MASTER_KINDS, so the generic
// masters routes already give them forms, validation, paging, CSV import and audit. What is left
// is what is not generic — a readiness view, and files.
import { Controller, Delete, Get, Param, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { access as fsAccess, constants } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { access, fail, scoped } from './core.js';
import { audit, body, id, mutate, text } from './access.controller.js';
import {
  MAX_FILE_BYTES,
  inspect,
  isPurpose,
  readStream,
  save,
  sizeOnDisk,
  storageRoot,
} from './file-store.js';

// A caller may send any name; it is only ever shown, never used to build a path.
function uploadName(value: unknown, extension: string) {
  if (value === undefined) return `upload.${extension}`;
  if (typeof value !== 'string') fail(400, 'VALIDATION_ERROR', 'The file name is not valid.');
  const cleaned = (value as string)
    .replace(/[\\/]/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, 200);
  return cleaned || `upload.${extension}`;
}

async function fileRow(db: PoolClient, fileId: string) {
  return (
    (
      await db.query(
        `SELECT id,file_no,purpose,content_type,file_name,byte_size,sha256,storage_key,
           pixel_width,pixel_height,uploaded_at
         FROM stored_files WHERE id=$1 AND deleted_at IS NULL`,
        [fileId],
      )
    ).rows[0] ?? null
  );
}

@Controller('api')
export class ReachController {
  // ---------- Readiness ----------

  @Get('reach/readiness') async readiness(@Req() req: Request) {
    const actor = await access(req, 'reach.read');
    // Whether the volume is there at all is not a per-company question, so it is asked once here.
    const storageWritable = await fsAccess(storageRoot, constants.W_OK).then(
      () => true,
      () => false,
    );
    return scoped(actor.tenant_id, async (db) => {
      const counts = (
        await db.query(
          `SELECT (SELECT count(*) FROM territories WHERE active AND deleted_at IS NULL)::int AS territories,
            (SELECT count(*) FROM rep_grades WHERE active AND deleted_at IS NULL)::int AS grades,
            (SELECT count(*) FROM field_reps WHERE active AND deleted_at IS NULL)::int AS reps,
            (SELECT count(*) FROM field_reps WHERE active AND deleted_at IS NULL AND user_id IS NOT NULL)::int AS reps_with_login,
            (SELECT count(*) FROM leave_types WHERE active AND deleted_at IS NULL)::int AS leave_types,
            (SELECT count(*) FROM holidays WHERE active AND deleted_at IS NULL
               AND holiday_date >= date_trunc('year', current_date))::int AS holidays,
            (SELECT count(*) FROM stored_files WHERE deleted_at IS NULL)::int AS files,
            (SELECT count(*) FROM customer_types WHERE active AND deleted_at IS NULL)::int AS types,
            (SELECT count(*) FROM customer_form_fields WHERE active AND deleted_at IS NULL)::int AS form_fields,
            (SELECT count(*) FROM customer_form_rules WHERE active AND deleted_at IS NULL AND requirement <> 'X')::int AS form_rules,
            (SELECT count(*) FROM beats WHERE active AND deleted_at IS NULL)::int AS beats,
            (SELECT count(*) FROM beats b WHERE b.active AND b.deleted_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM beat_outlets o WHERE o.beat_id=b.id))::int AS empty_beats,
            (SELECT count(*) FROM beats b WHERE b.active AND b.deleted_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM beat_assignments a WHERE a.beat_id=b.id
                 AND a.deleted_at IS NULL AND a.to_date IS NULL))::int AS unheld_beats,
            (SELECT count(*) FROM trade_customers WHERE deleted_at IS NULL)::int AS customers,
            (SELECT count(*) FROM trade_customers WHERE deleted_at IS NULL AND status='AWAITING_APPROVAL')::int AS awaiting,
            (SELECT count(*) FROM trade_customers x JOIN customer_types t ON t.id=x.type_id
               WHERE x.deleted_at IS NULL AND x.status='ACTIVE' AND t.geo_required
                 AND x.latitude IS NULL)::int AS untagged`,
        )
      ).rows[0];
      const items = [
        {
          key: 'territories',
          title: 'Territories',
          status: counts.territories ? 'ready' : 'missing',
          count: counts.territories,
          detail: counts.territories
            ? `${counts.territories} in use. A zone may hold territories; nothing deeper.`
            : 'Beats, reps and every Reach report roll up by territory. Add the zones and their territories first.',
        },
        {
          key: 'rep_grades',
          title: 'Rep grades',
          status: counts.grades ? 'ready' : 'missing',
          count: counts.grades,
          detail: counts.grades
            ? `${counts.grades} in use. Expense slabs will read these in seniority order.`
            : 'A grade decides what a rep may claim. Add at least one.',
        },
        {
          key: 'field_reps',
          title: 'Field reps',
          status: counts.reps ? 'ready' : 'missing',
          count: counts.reps,
          detail: counts.reps
            ? `${counts.reps} on the rolls, ${counts.reps_with_login} with a login. A rep without a login can be planned for but cannot sign in.`
            : 'Load the rep list from your spreadsheet, or add one rep to try the screen.',
        },
        {
          key: 'leave_types',
          title: 'Leave types',
          status: counts.leave_types ? 'ready' : 'missing',
          count: counts.leave_types,
          detail: counts.leave_types
            ? `${counts.leave_types} in use. Attendance will mark a leave day against one of these.`
            : 'Attendance needs to know what kinds of leave exist before a rep can apply for one.',
        },
        {
          key: 'holidays',
          title: 'Holiday list',
          status: counts.holidays ? 'ready' : 'missing',
          count: counts.holidays,
          detail: counts.holidays
            ? `${counts.holidays} from the start of this year. A national holiday applies to everyone; a regional one to its territory.`
            : 'Without the holiday list, the attendance register cannot tell a holiday from an absence.',
        },
        {
          key: 'customer_types',
          title: 'Customer types',
          status: counts.types ? 'ready' : 'missing',
          count: counts.types,
          detail: counts.types
            ? `${counts.types} in use. A type decides the form, the check-in radius and whether a new account waits for approval.`
            : 'Nothing about a customer can be asked until its type exists. Import the template to start with the six from the handover.',
        },
        {
          key: 'customer_form',
          title: 'Customer form',
          status: counts.form_rules ? 'ready' : 'missing',
          count: counts.form_rules,
          detail: counts.form_rules
            ? `${counts.form_fields} questions, ${counts.form_rules} of them placed on a type.`
            : 'A question is asked of nobody until it is placed on a type. Add the fields, then the form-by-type matrix.',
        },
        {
          key: 'beats',
          title: 'Beats',
          status: counts.beats ? 'ready' : 'missing',
          count: counts.beats,
          detail: counts.beats
            ? `${counts.beats} rounds. ${counts.empty_beats} with no stops yet, ${counts.unheld_beats} with no rep holding them.`
            : 'A beat is the round a rep walks: its outlets in order, and the days it runs.',
        },
        {
          key: 'customers',
          title: 'Customers',
          status: counts.customers ? 'ready' : 'missing',
          count: counts.customers,
          detail: counts.customers
            ? `${counts.customers} on the register. ${counts.awaiting} waiting for approval, ${counts.untagged} active without the location their type needs.`
            : 'The shops, distributors and institutions the field force calls on. A beat outlet is one of these.',
        },
        {
          key: 'files',
          title: 'Photo and document storage',
          status: storageWritable ? 'ready' : 'missing',
          count: counts.files,
          detail: storageWritable
            ? `Ready, ${counts.files} file${counts.files === 1 ? '' : 's'} kept. Selfies, KYC documents and receipts go to the volume, not the database.`
            : 'The storage volume is not writable, so photos cannot be saved. Check the server volume.',
        },
      ];
      return { items, maxFileBytes: MAX_FILE_BYTES };
    });
  }

  // ---------- Photos and documents ----------

  @Post('files') async upload(@Req() req: Request) {
    if (!Buffer.isBuffer(req.body))
      fail(
        400,
        'FILE_REQUIRED',
        'Send the file itself with its content type. Nothing arrived with this request.',
      );
    const purpose = req.query.purpose === undefined ? 'other' : String(req.query.purpose);
    if (!isPurpose(purpose))
      fail(
        400,
        'VALIDATION_ERROR',
        'A file has to say what it is for: selfie, kyc, receipt, shelf or other.',
      );
    const checked = inspect(req.body as Buffer, String(req.headers['content-type'] ?? ''));
    const name = uploadName(req.query.name, checked.storageKey.split('.').pop()!);
    // RCH-8: the phone's own name for this photo. It travels in the query string because the
    // body is the photo itself. The bytes were already stored once — the path is their sha256 —
    // but the row was not, so without this a retried selfie left an orphan behind it. Harmless
    // to the books, untrue to the promise that everything arrives exactly once.
    const clientRef = req.query.ref === undefined ? '' : text(req.query.ref, 'Reference', 0, 80);
    // Everything from here is inside mutate, which checks the permission before the callback runs:
    // nothing reaches the volume until the caller is allowed to put it there. Within the callback
    // the bytes go down before the row, so a failed insert leaves an orphan the next upload of the
    // same photo reuses, rather than a row pointing at a file that is not there.
    return mutate(req, 'files.upload', async (db, actor) => {
      if (clientRef) {
        const already = (
          await db.query(
            'SELECT id,file_no,purpose,content_type,file_name,byte_size,pixel_width,pixel_height FROM stored_files WHERE client_ref=$1',
            [clientRef],
          )
        ).rows[0];
        if (already)
          return {
            id: already.id,
            fileNo: Number(already.file_no),
            purpose: already.purpose,
            contentType: already.content_type,
            fileName: already.file_name,
            byteSize: Number(already.byte_size),
            pixelWidth: already.pixel_width,
            pixelHeight: already.pixel_height,
            repeat: true,
            message: `${already.file_name} was already uploaded.`,
          };
      }
      await save(checked.storageKey, req.body as Buffer);
      const no = (await db.query("SELECT next_number('stored_file') AS n")).rows[0].n;
      const row = (
        await db.query(
          `INSERT INTO stored_files(id,tenant_id,file_no,purpose,content_type,file_name,byte_size,
             sha256,storage_key,pixel_width,pixel_height,uploaded_by,uploaded_by_subject,client_ref)
           VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id,file_no`,
          [
            actor.tenant_id,
            no,
            purpose,
            checked.contentType,
            name,
            checked.byteSize,
            checked.sha256,
            checked.storageKey,
            checked.pixelWidth,
            checked.pixelHeight,
            actor.id,
            actor.actor_subject ?? null,
            clientRef,
          ],
        )
      ).rows[0];
      await audit(db, actor, 'file.uploaded', 'stored_file', row.id, null, {
        purpose,
        file_name: name,
        content_type: checked.contentType,
        byte_size: checked.byteSize,
      });
      return {
        id: row.id,
        fileNo: Number(row.file_no),
        purpose,
        contentType: checked.contentType,
        fileName: name,
        byteSize: checked.byteSize,
        pixelWidth: checked.pixelWidth,
        pixelHeight: checked.pixelHeight,
        message: `${name} uploaded.`,
      };
    });
  }

  @Get('files/:id') async serve(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') fileId: string,
  ) {
    id(fileId);
    const actor = await access(req, 'files.read');
    // The row is read inside the company's own transaction, so another company's id is a 404 here
    // and never a file on disk.
    const file = await scoped(actor.tenant_id, (db) => fileRow(db, fileId));
    if (!file) fail(404, 'FILE_NOT_FOUND', 'This file was not found in your company.');
    if ((await sizeOnDisk(file.storage_key)) === null)
      fail(
        404,
        'FILE_MISSING',
        'This file is recorded but its contents are not on the server. Upload it again.',
      );
    res.setHeader('Content-Type', file.content_type);
    res.setHeader('Content-Length', String(file.byte_size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // A PDF is handed over as a download rather than rendered in the page, so nothing inside it
    // ever runs in our origin.
    const shown = file.content_type.startsWith('image/');
    res.setHeader(
      'Content-Disposition',
      `${shown ? 'inline' : 'attachment'}; filename="file-${file.file_no}.${file.storage_key.split('.').pop()}"`,
    );
    readStream(file.storage_key).pipe(res);
  }

  @Delete('files/:id') async remove(@Req() req: Request, @Param('id') fileId: string) {
    id(fileId);
    return mutate(req, 'reach.delete', async (db, actor) => {
      const file = await fileRow(db, fileId);
      if (!file) fail(404, 'FILE_NOT_FOUND', 'This file was not found in your company.');
      const used = await db.query(
        'SELECT code FROM field_reps WHERE photo_file_id=$1 AND deleted_at IS NULL LIMIT 1',
        [fileId],
      );
      if (used.rowCount)
        fail(
          409,
          'FILE_IN_USE',
          `This file is the photo of field rep ${used.rows[0].code}. Remove it from the rep first.`,
        );
      // Only the row is stamped. The bytes stay, because another company may hold the same photo
      // and because a removal has to be reversible.
      await db.query('UPDATE stored_files SET deleted_at=now(),deleted_by=$2 WHERE id=$1', [
        fileId,
        actor.id,
      ]);
      await audit(db, actor, 'file.removed', 'stored_file', fileId, file, { deleted: true });
      return { message: `${file.file_name} removed.` };
    });
  }

  // ---------- A rep's photo ----------

  @Put('reach/field-reps/:id/photo') async setPhoto(
    @Req() req: Request,
    @Param('id') repId: string,
  ) {
    id(repId);
    const raw = body(req, ['fileId']);
    const fileId = id(raw.fileId);
    return mutate(req, 'reach.manage', async (db, actor) => {
      if (!actor.permissions.includes('files.read'))
        fail(
          403,
          'PERMISSION_DENIED',
          'You need permission to view photos before attaching one to a rep.',
        );
      const rep = (
        await db.query(
          'SELECT id,code,photo_file_id FROM field_reps WHERE id=$1 AND deleted_at IS NULL',
          [repId],
        )
      ).rows[0];
      if (!rep) fail(404, 'RECORD_NOT_FOUND', 'This field rep was not found in your company.');
      const file = await fileRow(db, fileId);
      if (!file) fail(404, 'FILE_NOT_FOUND', 'This file was not found in your company.');
      if (file.purpose !== 'selfie')
        fail(
          400,
          'WRONG_FILE_PURPOSE',
          "A rep's photo has to be uploaded as a selfie. Upload the photo again from this screen.",
        );
      await db.query(
        'UPDATE field_reps SET photo_file_id=$2,version=version+1,updated_at=now() WHERE id=$1',
        [repId, fileId],
      );
      await audit(
        db,
        actor,
        'field_reps.photo_set',
        'field_reps',
        repId,
        { photo_file_id: rep.photo_file_id },
        { photo_file_id: fileId },
      );
      return { message: `Photo saved for field rep ${rep.code}.` };
    });
  }

  @Delete('reach/field-reps/:id/photo') async clearPhoto(
    @Req() req: Request,
    @Param('id') repId: string,
  ) {
    id(repId);
    return mutate(req, 'reach.manage', async (db, actor) => {
      const rep = (
        await db.query(
          'SELECT id,code,photo_file_id FROM field_reps WHERE id=$1 AND deleted_at IS NULL',
          [repId],
        )
      ).rows[0];
      if (!rep) fail(404, 'RECORD_NOT_FOUND', 'This field rep was not found in your company.');
      if (!rep.photo_file_id)
        fail(409, 'NO_PHOTO', `Field rep ${rep.code} has no photo to remove.`);
      await db.query(
        'UPDATE field_reps SET photo_file_id=NULL,version=version+1,updated_at=now() WHERE id=$1',
        [repId],
      );
      await audit(
        db,
        actor,
        'field_reps.photo_cleared',
        'field_reps',
        repId,
        { photo_file_id: rep.photo_file_id },
        { photo_file_id: null },
      );
      return { message: `Photo removed from field rep ${rep.code}.` };
    });
  }
}
