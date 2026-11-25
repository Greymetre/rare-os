// RCH-8: the shell. It owns nothing but the provider and the decision of whether the rep is
// looking at the app or at the sign-in screen.
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { colour } from '../src/theme';
import { FieldProvider } from '../src/state';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colour.paper }}>
      <FieldProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colour.header },
            headerTintColor: colour.headerText,
            headerTitleStyle: { fontWeight: '700' },
            contentStyle: { backgroundColor: colour.paper },
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="sign-in" options={{ headerShown: false }} />
          <Stack.Screen name="queue" options={{ title: 'The queue' }} />
          <Stack.Screen name="stop/[id]" options={{ title: 'Shop' }} />
          <Stack.Screen name="stop/order" options={{ title: 'Take the order' }} />
          <Stack.Screen name="stop/collect" options={{ title: 'Collect' }} />
          <Stack.Screen name="stop/close" options={{ title: 'Check out' }} />
          <Stack.Screen name="month" options={{ title: 'My month' }} />
          <Stack.Screen name="leave" options={{ title: 'Leave' }} />
          <Stack.Screen name="regularise" options={{ title: 'Fix a punch' }} />
          <Stack.Screen name="change" options={{ title: 'Ask for a change' }} />
        </Stack>
      </FieldProvider>
    </GestureHandlerRootView>
  );
}
