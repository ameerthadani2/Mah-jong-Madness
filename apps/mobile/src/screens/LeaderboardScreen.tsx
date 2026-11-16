/**
 * Leaderboards: today's daily puzzle, Puzzle Rush (today, this week, all time) and the puzzle rating, for
 * everyone or for one of the player's clubs. The rules (requests, row text, the pinned own row, failures)
 * are in src/logic/leaderboard.ts; this screen draws them. Like Clubs, nothing reaches the server until the
 * age gate is passed, and the guest account is made here the first time.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useApp } from '../app-state';
import { useAuth } from '../auth/AuthProvider';
import { httpBase } from '../api/http';
import { clubsApi, isMemberView, type ClubListing } from '../api/clubs';
import { puzzlesApi, type Board, type BoardKind, type PuzzleContext } from '../api/puzzles';
import { todayKey } from '../storage';
import {
  BOARD_KINDS,
  boardFailure,
  boardRequest,
  boardTitleKey,
  boardView,
  choiceKey,
  DEFAULT_CHOICE,
  emptyText,
  periodKey,
  RUSH_PERIODS,
  scopeOptions,
  validChoice,
  type BoardChoice,
  type BoardFailure,
  type RowView,
} from '../logic/leaderboard';
import type { Message } from '../logic/translate';
import { useOnlineGuard } from '../legal/useOnlineGuard';
import { AgeBlocked, AgeGate } from '../components/AgeGate';
import { SignInPrompt } from '../components/SignInPrompt';
import { Avatar, resolveAvatar } from '../components/Avatars';
import { Icon } from '../components/Icons';
import { Live } from '../components/Live';
import { Button, Card, H2, P, Pill, Row, ScreenHeader } from '../components/Ui';
import { colors, fonts, space } from '../theme';
import { useT } from '../i18n';

type Loaded = { status: 'loading' } | { status: 'ready'; board: Board } | { status: 'failed'; failure: BoardFailure };

/** A choice button (a tab, a period or a scope): at least 44 pt tall, its label wraps rather than clips. */
function Choice({ label, a11y, selected, onPress, testID, grow, role = 'tab' }: { label: string; a11y?: string; selected: boolean; onPress: () => void; testID?: string; grow?: boolean; role?: 'tab' | 'button' }) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole={role}
      accessibilityLabel={a11y ?? label}
      accessibilityState={{ selected }} aria-selected={selected}
      style={({ pressed }) => [styles.choice, grow && styles.grow, selected && styles.choiceOn, pressed && { transform: [{ translateY: 1 }] }]}
    >
      <P style={[styles.choiceText, { fontFamily: fonts.uiBold }]}>{label}</P>
    </Pressable>
  );
}

function BoardRowLine({ row }: { row: RowView }) {
  const { t } = useT();
  return (
    <View testID={`board-row-${row.rank}${row.mine ? '-mine' : ''}`} accessible accessibilityRole="text" accessibilityLabel={row.label} style={[styles.row, row.mine && styles.rowMine]}>
      <P style={styles.rank}>{row.rankText}</P>
      <Avatar id={resolveAvatar(row.avatar, row.key)} size={36} />
      <View style={styles.who}>
        <P style={styles.name}>{row.name}</P>
        {(row.mine || row.detail) && (
          <Row gap={6} style={{ flexWrap: 'wrap', rowGap: 2 }}>
            {row.mine && <Pill text={t('puzzles.boards.you')} tone="gold" size="sm" />}
            {row.detail ? <P dim style={styles.detail}>{row.detail}</P> : null}
          </Row>
        )}
      </View>
      <P style={[styles.value, row.unsolved && styles.valueDim]}>{row.value}</P>
    </View>
  );
}

export function LeaderboardScreen({ board: initialBoard }: { board?: BoardKind }) {
  const app = useApp();
  const auth = useAuth();
  const { t } = useT();
  const { entry } = useOnlineGuard();
  const ageOk = entry === 'ok';
  const ctx = useMemo<PuzzleContext>(() => ({ base: httpBase(app.signalUrl), auth: auth.client }), [app.signalUrl, auth.client]);
  const userId = auth.user?.id ?? null;
  // The daily board is the one for the puzzle the player plays today (their local date key).
  const [dateKey] = useState(() => todayKey());
  const [choice, setChoice] = useState<BoardChoice>(() => ({ ...DEFAULT_CHOICE, board: initialBoard ?? DEFAULT_CHOICE.board }));
  const [connection, setConnection] = useState<'checking' | 'ready' | 'offline'>('checking');
  const [clubs, setClubs] = useState<ClubListing[]>([]);
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [notice, setNotice] = useState<Message | null>(null);
  const { ensure } = auth;

  const connect = useCallback(async () => {
    setConnection('checking');
    setLoaded({});
    setConnection((await ensure()) ? 'ready' : 'offline');
  }, [ensure]);
  useEffect(() => {
    if (ageOk) void connect();
  }, [connect, ageOk]);

  // The player's clubs, for the scope choice; without them only "Everyone" is offered.
  useEffect(() => {
    if (connection !== 'ready' || !userId) return;
    let live = true;
    clubsApi
      .mine(ctx, userId)
      .then((list) => live && setClubs(list))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [connection, ctx, userId]);
  // "Show me on leaderboards" as the server has it, so a hidden player is told so on every board.
  const [visible, setVisible] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (connection !== 'ready') return;
    let live = true;
    puzzlesApi
      .getLeaderboardVisible(ctx)
      .then((v) => live && setVisible(v))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [connection, ctx]);
  const scopes = useMemo(() => scopeOptions(clubs, (c) => !!userId && isMemberView(c, userId), t), [clubs, userId, t]);

  const key = choiceKey(choice, dateKey);
  const current = loaded[key];
  const asked = useRef(new Set<string>());
  const load = useCallback(
    async (c: BoardChoice, force = false) => {
      const k = choiceKey(c, dateKey);
      if (!force && asked.current.has(k)) return;
      asked.current.add(k);
      setLoaded((m) => ({ ...m, [k]: { status: 'loading' } }));
      const { kind, opts } = boardRequest(c, dateKey);
      try {
        const board = await puzzlesApi.getLeaderboard(ctx, kind, opts);
        setLoaded((m) => ({ ...m, [k]: { status: 'ready', board } }));
      } catch (e) {
        asked.current.delete(k);
        const failure = boardFailure(e);
        if (failure.kind === 'error' && failure.clubGone && c.club) {
          // Not a member any more, or the club is gone: say so and show everyone instead.
          setNotice(failure.message);
          setClubs((list) => list.filter((x) => x.code !== c.club));
          setChoice((now) => (now.club === c.club ? { ...now, club: null } : now));
          setLoaded((m) => {
            const next = { ...m };
            delete next[k];
            return next;
          });
          return;
        }
        setLoaded((m) => ({ ...m, [k]: { status: 'failed', failure } }));
      }
    },
    [ctx, dateKey],
  );
  useEffect(() => {
    if (connection === 'ready') {
      asked.current.clear();
    }
  }, [connection]);
  useEffect(() => {
    if (connection === 'ready') void load(choice);
  }, [connection, choice, load]);

  const pick = (next: Partial<BoardChoice>) => {
    setNotice(null);
    setChoice((c) => validChoice({ ...c, ...next }, scopes));
  };
  const retry = () => (connection === 'ready' ? void load(choice, true) : void connect());

  if (entry === 'blocked') return <AgeBlocked onBack={app.back} />;
  if (entry === 'ask') return <AgeGate onBack={app.back} />;
  if (entry === 'sign_in') return <SignInPrompt onBack={app.back} />;

  // A banned account can see no board: one line says so, instead of an offline card or a refusal per board.
  const state: Loaded | { status: 'offline' } = auth.banned
    ? { status: 'failed', failure: boardFailure({ code: 'banned' }) }
    : connection === 'offline'
      ? { status: 'offline' }
      : connection === 'checking' || !current
        ? { status: 'loading' }
        : current;
  const minRated = state.status === 'ready' ? state.board.minRated ?? 20 : 20;

  return (
    <ScrollView contentContainerStyle={styles.wrap} testID="leaderboards">
      <ScreenHeader title={t('puzzles.boards.title')} onBack={app.back} />
      <View style={styles.choices} accessibilityRole="tablist">
        {BOARD_KINDS.map((k) => (
          <Choice key={k} grow testID={`board-tab-${k}`} label={t(boardTitleKey(k))} a11y={t('puzzles.boards.tabA11y', { board: t(boardTitleKey(k)) })} selected={choice.board === k} onPress={() => pick({ board: k })} />
        ))}
      </View>
      {choice.board === 'rush' && (
        <View style={styles.choices} accessibilityRole="tablist">
          {RUSH_PERIODS.map((p) => (
            <Choice key={p} grow testID={`board-period-${p}`} label={t(periodKey(p))} a11y={t('puzzles.boards.periodA11y', { period: t(periodKey(p)) })} selected={choice.period === p} onPress={() => pick({ period: p })} />
          ))}
        </View>
      )}
      {scopes.length > 1 && (
        <View style={[styles.choices, styles.scopes]} testID="board-scopes">
          <P style={styles.scopeLabel}>{t('puzzles.boards.scopeLabel')}</P>
          {scopes.map((s) => (
            <Choice key={s.club ?? '*'} role="button" testID={`board-scope-${s.club ?? 'all'}`} label={s.label} a11y={s.a11y} selected={choice.club === s.club} onPress={() => pick({ club: s.club })} />
          ))}
        </View>
      )}
      <P dim style={styles.note}>
        {choice.board === 'rating' ? t('puzzles.boards.notes.rating', { count: minRated }) : t(`puzzles.boards.notes.${choice.board}`)}
      </P>
      {notice && (
        <Live message={t(notice.key, notice.params)} testID="boards-notice">
          <Pill tone="gold" icon="warning" wrap text={t(notice.key, notice.params)} />
        </Live>
      )}
      <Card style={styles.card}>
        {state.status === 'loading' && (
          <View testID="boards-loading" style={styles.centre} accessibilityLiveRegion="polite">
            <ActivityIndicator color={colors.ink} />
            <P dim>{t('puzzles.boards.loading')}</P>
          </View>
        )}
        {(state.status === 'offline' || (state.status === 'failed' && state.failure.kind === 'offline')) && (
          <Live message={t('puzzles.boards.offlineTitle')} testID="boards-offline" style={styles.centre}>
            <Row>
              <Icon name="warning" size={28} />
              <H2 style={{ flexShrink: 1 }}>{t('puzzles.boards.offlineTitle')}</H2>
            </Row>
            <P dim style={{ textAlign: 'center' }}>{t('puzzles.boards.offlineBody')}</P>
            <Button title={t('puzzles.boards.retry')} onPress={retry} testID="boards-retry" />
          </Live>
        )}
        {state.status === 'failed' && state.failure.kind === 'error' && (
          <Live message={t(state.failure.message.key, state.failure.message.params)} assertive testID="boards-error" style={styles.centre}>
            <Pill tone="danger" icon="warning" wrap text={t(state.failure.message.key, state.failure.message.params)} />
            <Button title={t('puzzles.boards.retry')} onPress={retry} testID="boards-retry" />
          </Live>
        )}
        {state.status === 'ready' && <BoardList board={state.board} userId={userId} visible={visible} />}
      </Card>
    </ScrollView>
  );
}

function BoardList({ board, userId, visible }: { board: Board; userId: string | null; visible?: boolean }) {
  const app = useApp();
  const { t } = useT();
  const view = boardView(board, userId, t, visible);
  return (
    <View style={{ gap: space.sm }} testID={`board-${board.board}`}>
      {view.hidden && (
        <View style={styles.hidden} testID="boards-hidden">
          <Row>
            <Icon name="lock" size={22} />
            <P style={styles.hiddenTitle}>{t('puzzles.boards.hiddenTitle')}</P>
          </Row>
          <P dim style={styles.detail}>{t('puzzles.boards.hiddenBody')}</P>
          <Row>
            <Button small kind="ghost" icon="cog" title={t('puzzles.boards.hiddenCta')} onPress={() => app.go({ name: 'settings' })} testID="boards-hidden-settings" />
          </Row>
        </View>
      )}
      {view.empty ? (
        <View style={styles.centre} testID="boards-empty">
          <Icon name="trophy" size={34} />
          <P style={{ textAlign: 'center' }}>{emptyText(board, t)}</P>
          {board.board === 'daily' && <Button kind="gold" title={t('puzzles.boards.playDaily')} onPress={() => app.go({ name: 'daily' })} />}
          {board.board === 'rush' && <Button kind="danger" title={t('puzzles.boards.playRush')} onPress={() => app.go({ name: 'rush' })} />}
        </View>
      ) : (
        <>
          {view.rows.length > 0 && (
            <View style={styles.head} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
              <P dim style={[styles.rank, styles.headText]}>{t('puzzles.boards.columns.rank')}</P>
              <P dim style={[styles.headText, { flex: 1, paddingLeft: 44 }]}>{t('puzzles.boards.columns.player')}</P>
              <P dim style={[styles.headText, { textAlign: 'right' }]}>{t(`puzzles.boards.columns.${board.board}`)}</P>
            </View>
          )}
          <View style={{ gap: 6 }} testID="board-rows">
            {view.rows.map((r) => (
              <BoardRowLine key={r.key} row={r} />
            ))}
          </View>
          {view.pinned && (
            <View style={styles.pinned} testID="boards-pinned">
              <P dim style={styles.headText}>{t('puzzles.boards.yourPlace')}</P>
              <BoardRowLine row={view.pinned} />
            </View>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md, flexGrow: 1, width: '100%', maxWidth: 760, alignSelf: 'center' },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  scopes: { alignItems: 'center' },
  grow: { flexGrow: 1, flexBasis: 0 },
  choice: { minHeight: 44, minWidth: 64, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 2.5, borderBottomWidth: 4, borderColor: colors.ink, backgroundColor: colors.creamLight },
  choiceOn: { backgroundColor: colors.gold },
  choiceText: { fontSize: 15, lineHeight: 19, textAlign: 'center', color: colors.ink },
  scopeLabel: { fontSize: 14, color: '#FFFFFF', fontFamily: fonts.uiBold, textShadowColor: colors.ink, textShadowRadius: 2 },
  note: { fontSize: 13, lineHeight: 18, color: colors.ink, backgroundColor: 'rgba(255,255,255,0.75)', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6, overflow: 'hidden' },
  card: { padding: space.md },
  centre: { alignItems: 'center', gap: space.sm, paddingVertical: space.md },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8 },
  headText: { fontSize: 12, lineHeight: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 14, borderWidth: 2, borderColor: 'transparent', backgroundColor: 'rgba(255,255,255,0.6)' },
  rowMine: { backgroundColor: '#FFF1C4', borderColor: colors.ink },
  rank: { minWidth: 32, textAlign: 'center', fontSize: 17, fontFamily: fonts.display, color: colors.ink },
  who: { flex: 1, minWidth: 0, gap: 2 },
  name: { fontSize: 15, lineHeight: 20, fontFamily: fonts.bodyHeavy },
  detail: { fontSize: 12, lineHeight: 16 },
  value: { fontSize: 18, lineHeight: 22, fontFamily: fonts.display, color: colors.ink, textAlign: 'right', flexShrink: 0, maxWidth: '40%' },
  valueDim: { fontSize: 13, lineHeight: 17, fontFamily: fonts.bodyHeavy, color: colors.inkDim },
  hidden: { gap: 6, padding: 10, borderRadius: 14, borderWidth: 2, borderColor: colors.ink, backgroundColor: '#FFF1C4' },
  hiddenTitle: { flex: 1, fontFamily: fonts.bodyHeavy },
  pinned: { gap: 4, borderTopWidth: 2, borderStyle: 'dashed', borderColor: colors.creamEdge, paddingTop: space.sm },
});
