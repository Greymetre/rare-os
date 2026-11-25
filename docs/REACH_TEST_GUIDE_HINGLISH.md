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

---

## RCH-2 — Attendance aur Leave

Yahan sabse zaroori baat pehle samajh lijiye: **register kahin store nahi hota.** Present, Late,
Half day, Leave, Absent, Week-off aur Holiday har baar punch, shift, holiday list aur approved
leave se **nikale jaate hain**. Isliye agar aap aaj ek purana punch theek karte ho ya ek holiday
peeche daalte ho, to **pichhle mahine ka register bhi badal jaata hai** — yahi iska maqsad hai.

Saari clock timings company ke apne timezone me padhi jaati hain (`Reach → Attendance settings`),
default `Asia/Kolkata`.

### 1. Shift banao (sab kuch isi par tika hai)

`Reach → Field setup → Shifts → Create shift`

| Field                  | Daalo   |
| ---------------------- | ------- |
| Shift code             | `DAY`   |
| Starts at              | `09:30` |
| Ends at                | `18:00` |
| Grace in minutes       | `10`    |
| Half day under minutes | `240`   |
| Counts from minutes    | `60`    |
| Week off               | `SUN`   |

Jaanch ke liye: `25:00` daal kar dekho — refuse hona chahiye. `9:30` likho to apne aap `09:30`
ban jana chahiye. `sun` likho to `SUN`. Aur "Counts from" ko `300` aur "Half day under" ko `120`
karke save karo — wo bhi rukna chahiye (din aadha hone ke baad ginti shuru nahi ho sakti).

Ek **night shift** bhi banao: `NIGHT`, `22:00` se `06:00`. Yeh chalna chahiye — end start se
pehle hona galti nahi, raat ki shift hai.

### 2. Work types

`Reach → Field setup → Work types`

| Code       | Needs a location | Counts as attended |
| ---------- | ---------------- | ------------------ |
| `FIELD`    | yes              | yes                |
| `OFFICE`   | no               | yes                |
| `PERSONAL` | no               | **no**             |

`PERSONAL` ka matlab: din record hoga par attendance me ginega nahi.

### 3. Rep ko shift do

`Reach → Field setup → Field reps` — apne rep ko edit karke **Shift code** me `DAY` daalo.

Shift khaali chhoda to kya hota hai? Register phir saaf kehta hai ki lateness judge nahi ho
sakti — wo chupchap office hours maan kar nahi chalta.

### 4. Apna din — acceptance ka pehla hissa

Us login se sign in karo jo kisi field rep se juda hai. `Reach → Attendance → My day`.

1. Work type chuno
2. `FIELD` chuna to **Use my location** dabao, phir **selfie** lo
3. **Start my day**

Dekhne layak cheezein:

- `OFFICE` chunte hi location aur selfie ki zarurat gayab ho jaani chahiye
- Location permission mana karo — screen saaf batayega kya kami hai, crash nahi karega
- Dobara start karne ki koshish karo — rukna chahiye
- **End my day** ke baad "Your day is finished" dikhega

Jis login ka koi rep record nahi hai, usse saaf kaha jayega — khaali screen nahi milega.

### 5. Late, Half day aur Leave — plan ka apna acceptance

`Reach → Attendance → Register`, apni date range chuno.

| Punch              | Dikhna chahiye                                            |
| ------------------ | --------------------------------------------------------- |
| 09:29 – 18:00      | **Present**                                               |
| 09:40 – 18:00      | **Present** (09:30 + 10 grace, boundary par late nahi)    |
| 09:41 – 18:00      | **Late**                                                  |
| 09:45 – 13:00      | **Half day** (3h 15m), par "Why" me late bhi likha rahega |
| 09:00 – 09:30      | **Absent** (ek ghante se kam, din ginta hi nahi)          |
| 09:00 – (end nahi) | **Not ended** — correction maango                         |

Aur sabse zaroori: **approved leave wale din punch ka sawal hi nahi uthta** — wahan `Leave`
likha aayega, chahe punch ho ya na ho.

### 6. Tarteeb — kya kisko harata hai

`Holiday` → `Week off` → `Leave` → punch → `Absent`

Iski jaanch:

- Leave wale din par ek **holiday** daal do → din `Holiday` ho jayega (rep ki leave bekaar na jaye)
- Sunday dekho → `Week off`, `Absent` nahi

### 7. Leave — balance, apply, approve

`Reach → Attendance → Leave`

Upar balance table: quota, taken, left. Apply karo, phir **wahi dates dobara** maango — rukna
chahiye, aur message me purani dates ka naam aayega.

`reach.leave` wale login se **Decide** dabao. Refuse karne par **reason zaroori hai**, approve
karne par nahi. Approve hote hi register us din par `Leave` dikhane lagega aur balance ghat jayega.

Jiske paas `reach.leave` nahi hai usey **Withdraw** dikhega — sirf apni request par.

### 8. Correction (regularisation)

`Reach → Attendance → Corrections → Ask for a correction`

Ek purana din chuno jahan punch chhut gaya tha, time daalo, wajah likho.

- Usi din ke liye doosri correction maango — rukna chahiye
- **Future ki date** maango — rukna chahiye
- Queue me **"Was" aur "Asked for" dono** dikhte hain — purani value record par hi rehti hai
- Approve karo → register us din ko dobara padhega aur status badal jayega

### 9. Today board

`Reach → Attendance → Today`

Upar tiles (kitne present, late, absent…), neeche har rep ki line. Jo rep shift khatam hone ke
**"Chase after minutes"** baad bhi nahi dikha, uske saamne _no word yet_ aayega — yeh sirf
**suggestion hai**, koi message apne aap nahi jaata.

Jo rep fence ke bahar se shuru kare uske start time ke aage `*` lagega. **Punch phir bhi hota
hai** — fence se bahar hona mana nahi hai, bas nishaan lag jaata hai.

### 10. Payroll CSV

`Register → Payroll CSV`. Header:

```
code,name,days,present,late,half_day,leave,absent,week_off,holiday,open,paid_days
```

**CSV ki ginti screen se bilkul milni chahiye** — dono ek hi engine se aate hain. Ek rep ka
register khol kar tiles se mila lijiye.

`paid_days` ka hisaab: Present aur Late = 1, Half day = 0.5, **paid** leave = 1, **unpaid**
leave = 0, aur Absent / Not ended / Week off / Holiday = 0.

### 11. Attendance settings

`Reach → Customer setup → Attendance settings`

Fence (metres), chase-after minutes, selfie zaroori hai ya nahi, aur timezone.

Zaroori jaanch: **yahan save karne ke baad `Reach settings` khol kar dekho** — GPS verified,
duplicate aur retag wali values waisi ki waisi honi chahiye. Dono ek hi row me rehti hain, par
ek doosre ko mitati nahi.

Timezone me `Mars/Olympus` daal kar dekho — refuse hona chahiye.

### 12. Permissions

| Permission     | Kya milta hai                                     |
| -------------- | ------------------------------------------------- |
| `reach.attend` | My day, apna Register, apni Leave aur Corrections |
| `reach.read`   | Today board, sab reps ka register, Payroll CSV    |
| `reach.leave`  | Leave aur corrections par **Decide**              |
| `reach.setup`  | Attendance settings badalna                       |

Sirf `reach.attend` wale login se jaanch: **Today** menu me dikhna hi nahi chahiye, **Payroll
CSV** ka link nahi hona chahiye, aur kisi doosre rep ka register maangne par mana hona chahiye.

### Jo RCH-2 mein nahi hai

- Reminder apne aap nahi jaata — board sirf propose karta hai
- Payroll software se koi jodna nahi hai, sirf CSV
- Overtime, comp-off aur leave carry-forward ka hisaab abhi nahi
- Mobile app nahi — web browser phone par chalta hai, selfie aur GPS wahin se

---

## RCH-3 — Tour Plan

Yahan bhi wahi usool hai jo RCH-2 me tha, aur isi wajah se milestone ka doosra acceptance
chalta hai: **plan vs actual kahin store nahi hota.** Followed, Partial, Deviated, Missed aur
Unplanned har baar plan, visits aur attendance register se **nikale jaate hain**. Isliye plan
ban jane ke **baad** agar kisi din ki leave approve ho jaye, to wo din apne aap "Missed" hona
band ho jaata hai — kuch dobara likhna nahi padta.

Leave, holiday aur week-off yahan dobara nahi rakhe gaye. Wo Attendance ke hain, aur plan unhi
se poochta hai. Ek hi holiday do jagah rakhne par company apne aap se asehmat ho jaati hai.

**Kahan:** `Reach → Tour plan` — **My plan**, **Plans**, **Day changes**, **Plan vs actual**.
Settings `Reach → Customer setup → Tour plan settings`.

### 1. Pehle ye hona chahiye (RCH-1 aur RCH-2 ka saman)

| Cheez            | Kahan                                      |
| ---------------- | ------------------------------------------ |
| Territory, Rep   | Field setup → Territories, Field reps      |
| Shift (week off) | Field setup → Shifts — `Week off = SUN`    |
| Beat + run days  | Field setup → Beats — `run_days = MON,THU` |
| Beat assignment  | Field setup → Beat assignments             |
| Beat ke outlets  | Customers → Customer register (beat chuno) |
| Holiday          | Field setup → Holidays                     |

Beat ka **town** aur **kitne outlet** — dono beat ke apne stops se aate hain, haath se nahi
likhe jaate. Isi wajah se plan kabhi aisa town nahi bol sakta jahan se round guzarta hi nahi.

### 2. Mahina shuru karo

`Reach → Tour plan → My plan` → month chuno → **Start this month**.

Ek rep ka ek mahine me ek hi plan banta hai. Dobara start karne par mana hona chahiye.

### 3. Auto-fill — beat calendar se poora mahina

**Fill from the beat calendar** dabao.

Dekhne layak:

- Sirf wahi din bhare jo beat ke `run_days` me hain
- **Sunday aur holiday bilkul nahi aate** — wo Attendance ke hain
- FORTNIGHTLY beat sirf apne aadhe pakhwade me aata hai (ODD / EVEN ISO week)
- Jo beat rep ne mahine ke beech me liya hai, wo usse pehle ke din me nahi aata
- Har bhare hue din par round, uska town aur uske outlet ki ginti aa jaati hai
- "From" column me `Beat calendar` likha dikhega

Ab ek din ko **Change** karke haath se badlo (`From` me `Typed` ho jayega), phir dobara
**Fill from the beat calendar** dabao — **aapka typed din waisa hi rehna chahiye.**

### 4. Jo jaanch mahina paas kiye bina submit nahi hota

Screen par teen check dikhte hain, har ek apna kaaran likhta hai:

| Check        | Matlab                                      |
| ------------ | ------------------------------------------- |
| `HAS_DAYS`   | Mahine me kam se kam ek field day ho        |
| `FIELD_DAYS` | Working days ka kam se kam 75% field day ho |
| `OUTLET_CAP` | Kisi din 12 se zyada outlet na hon          |

Working days = mahine ke din − Sundays (rep ka week off) − holidays.

Sirf auto-fill se mahina aam taur par 75% tak nahi pahunchta, to **Submit for approval** band
rahega. Baaki din haath se bharo, phir khul jayega.

Ek din me `30` outlet daal kar dekho — **wahin mana hona chahiye**, 12 ki limit ke saath.
Mahine ke bahar ki date daalo — wo bhi mana. Aur aisa round chuno jo rep ke paas hai hi nahi —
wo bhi mana.

### 5. Submit, approve, wapas bhejna

Rep: **Submit for approval**.

Ab mahina **Waiting** hai — rep usme kuch bhi badal nahi sakta. Try karke dekho, mana hona
chahiye.

Manager (`reach.plan_approve` wala): `Reach → Tour plan → Plans` → month chuno → **Decide**.

- **Send back** bina kaaran likhe — **mana hona chahiye**. Kaaran likh kar bhejo.
- Rep ko wo kaaran apni screen par dikhna chahiye.
- Rep dobara submit kare — purana kaaran apne aap hat jata hai.
- Ab **Approve** karo.

Rep apne hi mahine ko approve karne ki koshish kare — permission nahi milni chahiye.

### 6. Approved mahine ka ek din hilana (change request)

Approved mahina ab type karke nahi badlta. Rep: us din par **Ask to change**.

- Kaaran likhna zaroori hai
- Ek din par ek hi request chal sakti hai — doosri bhejne par mana
- Rep khud apni request decide nahi kar sakta

Manager: `Tour plan → Day changes` → **Decide** → **Approve the move**.

Iske baad:

- **Sirf wahi ek din badla** — aas-paas ke din waise ke waise
- Request par **purana din bhi likha rehta hai** (`Now` column), isliye record mitta nahi
- Usi request ko dobara decide karne par mana

### 7. Plan vs actual — milestone ka apna acceptance

Abhi check-in RCH-4 me aayega, isliye jaanch ke liye visits seedha database me daal kar dekhiye
(ye **sirf local test ke liye** hai):

```bash
docker compose exec -T db psql -U rare_owner -d rare_os -c \
  "INSERT INTO visits(id,tenant_id,rep_id,customer_id,visit_date,checked_in_at)
   SELECT gen_random_uuid(), c.tenant_id, r.id, c.id, '2026-03-09', '2026-03-09 11:00+05:30'
   FROM trade_customers c, field_reps r
   WHERE r.code='<REP>' AND c.beat_id=(SELECT id FROM beats WHERE code='<BEAT>')
   LIMIT 6"
```

`Reach → Tour plan → Plan vs actual` → From/To us din par:

| Kitne stop par gaye (10 me se) | Kya dikhna chahiye |
| ------------------------------ | ------------------ |
| 6 (= 60%)                      | **Followed**       |
| 5 (= 50%)                      | **Partial**        |
| 0, par kahin aur gaye          | **Deviated**       |
| 0, kahin nahi gaye             | **Missed**         |
| Din plan me tha hi nahi        | **Unplanned**      |

**Ab dusra acceptance:** usi mahine ke kisi planned din ki leave approve kar do
(`Reach → Attendance → Leave`). Phir Plan vs actual me wo din dekho —
**Missed nahi, `Leave` dikhna chahiye**, aur score ke denominator se bahar ho jana chahiye.
Plan me kuch bhi dobara nahi likha gaya — yahi "calculate, store nahi" ka faayda hai.

Holiday aur Sunday bhi kisi ke khilaaf nahi ginte.

### 8. Plans board

`Reach → Tour plan → Plans` — mahine ka poora hisaab:

- Kis rep ka mahina kis haal me hai (Draft / Waiting / Approved / Sent back)
- Kitne field days aur kitne outlet calls
- **Jin reps ne mahina shuru hi nahi kiya wo bhi list me hain** (`Not started`) — yahi iska
  asli maqsad hai

### 9. Tour plan settings

`Reach → Customer setup → Tour plan settings`

| Setting                                 | Default | Matlab                                  |
| --------------------------------------- | ------- | --------------------------------------- |
| Plan due on day                         | 25      | Agle mahine ka plan is tareekh tak      |
| Most outlets in a day                   | 12      | Isse zyada daalne par wahin mana        |
| Field days as a percent of working days | 75      | Isse kam par mahina submit nahi hota    |
| Followed at percent of the round        | 60      | Itne % round par gaye to din `Followed` |

Ye chaar number client ke abhi tak na-diye gaye jawab hain (milestone plan ke sawal 5, 6 aur 8).
Jawab aate hi screen se badal jayenge, koi deploy nahi chahiye.

Zaroori jaanch: **yahan save karne ke baad `Reach settings` aur `Attendance settings` dono khol
kar dekho** — unki values waisi ki waisi honi chahiye. Teeno ek hi row me rehti hain.

### 10. Permissions

| Permission           | Kya milta hai                                   |
| -------------------- | ----------------------------------------------- |
| `reach.plan`         | My plan, apna Plan vs actual, apni Day changes  |
| `reach.read`         | Plans board, kisi bhi rep ka plan aur adherence |
| `reach.plan_approve` | Plan aur day change par **Decide**              |
| `reach.setup`        | Tour plan settings badalna                      |

Sirf `reach.plan` wale login se jaanch: **Plans** menu me dikhna hi nahi chahiye, aur kisi
doosre rep ka plan ya adherence maangne par mana hona chahiye.

### Jo RCH-3 mein nahi hai

- **Check-in khud RCH-4 me hai.** Yahan visits padhe jaate hain, banaye nahi jaate — isliye
  asli Plan vs actual RCH-4 ke baad hi bharna shuru hoga
- Manager rep ka plan khud edit nahi kar sakta (milestone plan ka sawal 8 — jaan boojh kar)
- Plan ka koi CSV export abhi nahi
- Visit norms (A/B/C class par mahine me kitni visit) abhi nahi — wo sawal 7 hai, client se
- Mobile app nahi

---

## RCH-4 — Visit aur check-out report

Milestone plan isse **"Reach ka dil"** kehta hai, aur handover saaf likhta hai: ye raasta server
par pakka hone se pehle mobile app shuru nahi karni chahiye. Isliye teen usool yahan **server
par** lage hain, screen par nahi:

1. **Check-in kabhi reject nahi hota.** Dukaan se 800 meter door khade ho? Visit **banega aur
   flag hoga**. Reject karne se ek asli visit gum ho jaati hai aur salesman app par bharosa
   karna chhod deta hai — handover ka apna shabd hai ye.
2. **Ek hi check-in teen baar aaye to ek hi visit banti hai.** Network girta hai, app dobara
   bhejti hai. Do database index isse pakka karte hain, sirf code ki ummeed nahi.
3. **Visit kaisi padhi jaati hai wo calculate hota hai.** Kitni der ruke = do timestamp.
   Report poori hui ya nahi = **aaj ke form** ke hisaab se. Isliye kal ek sawal required banaya
   to aaj ki purani report khud keh degi "ye missing hai".

**Kahan:** `Reach → Field work` — **Field app**, **Visits**, **Calls today**.
Report form `Reach → Customer setup → Visit report fields` aur **Visit report by type**.
Settings `Reach → Customer setup → Visit settings`.

### 1. Pehle ye hona chahiye

| Cheez                   | Kahan                                              |
| ----------------------- | -------------------------------------------------- |
| Customer type ka radius | Customer setup → Customer types                    |
| Rep + uska login        | Field setup → Field reps (`user` bharo)            |
| Beat + uske outlets     | Field setup → Beats, Customers → Customer register |
| Dukaan ka location tag  | Customer register → row par **Tag location**       |
| Aaj ka plan (optional)  | Tour plan → My plan (RCH-3)                        |

Radius **type par** hai, settings par nahi — distributor ka yard aur retailer ka counter ek
doori par nahi hote. Handover ke numbers: DIST 100, RET 75, INST 200 meter.

### 2. Report form banao (har type ka alag)

`Reach → Customer setup → Visit report fields → Create`

| Field key     | Label           | Input  | Section |
| ------------- | --------------- | ------ | ------- |
| `shelf_share` | Shelf share %   | number | Shelf   |
| `competitor`  | Competitor seen | text   | Shelf   |
| `stock_out`   | Stock out today | bool   | Shelf   |

Jaanch: `input = select` chuno aur choices khaali chhodo — **refuse hona chahiye** (bina choices
ka sawal jawab-dene-layak hi nahi).

Phir `Visit report by type`: RET par `shelf_share` = **R**, `competitor` = **O**.
Distributor par kuch mat daalo — uska matlab hai distributor se kuch nahi poocha jayega.

### 3. Field app — phone jaisa frame

`Reach → Field work → Field app`

Ye jaan boojh kar phone ke frame me bana hai: **yahi wo screen hai jiske against mobile app
likhi jayegi.** Ek round, ek stop, bade button.

Screen khulte hi browser location maangta hai.

- **Allow karo** → upar "Located to about N m" dikhega
- **Deny kar do** → bhi theek hai. Check-in tab bhi jayega, bas doori nahi napi jayegi.
  Ye jaan boojh kar hai.

### 4. Milestone ka pehla acceptance — 800 meter door se

Browser me location spoof karo (Chrome DevTools → **Sensors** → Location → custom), dukaan se
~800 meter door ka lat/long daalo, phir **Check in**.

Dekhna chahiye:

- Visit **ban gayi** (reject nahi hui)
- Message: _"Checked in at …, 812 m from the shop. It is recorded and flagged."_
- Stop par doori laal me, `flagged` ke saath

Ab **usi jagah se** distributor par check in karo — uska radius 5000 m hai, to **flag nahi
aayega**. Ek hi doori, do alag jawab, kyunki radius type ka hai.

### 5. Milestone ka doosra acceptance — teen baar check-in, ek visit

Usi dukaan par **Check in** teen baar dabao (ya network throttle karke dobara bhejo).

```bash
docker compose exec -T db psql -U rare_owner -d rare_os -At -c \
  "SELECT count(*) FROM visits v JOIN trade_customers c ON c.id=v.customer_id
   WHERE c.code='<SHOP CODE>'"
```

**Jawab `1` aana chahiye.** Dusri aur teesri baar screen bolega "Already checked in at …".

Ye do index isse pakka karte hain:

| Index                   | Kya rokta hai                            |
| ----------------------- | ---------------------------------------- |
| `visits_open_idx`       | Ek rep + ek dukaan par ek hi khuli visit |
| `visits_client_ref_idx` | Ek reference, ek visit                   |

### 6. Check-out aur report

Stop par **Check out** dabao. Us type ka apna form khulega.

- Required sawal khaali chhod do → **ruk jana chahiye**, aur batana chahiye kaunsa
- Aisi key bhejo jo form me hai hi nahi → **refuse** (warna wo key hamesha ke liye report me
  padi rehti, har screen se invisible)
- Number wale sawal me `abcd` → refuse

Sahi bhar kar check out karo. Agar 5 minute se kam ruke to visit **Short call** dikhegi —
retailer type ka `min_visit_minutes` yahi tay karta hai.

Check out ke baad **Report** button se report sudhaari ja sakti hai. **Visit dobara nahi
khulti** — rep kab nikla wo ho chuka hai, aur wahi rahega.

### 7. "Report poori hui ya nahi" — aaj ke form se

Ek visit check out kar do jiska `competitor` khaali hai (abhi wo optional hai) → **Complete**.

Ab `Visit report by type` me `competitor` ko **R** kar do.

Wapas us visit par jao — ab wo **"missing 1"** dikhayegi. Database me kuch bhi dobara nahi
likha gaya; form badla, jawab wahi raha. Agar ye flag stored hota to purani report jhooth
bolti rehti.

### 8. Din ki visit list

`Reach → Field work → Visits`

Har visit par: kitni der ruke, kitni door se check-in hua, report poori hui ya nahi.
Manager ke liye **Visits CSV** bhi hai (`reach.read` chahiye).

### 9. Calls today — manager ka board

`Reach → Field work → Calls today` — ek din, rep ke hisaab se: kitni calls, kitne minute,
average, kitni flagged, kitni report adhoori.

### 10. RCH-3 ab asli data se bharti hai

Visits aane ke baad `Reach → Tour plan → Plan vs actual` kholo. Ab Followed / Partial /
Deviated asli check-in se nikal rahe hain, test data se nahi. Jo dukaan plan me nahi thi uspar
visit **off plan** gini jayegi — gayab nahi hogi.

### 11. Visit settings

`Reach → Customer setup → Visit settings`

| Setting                | Default | Matlab                                                           |
| ---------------------- | ------- | ---------------------------------------------------------------- |
| Retry window (minutes) | 10      | Itni der tak wahi check-in dobara aaye to wahi visit mani jayegi |

Radius yahan **nahi** hai — wo customer type par hai. Ye jaan boojh kar hai.

Zaroori jaanch: yahan save karne ke baad `Reach settings`, `Attendance settings` aur
`Tour plan settings` teeno khol kar dekho — sab waise ke waise hone chahiye. Chaaron ek hi row
me rehte hain.

### 12. Permissions

| Permission    | Kya milta hai                                   |
| ------------- | ----------------------------------------------- |
| `reach.visit` | Field app, apni Visits, apna check-in/check-out |
| `reach.read`  | Calls today board, kisi bhi rep ki visits, CSV  |
| `reach.setup` | Report form aur Visit settings badalna          |

Sirf `reach.visit` wale login se jaanch: **Calls today** menu me dikhna hi nahi chahiye, CSV ka
link nahi hona chahiye, aur kisi doosre rep ki visits maangne par mana hona chahiye.

### Jo RCH-4 mein nahi hai

- **Mobile app nahi.** Field app web par hai — yahi wo reference hai jiske against app banegi
- Offline queue nahi — browser online hona chahiye (retry window dropped connection ke liye hai)
- Order lena, stock dekhna, collection — wo RCH-5 (Customer 360) aur aage hai
- Shelf photo visit se abhi nahi judti (file upload RCH-0 me hai, visit se link nahi)
- **Khula sawal (milestone plan #12):** radius se bahar check-in — **rokein ya sirf flag karein**?
  Abhi jawab **"flag"** hai, handover ki apni warning ke hisaab se. Client "roko" bole to ye
  controller me chhota badlav hai — par handover khud isse mana karta hai

---

## RCH-5 — Customer 360

Ye wo screen hai jahan dukaan ki poori trading tasveer ek jagah aati hai: kitna udhaar hai,
order ja sakta hai ya nahi, kagaz poore hain ya nahi, is mahine kitna kharida, aur pichhe kya
kya hua.

Char usool yahan **server par** lage hain:

1. **Order credit ke liye kabhi reject nahi hota.** Limit cross kar raha ho ya KYC verified na
   ho — order **liya jata hai aur hold hota hai**, reason record ke saath. Wahi baat jo
   check-in ki thi: salesman ko bina wajah "no" bolna app par bharosa tod deta hai.
2. **Jo jod-ghata hota hai wo kahin store nahi hota.** Outstanding, ageing, hold aur KYC ki
   haalat har request par evidence se padhi jaati hai. Isliye paisa aate hi ya document verify
   hote hi hold apne aap khul jata hai — kuch dhoondh kar badalna nahi padta.
3. **Bill do raaste se aata hai, aur permission hi switch hai.** `reach.invoice` kisi ko nahi
   diya → yahan se invoice ban hi nahi sakti, sab ERP se aayengi. De diya → yahan se bhi ban
   jayegi, apni numbering series se. Koi setting nahi, koi deploy nahi.
4. **Rep wahi hai jo login hai.** Request me bheja hua rep id kabhi nahi padha jata, to koi
   kisi aur ke naam par order ya collection nahi kar sakta.

**Kahan:** `Reach → Trade` — **Customer 360**, **Take order**, **Orders**, **Paperwork**.
Setup `Reach → Customer setup` me — **KYC documents**, **KYC by type**, **Price list**,
**Schemes**, **Customer 360 settings**.

### 1. Pehle ye hona chahiye

| Cheez                           | Kahan                                       |
| ------------------------------- | ------------------------------------------- |
| Item aur uska unit              | Availability → Masters → Items (unit pehle) |
| Customer type par credit terms  | Customer setup → Customer types             |
| KYC documents aur kis type par  | Customer setup → KYC documents, KYC by type |
| Price list (type + item + rate) | Customer setup → Price list                 |
| Scheme (optional)               | Customer setup → Schemes                    |
| Rep + uska login                | Field setup → Field reps (`user` bharo)     |
| Dukaan                          | Customers → Customer register               |

Customer type par ye char naye khaane hain:

| Khana                          | Matlab                                                       |
| ------------------------------ | ------------------------------------------------------------ |
| Credit limit                   | Ek waqt me itna udhaar ho sakta hai                          |
| Credit days                    | Kitne din ki udhaari par bechte hain                         |
| Hold orders after overdue days | Bill itna purana hua to naye order hold. Khaali = kabhi nahi |
| KYC before ordering            | Tick kiya to verified kagaz ke bina order hold hoga          |

**Credit days aur hold days alag cheezein hain.** Credit days wo shart hai jis par becha jata
hai; hold days wo umar hai jis par bechna band hota hai. 30 din ki udhaari aur 45 din par hold
ek saath chalte hain — bill 35 din ka hai to overdue hai par hold nahi.

### 2. Price list aur scheme

`Reach → Customer setup → Price list → Create`

| Khana         | Example      | Note                                                    |
| ------------- | ------------ | ------------------------------------------------------- |
| Customer type | RET          | Rate **type par** hai, dukaan par nahi                  |
| Item code     | CHAIR        |                                                         |
| Rate          | `240.0000`   | **Char decimal** — bulk list 0.3333/piece bhi bolti hai |
| GST %         | `18.00`      |                                                         |
| From          | aaj ya pehle | Jo list sabse baad me khuli, wahi chalti hai            |

`Schemes` me: CHAIR par `From quantity` 50, `Discount %` 5, `Free units` 2.

Jaanch: ek scheme banao jisme **na discount na free units** — refuse hona chahiye. Jo scheme
kuch deti hi nahi wo kisi ki galti hai.

### 3. Milestone ka acceptance — hold, reject nahi

`Reach → Trade → Take order` → dukaan dhoondo → **Open**.

Price list dikhegi. CHAIR ke saamne **50** likho → **Price it**.

Dekho:

- Line par `Discount` 5% aur `Free` 2 aa gaya — scheme khud lagi
- `Taxable` 11,400 (12,000 me se 5% gaya), `Total` 13,452 (18% GST)
- **Do free chair billed nahi hain** — di gayi hain
- Upar laal patti: **"On hold: KYC is not verified."**

Ab **Place the order** dabao. Order **ban jayega** aur `HELD` dikhega, message hoga
"Order … taken and held." Order gaya nahi — reject nahi hua.

### 4. Kagaz verify karo, aur hold apne aap khul jaye

`Reach → Trade → Customer 360` → wahi dukaan → **Upload a document**.

- GST chuno, number me `NOTAGSTIN` daalo → **refuse** hoga (wahi GSTIN rule jo customer form me hai)
- Sahi GSTIN daalo (`06AABCU9603R1ZM`) → upload ho jayega, status **Waiting**

Ab Customer 360 refresh karo: KYC `Waiting` hai, hold abhi bhi **KYC** par hai.
**Upload karna verify karna nahi hai** — ye jaan boojh kar alag hai.

`Reach → Trade → Paperwork` → row par **Decide**:

- `Rejected` chuno aur reason khaali chhodo → refuse hoga (rejection ko wajah batani hi padti hai)
- `Verified` chuno → save

**Ab asli jaanch.** Customer 360 wapas kholo:

- KYC **Verified**
- Patti ab hari: **"Clear to place."**
- **Purana held order abhi bhi HELD hai** — kuch peeche jaa kar badla nahi gaya

Naya order lo (3 TABLE) → **PLACED** aayega, 7,080 ka. Yahi milestone ka acceptance hai: hold
evidence se padha ja raha tha, store nahi tha.

### 5. Limit cross karna

30 TABLE ka order lo (70,800) jab limit 50,000 hai → **HELD**, reason **OVER_LIMIT**.

`Reach → Trade → Orders` → order **Open** karo:

- `reach.credit` wale login par **Release** button dikhega, baaki par nahi
- Release par **reason zaroori** hai — ye kisi ki li hui decision hai aur uske naam par likhi jayegi
- Release ke baad status `PLACED` aur "Released because: …" dikhega
- Jo hold par nahi hai usse release karne par mana hoga

### 6. Bill — dono raaste

**A. Yahan se banao** (sirf `reach.invoice` ho to)

Orders → PLACED order Open → **Raise invoice**. Prefix `INV` default hai.

Number aisa aayega: `INV/2026/0001` — prefix / financial year / counter.

- Usi order ka dobara bill banane par mana hoga
- Held ya cancelled order ka bill nahi banta

**B. Bahar se aaya bill record karo**

Customer 360 → **Record a bill**. Number wahi jo us document par hai, source `From the ERP`.

- Wahi number dobara → mana
- Agar lines bheji hain to unka jod bill ke total se match hona chahiye, warna mana

**Number wapas nahi milta.** Raise kiya hua bill cancel karo → message aayega "Its number stays
used." Ab agla bill banao → `INV/2026/0002` aayega, `0001` **nahi**. GST me "no gaps" ka matlab
yahi hai.

### 7. Collection

Customer 360 → **Collect**.

| Jaanch                               | Hona kya chahiye              |
| ------------------------------------ | ----------------------------- |
| Cheque/NEFT/UPI bina reference       | Mana — bank line se jodna hai |
| Mode `BARTER` jaisa kuch             | Mana                          |
| Received on = kal ki date            | Mana — paisa kal nahi aata    |
| Cash 5,000 ek bill ke saamne         | Wo bill `Part paid`           |
| 2,000 bina bill chune ("On account") | **Sabse purana bill pehle**   |

Har collection ke baad message khud bata deta hai kitna abhi bhi baaki hai — rep ko bharosa
nahi karna padta.

**Receipt cancel karo** → paisa phir se owed ho jata hai, outstanding wapas upar.

### 8. Customer 360 par kya kya padho

| Hissa        | Kya dekhna                                                           |
| ------------ | -------------------------------------------------------------------- |
| Tiles        | Outstanding, Left to sell, Oldest bill days, DSO, is mahine ki sale  |
| Credit       | Limit kahan se aayi — **This shop** ya **Its type**                  |
| Paperwork    | Har document: manga gaya tha ya nahi, number, kisne decide kiya      |
| Money owed   | Ageing buckets, har bill ki umar, "Raised here" ya "ERP"             |
| Collections  | Har receipt, kis bill ke saamne, kis rep ne                          |
| What it buys | Is mahina vs pichla, growth, saal, top items                         |
| History      | Visit, order, bill, collection, document, location — ek hi dhaage me |

**Change terms** (sirf `reach.setup`): koi khana **khaali chhodo** to wo sawal customer type ko
wapas chala jata hai. **Khaali aur zero alag hain** — zero ka matlab zero.

### 9. Customer 360 settings

`Reach → Customer setup → Customer 360 settings`

| Setting                        | Default  | Matlab                                              |
| ------------------------------ | -------- | --------------------------------------------------- |
| Ageing buckets                 | 30,60,90 | 0-30, 31-60, 61-90, 91+ — har agla bada ho          |
| Financial year starts in month | 4        | April. Invoice series isi ke saath restart hoti hai |
| DSO window in days             | 90       | Itne din ki sale ke against DSO napa jata hai       |

Jaanch: buckets `60,30` likho → mana hona chahiye (warna ek bill do bucket me gir jata).
Save ke baad baaki teen Reach settings screens khol kar dekho — sab waise ke waise.

### 10. Permissions

| Permission      | Kya milta hai                                            |
| --------------- | -------------------------------------------------------- |
| `reach.order`   | Take order, apne liye gaye orders                        |
| `reach.collect` | Collection record karna aur apna receipt cancel karna    |
| `reach.kyc`     | Document upload aur verify/reject                        |
| `reach.credit`  | Hold hua order release karna                             |
| `reach.invoice` | **Yahan se bill banana, aur bahar ka bill record karna** |
| `reach.read`    | Customer 360, Paperwork queue, sabke orders              |
| `reach.setup`   | Terms, price list, KYC rules, settings                   |

Sirf `reach.order` + `reach.collect` wale login se jaanch:

- Menu me **Customer 360** aur **Paperwork** dikhna hi nahi chahiye
- Orders me sirf apne order dikhein, doosre rep ka maangne par mana ho
- **Raise invoice** aur **Record a bill** dono par mana ho
- Release par mana ho

### Jo RCH-5 mein nahi hai

- **Ye GST ka legal tax invoice nahi hai.** Abhi ye numbered record hai. Legal ke liye chahiye:
  seller GSTIN per place of business, place of supply, HSN, CGST/SGST/IGST ka alag-alag split,
  aur turnover limit se upar e-invoice (IRN). Migration ke header me ye saaf likha hai —
  **client se poochna hai**. Design badalna nahi padega, column jodne padenge
- Payment gateway nahi — collection ka record hai, paisa lena nahi
- Credit note / return nahi — bill cancel hota hai, credit note nahi banta
- Stock dikhana nahi — order price se banta hai, availability se nahi
- Order ERP ko bhejne ka asli connection nahi — "Send to ERP" status aur reference rakhta hai,
  message bhejta nahi

---

## RCH-6 — Expenses (TA / DA)

Ye milestone ek hi line par khada hai, aur wo line milestone plan ki apni hai: **"nayi version
hamesha aaj ke baad se shuru ho, taaki approved amount kabhi na hile."** Isko poori tarah
seriously liya gaya hai, aur baaki sab usi se nikalta hai.

Char usool:

1. **Policy version aane wale kal se hi shuru ho sakti hai, aur shuru hote hi freeze ho jati
   hai.** Jo version aaj se chal rahi hai usme ek bhi number badla to jo amount kisi ne approve
   kar diya wo hil jayega.
2. **Isi wajah se amount kahin store nahi hota.** Claim sirf wo rakhta hai jo rep ne kaha —
   date, km, raatein, town, kitna maang raha hai. Policy uska kya banati hai wo har baar nikala
   jata hai. `expense_claims` me `amount` ya `approved_amount` jaisa koi column hai hi nahi.
3. **Attendance aur Tour Plan ka faisla chalta hai, claim ka nahi.** Jis din register kehta hai
   rep kaam par nahi tha, us din DA zero. Aur town **plan se** aata hai — warna HQ par bitaya
   din door ke town ka bata kar zyada DA liya ja sakta tha.
4. **Limit se upar cap hota hai, reject nahi.** Line dono number rakhti hai: kitna maanga aur
   kitna milega. Sirf aakhri number dikhana wo tareeka hai jisse rep total se jhagadne lagta hai.

**Kahan:** `Reach → Expenses` — **My expenses**, **Expense claims**, **Expense register**.
Setup `Reach → Customer setup` me — **Expense categories** aur **Expense policy**.

### 1. Pehle ye hona chahiye

| Cheez                      | Kahan                                                    |
| -------------------------- | -------------------------------------------------------- |
| Rep ka headquarters town   | Field setup → Field reps → `Headquarters town`           |
| Rep ka grade               | Field setup → Rep grades (lodging ka rate grade par hai) |
| Kya kya claim ho sakta hai | Customer setup → Expense categories                      |
| Rates                      | Customer setup → Expense policy → New version            |
| Rep ka login               | Field setup → Field reps (`user` bharo)                  |

**Headquarters town khaali chhoda to har din "out of headquarters" padhega.** Guess nahi hota.

### 2. Categories banao

`Reach → Customer setup → Expense categories → Create`

| Code    | Worked out from | Matlab                                              |
| ------- | --------------- | --------------------------------------------------- |
| `KM`    | KM              | km × vehicle ka rate                                |
| `DA`    | DAILY           | ek din ka allowance, is hisaab se ki din kahan bita |
| `STAY`  | NIGHTLY         | raatein × rep ke grade ka rate                      |
| `PHONE` | ACTUAL          | jo sach me kharch hua, cap tak                      |

`Receipt needed above` me 200 daalo STAY aur PHONE par.

### 3. Policy version banao — aur dekho ki aaj se nahi ban sakti

`Reach → Customer setup → Expense policy → New version`

- `Starts on` me **aaj ki date** daal kar dekho → **refuse hona chahiye**. Message saaf batayega
  kyun: aaj se shuru hui version aaj ke claims par pehle se lagu hai
- Kal ki date daalo → ban jayegi, aur `Starts later · can be changed` dikhega
- Usme rates bharo (client ke apne numbers):

| Category | Key               | Rate | Limit per line | Limit per claim |
| -------- | ----------------- | ---- | -------------- | --------------- |
| KM       | `BIKE`            | 3.5  |                |                 |
| KM       | `CAR`             | 9    |                |                 |
| DA       | `HQ`              | 250  |                |                 |
| DA       | `EX_HQ`           | 400  |                |                 |
| DA       | `OUTSTATION`      | 600  |                |                 |
| STAY     | rep ka grade code | 2500 | 2500           |                 |
| PHONE    | _(khaali)_        |      | 500            | 500             |

**Key wahi cheez hai jis par rate nirbhar hai** — vehicle, din kahan bita, ya rep ka grade.

Jaanch: na rate na limit wali row daalo → **refuse**. Jo row kuch kehti hi nahi wo galti hai.

### 4. Jo version chal rahi hai wo chhui nahi ja sakti

Jab koi version aaj se pehle shuru ho chuki ho, use kholo:

- `In force · frozen` dikhega
- Rate ka box edit karne ka option hi nahi milega
- API se zabardasti bhejoge to **409** aur message: naya version banao

Yahi wo rule hai jiski wajah se amount har baar dobara nikalna surakshit hai.

Naya version banate waqt `Start from the rates of` me purani version chuno — saare rates copy ho
jate hain. Ek rate badalne ke liye barah dobara type karne ki zaroorat nahi.

### 5. Milestone ka acceptance — leave wale din ka DA zero

Rep ke login se `Reach → Expenses → My expenses`.

Teen din chahiye: ek jis din rep kaam par tha aur plan ne **Hisar** bheja, ek jis din **approved
leave** hai, ek jis din kaam par tha par plan ne **Rohtak** (HQ) rakha.

| Line                                                       | Kya milna chahiye                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| DA, Hisar wala din                                         | **400** (Ex-HQ)                                                          |
| DA, leave wala din                                         | **0**, aur wajah: _"the register says the rep was not at work that day"_ |
| DA, Rohtak wala din — par town me "Hisar" type karke dekho | **250** (HQ)                                                             |

Teesra sabse zaroori hai: **rep ne Hisar likha phir bhi HQ ka rate mila**, kyunki plan us din
Rohtak kehta hai. Agar rep ka likha hua chalta, to HQ par bitaya din door ka bata kar zyada DA
liya ja sakta tha.

### 6. Milestone ka acceptance — cap, reject nahi

STAY line daalo: 2 raatein, 6000 maango.

- `Asked` 6000, `Allowed` 2500
- Wajah: _"the policy caps this"_
- **Line gayi nahi** — dono number saath me dikhte hain

PHONE ki do line daalo, 300 aur 300, jab claim ka cap 500 hai:

- Pehli 300, doosri **200**, aur wajah _"the policy caps this over the whole claim"_
- Cap **baad wale kharch** par lagta hai, kisi random line par nahi

### 7. Receipt rokta hai, zero nahi karta

PHONE 320 ka daalo bina receipt ke (limit 200 hai):

- `Allowed` **320 hi rahega** — paisa sach me kharch hua hai
- Par wajah me _"a receipt is needed above the policy limit"_
- **Claim bhej hi nahi paoge** — submit par mana hoga

Receipt lagao ya amount 200 se neeche karo → claim chala jayega. Kharcha kagaz ke peeche chhupaya
nahi jata; bas claim tab tak nahi jata.

### 8. Line hatana

Draft me kisi line par **Take off** → reason maangega. Line claim se hat jayegi par **uski row
rehti hai**, reason ke saath. "Claim kiya phir wapas liya" wahi cheez hai jo baad me koi poochta
hai.

### 9. Milestone ka acceptance — ek aadmi dono jagah nahi

Rep claim bhejta hai → `With the manager`.

1. Finance wale login se pehle hi approve karne ki koshish → **mana**, _"A manager has to pass
   this claim before finance sees it"_
2. Manager (maan lo admin) pass karta hai → `With finance`
3. **Wahi admin ab finance ban kar approve kare** → **mana**: _"You passed this claim as its
   manager, so somebody else has to approve it"_
4. Doosre login se approve → `Approved`

Teen jagah ye rule laga hai — engine, controller aur **table ka apna CHECK**. Teeno isliye ki
yahi wo rule hai jisko koi na koi kabhi bypass karna chahega.

Sending back par **reason zaroori** hai. Rep ko pata hona chahiye kya theek karna hai. Wapas aayi
claim ko rep `Open it again to correct it` se kholta hai.

### 10. Register aur payout

`Reach → Expenses → Expense register`

- Har claim ek row: kitna maanga, kitna milega, kitna nahi mila
- **Payout CSV** sirf wahi deta hai jo finance ne approve kiya
- CSV aur screen **ek hi hisaab** se bante hain, to dono kabhi alag nahi bol sakte

### 11. Expense settings

`Reach → Customer setup → Expense policy` ke neeche:

| Setting                 | Default   | Matlab                                                      |
| ----------------------- | --------- | ----------------------------------------------------------- |
| Claims cover            | Fortnight | 1–15, phir baaki mahina                                     |
| Days to send a claim in | 15        | Period khatam hone ke baad kitne din. 0 = koi deadline nahi |

### 12. Permissions

| Permission              | Kya milta hai                        |
| ----------------------- | ------------------------------------ |
| `reach.expense`         | Apni claim banana aur bhejna         |
| `reach.expense_approve` | Manager ban kar pass karna           |
| `reach.expense_finance` | Finance ban kar approve/reject karna |
| `reach.setup`           | Categories, policy, settings         |
| `reach.read`            | Register aur sabki claims            |

Sirf `reach.expense` wale login se: **Expense register** aur **Expense claims** menu me dikhne hi
nahi chahiye, aur doosre rep ki claims maangne par mana hona chahiye.

### Jo RCH-6 mein nahi hai

- **Paisa yahan se nahi jata.** Approve hona record hota hai aur payout file banti hai; transfer
  nahi hota
- Advance / imprest nahi — sirf kharch ke baad ka claim
- **Line save karne se _pehle_ preview nahi hai**, aur ye jaan boojh kar hai. Plan kehta hai
  result pehle dikhe; seedha tareeka hota browser me hisaab karna, par DA is par nirbhar hai ki
  us din register kya kehta hai aur plan ne kis town bheja — browser ko dono nahi pata. Jo number
  zyadatar sahi ho wo bina number se bura hai. To line add hote hi **server** jawab deta hai, aur
  line claim jaane tak badli ya hataai ja sakti hai
- Week-off ya holiday par kaam karke DA — abhi nahi milega. RCH-2 week-off ko punch se pehle hi
  tay kar deta hai, to aisa din `WEEK_OFF` hi padhta hai. Ye RCH-2 ki shakal hai, yahan ka faisla
  nahi — **client se poochhne layak**

---

## RCH-7 — Reach dashboard, alerts aur live cutover

**Is milestone me ek bhi nayi table nahi hai.** Ye koi bachat nahi — yahi iska design hai.

Milestone ka apna acceptance do line hai: _"Har tile ka number neeche ki asli activity se mile"_
aur _"koi bhi proposal bina approval ke kuch na badle."_ Dono tab apne aap sach ho jate hain jab
overview kahin store hi na ho:

- Tile aur uske neeche ki list **ek hi query se, ek hi request me** nikalte hain. Alag ho hi nahi
  sakte
- Proposal ek **padhai** hai aur us screen ka naam jahan insaan faisla karta hai. Is module me
  **ek bhi route aisa nahi hai jo kuch likhta ho** — `reach-overview.controller.ts` me ek bhi
  `@Post` nahi, aur `reach-overview-db.mjs` me ek bhi INSERT/UPDATE/DELETE nahi. Proposal act
  kar hi nahi sakta

**Kahan:** `Reach → Overview` — **Overview**, **Waiting for a decision**, **Going live**,
**Reach audit trail**.

### 1. Overview

`Reach → Overview → Overview`

Upar aaj ke tiles: kitne rep ne din shuru kiya (kitno me se), kitne abhi tak band nahi hue, kitne
call hue, kitne abhi dukaan ke andar hain, kitne order, kitne ka order, kitna collect hua, aur
kitna faisle ka intezaar me hai.

Neeche teen hisse — **Waiting for a decision**, **Worth acting on**, **Worth a look**.

System chaudah cheezein dekhta hai:

| Kya                         | Kab                                                  |
| --------------------------- | ---------------------------------------------------- |
| Din shuru nahi hua          | Shift khatam hue company ki tay der se zyada ho gayi |
| Leave / correction waiting  | Koi faisla nahi hua                                  |
| Plan late                   | Agle mahine ka plan due day tak nahi aaya            |
| Plan / day change waiting   | Approval chahiye                                     |
| Check-in flag               | Dukaan se door se hua                                |
| Report adhoori              | Type ke required sawal chhoote                       |
| Customer / location waiting | Approval chahiye                                     |
| KYC waiting                 | Document check hona hai                              |
| Order hold                  | Credit ya KYC ne roka                                |
| Shop overdue                | Bill uske terms se purana                            |
| Expense claim waiting       | Kisi desk par ruki hai                               |

**Jo cheez zero hai wo dikhti hi nahi.** System chup rehta hai, "sab theek hai" nahi bolta.

**Aur jis screen ko aap khol hi nahi sakte, uska proposal aapko dikhta hi nahi.** Sirf `reach.read`
wale login se dekho — leave ka count dikhega par use _decide karne ko_ nahi kaha jayega.

### 2. Acceptance 1 — tile aur list ka number ek

Ek leave request pending banao aur ek customer approval me daalo. Phir:

- Overview par `Waiting for a decision` ka number badhega
- `Reach → Attendance → Leave` (status Pending) me **utni hi** rows hongi
- `Reach → Customers → Approvals` me **utne hi** accounts honge

Queue ka total hamesha uske apne rows ka jod hota hai — ye code ki ek line hai, bharosa nahi.

### 3. Acceptance 2 — proposal kuch badalta nahi

Kisi bhi proposal par sirf ek hi button hai: **Go there**. Wo aapko us screen par le jata hai
jahan faisla hota hai. Koi "approve from here", koi "dismiss", kuch nahi.

Jaanch: overview kholo, refresh karo, phir leave request ka status DB me dekho — `PENDING` hi
rahega. Spec isse aur aage le jata hai: har tarah ki POST/PUT/PATCH/DELETE request in raaston par
bhejta hai aur sab **404** aati hain, kyunki wo route hain hi nahi.

### 4. Waiting for a decision — ek hi queue

`Reach → Overview → Waiting for a decision`

Pehle har module ki apni queue thi — leave alag, approvals alag, KYC alag, held orders alag,
claims alag. Ab sab ek jagah, aur sirf wahi jo aap decide kar sakte hain.

### 5. Going live

`Reach → Overview → Going live`

Saat line, har ek **data se padhi gayi**, kisi ke tick karne se nahi:

| Line                               | Blocking? |
| ---------------------------------- | --------- |
| Reps hain aur unke login jude hain | Haan      |
| Customers load ho gaye             | Haan      |
| Rounds bane aur unme outlets hain  | Haan      |
| Shops tag ho gaye                  | Haan      |
| Shift set hai                      | Haan      |
| Price list chal rahi hai           | Nahi      |
| Expense policy chal rahi hai       | Nahi      |

Client ka apna data usi **file import** se aata hai jo baaki har master use karta hai — column
map karo, jo pehle se hai usse milao, phir commit. To live jaane ka matlab hai aakhri data load
karna aur in line ko badalte dekhna.

### 6. Reach audit trail

`Reach → Overview → Reach audit trail` (ismein `audit.read` chahiye, `reach.read` kaafi nahi)

Ye **doosra trail nahi** hai — wahi ek audit record hai jo poora system rakhta hai, bas Reach ke
aakar se dekha gaya. Isliye "kya hua" ka jawab hamesha ek hi rehta hai.

### Jo RCH-7 mein nahi hai

- Email ya push alert nahi — proposal screen par hai, bheja nahi jata
- Proposal ko "dekha" mark karne ka tareeka nahi: wo apne aap band ho jata hai jab wajah khatam
  hoti hai. Ye jaan boojh kar hai — "dekh liya" wala flag ek store ki hui cheez hai jo sach se
  alag ho jati hai
- Trend ya graph nahi — aaj ka haal hai, itihaas nahi
- RCH-8 (mobile app) abhi bacha hai

---

## RCH-8 — Field app (phone par, bina network ke)

Milestone plan ka apna acceptance ek hi line hai:

> _"Airplane mode mein poora beat complete karo — check-in, order, photo. App band karo, kholo,
> kharab network par jodo — sab kuch exactly ek baar pahunche."_

Poora milestone isi ek line ke liye bana hai. Neeche usi ko haath se karne ka tarika hai.

**Kya hai:** **Expo / React Native app**, jaisa handover ka `04_TECH_STACK.md` aur milestone
plan dono maangte hain. Browser ka page nahi — phone me install hone wali app.

### Phone par kaise chadhegi

Abhi store par nahi jaati. **Expo Go** se chalti hai, jo development ka tareeka hai:

1. Phone me Play Store/App Store se **Expo Go** install karo
2. Phone aur Mac **ek hi Wi-Fi** par hon
3. Mac ka us Wi-Fi par pata nikalo: `ipconfig getifaddr en0`
4. Repo ki jad me:

```sh
npm run mobile:install
EXPO_PUBLIC_API_URL=http://<Mac-ka-pata>:4000 npm run mobile:start
```

5. Terminal me QR code aayega → Expo Go se scan karo

> `localhost` **mat** likhna. Phone par `localhost` ka matlab khud phone hai, aapka Mac nahi.
> Pata galat hua to app sign-in par ruk jaayegi — aur yahi sahi vyavhaar hai, chup-chaap kuch
> aur server se baat karne se behtar.

LIVE par dekhna ho to `EXPO_PUBLIC_API_URL` chhod do; app `https://rare.greymetre.io` se baat
karti hai.

### 0. Pehli baar — ek baar signal me

1. Expo Go me app khulo
2. **Sign in** dabao → phone ka browser khulega Keycloak ke apne page par, apne address bar ke
   saath → rep ka email aur password
3. Wapas aate hi rep ka naam, aaj ki date aur **aaj ka round** dikhega

> Yahan app me koi username/password ka khana nahi hai, aur ye jaan boojh kar hai: app ke andar
> ka login form wo form hai jo dikha nahi sakta ki password kahan ja raha hai.

Yahan ek baat dhyan se dekho: **poora din ek hi request me aata hai.** Round, dukaanein, un
dukaanon ke aaj ke rate, visit form ke sawal, aur har dukaan par kitna bakaya hai — sab. Weak
line par aath request matlab aath jagah aadha din reh jaane ka mauka; isliye ek.

> Agar yahan `This login is not linked to a field rep` aaye, to us user ko kisi field rep se joda
> nahi gaya hai. Masters → Field reps → us rep ka user set karo.

### 1. Airplane mode — poora beat

Ab **phone ko airplane mode par daal do.** Wi-Fi bhi band. (Expo Go se chal rahi ho to app
pehle se load ho chuki hai, to airplane mode usse nahi rokta — bas Metro se reload mat karna.)

1. **Start day** → kaam ka type chuno → dabao
2. Upar ka patti turant kahegi **"1 item waiting to send"**
3. **Beat** tab → pehli dukaan par tap karo
4. **Check in** dabao → camera khulega, shelf ka photo lo (camera mana karne par bhi check-in
   ho jaata hai — photo marzi ki cheez hai, call nahi)
5. **Take the order** → `+` / `−` se units badhao. Neeche lines aur total dikhega
6. **Collect payment** → amount aur tarika → **Save the collection**
7. **Check out** → form bharo → **Check out**
8. Agli dukaan par wahi

**Yahan ek bhi jagah ghumta hua circle nahi dikhega.** Har tap turant ho jaata hai — phone par
likha gaya, ho gaya, line me laga diya. Jo app kharab signal me ghoomta rehta hai, woh salesman
ko app chhodna sikha deta hai.

Patti par tap karke dekho: har cheez apne naam se list me hai, sab **waiting**.

### 2. App band karo, kholo — abhi bhi airplane mode me

App ko poora band karo (recent apps se hata do), phir se kholo.

**Sab kuch waisa hi hona chahiye** — utne hi item, utne hi waiting, 0 sent. Kuch bhi memory me
nahi hai; sab phone ke **SQLite** me likha gaya hai, ek transaction me. Handover ki apni baat
yahi thi: _"offline-first with a local SQLite and an outbox sync"_.

Aur ye bhi dekho: app poori khulti hai aur aaj ka round dikhta hai, jo signal me utara gaya tha.

> **Bakaya kabhi cache se nahi aata.** Jo number dikh raha hai wo us waqt ka hai jab phone ne
> aakhri baar network dekha tha, aur screen par wahi likha hai. Agar app purana bakaya naye jaisa
> dikhati, to rep galat number par paisa maangta — isliye din ka data sirf wahan hai jahan app ne
> khud rakha hai aur jiski umar usko pata hai.

### 3. Signal wapas — sab kuch ek baar

Airplane mode band karo.

App khud bhej dega — phone batata hai ki network aa gaya. Ya **Me** tab ya kataar se
**Send now** dabao.

Patti **"Everything is in"** par aani chahiye, aur kataar me har cheez **In** par.

> **Send now** jaan boojh kar intezaar ka niyam tod deta hai. Poora din bina signal ke beeta ho
> to har item kai nakaam koshishon ke baad minaton ka intezaar le kar baitha hota hai; rep ke tap
> ka matlab hai "abhi bhejo", aur button ka kuch na karna dikhna sabse bura jawab hai.

Ab desk wale app me jaakar milan karo:

| Kahan                             | Kya dikhna chahiye                             |
| --------------------------------- | ---------------------------------------------- |
| `Reach → Attendance → Register`   | Us rep ka aaj ka din, ek hi baar               |
| `Reach → Visits → Visits`         | Har dukaan ka ek visit, check-out ke saath     |
| `Reach → Trade → Orders`          | Har order ek baar, **aur usme visit juda hua** |
| `Reach → Customer 360 → Receipts` | Collection ek baar                             |

**Us order me visit ka jud jaana sabse badi baat hai.** Jab rep ne order liya tha, us visit ka
server par koi naam hi nahi tha — sirf phone ka apna local naam. Queue ne pehle check-in bheja,
server se asli id li, aur phir order me local naam ki jagah asli id daal kar bheja.

### 4. "Exactly once" — ise jaan boojh kar todne ki koshish karo

Ye sabse zaroori test hai, kyunki poori retry strategy isi par tiki hai.

Sabse aasan tarika: **order lete waqt beech me hi airplane mode on kar do.** Phone ko pata hi
nahi chalega ki server ne order liya ya nahi. Woh dobara bhejega.

`Reach → Trade → Orders` me **ek hi order hona chahiye.**

Wajah: har aisi cheez jiska dobara bhejna sach me do record bana sakta hai, uske saath phone ka
apna reference jaata hai, jo retry par badalta nahi. Server us reference ko pehchaan kar wahi
purana record wapas kar deta hai.

| Kya             | Reference jaata hai? | Kyun                                                                                  |
| --------------- | -------------------- | ------------------------------------------------------------------------------------- |
| Order           | **Haan**             | Ek hi counter par do bilkul same order lena aam baat hai                              |
| Collection      | **Haan**             | Same amount do baar aana aam hai — aur dukaan ko do baar credit dena sabse buri galti |
| Photo           | **Haan**             | Bytes pehle se ek baar store hote the, par row dobara ban jati thi                    |
| Check-in        | **Haan**             | RCH-4 me pehle se tha                                                                 |
| Day start / end | **Nahi**             | Ek rep, ek din — server khud `ALREADY_STARTED` keh deta hai                           |
| Check-out       | **Nahi**             | Ek rep ki ek dukaan par ek hi khuli visit                                             |

Jahan reference ki zarurat nahi, wahan bheja bhi nahi jaata. Write routes unknown field reject
karte hain, to galti se bhejne par rep ki poori subah ek 400 ke peeche atak jaati.

### 5. Jab sach me kuch galat ho

Kuch aisa karo jo server pakka mana karega — jaise aisi dukaan par order jo delete ho chuki ho.

- Woh item **red** ho jayega aur patti kahegi **"1 item needs your attention"**
- Queue screen par uska naam aur **wajah saaf shabdon me** likhi hogi
- Jo cheezein usi par tiki thi (jaise us visit ka check-out) woh bhi ruk jayengi, aur batayengi
  ki kis cheez ka intezaar kar rahi hain

**Jo cheez dobara bhejne se theek nahi hoti, woh dobara bheji hi nahi jaati.** 400 ka matlab hai
server ne padha, samjha aur mana kiya. Hazaar baar bhejne se kuch nahi badlega — isliye ruk jaata
hai aur rep ko bata diya jaata hai.

Par **ek ruki hui cheez baaki din ko nahi rokti**: agar order price ki wajah se ruka hai, to
check-out phir bhi chala jayega.

### 6. Admin ke liye — "mera din gaya hi nahi"

Jab koi rep ye kahe, to `Reach → Overview` ke saath ab ye bhi hai: har phone ne aakhri baar kab
server se baat ki, aur us waqt uske paas kitna pada tha.

API: `GET /api/reach/device/seen`

Isme rep ka kaam nahi hota — sirf ginti. Kab, kaun sa phone, kitna waiting, kitna blocked.

### 7. Seedhe HTTP se dekhna ho to

```bash
# Phone ko sirf itna pata hona chahiye ki sign in kahan karna hai
curl -s https://rare.greymetre.io/api/mobile/config
# {"authUrl":"...","clientId":"rare-os-mobile","realm":"rare-os"}
# Isme koi secret nahi hai, aur ho bhi nahi sakta — ye public client hai

# Bina sahi token ke kuch nahi
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer nonsense" \
  https://rare.greymetre.io/api/reach/device/day
# 401
```

### Kya dhyan rakhna hai

**Phone ka login desk ke login se alag hai.** Keycloak me iska apna client hai —
`rare-os-mobile`, public, PKCE ke saath, bina kisi secret ke. App ke andar rakha hua secret
secret nahi hota.

**Jisko MFA chahiye, woh phone se andar nahi aa sakta.** Phone beech request me OTP nahi maang
sakta, aur chupke se check chhod dena matlab mobile app ko MFA se bachne ka rasta bana dena. Aise
account web se chalenge, aur app saaf shabdon me yahi kahega. Field rep par ye kabhi lagta nahi —
MFA sirf administrators par hai.

**Phone sign out karne par rep ka bina bheja kaam nahi mitta.** Woh kaam rep ka hai, session ka
nahi.

**Rep ko sign out karna ho to** Access → Users se — wahi revocation record phone par bhi lagta
hai jo browser par lagta hai, aur phone paanch minute ke andar band ho jata hai.

**Refresh token phone ke keystore me hai** — iOS keychain, Android ka EncryptedSharedPreferences.
Browser wale version me ye majboori thi ki wo IndexedDB me rahe, jahan page ka koi bhi script
usse padh sakta tha. Asli app hone ka ek thos faida yahi hai, aur isi wajah se itna lamba
chalne wala token yahan jaayaz hai.

**Store par abhi nahi hai.** Expo Go se chalti hai. Play Store / App Store par daalne ke liye
Apple aur Google ke developer account chahiye aur ek build service — wo apna kaam hai, is
milestone me nahi. Internal APK bhi ek raasta hai; bataiye to wo kar denge.
