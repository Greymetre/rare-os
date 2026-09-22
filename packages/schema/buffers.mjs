// Field rules for buffer profiles and per-plant buffer settings (AV-4). Pure: forms and CSV share them.
import { validateFields } from './masters.mjs';

const pct = (name, label, extra) => ({ name, label, type: 'decimal', decimals: 2, ...extra });

export const BUFFER_PROFILE_FIELDS = [
  { name: 'code', label: 'Profile code', type: 'code', required: true, immutable: true },
  { name: 'name', label: 'Name', type: 'text', required: true, max: 120 },
  pct('red_base_pct', 'Red base % of yellow', { required: true, positive: true, maxValue: 200 }),
  pct('red_safety_pct', 'Red safety % (variability)', { maxValue: 200, default: '0' }),
  pct('green_pct', 'Green % of yellow', { required: true, positive: true, maxValue: 300 }),
  { name: 'order_cycle_days', label: 'Order cycle (days)', type: 'int', min: 1, max: 365 },
  pct('spike_threshold_pct', 'Spike threshold % of red', {
    positive: true,
    maxValue: 500,
    default: '50',
  }),
  {
    name: 'adu_window_days',
    label: 'ADU window (days)',
    type: 'int',
    min: 7,
    max: 365,
  },
  // WEEKLY is the Nilkamal method: zones from recent weeks and safety from demand variability.
  {
    name: 'method',
    label: 'Zone method',
    type: 'enum',
    options: ['STANDARD', 'WEEKLY'],
    default: 'STANDARD',
  },
  { name: 'zone_weeks', label: 'Zone weeks (weekly method)', type: 'int', min: 1, max: 104 },
  { name: 'cv_weeks', label: 'Variability weeks (weekly method)', type: 'int', min: 4, max: 104 },
  {
    name: 'order_multiple',
    label: 'Order multiple for made items',
    type: 'decimal',
    decimals: 6,
    positive: true,
  },
  {
    name: 'moq_adu_days',
    label: 'Minimum order in days of ADU',
    type: 'decimal',
    decimals: 3,
    positive: true,
    maxValue: 365,
  },
];

export const BUFFER_SETTING_FIELDS = [
  {
    name: 'plant',
    label: 'Plant code',
    type: 'ref',
    ref: 'sites',
    required: true,
    immutable: true,
  },
  { name: 'item', label: 'Item code', type: 'ref', ref: 'items', required: true, immutable: true },
  { name: 'policy', label: 'Policy', type: 'enum', options: ['BUFFER', 'MTO'], default: 'BUFFER' },
  { name: 'profile', label: 'Buffer profile code', type: 'ref', ref: 'buffer_profiles' },
  { name: 'lead_time_days', label: 'Lead time (days)', type: 'int', min: 0, max: 365 },
  { name: 'adu_override', label: 'ADU override', type: 'decimal', decimals: 6, positive: true },
  // Made items: the order size behind the dynamic lead time (blank = 1.5 days of usage).
  { name: 'reference_lot', label: 'Reference lot', type: 'decimal', decimals: 6, positive: true },
];

export function validateBufferProfile(raw) {
  const r = validateFields(BUFFER_PROFILE_FIELDS, raw);
  if (r.value.adu_window_days === null || r.value.adu_window_days === undefined)
    r.value.adu_window_days = 90;
  r.value.zone_weeks ??= 13;
  r.value.cv_weeks ??= 52;
  if (r.value.moq_adu_days && !r.value.order_multiple)
    r.errors.push({
      column: 'moq_adu_days',
      message: 'Set an order multiple too: the minimum order is rounded to it.',
    });
  return r;
}

export function validateBufferSetting(raw) {
  const r = validateFields(BUFFER_SETTING_FIELDS, raw);
  if (
    r.value.policy === 'BUFFER' &&
    !r.value.profile &&
    !r.errors.some((e) => e.column === 'profile')
  )
    r.errors.push({ column: 'profile', message: 'Choose a buffer profile for a buffered item.' });
  if (r.value.policy === 'MTO') r.value.profile = null;
  return r;
}
