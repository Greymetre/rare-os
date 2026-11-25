// RCH-8: "My month" — the register as the rep's own payroll will read it.
//
// Every figure here is calculated, never stored. The phone adds nothing: it shows what
// `monthlyRegister` worked out, because a second opinion computed on a handset is how two
// screens start disagreeing about the same month.
import { thisMonth } from '../src/net';
import { useOnline, Waiting } from '../src/online';
import { colour } from '../src/theme';
import { Card, Heading, Row, Screen, Soft, Title } from '../src/ui';

type Register = {
  rep: { code: string; name: string; shift: string | null };
  rows: {
    date: string;
    status: string;
    late_by_minutes?: number | null;
    short_by_minutes?: number | null;
  }[];
  totals: Record<string, number>;
  days_owed?: number;
};

const WORDS: Record<string, string> = {
  PRESENT: 'Present',
  LATE: 'Late',
  HALF_DAY: 'Half day',
  LEAVE: 'Leave',
  ABSENT: 'Absent',
  WEEK_OFF: 'Week off',
  HOLIDAY: 'Holiday',
  SHORT: 'Short',
  NOT_COUNTED: 'Not counted',
};

export default function Month() {
  const month = thisMonth();
  const { state, reload } = useOnline<Register>('reach/attendance/register', {
    from: month + '-01',
    to: month + '-31',
  });

  return (
    <Screen>
      <Title>My month</Title>
      <Soft>{month}</Soft>
      <Waiting state={state} reload={reload} />
      {state?.data ? (
        <>
          <Card>
            <Heading>What the month adds up to</Heading>
            {Object.entries(state.data.totals)
              .filter(([, n]) => n > 0)
              .map(([status, n]) => (
                <Row key={status} title={WORDS[status] ?? status} right={String(n)} />
              ))}
            {typeof state.data.days_owed === 'number' ? (
              <Row title="Days payroll owes" right={String(state.data.days_owed)} />
            ) : null}
          </Card>
          <Card>
            <Heading>Day by day</Heading>
            {state.data.rows.map((r) => (
              <Row
                key={r.date}
                title={r.date}
                note={
                  r.late_by_minutes
                    ? `${r.late_by_minutes} minutes late`
                    : r.short_by_minutes
                      ? `${r.short_by_minutes} minutes short`
                      : undefined
                }
                right={WORDS[r.status] ?? r.status}
              />
            ))}
          </Card>
          <Soft>A missed punch is fixed by asking, not by editing. Me → Fix a punch.</Soft>
        </>
      ) : null}
    </Screen>
  );
}
