// RCH-8: Me. Who is signed in, what this phone is still carrying, and the way out.
import { useRouter } from 'expo-router';
import { useField } from '../../src/state';
import { APP_VERSION, SERVER } from '../../src/config';
import { Big, Body, Card, Heading, Row, Screen, Soft, Title } from '../../src/ui';

export default function Me() {
  const router = useRouter();
  const { day, items, signedOut, refreshDay, flush } = useField();
  const waiting = items.filter((i) => i.state === 'QUEUED').length;
  const stopped = items.filter((i) => i.state === 'BLOCKED').length;

  return (
    <Screen>
      <Title>{day?.rep.name ?? 'Signed in'}</Title>
      {day ? (
        <Soft>{[day.rep.code, day.rep.grade, day.rep.hq_town].filter(Boolean).join(' · ')}</Soft>
      ) : null}

      <Card>
        <Heading>This phone</Heading>
        <Row title="Waiting to send" right={String(waiting)} />
        <Row title="Stopped" right={String(stopped)} />
        <Row title="The queue" right="Open" onPress={() => router.push('/queue')} />
      </Card>

      <Big label="Send now" onPress={() => void flush(true)} testID="send-now" />
      <Big label="Get today's round again" onPress={() => void refreshDay()} tone="quiet" />

      <Card>
        <Heading>Attendance</Heading>
        <Row title="My month" right="Open" onPress={() => router.push('/month')} />
        <Row title="Leave" right="Open" onPress={() => router.push('/leave')} />
        <Row title="Fix a punch" right="Open" onPress={() => router.push('/regularise')} />
      </Card>

      {stopped > 0 ? (
        <Card>
          <Body>
            Sign out leaves your unsent work on this phone. It is still here when you sign back in.
          </Body>
        </Card>
      ) : null}
      <Big
        label="Sign out"
        tone="quiet"
        onPress={async () => {
          await signedOut();
          router.replace('/sign-in');
        }}
      />
      <Soft>
        {SERVER} · app {APP_VERSION}
      </Soft>
    </Screen>
  );
}
