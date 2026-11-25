// RCH-8: leave — the balance, what has been asked for, and asking for more.
import { useState } from 'react';
import { post, today } from '../src/net';
import { useOnline, Waiting } from '../src/online';
import { colour } from '../src/theme';
import { Big, Body, Card, Choice, Field, Heading, Row, Screen, Soft, Title } from '../src/ui';

type LeaveList = {
  rows: {
    id: string;
    leave_type: string;
    leave_type_name: string;
    from_date: string;
    to_date: string;
    days: number;
    half_day: boolean;
    status: string;
    reason: string;
  }[];
  balance: { id: string; code: string; name: string; annual_quota: number; taken: number }[];
  leaveTypes: { id: string; code: string; name: string; paid: boolean }[];
};

export default function Leave() {
  const { state, reload } = useOnline<LeaveList>('reach/attendance/leave', { mine: 'true' });
  const [type, setType] = useState<string | null>(null);
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState('');

  const apply = async () => {
    if (!type) return;
    setSending(true);
    setProblem('');
    const result = await post('reach/attendance/leave', {
      leave_type_id: type,
      from_date: from,
      to_date: to,
      half_day: false,
      reason,
    });
    setSending(false);
    if (result.data) {
      setReason('');
      await reload();
      return;
    }
    setProblem(
      result.offline ? 'This needs a network. Try again where there is signal.' : result.error,
    );
  };

  return (
    <Screen>
      <Title>Leave</Title>
      <Waiting state={state} reload={reload} />
      {state?.data ? (
        <>
          {state.data.balance.length ? (
            <Card>
              <Heading>Balance this year</Heading>
              {state.data.balance.map((b) => (
                <Row
                  key={b.id}
                  title={b.name}
                  note={b.code}
                  right={`${b.taken} of ${b.annual_quota}`}
                />
              ))}
            </Card>
          ) : null}

          <Card>
            <Heading>Ask for leave</Heading>
            <Choice
              label="Type"
              options={state.data.leaveTypes.map((t) => ({ id: t.id, name: t.name }))}
              value={type}
              onChange={setType}
            />
            <Field
              label="From"
              value={from}
              onChange={setFrom}
              placeholder="YYYY-MM-DD"
              testID="from"
            />
            <Field label="To" value={to} onChange={setTo} placeholder="YYYY-MM-DD" testID="to" />
            <Field label="Reason" value={reason} onChange={setReason} testID="reason" />
            {problem ? <Soft>{problem}</Soft> : null}
            <Big
              label={sending ? 'Sending…' : 'Ask for leave'}
              onPress={() => void apply()}
              disabled={sending || !type}
              testID="apply-leave"
            />
          </Card>

          <Card>
            <Heading>Asked for</Heading>
            {state.data.rows.length ? (
              state.data.rows.map((r) => (
                <Row
                  key={r.id}
                  title={`${r.leave_type_name} · ${r.from_date}${r.to_date !== r.from_date ? ' to ' + r.to_date : ''}`}
                  note={r.reason || undefined}
                  right={r.status}
                />
              ))
            ) : (
              <Body>Nothing yet this year.</Body>
            )}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}
