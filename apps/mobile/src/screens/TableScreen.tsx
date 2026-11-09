/**
 * The table. This screen owns the state (session, selection, reactions, call-outs, the result hold) and
 * composes the pieces in components/table: TableHud, Felt, HandRail, ActionBar, CoachPanel, CallBanner
 * and ResultSheet. Layout rules live in components/table/layout.ts; sounds in src/audio.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { hintFor, kindOf, legalActions, viewToState, WINDS, type Action, type GameState, type Hint, type TileId } from '@mjm/engine';
import { useApp } from '../app-state';
import { useConnection, useSession, useTableEvents } from '../game/useTable';
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
import { ACTION_STRIP_H, slopFor, tableLayout } from '../components/table/layout';
import { fitHand } from '../display/tableFit';
import { useDisplayScale } from '../display/DisplayScale';
import { RESULT_HOLD_MS } from '../components/table/feel';
import { MatchOverSheet, ResultSheet } from '../components/table/ResultSheet';
import { TableHud } from '../components/table/TableHud';
import { LeaveSheet } from '../components/table/LeaveSheet';
import { ClockTicker } from '../components/table/ClockParts';
import { useAnnounce } from '../components/table/announce';
import type { TurnClock } from '../components/table/turnClock';
import { exitPlan, type ExitChoice } from '../components/table/exit';
import { celebrationFor } from '../components/table/celebrate';
import { tableError } from '../components/table/tableErrors';
import { autoDiscarded, callHaptic, plateScore, resultHaptic, type Haptic } from '../components/table/feedback';
import { useTapHint } from '../components/table/useTapHint';
import { tileLabel } from '../components/table/tileLabel';
import { WinCelebration } from '../components/Celebrations';
import { useSfx, type TableEvent } from '../audio';

import * as Haptics from 'expo-haptics';
import { EMOTES, QUICK_CHATS, quickChatText, TableThemeContext, themeById } from '../themes';
import { emoteChoices } from '../monetisation/equipped';
import { useOwnedEquipped } from '../monetisation/useEquipped';
import { useT } from '../i18n';
import { ReportPlayerSheet } from '../components/ReportPlayerSheet';
import { hideBlocked, useBlockedIds } from '../api/blocks';
import { httpBase } from '../api/http';
import { useAuth } from '../auth/AuthProvider';
import type { ReportTarget } from '../legal/reports';

/** How long an emote bubble and a chat line stay on screen. */
const EMOTE_MS = 3500;
const CHAT_MS = 6000;

/** Hands whose result has already been celebrated (survives the table screen remounting). */
const celebratedHands = new Set<string>();

/** Claims, wins and a deal-in buzz (expo-haptics; a no-op where the device has none). */
function buzz(h: Haptic | null): void {
  if (!h) return;
  const p =
    h === 'claim' ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)
    : h === 'win' ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
    : Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  void p.catch(() => undefined);
}

/** How long the "discarded for you" notice stays up after a turn timeout. */
const AUTO_DISCARD_NOTICE_MS = 3500;

/** Keys for call-outs and seat reactions, unique across table screens so a remounted portrait never mistakes a new event for one it played. */
let eventKey = 0;

const REACTION: Record<'chi' | 'pong' | 'kong', SeatReactionKind> = { chi: 'chow', pong: 'pong', kong: 'kong' };

export function TableScreen() {
  const app = useApp();
  const equipped = useOwnedEquipped();
  const { t, locale } = useT();
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
  // Players this account blocked: their chat lines and emotes are not shown (src/api/blocks.ts).
  const auth = useAuth();
  const blocked = useBlockedIds(session?.mode === 'online' && auth.user ? { base: httpBase(app.signalUrl), auth: auth.client } : null, session?.mode === 'online' ? (auth.user?.id ?? null) : null);
  const [coachWanted, setCoachOpen] = useState(app.settings.coach);
  const coachOpen = coachAllowed && coachWanted;
  const [emotePicker, setEmotePicker] = useState(false);
  // The red exit icon asks first (components/table/exit.ts): only "Abandon table" forgets the table.
  const [leaveAsk, setLeaveAsk] = useState(false);
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
  // The turn clock is handed down once per turn; only the leaf components that show it count it down.
  const deadline = state?.deadline ?? null;

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
  const fire = (seat: number, kind: SeatReactionKind) => setReactions((r) => ({ ...r, [seat]: { kind, key: ++eventKey, at: Date.now() } }));
  const [callout, setCallout] = useState<Callout | null>(null);
  useTableEvents(state, (events: TableEvent[]) => {
    sfx.playEvents(events);
    buzz(callHaptic(events, mySeat));
    for (const e of events) if (e.type === 'call' && e.call !== 'hu' && e.call !== 'selfdraw') fire(e.seat, REACTION[e.call]);
    const last = [...events].reverse().find((e) => e.type === 'call');
    if (last && last.type === 'call') setCallout({ call: last.call, seat: last.seat, key: ++eventKey });
  });

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
    buzz(resultHaptic(res, mySeat));
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

  // A turn timeout that discarded for the player gets a short notice (and a buzz), never a silent tile leaving the hand.
  const sentDiscard = useRef(false);
  const pond = useRef<{ hand: number; count: number } | null>(null);
  const [autoNotice, setAutoNotice] = useState<{ tile: number; key: number } | null>(null);
  const myPond = view ? view.players[mySeat]?.discards : undefined;
  useEffect(() => {
    if (!view || !myPond) return;
    const next = { hand: view.handNumber, count: myPond.length };
    if (autoDiscarded(pond.current, next, sentDiscard.current)) {
      setAutoNotice({ tile: myPond[myPond.length - 1], key: ++eventKey });
      buzz('dealin');
    }
    if (!pond.current || next.count !== pond.current.count || next.hand !== pond.current.hand) sentDiscard.current = false;
    pond.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myPond?.length, view?.handNumber]);
  useEffect(() => {
    if (!autoNotice) return;
    const id = setTimeout(() => setAutoNotice((n) => (n && n.key === autoNotice.key ? null : n)), AUTO_DISCARD_NOTICE_MS);
    return () => clearTimeout(id);
  }, [autoNotice]);
  const autoNoticeText = autoNotice ? t('table.autoDiscard', { tile: tileLabel(kindOf(autoNotice.tile as TileId), locale) }) : null;
  useAnnounce(autoNoticeText, autoNotice?.key);
  const tapHint = useTapHint();

  // VoiceOver ignores the banners' live regions: announce them on iOS.
  const linkBanner =
    !state || state.matchOver ? null
    : conn.status === 'reconnecting' ? t('table.connection.reconnectingTitle')
    : conn.status === 'lost' || state.disconnected ? `${t(conn.reason === 'gone' ? 'table.connection.goneTitle' : 'table.connection.lostTitle')}. ${t(conn.reason === 'gone' ? 'table.connection.goneText' : 'table.connection.lostText')}`
    : null;
  useAnnounce(linkBanner);

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
    else {
      sentDiscard.current = true;
      tapHint.discarded();
    }
    session.client.act(a);
    setSelected(null);
  };
  function exit(choice: ExitChoice) {
    setLeaveAsk(false);
    const plan = exitPlan(choice);
    if (plan.closeSession) app.setSession(null);
    if (plan.forgetTable) app.setActiveSession(null);
    if (plan.goHome) app.reset({ name: 'home' });
  }
  // The result and match-over sheets' explicit "Leave table" buttons and the ceremony's Leave: the table is done with.
  function leave() {
    exit('abandon');
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
    const e = hideBlocked(state.emotes, state.seats, blocked).reverse().find((x) => x.seat === seat && now - x.at < EMOTE_MS);
    return e?.emote;
  };
  const rules = state.rules;
  const turnSeat = view.phase === 'discard' ? view.turn : null;
  const timerSeat = myMove ? mySeat : turnSeat;
  const clock: TurnClock = { deadline, total: rules ? (state.inTimeBank ? rules.timeBankSeconds || 1 : rules.turnSeconds || 1) : 1, bank: state.inTimeBank };
  const plateProps = (seat: number): PlateProps => ({
    seat,
    info: seatInfo(seat),
    player: view.players[seat],
    dealerSeat: view.dealerSeat,
    isTurn: timerSeat === seat || turnSeat === seat,
    // During the hold the plates keep the score from before the hand; the result sheet rolls the change up.
    score: plateScore(view.scores[seat], state.lastResult?.scoreDelta[seat], !!state.lastResult && !showResult),
    viewerSeat: mySeat,
    clock: timerSeat === seat && rules ? clock : null,
    emote: latestEmote(seat),
    onLongPress:
      session.mode === 'online' && seat !== mySeat && seatInfo(seat)?.userId && !seatInfo(seat)?.isBot
        ? () => setReporting({ userId: seatInfo(seat)!.userId!, name: seatInfo(seat)!.name, roomCode: session.roomCode })
        : undefined,
    onLongPressHint: t('table.a11y.reportHint'),
    reaction: reactions[seat],
    // The player's own seat wears the avatar frame they equipped.
    frame: seat === mySeat ? equipped.frame : null,
  });

  const recentChat = hideBlocked(state.chat, state.seats, blocked).filter((c) => now - c.at < CHAT_MS).slice(-3);
  const relWind = (r: number) => WINDS[(seatAt(r) - view.dealerSeat + 4) % 4];
  const activeRel = turnSeat === null ? null : (turnSeat - mySeat + 4) % 4;
  const compass = <Compass prevailing={WINDS[view.prevailingWind]} drawsLeft={view.drawsLeft} seatWinds={[relWind(0), relWind(1), relWind(2), relWind(3)]} active={activeRel} size={L.compassSize} />;
  const statusLine = view.pending
    ? t('table.status.discarded', { name: seatInfo(view.pending.from)?.name ?? '', tile: tileLabel(kindOf(view.pending.tile), locale) }) + (view.pending.kind === 'addedKong' ? t('table.status.addedKong') : '')
    : view.phase === 'discard' && view.turn !== mySeat
      ? t('table.status.turn', { name: seatInfo(view.turn)?.name ?? '' })
      : null;

  // During the hold after a win: the call-out and the winner's hand face up in the middle of the felt.
  const holding = !!state.lastResult && !showResult;
  const revealWin = holding && state.lastResult?.type === 'win' ? state.lastResult.wins[0] : null;
  // The player's own win: the celebration they equipped plays over the table during the hold (a still frame under reduce motion).
  const celebration = celebrationFor(state.lastResult, mySeat, equipped.celebration, holding);
  const overlay =
    callout || revealWin ? (
      <>
        {callout && <CallBanner small={L.compact || (L.portrait && width < 420)} callout={callout} name={seatName(callout.seat)} onDone={() => setCallout((c) => (c && c.key === callout.key ? null : c))} />}
        {revealWin && <WinReveal win={revealWin} tileSize={L.tablet ? 34 : L.compact ? 22 : 26} />}
      </>
    ) : null;

  const actionBar = <ActionBar actions={actions} act={act} selected={selected} hint={hint} view={view} big={L.tablet} align={L.actions === 'center' ? 'center' : 'flex-end'} tapHint={tapHint.show} wrap={!L.compact} />;

  return (
    <TableThemeContext.Provider value={theme}>
      <View style={styles.root}>
        <TableHud
          view={view}
          roomCode={session.roomCode}
          portrait={L.portrait}
          clock={clock}
          myMove={myMove}
          timeBank={state.timeBank}
          status={L.statusInHud ? statusLine : null}
          emotesOpen={emotePicker}
          onEmotes={() => setEmotePicker((v) => !v)}
          coachAllowed={coachAllowed}
          coachOpen={coachOpen}
          onCoach={() => setCoachOpen((v) => !v)}
          onLeave={() => setLeaveAsk(true)}
        />
        <ClockTicker clock={clock} myMove={myMove} onTick={() => sfx.sfx('tick')} />
        <LeaveSheet visible={leaveAsk} online={session.mode === 'online'} onChoose={exit} />

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
          dock={actions.some((a) => a.type !== 'discard') || (actions.length > 0 && selected !== null) ? 'buttons' : actions.length > 0 && tapHint.show ? 'hint' : 'none'}
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
              {emoteChoices(EMOTES, equipped).map((e) => (
                <Pressable
                  key={e}
                  hitSlop={slopFor(48)}
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

        {celebration && <WinCelebration id={celebration} width={winW} height={height} />}
        {autoNoticeText && (
          <View style={styles.autoNotice} accessibilityLiveRegion="polite" testID="auto-discard-notice" pointerEvents="none">
            <Icon name="clock" size={22} />
            <Text style={[styles.toastText, nameFont(autoNoticeText, fonts.bodyBold)]}>{autoNoticeText}</Text>
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
              <Text style={[styles.toastText, nameFont(tableError({ code: state.lastErrorCode ?? undefined, message: state.lastError }, t), fonts.bodyBold)]}>{tableError({ code: state.lastErrorCode ?? undefined, message: state.lastError }, t)}</Text>
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
  // Grows with its buttons (several 吃 options and 胡 wrap into more rows) so none runs under the hand rail.
  actionStrip: { minHeight: ACTION_STRIP_H, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  notice: { backgroundColor: colors.cream, borderWidth: 3, borderColor: colors.ink, borderRadius: 24, padding: 20, alignItems: 'center', gap: 10, borderBottomWidth: 8 },
  noticeTitle: { fontFamily: fonts.display, fontSize: 26, color: colors.ink },
  toast: { position: 'absolute', bottom: 12, alignSelf: 'center', backgroundColor: colors.cream, borderWidth: 2.5, borderColor: colors.ink, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 14, zIndex: 30 },
  toastText: { color: colors.ink, fontSize: 13 },
  autoNotice: { position: 'absolute', top: 48, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: '90%', backgroundColor: '#FFF1C4', borderWidth: 2.5, borderColor: colors.ink, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 14, zIndex: 35 },
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
