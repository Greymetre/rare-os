// RCH-8: "Fix a punch" — a rep asking for a day to be corrected.
//
// The rep never edits the day. The old record stays and the correction is a request somebody
// decides on, which is what keeps the register something payroll can rely on.
import { useState } from 'react';
import { post, today } from '../src/net';
import { useOnline, Waiting } from '../src/online';
import { Big, Body, Card, Field, Heading, Row, Screen, Soft, Title } from '../src/ui';

type Corrections = {
  rows: {
    id: string;
    work_date: string;
    start_time: string | null;
    end_time: string | null;
    reason: string;
    status: string;
  }[];
};

export default function Regularise() {
  const { state, reload } = useOnline<Corrections>('reach/attendance/corrections', {});
  const [date, setDate] = useState(today());
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState('');

  const ask = async () => {
    setSending(true);
    setProblem('');
    const result = await post('reach/attendance/corrections', {
      work_date: date,
      start_time: start || null,
      end_time: end || null,
      reason,
    });
    setSending(false);
    if (result.data) {
      setStart('');
      setEnd('');
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
      <Title>Fix a punch</Title>
      <Soft>The day you worked, and what the times should have been.</Soft>
      <Card>
        <Field
          label="Day"
          value={date}
          onChange={setDate}
          placeholder="YYYY-MM-DD"
          testID="work-date"
        />
        <Field
          label="Started at"
          value={start}
          onChange={setStart}
          placeholder="09:15"
          testID="start-time"
        />
        <Field
          label="Ended at"
          value={end}
          onChange={setEnd}
          placeholder="18:00"
          testID="end-time"
        />
        <Field label="Why" value={reason} onChange={setReason} testID="why" />
        {problem ? <Soft>{problem}</Soft> : null}
        <Big
          label={sending ? 'Sending…' : 'Ask for a correction'}
          onPress={() => void ask()}
          disabled={sending || !reason.trim()}
          testID="ask-correction"
        />
      </Card>
      <Waiting state={state} reload={reload} />
      {state?.data ? (
        <Card>
          <Heading>Asked for</Heading>
          {state.data.rows.length ? (
            state.data.rows.map((r) => (
              <Row
                key={r.id}
                title={r.work_date}
                note={[r.start_time, r.end_time].filter(Boolean).join(' – ') || r.reason}
                right={r.status}
              />
            ))
          ) : (
            <Body>Nothing waiting.</Body>
          )}
        </Card>
      ) : null}
    </Screen>
  );
}
