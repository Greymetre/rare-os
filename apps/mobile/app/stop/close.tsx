// RCH-8: checking out, with the report the company asks for at this kind of shop.
//
// The questions came down with the day, per customer type. The answers go up as an **object
// keyed by field** — `{ shelf_share: '20' }` — because that is the shape `validateAnswers`
// reads. A list of `{field_key, value}` pairs is refused field by field and the rep never learns
// why, which is how this was wrong the first time it was built.
//
// The phone does not validate. It marks required questions, and it will not let the rep check
// out with one empty, because that refusal is cheap here and expensive at six in the evening.
// Everything else is the server's judgement.

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { checkOut as checkOutPayload } from '../../../../packages/engines/field-payloads.mjs';
import { whereAmI } from '../../src/device';
import { useField, type FormField } from '../../src/state';
import { colour, space } from '../../src/theme';
import { Big, Body, Card, Choice, Field, Heading, Screen, Soft, Title } from '../../src/ui';

export default function ClosePad() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { day, push, flush, openVisitFor } = useField();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const stop = day?.stops.find((s) => s.customer_id === id);
  if (!day || !stop)
    return (
      <Screen>
        <Title>Check out</Title>
        <Card>
          <Body>This shop is not on today's round.</Body>
        </Card>
      </Screen>
    );

  const visit = openVisitFor(stop.customer_id);
  if (!visit)
    return (
      <Screen>
        <Title>{stop.name}</Title>
        <Card>
          <Body>There is no open call at this shop to check out of.</Body>
        </Card>
      </Screen>
    );

  const form: FormField[] = day.forms[stop.type_id] ?? [];
  const missing = form.filter((f) => f.required && !String(answers[f.field_key] ?? '').trim());

  const set = (key: string, value: string) => setAnswers((was) => ({ ...was, [key]: value }));

  const save = async () => {
    if (missing.length) return;
    setBusy(true);
    try {
      const fix = await whereAmI();
      // Only answered questions are sent. An empty optional answer is not an answer, and the
      // route is asked for nothing it did not ask about.
      const given = Object.fromEntries(
        Object.entries(answers).filter(([, v]) => String(v).trim() !== ''),
      );
      await push(
        'visit.checkout',
        checkOutPayload({ visitId: visit.id, version: visit.version, answers: given, fix }),
        'Check-out at ' + stop.name,
      );
      void flush();
      router.dismissTo('/(tabs)/beat');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Title>{stop.name}</Title>
      <Soft>
        {form.length
          ? `${form.length} question${form.length === 1 ? '' : 's'} for a ${stop.type_name}`
          : `No report is asked for at a ${stop.type_name}`}
      </Soft>

      {form.length ? (
        <Card style={{ gap: space.lg }}>
          {form.map((f) =>
            f.input === 'select' && f.choices.length ? (
              <Choice
                key={f.field_key}
                label={f.label + (f.required ? ' *' : '')}
                options={f.choices.map((c) => ({ id: c, name: c }))}
                value={answers[f.field_key] ?? null}
                onChange={(v) => set(f.field_key, v)}
              />
            ) : (
              <Field
                key={f.field_key}
                testID={'answer-' + f.field_key}
                label={f.label + (f.required ? ' *' : '')}
                value={answers[f.field_key] ?? ''}
                onChange={(v) => set(f.field_key, v)}
                keyboard={f.input === 'number' || f.input === 'integer' ? 'numeric' : 'default'}
                placeholder={f.help || undefined}
              />
            ),
          )}
        </Card>
      ) : null}

      {missing.length ? (
        <Card style={{ borderColor: colour.waiting }}>
          <Heading>Still to answer</Heading>
          {missing.map((f) => (
            <Soft key={f.field_key}>{f.label}</Soft>
          ))}
        </Card>
      ) : null}

      <Big
        label={busy ? 'Checking out…' : 'Check out'}
        onPress={() => void save()}
        disabled={busy || missing.length > 0}
        testID="check-out"
      />
    </Screen>
  );
}
