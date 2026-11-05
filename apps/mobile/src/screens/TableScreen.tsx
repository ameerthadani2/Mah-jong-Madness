/**
 * The table. This screen owns the state (session, selection, reactions, call-outs, the result hold) and
 * composes the pieces in components/table: TableHud, Felt, HandRail, ActionBar, CoachPanel, CallBanner
 * and ResultSheet. Layout rules live in components/table/layout.ts; sounds in src/audio.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { hintFor, kindInfo, kindOf, legalActions, viewToState, WINDS, type Action, type GameState, type Hint, type TileId } from '@mjm/engine';
import { useApp } from '../app-state';
import { useClockTick, useConnection, useCountdown, useSession, useTableEvents } from '../game/useTable';
import { nextFadeDelay } from '../logic/fade';
import { colors, fonts, nameFont } from '../theme';
import { Tile } from '../components/Tile';
import { Compass } from '../components/TableParts';
import type { SeatReaction, SeatReactionKind } from '../components/SeatMotion';
import { Button, P } from '../components/Ui';
import { Icon } from '../components/Icons';
import { Emote } from '../components/Emotes';
import { ActionBar } from '../components/table/ActionBar';
import { CallBanner, WinReveal, type Callout } from '../components/table/CallBanner';
import { Felt, type PlateProps } from '../components/table/Felt';
import { HandRail } from '../components/table/HandRail';
import { ACTION_STRIP_H, tableLayout } from '../components/table/layout';
import { fitHand } from '../display/tableFit';
import { useDisplayScale } from '../display/DisplayScale';
import { RESULT_HOLD_MS } from '../components/table/feel';
import { MatchOverSheet, ResultSheet } from '../components/table/ResultSheet';
import { TableHud } from '../components/table/TableHud';
import { useSfx, type TableEvent } from '../audio';

import * as Haptics from 'expo-haptics';
import { EMOTES, QUICK_CHATS, quickChatText, TableThemeContext, themeById } from '../themes';
import { useT } from '../i18n';
import { ReportPlayerSheet } from '../components/ReportPlayerSheet';
import type { ReportTarget } from '../legal/reports';

/** How long an emote bubble and a chat line stay on screen. */
const EMOTE_MS = 3500;
const CHAT_MS = 6000;

/** Hands whose result has already been celebrated (survives the table screen remounting). */
const celebratedHands = new Set<string>();

const REACTION: Record<'chi' | 'pong' | 'kong', SeatReactionKind> = { chi: 'chow', pong: 'pong', kong: 'kong' };

export function TableScreen() {
  const app = useApp();
  const { t } = useT();
  const session = app.session;
  const state = useSession(session);
  const conn = useConnection(session);
  const sfx = useSfx();
  const { tileScale } = useDisplayScale();
  const { width: winW, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const width = winW - insets.left - insets.right;
  const [selected, setSelected] = useState<TileId | null>(null);
  // The coach is a practice aid: offline bot tables only, never at an online table with other people.
  const coachAllowed = session?.mode === 'local';
  // Online only: a long press on an opponent's portrait opens the report sheet (bots and the local table have no one to report).
  const [reporting, setReporting] = useState<ReportTarget | null>(null);
  const [coachWanted, setCoachOpen] = useState(app.settings.coach);
  const coachOpen = coachAllowed && coachWanted;
  const [emotePicker, setEmotePicker] = useState(false);
  const theme = themeById(app.settings.tableTheme);
  // Re-render once when the next emote bubble or chat line is due to fade, rather than on a fixed tick.
  const [fadeTick, forceTick] = useState(0);
  useEffect(() => {
    const delay = nextFadeDelay(Date.now(), [
      { at: (state?.emotes ?? []).map((e) => e.at), ttl: EMOTE_MS },
      { at: (state?.chat ?? []).map((c) => c.at), ttl: CHAT_MS },
    ]);
    if (delay === null) return;
    const id = setTimeout(() => forceTick((n) => n + 1), delay + 20);
    return () => clearTimeout(id);
  }, [state?.emotes, state?.chat, fadeTick]);
  const countdown = useCountdown(state?.deadline ?? null);

  const view = state?.view ?? null;
  const mySeat = state?.seat ?? 0;
  const local: GameState | null = useMemo(() => (view ? viewToState(view) : null), [view]);
  const actions: Action[] = useMemo(() => (local ? legalActions(local, mySeat) : []), [local, mySeat]);
  const hint: Hint | null = useMemo(() => (coachOpen && local && local.phase !== 'ended' ? safeHint(local, mySeat) : null), [coachOpen, local, mySeat]);

  // Progress bookkeeping once per finished hand (keyed in persisted progress so remounts never double count).
  useEffect(() => {
    if (!state?.lastResult || !state.lastAudit) return;
    const key = `${state.lastAudit.matchId}:${state.lastAudit.handNumber}`;
    const won = state.lastResult.type === 'win' && state.lastResult.wins.some((w) => w.seat === mySeat);
    app.setProgress((p) => (p.lastCountedHand === key ? p : { ...p, lastCountedHand: key, handsPlayed: p.handsPlayed + 1, handsWon: p.handsWon + (won ? 1 : 0) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.lastResult]);

  // Buzz when it becomes our move.
  const myMove = actions.length > 0;
  useEffect(() => {
    if (myMove) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    if (!myMove) setSelected(null);
  }, [myMove]);

  // Table events: sounds, the centre call-out and the seat reactions (call-outs for claims, a celebration
  // for winners, a shake for the discarder).
  const [reactions, setReactions] = useState<Record<number, SeatReaction>>({});
  const reactionKey = useRef(0);
  const fire = (seat: number, kind: SeatReactionKind) => setReactions((r) => ({ ...r, [seat]: { kind, key: ++reactionKey.current } }));
  const [callout, setCallout] = useState<Callout | null>(null);
  useTableEvents(state, (events: TableEvent[]) => {
    sfx.playEvents(events);
    for (const e of events) if (e.type === 'call' && e.call !== 'hu' && e.call !== 'selfdraw') fire(e.seat, REACTION[e.call]);
    const last = [...events].reverse().find((e) => e.type === 'call');
    if (last && last.type === 'call') setCallout({ call: last.call, seat: last.seat, key: ++reactionKey.current });
  });
  useClockTick(countdown, myMove, () => sfx.sfx('tick'));

  // Hold the result sheet back so the call-out and the winner's face-up hand are seen first — once per hand,
  // so coming back from the review or fair-play screen shows the results straight away.
  const resultKey = state?.lastResult && state.lastAudit ? `${state.lastAudit.matchId}:${state.lastAudit.handNumber}` : null;
  const [showResult, setShowResult] = useState(() => resultKey !== null && celebratedHands.has(resultKey));
  useEffect(() => {
    const res = state?.lastResult;
    if (!res) {
      setShowResult(false);
      return;
    }
    if (resultKey && celebratedHands.has(resultKey)) {
      setShowResult(true);
      return;
    }
    if (resultKey) celebratedHands.add(resultKey);
    if (res.type === 'win') {
      for (const w of res.wins) {
        fire(w.seat, w.selfDrawn ? 'selfdraw' : 'win');
        if (!w.selfDrawn && w.fromSeat !== undefined) fire(w.fromSeat, 'dealin');
      }
    }
    const timer = setTimeout(() => setShowResult(true), res.type === 'win' ? RESULT_HOLD_MS.win : RESULT_HOLD_MS.draw);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.lastResult]);

  if (!session || !state) {
    return (
      <View style={styles.center}>
        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>{t('table.noTable')}</Text>
          <Button title={t('table.home')} onPress={() => app.go({ name: 'home' })} />
        </View>
      </View>
    );
  }
  if (!view) {
    return (
      <View style={styles.center}>
        <View style={styles.notice}>
          <View style={{ flexDirection: 'row', gap: 4 }}>
            <Tile kind={31} size="md" />
            <Tile faceDown size="md" />
            <Tile kind={9} size="md" />
          </View>
          <Text style={styles.noticeTitle}>{t('table.shuffling')}</Text>
          <P dim style={{ textAlign: 'center' }}>
            {t(state.ceremony === 'idle' ? 'table.ceremony.idle' : state.ceremony === 'committed' ? 'table.ceremony.committed' : 'table.ceremony.revealed')}
          </P>
          <Button kind="ghost" title={t('table.leave')} onPress={leave} />
        </View>
      </View>
    );
  }

  const act = (a: Action) => {
    if (a.type !== 'discard') sfx.sfx('tap');
    session.client.act(a);
    setSelected(null);
  };
  function leave() {
    // Leaving on purpose abandons the table; Resume is for crashes and dropped connections.
    app.setSession(null);
    app.setActiveSession(null);
    app.reset({ name: 'home' });
  }

  const me = view.players[mySeat];
  const isDiscardPhase = view.phase === 'discard' && view.turn === mySeat;
  const canDiscard = isDiscardPhase && actions.some((a) => a.type === 'discard');
  const onTile = (tile: TileId) => {
    if (!canDiscard) return;
    if (selected === tile) act({ type: 'discard', tile });
    else {
      sfx.sfx('tap');
      setSelected(tile);
    }
  };

  // ---- Layout -------------------------------------------------------
  const L = tableLayout(width, height);
  // Settings → Display → Tiles grows the hand and my melds; portrait wraps into more rows, landscape scrolls the rail.
  const hand = fitHand(width, height, L, (me.hand ?? []).length, me.melds.reduce((n, m) => n + m.tiles.length, 0), me.melds.length, tileScale);

  const seatAt = (r: number) => (mySeat + r) % 4;
  const seatInfo = (seat: number) => state.seats.find((s) => s.seat === seat);
  const seatName = (seat: number) => seatInfo(seat)?.name ?? t('table.seat', { n: seat + 1 });
  const now = Date.now();
  const latestEmote = (seat: number) => {
    const e = [...state.emotes].reverse().find((x) => x.seat === seat && now - x.at < EMOTE_MS);
    return e?.emote;
  };
  const rules = state.rules;
  const turnSeat = view.phase === 'discard' ? view.turn : null;
  const timerSeat = myMove ? mySeat : turnSeat;
  const timerFrac = countdown !== null && rules ? countdown / Math.max(1, state.inTimeBank ? rules.timeBankSeconds || 1 : rules.turnSeconds || 1) : null;
  const timerUrgent = state.inTimeBank || (countdown !== null && countdown <= 5);
  const plateProps = (seat: number): PlateProps => ({
    seat,
    info: seatInfo(seat),
    player: view.players[seat],
    dealerSeat: view.dealerSeat,
    isTurn: timerSeat === seat || turnSeat === seat,
    score: view.scores[seat],
    viewerSeat: mySeat,
    timer: timerSeat === seat ? timerFrac : null,
    timerUrgent,
    emote: latestEmote(seat),
    onLongPress:
      session.mode === 'online' && seat !== mySeat && seatInfo(seat)?.userId && !seatInfo(seat)?.isBot
        ? () => setReporting({ userId: seatInfo(seat)!.userId!, name: seatInfo(seat)!.name, roomCode: session.roomCode })
        : undefined,
    onLongPressHint: t('table.a11y.reportHint'),
    reaction: reactions[seat],
  });

  const recentChat = state.chat.filter((c) => now - c.at < CHAT_MS).slice(-3);
  const relWind = (r: number) => WINDS[(seatAt(r) - view.dealerSeat + 4) % 4];
  const activeRel = turnSeat === null ? null : (turnSeat - mySeat + 4) % 4;
  const compass = <Compass prevailing={WINDS[view.prevailingWind]} drawsLeft={view.drawsLeft} seatWinds={[relWind(0), relWind(1), relWind(2), relWind(3)]} active={activeRel} size={L.compassSize} />;
  const statusLine = view.pending
    ? t('table.status.discarded', { name: seatInfo(view.pending.from)?.name ?? '', tile: kindInfo(kindOf(view.pending.tile)).nameZh }) + (view.pending.kind === 'addedKong' ? t('table.status.addedKong') : '')
    : view.phase === 'discard' && view.turn !== mySeat
      ? t('table.status.turn', { name: seatInfo(view.turn)?.name ?? '' })
      : null;

  // During the hold after a win: the call-out and the winner's hand face up in the middle of the felt.
  const holding = !!state.lastResult && !showResult;
  const revealWin = holding && state.lastResult?.type === 'win' ? state.lastResult.wins[0] : null;
  const overlay =
    callout || revealWin ? (
      <>
        {callout && <CallBanner small={L.compact || (L.portrait && width < 420)} callout={callout} name={seatName(callout.seat)} onDone={() => setCallout((c) => (c && c.key === callout.key ? null : c))} />}
        {revealWin && <WinReveal win={revealWin} tileSize={L.tablet ? 34 : L.compact ? 22 : 26} />}
      </>
    ) : null;

  const actionBar = <ActionBar actions={actions} act={act} selected={selected} hint={hint} view={view} big={L.tablet} align={L.actions === 'center' ? 'center' : 'flex-end'} />;

  return (
    <TableThemeContext.Provider value={theme}>
      <View style={styles.root}>
        <TableHud
          view={view}
          roomCode={session.roomCode}
          portrait={L.portrait}
          countdown={countdown}
          myMove={myMove}
          inTimeBank={state.inTimeBank}
          timeBank={state.timeBank}
          timerUrgent={timerUrgent}
          status={L.statusInHud ? statusLine : null}
          emotesOpen={emotePicker}
          onEmotes={() => setEmotePicker((v) => !v)}
          coachAllowed={coachAllowed}
          coachOpen={coachOpen}
          onCoach={() => setCoachOpen((v) => !v)}
          onLeave={leave}
        />

        <ReportPlayerSheet visible={reporting !== null} target={reporting} onClose={() => setReporting(null)} />
        <Felt
          view={view}
          mySeat={mySeat}
          layout={L}
          plateProps={plateProps}
          compass={compass}
          status={L.statusInHud ? null : statusLine}
          hint={hint}
          coachOpen={coachOpen}
          actions={L.actions === 'center' ? actionBar : null}
          overlay={overlay}
        />
        {L.actions === 'strip' && (
          <View style={styles.actionStrip} testID="action-strip">
            {actionBar}
          </View>
        )}

        <HandRail
          me={me}
          layout={L}
          plate={plateProps(mySeat)}
          handTile={hand.tile}
          plateW={hand.plateW}
          meldTile={hand.meldTile}
          scroll={hand.scroll}
          selected={selected}
          canDiscard={canDiscard}
          drawn={isDiscardPhase && view.lastDrawn != null ? view.lastDrawn : null}
          best={hint?.bestDiscard?.tile}
          onTile={onTile}
        />

        {emotePicker && (
          <View style={styles.emotePanel}>
            <View style={styles.emoteGrid}>
              {EMOTES.map((e) => (
                <Pressable
                  key={e}
                  accessibilityRole="button"
                  accessibilityLabel={t('table.a11y.emote', { name: e })}
                  onPress={() => {
                    session.client.emote(e);
                    setEmotePicker(false);
                  }}
                  style={({ pressed }) => [styles.emoteBtn, pressed && { transform: [{ scale: 0.92 }] }]}
                >
                  <Emote id={e} size={34} />
                </Pressable>
              ))}
            </View>
            <View style={styles.quickWrap}>
              {QUICK_CHATS.map((id) => {
                const q = quickChatText(id);
                return (
                  <Pressable
                    key={id}
                    accessibilityRole="button"
                    accessibilityLabel={q}
                    hitSlop={8}
                    onPress={() => {
                      session.client.chat(q);
                      setEmotePicker(false);
                    }}
                    style={({ pressed }) => [styles.quickChat, pressed && { transform: [{ translateY: 1 }] }]}
                  >
                    <Text style={[styles.quickText, nameFont(q, fonts.uiBold)]}>{q}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}
        {recentChat.length > 0 && (
          <View style={styles.chatLog} pointerEvents="none" accessibilityLiveRegion="polite">
            {recentChat.map((c, i) => (
              <View key={i} style={styles.chatBubble}>
                <Text style={[styles.chatName, nameFont(c.name)]}>{c.name}</Text>
                <Text style={[styles.chatText, nameFont(c.text, fonts.bodyBold)]}>{c.text}</Text>
              </View>
            ))}
          </View>
        )}

        {state.lastResult && showResult && <ResultSheet result={state.lastResult} view={view} state={state} mySeat={mySeat} onNext={() => session.client.ready()} onLeave={leave} onReview={() => app.go({ name: 'review' })} onFairness={() => app.go({ name: 'fairness' })} />}
        {state.matchOver && <MatchOverSheet state={state} onLeave={leave} />}
        {conn.status === 'reconnecting' && !state.matchOver ? (
          // The session is rejoining on its own (1, 2, 4 … 60 s); the player may skip the wait.
          <View style={styles.banner} accessibilityLiveRegion="polite">
            <Icon name="hourglass" size={28} />
            <View style={{ flex: 1 }}>
              <Text style={styles.bannerTitle}>{t('table.connection.reconnectingTitle')}</Text>
              <Text style={styles.bannerText}>{t('table.connection.reconnectingText', { n: conn.attempt })}</Text>
            </View>
            <Button small title={t('table.connection.retryNow')} onPress={() => session.retryNow()} />
          </View>
        ) : !state.matchOver && (conn.status === 'lost' || state.disconnected) ? (
          // Only after ten failed attempts, a refused session (4401), the seat opening elsewhere, or the
          // server saying the table is gone (then there is nothing to come back to: the saved record goes too).
          <View style={styles.banner} accessibilityLiveRegion="assertive">
            <Icon name="warning" size={28} />
            <View style={{ flex: 1 }}>
              <Text style={styles.bannerTitle}>{t(conn.reason === 'gone' ? 'table.connection.goneTitle' : 'table.connection.lostTitle')}</Text>
              <Text style={styles.bannerText}>{t(conn.reason === 'gone' ? 'table.connection.goneText' : 'table.connection.lostText')}</Text>
            </View>
            <Button
              small
              title={t(conn.reason === 'gone' ? 'table.connection.goneLeave' : 'table.connection.reconnect')}
              onPress={() => {
                if (conn.reason === 'gone') app.setActiveSession(null);
                app.setSession(null);
                app.reset({ name: 'home' });
              }}
            />
          </View>
        ) : (
          state.lastError && (
            <View style={styles.toast} accessibilityLiveRegion="polite">
              <Text style={[styles.toastText, nameFont(state.lastError, fonts.bodyBold)]}>{state.lastError}</Text>
            </View>
          )
        )}
      </View>
    </TableThemeContext.Provider>
  );
}

function safeHint(s: GameState, seat: number): Hint | null {
  try {
    return hintFor(s, seat);
  } catch {
    return null;
  }
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  actionStrip: { height: ACTION_STRIP_H, justifyContent: 'center', paddingHorizontal: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  notice: { backgroundColor: colors.cream, borderWidth: 3, borderColor: colors.ink, borderRadius: 24, padding: 20, alignItems: 'center', gap: 10, borderBottomWidth: 8 },
  noticeTitle: { fontFamily: fonts.display, fontSize: 26, color: colors.ink },
  toast: { position: 'absolute', bottom: 12, alignSelf: 'center', backgroundColor: colors.cream, borderWidth: 2.5, borderColor: colors.ink, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 14, zIndex: 30 },
  toastText: { color: colors.ink, fontSize: 13 },
  banner: { position: 'absolute', top: 48, left: '15%', right: '15%', zIndex: 50, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#FFE3E1', borderWidth: 3, borderColor: colors.ink, borderRadius: 18, padding: 10 },
  bannerTitle: { fontFamily: fonts.display, color: colors.ink, fontSize: 17 },
  bannerText: { fontFamily: fonts.body, color: colors.ink, fontSize: 12 },
  emotePanel: { position: 'absolute', top: 48, right: 10, zIndex: 20, maxWidth: 360, backgroundColor: colors.cream, padding: 10, borderRadius: 20, borderWidth: 3, borderColor: colors.ink, borderBottomWidth: 7, gap: 10 },
  emoteGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  emoteBtn: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#FFFFFF', borderWidth: 2.5, borderColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  quickWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  quickChat: { backgroundColor: colors.info, borderWidth: 2, borderColor: colors.ink, borderBottomWidth: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  quickText: { color: '#FFFFFF', fontSize: 13 },
  chatLog: { position: 'absolute', top: 48, left: '25%', right: '25%', zIndex: 10, alignItems: 'center', gap: 4 },
  chatBubble: { flexDirection: 'row', gap: 6, backgroundColor: colors.cream, borderWidth: 2.5, borderColor: colors.ink, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
  chatName: { color: colors.infoShelf, fontSize: 12 },
  chatText: { color: colors.ink, fontSize: 12 },
});
