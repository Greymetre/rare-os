# Point 1 — Admin email aur invitations (local review)

Company Contact email aur admin login email alag hain. Contact edit se login ownership ya invitation recipient change nahi hota.

## Kya change hua

- Companies → Admin setup mein invitation recipient explicit hai.
- Correct admin email option sirf unused login ke liye: email verify, password/credential setup ya first company login hone ke baad API correction reject karti hai.
- Corrected email existing identity ko overwrite nahi karta. Existing account chahiye to platform se company open karke Users mein intended admin assign karein.
- Correction se old identity ka is company se link hat jata hai; dusri companies ke memberships/passwords unchanged. Old identity delete nahi hoti. Uske old invitation se corrected membership ka access nahi milta.
- Save ke baad invitation automatically nahi jati. Recipient review karke Send invitation click karein.
- Send fail hone par error aur audit status save; successful-send timestamp sirf success par. SMTP accepted ka matlab real inbox delivery confirmed nahi hai.
- Repeated send par 60-second cooldown. Completed onboarding par invitation API bhi reject; password recovery ke liye Forgot password.
- Latest delivery lookup ke liye migration 008 mein scoped partial index.

## Aap local par kaise test karein

1. http://localhost:4310 par Platform Admin login karein; Companies → Create company.
2. Unique test company code rakhein, Contact email `contact@example.test`, Admin email `typo-review@example.test` rakhein. Agar address pehle use kiya hai to naya unique address lein.
3. Abhi invitation open karke account activate na karein. Company Edit mein Contact email badlein; Admin setup mein recipient abhi bhi original admin email hona chahiye.
4. Admin setup → Correct admin email mein `correct-review@example.test` ka naya unused address save karein. Recipient update ho; invitation not sent status ho.
5. Send invitation click karein. http://localhost:4312 par corrected address wali mail kholein. Purani typo-address mail historical hai; new mail ka To check karein.
6. Turant dubara Send invitation karne par one-minute wait message aaye.
7. Corrected invitation incognito mein open karein, password set karein aur corrected email se login karein. Company khulni chahiye.
8. Platform Admin se Admin setup dobara kholein: Onboarding complete, first login time, invitation action hidden. Activated login email silently change nahi ho sakta.

Local mail sirf Mailpit mein hai. Real Microsoft 365 mailbox delivery aur VPS configuration ka verification live deployment ke samay baaki hai. Is point ke changes Git push/live deploy nahi hue. Point 2 user ke Next instruction ke baad.

## Existing email ko dusri company mein test karein

1. Platform Admin se ek nayi test company banayein. Admin email mein pehle se working account ka exact email dein.
2. Save par Existing login linked message aaye; Admin setup mein existing password, separate role/plant access aur global password reset ka explanation aaye.
3. Existing user ki nayi browser session mein purane password se login karein. Company chooser mein dono assigned companies dikhni chahiye.
4. Company select karke header ka naam aur Users/Plants check karein. Switch company karke dusri company ke apne records dikhne chahiye.
5. Platform Admin se company Open company → Users ke through same email ko company-specific role de sakte hain. Normal company admin ko dusri company ke accounts discover/link karne ka platform access nahi milta.
6. Same company mein same email dobara create karne par duplicate reject hona chahiye.

Nayi membership dekhne ke liye sign out aur fresh sign-in required hai. Same login ke password/MFA global hain; company roles, plant assignments aur membership activation separate hain. Same-looking typo email ko automatically merge nahi kiya jata.
