import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AppProvider, useApp } from './src/app-state';
import { colors } from './src/theme';
import { HomeScreen } from './src/screens/HomeScreen';
import { OnlineScreen } from './src/screens/OnlineScreen';
import { LobbyScreen } from './src/screens/LobbyScreen';
import { TableScreen } from './src/screens/TableScreen';
import { LearnScreen, LessonScreen } from './src/screens/LearnScreen';
import { DrillScreen } from './src/screens/DrillScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { ClubScreen, ClubsScreen } from './src/screens/ClubsScreen';
import { ReviewScreen } from './src/screens/ReviewScreen';
import { FairnessScreen } from './src/screens/FairnessScreen';
import { DailyPuzzleScreen, PuzzleRushScreen } from './src/screens/PuzzleScreens';

function Router() {
  const { screen } = useApp();
  switch (screen.name) {
    case 'home':
      return <HomeScreen />;
    case 'online':
      return <OnlineScreen />;
    case 'clubs':
      return <ClubsScreen />;
    case 'club':
      return <ClubScreen code={screen.code} />;
    case 'review':
      return <ReviewScreen />;
    case 'fairness':
      return <FairnessScreen />;
    case 'daily':
      return <DailyPuzzleScreen />;
    case 'rush':
      return <PuzzleRushScreen />;
    case 'lobby':
      return <LobbyScreen />;
    case 'table':
      return <TableScreen />;
    case 'learn':
      return <LearnScreen />;
    case 'lesson':
      return <LessonScreen id={screen.id} />;
    case 'drill':
      return <DrillScreen kind={screen.kind} />;
    case 'settings':
      return <SettingsScreen />;
    default:
      return <HomeScreen />;
  }
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <View style={styles.root}>
          <StatusBar style="light" hidden />
          <SafeAreaView style={styles.safe} edges={['left', 'right', 'top', 'bottom']}>
            <Router />
          </SafeAreaView>
        </View>
      </AppProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.felt },
  safe: { flex: 1 },
});
