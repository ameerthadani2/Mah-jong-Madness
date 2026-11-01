import React, { useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useApp } from '../app-state';
import { createOnlineSession } from '../game/session';
import { colors, space } from '../theme';
import { Button, Card, H1, H2, P, Row, Toggle } from '../components/Ui';

export function OnlineScreen() {
  const app = useApp();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hosted, setHosted] = useState(app.settings.hostedTables);

  const run = async (action: 'create' | 'join') => {
    setBusy(action);
    setError(null);
    try {
      const session = await createOnlineSession({
        signalUrl: app.settings.signalUrl,
        name: app.profile.name || 'Player',
        avatar: app.profile.avatar,
        rules: app.settings.rules,
        action,
        code: code.trim().toUpperCase(),
        hostedByServer: hosted,
      });
      app.setSession(session);
      app.go({ name: 'lobby' });
    } catch (e) {
      setError((e as Error).message || 'Could not connect');
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Row style={{ justifyContent: 'space-between' }}>
        <H1>Club</H1>
        <Button small kind="ghost" title="Back" onPress={app.back} />
      </Row>
      <P dim>
        Tables are hosted peer to peer: the phone that creates the table runs the game and every player audits each hand. Share the 6-letter code by any chat app.
      </P>
      <View style={styles.cols}>
        <Card style={styles.col}>
          <H2>Create a table</H2>
          <P dim style={{ fontSize: 13 }}>
            底 {app.settings.rules.basePoints} / 台 {app.settings.rules.taiPoints} · {app.settings.rules.handsPerMatch} dealer rotations · {app.settings.rules.turnSeconds}s per move
          </P>
          <Toggle label="Neutral server hosts the table" value={hosted} onChange={setHosted} />
          <P dim style={{ fontSize: 12 }}>
            {hosted ? 'The signaling server deals and referees; no player can peek at the wall.' : 'Your phone deals and referees. Fastest, works on a shared Wi-Fi.'}
          </P>
          <Button title={busy === 'create' ? 'Creating…' : 'Create table'} onPress={() => void run('create')} disabled={busy !== null} />
        </Card>
        <Card style={styles.col}>
          <H2>Join with a code</H2>
          <TextInput value={code} onChangeText={(t) => setCode(t.toUpperCase())} autoCapitalize="characters" placeholder="ABC123" placeholderTextColor={colors.textDim} style={styles.input} maxLength={8} />
          <Button title={busy === 'join' ? 'Joining…' : 'Join table'} kind="secondary" onPress={() => void run('join')} disabled={busy !== null || code.trim().length < 4} />
        </Card>
      </View>
      {error && (
        <Card style={{ borderColor: colors.danger, borderWidth: 1 }}>
          <P>{error}</P>
          <P dim style={{ fontSize: 12 }}>
            Signaling server: {app.settings.signalUrl}. Change it in Settings, or run `npm run signal` on a laptop on the same network.
          </P>
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md },
  cols: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  col: { flexGrow: 1, flexBasis: '45%', minWidth: 240 },
  input: { backgroundColor: colors.panelStrong, color: colors.text, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 12, fontSize: 24, letterSpacing: 6, fontWeight: '800', textAlign: 'center' },
});
