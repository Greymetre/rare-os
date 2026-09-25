# Availability — manual test guide

Har milestone complete hone par uska section yahan add hoga. Automated tests `npm run test:regression` mein chalte hain; ye steps aapke haath se verify karne ke liye hain.

## AV-0 — Availability foundation

**Kahan:** Login → left menu **Availability**. Menu tab dikhega jab role mein `masters.read` (Masters → View planning master data) ho.

### 1. Readiness

1. **Readiness** tab kholo.
2. Plants aur Units ka status **Ready** ya **Missing** dikhega, saath mein kya karna hai uska message.
3. Items, Resources/BOM, Orders/stock **Coming soon (AV-1/AV-2/AV-3)** dikhne chahiye.

### 2. Units (haath se)

1. **Units** tab → **Create unit** → code `NOS`, name `Numbers`, decimals `0` → **Save unit**.
2. Dobara `nos` (chhote letters) banao → message: **already exists** (duplicate nahi banega).
3. Decimals `9` daalo → error: 0 se 6 tak.
4. Edit karke name badlo → save. Do alag tabs mein ek hi unit edit karke save karo → doosre tab mein **changed elsewhere, refresh** message.

### 3. CSV import — galat file

1. **Imports** tab → **Download template**.
2. File mein ye rows daalo (header wahi rehne do):
   ```
   code,name,decimals
   KG,Kilogram,3
   BAD CODE,Broken,0
   kg,Duplicate,2
   M,Metre,9
   ```
3. **CSV file** choose karo → **Upload and validate**.
4. Status **Checking** → kuch second mein **Ready to review**.
5. **With errors = 3**, **Commit import** button nahi dikhega.
6. Rows table mein har error ka line number aur reason (jaise "Duplicate code KG; first used on line 2").
7. **Download error file** → Excel mein line, column, problem aur original values.
8. **Cancel import** → koi unit nahi bana.

### 4. CSV import — sahi file

1. Rows theek karo (`KG,Kilogram,3` aur `M,Metre,3`) → upload.
2. Preview mein **Will create / update / unchanged** counts check karo.
3. **Commit import** → status **Saving** → **Committed**, counts **Created / updated / unchanged**.
4. **Units** tab mein KG aur M dikhne chahiye. **Audit log** mein `import.committed`.

### 5. Duplicate protection

1. **Wahi file dobara** upload karo → message: **This exact file was already imported as batch #N**.
2. Same rows ek naye naam/extra khali line ke saath upload karo → preview **0 / 0 / 2 unchanged** → commit → units ki ginti nahi badhegi.

### 6. Galat upload

- Header ka order badlo (`name,code,decimals`) → message: first row exactly `code, name, decimals` honi chahiye.
- 5 MB se badi file → "larger than 5 MB".

### 7. Permissions

1. Ek role banao sirf **Dashboard** + **Masters → View planning master data**; user ko assign karke login.
2. Availability → Imports: upload card nahi dikhega; Units mein **Create unit** nahi.
3. **Masters → Validate and import files** select karte hi **Maintain planning masters** apne aap select hona chahiye (dependency).

### 8. Demo company (optional)

VPS/local terminal:

```bash
docker compose run --rm --no-deps seed node scripts/demo-abc-corp.mjs
```

Seed admin se sign out/sign in → company chooser mein **ABC Corp (Demo)** → Plant 1 aur 5 units (NOS, SET, KG, M, L). Command dobara chalane par "already present", kuch duplicate nahi.

## AV-1 — Item masters

**Kahan:** Availability → **Items, Suppliers, Item sourcing, Customers, Unit conversions** tabs. Demo data ke liye pehle `scripts/demo-abc-corp.mjs` chala kar **ABC Corp (Demo)** kholo (20 items, 4 suppliers, 7 customers).

### 1. Items

1. **Items** → **Create item**: code `RM-TEST`, type `RM`, `BUY`, base unit `XYZ` (jo exist nahi karta) → Save → field ke neeche **Unit XYZ was not found**.
2. Base unit `KG` karo → Save → item bana.
3. Same code chhote letters mein dobara → **already exists**.
4. Edit karo: code field locked rahega; naam badal kar save.
5. **Units** tab mein `KG` ko Inactive karne ki koshish → **used by N active item(s)** message.

### 2. Suppliers aur Item sourcing

1. **Suppliers** → supplier banao (lead time 0–365 din; galat email/phone par field message).
2. **Item sourcing** → FG (MAKE) item ke liye supplier jodo → **is MAKE** message.
3. Units mein `BOX` (decimals 0) banao. RM item + supplier + purchase unit `BOX` (conversion abhi nahi hai) → **No conversion between BOX and KG** message.
4. **Unit conversions** → `BOX → KG factor 25` banao. Ulta `KG → BOX` banao → **Keep one direction**.
5. Ab sourcing save hoga. MOQ `120`, order multiple `50` → **must be a multiple** message.
6. Ek item ke do suppliers ko **Preferred** mark karo → sirf aakhri wala preferred rahega.
7. **Readiness** → Suppliers and sourcing: bina supplier wale BUY items ki ginti.

### 3. Imports

1. **Imports** → Import type **Items** → template → ek row mein galat unit, ek duplicate code → upload → errors aur error file.
2. Sahi file → commit → counts.
3. **Item sourcing** import validate karo, commit se pehle us supplier ko Inactive karo, phir commit → **Data changed after validation**, kuch save nahi.
4. Import type dropdown sirf wahi types dikhata hai jinki permission aapke paas hai.

### 4. Permissions

1. Role: Dashboard + View planning master data + **Maintain suppliers and item sourcing** + Validate and import files.
2. Is user se: Suppliers/Item sourcing create ho sakta hai; Items aur Customers mein **Create** button nahi; Imports mein sirf Suppliers aur Item sourcing.

## AV-2 — Plant model

**Kahan:** Availability → **Calendars, Resources, BOMs, Routings** tabs aur **Readiness** (plant setup panel). Calendars, Resources, Routings aur plant readiness upar ke **Plant** dropdown wale plant ke liye hain; BOMs poori company ke hain. Demo data ke liye `scripts/demo-abc-corp.mjs` dobara chalao — pehle se bani ABC Corp mein Plant 1 ka 3-shift calendar, 5 resources (S1–S5), 12 BOMs aur 12 routings jud jayenge; baaki data waisa hi rahega.

Pehle apni company mein ek MAKE item (jaise `FG-TEST`, unit NOS) aur do BUY items (`RM-A` unit KG, `RM-B` unit NOS) bana lo, agar nahi hain.

### 1. Calendar

1. **Calendars** → Plant chuno → **Create calendar**: code `GEN`, Mon–Sat tick, shift General 09:00–17:30, break 30.
2. **Add shift** → 17:00–20:00 → Save → **overlaps** message. Us shift ko **Remove** karke Save → "created as the plant default" (plant ka pehla calendar apne aap default banta hai).
3. List mein **Minutes/day = 480**.
4. Doosra calendar `NIGHT` 22:00–06:00 (raat bhar), break 30 → Minutes/day **450**; default nahi banega.
5. `GEN` ko Edit → **Default** untick → Save → **A plant needs a default calendar** message. `NIGHT` ko default mark karo → ab `GEN` default nahi rahega.

### 2. Resources

1. **Resources** → **Create resource**: code `CNC`, Machines 2, Efficiency 90, Calendar = Plant default → Save.
2. **Capacity min/day** = default calendar minutes × 2 × 0.9 (jaise 480 → **864**).
3. Machines `0` ya Efficiency `120` → field message. Same code chhote letters mein → **already exists**.
4. Doosre plant mein resource sirf wahi plant chun kar dikhega.

### 3. BOMs

1. **BOMs** → **Create BOM**: parent `FG-TEST`, revision V1, line 1 `RM-A` qty 2.5, line 2 `RM-B` qty 1.5 → Save → **quantity** message (NOS mein decimals nahi). Qty 2 karke Save.
2. Parent ek BUY item rakho → **is BUY. Only MAKE items have a BOM**.
3. Line mein unit `BOX` (jiska KG se conversion nahi) → **no conversion between** message.
4. Same parent ka V2 same date range mein → **Effective dates overlap**. V1 ko Edit karke "Effective to" daalo, phir V2 us date ke baad se → ban jayega.
5. Loop: agar `FG-TEST` mein `SFG-X` hai, to `SFG-X` ke BOM mein `FG-TEST` daalo → **This creates a BOM loop: … → …**.
6. Search box mein item code ka shuru likh kar search; Next page kaam kare.

### 4. Routings

1. **Routings** → Plant chuno → **Create routing**: item `FG-TEST`, operations: 20 PACK `CNC` run 0.5; 10 CUT `CNC` run 2.25 → Save.
2. Dobara kholo → operations sequence order mein (10 CUT, 20 PACK); list mein **Run min/unit 2.75**.
3. Kisi doosre plant ka resource code daalo → **was not found in plant** message.
4. **Resources** → `CNC` Edit → Inactive → Save → **used by N operation(s) in active routings**.

### 5. Readiness

**Readiness** tab → Plant chuno → "Plant setup" panel: Plant calendar, Resources, BOMs, Routings. Calendar/resource bante hi Ready; jin MAKE items ka aaj effective BOM ya is plant mein routing nahi, unke codes dikhenge. Sab bana do → calendar, resources, BOMs aur routings Ready (AV-3 ke baad is panel mein stock aur demand bhi dikhte hain).

### 6. Imports

1. **Imports** → type **Resources** → template → ek row plant code galat → errors.
2. Type **BOM lines** (ek row = ek component; same parent + revision ki rows ek BOM). Ek BOM mein ek row ka component galat → us BOM ki **saari rows** error mein ("Nothing from it will be saved"), doosra BOM sahi dikhega; preview counts BOMs ke hisaab se.
3. Sahi file commit → BOMs tab mein dikhega.
4. Type **Routing operations** validate karo, commit se pehle us resource ko Inactive karo, phir commit → **Data changed after validation**, kuch save nahi.

### 7. Plant access

1. Role: Dashboard + View assigned plants + View planning master data + Maintain planning masters + Validate and import files. User ko **sirf Plant A** ka access do.
2. Is user se: Plant dropdown mein sirf Plant A. Resources import file mein Plant B ki row → **plants you cannot access: …**.

## AV-3 — Demand aur stock

**Kahan:** Availability mein ab tabs do rows mein hain. **Setup** row mein naya tab **Stock locations** hai. **Stock and demand** row mein **Stock, Customer orders, Purchase orders, Demand history** aur **Imports** hain. Har tab upar ke **Plant** dropdown wale plant ke liye kaam karta hai.

Demo data ke liye `scripts/demo-abc-corp.mjs` dobara chalao. ABC Corp ke Plant 1 mein ye jud jayega:

- 4 locations (RM-STORE, FG-STORE, WIP, QC-HOLD)
- 13 items ka opening stock
- 4 open POs
- 14 customer orders
- 12 FG items ki 90 din ki demand history

Pehle se bana data waisa hi rahega.

Apni test company mein pehle yeh bana lo:

- Items: `RM-A` (unit KG, 3 decimals), `RM-B` (unit NOS) aur ek MAKE item `FG-A` (NOS)
- Unit conversion `BOX → KG = 25`
- Ek customer aur ek supplier

### 1. Stock locations

1. **Stock locations** → **Create location**: code `STORE`, type STORES → Save.
2. Doosri location `QC`, type QUARANTINE, aur "Counts as available stock" untick karo.
3. Same code chhote letters mein dobara banao → **already exists** aana chahiye.

### 2. Stock movement aur ledger

1. **Stock** → **Post movement** → type **Opening stock**, location STORE, item `RM-A`, quantity 100 → Post. **Current stock** mein 100 KG dikhega.
2. `RM-A` ka opening dobara post karo → **already posted … Use an adjustment** aana chahiye.
3. **Receipt**: quantity 2, unit `BOX` → 50 KG judega aur stock 150 ho jayega.
4. **Issue** 200 → **Not enough stock: … has 150 KG available** aana chahiye, aur kuch save nahi hoga.
5. **Issue** 1.2345 → decimals wala error aana chahiye (KG mein 3 decimals tak hi chalte hain).
6. **Adjustment** → Direction Decrease, 0.5, reason khaali → **Reason is required**. Reason daalo → post ho jayega.
7. Movement date kal ki daalo → **cannot be in the future**.
8. **Stock ledger** mein receipt ke saamne **Reverse** → reason daalo → Post reversal. Stock 50 kam ho jayega. Ledger mein dono entries rahengi ("Reversal of #…" aur "(reversed by #…)").
9. Usi movement ko dobara reverse → **already reversed**. Reversal ko reverse karne par button hi nahi dikhega.
10. Opening ko reverse karo jab uska kuch stock pehle hi issue ho chuka ho → **Some of it was already used**.
11. **Stock locations** mein STORE ko Inactive karo jab usme stock ho → **still holds stock** aana chahiye.

### 3. Customer orders

1. **Customer orders** → **Create order**: order number khaali chhodo, customer, promise date, line 10 `FG-A` qty 1.5 → Save → **whole number** error aana chahiye. Qty 12 karke Save → **Order SO-000001 created**.
2. Promise date order date se pehle rakho → error aana chahiye.
3. Order kholo, ek line **Remove** karke Save karo → woh line cancel ho jayegi. Status filter **All** karke order dobara kholo, line ka record dikhega.
4. **Cancel order** → reason → Confirm. Order **Cancelled** filter mein dikhega aur edit nahi hoga.

### 4. Purchase orders

1. **Create purchase order**: item MAKE wala (`FG-A`) → **is MAKE** error aana chahiye.
2. `RM-A`, quantity 8, unit BOX, received 10 → **cannot be more than the ordered** error aana chahiye. Received 3 karke Save → **PO-000001** banega.

### 5. Imports

1. **Customer order lines**: ek row = ek order line. Same `order_no` wali rows milkar ek order banti hain.
   - Ek order mein customer galat rakho → us order ki saari rows error mein, doosra order sahi.
   - Sahi file commit karo. Phir ek quantity badal kar nayi file import karo → preview mein **update 1, unchanged 1**.
   - File mein kisi existing order ki koi line na ho → woh line cancel ho jayegi. Isliye poora order bhejo.
2. **Purchase order lines**: same tareeka; `received_quantity` optional hai.
3. **Stock movements**: har row mein `external_ref` zaroori hai.
   - Same file dobara import (ya same refs) → **unchanged**. Stock double nahi hota.
   - Same ref par quantity badli → **Posted movements cannot be changed**.
   - File ke andar ISSUE se stock minus mein jaaye → us row par **Not enough stock**.
   - File validate karo, commit se pehle Stock tab se issue karke stock khatam karo, phir commit → **Data changed after validation**, kuch post nahi hoga.
4. **Demand history**: ek row = plant + item + date. Future date → error. Wahi din dobara alag quantity ke saath → update.

### 6. Readiness

**Readiness** tab → plant chuno. Plant setup panel mein naye items dikhenge:

- **Stock locations**, **Opening stock** aur **Demand** — Ready ya Missing.
- **Open purchase orders** — Info (sirf jaankari).

### 7. Permissions

1. Role banao: Dashboard + View assigned plants + View planning master data + **View stock and movements** + **Post stock receipts and issues** + Validate and import files. Sirf Plant A ka access do.
2. Is user se:
   - **Post movement** mein sirf Receipt/Issue types dikhenge.
   - **Reverse** button nahi dikhega.
   - **Customer orders** tab nahi dikhega.
3. Stock movements file mein ADJUSTMENT row → **ADJUSTMENT rows need the "Post opening stock, adjustments and reversals" permission**.
4. Naye permissions Roles screen mein: Demand group (View/Create/Edit customer orders, Import demand history), Materials group (View stock, receipts/issues, opening/adjustments/reversals, View/Create purchase orders).

## AV-4 — Material buffers (kami pakadna)

**Yeh kya karta hai:** har buffered item ke liye system red/yellow/green zones banata hai. Phir **net flow** nikalta hai: store ka stock + aane wala maal (open POs) − abhi ki pakki demand. Net flow jitna neeche, item utna urgent. Yellow ya usse neeche aane par system bata deta hai kitna kharidna ya banana hai.

**Kahan:** Availability mein:

- **Setup** row: **Buffer profiles** (zone ke size ke rules) aur **Buffer settings** (plant mein kaunsa item stock mein rakhna hai).
- Nayi **Planning** row: **Buffer board**.

Koi bhi data badlo (order, stock, PO, BOM, settings), to buffers 3–5 second mein apne aap dobara calculate ho jaate hain. Board par "Up to date" ya "Recalculating…" dikhta hai.

Demo: `scripts/demo-abc-corp.mjs` dobara chalao. ABC Corp mein ye jud jayega:

- 3 profiles (prototype wale)
- FGa–FGe aur saare RM buffered, FGf–FGl made to order

Kuch seconds mein board bhar jayega: 2 Red, 5 Yellow, 6 Above top of green, 7 Made to order.

### Formula (seedha)

- **ADU** (average daily usage) = pichhle N din ki demand history / N. Components ka ADU BOM se apne aap judta hai (FG × qty per).
- **Yellow** = ADU × lead time. **Red** = yellow × red %. **Green** = yellow × green % (ya MOQ, jo bada ho). **Top of green** = red + yellow + green.
- **Net flow** = on hand + open supply − qualified demand.
- **Qualified demand** mein ye ginta hai:
  - Aaj tak due orders.
  - Lead time ke andar ke bade orders (spike).
  - Made-to-order products ke orders ka BOM se component ka hissa.

### 1. Profile aur settings

1. **Buffer profiles** → **Create profile**:
   - code `TEST`, red 50, green 50, usage window 30 → Save.
   - Green 0 daalo → error aana chahiye.
2. **Buffer settings** → plant chuno → **Add item**:
   - Ek BUY raw material, profile TEST, lead time khaali (supplier ka lead time lagega).
   - Ek MAKE product, lead time 5.
   - MAKE product ka lead time khaali chhodo → **set its manufacturing lead time** aana chahiye.
3. Ek product ko policy **Made or bought to order** ke saath jodo.

### 2. Buffer board

1. **Buffer board** → plant chuno. Upar ye dikhega:
   - "Run #N … Up to date"
   - Tiles: Stock-out risk, Red, Yellow, Green, Above top of green, Needs data
2. Kisi tile par click karo → sirf us zone ke items dikhenge. Dobara click karo → sab items.
3. Row par click karo → details khulengi: ADU, lead time, zones, aur "on hand + open supply − demand = net flow".
4. Yellow/Red item par **Suggested order** dikhega:
   - BUY: supplier ki MOQ aur multiple ke hisaab se (jaise "Buy 300 KG · SUP-1 · by date").
   - MAKE: "Make 50 NOS".
5. Jis BUY item ka preferred supplier nahi hai, woh **Needs data** mein aayega ("No lead time…"). Kabhi zero buffer nahi dikhega.

### 3. Order badlo → zone badle (milestone ki shart)

1. Kisi raw material ka zone note karo.
2. Uske made-to-order product ka ek bada customer order banao, promise date raw material ke lead time ke andar rakho.
3. 5 second ruko → board apne aap "Recalculating…" → "Up to date". Raw material ka zone neeche aa jayega (jaise Red → Stock-out risk) aur suggested order badh jayega.
4. Usi raw material ka purchase order banao → net flow badhega, zone upar jayega.
5. Customer order cancel karo → wapas pehle jaisa.

### 4. Run now aur import

1. **Run now** → "Planning run #N queued". Kuch second mein naya run number dikhega.
2. Imports → **Buffer settings** template (plant, item, policy, profile, lead_time_days, adu_override). Galat profile code → error. Sahi file commit karo → board update ho jayega.
3. Jo profile use ho raha hai use Inactive karo → **used by N buffered item(s)** aana chahiye.

### 5. Permissions

1. Role: Dashboard + View assigned plants + View planning master data + **View buffer board and planning results**. Sirf Plant A.
2. Is user se:
   - Board dikhega.
   - **Run now** button nahi dikhega.
   - Profiles mein **Create** nahi dikhega.
   - Plant B ka board nahi khulega.
3. Naye permissions: **Recalculate buffers on demand**, **Maintain buffer profiles and buffer settings**.

## AV-5 — Purchase loop (kharidari)

**Yeh kya karta hai:** jab kisi kharide jaane wale (BUY) item ka buffer yellow ya usse neeche jaata hai, system apne aap **purchase proposal** banata hai (rule AV-01). Koi dusra insaan use approve karta hai, tab **purchase order** banta hai. Maal aane par **goods receipt** hoti hai aur stock badhta hai.

```
Order → kami (buffer red/yellow) → proposal → approval → PO (aane wala maal) → receipt → stock
```

**Kahan:**

- **Planning** row → **Purchase proposals**.
- **Stock and demand** row → **Purchase orders** → PO kholo → neeche **Goods received**.
- **Buffer board** par suggested order ke neeche "Proposal #N waiting for approval" dikhta hai.

Demo: ABC Corp mein buffers calculate hote hi RMb, RMc, RMe, RMf, RMg ke proposals apne aap aa jaate hain (5 waiting).

### 1. Proposals

1. **Purchase proposals** → **Waiting for approval**. Har proposal mein item, supplier, quantity (purchase unit, MOQ aur multiple ke saath), needed-by date, aur "Why" (zone aur net flow) dikhta hai.
2. **Change**: quantity ya date badlo → save. Ab tum khud usse approve nahi kar sakte: "You created or last changed this proposal, so someone else must approve it." Dusra user approve karega.
3. **Approve** (ya kai select karke **Approve selected**) → "Purchase order PO-… created". Proposal **Approved** tab mein PO number ke saath dikhega.
4. **Reject** → reason zaroori hai. Wahi zaroorat dobara nahi aayegi, jab tak quantity badal na jaaye.
5. Order cancel karo ya stock aa jaaye, to system ka pending proposal apne aap **Withdrawn** ho jaata hai.
6. **Raise proposal**: haath se proposal (item ka preferred supplier lagta hai). Isse bhi koi dusra hi approve karega.

### 2. Approval ke rules (ye check karo)

1. Kisi proposal ko kholo. Dusri tab/user se uski quantity badlo. Pehli tab se Approve → **changed after you opened it**.
2. Stock ya order mein kuch badlo aur turant (3 second ke andar) approve karo → **Buffers are being recalculated…**. 5 second baad dobara approve → ho jayega.
3. Approve ke baad **Buffer board** par: **On hand wahi rehta hai**, sirf **Open supply** badhta hai. Approved PO stock nahi hai.

### 3. Goods receipt

1. **Purchase orders** → PO kholo → **Receive goods**.
   - Location, date aur delivery note bharo.
   - "Received now" mein bacha hua quantity pehle se bhara hota hai; partial ke liye kam karo.
   - **Post receipt**.
2. **Stock** tab: item ka stock badha. Ledger mein "Receipt against PO-…" dikhta hai.
3. Bache hue se zyada receive karo → **only N is still due** error.
4. PO ka "Received so far" form mein badla nahi ja sakta; woh sirf receipts se badhta hai.

### 4. Permissions

- **Approve or reject purchase proposals**: approver ke liye.
- **Create, edit and import purchase orders**: proposal change/raise ke liye.
- **Post stock receipts and issues**: goods receipt ke liye.
- Approver sirf apne plants ke proposals dekhta hai. Bina receipt permission ke **Receive goods** nahi dikhta.

## AV-6 — Scheduler (kaunsa order kis machine par kab)

**Yeh kya karta hai:** har recalculation mein plant ke saare **open production orders** machines par aage ki taraf (forward) schedule hote hain. Tareeka Nilkamal demo jaisa hai:

1. **Sequence:** pehle due date ke hisaab se. Agar ek hi item ke orders ki due dates mein **grouping window** (default 1 din) se kam farak ho, to woh ek ke baad ek chalte hain. Isse changeover bachta hai, par tabhi jab kisi aur order ka promise late na ho.
2. **Machine:** har resource par order us machine ko milta hai jo changeover gin kar sabse pehle free hoti hai. Ek hi item ke lagatar orders ek hi machine par rehte hain.
3. **Time:** har operation tab shuru hota hai jab pichhla operation khatam ho aur machine free ho (changeover ke baad). Efficiency 85% ho to kaam 1/0.85 guna time leta hai.
4. **Drum:** jis resource par load/capacity sabse zyada ho, woh apne aap drum banta hai (Nilkamal mein Quilting).
5. **Lead time at planned loading** (Plant planning mein chalu karo): made item ka lead time = master lead time + har machine ki queue (processing × u/(1−u), u = planned utilisation × din ka factor). FG buffers ke zones isi hisaab se bade hote hain.

**Kahan:**

- **Planning** row → **Scheduler**, **Gantt**, **Resource load**.
- **Setup** → **Plant planning** (grouping window, lead time basis, despatch profile).
- **Resources** form → **Planned utilisation %**. **Buffer settings** → **Reference lot** (made items).
- **Buffer board** → made item kholo → "Lead time down the routing at planned loading" table.

Nilkamal (Barjora) par: 76 orders, drum **QU02 Quilting**, 0 late. Header mein "Simulation: planning date fixed at …" dikhta hai, kyunki demo ek fixed din par chalta hai.

### 1. Scheduler

1. Plant chuno → **Scheduler**. Upar tiles: orders, late, drum, last finish, aur grouping se bacha changeover.
2. Table: sequence (#), order, item, quantity, **Release (start)**, **Finish**, **Promise**, **Slack (days)**, On time/Late, Materials (Clear / Gated / Cannot validate).
3. "Grouped after WO-…" = same item ko pichhle order ke saath chalaya gaya.
4. Filter: **Late**, **Material gated**, **Not schedulable** (routing nahi hai).

### 2. Gantt aur Resource load

1. **Gantt**: har machine ki lane, blocks par hover karo (order, item, qty, time). Hatched block = changeover. Resource aur din chuno, "Later →" se aage dekho.
2. **Resource load**: har resource ke run minutes, changeover minutes, changeovers ki ginti, capacity/day, utilisation, aur pehle 14 din ka roz ka busy %. Row par click karo to har machine ka hisaab dikhega. Drum par "drum" likha hota hai.

### 3. Publish (committed plan)

1. **Scheduler** → note likho → **Publish run #N**. Ab "Published plan … Matches the latest calculation" dikhega.
2. Kuch badlo (jaise **Plant planning** mein grouping window 0) → recalculation ke baad "The latest calculation differs". **Show → Published plan** mein purana sequence hi dikhega.
3. Wahi run dobara publish karo → "already the published schedule". Purana run publish karo → "no longer current".

### 4. Permissions

- **View buffers, schedules and planning results**: saari screens dekhne ke liye.
- **Publish a calculated schedule as the committed plan**: Publish button ke liye.
- **Maintain buffer profiles and buffer settings**: Plant planning badalne ke liye.

## AV-7 — Order decisions (club, move, insert order)

**Yeh kya karta hai:** planner ab schedule par khud faisle le sakta hai. Har faisla pehle **preview** hota hai
(kuch save nahi hota), phir **apply/commit** par ek numbered decision banta hai (audit mein bhi). Preview ke
baad agar calculation badal gayi ho (naya run, ya kisi aur ne faisla save kiya) to commit **409** deta hai:
"Review again".

**Material readiness (har order):** har lot apna poora BOM apne start par leta hai. Available = on hand +
release tak aane wali PO lines − pehle shuru hone wale orders ne jo liya. Status: **Expedite or quote later**
(kami) → **Cannot validate** (stock record nahi) → **Commit + replenish** (buffer green nahi) → **Clear**.

### 1. Club / declub (Scheduler)

1. **Planning → Scheduler** → kisi order ki row mein **Club** button. Cards dikhenge: Recommended club, Partial,
   Larger with expedite, Declub. Har card: bacha setup (min), carry (unit-days), members ki finish, materials.
2. **Apply club** → decision #N. Recalculation ke baad members saath chalte hain (Grouped).
3. **Declub** → orders apni promise-date jagah par wapas.

### 2. Haath se sequence (drag / ↑↓)

1. Row ko drag karo ya ↑/↓ dabao → order doosre order ke pehle/baad. Upar banner: "Manual sequence".
2. Impact report: kitne orders shift hue, kaunse promise late hue, drum changeover.
3. **Release to computed order** → wapas computed sequence (pinned clubs rehte hain).
4. Neeche **Decisions** table: har faisla, run #, kisne, kab, asar.

### 3. Insert order

**Planning → Insert order**:

1. **Catalogue item**: item code, quantity, need-by date → **Show options**.
   - Buffered item: "net flow 421 (green) falls to −579 (breach)" jaisa sentence.
   - 4 cards: **Take it whole, now** (sabse aage), **Split across available drum slots** (need-by se peeche
     chal kar drum ke khaali minutes, max 2 lots), **Whole, latest feasible slot**, **Decline, quote a later date**.
   - Har card: lots aur dates, full-route finish (saare operations), materials, measured changeover, carry,
     kitne orders shift / late. Recommended = sasta option jo capacity aur materials dono support karein;
     koi na kare to drum wala option warning ke saath.
2. **Commit** (ya "Commit with material gate" / "with capacity warning") → order **INS-n** (split ho to
   INS-n-1, INS-n-2) Production orders aur Scheduler mein. Lots apni date se pehle shuru nahi hote
   (sirf "whole, now" sabse aage). FG buffer ki qualified demand bhi order qty se badhti hai.
3. **Decline** → sirf quote decision log hota hai, schedule mein kuch nahi.
4. **Odd size, made to order**: family + L × W × H (inch). Family ka sabse paas wala standard (pehle same
   thickness, phir area) — routing ke **area operations** (Setup → Plant planning) area ratio se scale, BOM:
   metre area se, pieces same, baaki volume se. Commit par naya item (**FAMILY-75X30X4**, "estimated"), BOM
   aur routing (revision EST1) bante hain.
5. **Earliest possible (rush)**: har position × har supply date try hoti hai; "Earliest supported promise"
   aur "Earliest capacity / impact trade-off" jaise cards, quote = forward finish. Commit par rush order
   usi order ke pehle chalta hai jiske against quote hua.

Nilkamal par check (planning date 21-Sep): **MFROBNWHTGRN75606 × 1000, need-by 27-Sep** → recommended **split**
417 on 26-Sep + 583 on 27-Sep, finish 13-Oct, "Expedite or quote later". Commit ke baad **201423**: qualified
demand 2067.816, net flow 1474.835, red. **Odd size TRENDZZZ 75×30×4 × 100 by 25-Sep** → from
MFRTDZREDSSQ72304, area × 1.0417, recommended whole-late 25-Sep, "Cannot validate". **Rush
MFRCFSSFBND78725 × 160** → quote 03-Oct (before 15627039, Commit + replenish) aur 26-Sep trade-off.

### 4. Permissions

- **View buffers, schedules and planning results**: saare previews.
- **Change the schedule: move, club and declub orders**: club/declub/move/release.
- **Insert customer orders into the schedule and quote dates**: Insert order commit aur decline quote.

## AV-8 — Materials decisions (expedite, later date, pending orders)

**Yeh kya karta hai:** jab kisi order ka material uske release par kam ho ("Expedite or quote later"), planner ke paas do raaste hain:

1. **Request material expedite**: kaunsa existing PO line pehle aana chahiye (ya naya PO), kitna, kab tak.
   - **Approve** sirf irada hai, supply nahi. Aur **maker-checker**: jisne request ki, woh khud approve nahi kar sakta.
   - **Supplier ki confirmation** (date, quantity, reference) hi supply ko move karti hai. Confirm ki gayi quantity us date par aati hai, baaki PO apni due date par rehta hai.
   - Supplier ki date zaroorat ke baad ho → **late** → order "Decision required" par wapas.
2. **Explore / quote later date**: order ko book se nikaal kar har release day × har position try hota hai. Sabse pehli date jo materials aur poora route support karein, bina kisi aur order ka promise ya material bigade.
   - **Propose date to customer** → order **Pending orders** me. Dikhta hai, lekin capacity aur material nahi leta. Original promise same rehta hai.
   - **Date confirmation received** → "Ready to reschedule".
   - **Confirm and reschedule** → nayi date promise ban jaati hai aur order schedule me wapas aata hai.
   - **Move down queue** → order aage jaata hai, promise wahi rehta hai.

**Order ke states** (Scheduler ke Materials column me):

- Decision required: expedite or quote later
- Scheduled: expedite pending
- Scheduled: conditional on confirmed expedite
- Scheduled: material clear
- Awaiting customer date confirmation
- Ready to reschedule

### 1. Expedite

1. **Planning → Scheduler** → "Expedite or quote later" wali row → **Expedite**. Table me action type, component, quantity, needed by, on hand / timely supply, existing PO / due, aur orders dikhte hain. **Create linked expedite bundle** dabao.
2. **Planning → Expedites**: row "Requested". Jisne request kiya woh approve nahi kar sakta; doosra user (permission _Approve expedite requests and record supplier confirmations_) **Approve request** dabaye.
3. Supplier ka jawab: date, quantity (request se zyada nahi), reference → **Record confirmed receipt**. Needed-by ke baad ki date → "Confirmed late"; time par → "Confirmed by supplier", aur order "conditional on confirmed expedite" ho jaata hai.
4. **Reject / cannot arrive** (reason ke saath) → confirmation hat jaati hai, order phir "Decision required".

### 2. Later date aur pending

1. Row → **Later date**. Cards dikhenge: proposed delivery, production release, full-route finish, materials, position, aur kitne orders shift hote hain.
2. Upar **Planner-entered delivery date** daal kar **Preview date** dabao; customer ki date se pehle finish na ho to card "Conditional" dikhayega.
3. **Propose date to customer** → **Planning → Pending orders** me row aayegi (original, proposed, gating materials). Schedule me ye order nahi dikhega.
4. **Date confirmation received** → **Review / confirm and schedule** → **Confirm and reschedule**. Production order ki due date nayi date ban jaati hai.

**Nilkamal par check** (walkthrough §4, planning date 21-Sep). Pehle Insert order: `MFRCFSSFBND78725` × 160, need-by 05-Oct, **Take it whole, now** → INS-1.

- **Expedite:**
  - INS-1 → Expedite: `FMRF70DS787275`, 10 NOS, needed by 22-Sep, PO **4502939453 / 60**, due 28-Sep.
  - Doosre user se approve karao.
  - Confirm 28-Sep → late. Confirm 22-Sep → "Commit + replenish / conditional on confirmed expedite".
- **Later date** (dobara load karke, phir se INS-1 insert karo):
  - INS-1 → Later date: release 29-Sep, finish 03-Oct.
  - Date 07-Oct → Propose → Pending orders me (original 05-Oct).
  - Ready → Review → Confirm: promise 07-Oct, lot 29-Sep.

### 3. Permissions

- **Change the schedule** (schedule.plan): expedite request, later date, pending actions.
- **Approve expedite requests and record supplier confirmations** (purchase.expedite): approve, confirm, reject. Requester khud approve nahi kar sakta.
- **View** (planning.read): saare previews aur lists.

## AV-9 — Execution (work orders, downtime, cycle-time audit)

**Yeh kya karta hai:** plant se sirf **do event** chahiye: order **release** hua, aur **complete** hua. Inhi do se buffer penetration, schedule adherence aur cycle-time audit banta hai. Koi in-process scan ya sensor nahi.

- **Release:** jis calculation par planner ne release kiya, uske **planned minutes** order par freeze ho jaate hain. Release hone ke baad kaam **sequence me aage aa jaata hai aur dobara re-sequence nahi hota** — na grouping se, na club se, na planner ke move se.
- **Complete:** completion date, quantity aur **elapsed work minutes**. Order band ho jaata hai aur book se nikal jaata hai.
- **Buffer penetration:** planned ke upar (execution buffer %) ka protective time. 0% = plan ke andar, 100% = poora buffer, uske upar = buffer blown. Buffer % **Setup → Plant planning** me hai (default 25%).
- **Downtime:** kisi resource (ya ek machine) ke kisi din ke minutes chale jaate hain. Schedule wahi minutes kho deta hai aur **at-risk promises khud nikalte hain** (scripted nahi).
- **Make order release:** buffer board ki MAKE recommendation ek production order ban jaati hai.
- **Cycle-time audit:** apne completions se har item ka actual min/unit nikal kar maintained standard se compare hota hai. Flag tabhi jab: kam se kam 5 completions, sab ek hi taraf (upar ya neeche), aur drift 10% ya zyada. **Adopt** karne par naya routing revision (ACT1, ACT2…) banta hai aur purana usi din se band ho jaata hai.

### 1. Release aur complete

1. **Planning → Execution**. Upar tiles: schedule adherence, abhi kitne chal rahe hain.
2. "Release work" table me kisi order par **Release** dabao. Message me planned minutes dikhega.
3. **Scheduler** kholo: woh order ab #1 par hoga aur "Released: running, not re-sequenced" likha hoga. Use drag/move karke hilane ki koshish karo — apni jagah par hi rahega.
4. Wapas **Execution** me us row me completion form bharo: date, quantity, elapsed work minutes → **Record completion**.
   - Planned 60 aur elapsed 72 ho to penetration 80% (25% buffer) aur "Inside buffer".
   - Elapsed 80 ho to buffer blown.
5. Order schedule se nikal jaata hai aur adherence update hota hai.

### 2. Downtime aur at-risk

1. **Planning → Downtime** → resource (drum bhi chalega), machine (khaali = poora resource), date, minutes, reason → **Log downtime**.
2. Recalculation ke baad "Promises at risk" me wo orders dikhte hain jo pehle time par the aur ab late hain (ya pehle se zyada late).
3. **Machine is back** dabane par minutes wapas mil jaate hain aur schedule phir se seedha ho jaata hai.

### 3. Make order release

1. **Planning → Buffer board** me kisi made item ki row kholo (zone red/breach ho).
2. Recommendation cell me **Release make order** → `MO-1` jaisa order ban jaata hai, quantity aur due date recommendation wali.

### 4. Cycle-time audit

1. **Planning → Cycle time audit**. Jab tak 5 completions na hon, item "Inside noise" ya "Consistent, small" dikhega.
2. Ek hi item ke 5 orders release + complete karo, har baar elapsed standard se 20% zyada → row **Consistently wrong** ho jaayegi.
3. **Adopt** dabao → naya routing revision bunta hai. Uske baad schedule naye (asli) minutes se planning karta hai, aur dobara Adopt karne par "nothing to correct" aata hai.

Nilkamal par: har item ka standard CT sheet se aata hai, aur completions abhi nahi hain, isliye audit khaali rehta hai jab tak aap khud kuch work orders complete na karo. Demo ke prepared 12 series par rule ki parity unit test me check hoti hai (wahi 3 items flag hote hain).

### 5. Permissions

- **Release make orders, release and complete work orders, log downtime** (production.execute).
- **Adopt corrected cycle times from completed work orders** (masters.cycle_time).
- **View** (planning.read): saari screens padhne ke liye.

## AV-10 — Delivery aur planner ka din

**Yeh kya karta hai:** jo calculation abhi chali hai, wahi do screens me padh kar dikhti hai — **Today** (aaj kya karna hai) aur **Delivery** (kya promise kiya tha, kya milega). Har list CSV me export hoti hai, aur upar hamesha likha rehta hai ki number kis calculation ke hain aur input badle to nahi.

### 1. Today (planner ka din)

**Planning → Today**. Upar tiles: kitna order karna hai, kitna release karna hai, kitne critical alerts, aur kitne promises penetrated hain.

1. **Order today:** buffer board ki BUY recommendations; jinki date nikal chuki hai woh upar aur highlight me.
2. **Release today:** jin orders ka release day aa gaya hai. Material ready na ho to **Hold** likha aata hai.
3. **Alerts:** is calculation ke saare exceptions, sabse serious pehle:
   - Critical: stock out jiska koi order nahi, ya promise jo late ja raha hai.
   - High: red buffer, material short, late/rejected expedite, machine down, pichhle run se at-risk order.
   - Medium: yellow buffer, material validate nahi ho raha, expedite abhi confirm nahi hua, customer ki date ka intezaar.
   - Low: demand jo lead time ke bahar hai.

### 2. Delivery

**Planning → Delivery**:

1. **OTIF by order:** order tabhi on time jab uske **saare lots** promise tak ho jayein. Ek lot late = poora order late.
2. **By production lot:** wahi ginti lot-wise — ye number hamesha achha dikhta hai, isliye dono saath rakhe hain.
3. **Promises: given against projected** table: release by, promised, projected finish, **buffer used %** aur protection.
   - Buffer = promise tak ka poora runway; jo bacha hai woh slack hai.
   - 40% tak Protected, 70% tak Watch, uske upar Expedite zone, aur finish promise ke baad ho to **Penetrated**.
4. **Late only** checkbox se sirf late orders.
5. **Export (CSV)** buttons: OTIF, time buffer, release schedule (aur Today par alerts, today's list).

### 3. Stale-data indicator

Dono screens par heading ke neeche likha rehta hai: calculation number, kab chali, simulation date, aur agar input badle hain to **"inputs changed: recalculating…"**. Kuch bhi badlo (order, buffer, downtime, plant planning) to ye turant dikhega aur recalculation ke baad apne aap saaf ho jayega.

Nilkamal par abhi: **OTIF 100%** (76 me se 76 orders on time), 0 penetrated, aur alerts me zyadatar material wale (50 orders gated) aur buffer zones.

---

## AV-11 — Planning tools (mahine ki shape, buffer set, events, schemes, target, space, network)

Ye saare tools **Planning → Planning tools** tab me hain, upar ek **Tool** dropdown se chunte hain. Network alag tab hai.
Do tools plan ko sach me badalte hain (**Events & seasons**, **Scheme intake** — accept karne par), baaki sirf simulation hain: jab tak aap khud kuch save nahi karte, plan wahi rehta hai.

Change karne ke liye **planning.tools** permission chahiye; dekhne ke liye planning.read kaafi hai.

### 1. Month shape (mahine ki shape banaam constraint)

**Tool → Month shape**. Upar constraint (drum) ka naam, uski din bhar ki capacity aur mahine ke working days.

1. Bars me har din ka required minutes aur ek line par capacity. Line ke upar wale din constraint se zyada maang rahe hain.
2. **Over capacity** = poore mahine me kitne minutes capacity se zyada maange gaye.
3. **Prebuildable** = shuru ke shaant dino ki spare capacity se kitna peak pehle banaya ja sakta hai.
4. **Last third %** = mahine ka kitna hissa aakhri ek-tihai dino me girta hai (yahi "month-end rush" ka number hai).
5. **Level load** neeche: agar roz barabar banayein to peak stock kis din aur kitna (units aur days of demand).

Ye shape **Setup → Plant planning** ke _day weights_ se aati hai, volume plant ke finished goods (FG) ki demand se — components dobara nahi ginte.

### 2. Recommended buffers (service level se buffer set)

**Tool → Recommended buffers**, upar **Service level** (85/90/95/98%).

1. Har item ke liye ADU, variability, lead time, aur us service level par red/yellow/green zones.
2. **Fill %** = normal loss function se nikla hua, kitni demand stock se poori hogi. Steady item par 100% tak jaata hai, lumpy par kam.
3. Upar curve: 85 → 90 → 95% badhane par poore book ka top of green aur stock value kitna badhta hai — "service kitne ka padta hai" isi se dikhta hai.
4. Ye recommendation hai: buffer tab hi badlega jab aap Buffer settings me jaakar khud badlein.

### 3. Buffer vs MTO (kis item ko buffer chahiye hi nahi)

**Tool → Buffer vs MTO**. Har item ke liye: saal me kitne hafton me order aaya (orders/year), variability, aur sifarish.

- Saal me 12+ hafte **aur** variability 1.0 se kam = **BUFFER**.
- Warna **MTO** (order aane par banao, sirf ek hafte ka cover).
- Jahan aaj ki policy sifarish se alag hai, woh row upar aur highlight me (`change`).

### 4. Events & seasons (jo history me hai hi nahi)

**Tool → Events & seasons** → form: code, naam, Event/Season, window (from–to), **uplift %**, aur items (ya family, ya khaali = poora plant).

1. Save karne ke baad recalculation apne aap chalti hai.
2. Us item ke zones uplift se scale ho jaate hain, aur buffer row par message aata hai: _"Zones sized for an event: 50% above the trailing rate."_
3. Zones **window se pehle** hi badhte hain — item ke lead time jitna pehle — taki replenishment window ke andar land kare. Curve me `inWindow` wale hafte alag dikhte hain.
4. **Active** hata do ya window nikal jaye, to zones apne aap wapas normal.

Test: uplift 50% dalo, recalculation ke baad us item ka top of green thik 1.5 guna hona chahiye.

### 5. Scheme intake (dealer scheme)

**Tool → Scheme intake** → item, window, expected units.

1. Naya scheme **proposed** rehta hai: sirf dikhta hai, demand me nahi jaata.
2. **Accept** karne par hi uske units demand ban jaate hain (window par barabar bata kar, lead-time horizon ke andar) aur qualified demand badh jaati hai.
3. **Decline** karne par kuch nahi badalta. Decision kisne liya, woh row me likha rehta hai.

### 6. Target mode (sales target ki keemat)

**Tool → Target mode** → family (ya khaali = saare FG), period aur target units.

1. **History units** = us period jitne dino ki aaj ki rate se nikli demand.
2. **Ratio** = target ÷ history. Har item ke zones isi ratio par dobara nikaalte hain.
3. **Delta stock / delta value** = target poora karne ke liye kitna extra stock aur kitne paise chahiye.
4. **Utilisation %** = constraint par kitna load ho jayega. 100% se upar matlab target ke liye capacity ya shape badalna padega.

Kuch save nahi hota — ye sirf keemat batata hai.

### 7. Space mode (jitni jagah hai, utna set)

**Tool → Space mode** → pehle **Space limit** set karo (units ya volume).

1. Recommended set jagah me aa gaya to **fits**, aur kitni jagah bachi.
2. Na aaye to pehle **green** zones proportion me kaate jaate hain — **yellow ke neeche kabhi nahi**.
3. Agar sirf yellow tak bhi jagah se zyada hai, to **below** flag aata hai: matlab jagah hi kam hai, buffer ghata kar kaam nahi chalega.

### 8. Assumptions (plan kis baat par khada hai)

**Tool → Assumptions**. Plant planning, calendar, profiles, lead time basis — sabki aaj ki value ek jagah, "ye number kahan se aata hai" ke saath.

- Har row par **Confirm** dabakar note likh sakte hain (client ne confirm kiya). Confirm hone par pill **Confirmed** ho jaati hai, dobara dabane par **Reopen**.

### 9. Network

**Planning → Network** tab: saare plants ek table me — open orders, drum, uska utilisation, agla resource aur **stability**.

- Stability = drum aur uske baad wale resource ke beech ka gap (percentage points). Gap chhota ho to _Close_: chhoti si mix ya machine badalne par constraint jagah badal sakta hai.
- Neeche **machine what-if**: kisi resource ka machine count badal kar dekho constraint hilta hai ya nahi. Kuch save nahi hota.

### 10. Permissions

Viewer (sirf planning.read) ko saare tools dikhte hain, par event/scheme/space/assumption save ke buttons nahi dikhte aur API bhi 403 deti hai.

---

## AV-12 — File import (ERP ki apni .xlsx / .xls file seedha app me)

Ab CSV template banane ki zaroorat nahi: SAP se jo file aati hai wahi upload karo. **Availability → Masters & setup → File import**.

Jo CSV template wala purana raasta hai wo **Imports** tab par waise hi chalta rahega.

### 1. File upload

1. **Workbook** me `.xlsx` ya `.xls` chuno (40 MB tak) → **Upload**.
2. Neeche "Files uploaded" me aa jaayegi: kitne sheets hain, size, kitne imports us file se hue.
3. Wahi file dobara upload karoge to nayi copy nahi banegi — likha aayega _"already here as file #N"_.
4. File import ke baad bhi rehti hai (delete nahi hoti), taaki kisi bhi number ko uski row tak wapas dhoonda ja sake.

### 2. Sheet aur import type

**Choose** → phir **Sheet** (workbook me har plant ka alag sheet ho sakta hai), **Header row** (SAP aksar upar ek title row deta hai, to header row 2 hoti hai) aur **Import type** (Items, Stock movements, Demand history…) → **Read this sheet**.

Upar file ki pehli 20 rows dikhti hain, **har column apne number ke saath**. Agar SAP ne header naam repeat kiya hai (jaise `Unrestricted` do baar, ya `Release`/`Act.finish`) to upar likha aayega ki unhe **number se** chunna padega — naam se nahi.

### 3. Column mapping

Har field ke saamne teen cheezein:

- **Column in the file** — koi column, ya "Same value for every row…" (jaise `movement_type = OPENING`, ya plant code).
- **Read as** — Text / Number / Date / Unit of measure / Text in capitals.
- **Date format** — agar file me `03/04/2026` jaisi ambiguous date hai to poochha jaayega (din pehle ya mahina pehle); apne aap maan nahi liya jaata.

Neeche settings:

- **Decimals** — `1,234.56` ya `1.234,56`.
- **Unit aliases** — `EA=NOS, PC=NOS` (sirf jo aap likho wahi badlega).
- **Rows that repeat** — kaun se fields do rows ko "ek hi row" banate hain; chaaho to ek number column **jod** bhi sakte ho. (Sales file me ek din ki kai invoice lines hoti hain → `plant + item + date` par jod do, quantity add ho jaayegi.)
- **Rows to leave out** — rules: `plant is 1116`, `quantity is not zero`, `item is not X`…

Mapping ko **Save this mapping as** se naam de do — agli baar usi shape ki sheet par wahi mapping suggest ho jaayegi.

### 4. Reconciliation (commit se pehle ka hisaab)

**"Read the sheet and check it"** dabate hi neeche batch khulta hai, aur **"What was read from the file"** me poora hisaab:

```
Rows in the sheet        1,205
Under the header row     1,204
Left out by a rule         129   (128 × quantity not zero, 1 × item not equals …)
Added into another row       0   (jab rows jodi gayi hon)
Empty rows skipped           0
Read into this import    1,075
Ready to commit          1,075
Rejected                     0   (har ek ki wajah neeche)
Unaccounted                  0   ← ye hamesha 0 hona chahiye
```

Saath me **quantity har unit alag** (KG/NOS/M/L kabhi jode nahi jaate) aur rejected rows ki wajah ginti ke saath. Ek bhi row galat ho to **commit nahi hoga** — pehle rule se hatao ya file theek karo.

### 5. Commit

**Commit import** dabane par hi data jaata hai. Us file + sheet + import type ka combination dobara commit nahi ho sakta (409) — yani galti se do baar stock nahi chadhega.

### 6. Cutover ka sahi kram (Nilkamal par chala kar dekha hua)

1. **Units** — A2 ke Base Unit column se (rows combine karke).
2. **Items** — A2 sheet `1116`: code/name/base unit/family, aur **material type translate**: `FERT→FG`, `HALB→SFG`, `ROH/HIBE/ERSA/VERP/UNBW/MOLD→RM`; saath me `make_buy` usi column se (`FERT/HALB→MAKE`, baaki `BUY`).
3. **Stock locations** — MB52 ke SLoc column se (combine on code).
4. **Stock** — MB52: quantity = Unrestricted, zero rows rule se hata do, aur **reference item+location se banao** (MB52 me reference column hota hi nahi; isi se file dobara chadhane par stock dobara post nahi hota).

Asli result: 29,497 material rows me se **29,490 items** committed (6 codes chhode gaye — unme `%`, `+` ya space tha), 12 locations, aur **1,075 stock rows**; phir file se seedha milaya:

| Unit |    File total |    Import hua | Rows |
| ---- | ------------: | ------------: | ---: |
| KG   |    31,271.527 |    31,271.527 |   48 |
| L    |     3,226.878 |     3,226.878 |    9 |
| M    | 9,559,469.898 | 9,559,469.898 |  225 |
| NOS  |     551,519.4 |     551,519.4 |  793 |

**Reconciled** — har unit ka total file se bilkul same.

### 7. Bada file (performance)

Sales history jaisi file par naapa hua: **3,00,000 rows (4.8 MB)** → padhna + validate **7.5 s**, commit **2.1 s** (rows jod kar 250 din ke totals bane). Reader akela 287,653 rows (33.6 MB) **9.3 s** me padhta hai. Limit: **3,00,000 data rows** aur **40 MB** per file.

### 8. Permissions

File upload/mapping/staging ke liye **imports.create** + us import type ki apni permission chahiye (jaise stock ke liye inventory.move). Sirf `masters.read` wale ko files dikhti hain par upload/stage par 403 milta hai.

---

## Demo ke baaki panels (Batch A)

Ye teen cheezein demo me thi aur ab app me bhi hain.

### 1. Demand History ke upar teen naye panel

**Materials Planning → Demand History**:

1. **"N months of this plant's own demand"** — har mahine kitne units invoice hue (bars), peak mahina laal me; upar likha rehta hai average mahina aur peak. (Nilkamal par: 28 mahine, average 8,593 units, peak 2026-05 = 14,809.)
2. **"The shape of the year"** — har calendar mahine ka index: 1.00 = average mahina. Dashed line average par hai, uske upar wale mahine laal. (Nilkamal: Feb 1.23 sabse upar, Sep 0.82 sabse neeche.)
3. **"The order book is not the demand"** — abhi kitne orders/units khule hain, pichhle 12 mahine me kitna invoice hua, aur book usme kitne **din** ki demand hai.
4. **ABC / XYZ** — A pehle 80% value, B 95% tak, C baaki; X steady, Y beech, Z lumpy. Jab kisi item par cost nahi hoti (Nilkamal me nahi hai) to ranking **units** se hoti hai aur screen ye saaf likhti hai. Neeche top 25 items apni class, units, weeks-with-demand aur variability ke saath.

Sab kuch isi plant ki demand history se banta hai — koi forecast, koi anumaan nahi.

### 2. Release Schedule ab poori book ka

**Scheduling & Execution → Release Schedule** pehle sirf _aaj_ ke releases dikhata tha. Ab poori book: har order apni **release by**, projected finish, promise aur material ke saath, release date ke kram me. Late orders highlight hote hain, aur CSV export bhi wahin hai.

### 3. Feasible clubbing

**Scheduling & Execution → Club / date scenarios** me upar naya panel: kaun se same-item lots back-to-back chalaye ja sakte hain.

- Har row: item, kitne lots, club me kitne aayenge, **kitne setup minutes bachenge**, kitna carry karna padega, kitna pull-forward hoga.
- Verdict: _can be clubbed_ / _only with an expedite_ / kyun nahi (jaise `material short`, `cannot validate`).
- **See options** dabane par wahi purana club preview khulta hai jahan se apply hota hai. Yahan se kuch apply nahi hota — ye sirf batata hai kya mumkin hai.

Nilkamal par abhi: **17 items me se 4 club ho sakte hain, 835 setup minutes ki bachat**, 2 sirf expedite ke saath; baaki material ki wajah se nahi.
