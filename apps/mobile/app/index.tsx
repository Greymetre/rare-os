// The entry point exists only to send the rep to the right place once the app has read its
// storage. Deciding this inside a screen would flash the wrong one first.
import { Redirect } from 'expo-router';
import { View } from 'react-native';
import { colour } from '../src/theme';
import { useField } from '../src/state';

export default function Entry() {
  const { ready, signedIn } = useField();
  if (!ready) return <View style={{ flex: 1, backgroundColor: colour.paper }} />;
  return <Redirect href={signedIn ? '/(tabs)/today' : '/sign-in'} />;
}
