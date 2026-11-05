import React, { useEffect } from 'react';
import { ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { useApp } from '../app-state';
import { useConnection, useSession } from '../game/useTable';
import { useT } from '../i18n';
import { friendlyError } from '../logic/errors';
import { colors, fonts, nameFont, space } from '../theme';
import { Button, Card, H2, P, Pill, Row, ScreenHeader, StrokeText } from '../components/Ui';
import { AvatarPlate, seatAvatarId } from '../components/Avatars';
import { Icon } from '../components/Icons';

export function LobbyScreen() {
  const app = useApp();
  const { t } = useT();
  const session = app.session;
  const state = useSession(session);
  const conn = useConnection(session);

  useEffect(() => {
    if (state?.view) app.go({ name: 'table' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.view]);

  if (!session || !state) {
    return (
      <View style={styles.center}>
        <Card style={{ alignItems: 'center' }}>
          <H2>{t('lobby.noTable')}</H2>
          <Button title={t('common.back')} onPress={app.back} />
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
      <ScreenHeader title={t('lobby.title', { code: session.roomCode })} onBack={leave} />
      <View style={styles.cols}>
        <Card style={[styles.col, { alignItems: 'center' }]}>
          <P dim>{t('lobby.shareCode')}</P>
          <View style={styles.codeBox}>
            <StrokeText style={styles.code} strokeWidth={2.5} drop={2.5}>
              {session.roomCode}
            </StrokeText>
          </View>
          <Row style={{ flexWrap: 'wrap', justifyContent: 'center', rowGap: 6 }}>
            <Button small kind="secondary" icon="share" title={t('lobby.share')} onPress={() => void Share.share({ message: t('lobby.shareMessage', { code: session.roomCode }) })} />
            <Pill text={session.mode === 'online' ? t('lobby.serverTable') : t('lobby.onDevice')} icon="shield" tone="gold" />
          </Row>
        </Card>
        <Card style={styles.col}>
          <H2>{t('lobby.seats')}</H2>
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
                <Text style={[styles.seatName, nameFont(s.name || (s.isBot ? t('common.bot') : t('lobby.emptySeat'))), empty && { color: colors.inkDim }]} numberOfLines={1}>
                  {s.name || (s.isBot ? t('common.bot') : t('lobby.emptySeat'))}
                </Text>
                {s.isBot && <Icon name="bot" size={22} />}
                {s.seat === state.seat && <Pill text={t('common.you')} tone="gold" size="sm" />}
                {s.isBot && localHost && <Button small kind="ghost" title={t('lobby.remove')} onPress={() => localHost.removeBot(s.seat)} />}
              </Row>
            );
          })}
          <Row style={{ flexWrap: 'wrap', rowGap: 6 }}>
            <Button small kind="secondary" icon="bot" title={t('lobby.addBot')} onPress={addBot} />
            <P dim style={{ fontSize: 12, flexShrink: 1 }}>
              {t('lobby.fillHint')}
            </P>
          </Row>
        </Card>
      </View>
      <Button large title={humans > 1 ? t('lobby.start') : t('lobby.startWithBots')} icon="play" onPress={start} style={{ alignSelf: 'center' }} />
      {conn.status === 'reconnecting' ? (
        <Row style={{ flexWrap: 'wrap', rowGap: 6, alignItems: 'center' }} gap={8}>
          <Pill tone="gold" icon="hourglass" text={t('lobby.reconnecting', { n: conn.attempt })} />
          <Button small title={t('lobby.retryNow')} onPress={() => session.retryNow()} />
        </Row>
      ) : conn.status === 'lost' || state.disconnected ? (
        // Leaving via the header would forget the table; this path keeps the saved record so Home can resume it.
        <Row style={{ flexWrap: 'wrap', rowGap: 6, alignItems: 'center' }} gap={8}>
          <Pill tone="danger" icon="warning" text={t(conn.reason === 'gone' ? 'lobby.tableGone' : 'lobby.connectionLost')} />
          <Button
            small
            title={t(conn.reason === 'gone' ? 'common.back' : 'lobby.reconnect')}
            onPress={() => {
              // A table the server no longer has cannot be resumed: drop the saved record with the session.
              if (conn.reason === 'gone') app.setActiveSession(null);
              app.setSession(null);
              app.reset({ name: 'home' });
            }}
          />
        </Row>
      ) : (
        state.lastError && <Pill tone="danger" icon="warning" text={friendlyError(new Error(state.lastError), t)} />
      )}
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
