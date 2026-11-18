# Current handoff — 18 November 2026 (RCH-2 to RCH-5, Claude Code)

RCH-0 and RCH-1 went live on 17 November as `9668e10` with 30 migrations. This change adds RCH-2
(attendance and leave), RCH-3 (the tour plan), RCH-4 (visits and the check-out report) and RCH-5
(Customer 360) together, with migrations 031, 032, 033 and 034, plus a one-line fix to the Reach
subtitle in the shell. **Nothing is pushed.**

## The rule all four milestones are built on

Neither the attendance register nor plan-versus-actual is ever stored. Present, Late, Half day,
Leave, Absent, Week-off, Holiday — and Followed, Partial, Deviated, Missed, Unplanned — are read
out of the evidence every time they are asked for, by `packages/engines/attendance.mjs` and
`packages/engines/tour-plan.mjs`. That is what makes the two milestone acceptance tests work
without anything being rewritten: correcting a punch re-reads last month's register, and leave
approved _after_ a tour plan was approved stops that day counting as missed.

Leave, holidays and week-offs are not repeated in RCH-3. Attendance owns them and the plan asks
it again, so a company cannot end up holding the same holiday in two places.

## What RCH-2 added

- **Migration `031_reach_attendance.sql`**: `work_types`, `shifts` (both new generic masters),
  `attendance_days` — which deliberately carries **no status column** — `leave_requests` and
  `attendance_edits`, plus four settings columns on the existing `reach_settings` row. Row-level
  scoped, and **no DELETE granted anywhere**: a punch, a leave decision and a correction are
  records of what happened.
- `packages/engines/attendance.mjs` and `packages/schema/attendance-db.mjs`: the register, the day
  board with its reminder proposal, leave balances, corrections and the payroll CSV. SQL converts
  timestamps with `AT TIME ZONE` and hands the engine `'HH:MM'`, so the engine never has to guess
  whose midnight a working day belongs to.
- `reach-attendance.controller.ts` (14 routes) and `reach-attendance.tsx` (6 screens).
- Permissions `reach.attend` (stands alone on purpose) and `reach.leave`.

## What RCH-3 added

- **Migration `032_reach_tour_plan.sql`**: `tour_plans`, `tour_plan_days`, `tour_plan_changes`,
  and a minimal `visits` table. Four more settings columns on the same `reach_settings` row. Again
  row-level scoped with **no DELETE anywhere**, and a day taken off a round keeps its row with no
  beat on it rather than being deleted, so a month always reads as a whole month.
- **The auto-fill.** A beat already says which weekdays it runs on and which half of a fortnight
  it belongs to, so a month of those rules is a month of planned days. The rep is handed a filled
  calendar to correct instead of an empty one to type. A second run refreshes only the rows it
  wrote itself and leaves a typed day alone. Two rounds claiming one day is reported, not silently
  resolved.
- **Submit, approve, send back** — a send-back needs a reason the rep can read — and, once a month
  is approved, **one day moves by request**: one request in flight per day, decided once, and what
  the day said before is kept on the request itself.
- **Plan versus actual** from the plan, the visits and the attendance register.
- `reach-tour.controller.ts` (12 routes) and `reach-tour.tsx` (5 screens).
- Permissions `reach.plan` (stands alone, like `reach.attend`) and `reach.plan_approve`.

### One scope decision worth knowing

RCH-4 owns the visit — check-out, the per-type report form, duration, and the rule that three
check-ins from a bad network collapse into one visit. RCH-3 creates only the part adherence has to
read: one row per visit, where and when. **Nothing in RCH-3 writes a visit**, so Plan vs actual
reads real data only once RCH-4 lands. RCH-4 should add its columns to that same row rather than
start a second table beside it. The engine, the SQL and both acceptance cases are proven now.

Four numbers (plan due day 25, 12 outlets a day, 75% field days, Followed at 60%) are the
prototype's defaults for questions 5, 6 and 8 of the milestone plan that the client has not
answered yet. All four change from `Reach > Customer setup > Tour plan settings` without a deploy.

Question 8 — "can a manager edit a rep's plan?" — was answered **no**, as the plan proposes. A
manager approves a month or sends it back and never types into it; every plan write is refused
unless the plan belongs to the signed-in rep.

## What RCH-4 added

The milestone plan calls this the heart of Reach, and the handover is explicit that the path has
to be solid on the server before a mobile app is written against it. Three rules are enforced in
the migration and the controller rather than left to a screen.

- **A check-in is never refused for being far away.** A rep 800 metres from the shop is recorded
  and flagged; `distance_m` and `out_of_fence` are evidence, and no constraint and no route tests
  them as a gate. Refusing one loses a real visit and teaches the salesman to distrust the app —
  the handover's own words. The radius belongs to the customer type, because a distributor's yard
  and a retailer's counter are not the same distance.
- **The same check-in sent three times is one visit.** Two unique indexes make that safe rather
  than hopeful: `visits_open_idx` (one open visit per rep per shop) and `visits_client_ref_idx`
  (one reference, one visit). A retry inside the company's retry window is answered with the
  visit that already exists, and the route says so (`repeated: true`) instead of failing.
- **How a visit reads is calculated.** No status column, no duration column, no "report complete"
  flag. The duration is the two timestamps; the completeness is judged against the report form as
  it stands now, so making a question required today makes yesterday's report say it is missing
  it.

What that took:

- **Migration `033_reach_visits.sql`**: the rest of the `visits` table RCH-3 started — check-out,
  its location, the report, the client reference and the beat it was walked under — plus
  `visit_form_fields` and `visit_form_rules`, and one settings column.
- **The report form is the customer form's own machinery.** The same matrix, the same engine
  (`packages/engines/customer-form.mjs`), so a distributor call and a retailer call are different
  conversations without a second system to maintain. Both new masters arrive with CRUD, CSV
  templates and imports for free.
- **The field app** is drawn inside a phone-shaped frame on purpose: it is the reference the
  mobile app will be written against. It takes today's round from RCH-3's approved plan, and a
  call nobody planned is kept as unplanned work rather than discarded.
- `reach-visit.controller.ts` (10 routes) and `reach-visit.tsx` (4 screens).
- Permission `reach.visit` (stands alone, like `reach.attend` and `reach.plan`).

RCH-3's plan-versus-actual now reads real visits rather than rows a test inserted.

### The one open question left as it was

Milestone plan question 12 — out-of-radius check-in, **block or flag?** — is still open with the
client. The answer built here is **flag**, because the handover warns against the alternative in
terms. No half-built blocking path was added: if the client says block, that is a small change in
one controller, and the warning should be put to them first.

## What RCH-5 added

- **Migration `034_reach_trade.sql`**: eleven tables — `kyc_types`, `kyc_rules`, `kyc_documents`,
  `price_list_items`, `trade_schemes`, `trade_orders`, `trade_order_lines`, `trade_invoices`,
  `trade_invoice_lines`, `trade_receipts` and `invoice_series` — plus per-customer credit
  overrides on `trade_customers` and three more settings columns on the same `reach_settings`
  row. Row-level scoped, and **no DELETE granted anywhere**: an order, a bill, a collection and a
  KYC decision are all records of what happened or what somebody decided.
- **The same rule again, carried further.** The outstanding, the ageing, the credit hold, the KYC
  state, DSO and the sales summary are all read from the evidence on every request. There is no
  outstanding column, no hold flag, no KYC-state column and no stored age — which is why a held
  order clears the moment money lands or a document is verified, with nothing to find and rewrite.
  The security baseline asserts the absence of each of those columns.
- **An order is never refused for credit.** One over the limit, or placed before the type's KYC
  is verified, is taken and held with its reasons recorded. Releasing a hold is its own right
  (`reach.credit`) and needs a reason. This is the same principle as a check-in from outside the
  fence, and it is the milestone's own acceptance test.
- **A bill arrives two ways, and a permission is the only switch.** `reach.invoice` granted to
  nobody means no invoice can be raised in this system and every bill arrives from an ERP and is
  recorded here. Granted, this module issues its own numbers from a per-company, per-prefix,
  per-financial-year series whose counter is read and advanced in **one statement**, so two people
  billing at the same moment cannot be handed the same number. A cancelled bill keeps its number
  used. `source = 'RAISED'` and `series_id` are tied together by a table CHECK, so the two
  numbering authorities stay told apart for ever. There is no setting to deploy and no path to
  turn on later.
- **Both kinds of bill have the same shape** — line, rate, GST %, taxable, tax. A recorded bill
  fills in what its document knew and leaves the rest null rather than inventing it, so adding the
  legal GST fields later is adding columns, not changing the design.
- `packages/engines/trade.mjs` (price, scheme, line, ageing, DSO, credit, KYC, sales, timeline),
  `packages/schema/trade-db.mjs`, `reach-trade.controller.ts` (20 routes) and `reach-trade.tsx`
  (5 screens: Customer 360, Take order, Orders, Paperwork, Customer 360 settings).
- Four new generic masters — KYC documents, KYC by type, Price list, Schemes — which means CRUD,
  keyset paging, a CSV template, import and audit came for free.
- Permissions `reach.order`, `reach.collect`, `reach.kyc`, `reach.credit` and `reach.invoice`.

### Two open questions for the client

1. **Is RARE OS to issue legally valid GST tax invoices?** What it issues today is a numbered
   internal record. A legal tax invoice also needs the seller GSTIN per place of business, place
   of supply, HSN per line, the CGST/SGST/IGST split and, above the turnover limit, e-invoicing
   with an IRN. The migration header says so in terms. The shape is already right for it; this is
   columns and a print layout, not a redesign.
2. Milestone plan question 12 — out-of-radius check-in, block or flag — remains as RCH-4 left it.

## A decision taken on the user's instruction

Money and rates are not the same precision. **Rates keep four decimals** (`unitRate`) because a
bulk list quotes a piece at 0.3333; only the amounts a rate produces are rounded to the paisa. The
first version rounded the rate itself, which turned 3 × 0.333333 into 0.99.

## Defects found and fixed while building

- `version(raw)` was passed the whole request object in three routes, so leave decide, end-day and
  withdraw were permanently broken. Caught by the browser spec.
- `text(raw.note, 'Note', 0, 300)` rejects `undefined`, so starting a day without a note was
  impossible. Four optional text fields guarded.
- A rep could not load their own screens: they fetched master lists that need `reach.read`. The
  choices now travel with the screen instead.
- `reach.attend` was briefly made to depend on `reach.read`, which would have handed every field
  rep the day board, everyone else's register and the payroll export. Removed.
- Extending `SETTING_DEFAULTS` meant a partial settings save wrote NULL into NOT NULL columns.
  `saveReachSettings` now merges against the current row; RCH-3's four columns are covered by the
  same fix and it is asserted in both the dry run and the security baseline.
- `removalBlockers` would have crashed on the tables with no `deleted_at`; they are now listed as
  permanent.
- `weekdayOf('2026-13-01')` returned 'FRI' because `Date.UTC` rolls bad dates forward. The shared
  date parser now round-trips.
- `visit_dedupe_minutes` was added to the migration but not to `SETTING_DEFAULTS`, so the setting
  could never be read or saved. Caught by the dry run on its first line.
- `visitBoard` spread `daySummary` over each rep's row, and `daySummary` reports a count called
  `visits` — which silently replaced the rep's list of visits with a number. The summary now sits
  under its own key.
- `kyc_documents.uploaded_at` defaulted to `now()`, which is constant inside a transaction. Every
  document uploaded in one go shared a timestamp, so "the newest document" was undecidable and a
  re-upload after a rejection never took effect. It is `clock_timestamp()` now, with a stable
  `ORDER BY uploaded_at DESC, id DESC` behind it.
- `tradeCustomer` never selected `version`, so saving a customer's own credit terms always failed
  the optimistic-concurrency check.
- Lines on a recorded bill were written with `total: 0`, which would have made "top SKU" read zero
  for every item billed from an ERP. They carry their own money now, and the lines have to add up
  to what the bill says it came to.
- `lineAmount` rounded the rate to the paisa before multiplying — see the note above.
- The `invoice_series` foreign key was declared before the table existed.
- RCH-3's spec fixture inserted visits with no check-out, which RCH-4's new `visits_open_idx`
  correctly refused. **RCH-4's rule caught a genuine flaw in RCH-3's test data**, not the other way
  round; the fixture now closes its visits.
- The shell opened the Reach module only for `reach.read|reach.attend|reach.plan|reach.visit`.
  A rep holding `reach.order` and `reach.collect` could not open Reach at all, so the screens
  their own rights unlocked sat behind a door they could not open. This is the same mistake as
  the earlier `reach.attend` one, in the other direction, and only the browser spec finds it.
- Reach always opened on the readiness checklist, which needs `reach.read`. Every rep-only login
  since RCH-2 landed on a 403 before touching anything. The module now opens on the first screen
  the signed-in person's permissions actually unlock.

## Tests

- Unit: `tests/attendance.test.mjs` (13), `tests/tour-plan.test.mjs` (14),
  `tests/visit.test.mjs` (11) and `tests/trade.test.mjs` (16), plus new RCH-2, RCH-3, RCH-4 and
  RCH-5 suites in `tests/security-baseline.test.mjs`. **228 unit tests, 10 security suites.**
- DB dry runs against real Postgres, inside a transaction that is always rolled back: 34 checks
  for RCH-2, 60 for RCH-3, 44 for RCH-4 and 83 for RCH-5 — including every milestone acceptance
  case through real SQL.
- All 34 migrations replayed from an empty database on a throwaway stack (107 tables), so the
  schema is proven from zero rather than only through the deltas applied by hand locally.
- Browser/API + VAPT: `tests/reach-attendance.spec.ts`, `tests/reach-tour.spec.ts`,
  `tests/reach-visit.spec.ts` and `tests/reach-trade.spec.ts`.
- Manual steps in `docs/REACH_TEST_GUIDE_HINGLISH.md`; coverage rows in
  `docs/REGRESSION_TESTING_HINGLISH.md`.
- One clean full regression on a disposable stack: **38 specs passed in 24.7 minutes**, and all
  eleven steps green — browser suite, database isolation and privileges, repeat-safe demo seeder,
  application and identity backup/restore, and the offsite encrypted backup and restore drill.

### The regression harness hid a gap, and that is fixed too

`scripts/regression.mjs` killed every step at 25 minutes. The browser suite is one step that runs
every spec on one worker, so four new Reach specs pushed it past the cap: a run reported 37 specs
green, `security.spec.ts` never ran, and the only sign was the word FAILED at the bottom. Nothing
said a spec had been skipped, which is exactly the shape of a result somebody skims and believes.
The cap is now per step — 25 minutes still guards the short ones, the browser suite has 75 — with
a note at the call site that reaching it again means splitting the suite, not raising the number.

`tests/reach-masters.test.mjs` pinned the whole list of things that point at a beat, a rep and a
customer type, which RCH-3 and RCH-4 both legitimately add to. It now checks its own entries by
name — the same lesson RCH-0's spec taught during RCH-1, met twice more here. No product code
changed for it.

## The dependency gate was rewritten, on the user's instruction

A new advisory (GHSA-fc5q-39xc-vjpf, ReDoS in `picomatch`) turned `npm audit --audit-level=low`
red. There is no fixed version — 4.0.7 is the latest and the advisory covers every release — and
`picomatch` is reached only through `vite → tinyglobby → fdir` at build time. `npm audit fix
--force` would drop vite from 8.3.5 to 6.2.7. Production dependencies are clean.

`security:dependencies` now runs `scripts/audit.mjs`, which audits twice. **Production
dependencies are audited at `low` with no exceptions possible at all** — there is no code path in
that file which could let a shipped vulnerability through. The whole tree, build toolchain
included, is also audited at `low`, and only there may an advisory be accepted by id, with a
reason and a date it has to be looked at again. The date for this one is **28 February 2027**;
past it the gate goes red by itself, and when the advisory disappears the script says to delete
the entry. Lowering a threshold or suppressing a report was not done and should not be.

## Before any push

Nothing to change in `.env`. After deploying, `Reach > Tour plan` appears for anyone holding
`reach.plan` or `reach.read`, `Reach > Field work` for anyone holding `reach.visit` or
`reach.read`, and `Reach > Trade` for anyone holding `reach.order` or `reach.read`; all start
empty until a rep starts a month, walks a round and takes an order. The visit report form starts
empty too, which means no questions are asked on check-out until someone places them under
`Reach > Customer setup > Visit report by type`.

**Decide `reach.invoice` before granting anything.** It is the only switch between "bills are
raised in RARE OS" and "bills arrive from the ERP". Granting it to nobody is a complete, working
configuration and is the safer default until the client has answered the GST question above; it
can be granted later without a deploy. The four other new rights (`reach.order`, `reach.collect`,
`reach.kyc`, `reach.credit`) are granted the same way, under `Access > Roles`.

---

# Current handoff — 16 November 2026 (RCH-1 customers and beats, Claude Code)

RCH-0 and RCH-1 are both in this change, pushed together on the user's instruction. Live was
`542760e` with 28 migrations; this adds migrations 029 and 030.

## What RCH-1 added

- **Migration `030_reach_customers.sql`**: `reach_settings` (the distances that decide a location
  tag), `customer_types`, `customer_form_fields` and `customer_form_rules`, `beats`,
  `trade_customers`, `beat_outlets`, `beat_assignments`, `customer_geo_log`. Row-level scoped and
  soft-deleted like the rest; `beat_outlets` is the one table the runtime role may DELETE from,
  because a stop leaving a round is not a record to keep.
- **A customer form that each type defines for itself.** `customer_form_fields` holds the fields
  and `customer_form_rules` says, per type, whether each one is required, optional or not asked
  (R/O/X). `packages/engines/customer-form.mjs` turns those rows into field descriptors that
  `validateFields` already understands, so one matrix drives the form, the validation and the CSV.
  A value sent for a field the type does not ask for is refused rather than quietly stored.
- **Beats and rounds.** A beat carries its frequency, run days and week parity, with a check that
  only a fortnightly beat may pick odd or even weeks. Stops are ordered 1..500 under a
  `DEFERRABLE INITIALLY IMMEDIATE` unique constraint, so a reorder can swap two stops past each
  other inside one transaction instead of tripping over itself. Assignments are dated spells with
  one open spell per beat.
- **Location tagging.** `packages/engines/geo.mjs` is pure: haversine distance in metres and one
  decision — whether a tag counts as verified, and whether moving an existing customer needs
  approval. Beyond the retag distance the change is held as `PENDING` in `customer_geo_log` until
  someone decides it; duplicates within the configured radius are surfaced before a new customer
  is accepted.
- **Approvals and settings** screens, plus the customer register with tiles, search, filters, CSV,
  the per-type form, status changes and removal with a reason — `reach-customers.controller.ts`
  (20 routes) and `reach-customers.tsx`.

## Defect found and fixed

The create handler read the customer back **before** `syncBeatMembership` wrote the beat row, so a
new customer on a beat was confirmed with "at stop null" rather than its stop number. The record is
now read again after the sync. The row itself was always correct — only the message was wrong —
but it is exactly the kind of ordering mistake the browser regression exists to catch, and it was
the one assertion failing in `tests/reach-customers.spec.ts`.

## Tests

- Unit: `tests/reach-customers.test.mjs`, `tests/geo.test.mjs`, and RCH-1 assertions in
  `tests/security-baseline.test.mjs` (row-level scoping of the new tables, the deferrable stop
  constraint, one pending retag per customer, coordinate and enum validation at the controller).
- Browser/API + VAPT: `tests/reach-customers.spec.ts` — the per-type form, a beat round and its
  reorder, the three kinds of location tag, the retag approval flow, duplicate detection, plus
  permission denial and cross-company invisibility.
- Manual steps in `docs/REACH_TEST_GUIDE_HINGLISH.md` (12 RCH-1 sections); coverage rows in
  `docs/REGRESSION_TESTING_HINGLISH.md`.

## Before any push

Regression `mwk98d4x-ac990cda`: **PASSED** — all eleven steps, 34/34 browser scenarios, 171 unit
tests, database isolation and privileges, the demo seeder, application and identity restore, and
the offsite backup and restore drill.

Three assertions in `tests/reach-foundation.spec.ts` had to be loosened first. RCH-0 was written
when Reach held nothing else, so it pinned the readiness checklist to six rows, the import picker
to five kinds and the master catalogue to five Reach masters. RCH-1 legitimately adds five of each,
and the spec read those as failures. Each now looks for the rows, kinds and masters this milestone
owns rather than pinning the whole list, so RCH-2..RCH-8 will not break it again. No product code
changed for any of the three.

Nothing to change in `.env`. After deploying, `Reach > Readiness` should show every RCH-0 and RCH-1
row ready; the customer register starts empty until customer types and a form are set up under
`Reach > Customer setup`.

---

# Current handoff — 28 October 2026 (RCH-0 Reach foundation, Claude Code)

Reach milestone plan (`RARE_OS_Reach_Milestone_Plan.pdf`, 9 milestones RCH-0..RCH-8) was produced
from the client's 27-Oct-2026 developer handover; the client message asking for approval was
drafted. On the user's instruction, RCH-0 was then built **locally only**. Nothing committed,
pushed or deployed. Live stays at `542760e` with 28 migrations.

## What RCH-0 added

- **Migration `029_reach_foundation.sql`** (applied to the local stack; live still has 28):
  `territories`, `rep_grades`, `leave_types`, `field_reps`, `holidays`, `stored_files`. All
  row-level scoped per company. Soft delete via `deleted_at`/`deleted_by`/`delete_reason`; every
  uniqueness rule is a partial index over live rows, so a removed code is free again. The runtime
  role is granted SELECT/INSERT/UPDATE only — **never DELETE** on field data.
- **Five field masters registered in `MASTER_KINDS`**, so forms, validation, paging, CSV template,
  import and audit come from the machinery Availability already uses. Each kind now carries
  `module`, `readPermission`, `deletePermission` and `softDelete`; `masters.controller` gained a
  `DELETE` route, per-kind read permission and a catalogue filtered to what the caller may read.
  Territories are two levels at most (no self parent, no parent that has a parent, no new level
  under a territory that already has children); a field rep is a master first and a login second,
  linked by the login's email and allowed to stay blank.
- **Photo and document storage on a disk volume**, not in the database: `packages/engines/file-bytes.mjs`
  decides what may be stored from the bytes themselves (type allowlist, declared-type match, 8 MB
  cap, 10,000-pixel cap), `apps/api/src/file-store.ts` does the disk side with a path derived from
  the file's own sha256. New permissions `reach.read`, `reach.manage`, `reach.delete`, `files.read`,
  `files.upload`. `apps/api/src/reach.controller.ts` has the readiness checklist, upload, serve
  (stored type, `nosniff`, PDF as attachment), removal and a rep's photo.
- **Web**: `Reach` in the sidebar with its own screen tree, mirroring Availability. `MasterTable`,
  `Modal` and the import screens were extracted into `master-table.tsx`, `modal.tsx` and
  `imports.tsx` so both modules draw the same screens; the import screens take a `module` and show
  only their own kinds. The browser scales a photo to 1600 px before upload.
- **Backup**: the photo volume gets its own restic snapshot, tag `rare-os-files`. The ops image
  joins group 1000 (`appdata`) to read the volume as a non-root user; the mount is read-only. The
  files directory is `2750` and setgid so every photo directory inherits the group.

## Defects found and fixed while building

1. The upload wrote bytes to disk **before** the permission check, so any signed-in person could
   fill the volume with refused requests. Moved inside `mutate`. Regression now asserts a refused
   upload leaves the disk unchanged.
2. The staging filename was built from the storage key, which carries directory separators, so
   every real upload failed with a 503. Now built from the file's basename. Found only by the
   browser regression — the local checks had never performed an actual upload.
3. The ops container (uid 10001) could not read the volume, so **photos were silently not being
   backed up**. Fixed with the shared group above and locked down in `security-baseline.test.mjs`.
4. Two holidays on one date produced identical `Remove holiday <date>` labels. Row labels now
   carry the date and the name.
5. `npm audit` reported 6 new upstream advisories that blocked `verify:quick` (multer, vite,
   `@nestjs/*`, express, plus transitive qs/body-parser/ip-address). Bumped to multer 2.5.0,
   vite 8.3.5, NestJS 12.3.2, express 5.3.0 — **0 vulnerabilities**.

## Tests

- Unit: `tests/reach-masters.test.mjs`, `tests/file-bytes.test.mjs`, plus new RCH-0 assertions in
  `tests/security-baseline.test.mjs` and the master-kind invariants in `tests/masters.test.mjs`.
- Browser/API + VAPT: `tests/reach-foundation.spec.ts` — the milestone's own acceptance (rep master
  from a file, selfie uploaded and served back, a removed record off the list but in the database)
  plus permission denial per permission, cross-company invisibility of field records and files,
  upload refusals, and the CSRF rejection.
- Coverage guide rows added to `docs/REGRESSION_TESTING_HINGLISH.md`; manual steps in
  `docs/REACH_TEST_GUIDE_HINGLISH.md`; photo restore in `docs/OPERATIONS_HINGLISH.md`.

## Before any push

Nothing to change in `.env`: `FILE_STORE_DIR` has a default and the `filedata` volume is created by
compose. After deploying, `Reach > Readiness` should show "Photo and document storage" ready. The
offsite backup will start taking a second snapshot tagged `rare-os-files` once the volume exists.
MFA exemption for `admin@rareos.local` runs to **25 Dec 2026** on local and live.

---

# Current handoff — 16 September 2026 (evening, Claude Code)

Point 5 operations (ops image, offsite restic backups, restore drill, monitor, alerts, systemd timers) and Point 4 rollback (`scripts/deploy/rollback.sh` + full local rehearsal) are implemented and verified locally; worker healthcheck defect fixed. Final regression `mu45c9k8-c28461ab` PASSED. Details: docs/VALIDATION.md (last section), runbook docs/OPERATIONS_HINGLISH.md. Still no commit/push/live deployment.

Before push: reinstall `/usr/local/sbin/rare-os-deploy` on the VPS (script changed). No mandatory .env change for deploy (new variables have defaults). After deploy: admins must enroll MFA; this release's rollback must use backup restore. Then VPS Point 5 setup: R2 bucket/keys + BACKUP*\*/ALERT_EMAIL_TO/MONITOR*\* in .env, install rare-os-ops/rare-os-rollback/timers, run init/test-alert/backup/restore-drill/monitor. Availability only after live acceptance and the user's instruction.

---

# Current handoff — 16 September 2026

## VAPT update — 16 September 2026

User requested permanent vulnerability checks plus a VAPT-oriented review of current code. Local work only; nothing committed, pushed or deployed. Added npm advisory gate, source/secret/IaC tests, pinned Trivy source and built-image CI gates, an optional full platform image scan, HTTP attack-surface regression and dated review in `docs/VAPT_REVIEW_2026-09-16.md`.

Fresh results: npm 0 advisories; Trivy source/lockfiles/secrets/IaC 0 HIGH/CRITICAL; rebuilt API, web, Postgres, Mailpit and Redis images 0 HIGH/CRITICAL. API is patched Alpine without npm; web is patched Alpine Nginx/non-root; Postgres is non-root with vulnerable unused gosu removed; Caddy 2.11.4 is pinned/non-root/internal 8080/8443; Keycloak Netty CRITICAL patched to checksum-verified 4.1.137 while preserving indexed filename. Body parsers limit JSON/forms to 64 KiB and safely retain malformed 400 / oversized 413 status.

Full final isolated regression `mu437uf9-f4ec2f5f` PASSED: 23 unit/security, 14/14 browser/API (9.6m), DB tenant isolation/runtime grants/indexed 100k audit, application+identity restore/RLS and scoped cleanup. First run exposed that parser 413 was converted to 503; implementation fixed and full rerun passed. Normal local stack was not restarted or mutated.

Remaining visible upstream scan findings: official latest Caddy 2.11.4 binary has 17 HIGH Go dependency findings; Keycloak image has 2 HIGH (UBI JDK no vendor fix, plus Trivy flags bundled MSSQL artifact even though filename is the fixed `13.2.1.jre11` line and RARE OS uses PostgreSQL). CRITICAL count is now zero. `npm run security:platform` intentionally returns non-zero until upstream releases resolve/review these; no ignore/suppression was added. External live DAST/TLS/network/manual business-logic VAPT remains release acceptance work.

## Current task

Latest request: while user manually tests Point2, add proper automated regression coverage for implemented features and a repeatable workflow for future changes. Implementation is local only; no commit/push/live deployment. Do not proceed to another foundation point or Availability. Do not interrupt/recreate the normal `rare-os` stack or modify real accounts.

Regression implementation: `npm run test:regression` (also `test:e2e`) runs format/types/unit/build, snapshots current source without real .env/overrides, creates a fresh unique Docker project with random ports/generated credentials/private volumes/Mailpit, repeats seed, runs browser/API suites, DB privilege/RLS/index checks and app+identity restore verification, exports reports, then cleans only its own project and exact image tags. Direct Playwright on the real workspace is blocked by config-level marker/context/URL validation. Shared test environment removes hardcoded ports. Former retained-review plant test is now always-run `tests/plants.spec.ts` with fresh fixtures, expanded UI edit/search/pagination checks. Added sticky-header real-page-scroll regression. CI verify uses same runner and uploads explicit report allowlist (including hidden .local parent). Deployment job unchanged. Future-testing policy saved in AGENTS.md and coverage/commands in docs/REGRESSION_TESTING_HINGLISH.md.

Verification COMPLETE: final run `mu403rii-0a014c3b` passed end-to-end: 19 unit/safety tests, 14 browser scenarios (zero skipped, 9.3min), application types/build/format, repeat seed, DB privileges/RLS/indexed100k audit, app+identity restore with matching counts and RLS, and scoped cleanup. HTML/JUnit/JSON/screenshot/restore receipts retained under `.local/regression/mu403rii-0a014c3b/`; workspace, test credentials/dumps, containers/volumes/image tags removed. Prior full run exposed a readiness race in the new header test; fixed by waiting for the actual catalog before scrolling, then desktop/mobile scroll checks passed. Earlier disposable services stopped mid-run; failure reporting/cleanup worked. Cleanup helper also passed an actual stopped-container/volume/image-tag exercise with normal API image preserved. No normal-stack recreation or real-account mutation was performed. Future functional work must add/update relevant tests and use the safe regression command, per AGENTS.md. No push/live rollout.

Point2 mandatory administrator MFA and recovery login was already implemented, verified and deployed to LOCAL Docker in the previous turn. User monitors GitHub Actions themselves.

Actual repo `/Users/apple/Developer/rare-os/RARE_OS_Handover_03Sep2026/rare-os`; Downloads cwd is stale/nonexistent. Use explicit workdir and shell `/bin/bash`, login:false for tools. Repo outside writable roots requires escalated writes. Never print .env, authentication tokens, OTP secrets or recovery codes.

## Delivered

- Earlier MFA work: verified reset email offers Keep (existing OTP required) or Replace (explicit warning + verified new device before deleting selected old entry). Others remain. New admin reset emails use same choice. Native password/OTP processing remains in Keycloak.
- Security lists own authenticators; add multiple/remove one. Off removes OTP/recovery credentials and revokes other sessions; now allowed only for non-admins. Management requires fresh authentication.
- Point2: platform admins, active company system/Main Admin roles and delegated users/roles administrative permission holders require MFA. Any active company grant applies to entire login.
- Migration010 `identity_requires_mfa(subject)` is SECURITY DEFINER with fixed search path and EXECUTE grants only to rare_app/rare_keycloak. Identity DB role has no SELECT access to application business tables. Keycloak uses existing credentials and explicit RARE_POLICY_DB_URL; unavailable policy fails closed.
- RARE_ADMIN_MFA required action forces native OTP enrollment before workspace entry if missing. Custom native OTP/recovery wrappers mark successful verification; signed ID-token session-note mapper carries boolean rare_mfa_verified. API callback and protected API requests enforce proof; API also checks OTP still exists. Old password-only sessions are denied immediately upon admin promotion, including another company.
- Admin off hidden in Security and disabled in identity form; forged POST still denied. Last admin device cannot be removed. Normal users retain optional off flow.
- Recovery login succeeds once; same consumed code rejected. User chooses Try another way → Recovery Authentication Code and enters requested numbered code.

## Verified

Fresh isolated stack: 13 browser tests PASS, 1 optional retained-demo skipped, 9.1min. Final targeted admin test after UX/forged-form assertions PASS (2min). Covers enrollment/invalid OTP/pre-enrollment API denial, cross-company promotion, server disable/last-device denial, recovery login/reuse denial, active platform/delegated policy, normal-user off, narrow DB privileges. Existing company/role/permission/invitation/login-recovery and Keep/Replace tests pass.

15 unit/deployment tests PASS; TypeScript/build/format/diff checks PASS. DB tenant isolation/runtime privileges/indexed100k audit PASS. Application+identity isolated restore matched counts/RLS; temporary restore DBs removed. Backup `.local/backups/2026-09-16T10-16-53-637Z` (before-change backup09-51-57 too). Repeat seed fixed mapper representation ID, then two consecutive seeds PASS. Actual users' passwords/devices not auto-enrolled or changed. Local api/db/redis healthy and services running.

UI reviewed `.local/admin-mfa-security.png`; mandatory message and off-link absence verified even while selected company role is Reader and another company grants admin. Temporary `rare-point2-qa` Docker containers and volumes removed. Full suite used ports4410/11/12 and fresh generated credentials in `/tmp/rare-point2-qa`, preserving normal localhost4310 accounts. Test helper `tests/helpers/mfa.ts` requires RARE_E2E_DISPOSABLE_STACK=true before enrolling test accounts, keeps private fixtures under ignored .local. CI sets flag and repeats seed. Never run full enrollment suite on real local accounts; targeted admin-mfa test creates/cleans its own disposable identities.

## Implementation notes

Provider jar builds against pinned Keycloak26.7.3 with Java21 in infra/keycloak/Dockerfile. Native UpdatePassword.create() returns a BASE instance; custom ResetPassword overrides create() to retain implementation. Manage/Disable enforce getMaxAuthAge=0. Adapted login-config-totp.ftl preserves RARE_REPLACE_OTP and RARE_ADMIN_MFA on QR/manual links (native URL hardcodes CONFIGURE_TOTP). Browser copy rare-browser-mfa-v1 retains native conditional second-factor execution; thin wrappers preserve native brute-force/recovery consumption. Reset copy rare-reset-credentials-v1 requires email before MFA choice and omits native reset-otp automatic duplicate enrollment.

Seeder mapper UPDATE must include the existing ID in both URL and JSON. This was found by repeat-seed verification and fixed. Auth browser tests wait for UI navigation completion before API probes to avoid cookie races. Recovery input name is recoveryCodeInput, displayed list includes a numbered prefix that tests strip.

## Next scope (only on user instruction)

Original five points: Point1 local invitation/contact-vs-login/reset flow done; live SMTP reset receipt/login confirmed, corrected-recipient invitation acceptance still needs live confirmation. Point2 now local complete. Point3 action permission matrix delivered/tested. Point4 earlier automatic deployment succeeded; NEW custom identity image/config-compatible rollback and deployment rehearsal remains. Point5 automated encrypted offsite backup/retention/monitoring/alerts and production restore remains. User wants remaining local work before combined server deployment.

Last pushed revision remains ddc668ad2c7a6e53c489a1429adc10b4e58e405f. VPS187.127.186.131 /var/www/rare-os, rare.greymetre.io and auth.rare.greymetre.io. Preserve .env/compose.override.yaml. Migration before custom Keycloak startup; seed after provider loaded. Check production override does not pin stock identity image and includes policy DB URL. Realm references custom providers: rollback needs matching provider image/config or reviewed identity DB restore, never blind DB downgrade. Root-owned deploy script `/usr/local/sbin/rare-os-deploy` is installed snapshot, not replaced by git pull. No Point4 deploy-script changes were made in this task.

Manual guide: docs/MFA_RESET_HINGLISH.md; architecture: infra/keycloak/README.md; evidence: docs/VALIDATION.md.
