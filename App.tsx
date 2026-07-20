import { StatusBar } from 'expo-status-bar';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import HistoryScreen from './src/screens/HistoryScreen';
import RecordScreen from './src/screens/RecordScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { SettingsProvider } from './src/SettingsContext';
import { colors } from './src/theme';

const Tab = createBottomTabNavigator();

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.surface,
    border: colors.border,
    text: colors.text,
    primary: colors.accent,
  },
};

// Emoji rather than an icon font: keeps the APK free of extra font assets and
// renders identically on every Android version we care about.
const ICONS: Record<string, string> = {
  'New Record': '⏺',
  History: '🕘',
  Settings: '⚙️',
};

export default function App() {
  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <NavigationContainer theme={navTheme}>
          <StatusBar style="light" />
          <Tab.Navigator
            screenOptions={({ route }) => ({
              headerStyle: { backgroundColor: colors.bg },
              headerTitleStyle: { color: colors.text, fontSize: 20, fontWeight: '700' },
              headerTitleAlign: 'left',
              headerShadowVisible: false,
              tabBarStyle: {
                backgroundColor: colors.surface,
                borderTopColor: colors.border,
                height: 62,
                paddingBottom: 8,
                paddingTop: 8,
              },
              tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
              tabBarActiveTintColor: colors.accent,
              tabBarInactiveTintColor: colors.textFaint,
              tabBarIcon: ({ color }) => (
                <Text style={{ fontSize: 17, color }}>{ICONS[route.name]}</Text>
              ),
            })}
          >
            <Tab.Screen name="New Record" component={RecordScreen} />
            <Tab.Screen name="History" component={HistoryScreen} />
            <Tab.Screen name="Settings" component={SettingsScreen} />
          </Tab.Navigator>
        </NavigationContainer>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}
