// RCH-1: the questions a customer of a given type is asked, and the shape each answer must take.
//
// A company decides its own questions, so the form is data: a list of fields, and a rule per type
// saying whether that field is required (R), optional (O) or not asked at all (X). This turns that
// data into the field descriptors the shared validators already understand, so an answer typed on
// a screen and an answer read from a spreadsheet are judged by exactly the same rule.
// Pure: no database, no HTTP.

// How each kind of question is checked. The right-hand side is a field descriptor of the kind
// packages/schema/masters.mjs validates.
const SHAPES = {
  text: () => ({ type: 'text', max: 200 }),
  textarea: () => ({ type: 'text', max: 1000 }),
  number: () => ({ type: 'decimal', decimals: 4 }),
  select: (field) => ({ type: 'enum', options: choicesOf(field) }),
  date: () => ({ type: 'date' }),
  phone: () => ({ type: 'phone' }),
  email: () => ({ type: 'email' }),
  gstin: () => ({ type: 'gstin' }),
  pan: () => ({ type: 'pan' }),
  bool: () => ({ type: 'bool' }),
};

const truthy = ['true', 'yes', 'y', '1'];

export function choicesOf(field) {
  return String(field.options ?? '')
    .split('|')
    .map((choice) => choice.trim())
    .filter(Boolean);
}

// The default answer, in the shape that kind of question's parser expects. A blank default means
// there is none; a choice that is no longer on the list is treated as none.
function defaultOf(field) {
  const given = String(field.default_value ?? '').trim();
  if (!given) return field.input === 'bool' ? false : undefined;
  if (field.input === 'bool') return truthy.includes(given.toLowerCase());
  if (field.input === 'select') {
    const match = choicesOf(field).find((c) => c.toLowerCase() === given.toLowerCase());
    return match ?? undefined;
  }
  if (field.input === 'date') return undefined;
  return given;
}

// The fields a type asks for, in the order the form shows them: by section, then by the order the
// company gave, then by key so two fields with the same order never swap places between reads.
// rows: customer_form_fields joined to this type's customer_form_rules, with `requirement`.
export function customerForm(rows) {
  return rows
    .filter((field) => field.requirement === 'R' || field.requirement === 'O')
    .map((field) => {
      const shape = (SHAPES[field.input] ?? SHAPES.text)(field);
      const label = String(field.label_override || field.name || field.field_key).trim();
      const fallback = defaultOf(field);
      return {
        field_key: field.field_key,
        label,
        section: field.section || 'Details',
        // The order the company gave this question within its section.
        order: Number(field.display_order ?? 0),
        input: field.input,
        help: field.help ?? '',
        required: field.requirement === 'R',
        choices: field.input === 'select' ? choicesOf(field) : [],
        // What a validator needs: the same descriptor shape the planning masters use.
        descriptor: {
          name: field.field_key,
          label,
          required: field.requirement === 'R',
          ...shape,
          ...(fallback === undefined ? {} : { default: fallback }),
        },
      };
    })
    .sort(
      (a, b) =>
        a.section.localeCompare(b.section) ||
        a.order - b.order ||
        a.field_key.localeCompare(b.field_key),
    );
}

// The sections of a form, each with its own fields, for a screen that draws them in groups.
export function formSections(form) {
  const sections = [];
  for (const field of form) {
    const last = sections[sections.length - 1];
    if (last && last.section === field.section) last.fields.push(field);
    else sections.push({ section: field.section, fields: [field] });
  }
  return sections;
}
