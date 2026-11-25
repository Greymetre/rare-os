// RCH-8: signing in.
//
// One button. The rep taps it, Keycloak's own page opens in a real browser view with a real
// address bar, and they come back signed in. There is no username field here on purpose: a
// login form inside an app is a login form that cannot show where it is sending the password.

import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { signIn } from '../src/auth';
import { useField } from '../src/state';
import { colour, space, text } from '../src/theme';
import { Big, Body, Card, Soft, Title } from '../src/ui';

export default function SignIn() {
  const router = useRouter();
  const { setSignedIn, refreshDay, flush, items } = useField();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const waiting = items.filter((i) => i.state !== 'SENT').length;

  const go = async () => {
    setBusy(true);
    setError('');
    try {
      await signIn();
      setSignedIn(true);
      await refreshDay();
      // Signing back in is one of the moments worth an immediate attempt: the usual reason a rep
      // is here is that the queue asked them to be.
      await flush(true);
      router.replace('/(tabs)/today');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Sign-in did not complete.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colour.paper,
        justifyContent: 'center',
        padding: space.lg,
        gap: space.lg,
      }}
    >
      <View style={{ gap: space.xs }}>
        <Title>RARE OS</Title>
        <Text style={text.heading}>Field</Text>
      </View>

      <Card>
        <Body>Sign in with your RARE OS account to load today's round.</Body>
        <Soft>
          Once you are signed in the app works without a network. It sends your work when a network
          comes back.
        </Soft>
      </Card>

      {waiting > 0 ? (
        <Card style={{ borderColor: colour.waiting }}>
          <Body>
            {waiting === 1
              ? '1 piece of work is still on this phone.'
              : `${waiting} pieces of work are still on this phone.`}
          </Body>
          <Soft>Signing in does not change it. It will be sent once you are back in.</Soft>
        </Card>
      ) : null}

      {error ? (
        <Card style={{ borderColor: colour.stopped }}>
          <Body>{error}</Body>
        </Card>
      ) : null}

      <Big
        label={busy ? 'Opening sign-in…' : 'Sign in'}
        onPress={go}
        disabled={busy}
        testID="sign-in"
      />
    </View>
  );
}
