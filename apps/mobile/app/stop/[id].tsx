// RCH-8: the visit hub — one shop, and everything the rep can do standing in front of it.
//
// Check in first. Everything else needs an open visit, because that is what the server's own
// rules say: an order may carry a visit, a check-out must have one. The one exception is a
// collection, which carries no visit at all — `trade_receipts` has no column for one.

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import {
  checkIn as checkInPayload,
  photo as photoPayload,
} from '../../../../packages/engines/field-payloads.mjs';
import { takePhoto, whereAmI } from '../../src/device';
import { useField } from '../../src/state';
import { colour, space } from '../../src/theme';
import { Big, Body, Card, Heading, Row, Screen, Soft, Title } from '../../src/ui';

export default function Stop() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { day, items, push, flush, may, openVisitFor } = useField();
  const [busy, setBusy] = useState(false);

  const stop = day?.stops.find((s) => s.customer_id === id);
  if (!day || !stop)
    return (
      <Screen>
        <Title>Shop</Title>
        <Card>
          <Body>This shop is not on today's round.</Body>
        </Card>
      </Screen>
    );

  const visit = openVisitFor(stop.customer_id);
  const owed = day.outstanding[stop.customer_id] ?? 0;
  const closed = items.some(
    (c) =>
      c.kind === 'visit.checkout' &&
      (c.payload.visit_id === visit?.id || (visit && c.payload.visit_id === visit.id)),
  );

  const arrive = async () => {
    setBusy(true);
    try {
      const fix = await whereAmI();
      // A photo of the shelf, not of the rep. `shelf` has been an allowed purpose since RCH-0
      // and this is what it was for. Optional: a refused camera is no photo, never a lost call.
      const shelf = await takePhoto('shelf.jpg');
      let fileId: string | null = null;
      if (shelf) {
        const shot = await push(
          'file.upload',
          photoPayload({ purpose: 'shelf', name: shelf.name }),
          'Photo',
          {
            fileUri: shelf.uri,
            contentType: shelf.contentType,
          },
        );
        fileId = shot.localId;
      }
      await push(
        'visit.checkin',
        checkInPayload({ customerId: stop.customer_id, fix, fileId }),
        'Check-in at ' + stop.name,
      );
      void flush();
    } finally {
      setBusy(false);
    }
  };

  const go = (where: 'order' | 'collect' | 'close') =>
    router.push({ pathname: '/stop/' + where, params: { id: stop.customer_id } });

  return (
    <Screen>
      <View style={{ gap: space.xs }}>
        <Title>{stop.name}</Title>
        <Soft>{[stop.code, stop.town, stop.type_name].filter(Boolean).join(' · ')}</Soft>
      </View>

      {owed > 0 ? (
        <Card style={{ borderColor: colour.waiting }}>
          <Heading>{'₹' + owed.toLocaleString('en-IN') + ' owing'}</Heading>
          <Soft>As it stood when this phone last had a network.</Soft>
        </Card>
      ) : null}

      {!visit ? (
        <Card>
          <Heading>Check in</Heading>
          <Soft>
            {stop.latitude === null
              ? 'This shop has no location on file, so the distance will not be measured.'
              : 'Your location is recorded. A long way from the shop is flagged, never refused.'}
          </Soft>
          <Big
            label={busy ? 'Checking in…' : 'Check in'}
            onPress={() => void arrive()}
            disabled={busy || !may('visit.checkin')}
            testID="check-in"
          />
          {!may('visit.checkin') ? <Soft>You do not have the right to record visits.</Soft> : null}
        </Card>
      ) : closed ? (
        <Card>
          <Heading>Call closed</Heading>
          <Soft>Checked out. Anything still unsent is in the queue.</Soft>
        </Card>
      ) : (
        <>
          <Card>
            <Heading>Checked in</Heading>
            <Row title="What you can do here" note="Each one is saved on the phone first" />
          </Card>
          {may('order.place') ? (
            <Big label="Take the order" onPress={() => go('order')} testID="to-order" />
          ) : null}
          {may('receipt.collect') ? (
            <Big
              label="Collect payment"
              onPress={() => go('collect')}
              tone="quiet"
              testID="to-collect"
            />
          ) : null}
          {may('visit.checkout') ? (
            <Big label="Check out" onPress={() => go('close')} tone="quiet" testID="to-close" />
          ) : null}
        </>
      )}
    </Screen>
  );
}
