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
];

export function validateBufferProfile(raw) {
  const r = validateFields(BUFFER_PROFILE_FIELDS, raw);
  if (r.value.adu_window_days === null || r.value.adu_window_days === undefined)
    r.value.adu_window_days = 90;
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
