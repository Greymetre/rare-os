import type { MasterField } from './masters.mjs';
type Result = { value: any; errors: { column: string; message: string }[] };
export const BUFFER_PROFILE_FIELDS: MasterField[];
export const BUFFER_SETTING_FIELDS: MasterField[];
export function validateBufferProfile(raw: any): Result;
export function validateBufferSetting(raw: any): Result;
