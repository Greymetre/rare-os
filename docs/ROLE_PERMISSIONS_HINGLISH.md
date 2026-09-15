# Roles aur permissions — 15 September 2026

Roles & permissions → Create role / Edit se module-wise access choose karein. RARE OS ke existing colors aur cards use hote hain; mobile par cards ek column mein aate hain.

| Module    | View                           | Manage                                                 |
| --------- | ------------------------------ | ------------------------------------------------------ |
| Dashboard | Workspace overview; required   | Nahi                                                   |
| Users     | Company users ki listing       | User create/edit, role assignment, invitation/reset    |
| Roles     | Roles aur permissions dekhna   | Custom role create/edit/delete                         |
| Plants    | Assigned active plants dekhna  | Plants create/edit aur company ke sab plants ka access |
| Audit log | Company administrative history | Nahi                                                   |

Manage ek combined permission hai; create/edit/delete ke separate switches is delivery mein nahi hain. Sirf implemented actions ko describe kiya gaya hai. Plant assignment ke liye Users Manage aur Plants Manage dono chahiye. Security settings user ki personal authenticator settings hain. Platform company creation/open access separate platform grant se controlled hai; company role se platform admin nahi ban sakta.

## Aapka use case

- User ko roles ka koi access nahi dena: Roles View aur Manage dono off; Users Manage bhi off rahega kyunki existing role select karne ke liye Roles View required hai.
- User create karne dena, permissions edit nahi karne dena: Users Manage on, Roles View automatically on, Roles Manage off.
- Doosre custom roles manage karne dena: Roles Manage on. User apne assigned role ko edit nahi kar sakta; another authorised administrator karega. Main Admin role protected hai.
- Plant-limited user: Plants View on, Plants Manage off, phir Users → Plant access se assignments karein.

Required view permissions manage select karte waqt automatically select hoti hain. View remove karne par dependent manage bhi remove hota hai. Dashboard required rehta hai. Search aur visible View selection available hain. Future module permissions separate toggle ke andar hain; existing selections preserve hote hain aur label clearly batata hai ki module abhi implemented nahi hai.

## Enforcement aur verification

Backend every request par current permissions verify karta hai. Roles read absent hone par listing/catalog deny hote hain; Roles Manage absent hone par mutations deny hote hain. Apne assigned role ka update backend reject karta hai, including uppercase UUID URLs. Apne user ka role/status change existing self-access protection se blocked hai. Users apne rights se zyada rights kisi role/user ko assign nahi kar sakte.

Permission codes aur existing role grants same hain. Seeder labels/module names refresh karta hai; existing accounts aur passwords reset nahi hote. Live server par deploy ke baad fresh page load karein.
