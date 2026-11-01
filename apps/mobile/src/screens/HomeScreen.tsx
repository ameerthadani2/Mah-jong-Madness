import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { BOT_SKILLS, describeRules, type BotSkill } from '@mjm/engine';
import { hasTier } from '../monetisation/store';
import { useApp } from '../app-state';
import { createLocalSession, createOnlineSession } from '../game/session';
import { AVATARS, effectiveStreak, todayKey } from '../storage';
import { colors, space } from '../theme';
import { Button, Card, H1, P, Pill, Row } from '../components/Ui';

export function HomeScreen() {
  const app = useApp();
  const [name, setName] = useState(app.profile.name);
  const needsName = !app.profile.name;

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
      setResumeError((e as Error).message || 'Could not reconnect');
    } finally {
      setResuming(false);
    }
  };

  const winRate = app.progress.handsPlayed ? Math.round((app.progress.handsWon / app.progress.handsPlayed) * 100) : null;
  const dailyDone = app.progress.dailySolved[todayKey()] !== undefined;
  const streak = effectiveStreak(app.progress);
  const avgAccuracy = app.progress.reviewAccuracies.length ? Math.round(app.progress.reviewAccuracies.reduce((a, b) => a + b, 0) / app.progress.reviewAccuracies.length) : null;

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <View style={styles.hero}>
        <Text style={styles.logo}>🀄</Text>
        <H1>Mahjong Madness</H1>
        <P dim>台灣十六張麻將 · Taiwanese 16-tile · Play with friends, peer to peer</P>
      </View>

      {needsName ? (
        <Card>
          <P>Pick a name and avatar</P>
          <TextInput testID="name-input" value={name} onChangeText={setName} placeholder="Your name" placeholderTextColor={colors.textDim} style={styles.input} maxLength={24} />
          <Row style={{ flexWrap: 'wrap' }}>
            {AVATARS.map((a) => (
              <Text key={a} onPress={() => app.setProfile({ ...app.profile, avatar: a })} style={[styles.avatar, app.profile.avatar === a && styles.avatarOn]}>
                {a}
              </Text>
            ))}
          </Row>
          <Button testID="save-name" title="Save" onPress={saveName} disabled={!name.trim()} />
        </Card>
      ) : (
        <Card style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Row>
            <Text style={{ fontSize: 28 }}>{app.profile.avatar}</Text>
            <View>
              <Text style={{ color: colors.ink, fontWeight: '900', fontSize: 16 }}>{app.profile.name}</Text>
              <P dim style={{ fontSize: 12 }}>
                {app.progress.handsPlayed} hands · {winRate === null ? 'no wins yet' : `${winRate}% win rate`}
              </P>
            </View>
          </Row>
          <Row>
            <Button testID="open-shop" small kind="ghost" title={`💎 ${app.wallet.diamonds + app.wallet.bonusDiamonds}`} onPress={() => app.go({ name: 'shop' })} />
            <Button small kind="ghost" title="Edit" onPress={() => app.go({ name: 'settings' })} />
          </Row>
        </Card>
      )}

      {app.activeSession && !app.session && (
        <Card style={{ borderColor: colors.gold, borderWidth: 1 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.tileTitle}>Table in progress</Text>
              <P dim style={styles.tileText}>
                {app.activeSession.kind === 'local' ? `Offline match vs bots · hand ${app.activeSession.host.snapshot.handNumber + 1}` : `Online table ${app.activeSession.roomCode}${app.activeSession.clubCode ? ` · club ${app.activeSession.clubCode}` : ''}`}
              </P>
              {resumeError && <P style={{ color: colors.danger, fontSize: 12 }}>{resumeError}</P>}
            </View>
            <Row>
              <Button title={resuming ? 'Reconnecting…' : 'Resume'} onPress={() => void resume()} disabled={resuming} />
              <Button small kind="ghost" title="Discard" onPress={() => app.setActiveSession(null)} />
            </Row>
          </Row>
        </Card>
      )}

      <View style={styles.grid}>
        <Card style={styles.tile}>
          <Text style={styles.tileIcon}>🤖</Text>
          <Text style={styles.tileTitle}>Play vs Bots</Text>
          <P dim style={styles.tileText}>{describeRules(app.settings.rules)}</P>
          <Row style={{ flexWrap: 'wrap' }}>
            {(Object.keys(BOT_SKILLS) as BotSkill[]).map((k) => {
              const locked = k === 'pro' && !hasTier(app.wallet, 'gold');
              return (
                <Text key={k} onPress={() => (locked ? app.go({ name: 'shop' }) : app.setSettings({ ...app.settings, botSkill: k }))} style={[styles.chip, app.settings.botSkill === k && styles.chipOn]}>
                  {locked ? '🔒 ' : ''}
                  {BOT_SKILLS[k].label} · {BOT_SKILLS[k].rating}
                </Text>
              );
            })}
          </Row>
          <Button testID="start-match" title="Start match" onPress={playBots} />
        </Card>
        <Card style={styles.tile}>
          <Text style={styles.tileIcon}>👥</Text>
          <Text style={styles.tileTitle}>Clubs & Friends</Text>
          <P dim style={styles.tileText}>Create a club with your rules, or open a quick table and share the code.</P>
          <Row>
            <Button testID="open-clubs" title="My clubs" kind="secondary" onPress={() => (needsName ? saveName() : undefined) ?? app.go({ name: 'clubs' })} />
            <Button small kind="ghost" title="Quick table" onPress={() => (needsName ? saveName() : undefined) ?? app.go({ name: 'online' })} />
          </Row>
        </Card>
        <Card style={styles.tile}>
          <Text style={styles.tileIcon}>🧩</Text>
          <Text style={styles.tileTitle}>Daily puzzle</Text>
          <P dim style={styles.tileText}>One best-discard puzzle a day, same for everyone.</P>
          <Row style={{ justifyContent: 'space-between' }}>
            <Pill text={`🔥 ${streak} streak`} tone={streak > 0 ? 'gold' : 'neutral'} />
            <Button small kind={dailyDone ? 'ghost' : 'primary'} title={dailyDone ? 'Done ✓' : 'Solve'} onPress={() => app.go({ name: 'daily' })} />
          </Row>
        </Card>
        <Card style={styles.tile}>
          <Text style={styles.tileIcon}>🎓</Text>
          <Text style={styles.tileTitle}>Learn</Text>
          <P dim style={styles.tileText}>Lessons, Puzzle Rush, drills and hand reviews{avgAccuracy !== null ? ` · ${avgAccuracy}% review accuracy` : ''}.</P>
          <Row style={{ justifyContent: 'space-between' }}>
            <Pill text={`${Object.keys(app.progress.lessonsDone).length}/6 lessons`} tone="gold" />
            <Button testID="open-learn" small kind="secondary" title="Open" onPress={() => app.go({ name: 'learn' })} />
          </Row>
        </Card>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.lg },
  hero: { alignItems: 'center', gap: 4 },
  logo: { fontSize: 48 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  tile: { flexGrow: 1, flexBasis: '45%', minWidth: 220 },
  tileIcon: { fontSize: 28 },
  tileTitle: { color: colors.ink, fontWeight: '900', fontSize: 17 },
  tileText: { fontSize: 13 },
  input: { backgroundColor: '#FFFFFF', color: colors.ink, borderWidth: 3, borderColor: colors.creamEdge, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  avatar: { fontSize: 26, padding: 4, borderRadius: 8 },
  avatarOn: { backgroundColor: colors.gold, borderWidth: 2, borderColor: colors.goldDim },
  chip: { color: colors.ink, backgroundColor: colors.cream, borderWidth: 2, borderColor: colors.creamEdge, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, fontSize: 12, fontWeight: '800', overflow: 'hidden' },
  chipOn: { backgroundColor: colors.gold, borderColor: colors.goldDim, color: colors.ink },
});
