// RCH-8: the queue, which is the one screen that explains this app to the rep who has to trust
// it.
//
// It answers three questions and nothing else: what is still here, what has gone, and what has
// stopped and why. "Why" is in words, taken from what the server actually said — not a code, and
// never "an error occurred". A rep who can read the reason can act on it; a rep who cannot will
// ring the office, and the office will ring us.

import { useState } from 'react';
import { View } from 'react-native';
import { queueSummary } from '../../../packages/engines/sync-queue.mjs';
import { useField } from '../src/state';
import { colour, space } from '../src/theme';
import { Big, Body, Card, Heading, Row, Screen, Soft, Title } from '../src/ui';

export default function Queue() {
  const { items, outcome, flush } = useField();
  const [busy, setBusy] = useState(false);
  const view = queueSummary(items);

  const waiting = items.filter((i) => i.state === 'QUEUED');
  const stopped = items.filter((i) => i.state === 'BLOCKED');
  const gone = items.filter((i) => i.state === 'SENT');

  const labelOf = (item: (typeof items)[number]) => (item as { label?: string }).label || item.kind;

  const sendNow = async () => {
    setBusy(true);
    try {
      // `true`: a rep who taps this is owed an attempt. The backoff exists for a line that is
      // present and failing, which is not what a tap means.
      await flush(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Title>The queue</Title>
      <Soft testID="queue-counts">
        {`${view.sent} in · ${view.queued} waiting · ${view.blocked} stopped`}
      </Soft>

      {outcome?.needsSignIn ? (
        <Card style={{ borderColor: colour.stopped }}>
          <Heading>Sign in again</Heading>
          <Body>Your work is safe on this phone. It will go up once you are signed in.</Body>
        </Card>
      ) : null}

      <Big
        label={busy ? 'Sending…' : 'Send now'}
        onPress={() => void sendNow()}
        disabled={busy}
        testID="send-now"
      />

      {stopped.length ? (
        <Card style={{ borderColor: colour.stopped }}>
          <Heading>Stopped</Heading>
          <Soft>These will not go up on their own. Each says what the server refused.</Soft>
          {stopped.map((i) => (
            <View
              key={i.localId}
              testID="problem"
              style={{
                paddingVertical: space.sm,
                borderTopWidth: 1,
                borderTopColor: colour.line,
                gap: 2,
              }}
            >
              <Body>{labelOf(i)}</Body>
              <Soft>{i.lastError || i.lastCode || 'The server refused this.'}</Soft>
            </View>
          ))}
        </Card>
      ) : null}

      {waiting.length ? (
        <Card>
          <Heading>Waiting</Heading>
          {waiting.map((i) => (
            <Row
              key={i.localId}
              title={labelOf(i)}
              note={
                i.attempts > 0
                  ? `${i.attempts} ${i.attempts === 1 ? 'try' : 'tries'}${i.lastError ? ' · ' + i.lastError : ''}`
                  : 'Not tried yet'
              }
            />
          ))}
        </Card>
      ) : null}

      {gone.length ? (
        <Card>
          <Heading>Gone up</Heading>
          {gone
            .slice(-25)
            .reverse()
            .map((i) => (
              <Row key={i.localId} title={labelOf(i)} right="In" />
            ))}
          {gone.length > 25 ? <Soft>{`and ${gone.length - 25} more`}</Soft> : null}
        </Card>
      ) : null}

      {!items.length ? (
        <Card>
          <Body>Nothing has been queued on this phone yet.</Body>
        </Card>
      ) : null}

      <Soft>
        Work is kept on this phone until the server has it. Closing the app does not lose it.
      </Soft>
      <View style={{ height: space.xl }} />
    </Screen>
  );
}
