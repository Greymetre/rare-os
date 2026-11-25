// RCH-8: today's beat — the round, in the order the plan puts it.
//
// A stop that has been called on is shown as such from what is on the phone, not from the
// server, because the server may not have heard about this morning yet.
import { useRouter } from 'expo-router';
import { useField } from '../../src/state';
import { Body, Card, Row, Screen, Soft, Title } from '../../src/ui';

export default function Beat() {
  const router = useRouter();
  const { day, items, openVisitFor } = useField();

  if (!day)
    return (
      <Screen>
        <Title>Beat</Title>
        <Card>
          <Body>Your round has not reached this phone yet.</Body>
        </Card>
      </Screen>
    );

  if (!day.stops.length)
    return (
      <Screen>
        <Title>Beat</Title>
        <Card>
          <Body>No approved round for today.</Body>
          <Soft>A tour plan has to be approved before shops appear here.</Soft>
        </Card>
      </Screen>
    );

  const closedFor = (customerId: string) => {
    const checkIn = items.find(
      (i) => i.kind === 'visit.checkin' && i.payload.customer_id === customerId,
    );
    if (!checkIn) return false;
    return items.some(
      (c) =>
        c.kind === 'visit.checkout' &&
        (c.payload.visit_id === checkIn.localId || c.payload.visit_id === checkIn.serverId),
    );
  };

  return (
    <Screen>
      <Title>{day.stops[0].beat || 'Today'}</Title>
      <Soft>{day.stops.length} shops, in plan order</Soft>
      <Card>
        {day.stops.map((stop) => {
          const open = openVisitFor(stop.customer_id);
          const state = closedFor(stop.customer_id) ? 'Done' : open ? 'Open' : '';
          const owed = day.outstanding[stop.customer_id] ?? 0;
          return (
            <Row
              key={stop.customer_id}
              testID={'stop-' + stop.code}
              title={`${stop.sequence}. ${stop.name}`}
              note={[
                stop.code,
                stop.town,
                stop.type_name,
                owed > 0 ? '₹' + owed.toLocaleString('en-IN') + ' owing' : '',
              ]
                .filter(Boolean)
                .join(' · ')}
              right={state}
              onPress={() =>
                router.push({ pathname: '/stop/[id]', params: { id: stop.customer_id } })
              }
            />
          );
        })}
      </Card>
    </Screen>
  );
}
