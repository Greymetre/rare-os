// RCH-8: "Start my day" and "Rep today", which the client's designs draw as two screens and
// which are one here because they are one thing: what the rep is doing right now.
//
// The day is started with a work type and, if the phone will say, a fix and a selfie. None of
// that blocks: `attendance.start` accepts a null location, and the server records how much the
// location can be trusted rather than refusing a day that began in a basement.

import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import {
  dayEnd,
  dayStart,
  photo as photoPayload,
} from '../../../../packages/engines/field-payloads.mjs';
import { takePhoto, whereAmI } from '../../src/device';
import { useField } from '../../src/state';
import { colour, space } from '../../src/theme';
import { Big, Body, Card, Choice, Heading, Row, Screen, Soft, Title } from '../../src/ui';

export default function Today() {
  const router = useRouter();
  const { day, items, push, flush, may, refreshDay } = useField();
  const [workType, setWorkType] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!day)
    return (
      <Screen>
        <Title>Today</Title>
        <Card>
          <Body>Your round has not reached this phone yet.</Body>
          <Soft>Connect to a network once and it will be saved here for the day.</Soft>
        </Card>
        <Big label="Try again" onPress={() => void refreshDay()} tone="quiet" />
      </Screen>
    );

  // The day as the phone understands it: what the server already had, plus anything the rep has
  // done that has not left the handset.
  const startedOnPhone = items.some((i) => i.kind === 'attendance.start' && i.state !== 'BLOCKED');
  const endedOnPhone = items.some((i) => i.kind === 'attendance.end' && i.state !== 'BLOCKED');
  const started = Boolean(day.day?.start_time) || startedOnPhone;
  const ended = Boolean(day.day?.end_time) || endedOnPhone;

  const doneStops = new Set(
    items
      .filter((i) => i.kind === 'visit.checkout' && i.state !== 'BLOCKED')
      .map((i) => String(i.payload.visit_id)),
  );
  const checkedIn = items.filter((i) => i.kind === 'visit.checkin' && i.state !== 'BLOCKED');
  const calls = checkedIn.length;
  const closed = checkedIn.filter(
    (c) => doneStops.has(c.localId) || doneStops.has(String(c.serverId)),
  ).length;

  const startDay = async () => {
    if (!workType) return;
    setBusy(true);
    try {
      const fix = await whereAmI();
      // A selfie at day start is what the client's "Start my day" screen draws. Optional: a rep
      // who declines the camera still starts their day.
      const selfie = await takePhoto('selfie.jpg');
      let fileId: string | null = null;
      if (selfie) {
        const shot = await push(
          'file.upload',
          photoPayload({ purpose: 'selfie', name: selfie.name }),
          'Selfie',
          {
            fileUri: selfie.uri,
            contentType: selfie.contentType,
          },
        );
        fileId = shot.localId;
      }
      await push(
        'attendance.start',
        dayStart({ workTypeId: workType, fix, fileId }),
        'Day started',
      );
      void flush();
    } finally {
      setBusy(false);
    }
  };

  const endDay = async () => {
    setBusy(true);
    try {
      const fix = await whereAmI();
      await push('attendance.end', dayEnd({ fix, version: day.day?.version ?? 1 }), 'Day ended');
      void flush();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={{ gap: space.xs }}>
        <Title>{day.rep.name}</Title>
        <Soft>
          {day.rep.code}
          {day.rep.hq_town ? ' · ' + day.rep.hq_town : ''} · {day.server_date}
        </Soft>
      </View>

      {!started ? (
        <Card>
          <Heading>Start your day</Heading>
          <Soft>Pick what you are doing today. Your location and a selfie go with it.</Soft>
          <Choice
            label="Work type"
            options={day.work_types.map((w) => ({ id: w.id, name: w.name }))}
            value={workType}
            onChange={setWorkType}
          />
          <Big
            label={busy ? 'Starting…' : 'Start my day'}
            onPress={() => void startDay()}
            disabled={busy || !workType || !may('attendance.start')}
            testID="start-day"
          />
          {!may('attendance.start') ? (
            <Soft>You do not have the right to mark attendance.</Soft>
          ) : null}
        </Card>
      ) : (
        <Card>
          <Heading>{ended ? 'Day closed' : 'Day running'}</Heading>
          <Row title="Started" right={day.day?.start_time ?? 'on this phone'} />
          {ended ? <Row title="Ended" right={day.day?.end_time ?? 'on this phone'} /> : null}
          <Row title="Shops called on" right={String(calls)} />
          <Row title="Calls closed" right={String(closed)} />
        </Card>
      )}

      {started && !ended ? (
        <>
          <Big label="Today's beat" onPress={() => router.push('/(tabs)/beat')} />
          <Big
            label={busy ? 'Ending…' : 'End my day'}
            onPress={() => void endDay()}
            tone="quiet"
            disabled={busy || !may('attendance.end')}
            testID="end-day"
          />
        </>
      ) : null}

      <Card style={{ borderColor: colour.line }}>
        <Row
          title="The queue"
          note="What is still on this phone"
          right="Open"
          onPress={() => router.push('/queue')}
          testID="open-queue"
        />
      </Card>
    </Screen>
  );
}
