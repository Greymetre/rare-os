// RCH-8: the tour plan — the month as the plan has it, and the one action a rep has on it.
//
// A rep does not type into their own plan: milestone question 8 was answered no, and a manager
// approves or sends back a month. What a rep can do is ask for a change, which is what the
// client's "Change request" screen is for.
import { useRouter } from 'expo-router';
import { useOnline, Waiting } from '../../src/online';
import { thisMonth } from '../../src/net';
import { Card, Heading, Row, Screen, Soft, Title } from '../../src/ui';

type Plan = {
  plan: { id: string; month: string; status: string; version: number } | null;
  days: { work_date: string; beat: string | null; beat_id: string | null; outlets: number }[];
};

export default function PlanTab() {
  const router = useRouter();
  const month = thisMonth();
  const { state, reload } = useOnline<Plan>('reach/tour/plan', { month });

  return (
    <Screen>
      <Title>Tour plan</Title>
      <Soft>{month}</Soft>
      <Waiting state={state} reload={reload} />
      {state?.data ? (
        !state.data.plan ? (
          <Card>
            <Heading>No plan for this month</Heading>
            <Soft>A plan is made and approved in the office before it reaches your phone.</Soft>
          </Card>
        ) : (
          <>
            <Card>
              <Row title="Status" right={state.data.plan.status} />
              <Row title="Ask for a change" right="Open" onPress={() => router.push('/change')} />
            </Card>
            <Card>
              <Heading>Days</Heading>
              {state.data.days.map((d) => (
                <Row
                  key={d.work_date}
                  title={d.work_date}
                  note={d.beat ? `${d.beat} · ${d.outlets} shops` : 'No beat'}
                />
              ))}
            </Card>
          </>
        )
      ) : null}
    </Screen>
  );
}
