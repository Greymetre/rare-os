# Password reset aur authenticator management

## Password reset

MFA enabled account par fresh reset email kholne ke baad do choices hain:

- **Keep my authenticators:** apna device select karein, uska current code dein, phir password change karein. Existing devices unchanged rahenge.
- **Replace the selected authenticator:** lost/changed phone ke liye device select karein aur warning confirm karein. New QR scan karke valid code submit hone par selected old entry remove hogi. Dusre authenticators active rahenge. Naya code reject hone ya setup incomplete rehne par old entry remove nahi hoti.

Replacement reset email ke proof se authorize hota hai; old device ka code is recovery route mein required nahi hai. Fresh email link use karein. Existing MFA ke bina password form milta hai; administrator ko workspace entry se pehle mandatory authenticator setup bhi complete karna hoga.

## Login ke baad Security

- **Add authenticator:** ek aur named device add karein. Purane devices active rehte hain.
- **Remove a device:** fresh sign-in verification aur confirmation ke baad selected entry remove hoti hai. Normal users last device ke liye Turn off MFA use kar sakte hain; admins ko kam se kam ek authenticator rakhna hoga.
- **Turn off MFA (non-admin only):** fresh sign-in verification aur explicit confirmation ke baad saare authenticator devices aur recovery codes remove hote hain. Agla login password se hota hai. Other signed-in sessions revoke hote hain.

Ye settings email/login account ki hain: agar same login multiple companies mein hai to change sab par apply hota hai. Company permissions unchanged rehti hain.

## Manual local test

1. `http://localhost:4310` par test account se login karein. Security se do devices different names ke saath add karein.
2. Sign out, Forgot Password request karein. Local email `http://localhost:4312` par milega. Keep choose karke current device OTP aur naya password dein; login par dono devices rehne chahiye.
3. Fresh reset email mangayein. Replace choose karein, warning confirm karein, new QR scan karein. Ek wrong code se old device remove nahi hona chahiye. Correct code ke baad selected old entry replace aur doosri entry retain honi chahiye.
4. Security se Remove a device try karein. Confirmation ke bina removal nahi hona chahiye. Ek device remove karein; last remaining device ke removal par Turn off MFA ka message aana chahiye.
5. Turn off MFA confirm karein. Sign out/in par OTP prompt nahi aana chahiye. Security se authenticator dobara add ho sakta hai.
6. Company admin ka Users → Reset password email bhi Keep/Replace choice dikhana chahiye. Shared login ke liye existing policy Forgot Password route batati hai.

## Deployment note

Ye change custom Keycloak image require karta hai. Compose ko `--build` ke saath run karein; sirf web/API rebuild kaafi nahi hai. Existing production override ka merged Keycloak image/command check karein. Old reset emails already issued with UPDATE_PASSWORD use their original action; test ke liye fresh reset email mangayein.

Latest local verification complete: 13 browser tests aur 15 unit tests passed; 1 optional demo test intentionally skipped. Database isolation aur backup restore checks bhi passed. Live deployment/push alag authorization ke baad hoga.

## Point 2: compulsory administrator MFA

Platform admins, active company Main Admins aur users/roles manage karne wale delegated admins ke liye MFA compulsory hai. Kisi ek active company mein admin access ho to requirement poore login par apply hoti hai. Normal read-only/non-admin users ka optional MFA/off flow available hai.

- Existing authenticator/password preserve rehte hain. Missing authenticator ke liye next login par setup required hota hai.
- Admin ka Turn off MFA link hidden hai; forged direct disable request bhi reject hoti hai. Last authenticator remove nahi ho sakta. Add aur selected-device replacement allowed hain.
- Password-only session ko admin grant milne par next protected API request reject hoti hai; fresh sign-in/enrollment required hai. Authentication proof signed identity token se aata hai, browser input se nahi.
- Security mein recovery codes generate aur privately save karein. Login par **Try another way → Recovery Authentication Code** select karein aur screen par requested number ka code enter karein. Used code dobara accept nahi hota.

### Aap local test kaise karein

1. `http://localhost:4310` par admin se sign in karein. MFA absent ho to QR setup complete hone se pehle dashboard nahi khulega; pehle se configured ho to existing OTP use karein.
2. Security par compulsory MFA message dikhega; Turn off MFA option nahi dikhega. Last device remove karne par explanatory error aayega.
3. Generate recovery codes open karein, fresh verification complete karke codes save karein. Sign out karke password ke baad Try another way se requested recovery code use karein: login hona chahiye.
4. Phir sign out/in karke same recovery code enter karein: reject hona chahiye. Agla requested unused code ya authenticator OTP use kar sakte hain.
5. Non-admin role (users/roles management rights ke bina) se Security check karein: optional MFA aur verified Turn off flow available rahega.

Full automated regression ke liye `npm run test:regression` chalayein. Runner separate disposable Docker stack aur private MFA fixtures banata hai; normal local accounts untouched rehte hain. Direct browser tests real stack par blocked hain. Full commands aur coverage: [Regression testing guide](REGRESSION_TESTING_HINGLISH.md).
