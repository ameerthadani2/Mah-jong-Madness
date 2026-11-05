import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { hintFor, kindInfo, kindOf, legalActions, viewToState, WINDS, type Action, type GameState, type HandResult, type Hint, type TableView, type TileId, type WinRecord } from '@mjm/engine';
import type { ClientState } from '@mjm/net';
import { useApp } from '../app-state';
import { useCountdown, useSession } from '../game/useTable';
import { nextFadeDelay } from '../logic/fade';
import { colors, fonts, nameFont, space } from '../theme';
import { Tile, HiddenHand, tileDims, type TileSize } from '../components/Tile';
import { Compass, DiscardPool, FeltFrame, MeldsAndFlowers, MeldView, SeatBadge, WallRing } from '../components/TableParts';
import type { SeatReaction, SeatReactionKind } from '../components/SeatMotion';
import { Button, IconButton, P, Pill, Row, StrokeText, type ButtonKind } from '../components/Ui';
import { Icon } from '../components/Icons';
import { AvatarPlate, CoachOwl, seatAvatarId } from '../components/Avatars';
import { Emote } from '../components/Emotes';

import * as Haptics from 'expo-haptics';
import { EMOTES, QUICK_CHATS, TableThemeContext, themeById } from '../themes';

/** How long an emote bubble and a chat line stay on screen. */
const EMOTE_MS = 3500;
const CHAT_MS = 6000;

/** Hands whose result has already been celebrated (survives the table screen remounting). */
const celebratedHands = new Set<string>();

export function TableScreen() {
  const app = useApp();
  const session = app.session;
  const state = useSession(session);
  const { width: winW, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const width = winW - insets.left - insets.right;
  const [selected, setSelected] = useState<TileId | null>(null);
  // The coach is a practice aid: offline bot tables only, never at an online table with other people.
  const coachAllowed = session?.mode === 'local';
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

  // Table events become seat reactions: call-outs for claims, a celebration for winners, a shake for the discarder.
  const [reactions, setReactions] = useState<Record<number, SeatReaction>>({});
  const reactionKey = useRef(0);
  const meldSig = useRef<{ hand: number; melds: number[]; kongs: number[] } | null>(null);
  const fire = (seat: number, kind: SeatReactionKind) => setReactions((r) => ({ ...r, [seat]: { kind, key: ++reactionKey.current } }));
  useEffect(() => {
    if (!view) return;
    const melds = view.players.map((p) => p.melds.length);
    const kongs = view.players.map((p) => p.melds.filter((m) => m.type === 'kong').length);
    const prev = meldSig.current;
    if (prev && prev.hand === view.handNumber) {
      view.players.forEach((p, seat) => {
        if (melds[seat] > prev.melds[seat]) {
          const m = p.melds[p.melds.length - 1];
          fire(seat, m.type === 'chow' ? 'chow' : m.type === 'pong' ? 'pong' : 'kong');
        } else if (kongs[seat] > prev.kongs[seat]) {
          fire(seat, 'kong');
        }
      });
    }
    meldSig.current = { hand: view.handNumber, melds, kongs };
  }, [view]);
  // Hold the result sheet back briefly so the win celebration is visible first — once per hand,
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
    const t = setTimeout(() => setShowResult(true), res.type === 'win' ? 1800 : 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.lastResult]);

  if (!session || !state) {
    return (
      <View style={styles.center}>
        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>No table</Text>
          <Button title="Home" onPress={() => app.go({ name: 'home' })} />
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
          <Text style={styles.noticeTitle}>Shuffling…</Text>
          <P dim style={{ textAlign: 'center' }}>
            {state.ceremony === 'idle' ? 'Waiting for players' : state.ceremony === 'committed' ? 'Sealed your random share' : 'Revealed'}
          </P>
          <Button kind="ghost" title="Leave" onPress={leave} />
        </View>
      </View>
    );
  }

  const act = (a: Action) => {
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
  const onTile = (t: TileId) => {
    if (!canDiscard) return;
    if (selected === t) act({ type: 'discard', tile: t });
    else setSelected(t);
  };

  // ---- Layout -------------------------------------------------------
  const portrait = height > width;
  const tablet = Math.min(width, height) >= 680;
  const compact = height < 420;
  // On short screens the side columns have no room under the opponent panel: show the coach in the centre instead.
  const coachInCenter = portrait || height < 520;
  const sideWidth = portrait ? Math.max(84, Math.min(110, Math.floor(width * 0.24))) : width >= 1000 ? 214 : width >= 760 ? 150 : 128;
  const plate = tablet ? 50 : portrait ? 34 : 32;
  const pool: TileSize = tablet ? 'sm' : 'xs';
  const poolW = tileDims(pool).w + 2;
  const rail = tablet ? 15 : 11;
  const feltInnerW = width - 16 - (rail + 3) * 2;
  const centerW = feltInnerW - sideWidth * 2 - 16;
  const centerPerRow = Math.max(5, Math.min(portrait ? 8 : 12, Math.floor(centerW / poolW)));
  const sidePerRow = Math.max(3, Math.min(7, Math.floor((sideWidth - 4) / poolW)));

  // The hand spans the full width under the table, so 17 tiles + the drawn-tile gap always fit.
  const smW = tileDims('sm').w;
  // Landscape: my melds sit right of the hand; my flowers sit under my avatar.
  const meldW = me.melds.reduce((acc, m) => acc + m.tiles.length * (smW + 1) + 8, 0);
  const myPlateW = portrait ? 0 : tablet ? 124 : 82;
  // Slots for a full hand (16 − 3 per meld, +1 drawn) so the tile size does not jump between turns.
  const slots = Math.max((me.hand ?? []).length, 17 - 3 * me.melds.length, 2);
  const handRoom = width - 24 - myPlateW - (portrait ? 0 : meldW + (meldW ? 10 : 0)) - 12;
  // Portrait (phone held upright, e.g. the web preview): the hand wraps into two rows of nine.
  const handTile = portrait ? Math.max(28, Math.min(48, Math.floor((handRoom - 4) / 9.4))) : Math.max(24, Math.min(compact ? 42 : tablet ? 60 : 50, Math.floor((handRoom - 10) / slots) - 2));

  const seatAt = (r: number) => (mySeat + r) % 4;
  const seatInfo = (seat: number) => state.seats.find((s) => s.seat === seat);
  const latestDiscard = view.lastDiscard?.tile;
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
  const plateProps = (seat: number) => ({
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
    reaction: reactions[seat],
  });

  const topSeat = () => {
    const seat = seatAt(2);
    const p = view.players[seat];
    return (
      <View style={styles.topSeat}>
        <Row gap={10} style={{ justifyContent: 'center', flexWrap: 'wrap', rowGap: 4 }}>
          <SeatBadge {...plateProps(seat)} size={plate} maxNameWidth={portrait ? 80 : 120} />
          <HiddenHand count={p.handCount} tileW={tablet ? 15 : portrait ? 9 : 11} tileH={tablet ? 24 : portrait ? 15 : 17} />
          <MeldsAndFlowers player={p} size={tablet ? 'sm' : 'xs'} />
        </Row>
        <DiscardPool tiles={p.discards} size={pool} perRow={centerPerRow} align="center" latest={latestDiscard && view.lastDiscard?.seat === seat ? latestDiscard : undefined} />
      </View>
    );
  };
  const sideSeat = (r: 1 | 3) => {
    const seat = seatAt(r);
    const p = view.players[seat];
    const slim = Math.max(5, Math.min(11, Math.floor((sideWidth - 6) / Math.max(1, p.handCount)) + 1));
    return (
      <View style={[styles.sideSeat, { width: sideWidth }, r === 1 && { alignItems: 'flex-end' }]} key={seat}>
        <SeatBadge {...plateProps(seat)} size={plate} vertical={portrait} maxNameWidth={portrait ? sideWidth : sideWidth - plate - 12} />
        <HiddenHand count={p.handCount} tileW={slim} tileH={tablet ? 22 : 15} />
        <MeldsAndFlowers player={p} size="xs" style={r === 1 ? { justifyContent: 'flex-end' } : undefined} />
        <DiscardPool tiles={p.discards} size={pool} perRow={sidePerRow} align={r === 1 ? 'flex-end' : 'flex-start'} latest={latestDiscard && view.lastDiscard?.seat === seat ? latestDiscard : undefined} />
      </View>
    );
  };

  const recentChat = state.chat.filter((c) => now - c.at < CHAT_MS).slice(-3);
  const waitKinds = new Set(hint?.waits.map((w) => w.kind) ?? []);
  const bestDiscard = hint?.bestDiscard?.tile;
  const relWind = (r: number) => WINDS[(seatAt(r) - view.dealerSeat + 4) % 4];
  const activeRel = turnSeat === null ? (view.pending ? null : null) : (turnSeat - mySeat + 4) % 4;
  // Where there is room (tablet, portrait) the live wall is drawn around the compass.
  const showWall = tablet || portrait;
  const wallSize = tablet ? Math.min(centerW - 24, 300) : Math.max(120, Math.min(centerW - 4, 220));
  const compass = <Compass prevailing={WINDS[view.prevailingWind]} drawsLeft={view.drawsLeft} seatWinds={[relWind(0), relWind(1), relWind(2), relWind(3)]} active={activeRel} size={tablet ? 96 : portrait ? Math.min(66, Math.round(wallSize * 0.42)) : 74} />;
  const statusLine = view.pending ? `${seatInfo(view.pending.from)?.name ?? ''} 打出 ${kindInfo(kindOf(view.pending.tile)).nameZh}${view.pending.kind === 'addedKong' ? '（加槓）' : ''}` : !view.pending && view.phase === 'discard' && view.turn !== mySeat ? `輪到 ${seatInfo(view.turn)?.name ?? ''}` : null;
  const status = statusLine ? (
    <View style={styles.status}>
      <Text numberOfLines={1} style={styles.statusText}>
        {statusLine}
      </Text>
    </View>
  ) : null;

  const centerColumn = (
    <View style={styles.centerCol}>
      {topSeat()}
      {showWall ? (
        <View style={[styles.middle, { flexDirection: 'column', gap: 6 }]}>
          <WallRing remaining={view.tilesRemaining} size={wallSize}>
            {compass}
            {tablet && status && <View style={{ marginTop: 22 }}>{status}</View>}
          </WallRing>
          {!tablet && status}
        </View>
      ) : (
        <View style={styles.middle}>
          <View style={{ alignItems: 'center', gap: 16, paddingVertical: 12, paddingHorizontal: 12 }}>
            {compass}
            {status}
          </View>
          {coachOpen && hint && coachInCenter && <CoachPanel hint={hint} waitKinds={waitKinds} compact />}
        </View>
      )}
      <DiscardPool tiles={me.discards} size={pool} perRow={centerPerRow} align="center" latest={latestDiscard && view.lastDiscard?.seat === mySeat ? latestDiscard : undefined} />
    </View>
  );

  const myPlate = (
    <SeatBadge {...plateProps(mySeat)} size={tablet ? 54 : portrait ? 36 : 40} vertical={!portrait} maxNameWidth={portrait ? 120 : myPlateW - 4} />
  );
  const myFlowers = !portrait && me.flowers.length > 0 && (
    <View style={styles.myFlowers}>
      {me.flowers.map((f) => (
        <Tile key={f} tile={f} size={tablet ? 20 : 16} />
      ))}
    </View>
  );

  return (
    <TableThemeContext.Provider value={theme}>
      <View style={styles.root}>
        {/* HUD */}
        <View style={styles.hud}>
          <Row gap={6} style={{ flexShrink: 1, flexWrap: 'wrap', rowGap: 4 }}>
            <View style={styles.roundChip}>
              <Text style={styles.roundWind}>{WINDS[view.prevailingWind]}</Text>
              <Text style={styles.roundText}>
                風 · 第{view.handNumber + 1}局{view.dealerStreak ? ` · 連${view.dealerStreak}` : ''}
              </Text>
            </View>
            <View style={styles.hudChip}>
              <Icon name="wall" size={18} />
              <Text style={styles.hudChipText}>{view.drawsLeft}</Text>
            </View>
            {session.roomCode !== 'LOCAL' && !portrait && (
              <View style={styles.hudChip}>
                <Text style={styles.hudChipText}>{session.roomCode}</Text>
              </View>
            )}
            {countdown !== null && myMove && (
              <View style={[styles.hudChip, timerUrgent && { backgroundColor: colors.danger }]}>
                <Icon name={state.inTimeBank ? 'hourglass' : 'clock'} size={18} />
                <Text style={styles.hudChipText}>{state.inTimeBank ? `bank ${countdown}s` : `${countdown}s`}</Text>
              </View>
            )}
            {!myMove && state.timeBank > 0 && !portrait && (
              <View style={styles.hudChip}>
                <Icon name="hourglass" size={18} />
                <Text style={styles.hudChipText}>{state.timeBank}s</Text>
              </View>
            )}
          </Row>
          <Row gap={8}>
            <IconButton icon="smile" kind={emotePicker ? 'gold' : 'ghost'} size={38} onPress={() => setEmotePicker((v) => !v)} />
            {coachAllowed && <IconButton icon="cap" kind={coachOpen ? 'primary' : 'ghost'} size={38} onPress={() => setCoachOpen((v) => !v)} />}
            <IconButton testID="leave-table" icon="exit" kind="danger" size={38} onPress={leave} />
          </Row>
        </View>

        {/* Table */}
        <FeltFrame rail={rail} style={{ marginHorizontal: 8 }}>
          {portrait ? (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.portraitBody}>
              <View style={styles.cross}>
                {sideSeat(3)}
                {centerColumn}
                {sideSeat(1)}
              </View>
              {coachOpen && hint && <CoachPanel hint={hint} waitKinds={waitKinds} compact />}
            </ScrollView>
          ) : (
            <View style={styles.cross}>
              {sideSeat(3)}
              {centerColumn}
              <View style={{ gap: 8, flexShrink: 1 }}>
                {sideSeat(1)}
                {coachOpen && hint && !coachInCenter && (
                  <View style={{ width: sideWidth }}>
                    <CoachPanel hint={hint} waitKinds={waitKinds} />
                  </View>
                )}
              </View>
            </View>
          )}
          <View style={styles.actionSpot} pointerEvents="box-none">
            <ActionBar actions={actions} act={act} selected={selected} hint={hint} view={view} big={tablet} />
          </View>
        </FeltFrame>

        {/* My seat: plate, hand on a wooden rack, melds */}
        <View style={[styles.footer, portrait && { paddingTop: 4 }]}>
          {portrait && (
            <Row gap={10} style={{ paddingHorizontal: 4, marginBottom: 2 }}>
              {myPlate}
              <MeldsAndFlowers player={me} size="sm" style={{ flex: 1 }} />
            </Row>
          )}
          <View style={styles.handRow}>
            {!portrait && (
              <View style={{ width: myPlateW }}>
                {/* Grows upward so my avatar overlaps the rail instead of stealing height from the felt. */}
                <View style={[styles.myPlateCol, { width: myPlateW }]}>
                  {myFlowers}
                  {myPlate}
                </View>
              </View>
            )}
            <View style={{ flex: 1 }}>
              <View style={[styles.rack, { height: Math.round(handTile * 0.42) }]}>
                <View style={styles.rackTop} />
              </View>
              <View style={[styles.handTiles, portrait && { flexWrap: 'wrap', rowGap: 6, justifyContent: 'center' }]}>
                {(me.hand ?? []).map((t, i) => {
                  const isDrawn = view.lastDrawn === t && isDiscardPhase;
                  return (
                    <Tile
                      key={t}
                      tile={t}
                      size={handTile}
                      selected={selected === t}
                      dimmed={canDiscard ? false : undefined}
                      highlight={bestDiscard === t && canDiscard ? 'good' : undefined}
                      onPress={() => onTile(t)}
                      style={isDrawn && i === (me.hand?.length ?? 0) - 1 ? { marginLeft: 10 } : undefined}
                    />
                  );
                })}
              </View>
            </View>
            {!portrait && meldW > 0 && (
              <View style={styles.myMelds}>
                {me.melds.map((m, i) => (
                  <MeldView key={i} meld={m} size="sm" />
                ))}
              </View>
            )}
          </View>
        </View>

        {emotePicker && (
          <View style={styles.emotePanel}>
            <View style={styles.emoteGrid}>
              {EMOTES.map((e) => (
                <Pressable
                  key={e}
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
              {QUICK_CHATS.map((q) => (
                <Pressable
                  key={q}
                  onPress={() => {
                    session.client.chat(q);
                    setEmotePicker(false);
                  }}
                  style={({ pressed }) => [styles.quickChat, pressed && { transform: [{ translateY: 1 }] }]}
                >
                  <Text style={[styles.quickText, nameFont(q, fonts.uiBold)]}>{q}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}
        {recentChat.length > 0 && (
          <View style={styles.chatLog} pointerEvents="none">
            {recentChat.map((c, i) => (
              <View key={i} style={styles.chatBubble}>
                <Text style={[styles.chatName, nameFont(c.name)]}>{c.name}</Text>
                <Text style={[styles.chatText, nameFont(c.text, fonts.bodyBold)]}>{c.text}</Text>
              </View>
            ))}
          </View>
        )}

        {state.lastResult && showResult && <ResultOverlay result={state.lastResult} view={view} state={state} mySeat={mySeat} onNext={() => session.client.ready()} onLeave={leave} onReview={() => app.go({ name: 'review' })} onFairness={() => app.go({ name: 'fairness' })} />}
        {state.matchOver && <MatchOverOverlay state={state} onLeave={leave} />}
        {state.disconnected ? (
          <View style={styles.banner}>
            <Icon name="warning" size={28} />
            <View style={{ flex: 1 }}>
              <Text style={styles.bannerTitle}>Connection lost</Text>
              <Text style={styles.bannerText}>Your seat is saved. A bot plays for you until you are back.</Text>
            </View>
            <Button
              small
              title="Reconnect"
              onPress={() => {
                app.setSession(null);
                app.reset({ name: 'home' });
              }}
            />
          </View>
        ) : (
          state.lastError && (
            <View style={styles.toast}>
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

/** Chunky claim button: a big CJK verb plus the tiles it would take. */
function ClaimButton({ label, tiles, kind, onPress, big }: { label: string; tiles?: TileId[]; kind: ButtonKind; onPress: () => void; big?: boolean }) {
  const pal: Record<ButtonKind, [string, string, string]> = {
    primary: [colors.cta, colors.ctaLight, colors.ctaShelf],
    secondary: [colors.info, colors.infoLight, colors.infoShelf],
    danger: [colors.danger, colors.dangerLight, colors.dangerShelf],
    gold: [colors.gold, colors.goldLight, colors.goldShelf],
    premium: [colors.premium, colors.premiumLight, colors.premiumShelf],
    ghost: [colors.creamDeep, colors.creamLight, colors.creamShelf],
  };
  const [fill, light, shelf] = pal[kind];
  const h = big ? 60 : 50;
  return (
    <Pressable onPress={onPress} hitSlop={4}>
      {({ pressed }) => (
        <View style={[styles.claimShell, { backgroundColor: shelf, height: h, borderRadius: h / 2, paddingBottom: pressed ? 0 : 5, paddingTop: pressed ? 5 : 0 }]}>
          <View style={[styles.claimFace, { backgroundColor: fill, borderRadius: h / 2 }]}>
            <View style={[styles.claimTop, { backgroundColor: light }]} />
            {kind === 'ghost' ? (
              <Text style={[styles.claimGhost, { fontSize: big ? 24 : 21 }]}>{label}</Text>
            ) : (
              <StrokeText style={{ fontSize: big ? 26 : 22, lineHeight: big ? 32 : 27 }} strokeWidth={2} drop={1.5}>
                {label}
              </StrokeText>
            )}
            {tiles && tiles.length > 0 && (
              <View style={{ flexDirection: 'row', gap: 1 }}>
                {tiles.map((t) => (
                  <Tile key={t} tile={t} size={big ? 24 : 20} />
                ))}
              </View>
            )}
          </View>
        </View>
      )}
    </Pressable>
  );
}

function ActionBar({ actions, act, selected, hint, view, big }: { actions: Action[]; act: (a: Action) => void; selected: TileId | null; hint: Hint | null; view: TableView; big?: boolean }) {
  if (actions.length === 0) return null;
  const hu = actions.find((a) => a.type === 'hu');
  const kongs = actions.filter((a) => a.type === 'kong');
  const pong = actions.find((a) => a.type === 'pong');
  const chis = actions.filter((a) => a.type === 'chi');
  const pass = actions.find((a) => a.type === 'pass');
  const canDiscard = actions.some((a) => a.type === 'discard');
  const recommended = (a: Action) => hint?.claims.find((c) => JSON.stringify(c.action) === JSON.stringify(a))?.recommended;
  const pendingTile = view.pending?.tile;
  return (
    <View style={styles.actionBar}>
      {canDiscard && selected === null && !hu && kongs.length === 0 && (
        <View style={styles.tapHint}>
          <Icon name="play" size={14} />
          <Text style={styles.tapHintText}>Tap a tile, tap again to discard</Text>
        </View>
      )}
      {pass && <ClaimButton kind="ghost" label="過" onPress={() => act(pass)} big={big} />}
      {chis.map((c, i) => (
        <ClaimButton key={i} kind={recommended(c) ? 'primary' : 'secondary'} label="吃" tiles={(c as { tiles: TileId[] }).tiles} onPress={() => act(c)} big={big} />
      ))}
      {pong && <ClaimButton kind={recommended(pong) ? 'primary' : 'secondary'} label="碰" tiles={pendingTile !== undefined ? [pendingTile] : undefined} onPress={() => act(pong)} big={big} />}
      {kongs.map((k, i) => (
        <ClaimButton key={i} kind={recommended(k) ? 'primary' : 'premium'} label="槓" tiles={[(k as { tile: TileId }).tile]} onPress={() => act(k)} big={big} />
      ))}
      {canDiscard && selected !== null && <ClaimButton kind="danger" label="打" tiles={[selected]} onPress={() => act({ type: 'discard', tile: selected })} big={big} />}
      {hu && <ClaimButton kind="gold" label={view.phase === 'discard' ? '自摸 胡!' : '胡!'} onPress={() => act(hu)} big />}
    </View>
  );
}

function CoachPanel({ hint, waitKinds, compact }: { hint: Hint; waitKinds: Set<number>; compact?: boolean }) {
  if (compact) {
    // One or two lines: status + the single most useful piece of advice.
    const line = hint.winPreview ? `${hint.winPreview.items.map((i) => `${i.nameZh} ${i.tai}`).join(' · ')} = ${hint.winPreview.tai} 台` : hint.discardReason ?? hint.claims.find((c) => c.recommended)?.reason ?? '';
    return (
      <View style={[styles.coach, styles.coachCompact]}>
        <CoachOwl size={34} />
        <View style={{ flex: 1, minWidth: 0, flexShrink: 1, overflow: 'hidden' }}>
          <Text style={styles.coachStatus} numberOfLines={1}>
            {hint.status}
          </Text>
          {!!line && (
            <Text style={styles.coachLine} numberOfLines={2}>
              {line}
            </Text>
          )}
        </View>
        {hint.waits.length > 0 && (
          <Row gap={2}>
            {hint.waits.slice(0, 5).map((w) => (
              <Tile key={w.kind} kind={w.kind} size="xs" highlight={waitKinds.has(w.kind) ? 'wait' : undefined} />
            ))}
          </Row>
        )}
      </View>
    );
  }
  return (
    <View style={styles.coach}>
      <Row gap={8}>
        <CoachOwl size={36} />
        <Text style={styles.coachTitle}>Coach</Text>
      </Row>
      <Text style={styles.coachStatus}>{hint.status}</Text>
      {hint.winPreview && (
        <Text style={styles.coachLine}>
          {hint.winPreview.items.map((i) => `${i.nameZh} ${i.tai}`).join(' · ')} = {hint.winPreview.tai} 台
        </Text>
      )}
      {hint.discardReason && <Text style={styles.coachLine}>{hint.discardReason}</Text>}
      {hint.waits.length > 0 && (
        <Row style={{ flexWrap: 'wrap' }} gap={4}>
          <Text style={styles.coachLabel}>聽</Text>
          {hint.waits.map((w) => (
            <View key={w.kind} style={{ alignItems: 'center' }}>
              <Tile kind={w.kind} size="xs" highlight={waitKinds.has(w.kind) ? 'wait' : undefined} />
              <Text style={styles.coachCount}>×{w.remaining}</Text>
            </View>
          ))}
        </Row>
      )}
      {hint.claims.map((c, i) => (
        <Row key={i} gap={4} style={{ alignItems: 'flex-start' }}>
          {c.recommended ? <Icon name="check" size={16} color={colors.cta} /> : <View style={styles.coachDot} />}
          <Text style={[styles.coachLine, { flex: 1 }, c.recommended && { color: colors.okText }]}>
            {c.label}: {c.reason}
          </Text>
        </Row>
      ))}
    </View>
  );
}

function WinCard({ w, state }: { w: WinRecord; state: ClientState }) {
  const seatOf = (seat: number) => state.seats.find((s) => s.seat === seat);
  const name = (seat: number) => seatOf(seat)?.name ?? `Seat ${seat + 1}`;
  // Flower wins (八仙過海 / 七搶一) end the hand on a bonus tile: the winning tile sits in the flowers row.
  const flowerWin = w.score.flowerWin;
  const how = flowerWin === 'eight' ? '八仙過海' : flowerWin === 'sevenRob' ? `七搶一 · ${name(w.fromSeat!)}` : w.selfDrawn ? '自摸' : `${name(w.fromSeat!)} 放槍`;
  return (
    <View style={styles.winCard}>
      <Row gap={10}>
        <AvatarPlate id={seatAvatarId(seatOf(w.seat), w.seat)} size={40} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.winTitle, nameFont(name(w.seat))]}>{name(w.seat)} 胡牌</Text>
          <Text style={styles.winSub}>{how}</Text>
        </View>
        <View style={styles.taiBadge}>
          <StrokeText style={{ fontSize: 24 }} strokeWidth={2} drop={1.5}>
            {w.score.tai}
          </StrokeText>
          <Text style={styles.taiLabel}>台</Text>
        </View>
      </Row>
      <Row style={{ flexWrap: 'wrap', rowGap: 4 }} gap={2}>
        {w.melds.map((m, i) => (
          <MeldView key={i} meld={m} size="sm" />
        ))}
        {w.hand.map((t) => (
          <Tile key={t} tile={t} size="sm" highlight={t === w.winningTile ? 'wait' : undefined} />
        ))}
        {w.flowers.map((f) => (
          <Tile key={f} tile={f} size="sm" highlight={flowerWin && f === w.winningTile ? 'wait' : undefined} />
        ))}
      </Row>
      <View style={styles.items}>
        {w.score.items.map((it) => (
          <Row key={it.key} style={styles.itemRow}>
            <Text style={styles.itemText}>
              {it.nameZh} <Text style={styles.itemEn}>{it.nameEn}</Text>
            </Text>
            <Text style={styles.itemTai}>{it.tai} 台</Text>
          </Row>
        ))}
        {w.payments.map((p, i) => (
          <Text key={i} style={styles.payment}>
            {name(p.from)} → {name(p.to)}: {p.points} ({p.tai} 台 incl. dealer)
          </Text>
        ))}
      </View>
    </View>
  );
}

function ResultOverlay({ result, view, state, mySeat, onNext, onLeave, onReview, onFairness }: { result: HandResult; view: TableView; state: ClientState; mySeat: number; onNext: () => void; onLeave: () => void; onReview: () => void; onFairness: () => void }) {
  const [ready, setReady] = useState(false);
  const { width, height } = useWindowDimensions();
  // Short landscape phones: results on the left, scores and buttons on the right, so nothing needs scrolling to act.
  const twoCol = width > height && height < 560;
  const iWon = result.wins.some((w) => w.seat === mySeat);
  const audit = state.auditStatus;
  const title = result.type === 'draw' ? '流局' : iWon ? '你胡了!' : '本局結束';
  const sub = result.type === 'draw' ? 'Draw' : iWon ? 'You won the hand!' : 'Hand over';
  const ribbon = result.type === 'draw' ? colors.info : iWon ? colors.gold : colors.premium;
  const ribbonView = (
    <View style={[styles.ribbon, { backgroundColor: ribbon }, twoCol && { alignSelf: 'flex-start', paddingVertical: 3 }]}>
      {iWon && <Icon name="star" size={twoCol ? 24 : 30} />}
      <StrokeText style={{ fontSize: twoCol ? 24 : 30, lineHeight: twoCol ? 30 : 36 }} strokeWidth={2.5} drop={2}>
        {title}
      </StrokeText>
      <StrokeText style={{ fontSize: twoCol ? 15 : 18 }} strokeWidth={2} drop={1.5}>
        {sub}
      </StrokeText>
      {iWon && <Icon name="star" size={twoCol ? 24 : 30} />}
    </View>
  );
  const results = (
    <>
      {result.wins.map((w) => (
        <WinCard key={w.seat} w={w} state={state} />
      ))}
      {result.type === 'draw' && <P>Wall exhausted. Dealer {result.dealerContinues ? 'keeps the deal (連莊).' : 'passes.'}</P>}
    </>
  );
  const scores = (
    <View style={[styles.scoreRow, twoCol && { flexDirection: 'column', flexWrap: 'nowrap', gap: 5 }]}>
      {view.scores.map((s, i) => {
        const info = state.seats.find((x) => x.seat === i);
        const d = result.scoreDelta[i];
        return (
          <View key={i} style={[styles.scoreChip, i === mySeat && { backgroundColor: '#FFF1C4' }, twoCol && { alignSelf: 'stretch' }]}>
            <AvatarPlate id={seatAvatarId(info, i)} size={twoCol ? 26 : 30} />
            <View style={{ flexShrink: 1 }}>
              <Text numberOfLines={1} style={[styles.scoreName, nameFont(info?.name ?? String(i))]}>
                {info?.name ?? i}
              </Text>
              <Text style={styles.scoreNum}>
                {s >= 0 ? '+' : ''}
                {s} <Text style={{ color: d >= 0 ? colors.okText : colors.dangerText }}>({d >= 0 ? '+' : ''}{d})</Text>
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
  // 'partial': the shuffle log and result replayed correctly, but this seat's own share did not protect the seed
  // (it was stood in, or it joined mid-hand). Amber, never green: a host can always claim a seat was late.
  const auditText =
    audit === 'ok' ? (twoCol ? 'Verified · details' : 'Shuffle & log verified · details')
    : audit === 'partial' ? (twoCol ? 'Verified (log only)' : 'Verified (log only) · details')
    : audit === 'failed' ? 'Audit failed · details'
    : 'Audit pending';
  const auditRow = (
    <Row style={{ flexWrap: 'wrap', rowGap: 8 }}>
      <Pressable onPress={onFairness} testID="audit-status">
        <Pill size={twoCol ? 'sm' : 'md'} text={auditText} icon={audit === 'ok' || audit === 'partial' ? 'shield' : audit === 'failed' ? 'warning' : 'hourglass'} tone={audit === 'ok' ? 'ok' : audit === 'partial' ? 'gold' : audit === 'failed' ? 'danger' : 'neutral'} />
      </Pressable>
      {state.auditFailures.map((f, i) => (
        <Text key={`f${i}`} style={{ color: colors.dangerText, fontSize: 12 }}>
          {f}
        </Text>
      ))}
      {state.auditCaveats.map((c, i) => (
        <Text key={`c${i}`} style={{ color: colors.goldDim, fontSize: 12 }}>
          {c}
        </Text>
      ))}
    </Row>
  );
  const next = (
    <Button
      large={!twoCol}
      title={ready ? 'Waiting for others…' : 'Next hand'}
      disabled={ready}
      onPress={() => {
        setReady(true);
        onNext();
      }}
    />
  );
  if (twoCol) {
    return (
      <View style={styles.overlay}>
        <View style={[styles.overlayCard, styles.overlayWide]}>
          <ScrollView style={{ flex: 1.45 }} contentContainerStyle={{ gap: 8 }}>
            {ribbonView}
            {results}
          </ScrollView>
          <View style={{ flex: 1, gap: 8, justifyContent: 'space-between' }}>
            {scores}
            {auditRow}
            <View style={{ gap: 6 }}>
              {next}
              <Row gap={6}>
                <Button small kind="secondary" title="Review" onPress={onReview} style={{ flex: 1 }} />
                <Button small kind="ghost" title="Leave table" onPress={onLeave} style={{ flex: 1 }} />
              </Row>
            </View>
          </View>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.overlay}>
      <ScrollView style={{ width: '100%' }} contentContainerStyle={styles.overlayScroll}>
        <View style={styles.overlayCard}>
          {ribbonView}
          {results}
          {scores}
          {auditRow}
          <Row style={{ flexWrap: 'wrap', rowGap: 8 }}>
            {next}
            <Button kind="secondary" title="Review my hand" onPress={onReview} />
            <Button kind="ghost" title="Leave table" onPress={onLeave} />
          </Row>
        </View>
      </ScrollView>
    </View>
  );
}

function MatchOverOverlay({ state, onLeave }: { state: ClientState; onLeave: () => void }) {
  const scores = state.finalScores ?? [];
  const order = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s);
  return (
    <View style={styles.overlay}>
      <View style={[styles.overlayCard, { maxWidth: 460 }]}>
        <View style={[styles.ribbon, { backgroundColor: colors.gold }]}>
          <Icon name="trophy" size={34} />
          <StrokeText style={{ fontSize: 28 }} strokeWidth={2.5} drop={2}>
            Match over
          </StrokeText>
        </View>
        {order.map(({ s, i }, rank) => {
          const info = state.seats.find((x) => x.seat === i);
          return (
            <Row key={i} style={styles.rankRow}>
              <View style={[styles.rankNum, rank === 0 && { backgroundColor: colors.gold }]}>
                <Text style={styles.rankNumText}>{rank + 1}</Text>
              </View>
              <AvatarPlate id={seatAvatarId(info, i)} size={34} />
              <Text style={[styles.itemText, { flex: 1 }, nameFont(info?.name)]}>{info?.name}</Text>
              <Text style={[styles.rankScore, { color: s >= 0 ? colors.okText : colors.dangerText }]}>
                {s >= 0 ? '+' : ''}
                {s}
              </Text>
            </Row>
          );
        })}
        <Button large title="Back to home" onPress={onLeave} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  notice: { backgroundColor: colors.cream, borderWidth: 3, borderColor: colors.ink, borderRadius: 24, padding: 20, alignItems: 'center', gap: 10, borderBottomWidth: 8 },
  noticeTitle: { fontFamily: fonts.display, fontSize: 26, color: colors.ink },
  hud: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 10, paddingTop: 4, paddingBottom: 6, gap: 8 },
  roundChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.gold, borderWidth: 2.5, borderColor: colors.ink, borderRadius: 999, paddingLeft: 4, paddingRight: 10, height: 30 },
  roundWind: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.ink, color: colors.gold, textAlign: 'center', fontWeight: '900', fontSize: 14, lineHeight: 22, overflow: 'hidden' },
  roundText: { color: colors.ink, fontWeight: '900', fontSize: 13 },
  hudChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(16,20,47,0.7)', borderWidth: 2.5, borderColor: colors.ink, borderRadius: 999, paddingLeft: 5, paddingRight: 10, height: 30 },
  hudChipText: { color: '#FFFFFF', fontFamily: fonts.display, fontSize: 15 },
  cross: { flex: 1, flexDirection: 'row', gap: 8, padding: 6 },
  portraitBody: { flexGrow: 1, paddingBottom: 70 },
  sideSeat: { gap: 6 },
  centerCol: { flex: 1, alignItems: 'center', gap: 6, minWidth: 0 },
  topSeat: { alignItems: 'center', gap: 6 },
  middle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, alignSelf: 'stretch', flexGrow: 1 },
  status: { backgroundColor: 'rgba(16,20,47,0.6)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2, maxWidth: 220 },
  statusText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
  actionSpot: { position: 'absolute', right: 8, bottom: 8, left: 8, alignItems: 'flex-end' },
  actionBar: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'flex-end' },
  tapHint: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(16,20,47,0.78)', borderWidth: 2, borderColor: colors.ink, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  tapHintText: { color: '#FFFFFF', fontFamily: fonts.uiBold, fontSize: 13 },
  claimShell: { borderWidth: 3, borderColor: colors.ink, overflow: 'hidden', minWidth: 60 },
  claimFace: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 16, overflow: 'hidden' },
  claimTop: { position: 'absolute', top: 0, left: 0, right: 0, height: '50%' },
  claimGhost: { color: colors.ink, fontWeight: '900' },
  footer: { paddingHorizontal: 12, paddingBottom: 4, paddingTop: 2 },
  handRow: { flexDirection: 'row', alignItems: 'flex-end' },
  myPlateCol: { position: 'absolute', left: 0, bottom: 4, alignItems: 'center', gap: 4 },
  myFlowers: { flexDirection: 'row', flexWrap: 'wrap', gap: 1, justifyContent: 'center' },
  myMelds: { flexDirection: 'row', alignItems: 'flex-end', marginLeft: 10, paddingBottom: 7 },
  rack: { position: 'absolute', left: -6, right: -6, bottom: 0, backgroundColor: colors.rail, borderWidth: 3, borderColor: colors.ink, borderRadius: 10, overflow: 'hidden' },
  rackTop: { position: 'absolute', top: 0, left: 0, right: 0, height: 5, backgroundColor: colors.railLight },
  handTiles: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, paddingTop: 12, paddingBottom: 7, paddingHorizontal: 4 },
  coach: { backgroundColor: colors.cream, borderRadius: 16, padding: 8, gap: 4, borderWidth: 3, borderColor: colors.ink, flexShrink: 1, overflow: 'hidden' },
  coachCompact: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0, maxWidth: 460, flexShrink: 1, paddingVertical: 5 },
  coachTitle: { color: colors.ink, fontFamily: fonts.display, fontSize: 18 },
  coachStatus: { color: colors.ink, fontFamily: fonts.uiBold, fontSize: 13 },
  coachLine: { color: colors.inkDim, fontSize: 11, lineHeight: 15, fontWeight: '700' },
  coachLabel: { color: colors.ink, fontWeight: '900', fontSize: 13 },
  coachCount: { color: colors.inkDim, fontSize: 9, fontWeight: '800' },
  coachDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.inkDim, marginTop: 5, marginHorizontal: 5 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(16,20,47,0.72)', alignItems: 'center', justifyContent: 'center', padding: space.md, zIndex: 40 },
  overlayScroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 16 },
  overlayCard: { backgroundColor: colors.cream, borderRadius: 26, padding: space.lg, paddingTop: 10, gap: space.md, width: '100%', maxWidth: 720, borderWidth: 3, borderColor: colors.ink, borderBottomWidth: 8 },
  overlayWide: { flexDirection: 'row', maxWidth: 860, flex: 1, padding: 12, paddingTop: 10, gap: 12 },
  ribbon: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, borderWidth: 3, borderColor: colors.ink, borderRadius: 18, paddingVertical: 6, paddingHorizontal: 16, alignSelf: 'center', marginTop: -2, flexWrap: 'wrap' },
  winCard: { gap: 8, backgroundColor: '#FFFFFF', borderWidth: 2.5, borderColor: colors.ink, borderRadius: 18, padding: 12 },
  winTitle: { color: colors.ink, fontSize: 17 },
  winSub: { color: colors.inkDim, fontSize: 13, fontWeight: '900' },
  taiBadge: { flexDirection: 'row', alignItems: 'center', gap: 2, backgroundColor: colors.danger, borderWidth: 2.5, borderColor: colors.ink, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 2 },
  taiLabel: { color: '#FFFFFF', fontWeight: '900', fontSize: 15 },
  items: { gap: 3 },
  itemRow: { justifyContent: 'space-between', borderBottomWidth: 1.5, borderBottomColor: colors.creamDeep, paddingVertical: 2 },
  itemText: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  itemEn: { color: colors.inkDim, fontWeight: '600', fontSize: 12 },
  itemTai: { color: colors.goldDim, fontWeight: '900', fontSize: 14 },
  payment: { color: colors.inkDim, fontSize: 12, fontWeight: '700' },
  scoreRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  scoreChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#FFFFFF', borderWidth: 2, borderColor: colors.ink, borderRadius: 999, paddingLeft: 3, paddingRight: 12, paddingVertical: 3 },
  scoreName: { color: colors.ink, fontSize: 12, maxWidth: 110 },
  scoreNum: { color: colors.ink, fontFamily: fonts.display, fontSize: 13 },
  rankRow: { paddingVertical: 4, borderBottomWidth: 2, borderBottomColor: colors.creamDeep },
  rankNum: { width: 30, height: 30, borderRadius: 15, borderWidth: 2.5, borderColor: colors.ink, backgroundColor: colors.creamDeep, alignItems: 'center', justifyContent: 'center' },
  rankNumText: { fontFamily: fonts.display, color: colors.ink, fontSize: 16 },
  rankScore: { fontFamily: fonts.display, fontSize: 20 },
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
