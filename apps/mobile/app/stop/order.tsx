// RCH-8: taking the order. The one screen in the client's prototype that holds state, and the
// one a rep uses most.
//
// Prices came down with the day, for the types of shop on this round only. A line is a count of
// selling units — `units`, which is what the basket reader names them — and the total shown here
// is the phone's arithmetic for the rep's benefit. The server works out its own; nothing here is
// sent as a total.
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { order as orderPayload } from '../../../../packages/engines/field-payloads.mjs';
import { useField } from '../../src/state';
import { colour, space, text, TOUCH } from '../../src/theme';
import { Big, Body, Card, Heading, Screen, Soft, Title } from '../../src/ui';

export default function OrderPad() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { day, push, flush, openVisitFor } = useField();
  const [units, setUnits] = useState<Record<string, number>>({});

  const stop = day?.stops.find((s) => s.customer_id === id);
  if (!day || !stop)
    return (
      <Screen>
        <Title>Order</Title>
        <Card>
          <Body>This shop is not on today's round.</Body>
        </Card>
      </Screen>
    );

  const list = day.prices.filter((p) => p.type_id === stop.type_id);
  const lines = Object.entries(units)
    .filter(([, n]) => n > 0)
    .map(([item_id, n]) => ({ item_id, units: n }));
  const total = lines.reduce((sum, l) => {
    const price = list.find((p) => p.item_id === l.item_id);
    return sum + (price ? price.rate * l.units : 0);
  }, 0);

  const step = (itemId: string, by: number) =>
    setUnits((was) => ({ ...was, [itemId]: Math.max(0, (was[itemId] ?? 0) + by) }));

  const save = async () => {
    if (!lines.length) return;
    const visit = openVisitFor(stop.customer_id);
    await push(
      'order.place',
      orderPayload({ customerId: stop.customer_id, visitId: visit?.id ?? null, lines }),
      'Order at ' + stop.name,
    );
    void flush();
    router.back();
  };

  if (!list.length)
    return (
      <Screen>
        <Title>{stop.name}</Title>
        <Card>
          <Body>No price list reached this phone for a {stop.type_name}.</Body>
          <Soft>A price list has to be active for this type of shop on today's date.</Soft>
        </Card>
      </Screen>
    );

  return (
    <Screen>
      <Title>{stop.name}</Title>
      <Soft>
        {list.length} items priced for a {stop.type_name}
      </Soft>

      <Card>
        {list.map((p) => (
          <View
            key={p.item_id}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.md,
              paddingVertical: space.sm,
              borderBottomWidth: 1,
              borderBottomColor: colour.line,
            }}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={text.body}>{p.item_name}</Text>
              <Text style={text.tiny}>
                {p.item} · ₹{p.rate.toLocaleString('en-IN')}
                {p.unit ? ' / ' + p.unit : ''}
              </Text>
            </View>
            <Stepper
              value={units[p.item_id] ?? 0}
              onStep={(by) => step(p.item_id, by)}
              code={p.item}
            />
          </View>
        ))}
      </Card>

      <Card>
        <Heading>
          {lines.length
            ? `${lines.length} lines · ₹${total.toLocaleString('en-IN')}`
            : 'Nothing added yet'}
        </Heading>
        <Soft>The shop's own total comes from the server when this order arrives.</Soft>
      </Card>

      <Big
        label="Save the order"
        onPress={() => void save()}
        disabled={!lines.length}
        testID="save-order"
      />
    </Screen>
  );
}

function Stepper({
  value,
  onStep,
  code,
}: {
  value: number;
  onStep: (by: number) => void;
  code: string;
}) {
  const button = (label: string, by: number, testID: string) => (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={() => onStep(by)}
      style={{
        width: TOUCH,
        height: TOUCH,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colour.paper,
        borderWidth: 1,
        borderColor: colour.line,
      }}
    >
      <Text style={{ fontSize: 22, fontWeight: '700', color: colour.ink }}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      {button('−', -1, 'less-' + code)}
      <Text
        testID={'units-' + code}
        style={{ minWidth: 28, textAlign: 'center', fontSize: 18, fontWeight: '700' }}
      >
        {value}
      </Text>
      {button('+', 1, 'more-' + code)}
    </View>
  );
}
