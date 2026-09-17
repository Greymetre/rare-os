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
