import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { hintFor, kindInfo, kindOf, legalActions, viewToState, WINDS, type Action, type GameState, type HandResult, type Hint, type TableView, type TileId, type WinRecord } from '@mjm/engine';
import type { ClientState } from '@mjm/net';
import { useApp } from '../app-state';
import { useCountdown, useSession } from '../game/useTable';
import { colors, radius, space } from '../theme';
import { Tile } from '../components/Tile';
import { DiscardPool, MeldView, SeatBadge } from '../components/TableParts';
import { Button, P, Pill, Row } from '../components/Ui';

import * as Haptics from 'expo-haptics';

export function TableScreen() {
  const app = useApp();
  const session = app.session;
  const state = useSession(session);
  const { width, height } = useWindowDimensions();
  const [selected, setSelected] = useState<TileId | null>(null);
  const [coachOpen, setCoachOpen] = useState(app.settings.coach);
  const countdown = useCountdown(state?.deadline ?? null);
  const lastHandCounted = useRef<number>(-1);

  const view = state?.view ?? null;
  const mySeat = state?.seat ?? 0;
  const local: GameState | null = useMemo(() => (view ? viewToState(view) : null), [view]);
  const actions: Action[] = useMemo(() => (local ? legalActions(local, mySeat) : []), [local, mySeat]);
  const hint: Hint | null = useMemo(() => (coachOpen && local && local.phase !== 'ended' ? safeHint(local, mySeat) : null), [coachOpen, local, mySeat]);

  // Progress bookkeeping once per finished hand.
  useEffect(() => {
    if (!state?.lastResult || !view) return;
    if (lastHandCounted.current === view.handNumber) return;
    lastHandCounted.current = view.handNumber;
    const won = state.lastResult.type === 'win' && state.lastResult.wins.some((w) => w.seat === mySeat);
    app.setProgress((p) => ({ ...p, handsPlayed: p.handsPlayed + 1, handsWon: p.handsWon + (won ? 1 : 0) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.lastResult]);

  // Buzz when it becomes our move.
  const myMove = actions.length > 0;
  useEffect(() => {
    if (myMove) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    if (!myMove) setSelected(null);
  }, [myMove]);

  if (!session || !state) {
    return (
      <View style={styles.center}>
        <P>No table.</P>
        <Button title="Home" onPress={() => app.go({ name: 'home' })} />
      </View>
    );
  }
  if (!view) {
    return (
      <View style={styles.center}>
        <P>Shuffling… ({state.ceremony === 'idle' ? 'waiting for players' : state.ceremony === 'committed' ? 'sealed your random share' : 'revealed'})</P>
        <Button kind="ghost" title="Leave" onPress={leave} />
      </View>
    );
  }

  const act = (a: Action) => {
    session.client.act(a);
    setSelected(null);
  };
  function leave() {
    const over = state?.matchOver ?? false;
    app.setSession(null);
    if (over || session?.mode === 'local') app.setActiveSession(null);
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

  const compact = height < 420;
  const sideWidth = width >= 1000 ? 200 : width >= 760 ? 170 : 140;
  const handRoom = width - 2 * sideWidth - 48;
  const perTile = handRoom / 17.6;
  const handSize: 'sm' | 'md' | 'lg' = compact || perTile < 42 ? 'sm' : perTile < 52 ? 'md' : 'lg';
  const seatAt = (r: number) => (mySeat + r) % 4;
  const seatInfo = (seat: number) => state.seats.find((s) => s.seat === seat);
  const latestDiscard = view.lastDiscard?.tile;
  const pendingTile = view.pending?.tile;

  const otherPanel = (r: 1 | 2 | 3) => {
    const seat = seatAt(r);
    const p = view.players[seat];
    const vertical = r === 1 || r === 3;
    return (
      <View style={[styles.other, vertical ? styles.otherVertical : styles.otherHorizontal]} key={seat}>
        <SeatBadge seat={seat} info={seatInfo(seat)} player={p} dealerSeat={view.dealerSeat} isTurn={view.turn === seat && view.phase === 'discard'} score={view.scores[seat]} compact viewerSeat={mySeat} />
        <View style={[styles.otherTiles, vertical && { flexDirection: 'column', alignItems: 'flex-start' }]}>
          <View style={{ flexDirection: 'row', gap: 1, flexWrap: 'wrap', maxWidth: vertical ? sideWidth - 16 : undefined }}>
            {Array.from({ length: Math.min(p.handCount, 17) }).map((_, i) => (
              <Tile key={i} size="xs" faceDown />
            ))}
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {p.melds.map((m, i) => (
              <MeldView key={i} meld={m} size="xs" />
            ))}
          </View>
        </View>
        <DiscardPool tiles={p.discards} perRow={vertical ? 6 : 10} latest={latestDiscard && view.lastDiscard?.seat === seat ? latestDiscard : undefined} />
      </View>
    );
  };

  const windName = WINDS[view.prevailingWind];
  const myInfo = seatInfo(mySeat);
  const waitKinds = new Set(hint?.waits.map((w) => w.kind) ?? []);
  const bestDiscard = hint?.bestDiscard?.tile;

  return (
    <View style={styles.root}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <Row>
          <Pill text={`${windName}風 · 第${view.handNumber + 1}局`} tone="gold" />
          <Pill text={`莊 ${seatInfo(view.dealerSeat)?.name ?? ''}${view.dealerStreak ? ` 連${view.dealerStreak}` : ''}`} />
          <Pill text={`剩 ${view.drawsLeft} 張`} />
          {session.roomCode !== 'LOCAL' && <Pill text={session.roomCode} />}
          {countdown !== null && myMove && <Pill text={state.inTimeBank ? `⏳ bank ${countdown}s` : `${countdown}s`} tone={state.inTimeBank ? 'danger' : countdown <= 5 ? 'gold' : 'neutral'} />}
          {!myMove && state.timeBank > 0 && <Pill text={`bank ${state.timeBank}s`} />}
        </Row>
        <Row>
          <Button small kind={coachOpen ? 'primary' : 'ghost'} title={coachOpen ? 'Coach on' : 'Coach'} onPress={() => setCoachOpen((v) => !v)} />
          <Button small kind="ghost" title="Leave" onPress={leave} />
        </Row>
      </View>

      <View style={styles.body}>
        {/* Left: 上家 */}
        <View style={[styles.side, { width: sideWidth }]}>{otherPanel(3)}</View>

        {/* Center column: 對家 on top, my area at bottom */}
        <View style={styles.centerCol}>
          {otherPanel(2)}
          <View style={styles.centerInfo}>
            {view.pending && (
              <P dim style={{ fontSize: 12 }}>
                {seatInfo(view.pending.from)?.name} 打出 {kindInfo(kindOf(view.pending.tile)).nameZh}
                {view.pending.kind === 'addedKong' ? '（加槓）' : ''} — 等待回應…
              </P>
            )}
            {!view.pending && view.phase === 'discard' && view.turn !== mySeat && (
              <P dim style={{ fontSize: 12 }}>
                輪到 {seatInfo(view.turn)?.name}
              </P>
            )}
          </View>
          {/* My melds + flowers */}
          <View style={styles.myMelds}>
            {me.melds.map((m, i) => (
              <MeldView key={i} meld={m} size="sm" />
            ))}
          </View>
          {/* Action bar */}
          <ActionBar actions={actions} view={view} act={act} selected={selected} hint={hint} />
          {/* My hand */}
          <View style={styles.hand}>
            <SeatBadge seat={mySeat} info={myInfo} player={me} dealerSeat={view.dealerSeat} isTurn={isDiscardPhase} score={view.scores[mySeat]} compact viewerSeat={mySeat} />
            <View style={styles.handTiles}>
              {(me.hand ?? []).map((t, i) => {
                const isDrawn = view.lastDrawn === t && isDiscardPhase;
                return (
                  <Tile
                    key={t}
                    tile={t}
                    size={handSize}
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
        </View>

        {/* Right: 下家 + coach */}
        <View style={[styles.side, { width: sideWidth }]}>
          {otherPanel(1)}
          {coachOpen && hint && <CoachPanel hint={hint} waitKinds={waitKinds} />}
        </View>
      </View>

      {state.lastResult && <ResultOverlay result={state.lastResult} view={view} state={state} mySeat={mySeat} onNext={() => session.client.ready()} onLeave={leave} onReview={() => app.go({ name: 'review' })} onFairness={() => app.go({ name: 'fairness' })} />}
      {state.matchOver && <MatchOverOverlay state={state} onLeave={leave} />}
      {state.lastError && (
        <View style={styles.toast}>
          <Text style={{ color: colors.text }}>{state.lastError}</Text>
        </View>
      )}
      {pendingTile !== undefined && !view.pending && null}
    </View>
  );
}

function safeHint(s: GameState, seat: number): Hint | null {
  try {
    return hintFor(s, seat);
  } catch {
    return null;
  }
}

function ActionBar({ actions, view, act, selected, hint }: { actions: Action[]; view: TableView; act: (a: Action) => void; selected: TileId | null; hint: Hint | null }) {
  if (actions.length === 0) return <View style={styles.actionBar} />;
  const hu = actions.find((a) => a.type === 'hu');
  const kongs = actions.filter((a) => a.type === 'kong');
  const pong = actions.find((a) => a.type === 'pong');
  const chis = actions.filter((a) => a.type === 'chi');
  const pass = actions.find((a) => a.type === 'pass');
  const canDiscard = actions.some((a) => a.type === 'discard');
  const recommended = (a: Action) => hint?.claims.find((c) => JSON.stringify(c.action) === JSON.stringify(a))?.recommended;
  return (
    <View style={styles.actionBar}>
      {hu && <Button title={view.phase === 'discard' ? '自摸 胡!' : '胡!'} onPress={() => act(hu)} style={styles.huBtn} />}
      {kongs.map((k, i) => (
        <Button key={i} kind={recommended(k) ? 'primary' : 'secondary'} title={`槓 ${kindInfo(kindOf((k as { tile: TileId }).tile)).nameZh}`} onPress={() => act(k)} />
      ))}
      {pong && <Button kind={recommended(pong) ? 'primary' : 'secondary'} title="碰" onPress={() => act(pong)} />}
      {chis.map((c, i) => (
        <Button key={i} kind={recommended(c) ? 'primary' : 'secondary'} title={`吃 ${(c as { tiles: TileId[] }).tiles.map((t) => kindInfo(kindOf(t)).nameZh).join('')}`} onPress={() => act(c)} />
      ))}
      {pass && <Button kind="ghost" title="過" onPress={() => act(pass)} />}
      {canDiscard && selected !== null && <Button kind="danger" title={`打 ${kindInfo(kindOf(selected)).nameZh}`} onPress={() => act({ type: 'discard', tile: selected })} />}
      {canDiscard && selected === null && <P dim style={{ fontSize: 12 }}>Tap a tile, tap again to discard</P>}
    </View>
  );
}

function CoachPanel({ hint, waitKinds }: { hint: Hint; waitKinds: Set<number> }) {
  return (
    <View style={styles.coach}>
      <Text style={styles.coachTitle}>Coach</Text>
      <Text style={styles.coachStatus}>{hint.status}</Text>
      {hint.winPreview && (
        <Text style={styles.coachLine}>
          {hint.winPreview.items.map((i) => `${i.nameZh} ${i.tai}`).join(' · ')} = {hint.winPreview.tai} 台
        </Text>
      )}
      {hint.discardReason && <Text style={styles.coachLine}>{hint.discardReason}</Text>}
      {hint.waits.length > 0 && (
        <Row style={{ flexWrap: 'wrap' }} gap={4}>
          <Text style={styles.coachLine}>聽:</Text>
          {hint.waits.map((w) => (
            <View key={w.kind} style={{ alignItems: 'center' }}>
              <Tile kind={w.kind} size="xs" highlight={waitKinds.has(w.kind) ? 'wait' : undefined} />
              <Text style={{ color: colors.textDim, fontSize: 9 }}>×{w.remaining}</Text>
            </View>
          ))}
        </Row>
      )}
      {hint.claims.map((c, i) => (
        <Text key={i} style={[styles.coachLine, c.recommended && { color: colors.gold }]}>
          {c.recommended ? '✓ ' : '• '}
          {c.label}: {c.reason}
        </Text>
      ))}
    </View>
  );
}

function WinCard({ w, view, state }: { w: WinRecord; view: TableView; state: ClientState }) {
  const name = (seat: number) => state.seats.find((s) => s.seat === seat)?.name ?? `Seat ${seat + 1}`;
  return (
    <View style={styles.winCard}>
      <Text style={styles.winTitle}>
        {name(w.seat)} 胡牌 — {w.selfDrawn ? '自摸' : `${name(w.fromSeat!)} 放槍`} · {w.score.tai} 台
      </Text>
      <Row style={{ flexWrap: 'wrap' }} gap={2}>
        {w.melds.map((m, i) => (
          <MeldView key={i} meld={m} size="sm" />
        ))}
        {w.hand.map((t) => (
          <Tile key={t} tile={t} size="sm" highlight={t === w.winningTile ? 'wait' : undefined} />
        ))}
        {w.flowers.map((f) => (
          <Tile key={f} tile={f} size="sm" />
        ))}
      </Row>
      <View style={styles.items}>
        {w.score.items.map((it) => (
          <Row key={it.key} style={{ justifyContent: 'space-between' }}>
            <Text style={styles.itemText}>
              {it.nameZh} <Text style={{ color: colors.textDim }}>{it.nameEn}</Text>
            </Text>
            <Text style={styles.itemTai}>{it.tai} 台</Text>
          </Row>
        ))}
        {w.payments.map((p, i) => (
          <Text key={i} style={[styles.itemText, { color: colors.textDim }]}>
            {name(p.from)} → {name(p.to)}: {p.points} ({p.tai} 台 incl. dealer)
          </Text>
        ))}
      </View>
      {void view}
    </View>
  );
}

function ResultOverlay({ result, view, state, mySeat, onNext, onLeave, onReview, onFairness }: { result: HandResult; view: TableView; state: ClientState; mySeat: number; onNext: () => void; onLeave: () => void; onReview: () => void; onFairness: () => void }) {
  const [ready, setReady] = useState(false);
  const iWon = result.wins.some((w) => w.seat === mySeat);
  const audit = state.auditStatus;
  return (
    <View style={styles.overlay}>
      <ScrollView contentContainerStyle={styles.overlayCard}>
        <Text style={styles.overlayTitle}>{result.type === 'draw' ? '流局 Draw' : iWon ? '🎉 你胡了!' : '本局結束'}</Text>
        {result.wins.map((w) => (
          <WinCard key={w.seat} w={w} view={view} state={state} />
        ))}
        {result.type === 'draw' && <P dim>Wall exhausted. Dealer {result.dealerContinues ? 'keeps the deal (連莊).' : 'passes.'}</P>}
        <Row style={{ flexWrap: 'wrap' }}>
          {view.scores.map((s, i) => (
            <Pill key={i} text={`${state.seats.find((x) => x.seat === i)?.name ?? i}: ${s >= 0 ? '+' : ''}${s} (${result.scoreDelta[i] >= 0 ? '+' : ''}${result.scoreDelta[i]})`} tone={i === mySeat ? 'gold' : 'neutral'} />
          ))}
        </Row>
        <Row style={{ flexWrap: 'wrap' }}>
          <Pressable onPress={onFairness}>
            <Pill text={audit === 'ok' ? '✓ Shuffle & log verified · details' : audit === 'failed' ? '⚠ Audit failed · details' : 'Audit pending'} tone={audit === 'ok' ? 'ok' : audit === 'failed' ? 'danger' : 'neutral'} />
          </Pressable>
          <Button small kind="secondary" title="Review my hand" onPress={onReview} />
          {state.auditFailures.map((f, i) => (
            <Text key={i} style={{ color: colors.danger, fontSize: 12 }}>
              {f}
            </Text>
          ))}
        </Row>
        <Row>
          <Button
            title={ready ? 'Waiting for others…' : 'Next hand'}
            disabled={ready}
            onPress={() => {
              setReady(true);
              onNext();
            }}
          />
          <Button kind="ghost" title="Leave table" onPress={onLeave} />
        </Row>
      </ScrollView>
    </View>
  );
}

function MatchOverOverlay({ state, onLeave }: { state: ClientState; onLeave: () => void }) {
  const scores = state.finalScores ?? [];
  const order = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s);
  return (
    <View style={styles.overlay}>
      <View style={styles.overlayCard}>
        <Text style={styles.overlayTitle}>Match over</Text>
        {order.map(({ s, i }, rank) => (
          <Row key={i} style={{ justifyContent: 'space-between' }}>
            <Text style={styles.itemText}>
              {rank + 1}. {state.seats.find((x) => x.seat === i)?.name}
            </Text>
            <Text style={[styles.itemTai, { color: s >= 0 ? colors.ok : colors.danger }]}>
              {s >= 0 ? '+' : ''}
              {s}
            </Text>
          </Row>
        ))}
        <Button title="Back to home" onPress={onLeave} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.felt },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: space.md, paddingVertical: 4 },
  body: { flex: 1, flexDirection: 'row', paddingHorizontal: space.sm, gap: space.sm },
  side: { gap: space.sm },
  centerCol: { flex: 1, justifyContent: 'space-between' },
  centerInfo: { alignItems: 'center', minHeight: 18 },
  other: { backgroundColor: 'rgba(0,0,0,0.15)', borderRadius: radius.md, padding: 6, gap: 4 },
  otherVertical: {},
  otherHorizontal: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  otherTiles: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  myMelds: { flexDirection: 'row', flexWrap: 'wrap', minHeight: 24, paddingHorizontal: 4 },
  actionBar: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, minHeight: 44, alignItems: 'center', paddingHorizontal: 4 },
  huBtn: { backgroundColor: colors.gold, paddingHorizontal: 26 },
  hand: { gap: 4, paddingBottom: 4 },
  handTiles: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, paddingTop: 12 },
  coach: { backgroundColor: colors.panelStrong, borderRadius: radius.md, padding: 8, gap: 4, borderWidth: 1, borderColor: colors.goldDim },
  coachTitle: { color: colors.gold, fontWeight: '900', fontSize: 12, letterSpacing: 1 },
  coachStatus: { color: colors.text, fontWeight: '700', fontSize: 13 },
  coachLine: { color: colors.textDim, fontSize: 11, lineHeight: 15 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', alignItems: 'center', justifyContent: 'center', padding: space.lg },
  overlayCard: { backgroundColor: colors.feltDark, borderRadius: radius.lg, padding: space.lg, gap: space.md, minWidth: 360, maxWidth: 720, borderWidth: 1, borderColor: colors.goldDim },
  overlayTitle: { color: colors.gold, fontSize: 24, fontWeight: '900' },
  winCard: { gap: 6 },
  winTitle: { color: colors.text, fontWeight: '800', fontSize: 15 },
  items: { gap: 2 },
  itemText: { color: colors.text, fontSize: 13 },
  itemTai: { color: colors.gold, fontWeight: '800', fontSize: 13 },
  toast: { position: 'absolute', bottom: 8, alignSelf: 'center', backgroundColor: colors.panelStrong, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
});
