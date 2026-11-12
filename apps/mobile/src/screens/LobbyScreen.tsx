import React, { useEffect } from 'react';
import { ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { useApp, useHardwareBack } from '../app-state';
import { useConnection, useSession } from '../game/useTable';
import { useT } from '../i18n';
import { tableError } from '../components/table/tableErrors';
import { colors, fonts, nameFont, space } from '../theme';
import { Button, Card, H2, P, Pill, Row, ScreenHeader, StrokeText } from '../components/Ui';
import { AvatarPlate, seatAvatarId } from '../components/Avatars';
import { Icon } from '../components/Icons';
import { APP_NAME, APP_SCHEMES, LINK_DOMAIN } from '../config';
import { tableLink } from '../push/deeplink';
import { lobbyControls } from '../logic/lobby';
import { forgetsTable, linkCopy, linkNotice } from '../logic/reconnect';

export function LobbyScreen() {
  const app = useApp();
  const { t } = useT();
  const session = app.session;
  const state = useSession(session);
  const conn = useConnection(session);

  // Android's Back key does what the header's Back arrow does: it never leaves the table open behind another screen.
  useHardwareBack(() => leave());

  useEffect(() => {
    if (state?.view) app.go({ name: 'table' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.view]);

  function leave() {
    app.setSession(null);
    app.setActiveSession(null);
    app.reset({ name: 'home' });
  }

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

  // A quick-match table is closed to everyone but the matched players and starts by itself (src/logic/lobby.ts).
  const controls = lobbyControls(session);
  // Rejoining, or why this device has stopped for good (src/logic/reconnect.ts).
  const notice = linkNotice(conn, state);
  // Online tables run on the game server and have no host player, so every seated human may start or add bots.
  const localHost = session.mode === 'local' ? session.host : null;
  const humans = state.seats.filter((s) => s.peerId && !s.isBot).length;
  const addBot = () => (localHost ? localHost.addBot() : session.client.requestBot());
  const start = () => (localHost ? localHost.start() : session.client.requestStart());

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <ScreenHeader title={controls.share ? t('lobby.title', { code: session.roomCode }) : t('lobby.quickTable')} onBack={leave} />
      <View style={styles.cols}>
        {!controls.share ? (
          // No code and no invite link here: nobody but the matched players can enter this table.
          <Card style={[styles.col, { alignItems: 'center', justifyContent: 'center' }]} testID="lobby-quick">
            <Icon name="users" size={36} color={colors.cta} />
            <H2>{t('lobby.quickTable')}</H2>
            <P dim style={{ textAlign: 'center' }}>
              {t('lobby.quickClosed')}
            </P>
            <Pill text={t('lobby.serverTable')} icon="shield" tone="gold" />
          </Card>
        ) : (
          <Card style={[styles.col, { alignItems: 'center' }]} testID="lobby-share">
            <P dim>{t('lobby.shareCode')}</P>
            <View style={styles.codeBox}>
              <StrokeText style={styles.code} strokeWidth={2.5} drop={2.5}>
                {session.roomCode}
              </StrokeText>
            </View>
            <Row style={{ flexWrap: 'wrap', justifyContent: 'center', rowGap: 6 }}>
              <Button
                small
                kind="secondary"
                icon="share"
                title={t('lobby.share')}
                onPress={() =>
                  void Share.share({
                    message: t('lobby.shareMessage', { app: t('common.appName', { name: APP_NAME }), code: session.roomCode, link: tableLink(session.roomCode, { scheme: APP_SCHEMES[0] ?? 'mahjongmania', domain: LINK_DOMAIN }) }),
                  })
                }
              />
              <Pill text={session.mode === 'online' ? t('lobby.serverTable') : t('lobby.onDevice')} icon="shield" tone="gold" />
            </Row>
          </Card>
        )}
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
          {!controls.addBot ? (
            <P dim style={{ fontSize: 12 }}>{t('lobby.quickStarts')}</P>
          ) : (
            <Row style={{ flexWrap: 'wrap', rowGap: 6 }}>
              <Button small kind="secondary" icon="bot" title={t('lobby.addBot')} onPress={addBot} />
              <P dim style={{ fontSize: 12, flexShrink: 1 }}>
                {t('lobby.fillHint')}
              </P>
            </Row>
          )}
        </Card>
      </View>
      {controls.start && <Button large title={humans > 1 ? t('lobby.start') : t('lobby.startWithBots')} icon="play" onPress={start} style={{ alignSelf: 'center' }} />}
      {notice === 'reconnecting' ? (
        <Row style={{ flexWrap: 'wrap', rowGap: 6, alignItems: 'center' }} gap={8}>
          <Pill tone="gold" icon="hourglass" text={t('lobby.reconnecting', { n: conn.attempt })} />
          <Button small title={t('lobby.retryNow')} onPress={() => session.retryNow()} />
        </Row>
      ) : notice ? (
        // Leaving via the header would forget the table; this path keeps the saved record so Home can resume it
        // (also after the seat was opened on another device: taking it back is then the player's choice).
        <Row style={{ flexWrap: 'wrap', rowGap: 6, alignItems: 'center' }} gap={8}>
          <View testID={`link-${notice}`} accessibilityRole="alert" accessibilityLiveRegion="assertive" style={{ flexShrink: 1 }}>
            <Pill tone="danger" icon="warning" wrap text={t(linkCopy(notice, 'lobby').text)} />
          </View>
          <Button
            small
            title={t(linkCopy(notice, 'lobby').leave)}
            onPress={() => {
              // A table the server no longer has, or will not let a banned account back to, cannot be resumed:
              // drop the saved record with the session.
              if (forgetsTable(notice)) app.setActiveSession(null);
              app.setSession(null);
              app.reset({ name: 'home' });
            }}
          />
        </Row>
      ) : (
        state.lastError && <Pill tone="danger" icon="warning" wrap text={tableError({ code: state.lastErrorCode ?? undefined, message: state.lastError }, t)} />
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
