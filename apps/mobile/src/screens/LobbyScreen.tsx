import React, { useEffect } from 'react';
import { ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { useApp } from '../app-state';
import { useSession } from '../game/useTable';
import { colors, fonts, nameFont, space } from '../theme';
import { Button, Card, H2, P, Pill, Row, ScreenHeader, StrokeText } from '../components/Ui';
import { AvatarPlate, seatAvatarId } from '../components/Avatars';
import { Icon } from '../components/Icons';

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
        <Card style={{ alignItems: 'center' }}>
          <H2>No table</H2>
          <Button title="Back" onPress={app.back} />
        </Card>
      </View>
    );
  }

  // Online tables run on the game server and have no host player, so every seated human may start or add bots.
  const localHost = session.mode === 'local' ? session.host : null;
  const humans = state.seats.filter((s) => s.peerId && !s.isBot).length;
  const addBot = () => (localHost ? localHost.addBot() : session.client.requestBot());
  const start = () => (localHost ? localHost.start() : session.client.requestStart());

  const leave = () => {
    app.setSession(null);
    app.setActiveSession(null);
    app.reset({ name: 'home' });
  };

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <ScreenHeader title={`Table ${session.roomCode}`} onBack={leave} />
      <View style={styles.cols}>
        <Card style={[styles.col, { alignItems: 'center' }]}>
          <P dim>Share this code</P>
          <View style={styles.codeBox}>
            <StrokeText style={styles.code} strokeWidth={2.5} drop={2.5}>
              {session.roomCode}
            </StrokeText>
          </View>
          <Row style={{ flexWrap: 'wrap', justifyContent: 'center', rowGap: 6 }}>
            <Button small kind="secondary" icon="share" title="Share" onPress={() => void Share.share({ message: `Join my Mahjong Madness table: ${session.roomCode}` })} />
            <Pill text={session.mode === 'online' ? 'Server table' : 'On this device'} icon="shield" tone="gold" />
          </Row>
        </Card>
        <Card style={styles.col}>
          <H2>Seats</H2>
          {state.seats.map((s) => {
            const empty = !s.peerId && !s.isBot;
            return (
              <Row key={s.seat} style={styles.seat}>
                {empty ? (
                  <View style={styles.emptySeat}>
                    <Icon name="plus" size={20} color="#C9CFE3" />
                  </View>
                ) : (
                  <AvatarPlate id={seatAvatarId(s, s.seat)} size={40} />
                )}
                <Text style={[styles.seatName, nameFont(s.name || 'Bot'), empty && { color: colors.inkDim }]} numberOfLines={1}>
                  {s.name || (s.isBot ? 'Bot' : 'Empty — waiting for a friend')}
                </Text>
                {s.isBot && <Icon name="bot" size={22} />}
                {s.seat === state.seat && <Pill text="you" tone="gold" size="sm" />}
                {s.isBot && localHost && <Button small kind="ghost" title="Remove" onPress={() => localHost.removeBot(s.seat)} />}
              </Row>
            );
          })}
          <Row style={{ flexWrap: 'wrap', rowGap: 6 }}>
            <Button small kind="secondary" icon="bot" title="Add bot" onPress={addBot} />
            <P dim style={{ fontSize: 12, flexShrink: 1 }}>
              Empty seats are filled with bots when you start.
            </P>
          </Row>
        </Card>
      </View>
      <Button large title={humans > 1 ? 'Start match' : 'Start (bots fill empty seats)'} icon="play" onPress={start} style={{ alignSelf: 'center' }} />
      {state.disconnected && <Pill tone="danger" icon="warning" text="Connection lost. Go back to Home and tap Resume." />}
      {state.lastError && <Pill tone="danger" icon="warning" text={state.lastError} />}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  cols: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  col: { flexGrow: 1, flexBasis: '45%', minWidth: 260 },
  codeBox: { backgroundColor: colors.info, borderWidth: 3, borderColor: colors.ink, borderRadius: 18, paddingHorizontal: 22, paddingVertical: 6, borderBottomWidth: 7 },
  code: { fontSize: 44, letterSpacing: 8, fontFamily: fonts.display },
  seat: { paddingVertical: 6, borderBottomWidth: 2, borderBottomColor: colors.creamDeep },
  seatName: { flex: 1, color: colors.ink, fontSize: 15 },
  emptySeat: { width: 40, height: 40, borderRadius: 20, borderWidth: 3, borderStyle: 'dashed', borderColor: colors.creamShelf, alignItems: 'center', justifyContent: 'center' },
});
