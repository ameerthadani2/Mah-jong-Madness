import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { dailyPuzzle, dailySeed, rushScore } from '@mjm/engine';
import { randomHex } from '@mjm/net';
import { useApp } from '../app-state';
import { effectiveStreak, todayKey } from '../storage';
import { nextDailyProgress } from '../logic/daily';
import { localDayAsUtc } from '../logic/dates';
import { dailyDifficulty, puzzleDifficultyOf, PUZZLE_TYPE_KEYS, type PuzzleResult } from '../logic/puzzle';
import { rateAnswer, recordRush } from '../logic/rating';
import { rushDifficulty, rushOutcome, rushPuzzleAt } from '../logic/rush';
import { canUse, consume } from '../monetisation/store';
import { colors, fonts, space } from '../theme';
import { PuzzleView } from '../components/PuzzleView';
import { RatingPill } from '../components/puzzles/RatingPill';
import { Button, Card, H2, P, Pill, Row, ScreenHeader, StrokeText } from '../components/Ui';
import { Icon } from '../components/Icons';
import { ConfirmSheet } from '../components/table/ConfirmSheet';
import { useT } from '../i18n';

export function DailyPuzzleScreen() {
  const app = useApp();
  const { t } = useT();
  // One puzzle per local calendar day, recorded under the same local date key.
  const [day] = useState(() => new Date());
  const today = todayKey(day);
  const puzzle = useMemo(() => dailyPuzzle(localDayAsUtc(day)), [day]);
  const difficulty = dailyDifficulty(localDayAsUtc(day));
  const attemptedBefore = app.progress.dailySolved[today] !== undefined;
  const [done, setDone] = useState(attemptedBefore);
  const [wasCorrect, setWasCorrect] = useState<boolean | null>(null);
  const streak = effectiveStreak(app.progress);

  const onResult = (r: PuzzleResult) => {
    setDone(true);
    setWasCorrect(r.correct);
    // Only the day's first attempt counts, for the streak and for the rating alike.
    app.setProgress((p) => {
      const next = nextDailyProgress(p, r.correct, today);
      return next === p ? p : rateAnswer({ ...next, drillsPlayed: p.drillsPlayed + 1, drillsCorrect: p.drillsCorrect + (r.correct ? 1 : 0) }, 'discard', difficulty, r.correct, Date.now());
    });
  };

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <ScreenHeader title={t('puzzles.daily.title')} onBack={app.back} />
      <Row style={{ flexWrap: 'wrap', rowGap: 6 }}>
        <Pill icon="scroll" text={dailySeed(localDayAsUtc(day)).replace('daily-', '')} />
        <Pill icon="flame" text={t('puzzles.daily.streak', { n: streak })} tone={streak > 0 ? 'gold' : 'neutral'} />
        <RatingPill rating={app.progress.puzzleRating} history={app.progress.ratingHistory} showChange={wasCorrect !== null} />
        {attemptedBefore && <Pill text={t(app.progress.dailySolved[today] === 'correct' ? 'puzzles.daily.solvedToday' : 'puzzles.daily.attemptedToday')} tone={app.progress.dailySolved[today] === 'correct' ? 'ok' : 'neutral'} />}
      </Row>
      <Card>
        {attemptedBefore && wasCorrect === null ? (
          <>
            <Row>
              <Icon name="check" size={30} color={colors.cta} />
              <H2>{t('puzzles.daily.alreadyTitle')}</H2>
            </Row>
            <P dim>{t('puzzles.daily.alreadyText')}</P>
            <Button title={t('puzzles.daily.rush')} onPress={() => app.go({ name: 'rush' })} />
          </>
        ) : (
          <PuzzleView puzzle={puzzle} onResult={onResult} onNext={app.back} nextLabel={t(done ? 'puzzles.daily.done' : 'puzzles.daily.next')} />
        )}
      </Card>
      <PuzzleFoot about={t('puzzles.daily.about')} />
    </ScrollView>
  );
}

const RUSH_SECONDS = 180;
const RUSH_STRIKES = 3;

export function PuzzleRushScreen() {
  const app = useApp();
  const { t } = useT();
  const [run, setRun] = useState(0);
  const [allowance, setAllowance] = useState(() => canUse(app.wallet, 'rush'));
  // A free run is spent when its first puzzle is answered, not when the screen opens: opening Rush and
  // backing out at once costs nothing (and a run that was started is always recorded: see PuzzleRushRun).
  const spent = useRef<number | null>(null);
  const startRun = () => {
    if (spent.current === run) return;
    spent.current = run;
    if (allowance.ok && allowance.limit !== null) app.setWallet(consume(app.wallet, 'rush'));
  };
  if (!allowance.ok) {
    return (
      <ScrollView contentContainerStyle={styles.wrap}>
        <ScreenHeader title={t('puzzles.rush.title')} onBack={app.back} />
        <Card>
          <Row>
            <Icon name="lock" size={30} />
            <H2>{t('puzzles.rush.usedTitle')}</H2>
          </Row>
          <P dim>{t('puzzles.rush.usedText')}</P>
          <Row>
            <Button title={t('puzzles.rush.seePlans')} onPress={() => app.go({ name: 'shop' })} />
            <Button kind="ghost" title={t('puzzles.rush.dailyInstead')} onPress={() => app.go({ name: 'daily' })} />
          </Row>
        </Card>
      </ScrollView>
    );
  }
  return (
    <PuzzleRushRun
      key={run}
      onStart={startRun}
      onAgain={() => {
        const next = canUse(app.wallet, 'rush');
        setAllowance(next);
        if (next.ok) setRun((r) => r + 1);
      }}
    />
  );
}

function PuzzleRushRun({ onAgain, onStart }: { onAgain: () => void; /** The first answer: the run counts from here (and spends a free run). */ onStart: () => void }) {
  const app = useApp();
  const { t } = useT();
  const [runSeed] = useState(() => `rush-${randomHex(4)}`);
  // The saved best is raised as soon as the run ends, so judge the run against the best from before it.
  const [prevBest] = useState(() => app.progress.rushBestScore);
  const [index, setIndex] = useState(0);
  const [score, setScore] = useState(0);
  const [strikes, setStrikes] = useState(0);
  const [left, setLeft] = useState(RUSH_SECONDS);
  const [over, setOver] = useState(false);
  const recorded = useRef(false);
  const puzzle = useMemo(() => rushPuzzleAt(runSeed, index), [runSeed, index]);
  const [answeredOnce, setAnsweredOnce] = useState(false);
  // Seconds played so far: the clock stops when the run ends, so this is the run's time once over.
  const elapsed = RUSH_SECONDS - left;
  const points = rushScore(score, elapsed);

  useEffect(() => {
    if (over) return;
    const id = setInterval(() => setLeft((l) => (l <= 1 ? 0 : l - 1)), 1000);
    return () => clearInterval(id);
  }, [over]);
  useEffect(() => {
    if ((left === 0 || strikes >= RUSH_STRIKES) && !over) setOver(true);
  }, [left, strikes, over]);
  const record = () => {
    if (recorded.current) return;
    recorded.current = true;
    app.setProgress((p) => recordRush(p, score, elapsed).progress);
  };
  useEffect(() => {
    if (over) record();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [over]);
  // Leaving mid-run asks first; leaving ends the run and records it (the free run it spent is not lost unrecorded).
  const [askLeave, setAskLeave] = useState(false);
  const back = () => (answeredOnce && !over ? setAskLeave(true) : app.back());
  const leaveRun = () => {
    setAskLeave(false);
    record();
    app.back();
  };

  const onResult = (r: PuzzleResult) => {
    if (!answeredOnce) onStart();
    if (r.correct) setScore((s) => s + 1);
    else setStrikes((s) => s + 1);
    setAnsweredOnce(true);
    const difficulty = r.difficulty ?? puzzleDifficultyOf(puzzle, rushDifficulty(index));
    app.setProgress((p) => rateAnswer(p, r.type, difficulty, r.correct, Date.now()));
  };

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <ScreenHeader title={t('puzzles.rush.title')} onBack={back} />
      <ConfirmSheet
        visible={askLeave}
        testID="rush-leave-sheet"
        title={t('puzzles.rush.leaveTitle')}
        body={t('puzzles.rush.leaveBody', { n: score })}
        yes={t('puzzles.rush.leaveYes')}
        no={t('puzzles.rush.leaveNo')}
        onYes={leaveRun}
        onNo={() => setAskLeave(false)}
      />
      <Row style={{ flexWrap: 'wrap', rowGap: 6 }}>
        <Pill icon="clock" text={`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`} tone={left <= 20 ? 'danger' : 'neutral'} />
        <Pill icon="check" text={`${score}`} tone="ok" />
        <View style={styles.strikes}>
          {Array.from({ length: RUSH_STRIKES }).map((_, i) => (
            <View key={i} style={[styles.strike, i < strikes && { backgroundColor: colors.danger }]}>
              {i < strikes && <Icon name="cross" size={14} />}
            </View>
          ))}
        </View>
        <Pill icon="trophy" text={t('puzzles.rush.bestScore', { n: app.progress.rushBestScore })} tone="gold" />
        <RatingPill rating={app.progress.puzzleRating} history={app.progress.ratingHistory} showChange={answeredOnce} />
      </Row>
      <Card>
        {over ? (
          <View style={{ gap: 8, alignItems: 'center' }}>
            <StrokeText style={styles.big} strokeWidth={3} drop={3}>
              {String(points)}
            </StrokeText>
            <Pill icon="check" text={t('puzzles.rush.solved', { n: score })} tone="ok" />
            <H2>{t(`puzzles.rush.outcome.${rushOutcome(prevBest, points).kind}`)}</H2>
            <P dim>{t(strikes >= RUSH_STRIKES ? 'puzzles.rush.endStrikes' : 'puzzles.rush.endTime')}</P>
            <Row>
              <Button title={t('puzzles.rush.playAgain')} onPress={onAgain} />
              <Button kind="ghost" title={t('puzzles.rush.backToLearn')} onPress={app.back} />
            </Row>
          </View>
        ) : (
          <>
            <P dim style={{ fontSize: 12 }}>
              {t('puzzles.rush.progress', { n: index + 1, type: t(PUZZLE_TYPE_KEYS[puzzle.type]) })}
            </P>
            <PuzzleView puzzle={puzzle} onResult={onResult} onNext={() => setIndex((i) => i + 1)} autoAdvance />
          </>
        )}
      </Card>
      <PuzzleFoot />
    </ScrollView>
  );
}

/**
 * The bottom of a puzzle screen: the player's puzzle record and a tip, so tall phones are not left with half a
 * screen of empty sky under the puzzle (it sits at the bottom of the scroll content and wraps on narrow screens).
 */
export function PuzzleFoot({ about }: { /** A line about this screen, shown above the tip. */ about?: string }) {
  const app = useApp();
  const { t } = useT();
  const p = app.progress;
  const acc = p.drillsPlayed ? Math.round((p.drillsCorrect / p.drillsPlayed) * 100) : null;
  const tips = ['puzzles.foot.tip1', 'puzzles.foot.tip2', 'puzzles.foot.tip3'];
  // One tip per day, the same all day.
  const tip = tips[new Date().getDate() % tips.length];
  const stat = (icon: 'target' | 'flame' | 'trophy' | 'check', value: string, label: string) => (
    <View style={styles.stat} accessible accessibilityLabel={`${label}: ${value}`}>
      <Icon name={icon} size={22} />
      <StrokeText style={styles.statValue} strokeWidth={2} drop={1.5}>
        {value}
      </StrokeText>
      <P dim style={styles.statLabel}>
        {label}
      </P>
    </View>
  );
  return (
    <View style={styles.foot} testID="puzzle-foot">
      <Card tone="sky" style={{ gap: space.sm }}>
        <H2>{t('puzzles.foot.title')}</H2>
        <View style={styles.stats}>
          {stat('target', String(p.puzzleRating), t('puzzles.foot.rating'))}
          {stat('flame', String(effectiveStreak(p)), t('puzzles.foot.streak'))}
          {stat('trophy', String(p.rushBestScore), t('puzzles.foot.rushBest'))}
          {stat('check', acc === null ? '–' : `${acc}%`, t('puzzles.foot.accuracy'))}
        </View>
      </Card>
      {about ? <P style={{ fontSize: 12 }}>{about}</P> : null}
      <Row style={styles.tip}>
        <Icon name="book" size={22} />
        <P style={{ flex: 1, fontSize: 13, lineHeight: 18 }}>{t(tip)}</P>
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md, flexGrow: 1 },
  foot: { marginTop: 'auto', gap: space.sm, paddingTop: space.sm },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, justifyContent: 'space-between' },
  stat: { alignItems: 'center', minWidth: 64, flexGrow: 1, gap: 2 },
  statValue: { fontSize: 22, fontFamily: fonts.display },
  statLabel: { fontSize: 12, textAlign: 'center' },
  tip: { backgroundColor: 'rgba(255,255,255,0.75)', borderWidth: 2, borderColor: colors.ink, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 8, alignItems: 'center' },
  big: { fontSize: 64, fontFamily: fonts.display },
  strikes: { flexDirection: 'row', gap: 4, alignItems: 'center' },
  strike: { width: 24, height: 24, borderRadius: 12, borderWidth: 2.5, borderColor: colors.ink, backgroundColor: colors.creamLight, alignItems: 'center', justifyContent: 'center' },
});
