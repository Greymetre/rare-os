# Reach — manual test guide

Har milestone complete hone par uska section yahan add hoga. Automated tests `npm run test:regression` mein chalte hain; ye steps aapke haath se verify karne ke liye hain.

## RCH-0 — Reach buniyaad (field masters, photo storage, soft delete)

**Kahan:** Login → left menu **Reach**. Menu tab dikhega jab role mein `reach.read` (Reach → View Reach field masters and readiness) ho. Admin role ke paas sab permissions apne aap hain.

27-Oct-2026 handover ke RCH-0 ka apna acceptance ye hai: _"Ek rep ka master Excel se load ho, uski selfie upload ho kar wapas dikhe, aur ek record 'hataane' par list se jaaye par database mein mile."_ Neeche ke step 5, 6 aur 7 bilkul wahi check karte hain.

### 1. Readiness

1. **Reach** menu kholo → **Field setup** group → **Readiness**.
2. Shuru mein 6 rows dikhengi. **Photo and document storage** hi **Ready** hogi (volume server par pehle se hai); baaki 5 **Missing**.
3. Badge par `1 / 6 ready` likha hoga. Har row ke neeche likha hai ki wo cheez kis liye chahiye.

### 2. Territories — zone aur uske andar territory

1. **Territories** → **Create territory** → code `EAST`, name `East zone`, Parent territory **khaali chhodo** → **Save territory**.
2. Phir **Create territory** → code `EAST-T1`, name `Kolkata city`, Parent `EAST` → save. Table mein Parent column mein `EAST` dikhega.
3. Parent mein koi galat code (`EAST-XX`) daalo → field ke neeche: **Territory EAST-XX was not found. Create it first.**
4. Teesra level banane ki koshish karo: code `EAST-T1-A`, Parent `EAST-T1` → error: **already sits under another territory.** (Design: zone + territory, bas do level.)
5. `EAST` ko edit karke uska Parent `EAST-T1` karne ki koshish karo → error: **already sits under another territory** (kyunki `EAST-T1` ka khud ek parent hai).
6. Ek aur zone banao: code `WEST`, Parent khaali. Ab `EAST` ka Parent `WEST` karne ki koshish karo → error: **already has EAST-T1 under it** (`EAST` ke andar pehle se territory hai, use neeche nahi le ja sakte).
7. `EAST` ka Parent `EAST` karne ki koshish karo → error: **cannot be its own parent.**

### 3. Rep grades, leave types, holidays

1. **Rep grades** → `SO` / `Sales Officer` / Seniority rank `1`, aur `ASM` / `Area Sales Manager` / rank **khaali** → save. Khaali rank `1` ban jaata hai.
2. Rank `0` ya `2.5` daalo → error (1 se 99 tak, poora number).
3. **Leave types** → `CL` / `Casual leave`. Paid tick, **Days a year** `12.5` (aadha din chalta hai), Carries forward off, Needs approval on.
   - `7.55` daalo → decimal error. `1000` daalo → at most 999.
4. **Holidays** → Date `2026-01-26`, Name `Republic Day`, Holiday type `NATIONAL`, Territory khaali → save.
5. Wahi date dobara National ke liye daalo → **already exists**.
6. Wahi date, type `REGIONAL`, Territory `EAST-T1` → ban jayegi (regional holiday alag record hai).

### 4. Field rep — haath se

1. **Field reps** → **Create field rep** → Rep code `FS-1`, Name `Kiran Patil`, Grade code `SO`, Territory code `EAST-T1`, Joined on `2024-04-01`.
2. **Login email** mein koi aisa email daalo jiska app mein login na ho → error: **No login was found for … Invite the user first, or leave this blank.**
3. Login email khaali karke save karo → rep ban jayega. (Rep pehle master hai, login baad mein — spreadsheet se list pehle aati hai.)
4. Users screen se ek login banao, phir rep edit karke uska **Login email** wahi daalo → save ho jayega. Wahi login doosre rep ko dene ki koshish karo → refuse hoga (ek login, ek rep).

### 5. Rep list Excel/CSV se (acceptance ka pehla hissa)

1. **Imports** screen kholo. **Import type** dropdown mein sirf 5 Reach masters honi chahiye: Territories, Rep grades, Field reps, Leave types, Holidays. (Availability ki items/suppliers yahan nahi dikhengi — wo apne module mein hain.)
2. **Field reps** choose karo → **Download template** → header hoga
   `code,name,grade,territory,user,email,phone,joined_on`
3. 3 rows bhar do (`user` column khaali chhodo), file upload karo → **Checking** → **Ready to review** → preview mein **Will create 3** → **Commit import** → **Committed**, Created 3.
4. **Field reps** screen par 4 rep dikhne chahiye.
5. **Wahi file dobara upload karke commit karo** → Created 0, Updated 0, **Unchanged 3**. (Import replay-safe hai; dobara chalane se kuch nahi badalta.)
6. Ek row mein Grade `XX` kar do → us line par error aur reason, aur **Commit** button nahi aayega.

### 6. Selfie — upload hoke wapas dikhni chahiye (acceptance ka doosra hissa)

1. **Field reps** screen par `FS-1` ki row mein **Add photo** button dabao.
2. Dialog khulega → **Choose a photo** → apne phone/laptop se koi JPEG ya PNG chuno.
3. Browser use **1600 pixel** tak chhota karke bhejta hai (dialog mein ye likha hai). Upload ke baad photo usi dialog mein dikhni chahiye, aur message: **Photo saved for field rep FS-1.**
4. Dialog band karke dobara **Photo** dabao → photo phir dikhni chahiye (server se aa rahi hai, browser ki memory se nahi). Page **refresh** karke bhi check karo.
5. **Remove photo** dabao → **Photo removed from field rep FS-1.** Row ka button wapas **Add photo** ho jayega.
   - Dhyan do: photo _rep se hat gayi_, file khud nahi mitti. Yahi design hai.
6. Galat file ki koshish:
   - Kisi `.txt` ya `.zip` file ka naam badal kar `photo.jpg` kar do aur upload karo → **This file is not really a image/jpeg.** (Server naam par bharosa nahi karta, file ke andar ke bytes dekhta hai.)
   - 8 MB se badi file → **larger than 8 MB.**

### 7. Soft delete — list se jaye, database mein rahe (acceptance ka teesra hissa)

1. **Holidays** screen → `Republic Day` ki row mein **Remove** dabao.
2. Dialog mein likha hoga ki record rakha jayega aur code free ho jayega. **Reason** mein `Entered twice` likho → **Confirm remove**.
3. Message: **… removed. It is off the list but kept in the records.** Row list se gayab.
4. **Wahi date dobara** `Republic Day` ke naam se banao → ban jayegi (code/date free ho gaya).
5. Database mein dono rows milni chahiye — ek removed, ek nayi:
   ```bash
   docker compose exec -T db psql -U rare_owner -d rare_os -At -c \
     "SELECT name, deleted_at IS NOT NULL AS removed, delete_reason FROM holidays WHERE holiday_date='2026-01-26'"
   ```
6. **Jo cheez use ho rahi hai wo nahi hategi:** `EAST-T1` (jiske andar 4 rep hain) par **Remove** dabao → **4 field reps still use it. Move them first.** Aur `EAST` par → **1 territory still uses it.**
7. Availability ke masters (Items, Suppliers…) par **Remove** button nahi hona chahiye — wahan sirf Inactive karna hai, taaki purana planning data padha ja sake.

### 8. Readiness wapas check

1. **Readiness** → badge `6 / 6 ready`.
2. **Field reps** row par likha hoga `4 on the rolls, 0 with a login` (ya jitne login aapne jode).

### 9. Permissions (ye zaroori hai)

1. **Roles & permissions** → naya role banao: sirf `dashboard.read`, `reach.read`, `files.read`. (`reach.manage` tick karne par `reach.read` apne aap aa jata hai; `reach.delete` par dono.)
2. Us role ka ek user banao, usse login karo:
   - **Reach** menu dikhega, saari screens khulengi, photo bhi dikhegi.
   - **Create …** aur **Remove** button kahin nahi honge.
   - **Imports** screen par "Import data" panel nahi hoga (maintain karne ki permission nahi hai).
3. Ab us role se `reach.read` hata do (sirf `dashboard.read` + `masters.read` rakho) → wo user **Reach** menu hi nahi dekhega, aur Availability ke masters normal chalenge.

### 10. Photo kahan rakhi hai (server side)

```bash
# database mein bytes nahi, sirf handle
docker compose exec -T db psql -U rare_owner -d rare_os -At -c \
  "SELECT file_no, purpose, content_type, byte_size, storage_key FROM stored_files ORDER BY file_no"
# bytes volume par
docker compose exec -T api sh -c 'find "$FILE_STORE_DIR" -type f | head'
```

Path file ke apne sha256 se banta hai, isliye ek hi photo do baar upload karne par disk par ek hi file rehti hai. Backup: ye volume apne restic snapshot mein jata hai, tag `rare-os-files` — details `docs/OPERATIONS_HINGLISH.md` mein.

### Jo RCH-0 mein nahi hai

Attendance, Tour Plan aur Expenses — ye RCH-2, RCH-3 aur RCH-6 hain, plan `RARE_OS_Reach_Milestone_Plan.pdf` mein. Mobile app sabse last (RCH-8). Availability ke purane masters par soft delete abhi nahi lagaya gaya — wahan deactivate hi rehega.

---

## RCH-1 — Customers aur Beats

**Kahan:** **Reach** menu me ab teen group hain:

- **Customers** — Customer register, Beat round, Approvals
- **Field setup** — Readiness, Territories, Rep grades, Field reps, Leave types, Holidays, Beats, Beat assignments, Imports, File import
- **Customer setup** — Customer types, Customer form fields, Customer form by type, Reach settings

27-Oct handover ke RCH-1 ka acceptance: _"Ek beat mein 12 outlet daalo — wo kramwar dikhein, unka town aaye, aur ek naya customer banate hi apne beat mein jud jaye."_ Step 5 aur 6 bilkul yahi hain.

**Zaroori baat — do tarah ke "customer" hain:**

- **Availability → Customers** = planning ka account, jiske naam par sales order banta hai (OEM/DISTRIBUTOR/…)
- **Reach → Customer register** = dukaan/outlet jahan rep jaata hai (6 trade types)

Ye jaan-boojh ke alag hain. Agar ek distributor dono hai, to Reach ke record me **Planning account** field me uska planning code daal dijiye — link ban jayega. Ek planning account ek hi Reach customer se jud sakta hai.

### 1. Chhe customer types — ek template se

1. **Customer setup → Customer types** → kuch nahi hoga shuru me.
2. **Field setup → Imports** → Import type me **Customer types** choose karo → **Download template**.
3. Template me handover ke apne chhe types pehle se bhare hue hain, unke asli numbers ke saath: check-in radius 100/150/75/75/200/200 (AS-R43) aur hold days 30/15/–/–/60/– (AS-R44).
4. Bina kuch badle upload karo → commit → **Created 6**.
5. **Customer types** screen par chhe dikhne chahiye. `DIST` par dekho: **New account needs approval** on, **Sits on a beat plan** on. `KEY` par: beat plan **off** (key account beat par nahi chalta, par territory ke liye beat carry karta hai).

### 2. Customer ka form — sawal aur matrix

1. **Customer setup → Customer form fields** → **Create form field**:
   - `trade_name` / Label `Trade name` / Input `text` / Section `Identity` / Order `10`
   - `shop_type` / `Shop type` / Input `select` / Choices `Exclusive|Multi-brand|General` / Order `30`
   - `gstin` / `GSTIN` / Input `gstin` / Section `Statutory` / Order `20`
2. `select` choose karke Choices khaali chhod do → error: **A choice list needs its choices.**
3. Field key me `1abc` ya `has space` daalo → error (chhote letter se shuru, sirf letters/numbers/underscore).
4. **Customer form by type** → **Create form rule**:
   - `RET` + `trade_name` → **R** (zaroori)
   - `RET` + `shop_type` → **O** (optional)
   - `RET` + `gstin` → **X** (RET se nahi pucha jayega)
   - `DIST` + `gstin` → **R**
5. Matlab: ek sawal kisi type par rule dale bina **kisi se bhi nahi** pucha jata. Naya field banane se wo kahin nahi dikhega jab tak matrix me na rakho.

### 3. Territory, rep aur beat

1. **Field setup** se: Territory `T1`, Rep grade `SO`, Field rep `FS-1`.
2. **Beats** → **Create beat** → code `B1`, name `Kolkata north round`, Territory `T1`, How often `WEEKLY`, Days `mon,thu`, Which week `ALL`.
   - Days me `thu, mon` likho → save hone par `MON,THU` ban jayega (week order me).
   - `WEEKLY` ke saath Which week `ODD` karo → error: **A weekly beat runs every week.**
   - `FORTNIGHTLY` ke saath `ALL` chhodo → error: **Choose ODD or EVEN weeks.**
3. **Beat assignments** → Beat `B1`, Rep `FS-1`, From `2026-04-01`, Until khaali.
   - Dobara `B1` ke liye `2026-06-01` se daalo → error: **FS-1 already has this beat from 2026-04-01 onwards. Close that spell first.**
   - Pehle wale ka **Until** `2026-05-31` kar do, phir `2026-06-01` wala ban jayega. Purana record rehta hai — isliye pichhle quarter ki adherence usi rep par padhegi jiske paas beat tab thi.

### 4. Pehla customer — form type ke hisaab se badalta hai

1. **Customers → Customer register** → **Create customer**.
2. **Customer type** `Retailer` choose karo. Neeche sirf **Trade name \*** aur **Shop type** dikhne chahiye — GSTIN nahi, kyunki RET par uska rule `X` hai.
3. Type `Distributor` kar do → form badal jayega, ab **GSTIN \*** dikhega.
4. Wapas `Retailer` karo. Code `R01`, Name `Outlet 1`, Territory `T1`, Beat khaali chhod kar save karo → error: **A Retailer is visited on a beat, so it needs one.**
5. Beat `B1` daalo, Trade name khaali rakho → error: **Trade name is required.**
6. Trade name bhar do → ban jayega, message me likha hoga **added to beat B1 at stop 1**.

### 5. Baarah outlet, kramwar (acceptance ka pehla hissa)

1. Isi tarah `R02` se `R12` tak banao, har ek me Town bhar do (Shyambazar, Baranagar, Dum Dum…).
2. **Customers → Beat round** → Beat `B1` → **12 stops** dikhne chahiye, **1 se 12 kramwar**, har ek ka Town saath me, aur upar likha hoga `Every week on MON, THU` aur `walked by Kiran Patil`.

### 6. Naya customer banate hi beat me jud jaye (acceptance ka doosra hissa)

1. `R13` banao, Beat `B1`.
2. Message: **added to beat B1 at stop 13.**
3. **Beat round** par wo 13ve stop par dikhega. Yahi handover ka rule hai: jo type beat par chalta hai, wo active hote hi apne beat ka stop ban jata hai.

### 7. Order badalna

1. **Beat round** par kisi stop ke `↓` dabao — order badal jayega par save nahi hua.
2. **Save this order** dabao → message `The round now has 13 stops in this order.`
3. **Undo** se wapas aa sakte hain (save se pehle).
4. Order 1..n saaf rehta hai — koi gap nahi.

### 8. Approval wala account

1. **Create customer** → type `Distributor`, code `D1`, GSTIN `27aapfu0939f1zv` (chhote letters me hi likho).
2. Message: **created and sent for approval.** Status **Awaiting approval**.
3. **Beat round** dekho — `D1` abhi stop **nahi** hai, kyunki approval baaki hai.
4. Register me `D1` par **Dormant/Activate** button nahi dikhega; API se zabardasti karo to error: **This account is waiting for approval.**
5. **Customers → Approvals** → New accounts me `D1`. **Decide** → Reason khaali rakh kar **Reject** → error: **Say why the account is rejected.**
6. Reason bhar kar **Approve** → message **approved and added to beat B1**. Ab wo beat ka last stop hai.
7. GSTIN check karo — `27AAPFU0939F1ZV` bada hoke save hua hoga. Galat GSTIN (aakhri character badal do) → error: **the last character does not check out.**

### 9. Location tag

1. Register me `R02` par **Open** dabao → **Location** panel.
2. Latitude `22.572600`, Longitude `88.363900` daal kar **Save this location** → **Location saved.** Badge me `Typed` dikhega (typed tag kabhi verified nahi hota).
3. **Use this device** dabao (browser permission maangega) → coordinates bhar jayenge aur accuracy bata dega. Save karne par agar accuracy 50 m ke andar hai to badge **Verified by a device fix**.
4. Ab Latitude `22.582600` kar do (lagbhag 1.1 km uttar) → message: **This moves the shop 1112 m, more than the 100 m allowed, so it is waiting for approval.**
5. Panel me likha hoga ki move approval ka intezaar kar raha hai, aur **plane par ek khokhla laal point** dikhega line ke saath. **Dukaan abhi hili nahi** — yahi design hai.
6. Dobara move karne ki koshish karo → error: **already has a move waiting for approval.**
7. **Approvals → Location moves** me wo request. **Approve** → dukaan wahan chali jayegi. **Reject** karte to wahin rehti (reason zaroori).
8. `R03` ko `R02` ke bilkul paas tag karo (22.582610 / 88.363910) → warning: **Tagged within 30 m of R02 (… m). Check it is not the same shop entered twice.** Ye sirf warning hai, rokta nahi.
9. **Location** panel ke neeche history table — har tag, uska source, kitna hila, status aur reason.

### 10. Register — filter, CSV, dormant, remove

1. Upar saat tiles: On the register, Active, Awaiting approval, Dormant, Location tagged, Verified by a device, No rep.
2. Search `R0` → sirf wahi. Type filter `Distributor` → sirf `D1`. Location filter `Not tagged` / `Tagged` / `Verified`.
3. **Download CSV** → jo screen par dikh raha hai wahi file me aayega (filters lagu hote hain), 14 column ke saath.
4. Kisi active customer par **Dormant** → message **dormant and off its beat**; Beat round par stop kam ho jayega. **Activate** → wapas, par **aakhri stop par** (purani position wapas nahi aati — ye jaan-boojh ke hai).
5. `R04` ko edit karke **Buys from** = `D1` kar do. Ab `D1` ko **Remove** karo → error: **1 customer buys from it.**
6. Kisi aur customer ko **Remove** karo reason ke saath → register se jayega, beat se jayega, par database me rahega aur uska code dobara use ho sakega:
   ```bash
   docker compose exec -T db psql -U rare_owner -d rare_os -At -c \
     "SELECT code, status, deleted_at IS NOT NULL AS removed, delete_reason FROM trade_customers WHERE code='R12'"
   ```

### 11. Reach settings

1. **Customer setup → Reach settings** → chaar number, pehle `Never changed` (koi row nahi, defaults chal rahe hain).
2. `A move further than this needs approval` ko `250` kar do → save → `Version 1`.
3. Ab 1112 m se chhota move (jaise 200 m) approval ke bina lag jayega. Ye settings ab asar daal rahi hain.
4. `A device fix counts as verified within` me `1` daalo → error (5 se 1000 tak).
5. Do tab me ek saath save karo → doosre me **changed elsewhere** message.
6. Dhyan do: **check-in radius aur hold days yahan nahi hain** — wo customer type par hain, kyunki type ke hisaab se alag hote hain.

### 12. Permissions

1. Naya role: `dashboard.read` + `reach.read` sirf.
   - Reach menu dikhega, register khulega, customer open hoga, Reach settings dikhegi par **Save settings** nahi.
   - **Create customer**, **Remove**, **Dormant**, location save — kuch nahi dikhega. **Approvals** tab hi nahi hoga.
2. Usme `reach.approve` add karo → **Approvals** tab aa jayega aur decide kar sakega, par customer banana/badalna phir bhi nahi.
3. `reach.setup` tick karo → `reach.read` aur `reach.manage` apne aap aa jayenge (form ka dhaancha badalna maintain karne se bada kaam hai). Ab Customer types / form fields / matrix / settings edit ho payenge.

### Jo RCH-1 mein nahi hai

Customer 360 (RCH-5), visit aur check-out report (RCH-4), orders, KYC documents, outstanding aur ledger — ye aage ke milestones hain. Abhi customer type par `KYC before ordering`, `Order route`, `Credit limit`, `Credit days` aur `Hold days` **sirf set hote hain**, inhe padhne wala kaam baad me aayega. Geo plane par koi map background nahi hai (handover me bhi nahi hai) — wo to-scale plane hai.
