export type FormRow = {
  field_key: string;
  name: string;
  input: string;
  section: string;
  options?: string;
  help?: string;
  default_value?: string;
  label_override?: string;
  requirement: string;
  display_order?: number;
};
export type FormField = {
  field_key: string;
  label: string;
  section: string;
  order: number;
  input: string;
  help: string;
  required: boolean;
  choices: string[];
  descriptor: Record<string, unknown>;
};
export function choicesOf(field: { options?: string }): string[];
export function customerForm(rows: FormRow[]): FormField[];
export function formSections(form: FormField[]): { section: string; fields: FormField[] }[];
