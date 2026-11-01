import React, { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import { LilitaOne_400Regular } from '@expo-google-fonts/lilita-one/400Regular';
import { LuckiestGuy_400Regular } from '@expo-google-fonts/luckiest-guy/400Regular';
import { Fredoka_500Medium } from '@expo-google-fonts/fredoka/500Medium';
import { Fredoka_600SemiBold } from '@expo-google-fonts/fredoka/600SemiBold';
import { Fredoka_700Bold } from '@expo-google-fonts/fredoka/700Bold';
import { Nunito_600SemiBold } from '@expo-google-fonts/nunito/600SemiBold';
import { Nunito_700Bold } from '@expo-google-fonts/nunito/700Bold';
import { Nunito_800ExtraBold } from '@expo-google-fonts/nunito/800ExtraBold';
import { AppProvider, useApp } from './src/app-state';
import { colors, fonts } from './src/theme';
import { SkyBackdrop, TableBackdrop } from './src/components/Backdrop';
import { Logo } from './src/components/Logo';
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
import { ShopScreen } from './src/screens/ShopScreen';

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
    case 'shop':
      return <ShopScreen />;
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

/** Sky lobby everywhere except the table, which sits on the parlour floor. */
function Shell() {
  const { screen } = useApp();
  return (
    <View style={styles.root}>
      {screen.name === 'table' ? <TableBackdrop /> : <SkyBackdrop />}
      <SafeAreaView style={styles.safe} edges={['left', 'right', 'top', 'bottom']}>
        <Router />
      </SafeAreaView>
    </View>
  );
}

/** Branded loading view shown while the display fonts load. */
function Loading() {
  return (
    <View style={[styles.root, styles.center]}>
      <SkyBackdrop />
      <Logo size={1.5} stacked />
      <View style={styles.dots}>
        {[colors.cta, colors.gold, colors.danger].map((c) => (
          <View key={c} style={[styles.dot, { backgroundColor: c }]} />
        ))}
      </View>
    </View>
  );
}

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    [fonts.display]: LilitaOne_400Regular,
    [fonts.logo]: LuckiestGuy_400Regular,
    [fonts.uiMedium]: Fredoka_500Medium,
    [fonts.ui]: Fredoka_600SemiBold,
    [fonts.uiBold]: Fredoka_700Bold,
    [fonts.body]: Nunito_600SemiBold,
    [fonts.bodyBold]: Nunito_700Bold,
    [fonts.bodyHeavy]: Nunito_800ExtraBold,
  });
  // Never blank the app on a slow or failed font load: fall back to system fonts after ~3 s.
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setTimedOut(true), 3000);
    return () => clearTimeout(id);
  }, []);
  const ready = fontsLoaded || !!fontError || timedOut;
  return (
    <SafeAreaProvider>
      <StatusBar style="light" hidden />
      {ready ? (
        <AppProvider>
          <Shell />
        </AppProvider>
      ) : (
        <Loading />
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.sky },
  safe: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', gap: 24 },
  dots: { flexDirection: 'row', gap: 10 },
  dot: { width: 16, height: 16, borderRadius: 8, borderWidth: 3, borderColor: colors.ink },
});
