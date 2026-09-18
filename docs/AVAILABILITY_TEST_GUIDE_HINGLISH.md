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
