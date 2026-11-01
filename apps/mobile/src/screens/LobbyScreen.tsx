import React, { useEffect } from 'react';
import { ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { useApp } from '../app-state';
import { useSession } from '../game/useTable';
import { colors, space } from '../theme';
import { Button, Card, H1, H2, P, Pill, Row } from '../components/Ui';

export function LobbyScreen() {
  const app = useApp();
  const session = app.session;
  const state = useSession(session);

  useEffect(() => {
    if (state?.view) app.go({ name: 'table' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.view]);

  if (!session || !state) {
    return (
      <View style={styles.center}>
        <P>No table.</P>
        <Button title="Back" onPress={app.back} />
      </View>
    );
  }

  const isHost = session.mode === 'host';
  const humans = state.seats.filter((s) => s.peerId && !s.isBot).length;

  const leave = () => {
    app.setSession(null);
    app.back();
  };

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Row style={{ justifyContent: 'space-between' }}>
        <H1>Table {session.roomCode}</H1>
        <Button small kind="ghost" title="Leave" onPress={leave} />
      </Row>
      <Card style={{ alignItems: 'center' }}>
        <P dim>Share this code</P>
        <Text style={styles.code}>{session.roomCode}</Text>
        <Row>
          <Button small kind="secondary" title="Share" onPress={() => void Share.share({ message: `Join my Mahjong Madness table: ${session.roomCode}` })} />
          <Pill text={session.transportKind === 'webrtc' ? 'Direct P2P' : session.transportKind === 'relay' ? 'Relay' : 'Local'} />
          <Pill text={session.mode === 'guest' ? 'Hosted elsewhere' : 'You host'} tone="gold" />
        </Row>
      </Card>
      <Card>
        <H2>Seats</H2>
        {state.seats.map((s) => (
          <Row key={s.seat} style={styles.seat}>
            <Text style={{ fontSize: 22 }}>{s.avatar ?? (s.isBot ? '🤖' : s.peerId ? '🀄' : '▫️')}</Text>
            <P style={{ flex: 1 }}>{s.name || (s.isBot ? 'Bot' : 'Empty — waiting for a friend')}</P>
            {s.seat === state.seat && <Pill text="you" tone="gold" />}
            {s.isBot && isHost && <Button small kind="ghost" title="Remove" onPress={() => session.host!.removeBot(s.seat)} />}
          </Row>
        ))}
        {isHost && (
          <Row>
            <Button small kind="secondary" title="Add bot" onPress={() => session.host!.addBot()} />
            <P dim style={{ fontSize: 12 }}>Empty seats are filled with bots when you start.</P>
          </Row>
        )}
      </Card>
      {isHost ? (
        <Button title={humans > 1 ? 'Start match' : 'Start (bots fill empty seats)'} onPress={() => session.host!.start()} />
      ) : (
        <P dim style={{ textAlign: 'center' }}>
          Waiting for the host to start…
        </P>
      )}
      {state.lastError && <P style={{ color: colors.danger }}>{state.lastError}</P>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  code: { color: colors.gold, fontSize: 44, fontWeight: '900', letterSpacing: 10 },
  seat: { paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.textDim },
});
