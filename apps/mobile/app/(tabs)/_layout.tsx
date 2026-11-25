// RCH-8: the bottom tabs.
//
// The client's designs give the Field Rep workspace five tabs — Today, Beat, Plan, Leads, Me.
// Four are here. Leads is left out because the Reach plan names leads and pipeline among the
// things that are **not** in this plan, and a tab that opens an empty screen is worse than a tab
// that is not there.

import { Redirect, Tabs } from 'expo-router';
import { View } from 'react-native';
import { colour } from '../../src/theme';
import { useField } from '../../src/state';

export default function TabsLayout() {
  const { ready, signedIn } = useField();
  if (!ready) return <View style={{ flex: 1, backgroundColor: colour.paper }} />;
  if (!signedIn) return <Redirect href="/sign-in" />;

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colour.header },
        headerTintColor: colour.headerText,
        headerTitleStyle: { fontWeight: '700' },
        tabBarActiveTintColor: colour.header,
        tabBarInactiveTintColor: colour.inkSoft,
        tabBarStyle: { backgroundColor: colour.card, borderTopColor: colour.line },
        tabBarLabelStyle: { fontSize: 13, fontWeight: '600' },
        sceneStyle: { backgroundColor: colour.paper },
      }}
    >
      <Tabs.Screen name="today" options={{ title: 'Today' }} />
      <Tabs.Screen name="beat" options={{ title: 'Beat' }} />
      <Tabs.Screen name="plan" options={{ title: 'Plan' }} />
      <Tabs.Screen name="me" options={{ title: 'Me' }} />
    </Tabs>
  );
}
