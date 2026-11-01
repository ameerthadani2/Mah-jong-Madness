import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useApp } from '../app-state';
import { createLocalSession } from '../game/session';
import { AVATARS } from '../storage';
import { colors, space } from '../theme';
import { Button, Card, H1, P, Pill, Row } from '../components/Ui';

export function HomeScreen() {
  const app = useApp();
  const [name, setName] = useState(app.profile.name);
  const needsName = !app.profile.name;

  const saveName = () => app.setProfile({ ...app.profile, name: name.trim() || 'Player' });

  const playBots = () => {
    if (needsName) saveName();
    const session = createLocalSession(app.profile.name || name.trim() || 'Player', app.profile.avatar, app.settings.rules);
    app.setSession(session);
    session.host!.start();
    app.go({ name: 'table' });
  };

  const winRate = app.progress.handsPlayed ? Math.round((app.progress.handsWon / app.progress.handsPlayed) * 100) : null;

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
          <TextInput value={name} onChangeText={setName} placeholder="Your name" placeholderTextColor={colors.textDim} style={styles.input} maxLength={24} />
          <Row style={{ flexWrap: 'wrap' }}>
            {AVATARS.map((a) => (
              <Text key={a} onPress={() => app.setProfile({ ...app.profile, avatar: a })} style={[styles.avatar, app.profile.avatar === a && styles.avatarOn]}>
                {a}
              </Text>
            ))}
          </Row>
          <Button title="Save" onPress={saveName} disabled={!name.trim()} />
        </Card>
      ) : (
        <Card style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Row>
            <Text style={{ fontSize: 28 }}>{app.profile.avatar}</Text>
            <View>
              <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>{app.profile.name}</Text>
              <P dim style={{ fontSize: 12 }}>
                {app.progress.handsPlayed} hands · {winRate === null ? 'no wins yet' : `${winRate}% win rate`}
              </P>
            </View>
          </Row>
          <Button small kind="ghost" title="Edit" onPress={() => app.go({ name: 'settings' })} />
        </Card>
      )}

      <View style={styles.grid}>
        <Card style={styles.tile}>
          <Text style={styles.tileIcon}>🤖</Text>
          <Text style={styles.tileTitle}>Play vs Bots</Text>
          <P dim style={styles.tileText}>Full match offline with the coach beside you.</P>
          <Button title="Start" onPress={playBots} />
        </Card>
        <Card style={styles.tile}>
          <Text style={styles.tileIcon}>👥</Text>
          <Text style={styles.tileTitle}>Play with Friends</Text>
          <P dim style={styles.tileText}>Create a table, share the code. Your phones host the game.</P>
          <Button title="Open Club" kind="secondary" onPress={() => (needsName ? saveName() : undefined) ?? app.go({ name: 'online' })} />
        </Card>
        <Card style={styles.tile}>
          <Text style={styles.tileIcon}>🎓</Text>
          <Text style={styles.tileTitle}>Learn</Text>
          <P dim style={styles.tileText}>Lessons, 台 counting and daily discard drills.</P>
          <Row style={{ justifyContent: 'space-between' }}>
            <Pill text={`${Object.keys(app.progress.lessonsDone).length}/6 lessons`} tone="gold" />
            <Button small kind="secondary" title="Open" onPress={() => app.go({ name: 'learn' })} />
          </Row>
        </Card>
        <Card style={styles.tile}>
          <Text style={styles.tileIcon}>⚙️</Text>
          <Text style={styles.tileTitle}>House Rules</Text>
          <P dim style={styles.tileText}>
            底 {app.settings.rules.basePoints} / 台 {app.settings.rules.taiPoints} · {app.settings.rules.turnSeconds}s turns
          </P>
          <Button small kind="ghost" title="Settings" onPress={() => app.go({ name: 'settings' })} />
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
  tileTitle: { color: colors.text, fontWeight: '900', fontSize: 17 },
  tileText: { fontSize: 13 },
  input: { backgroundColor: colors.panelStrong, color: colors.text, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  avatar: { fontSize: 26, padding: 4, borderRadius: 8 },
  avatarOn: { backgroundColor: colors.gold },
});
