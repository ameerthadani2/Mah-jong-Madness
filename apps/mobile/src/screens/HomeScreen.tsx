import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BOT_SKILLS, LESSON_TRACKS, LESSONS, type BotSkill } from '@mjm/engine';
import { allowedBotSkill, diamondsOwed, hasTier, totalDiamonds } from '../monetisation/wallet';
import { useWallet } from '../monetisation/useWallet';
import { gateFor } from '../legal/age';
import { useOnlineGuard } from '../legal/useOnlineGuard';
import { AgeBlocked, AgeGate } from '../components/AgeGate';
import { ConsentQuestion } from '../components/ConsentQuestion';
import { telemetryAvailable, useConsent } from '../telemetry';
import { shouldAskConsent } from '../telemetry/consent';
import { useApp } from '../app-state';
import { createLocalSession, createOnlineSession, seatOrRefusal } from '../game/session';
import { useAuth } from '../auth/AuthProvider';
import { AVATARS, effectiveStreak, todayKey } from '../storage';
import { acceptedName } from '../logic/profile';
import { NameRefusedNotice } from '../components/NameRefusedNotice';
import { tableError } from '../components/table/tableErrors';
import { ConfirmSheet } from '../components/table/ConfirmSheet';
import { replacesTable } from '../logic/back';
import { homeSmallWindowHeight, homeWindowHeight, isShortHome, LINK_HEIGHT } from '../logic/homeFit';
import { learnSummary } from '../logic/learn';
import { botLabel, rulesSummary } from '../logic/rules-text';
import { useT } from '../i18n';
import { colors, fonts, nameFont, space } from '../theme';
import { Button, Card, Chip, fontFor, GemCounter, IconButton, P, Pill, Row } from '../components/Ui';
import { AvatarPlate, avatarName } from '../components/Avatars';
import { useOwnedEquipped } from '../monetisation/useEquipped';
import { slopFor } from '../components/table/layout';
import { ChestScene, ClubhouseScene, ScrollScene, TableScene } from '../components/Scenes';
import { Icon } from '../components/Icons';
import { Logo } from '../components/Logo';

const WINDOWS = {
  play: ['#FFF0B8', '#FFD36B'] as const,
  clubs: ['#C9F1FF', '#83D6FF'] as const,
  learn: ['#EEE4FF', '#C6AFFF'] as const,
  shop: ['#FFE0EC', '#FFA5C8'] as const,
};

export function HomeScreen() {
  const app = useApp();
  // The avatar frame the player equipped (only one their wallet owns).
  const { frame } = useOwnedEquipped();
  const auth = useAuth();
  const { t, locale } = useT();
  const { width, height } = useWindowDimensions();
  const [name, setName] = useState(app.profile.name);
  const needsName = !app.profile.name;
  // A name the server refused is not shown as the player's (src/logic/profile.ts); the notice below says why.
  const shownName = acceptedName(app.profile) || t('common.player');
  const wide = width >= 700;
  // Any landscape phone (667×375 is not "wide"): the first-run Play button goes beside the name field.
  const landscape = width > height;
  const tablet = width >= 1000 && height >= 700;

  const saveName = () => app.setProfile({ ...app.profile, name: name.trim() || t('common.player') });

  // A table still open on this device and not over: the Resume card goes back to it rather than opening it again.
  const liveTable = app.session && !app.session.client.state.matchOver ? app.session : null;
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  // The age gate comes first on a fresh install (src/legal/age.ts, gateFor); `entry` guards the online resume.
  const { entry, gate } = useOnlineGuard();
  // The one-time privacy question exists only in a build that has a service to ask about (never the web preview).
  const asksConsent = telemetryAvailable.analytics || telemetryAvailable.crash;
  const consentState = useConsent();
  // Mirror the server wallet when this device already has a session (never bootstraps one).
  const { refresh: refreshWallet } = useWallet({ loadPrices: false });
  const accountId = auth.user?.id;
  useEffect(() => {
    if (app.loaded && accountId) void refreshWallet();
  }, [app.loaded, accountId, refreshWallet]);

  // A new match takes the place of a table in progress (the saved record is one slot): ask before it does.
  const [askReplace, setAskReplace] = useState(false);
  const playBots = () => {
    if (needsName) saveName();
    if (replacesTable(app.activeSession, app.session)) setAskReplace(true);
    else startBots();
  };
  const startBots = () => {
    setAskReplace(false);
    const session = createLocalSession(acceptedName(app.profile) || (needsName ? name.trim() : '') || t('common.player'), app.profile.avatar, app.settings.rules, { botSkill: allowedBotSkill(app.settings.botSkill, app.wallet) });
    app.setSession(session);
    session.host!.start();
    app.go({ name: 'table' });
  };

  const resume = async () => {
    const rec = app.activeSession;
    if (!rec) return;
    // The table is still open on this device (it was left behind without closing): go back to it as it is.
    if (liveTable) return app.go({ name: liveTable.client.state.view ? 'table' : 'lobby' });
    setResuming(true);
    setResumeError(null);
    try {
      if (rec.kind === 'local') {
        const session = createLocalSession(rec.name || t('common.player'), rec.avatar, rec.host.rules, { restore: { host: rec.host, token: rec.token } });
        app.setSession(session);
        app.go({ name: 'table' });
      } else if (entry !== 'ok') {
        // An install with no age answer (or a signed-out account) is gated on the Online screen before anything reaches the server.
        app.go({ name: 'online' });
      } else {
        // Back to the server the table lives on (the stored serverUrl), with this player's session.
        const session = await createOnlineSession({
          signalUrl: rec.signalUrl,
          name: rec.name || t('common.player'),
          avatar: rec.avatar,
          userId: app.profile.userId || undefined,
          rules: app.settings.rules,
          action: 'join',
          code: rec.roomCode,
          token: rec.token,
          clubCode: rec.clubCode,
          quickMatch: rec.quickMatch,
          ...auth.tableAuth,
        });
        // The table may no longer give this seat back (the match went on without it): say so on the card.
        await seatOrRefusal(session);
        app.setSession(session);
        app.go({ name: 'lobby' });
      }
    } catch (e) {
      setResumeError(tableError(e, t));
    } finally {
      setResuming(false);
    }
  };

  const winRate = app.progress.handsPlayed ? Math.round((app.progress.handsWon / app.progress.handsPlayed) * 100) : null;
  const dailyDone = app.progress.dailySolved[todayKey()] !== undefined;
  const streak = effectiveStreak(app.progress);
  // The same count Learn shows: lessons that still exist, out of all of them.
  const lessons = learnSummary(LESSONS, LESSON_TRACKS, app.progress.lessonsDone);
  const gems = totalDiamonds(app.wallet);
  // After a refund of spent diamonds the balance is below zero: the counter says so, and a line under the bar says why.
  const gemsOwed = diamondsOwed(app.wallet);
  const goClubs = () => {
    if (needsName) saveName();
    app.go({ name: 'clubs' });
  };
  const goOnline = () => {
    if (needsName) saveName();
    app.go({ name: 'online' });
  };
  // Quick match: the screen itself runs the online guard (age gate, update block, sign-in) before it queues.
  const goQuickMatch = () => {
    if (needsName) saveName();
    app.go({ name: 'quickmatch' });
  };

  const phoneLand = wide && !tablet;
  // A phone held sideways is about 390 pt tall: the art shrinks and the blurbs go, so the four cards, their buttons and
  // the links under them all fit above the bottom edge (src/logic/homeFit.ts).
  const short = isShortHome({ wide, tablet, height });
  const windowH = homeWindowHeight({ wide, tablet, height });
  const smallWindow = homeSmallWindowHeight({ wide, tablet, height });

  const skillChips = (
    <Row style={{ flexWrap: 'wrap', rowGap: 6 }} gap={6}>
      {(Object.keys(BOT_SKILLS) as BotSkill[]).map((k) => {
        const locked = k === 'pro' && !hasTier(app.wallet, 'gold');
        return <Chip key={k} label={botLabel(k, locale, true)} selected={allowedBotSkill(app.settings.botSkill, app.wallet) === k} locked={locked} onPress={() => (locked ? app.go({ name: 'shop' }) : app.setSettings({ ...app.settings, botSkill: k }))} />;
      })}
    </Row>
  );

  const playCard = (
    <ModeCard key="play" colorsPair={WINDOWS.play} windowH={windowH} scene={<TableScene width="100%" height="100%" />} title={t('home.play.title')} style={wide ? { flex: 1.55 } : undefined} horizontal={!wide}>
      {/* The whole rules line, clocks included: it wraps rather than ending in an ellipsis. */}
      <P dim style={styles.cardText} numberOfLines={phoneLand ? 2 : undefined}>
        {rulesSummary(app.settings.rules, t, locale)}
      </P>
      {skillChips}
      <View style={styles.cardFoot}>
        {/* On a first run the welcome card carries the Play button (above the fold everywhere); this one is the card's own. */}
        <Button testID={needsName ? 'start-match-card' : 'start-match'} title={t('home.play.start')} icon="play" large={tablet} onPress={playBots} />
      </View>
    </ModeCard>
  );
  const compact = !wide;
  const clubsCard = (
    <ModeCard key="clubs" colorsPair={WINDOWS.clubs} windowH={smallWindow} scene={<ClubhouseScene width="100%" height="100%" />} title={tablet ? t('home.clubs.titleWide') : t('home.clubs.title')} compact={compact} style={{ flex: 1 }}>
      {!compact && !short && (
        <P dim style={styles.cardText}>
          {t('home.clubs.blurb')}
        </P>
      )}
      <View style={styles.cardFoot}>
        {/* The short label on a portrait phone, as for quick match below: the full one is wider than the card's button in Chinese. */}
        <Button testID="open-clubs" title={t(compact && !landscape ? 'home.clubs.openShort' : 'home.clubs.open')} accessibilityLabel={t('home.clubs.open')} kind="secondary" small={compact} large={tablet} onPress={goClubs} />
        {/* No icon, and the short label on a portrait phone: the card's button is as narrow as 73 pt there, and a clipped label is worse than a short one. */}
        <Button testID="open-quickmatch" title={t(compact && !landscape ? 'quickmatch.buttonShort' : 'quickmatch.button')} accessibilityLabel={`${t('quickmatch.button')}. ${t('quickmatch.buttonHint')}`} small={compact} large={tablet} onPress={goQuickMatch} />
        {!compact && (
          <Pressable onPress={goOnline} hitSlop={slopFor(LINK_HEIGHT)} style={styles.link} accessibilityRole="link" accessibilityLabel={t('home.clubs.quickTable')}>
            <Icon name="users" size={18} />
            <Text style={[styles.linkText, fontFor(t('home.clubs.quickTable'), fonts.uiBold)]}>{t('home.clubs.quickTable')}</Text>
          </Pressable>
        )}
      </View>
    </ModeCard>
  );
  const learnCard = (
    <ModeCard
      key="learn"
      colorsPair={WINDOWS.learn}
      windowH={smallWindow}
      scene={<ScrollScene width="100%" height="100%" />}
      title={t('home.learn.title')}
      compact={compact}
      style={{ flex: 1 }}
      badge={!dailyDone ? <View style={styles.notify}><Text style={styles.notifyText}>!</Text></View> : undefined}
    >
      {!compact && (
        <Row style={{ flexWrap: 'wrap', rowGap: 6 }} gap={6}>
          <Pill text={t('home.learn.lessons', { done: lessons.done, total: lessons.total })} icon="book" size="sm" />
          <Pill text={t('home.learn.streak', { days: streak })} icon="flame" tone={streak > 0 ? 'gold' : 'neutral'} size="sm" />
          <Pill text={t('home.learn.rating', { n: app.progress.puzzleRating })} icon="target" tone="info" size="sm" />
        </Row>
      )}
      <View style={styles.cardFoot}>
        <Button testID="open-learn" title={t('home.learn.open')} kind="premium" small={compact} large={tablet} onPress={() => app.go({ name: 'learn' })} />
        {!compact && (
          <Pressable onPress={() => app.go({ name: 'daily' })} hitSlop={slopFor(LINK_HEIGHT)} style={styles.link} accessibilityRole="link" accessibilityLabel={dailyDone ? t('home.learn.dailyDone') : t('home.learn.daily')}>
            <Icon name={dailyDone ? 'check' : 'scroll'} size={18} color={colors.cta} />
            <Text style={[styles.linkText, fontFor(t('home.learn.daily'), fonts.uiBold)]}>{dailyDone ? t('home.learn.dailyDone') : t('home.learn.daily')}</Text>
          </Pressable>
        )}
      </View>
    </ModeCard>
  );
  const shopCard = (
    <ModeCard key="shop" colorsPair={WINDOWS.shop} windowH={smallWindow} scene={<ChestScene width="100%" height="100%" />} title={t('home.shop.title')} compact={compact} style={{ flex: 1 }}>
      {!compact && !short && (
        <P dim style={styles.cardText}>
          {t('home.shop.blurb')}
        </P>
      )}
      <View style={styles.cardFoot}>
        <Button testID="open-shop-card" title={t('home.shop.open')} kind="gold" small={compact} large={tablet} onPress={() => app.go({ name: 'shop' })} />
      </View>
    </ModeCard>
  );

  // Wait for the saved profile and the age answer before choosing what to show.
  if (!app.loaded || !gate.loaded) return null;
  const gateState = gateFor('home', gate.status, needsName);
  if (gateState === 'blocked') return <AgeBlocked />;
  if (gateState === 'ask') return <AgeGate />;
  // Once, after the age gate: may the app send usage statistics and crash reports? Off until the player says yes.
  if (asksConsent) {
    if (!consentState.loaded) return null;
    if (gate.status === 'allowed' && shouldAskConsent(consentState.record, telemetryAvailable)) return <ConsentQuestion />;
  }

  return (
    <ScrollView contentContainerStyle={[styles.wrap, wide && { paddingTop: 8 }, tablet && { padding: 28, gap: 22 }]}>
      {/* Top bar: profile, logo, gems, settings */}
      <View style={styles.topBar}>
        {needsName ? (
          <View style={{ flex: 1 }} />
        ) : (
          <Pressable onPress={() => app.go({ name: 'settings' })} hitSlop={slopFor(50)} style={({ pressed }) => [styles.profile, pressed && { transform: [{ translateY: 2 }] }, { flex: wide ? undefined : 1 }]} accessibilityRole="button" accessibilityLabel={`${app.profile.name}. ${t('settings.title')}`}>
            <AvatarPlate id={app.profile.avatar} size={tablet ? 54 : 44} frame={frame} />
            <View style={{ flexShrink: 1 }}>
              <Text numberOfLines={1} style={[styles.profileName, nameFont(shownName)]}>
                {shownName}
              </Text>
              <Text numberOfLines={wide ? 1 : 2} style={styles.profileMeta}>
                {t('home.profile.meta', { hands: app.progress.handsPlayed, wins: winRate === null ? t('home.profile.noWins') : t('home.profile.winRate', { rate: winRate }) })}
              </Text>
            </View>
          </Pressable>
        )}
        {wide && (
          <View style={styles.logoMid}>
            <Logo size={tablet ? 1.15 : 0.82} />
          </View>
        )}
        <Row gap={10} style={wide ? { flex: needsName ? 1 : undefined, justifyContent: 'flex-end' } : undefined}>
          <GemCounter testID="open-shop" amount={gems} owed={gemsOwed} onPress={() => app.go({ name: 'shop' })} />
          <IconButton icon="cog" kind="ghost" size={42} testID="open-settings" onPress={() => app.go({ name: 'settings' })} />
        </Row>
      </View>

      {!wide && (
        <View style={{ alignItems: 'center', paddingVertical: 6 }}>
          <Logo size={1.25} />
        </View>
      )}

      {gemsOwed > 0 && (
        <Pressable testID="home-diamonds-owed" onPress={() => app.go({ name: 'shop' })} hitSlop={slopFor(30)} accessibilityRole="button" accessibilityLabel={t('home.shop.owed', { n: gemsOwed.toLocaleString() })} style={{ alignSelf: wide ? 'flex-end' : 'center', maxWidth: '100%' }}>
          <Pill tone="gold" icon="gem" wrap text={t('home.shop.owed', { n: gemsOwed.toLocaleString() })} />
        </Pressable>
      )}

      <NameRefusedNotice />

      {needsName && (
        <Card style={wide ? { flexDirection: 'row', alignItems: 'center', gap: space.lg } : undefined}>
          <Row gap={14} style={{ flexShrink: 0 }}>
            <AvatarPlate id={app.profile.avatar} size={wide ? 80 : 60} frame={frame} />
            {!wide && (
              <View>
                <Text style={[styles.welcomeTitle, fontFor(t('home.welcome.title'), fonts.display)]}>{t('home.welcome.title')}</Text>
                <P dim style={{ fontSize: 13 }}>
                  {t('home.welcome.sub')}
                </P>
              </View>
            )}
          </Row>
          <View style={{ flex: wide ? 1 : undefined, gap: 8 }}>
            {wide && (
              <Row gap={10}>
                <Text style={[styles.welcomeTitle, fontFor(t('home.welcome.title'), fonts.display)]}>{t('home.welcome.title')}</Text>
                <P dim style={{ fontSize: 13 }}>
                  {t('home.welcome.sub')}
                </P>
              </Row>
            )}
            <Row gap={10}>
              <TextInput testID="name-input" value={name} onChangeText={setName} placeholder={t('home.welcome.namePlaceholder')} placeholderTextColor="#9AA0BF" style={[styles.input, { flex: 1, minWidth: 0 }, wide && { paddingVertical: 7 }]} maxLength={24} />
              <Button testID="save-name" small={!wide} title={t('common.save')} onPress={saveName} disabled={!name.trim()} />
              {/* First run: Play sits right here in landscape, where the mode cards are below the fold. */}
              {(wide || landscape) && <Button testID="start-match" title={t('home.welcome.play')} icon="play" onPress={playBots} />}
            </Row>
            <Row style={{ flexWrap: 'wrap', rowGap: 8 }} gap={wide ? 4 : 8}>
              {AVATARS.map((a) => (
                <Pressable key={a} onPress={() => app.setProfile({ ...app.profile, avatar: a })} hitSlop={2} style={[styles.pick, app.profile.avatar === a && styles.pickOn]} accessibilityRole="button" accessibilityLabel={avatarName(a)} accessibilityState={{ selected: app.profile.avatar === a }}>
                  <AvatarPlate id={a} size={wide ? 36 : 34} />
                </Pressable>
              ))}
            </Row>
            {/* Narrow phones (the iPhone SE size included): a full-width Play under the buddies, still above the fold. */}
            {!wide && !landscape && <Button testID="start-match" title={t('home.welcome.play')} icon="play" onPress={playBots} />}
          </View>
        </Card>
      )}

      {app.activeSession && (!app.session || liveTable) && (
        <Card tone="gold" testID="resume-card" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.md }}>
          <Icon name="hourglass" size={34} />
          <View style={{ flex: 1, minWidth: 170 }}>
            <Text style={[styles.resumeTitle, fontFor(t('home.resume.title'), fonts.display)]}>{t('home.resume.title')}</Text>
            <P dim style={{ fontSize: 13 }} numberOfLines={2}>
              {app.activeSession.kind === 'local'
                ? t('home.resume.local', { hand: app.activeSession.host.snapshot.handNumber + 1 })
                : app.activeSession.quickMatch
                  ? // A quick-match table has no code anyone can use (src/logic/lobby.ts): the card names the kind of table.
                    t('home.resume.quick')
                  : `${t('home.resume.online', { code: app.activeSession.roomCode })}${app.activeSession.clubCode ? t('home.resume.club', { code: app.activeSession.clubCode }) : ''}`}
            </P>
            {resumeError && <P style={{ color: colors.dangerText, fontSize: 12 }}>{resumeError}</P>}
          </View>
          <Button testID="resume-table" title={resuming ? t('home.resume.reconnecting') : t('home.resume.resume')} onPress={() => void resume()} disabled={resuming} />
          <Button
            small
            kind="ghost"
            title={t('home.resume.discard')}
            onPress={() => {
              if (liveTable) app.setSession(null);
              app.setActiveSession(null);
            }}
          />
        </Card>
      )}

      {wide ? (
        <View style={tablet ? { flexGrow: 1, justifyContent: 'center', paddingBottom: 30 } : undefined}>
          <View style={[styles.cardsRow, tablet && { gap: 18 }]}>
            {playCard}
            {clubsCard}
            {learnCard}
            {shopCard}
          </View>
        </View>
      ) : (
        <View style={{ gap: space.lg, flexGrow: 1, justifyContent: 'center', paddingBottom: 24 }}>
          {playCard}
          <View style={styles.cardsRow}>
            {clubsCard}
            {learnCard}
            {shopCard}
          </View>
        </View>
      )}
      <ConfirmSheet testID="replace-table" visible={askReplace} title={t('home.replace.title')} body={t('home.replace.body')} yes={t('home.replace.yes')} no={t('home.replace.no')} onYes={startBots} onNo={() => setAskReplace(false)} />
    </ScrollView>
  );
}

function ModeCard({
  colorsPair,
  windowH,
  scene,
  title,
  children,
  style,
  compact,
  horizontal,
  badge,
}: {
  colorsPair: readonly [string, string];
  windowH: number;
  scene: React.ReactNode;
  title: string;
  children: React.ReactNode;
  style?: object;
  compact?: boolean;
  horizontal?: boolean;
  badge?: React.ReactNode;
}) {
  const window = (
    <View style={[styles.window, horizontal ? { width: 156, alignSelf: 'stretch', minHeight: 150 } : { height: windowH }]}>
      <LinearGradient colors={colorsPair} style={StyleSheet.absoluteFill} />
      <View style={styles.windowShine} />
      <View style={{ position: 'absolute', left: 4, right: 4, top: 4, bottom: 4 }}>{scene}</View>
    </View>
  );
  return (
    <Card style={[{ padding: compact ? 8 : 10, gap: compact ? 6 : 8 }, horizontal && { flexDirection: 'row', gap: 12 }, style]}>
      {window}
      <View style={{ flex: 1, gap: compact ? 6 : 8, paddingHorizontal: compact ? 0 : 4, paddingBottom: 2 }}>
        <Text numberOfLines={1} style={[styles.cardTitle, fontFor(title, fonts.display), compact && { fontSize: 18, textAlign: 'center' }]}>
          {title}
        </Text>
        {children}
      </View>
      {badge && <View style={styles.badgeSpot}>{badge}</View>}
    </Card>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md, flexGrow: 1 },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: space.md, justifyContent: 'space-between' },
  logoMid: { flex: 1, alignItems: 'center' },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'rgba(16,20,47,0.55)', borderWidth: 3, borderColor: colors.ink, borderRadius: 999, paddingLeft: 3, paddingRight: 16, paddingVertical: 3, minWidth: 0, maxWidth: 260 },
  profileName: { color: '#FFFFFF', fontSize: 16 },
  profileMeta: { color: '#CFE9FF', fontSize: 11, fontFamily: fonts.ui },
  cardsRow: { flexDirection: 'row', gap: space.md, alignItems: 'stretch' },
  window: { borderWidth: 3, borderColor: colors.ink, borderRadius: 16, overflow: 'hidden' },
  windowShine: { position: 'absolute', top: -40, left: -20, width: 120, height: 120, borderRadius: 60, backgroundColor: 'rgba(255,255,255,0.35)' },
  cardTitle: { fontFamily: fonts.display, color: colors.ink, fontSize: 22, letterSpacing: 0.3 },
  cardText: { fontSize: 12, lineHeight: 16 },
  cardFoot: { marginTop: 'auto', gap: 8, paddingTop: 2 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center', minHeight: LINK_HEIGHT },
  linkText: { fontFamily: fonts.uiBold, color: colors.infoShelf, fontSize: 14, textDecorationLine: 'underline' },
  notify: { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.danger, borderWidth: 3, borderColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  notifyText: { color: '#FFFFFF', fontFamily: fonts.display, fontSize: 15 },
  badgeSpot: { position: 'absolute', top: 4, right: 4 },
  welcomeTitle: { fontFamily: fonts.display, color: colors.ink, fontSize: 26 },
  input: { backgroundColor: '#FFFFFF', color: colors.ink, borderWidth: 3, borderColor: colors.ink, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, fontSize: 18, fontFamily: fonts.uiBold },
  pick: { borderRadius: 999, padding: 2, borderWidth: 3, borderColor: 'transparent' },
  pickOn: { borderColor: colors.gold, backgroundColor: colors.gold },
  resumeTitle: { fontFamily: fonts.display, color: colors.ink, fontSize: 19 },
});
