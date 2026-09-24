import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import HistoryScreen from './src/screens/HistoryScreen';
import RecordScreen from './src/screens/RecordScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { SettingsProvider } from './src/SettingsContext';
import { ProcessingProvider } from './src/ProcessingContext';
import { bottomTabStyle, colors } from './src/theme';

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

const ICONS: Record<string, SymbolViewProps['name']> = {
  'New Record': { ios: 'mic.fill', android: 'mic', web: 'mic' },
  History: { ios: 'clock.arrow.circlepath', android: 'history', web: 'history' },
  Settings: { ios: 'gearshape.fill', android: 'settings', web: 'settings' },
};

export default function App() {
  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <ProcessingProvider>
          <NavigationContainer theme={navTheme}>
          <StatusBar style="light" />
          <Tab.Navigator
            screenOptions={({ route }) => ({
              headerStyle: { backgroundColor: colors.bg },
              headerTitleStyle: { color: colors.text, fontSize: 27, fontWeight: '700' },
              headerTitleAlign: 'left',
              headerShadowVisible: false,
              tabBarStyle: bottomTabStyle,
              tabBarHideOnKeyboard: true,
              tabBarItemStyle: styles.tabItem,
              tabBarActiveTintColor: colors.accent,
              tabBarInactiveTintColor: colors.textFaint,
              tabBarIcon: ({ color }) => (
                <SymbolView name={ICONS[route.name]} size={25} tintColor={color} />
              ),
              tabBarLabel: ({ focused, color }) => (
                <View style={styles.tabLabelWrap}>
                  <Text style={[styles.tabLabel, { color }]}>
                    {route.name === 'New Record' ? 'Record' : route.name}
                  </Text>
                  <View style={[styles.tabIndicator, focused && styles.tabIndicatorActive]} />
                </View>
              ),
            })}
          >
            <Tab.Screen
              name="New Record"
              component={RecordScreen}
              options={{ title: 'New recording' }}
            />
            <Tab.Screen name="History" component={HistoryScreen} />
            <Tab.Screen name="Settings" component={SettingsScreen} />
          </Tab.Navigator>
          </NavigationContainer>
        </ProcessingProvider>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  tabItem: { paddingTop: 2 },
  tabLabelWrap: { alignItems: 'center', gap: 4 },
  tabLabel: { fontSize: 13, lineHeight: 17, fontWeight: '600' },
  tabIndicator: { width: 26, height: 3, borderRadius: 2, backgroundColor: 'transparent' },
  tabIndicatorActive: { backgroundColor: colors.accent },
});
