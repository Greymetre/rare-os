# Role permissions — action-wise local delivery

Role create/edit screen mein module/action matrix hai: View, Create, Edit, Delete aur Other actions. Module-wise aur column-wise selection, partial-selection indicator, search aur selected count available hain. RARE OS design retained hai. Future module permissions explicit toggle ke peeche hain.

## Current modules

| Module    | Available actions                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------ |
| Dashboard | View (workspace entry ke liye required)                                                                                  |
| Roles     | View, Create, Edit, Delete                                                                                               |
| Users     | View, Create, Edit; status change, role assignment, invitation, password reset, setup retry, plant assignment separately |
| Plants    | View, Create, Edit; status change aur all-company-plant visibility separately                                            |
| Audit log | View                                                                                                                     |

Users aur Plants ke permanent-delete endpoints nahi hain; unke Delete cells dash hain. Inactive karna status permission se hota hai. Company/platform management separate Platform Admin grant se controlled hai; company role usko grant nahi kar sakta. Security screen apne account ke liye hai, company-wide account administration nahi.

## Rules

- Roles Create se existing role Edit/Delete nahi milta. Roles Edit se Create/Delete nahi milta.
- Apna assigned role editable nahi; protected Main Admin role aur assigned-role deletion safeguards remain.
- Users Create mein initial existing role choose karna included hai; sirf actor ke own grants ke andar role assign ho sakta hai.
- Users Create ke saath Send invitations nahi diya to account save/provision hota hai, email automatically nahi bheji jati. UI message tells an authorised user to send it.
- Users Edit se name/pending-email edit ho sakta hai. Existing role change ke liye Change a user role; activate/deactivate ke liye separate status action required hai. Dono Edit par depend karte hain.
- View dependencies automatically select hoti hain. Required View remove karne par dependent actions bhi remove hote hain. Backend missing dependencies reject karta hai.
- Users Create/Edit ko Roles View chahiye for role selection/display; Roles View role editing allow nahi karta.
- User plant assignment ko Users View, Roles View, Plants View aur Access all company plants chahiye. Existing grant-limit check prevents managing a user whose role exceeds actor permissions.
- Plants Edit assigned plants par hi apply hota hai. All-plant visibility separate permission hai. Limited creator ko apne newly-created plant ka explicit assignment milta hai.
- Password reset shared login ke liye global impact rakhta hai; existing shared-login reset safeguards remain.
- Main Admin has all current catalog permissions; runtime direct API requests par same action checks karta hai.

## Existing roles

Migration 009 old Users/Roles/Plants Manage grants ko equivalent action grants mein convert karti hai. Plant-assignment grant sirf un roles ko milta hai jinke paas pehle Users Manage aur Plants Manage dono the. Role versions increase so an old edit form cannot overwrite new grants. Combined legacy codes retire ho gaye hain; future masters.manage unchanged hai (module not started).

Total catalog: 35 permissions; 20 implemented access actions and 15 reserved future actions. Seeder repeat-safe hai. Breaking access-code change ke karan migration 009 ke baad old application image ko blindly rollback na karein; compatibility review required hai.

## Aap kaise verify karein

1. Local admin login → Roles & permissions → Create role. Search, row checkbox aur column checkbox try karein. Mobile par table horizontal scroll hoti hai; Save/Cancel accessible hain.
2. Test role mein sirf Roles Create select karein. Roles View aur Dashboard auto-selected rahenge. Save karke test user ko yeh role assign karein.
3. Test user fresh login kare: Create role button available ho, existing roles Edit/Delete controls na hon.
4. Main Admin se test role ko Roles Edit only karein. User screen refresh kare: Create/Delete hidden; allowed custom role Edit available; own assigned role View only.
5. Users Edit role mein role/status actions unselected rakhein: Edit user mein Assign role aur Account status disabled hon. Invitation/reset/plant-access actions unselected hone par hidden hon.
6. Plants View/Edit without all-plant visibility assign karein; user ko selected plant grant karein. Sirf assigned plant dikhna/edit hona chahiye; status permission ke bina Status disabled rahe.

Automated source: tests/action-permissions.spec.ts (direct API denials, migration and UI), tests/access-management.spec.ts, tests/permission-selection.test.mjs. Disposable regression accounts are cleaned; existing real accounts are preserved. No Git push/live deployment in this point-3 local delivery.
