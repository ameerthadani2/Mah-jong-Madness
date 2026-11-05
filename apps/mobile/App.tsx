import React, { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Platform, StyleSheet, Text, View } from 'react-native';
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
import { randomHex } from '@mjm/net';
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
import { AvatarGallery } from './src/screens/AvatarGallery';

/** Web-only developer gallery: open the app with #avatars. */
const SHOW_AVATAR_GALLERY = Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.hash === '#avatars';

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

/**
 * Shuffle shares and rejoin tokens need a secure random source (installed by
 * src/polyfills.ts on native). Without one the game cannot be fair, so the app
 * stops here instead of failing mid-hand.
 */
function secureRandomError(): string | null {
  try {
    randomHex(1);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Plain, font-independent error screen for a device that cannot run the app. */
function BootError({ detail }: { detail: string }) {
  return (
    <View style={[styles.root, styles.center, styles.errorWrap]}>
      <Text style={styles.errorTitle}>This device cannot run fair games</Text>
      <Text style={styles.errorBody}>Mahjong Madness needs the system's secure random number generator to shuffle fairly, and it is not available here. Please update the app or your device's system software.</Text>
      <Text style={styles.errorDetail}>{detail}</Text>
    </View>
  );
}

export default function App() {
  const [rngError] = useState(secureRandomError);
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
  if (rngError) return <BootError detail={rngError} />;
  return (
    <SafeAreaProvider>
      <StatusBar style="light" hidden />
      {ready && SHOW_AVATAR_GALLERY ? (
        <AvatarGallery />
      ) : ready ? (
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
  errorWrap: { padding: 24, gap: 12 },
  errorTitle: { color: colors.ink, fontSize: 22, fontWeight: '800', textAlign: 'center' },
  errorBody: { color: colors.ink, fontSize: 16, lineHeight: 22, textAlign: 'center', maxWidth: 480 },
  errorDetail: { color: colors.inkDim, fontSize: 12, textAlign: 'center' },
});
