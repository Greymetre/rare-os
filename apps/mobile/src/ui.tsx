// RCH-8: the handful of pieces every screen is built from.
//
// Deliberately small. A field app used one-handed in a market needs big targets, high contrast
// and no cleverness; a component library would be a liability here, not a help.

import { Pressable, ScrollView, Text, TextInput, View, type ViewStyle } from 'react-native';
import { colour, space, text, TOUCH } from './theme';
import { useField } from './state';

// The bar across the top: the only place in the app that ever mentions the network. It says what
// is still on the phone, never what went wrong with a request.
export function QueueBar() {
  const { items, outcome } = useField();
  const queued = items.filter((i) => i.state === 'QUEUED').length;
  const blocked = items.filter((i) => i.state === 'BLOCKED').length;

  const [tone, line] =
    blocked > 0
      ? [colour.stopped, `${blocked} stopped — open the queue`]
      : outcome?.needsSignIn
        ? [colour.stopped, 'Sign in again to send your work']
        : queued > 0
          ? [
              colour.waiting,
              outcome?.offline ? `${queued} waiting for a network` : `${queued} sending`,
            ]
          : [colour.good, 'Everything is in'];

  return (
    <View
      testID="queue-headline"
      accessibilityLabel={line}
      style={{
        backgroundColor: tone,
        paddingVertical: space.sm,
        paddingHorizontal: space.lg,
      }}
    >
      <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>{line}</Text>
    </View>
  );
}

export function Screen({
  children,
  scroll = true,
}: {
  children: React.ReactNode;
  scroll?: boolean;
}) {
  const body = (
    <View style={{ padding: space.lg, gap: space.md, paddingBottom: space.xl * 2 }}>
      {children}
    </View>
  );
  return (
    <View style={{ flex: 1, backgroundColor: colour.paper }}>
      <QueueBar />
      {scroll ? <ScrollView>{body}</ScrollView> : body}
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return (
    <View
      style={[
        {
          backgroundColor: colour.card,
          borderRadius: 10,
          padding: space.lg,
          gap: space.sm,
          borderWidth: 1,
          borderColor: colour.line,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Title({ children }: { children: React.ReactNode }) {
  return <Text style={text.title}>{children}</Text>;
}

export function Heading({ children }: { children: React.ReactNode }) {
  return <Text style={text.heading}>{children}</Text>;
}

export function Body({ children }: { children: React.ReactNode }) {
  return <Text style={text.body}>{children}</Text>;
}

export function Soft({ children, testID }: { children: React.ReactNode; testID?: string }) {
  return (
    <Text testID={testID} style={text.soft}>
      {children}
    </Text>
  );
}

export function Big({
  label,
  onPress,
  tone = 'action',
  disabled = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  tone?: 'action' | 'quiet';
  disabled?: boolean;
  testID?: string;
}) {
  const quiet = tone === 'quiet';
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: TOUCH + 6,
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: 10,
        paddingHorizontal: space.lg,
        backgroundColor: quiet ? colour.card : colour.action,
        borderWidth: quiet ? 1 : 0,
        borderColor: colour.line,
        opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
      })}
    >
      <Text
        style={{
          color: quiet ? colour.ink : colour.actionText,
          fontSize: 17,
          fontWeight: '700',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// A row that is itself the target, because a line of text in a list is what a rep will aim at.
export function Row({
  title,
  note,
  right,
  onPress,
  testID,
}: {
  title: string;
  note?: string;
  right?: string;
  onPress?: () => void;
  testID?: string;
}) {
  const inner = (
    <View
      style={{
        minHeight: TOUCH,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: space.md,
        paddingVertical: space.sm,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={text.body}>{title}</Text>
        {note ? <Text style={text.tiny}>{note}</Text> : null}
      </View>
      {right ? <Text style={text.soft}>{right}</Text> : null}
    </View>
  );
  if (!onPress) return inner;
  return (
    <Pressable testID={testID} accessibilityRole="button" onPress={onPress}>
      {inner}
    </Pressable>
  );
}

export function Field({
  label,
  value,
  onChange,
  keyboard = 'default',
  placeholder,
  testID,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  keyboard?: 'default' | 'numeric' | 'decimal-pad';
  placeholder?: string;
  testID?: string;
}) {
  return (
    <View style={{ gap: space.xs }}>
      <Text style={text.soft}>{label}</Text>
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        keyboardType={keyboard}
        style={{
          minHeight: TOUCH,
          borderWidth: 1,
          borderColor: colour.line,
          borderRadius: 8,
          paddingHorizontal: space.md,
          fontSize: 17,
          backgroundColor: colour.card,
          color: colour.ink,
        }}
      />
    </View>
  );
}

// A row of choices, used where a dropdown would be wrong: a rep picking a work type or a payment
// mode should see the options, not go looking for them.
export function Choice({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: string; name: string }[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <View style={{ gap: space.sm }}>
      <Text style={text.soft}>{label}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {options.map((o) => {
          const on = o.id === value;
          return (
            <Pressable
              key={o.id}
              accessibilityRole="button"
              onPress={() => onChange(o.id)}
              style={{
                minHeight: TOUCH,
                justifyContent: 'center',
                paddingHorizontal: space.lg,
                borderRadius: 999,
                borderWidth: on ? 0 : 1,
                borderColor: colour.line,
                backgroundColor: on ? colour.header : colour.card,
              }}
            >
              <Text style={{ fontSize: 16, color: on ? '#fff' : colour.ink, fontWeight: '600' }}>
                {o.name}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function Money({ value }: { value: number }) {
  return <Text style={text.body}>{'₹' + value.toLocaleString('en-IN')}</Text>;
}
