// RCH-8: "Change request" — a rep asking for a day of the plan to be different.
//
// A rep does not edit their own plan. Milestone question 8 was answered no: a manager approves
// or sends back a month, and never types into a rep's plan. This is the rep's side of that.
import { useState } from 'react';
import { post, thisMonth, today } from '../src/net';
import { useOnline, Waiting } from '../src/online';
import { Big, Body, Card, Choice, Field, Heading, Row, Screen, Soft, Title } from '../src/ui';

type Plan = { plan: { id: string; month: string; status: string } | null };
type Changes = {
  rows: {
    id: string;
    work_date: string;
    objective: string;
    reason: string;
    status: string;
    beat: string | null;
  }[];
};

export default function Change() {
  const month = thisMonth();
  const plan = useOnline<Plan>('reach/tour/plan', { month });
  const changes = useOnline<Changes>('reach/tour/changes', {});
  const [date, setDate] = useState(today());
  const [objective, setObjective] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState('');

  const planId = plan.state?.data?.plan?.id ?? null;

  const ask = async () => {
    if (!planId || !objective) return;
    setSending(true);
    setProblem('');
    const result = await post(`reach/tour/plan/${planId}/change`, {
      work_date: date,
      beat_id: null,
      outlet_count: null,
      objective,
      reason,
    });
    setSending(false);
    if (result.data) {
      setReason('');
      await changes.reload();
      return;
    }
    setProblem(
      result.offline ? 'This needs a network. Try again where there is signal.' : result.error,
    );
  };

  return (
    <Screen>
      <Title>Ask for a change</Title>
      <Soft>{month}</Soft>
      <Waiting state={plan.state} reload={plan.reload} />
      {plan.state?.data && !planId ? (
        <Card>
          <Body>There is no plan for this month to change.</Body>
        </Card>
      ) : null}
      {planId ? (
        <Card>
          <Heading>What should be different</Heading>
          <Field
            label="Day"
            value={date}
            onChange={setDate}
            placeholder="YYYY-MM-DD"
            testID="change-date"
          />
          <Choice
            label="What you are asking for"
            options={[
              { id: 'ADD', name: 'Add a day' },
              { id: 'MOVE', name: 'Move a day' },
              { id: 'DROP', name: 'Drop a day' },
            ]}
            value={objective}
            onChange={setObjective}
          />
          <Field label="Why" value={reason} onChange={setReason} testID="change-why" />
          {problem ? <Soft>{problem}</Soft> : null}
          <Big
            label={sending ? 'Sending…' : 'Send the request'}
            onPress={() => void ask()}
            disabled={sending || !objective || !reason.trim()}
            testID="ask-change"
          />
        </Card>
      ) : null}
      {changes.state?.data?.rows?.length ? (
        <Card>
          <Heading>Asked for</Heading>
          {changes.state.data.rows.map((r) => (
            <Row key={r.id} title={r.work_date} note={r.reason || r.objective} right={r.status} />
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}
