import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BOT_SKILLS, describeRules, type BotSkill } from '@mjm/engine';
import { hasTier } from '../monetisation/store';
import { useApp } from '../app-state';
import { createLocalSession, createOnlineSession } from '../game/session';
import { AVATARS, effectiveStreak, todayKey } from '../storage';
import { friendlyError } from '../logic/errors';
import { colors, fonts, nameFont, space } from '../theme';
import { Button, Card, Chip, GemCounter, IconButton, P, Pill, Row } from '../components/Ui';
import { AvatarPlate } from '../components/Avatars';
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
  const { width, height } = useWindowDimensions();
  const [name, setName] = useState(app.profile.name);
  const needsName = !app.profile.name;
  const wide = width >= 700;
  const tablet = width >= 1000 && height >= 700;

  const saveName = () => app.setProfile({ ...app.profile, name: name.trim() || 'Player' });

  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const playBots = () => {
    if (needsName) saveName();
    const session = createLocalSession(app.profile.name || name.trim() || 'Player', app.profile.avatar, app.settings.rules, { botSkill: app.settings.botSkill });
    app.setSession(session);
    session.host!.start();
    app.go({ name: 'table' });
  };

  const resume = async () => {
    const rec = app.activeSession;
    if (!rec) return;
    setResuming(true);
    setResumeError(null);
    try {
      if (rec.kind === 'local') {
        const session = createLocalSession(rec.name, rec.avatar, rec.host.rules, { restore: { host: rec.host, token: rec.token } });
        app.setSession(session);
        app.go({ name: 'table' });
      } else {
        const session = await createOnlineSession({ signalUrl: rec.signalUrl, name: rec.name, avatar: rec.avatar, userId: app.profile.userId, rules: app.settings.rules, action: 'join', code: rec.roomCode, token: rec.token, clubCode: rec.clubCode });
        app.setSession(session);
        app.go({ name: 'lobby' });
      }
    } catch (e) {
      setResumeError(friendlyError(e));
    } finally {
      setResuming(false);
    }
  };

  const winRate = app.progress.handsPlayed ? Math.round((app.progress.handsWon / app.progress.handsPlayed) * 100) : null;
  const dailyDone = app.progress.dailySolved[todayKey()] !== undefined;
  const streak = effectiveStreak(app.progress);
  const lessonsDone = Object.keys(app.progress.lessonsDone).length;
  const gems = app.wallet.diamonds + app.wallet.bonusDiamonds;
  const goClubs = () => {
    if (needsName) saveName();
    app.go({ name: 'clubs' });
  };
  const goOnline = () => {
    if (needsName) saveName();
    app.go({ name: 'online' });
  };

  const phoneLand = wide && !tablet;
  const windowH = tablet ? Math.min(250, Math.round(height * 0.28)) : wide ? Math.max(70, Math.min(150, Math.round(height * 0.22))) : 104;
  const smallWindow = tablet ? windowH : wide ? windowH : 100;

  const skillChips = (
    <Row style={{ flexWrap: 'wrap', rowGap: 6 }} gap={6}>
      {(Object.keys(BOT_SKILLS) as BotSkill[]).map((k) => {
        const locked = k === 'pro' && !hasTier(app.wallet, 'gold');
        return <Chip key={k} label={BOT_SKILLS[k].label.replace(' player', '')} selected={app.settings.botSkill === k} locked={locked} onPress={() => (locked ? app.go({ name: 'shop' }) : app.setSettings({ ...app.settings, botSkill: k }))} />;
      })}
    </Row>
  );

  const playCard = (
    <ModeCard key="play" colorsPair={WINDOWS.play} windowH={windowH} scene={<TableScene width="100%" height="100%" />} title="Play vs Bots" style={wide ? { flex: 1.55 } : undefined} horizontal={!wide}>
      <P dim style={styles.cardText} numberOfLines={phoneLand ? 1 : 2}>
        {describeRules(app.settings.rules)}
      </P>
      {skillChips}
      <View style={styles.cardFoot}>
        <Button testID="start-match" title="Play now" icon="play" large={tablet} onPress={playBots} />
      </View>
    </ModeCard>
  );
  const compact = !wide;
  const clubsCard = (
    <ModeCard key="clubs" colorsPair={WINDOWS.clubs} windowH={smallWindow} scene={<ClubhouseScene width="100%" height="100%" />} title={tablet ? 'Clubs & Friends' : 'Clubs'} compact={compact} style={{ flex: 1 }}>
      {!compact && (
        <P dim style={styles.cardText} numberOfLines={2}>
          Your rules, your members. Share a code and play anywhere.
        </P>
      )}
      <View style={styles.cardFoot}>
        <Button testID="open-clubs" title="My clubs" kind="secondary" small={compact} large={tablet} onPress={goClubs} />
        {!compact && (
          <Pressable onPress={goOnline} hitSlop={6} style={styles.link}>
            <Icon name="users" size={18} />
            <Text style={styles.linkText}>Quick table</Text>
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
      title="Learn"
      compact={compact}
      style={{ flex: 1 }}
      badge={!dailyDone ? <View style={styles.notify}><Text style={styles.notifyText}>!</Text></View> : undefined}
    >
      {!compact && (
        <Row style={{ flexWrap: 'wrap', rowGap: 6 }} gap={6}>
          <Pill text={`${lessonsDone}/6 lessons`} icon="book" size="sm" />
          <Pill text={`${streak} day streak`} icon="flame" tone={streak > 0 ? 'gold' : 'neutral'} size="sm" />
        </Row>
      )}
      <View style={styles.cardFoot}>
        <Button testID="open-learn" title="Learn" kind="premium" small={compact} large={tablet} onPress={() => app.go({ name: 'learn' })} />
        {!compact && (
          <Pressable onPress={() => app.go({ name: 'daily' })} hitSlop={6} style={styles.link}>
            <Icon name={dailyDone ? 'check' : 'scroll'} size={18} color={colors.cta} />
            <Text style={styles.linkText}>{dailyDone ? 'Daily done' : 'Daily puzzle'}</Text>
          </Pressable>
        )}
      </View>
    </ModeCard>
  );
  const shopCard = (
    <ModeCard key="shop" colorsPair={WINDOWS.shop} windowH={smallWindow} scene={<ChestScene width="100%" height="100%" />} title="Shop" compact={compact} style={{ flex: 1 }}>
      {!compact && (
        <P dim style={styles.cardText} numberOfLines={2}>
          Table looks, coaching and gems. Never luck.
        </P>
      )}
      <View style={styles.cardFoot}>
        <Button title="Open" kind="gold" small={compact} large={tablet} onPress={() => app.go({ name: 'shop' })} />
      </View>
    </ModeCard>
  );

  return (
    <ScrollView contentContainerStyle={[styles.wrap, wide && { paddingTop: 8 }, tablet && { padding: 28, gap: 22 }]}>
      {/* Top bar: profile, logo, gems, settings */}
      <View style={styles.topBar}>
        {needsName ? (
          <View style={{ flex: 1 }} />
        ) : (
          <Pressable onPress={() => app.go({ name: 'settings' })} style={({ pressed }) => [styles.profile, pressed && { transform: [{ translateY: 2 }] }, { flex: wide ? undefined : 1 }]}>
            <AvatarPlate id={app.profile.avatar} size={tablet ? 54 : 44} />
            <View style={{ flexShrink: 1 }}>
              <Text numberOfLines={1} style={[styles.profileName, nameFont(app.profile.name)]}>
                {app.profile.name}
              </Text>
              <Text numberOfLines={1} style={styles.profileMeta}>
                {app.progress.handsPlayed} hands · {winRate === null ? 'no wins yet' : `${winRate}% wins`}
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
          <GemCounter testID="open-shop" amount={gems} onPress={() => app.go({ name: 'shop' })} />
          <IconButton icon="cog" kind="ghost" size={42} onPress={() => app.go({ name: 'settings' })} />
        </Row>
      </View>

      {!wide && (
        <View style={{ alignItems: 'center', paddingVertical: 6 }}>
          <Logo size={1.25} />
        </View>
      )}

      {needsName && (
        <Card style={wide ? { flexDirection: 'row', alignItems: 'center', gap: space.lg } : undefined}>
          <Row gap={14} style={{ flexShrink: 0 }}>
            <AvatarPlate id={app.profile.avatar} size={wide ? 80 : 60} />
            {!wide && (
              <View>
                <Text style={styles.welcomeTitle}>Welcome!</Text>
                <P dim style={{ fontSize: 13 }}>
                  Pick a name and a buddy.
                </P>
              </View>
            )}
          </Row>
          <View style={{ flex: wide ? 1 : undefined, gap: 8 }}>
            {wide && (
              <Row gap={10}>
                <Text style={styles.welcomeTitle}>Welcome!</Text>
                <P dim style={{ fontSize: 13 }}>
                  Pick a name and a buddy.
                </P>
              </Row>
            )}
            <Row gap={10}>
              <TextInput testID="name-input" value={name} onChangeText={setName} placeholder="Your name" placeholderTextColor="#9AA0BF" style={[styles.input, { flex: 1 }, wide && { paddingVertical: 7 }]} maxLength={24} />
              <Button testID="save-name" title="Save" onPress={saveName} disabled={!name.trim()} />
            </Row>
            <Row style={{ flexWrap: 'wrap', rowGap: 8 }} gap={wide ? 4 : 8}>
              {AVATARS.map((a) => (
                <Pressable key={a} onPress={() => app.setProfile({ ...app.profile, avatar: a })} hitSlop={2} style={[styles.pick, app.profile.avatar === a && styles.pickOn]}>
                  <AvatarPlate id={a} size={wide ? 36 : 40} />
                </Pressable>
              ))}
            </Row>
          </View>
        </Card>
      )}

      {app.activeSession && !app.session && (
        <Card tone="gold" style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Icon name="hourglass" size={34} />
          <View style={{ flex: 1 }}>
            <Text style={styles.resumeTitle}>Table in progress</Text>
            <P dim style={{ fontSize: 13 }} numberOfLines={2}>
              {app.activeSession.kind === 'local' ? `Offline match vs bots · hand ${app.activeSession.host.snapshot.handNumber + 1}` : `Online table ${app.activeSession.roomCode}${app.activeSession.clubCode ? ` · club ${app.activeSession.clubCode}` : ''}`}
            </P>
            {resumeError && <P style={{ color: colors.dangerText, fontSize: 12 }}>{resumeError}</P>}
          </View>
          <Button title={resuming ? 'Reconnecting…' : 'Resume'} onPress={() => void resume()} disabled={resuming} />
          <Button small kind="ghost" title="Discard" onPress={() => app.setActiveSession(null)} />
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
        <Text numberOfLines={1} style={[styles.cardTitle, compact && { fontSize: 18, textAlign: 'center' }]}>
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
  link: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center' },
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
