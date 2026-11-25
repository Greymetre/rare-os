// RCH-8: collecting money.
//
// A collection records no visit. `trade_receipts` has no column for one and the route refuses
// fields it does not read, so sending a visit here would block every collection a rep took. It
// still goes up after the check-in, because the queue sends in the order the rep did things.
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { receipt as receiptPayload } from '../../../../packages/engines/field-payloads.mjs';
import { whereAmI } from '../../src/device';
import { useField } from '../../src/state';
import { colour } from '../../src/theme';
import { Big, Body, Card, Choice, Field, Heading, Screen, Soft, Title } from '../../src/ui';

const MODES = [
  { id: 'CASH', name: 'Cash' },
  { id: 'UPI', name: 'UPI' },
  { id: 'CHEQUE', name: 'Cheque' },
  { id: 'NEFT', name: 'Bank transfer' },
];

export default function CollectPad() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { day, push, flush } = useField();
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<string | null>('CASH');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);

  const stop = day?.stops.find((s) => s.customer_id === id);
  if (!day || !stop)
    return (
      <Screen>
        <Title>Collect</Title>
        <Card>
          <Body>This shop is not on today's round.</Body>
        </Card>
      </Screen>
    );

  const owed = day.outstanding[stop.customer_id] ?? 0;
  const value = Number(amount.replace(/[^0-9.]/g, ''));
  const ok = value > 0 && Boolean(mode);

  const save = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      const fix = await whereAmI();
      await push(
        'receipt.collect',
        receiptPayload({
          customerId: stop.customer_id,
          amount: value,
          mode: mode!,
          reference,
          fix,
        }),
        `₹${value.toLocaleString('en-IN')} from ${stop.name}`,
      );
      void flush();
      router.back();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Title>{stop.name}</Title>
      {owed > 0 ? (
        <Card style={{ borderColor: colour.waiting }}>
          <Heading>{'₹' + owed.toLocaleString('en-IN') + ' owing'}</Heading>
          <Soft>As it stood when this phone last had a network.</Soft>
        </Card>
      ) : null}

      <Card>
        <Field
          label="Amount"
          value={amount}
          onChange={setAmount}
          keyboard="decimal-pad"
          placeholder="0"
          testID="amount"
        />
        <Choice label="How" options={MODES} value={mode} onChange={setMode} />
        {mode && mode !== 'CASH' ? (
          <Field
            label={mode === 'CHEQUE' ? 'Cheque number' : 'Reference'}
            value={reference}
            onChange={setReference}
            testID="reference"
          />
        ) : null}
      </Card>

      <Big
        label={busy ? 'Saving…' : 'Save the collection'}
        onPress={() => void save()}
        disabled={!ok || busy}
        testID="save-receipt"
      />
      <Soft>The receipt is numbered by the server when this arrives.</Soft>
    </Screen>
  );
}
