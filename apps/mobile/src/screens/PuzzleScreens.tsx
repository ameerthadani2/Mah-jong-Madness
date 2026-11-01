import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { dailyPuzzle, dailySeed, rushPuzzle } from '@mjm/engine';
import { randomHex } from '@mjm/net';
import { useApp } from '../app-state';
import { effectiveStreak, todayKey, yesterdayKey } from '../storage';
import { canUse, consume } from '../monetisation/store';
import { colors, space } from '../theme';
import { PuzzleView } from '../components/PuzzleView';
import { Button, Card, H1, H2, P, Pill, Row } from '../components/Ui';

export function DailyPuzzleScreen() {
  const app = useApp();
  const today = todayKey();
  const puzzle = useMemo(() => dailyPuzzle(new Date()), []);
  const attemptedBefore = app.progress.dailySolved[today] !== undefined;
  const [done, setDone] = useState(attemptedBefore);
  const [wasCorrect, setWasCorrect] = useState<boolean | null>(null);
  const streak = effectiveStreak(app.progress);

  const onResult = (r: { correct: boolean }) => {
    setDone(true);
    setWasCorrect(r.correct);
    app.setProgress((p) => {
      if (p.dailySolved[today] !== undefined) return p;
      const continues = effectiveStreak(p) > 0 && p.dailyLastDate === yesterdayKey();
      const nextStreak = r.correct ? (continues ? p.dailyStreak + 1 : 1) : 0;
      return { ...p, dailySolved: { ...p.dailySolved, [today]: r.correct ? 'correct' : 'wrong' }, dailyStreak: nextStreak, dailyLastDate: today, drillsPlayed: p.drillsPlayed + 1, drillsCorrect: p.drillsCorrect + (r.correct ? 1 : 0) };
    });
  };

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Row style={{ justifyContent: 'space-between' }}>
        <H1 style={{ fontSize: 22 }}>Daily puzzle</H1>
        <Button small kind="ghost" title="Back" onPress={app.back} />
      </Row>
      <Row>
        <Pill text={dailySeed(new Date()).replace('daily-', '')} />
        <Pill text={`🔥 ${streak}-day streak`} tone={streak > 0 ? 'gold' : 'neutral'} />
        {attemptedBefore && <Pill text={app.progress.dailySolved[today] === 'correct' ? 'Solved today' : 'Attempted today'} tone={app.progress.dailySolved[today] === 'correct' ? 'ok' : 'neutral'} />}
      </Row>
      <Card>
        {attemptedBefore && wasCorrect === null ? (
          <>
            <H2>Already played today</H2>
            <P dim>Come back tomorrow for a new one, or keep sharp with Puzzle Rush.</P>
            <Button title="Puzzle Rush" onPress={() => app.go({ name: 'rush' })} />
          </>
        ) : (
          <PuzzleView puzzle={puzzle} onResult={onResult} onNext={app.back} nextLabel={done ? 'Done' : 'Next'} />
        )}
      </Card>
      <P dim style={{ fontSize: 12 }}>
        Everyone in the world gets the same puzzle each day. Weekends are harder.
      </P>
    </ScrollView>
  );
}

const RUSH_SECONDS = 180;
const RUSH_STRIKES = 3;

export function PuzzleRushScreen() {
  const app = useApp();
  const [run, setRun] = useState(0);
  const [allowance, setAllowance] = useState(() => canUse(app.wallet, 'rush'));
  useEffect(() => {
    if (allowance.ok && allowance.limit !== null) app.setWallet(consume(app.wallet, 'rush'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);
  if (!allowance.ok) {
    return (
      <ScrollView contentContainerStyle={styles.wrap}>
        <Row style={{ justifyContent: 'space-between' }}>
          <H1 style={{ fontSize: 22 }}>Puzzle Rush</H1>
          <Button small kind="ghost" title="Back" onPress={app.back} />
        </Row>
        <Card>
          <H2>Daily run used</H2>
          <P dim>Free accounts get one Puzzle Rush a day. Coach Gold makes it unlimited, with history and leaderboards.</P>
          <Row>
            <Button title="See Coach plans" onPress={() => app.go({ name: 'shop' })} />
            <Button kind="ghost" title="Daily puzzle instead" onPress={() => app.go({ name: 'daily' })} />
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
  const [runSeed] = useState(() => `rush-${randomHex(4)}`);
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
      <Row style={{ justifyContent: 'space-between' }}>
        <H1 style={{ fontSize: 22 }}>Puzzle Rush</H1>
        <Button small kind="ghost" title="Quit" onPress={app.back} />
      </Row>
      <Row>
        <Pill text={`⏱ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`} tone={left <= 20 ? 'danger' : 'neutral'} />
        <Pill text={`✓ ${score}`} tone="ok" />
        <Pill text={`✗ ${'●'.repeat(strikes)}${'○'.repeat(RUSH_STRIKES - strikes)}`} tone={strikes > 0 ? 'danger' : 'neutral'} />
        <Pill text={`Best ${app.progress.rushBest}`} tone="gold" />
      </Row>
      <Card>
        {over ? (
          <View style={{ gap: 8, alignItems: 'center' }}>
            <Text style={styles.big}>{score}</Text>
            <H2>{score > app.progress.rushBest ? 'New personal best!' : score >= app.progress.rushBest && score > 0 ? 'Matched your best' : 'Run over'}</H2>
            <P dim>
              {strikes >= RUSH_STRIKES ? 'Three strikes.' : 'Time is up.'} Puzzles get harder the further you go.
            </P>
            <Row>
              <Button title="Play again" onPress={onAgain} />
              <Button kind="ghost" title="Back to Learn" onPress={app.back} />
            </Row>
          </View>
        ) : (
          <>
            <P dim style={{ fontSize: 12 }}>
              Puzzle {index + 1} · {puzzle.type === 'discard' ? 'Best discard' : 'Read the wait'}
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
  big: { color: colors.ink, fontSize: 64, fontWeight: '900' },
});
