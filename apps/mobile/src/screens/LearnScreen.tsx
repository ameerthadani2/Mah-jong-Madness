import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { kindsFromString, LESSONS, kindFromCode, type LessonStep } from '@mjm/engine';
import { useApp } from '../app-state';
import { effectiveStreak } from '../storage';
import { colors, space } from '../theme';
import { Tile } from '../components/Tile';
import { Button, Card, H1, H2, P, Pill, Row } from '../components/Ui';

export function LearnScreen() {
  const app = useApp();
  const done = app.progress.lessonsDone;
  const acc = app.progress.drillsPlayed ? Math.round((app.progress.drillsCorrect / app.progress.drillsPlayed) * 100) : null;
  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Row style={{ justifyContent: 'space-between' }}>
        <H1>Learn</H1>
        <Button testID="back" small kind="ghost" title="Back" onPress={app.back} />
      </Row>
      <View style={styles.grid}>
        <Card style={styles.drill}>
          <Text style={styles.icon}>🧩</Text>
          <H2>Daily puzzle</H2>
          <P dim style={{ fontSize: 13 }}>Same puzzle for everyone, every day. Keep the streak alive.</P>
          <Row style={{ justifyContent: 'space-between' }}>
            <Pill text={`🔥 ${effectiveStreak(app.progress)} streak`} tone={effectiveStreak(app.progress) > 0 ? 'gold' : 'neutral'} />
            <Button small title="Solve" onPress={() => app.go({ name: 'daily' })} />
          </Row>
        </Card>
        <Card style={styles.drill}>
          <Text style={styles.icon}>⚡</Text>
          <H2>Puzzle Rush</H2>
          <P dim style={{ fontSize: 13 }}>Three minutes, three strikes, puzzles that get harder as you go.</P>
          <Row style={{ justifyContent: 'space-between' }}>
            <Pill text={`Best ${app.progress.rushBest} · ${app.progress.rushRuns} runs`} />
            <Button small title="Go" onPress={() => app.go({ name: 'rush' })} />
          </Row>
        </Card>
        <Card style={styles.drill}>
          <Text style={styles.icon}>🎯</Text>
          <H2>Best-discard drill</H2>
          <P dim style={{ fontSize: 13 }}>Random hands, you pick the discard. The coach grades it with shanten and acceptance.</P>
          <Row style={{ justifyContent: 'space-between' }}>
            <Pill text={acc === null ? 'No drills yet' : `${acc}% correct · ${app.progress.drillsPlayed} played`} />
            <Button small title="Train" onPress={() => app.go({ name: 'drill', kind: 'discard' })} />
          </Row>
        </Card>
        <Card style={styles.drill}>
          <Text style={styles.icon}>👂</Text>
          <H2>Read the wait</H2>
          <P dim style={{ fontSize: 13 }}>A ready hand is shown. Which tiles complete it? Learn to spot every 聽.</P>
          <Row style={{ justifyContent: 'flex-end' }}>
            <Button small title="Train" onPress={() => app.go({ name: 'drill', kind: 'waits' })} />
          </Row>
        </Card>
      </View>
      <H2>Lessons</H2>
      {LESSONS.map((l, i) => (
        <Card key={l.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Text style={styles.num}>{i + 1}</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>
              {l.title} <Text style={{ color: colors.textDim }}>{l.titleZh}</Text>
            </Text>
            <P dim style={{ fontSize: 13 }}>{l.summary}</P>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 6 }}>
            {done[l.id] ? <Pill text="Done" tone="ok" /> : <Pill text={`${l.minutes} min`} />}
            <Button small kind="secondary" title={done[l.id] ? 'Review' : 'Start'} onPress={() => app.go({ name: 'lesson', id: l.id })} />
          </View>
        </Card>
      ))}
    </ScrollView>
  );
}

export function HandView({ hand, size = 'sm', onPress, selected, highlight }: { hand: string; size?: 'xs' | 'sm' | 'md'; onPress?: (code: string, index: number) => void; selected?: string | null; highlight?: Record<string, 'good' | 'bad' | 'wait'> }) {
  const groups = hand.trim().split(/\s+/);
  return (
    <View style={styles.handRow}>
      {groups.map((g, gi) => {
        const kinds = kindsFromString(g);
        return (
          <View key={gi} style={styles.group}>
            {kinds.map((k, i) => {
              const code = codeOf(k);
              return <Tile key={`${gi}-${i}`} kind={k} size={size} selected={selected === code} highlight={highlight?.[code]} onPress={onPress ? () => onPress(code, i) : undefined} />;
            })}
          </View>
        );
      })}
    </View>
  );
}

function codeOf(kind: number): string {
  // inverse of kindFromCode via a small search; kinds are few
  const codes = ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p', '1s', '2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s', 'E', 'S', 'W', 'N', 'C', 'F', 'B', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'];
  return codes[kind];
}

export function LessonScreen({ id }: { id: string }) {
  const app = useApp();
  const lesson = LESSONS.find((l) => l.id === id)!;
  const [i, setI] = useState(0);
  const [answer, setAnswer] = useState<string | null>(null);
  const step: LessonStep = lesson.steps[i];
  const last = i === lesson.steps.length - 1;
  const quiz = step.quiz;
  const correct = quiz && answer !== null && kindFromCode(answer) === kindFromCode(quiz.answer);

  const next = () => {
    if (last) {
      app.setProgress((p) => ({ ...p, lessonsDone: { ...p.lessonsDone, [lesson.id]: true } }));
      app.back();
      return;
    }
    setI(i + 1);
    setAnswer(null);
  };

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Row style={{ justifyContent: 'space-between' }}>
        <H1 style={{ fontSize: 22 }}>
          {lesson.title} <Text style={{ color: colors.textDim, fontSize: 16 }}>{lesson.titleZh}</Text>
        </H1>
        <Button small kind="ghost" title="Exit" onPress={app.back} />
      </Row>
      <Row>
        {lesson.steps.map((_, j) => (
          <View key={j} style={[styles.dot, j <= i && { backgroundColor: colors.gold }]} />
        ))}
      </Row>
      <Card>
        <H2>{step.title}</H2>
        <P>{step.body}</P>
        {step.hand && <HandView hand={step.hand} size="md" />}
        {quiz && (
          <View style={{ gap: 8 }}>
            <P style={{ color: colors.gold, fontWeight: '800' }}>{quiz.prompt}</P>
            <HandView
              hand={quiz.hand}
              size="md"
              onPress={(code) => setAnswer(code)}
              selected={answer}
              highlight={answer !== null ? { [quiz.answer]: 'good', ...(correct ? {} : { [answer]: 'bad' }) } : undefined}
            />
            {answer !== null && (
              <P style={{ color: correct ? colors.ok : colors.danger }}>
                {correct ? 'Correct! ' : 'Not quite. '}
                <Text style={{ color: colors.text }}>{quiz.explanation}</Text>
              </P>
            )}
          </View>
        )}
      </Card>
      <Row style={{ justifyContent: 'space-between' }}>
        <Button kind="ghost" title="Previous" disabled={i === 0} onPress={() => setI(i - 1)} />
        <Button title={last ? 'Finish lesson' : 'Next'} disabled={!!quiz && answer === null} onPress={next} />
      </Row>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  drill: { flexGrow: 1, flexBasis: '45%', minWidth: 240 },
  icon: { fontSize: 26 },
  num: { color: colors.goldDim, fontSize: 24, fontWeight: '900', width: 28 },
  title: { color: colors.ink, fontSize: 16, fontWeight: '900' },
  handRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingVertical: 8 },
  group: { flexDirection: 'row', gap: 2 },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.cream, borderWidth: 2, borderColor: colors.creamEdge },
});
