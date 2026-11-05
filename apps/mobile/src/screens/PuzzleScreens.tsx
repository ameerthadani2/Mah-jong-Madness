import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { dailyPuzzle, dailySeed, rushPuzzle } from '@mjm/engine';
import { randomHex } from '@mjm/net';
import { useApp } from '../app-state';
import { effectiveStreak, todayKey } from '../storage';
import { nextDailyProgress } from '../logic/daily';
import { localDayAsUtc } from '../logic/dates';
import { rushOutcome } from '../logic/rush';
import { canUse, consume } from '../monetisation/store';
import { colors, fonts, space } from '../theme';
import { PuzzleView } from '../components/PuzzleView';
import { Button, Card, H2, P, Pill, Row, ScreenHeader, StrokeText } from '../components/Ui';
import { Icon } from '../components/Icons';
import { useT } from '../i18n';

export function DailyPuzzleScreen() {
  const app = useApp();
  const { t } = useT();
  // One puzzle per local calendar day, recorded under the same local date key.
  const [day] = useState(() => new Date());
  const today = todayKey(day);
  const puzzle = useMemo(() => dailyPuzzle(localDayAsUtc(day)), [day]);
  const attemptedBefore = app.progress.dailySolved[today] !== undefined;
  const [done, setDone] = useState(attemptedBefore);
  const [wasCorrect, setWasCorrect] = useState<boolean | null>(null);
  const streak = effectiveStreak(app.progress);

  const onResult = (r: { correct: boolean }) => {
    setDone(true);
    setWasCorrect(r.correct);
    app.setProgress((p) => {
      const next = nextDailyProgress(p, r.correct, today);
      return next === p ? p : { ...next, drillsPlayed: p.drillsPlayed + 1, drillsCorrect: p.drillsCorrect + (r.correct ? 1 : 0) };
    });
  };

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <ScreenHeader title={t('puzzles.daily.title')} onBack={app.back} />
      <Row style={{ flexWrap: 'wrap', rowGap: 6 }}>
        <Pill icon="scroll" text={dailySeed(localDayAsUtc(day)).replace('daily-', '')} />
        <Pill icon="flame" text={t('puzzles.daily.streak', { n: streak })} tone={streak > 0 ? 'gold' : 'neutral'} />
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
      <P style={{ fontSize: 12 }}>{t('puzzles.daily.about')}</P>
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
  useEffect(() => {
    if (allowance.ok && allowance.limit !== null) app.setWallet(consume(app.wallet, 'rush'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);
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
      onAgain={() => {
        const next = canUse(app.wallet, 'rush');
        setAllowance(next);
        if (next.ok) setRun((r) => r + 1);
      }}
    />
  );
}

function PuzzleRushRun({ onAgain }: { onAgain: () => void }) {
  const app = useApp();
  const { t } = useT();
  const [runSeed] = useState(() => `rush-${randomHex(4)}`);
  // The saved best is raised as soon as the run ends, so judge the run against the best from before it.
  const [prevBest] = useState(() => app.progress.rushBest);
  const [index, setIndex] = useState(0);
  const [score, setScore] = useState(0);
  const [strikes, setStrikes] = useState(0);
  const [left, setLeft] = useState(RUSH_SECONDS);
  const [over, setOver] = useState(false);
  const recorded = useRef(false);
  const puzzle = useMemo(() => rushPuzzle(runSeed, index), [runSeed, index]);

  useEffect(() => {
    if (over) return;
    const id = setInterval(() => setLeft((l) => (l <= 1 ? 0 : l - 1)), 1000);
    return () => clearInterval(id);
  }, [over]);
  useEffect(() => {
    if ((left === 0 || strikes >= RUSH_STRIKES) && !over) setOver(true);
  }, [left, strikes, over]);
  useEffect(() => {
    if (!over || recorded.current) return;
    recorded.current = true;
    app.setProgress((p) => ({ ...p, rushRuns: p.rushRuns + 1, rushBest: Math.max(p.rushBest, score) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [over]);

  const onResult = (r: { correct: boolean }) => {
    if (r.correct) setScore((s) => s + 1);
    else setStrikes((s) => s + 1);
  };

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <ScreenHeader title={t('puzzles.rush.title')} onBack={app.back} />
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
        <Pill icon="trophy" text={t('puzzles.rush.best', { n: app.progress.rushBest })} tone="gold" />
      </Row>
      <Card>
        {over ? (
          <View style={{ gap: 8, alignItems: 'center' }}>
            <StrokeText style={styles.big} strokeWidth={3} drop={3}>
              {String(score)}
            </StrokeText>
            <H2>{t(`puzzles.rush.outcome.${rushOutcome(prevBest, score).kind}`)}</H2>
            <P dim>{t(strikes >= RUSH_STRIKES ? 'puzzles.rush.endStrikes' : 'puzzles.rush.endTime')}</P>
            <Row>
              <Button title={t('puzzles.rush.playAgain')} onPress={onAgain} />
              <Button kind="ghost" title={t('puzzles.rush.backToLearn')} onPress={app.back} />
            </Row>
          </View>
        ) : (
          <>
            <P dim style={{ fontSize: 12 }}>
              {t('puzzles.rush.progress', { n: index + 1, type: t(puzzle.type === 'discard' ? 'puzzles.rush.typeDiscard' : 'puzzles.rush.typeWaits') })}
            </P>
            <PuzzleView puzzle={puzzle} onResult={onResult} onNext={() => setIndex((i) => i + 1)} autoAdvance />
          </>
        )}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md },
  big: { fontSize: 64, fontFamily: fonts.display },
  strikes: { flexDirection: 'row', gap: 4, alignItems: 'center' },
  strike: { width: 24, height: 24, borderRadius: 12, borderWidth: 2.5, borderColor: colors.ink, backgroundColor: colors.creamLight, alignItems: 'center', justifyContent: 'center' },
});
