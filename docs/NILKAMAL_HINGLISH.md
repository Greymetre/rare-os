# Nilkamal (Barjora) — local data aur calculation guide

Reference: `Nilkamal_Simulation_Demo_Developer_Handover_21Sep2026` (final v13 demo). Neev (login, roles,
masters, stock, orders, buffers, kharidari) waisa hi hai; buffer ka hisaab aur flow ab Nilkamal demo
jaisa hai. **Yeh client data hai: sirf local par, kabhi commit ya share mat karna.**

## Load kaise karein (sirf local)

```sh
# 1. Handover se bundle banao (Python 3 + openpyxl). Output .local/ mein jata hai (git/docker ignore).
python3 scripts/nilkamal-convert.py ../../Nilkamal_Simulation_Demo_Developer_Handover_21Sep2026 .local/nilkamal/bundle.json

# 2. Backup, phir load. Yeh BAAKI SAARI COMPANIES DELETE karta hai; sirf APP_URL localhost par chalta hai.
npm run backup:local
docker compose run --rm --no-deps -v "$PWD/.local/nilkamal:/data:ro" \
  -v "$PWD/scripts/load-nilkamal.mjs:/app/scripts/load-nilkamal.mjs:ro" seed \
  node scripts/load-nilkamal.mjs /data/bundle.json --replace-all-companies

# 3. Demo se har buffer match karo (Chrome chahiye).
node scripts/nilkamal-parity.mjs ../../Nilkamal_Simulation_Demo_Developer_Handover_21Sep2026
```

Workspace company (admin + uske users) rename hokar **"Nilkamal"** banti hai, plant **1116 Barjora**.
Saari dates poore hafton mein aage khiskti hain, taaki demo ka model day 27-Jul-2026 is hafte mein aaye
(21-Sep-2026 ko shift 56 din tha). Dobara chalao to data fir se fresh ho jata hai ("Reset to seed" jaisa).

## Kya load hota hai

| Data                                               | Source                                  | Hamare system mein             |
| -------------------------------------------------- | --------------------------------------- | ------------------------------ |
| 57 FG + 217 components                             | demo seed (A2/BOM se)                   | Items                          |
| 57 BOM, 1,094 lines (repeat components alag lines) | 1116-Barjora BOM                        | BOMs                           |
| 16 work centres, 57 routings                       | seed (CT sheet)                         | Resources, Routings            |
| Component stock, 6 storage locations               | MB52 unrestricted                       | Stock (opening)                |
| FG stock                                           | demo ke FG buffer positions (MB52 nahi) | Stock, location FG01           |
| 35 open POs, 69 lines                              | A5 open PO, sheet 1116, balance qty     | Purchase orders                |
| 76 open production orders                          | A5 open production orders               | **Production orders (naya)**   |
| 20,392 din ki bikri (Apr-24..Jun-26, returns net)  | Sleep Sale file                         | Demand history                 |
| 56 FG + 30 component buffers, 1 MTO                | demo                                    | Buffer settings (NK-FG, NK-RM) |

Supplier lead time 10 din (demo assumption, A1 file nahi mili). MOQ = max(10, ADU×1.5 ko 10 mein round),
multiple 50 (bought) / 10 (made) — demo ke planning parameters, master data nahi.

## Hisaab (WEEKLY method = Nilkamal)

- Demand **history ki aakhri date** tak padhi jaati hai (aaj tak nahi).
- Weekly mean = aakhri 13 Monday-hafton ka average. CV = aakhri 52 saat-din blocks (std/mean).
- Safety: CV < 0.5 → 30%, < 1.0 → 50%, warna 70%. DLT = lead time ÷ 7, round, kam se kam 1 hafta.
- Yellow = mean × DLT hafte; red = yellow × 50% × (1 + safety); green = ek hafte ka mean.
  Zones 0.1 tak, phir poore units mein.
- FG (made): ADU = mean/7; qualified demand mein ADU × lead time. Production orders FG supply nahi.
- Component: qualified demand = open production orders + FG ki make recommendation (scheduled se
  zyada wala hissa) × BOM, sirf jo lead time ke andar hai. "Needed by" = parent date − lead time.
- Stock record hi nahi to "No stock position" (missing), zero nahi. TOG se upar bhi green (excess nahi).
- Order: TOG tak; bought = MOQ + multiple; made red/breach = 10 ka multiple, yellow = poore units.

## Scheduler (AV-6)

- Loader plant policy set karta hai: grouping window 1 din, lead time **planned loading**, despatch profile
  (31 din) aur profile day 7; har machine ka planned utilisation aur har FG ka reference lot (average order qty).
- Planning **fixed date** par chalti hai (demo ka model day, shifted), chahe aaj kuch bhi ho. UI mein
  "Simulation: planning date fixed at …" dikhta hai. Dobara load karne par date phir is hafte mein aati hai.

Parity (22-Sep-2026, demo ke default mode, lead time at loading): **86/86 buffers, 13/13 recommendations,
76 orders ka sequence, 566 operations (machine, start, finish), drum, finish day/slack aur har resource/machine
ka run + changeover** exact.

## Order decisions (AV-7)

- Loader odd-size families (24, demo ka `mto_family_index`) aur area operations (QU02, CU02, TE02, QP02, PP02)
  bhi load karta hai. Decision aur INS numbering har load par #1 se.
- Insert kiya order production-order **lots** banta hai (same order_ref, due = need-by, lot date = drum slot).
  Naye (inserted/rush) orders naye club nahi banate: book wahi clubs rakhta hai jo unke bina banta (demo ke
  landed cohorts), promise check ke saath.
- Parity (22-Sep-2026, demo v13): club (MFRCFSSFBND78605, 4 orders, 225 min) aur move after apply ka poora
  schedule; readiness 76 orders har line; insert catalogue / odd size / rush ke saare scenarios (lots, finish,
  materials, broken promises, measured changeover); split commit ke baad sequence, readiness aur **86/86
  buffers** exact. Rush mein demo "kal" ki date do baar ginta hai (539 vs hamare 462 candidates) — result same.

## Materials decisions (AV-8)

- Walkthrough §4 ki parity (22-Sep-2026, demo v13):
  - **Expedite:** row (PO 4502939453/60, 10 NOS), approve, late (03-Aug) aur timely (28-Jul) confirmation ke baad status aur order state.
  - **Quote later:** auto, 12-Aug candidate aur pending review ke scenarios.
  - **Propose ke baad aur confirm ke baad:** dono par **86/86 buffers** exact.
  - **Seed order pending:** 15625229 ke scenarios aur 86/86 buffers exact. Pending imported order apne FG ki demand se ghat jaata hai, demo jaisa.
- Hamara farq: expedite approval **maker-checker** hai (demo me requester khud approve kar sakta hai).

## Execution (AV-9)

- Loader execution ke naye tables saaf karta hai aur MO / release / downtime numbering #1 se shuru karta hai.
- Demo ka execution loop wahi do event hai (release + completion). Demo me ye log seed data tha; hamare yahan
  planner khud release aur complete karta hai, aur audit **apne** completions par banta hai.
- Demo ka master-data audit apne prepared series par tha (uska "standard" CT sheet se alag hai), isliye hum
  sirf **rule** ki parity rakhte hain: unit test demo ke 12 series par avg, drift aur wahi 3 flagged items deta hai.
- Downtime: demo me at-risk orders scripted the; hamare yahan downtime ke baad schedule dobara chalta hai aur
  at-risk list do runs ki tulna se nikalti hai.

## Delivery (AV-10)

- **Today** aur **Delivery** screens current run se bante hain: OTIF (76/76 on time), time buffer, alerts,
  aur "aaj kya order / release karna hai" ki list. Har list CSV me milti hai.
- Demo ka time-buffer bar aur at-risk list prepared numbers par thi; hamare yahan dono schedule se nikalte
  hain: promise tak ka runway aur uska bacha hua slack.

## Planning tools (AV-11)

Nilkamal data par aaj ke numbers (planning date 21-Sep-2026):

- **Month shape:** drum **QU02**, 2,448 min/din, 31 working days. Shape 15,763 minutes capacity se
  zyada maangti hai, jisme 15,269 shuru ke shaant dino me pehle banaya ja sakta hai; mahine ka
  **52.5%** aakhri ek-tihai dino me girta hai. Level load par peak stock **2,060 units (din 22)**,
  mahine ka volume 10,005 units (sirf FG, components dobara nahi gine).
- **Recommended buffers:** 258 items par service curve (85/90/95%). Fill normal loss function se
  nikalta hai — demo me ye prepared number tha, yahan har item ke apne variability se banta hai.
- **Buffer vs MTO:** 274 items — 185 BUFFER, 89 MTO, aur **14** jagah aaj ki policy sifarish se alag hai.
- **Network:** plant 1116, drum QU02 **25%** par, agle resource se **15.8 pp** ka gap — stable.
  What-if: QU02 ko 2 se 3 ya 4 machine karne par bhi constraint wahi (QU02, 17% aur 13%) —
  **6** machine par hi constraint CU02 par jaata hai.
- **Target mode:** 30 din ki history 11,617 units; agar target usse kam ho (ratio 0.4) to stock
  1,088 units kam chahiye aur constraint 71% par aa jaata hai.
- **Assumptions:** 7 rows (plant planning, calendar, lead time basis, profiles) — sab ek jagah.

Events aur schemes Nilkamal data me abhi koi nahi hai; dono khud dalne par hi plan badalte hain
(scheme sirf accept karne par).

## Screens

- **Stock and demand → Production orders**: order par click → poora BOM: per unit, zaroorat, buffer zone,
  on hand ("not available" agar stock record nahi), on order, net flow, needed by, verdict.
- **Planning → Buffer board**: detail mein weekly usage, CV, safety, demand ka breakdown, driving orders aur lead time at loading.
- **Planning → Today / Delivery / Buffer board / Scheduler / Insert order / Pending orders / Expedites / Execution / Downtime / Cycle time audit / Planning tools / Network / Gantt / Resource load**, **Setup → Plant planning**.
- **Buffer profiles**: "Zone method" = Weekly (Nilkamal).

## File import aur cutover (AV-12)

Ab Nilkamal ki apni SAP files app ke andar se padhi ja sakti hain — script ke bina. Barjora par
poora chain chala kar dekha gaya hai (**Availability → Masters & setup → File import**):

1. **Units** — `A2.xlsx`, sheet `1116`, Base Unit column (rows combine karke): 15 units.
2. **Items** — wahi sheet, 29,497 rows: material type translate karke (`FERT→FG`, `HALB→SFG`,
   `ROH/HIBE/ERSA/VERP/UNBW/MOLD→RM`, aur make/buy usi column se) → **29,490 items** committed
   (29,216 naye, 274 pehle se maujood). **6 codes chhode gaye**: unme `%`, `+` ya space tha, jo
   item code me nahi chal sakta — inhe SAP me theek karna padega ya aise hi chhodna padega.
3. **Stock locations** — `1116-Barjora.xlsx` sheet `MB52` ke SLoc column se: **12 locations**.
4. **Stock** — wahi MB52: quantity = Unrestricted, 128 zero rows rule se hataye, reference
   **item+location** se banaya (MB52 me reference column hai hi nahi) → **1,075 rows** committed.

Phir file se seedha milaan (app ke bahar se), aur har unit ka total bilkul same:

| Unit |          File |        Import | Rows |
| ---- | ------------: | ------------: | ---: |
| KG   |    31,271.527 |    31,271.527 |   48 |
| L    |     3,226.878 |     3,226.878 |    9 |
| M    | 9,559,469.898 | 9,559,469.898 |  225 |
| NOS  |     551,519.4 |     551,519.4 |  793 |

Do baatein yaad rakhne ki:

- **Sales history** (`Sleep Sale…xlsx`, 287,653 rows) me ek din ki kai invoice lines hoti hain;
  demand history ek din ka ek row leta hai. Mapping me `plant + item + date` par rows jod do,
  quantity apne aap add ho jaayegi (3,00,000 rows → 250 din, ~7.5 s).
- **Loader script (`scripts/load-nilkamal.mjs`) ab bhi wahi frozen demo parity ke liye hai.**
  File import cutover ke liye hai; dono ek doosre ki jagah nahi lete.

## Abhi baaki (demo mein hai, yahan nahi)

SAP ZMTO lines ka import (abhi odd size screen par family + size se aata hai). Demo ka resource load graph drum ke "nose to tail" model par hai; hamara graph timed schedule se
asli busy minutes dikhata hai (totals same, din-wise baant alag). Approval
hamara maker-checker hi rahega (demo ka one-click nahi).
