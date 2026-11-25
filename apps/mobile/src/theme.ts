// RCH-8: the look, taken from the client's own mobile designs rather than invented here.
//
// `02_Mobile_App_Prototype/MOBILE_README.md` in the 27-Oct handover states it exactly: indigo
// header `#20264a`, paper background `#f2f1ec`, white cards, action orange `#b8571c`
// (their note says darkened for contrast), and **44 px minimum touch targets**. The 73 design
// screens are drawn in these colours, so a rep who saw the designs recognises the app.
//
// The sizes below are not decoration. This is used one-handed, outdoors, in sunlight, often in a
// hurry, sometimes by someone whose reading glasses are in the van. Nothing here is smaller than
// 15 px and nothing tappable is smaller than 44.

export const colour = {
  header: '#20264a',
  headerText: '#ffffff',
  paper: '#f2f1ec',
  card: '#ffffff',
  action: '#b8571c',
  actionText: '#ffffff',
  ink: '#1b1b1b',
  inkSoft: '#5a5a5a',
  line: '#dcdad2',
  // The four levers carry their own colours through the whole product; Reach is this one.
  reach: '#1f6f5c',
  good: '#1f6f5c',
  waiting: '#8a6d1f',
  stopped: '#9b2c2c',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };

export const TOUCH = 44;

export const text = {
  title: { fontSize: 22, fontWeight: '700' as const, color: colour.ink },
  heading: { fontSize: 18, fontWeight: '700' as const, color: colour.ink },
  body: { fontSize: 16, color: colour.ink },
  soft: { fontSize: 15, color: colour.inkSoft },
  tiny: { fontSize: 13, color: colour.inkSoft },
};
