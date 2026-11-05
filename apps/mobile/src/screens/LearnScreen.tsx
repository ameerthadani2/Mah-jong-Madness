import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { kindsFromString, LESSONS, type LessonStep } from '@mjm/engine';
import { useApp } from '../app-state';
import { effectiveStreak } from '../storage';
import { rollingAccuracy } from '../logic/accuracy';
import { lessonAnswers, lessonComplete } from '../logic/lesson';
import { colors, fonts, space } from '../theme';
import { Tile } from '../components/Tile';
import { Button, Card, H2, P, Pill, Row, ScreenHeader, SectionLabel, StrokeText } from '../components/Ui';
import { Icon, type IconName } from '../components/Icons';

export function LearnScreen() {
  const app = useApp();
  const { width } = useWindowDimensions();
  const done = app.progress.lessonsDone;
  const acc = app.progress.drillsPlayed ? Math.round((app.progress.drillsCorrect / app.progress.drillsPlayed) * 100) : null;
  const streak = effectiveStreak(app.progress);
  const cols = width >= 1000 ? 4 : width >= 640 ? 2 : 1;
  const lessonCols = width >= 900 ? 2 : 1;
  const pad = width >= 1000 ? 28 : space.lg;
  const drillW = Math.floor((width - pad * 2 - space.md * (cols - 1)) / cols);
  const lessonW = Math.floor((width - pad * 2 - space.md * (lessonCols - 1)) / lessonCols);
  const lessonsDone = Object.keys(done).length;
  const reviewAcc = rollingAccuracy(app.progress.reviewAccuracies);
  return (
    <ScrollView contentContainerStyle={[styles.wrap, { padding: pad }]}>
      <ScreenHeader title="Learn" onBack={app.back} backTestID="back" right={<Pill text={`${lessonsDone}/${LESSONS.length} lessons`} icon="book" tone="gold" />} />
      <View style={styles.grid}>
        <DrillCard w={drillW} icon="scroll" tint={colors.gold} title="Daily puzzle" text="Same puzzle for everyone, every day. Keep the streak alive." stat={`${streak} day streak`} statIcon="flame" statTone={streak > 0 ? 'gold' : 'neutral'} cta="Solve" kind="gold" onPress={() => app.go({ name: 'daily' })} />
        <DrillCard w={drillW} icon="bolt" tint={colors.danger} title="Puzzle Rush" text="Three minutes, three strikes, puzzles that get harder." stat={`Best ${app.progress.rushBest} · ${app.progress.rushRuns} runs`} statIcon="trophy" cta="Go" kind="danger" onPress={() => app.go({ name: 'rush' })} />
        <DrillCard w={drillW} icon="target" tint={colors.cta} title="Best discard" text="Random hands; pick the discard. The coach grades shanten and acceptance." stat={acc === null ? 'No drills yet' : `${acc}% · ${app.progress.drillsPlayed} played`} statIcon="check" cta="Train" kind="primary" onPress={() => app.go({ name: 'drill', kind: 'discard' })} />
        <DrillCard w={drillW} icon="magnifier" tint={colors.info} title="Read the wait" text="A ready hand is shown. Which tiles complete it? Spot every 聽." cta="Train" kind="secondary" onPress={() => app.go({ name: 'drill', kind: 'waits' })} />
      </View>
      <Row style={{ flexWrap: 'wrap', rowGap: 6 }}>
        <Pill icon="magnifier" text={reviewAcc === null ? 'Review a hand after a game to track your accuracy' : `Hand review accuracy ${reviewAcc}% · last ${app.progress.reviewAccuracies.length} reviewed`} tone={reviewAcc === null ? 'neutral' : 'ok'} />
      </Row>
      <SectionLabel>Lessons</SectionLabel>
      <View style={styles.grid}>
        {LESSONS.map((l, i) => (
          <Card key={l.id} style={{ width: lessonW, flexDirection: 'row', alignItems: 'center', gap: space.md, padding: 12 }}>
            <View style={[styles.medal, done[l.id] && { backgroundColor: colors.cta }]}>
              {done[l.id] ? (
                <Icon name="check" size={28} />
              ) : (
                <StrokeText style={{ fontSize: 22 }} strokeWidth={1.8} drop={1.5}>
                  {i + 1}
                </StrokeText>
              )}
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Row gap={6} style={{ flexWrap: 'wrap' }}>
                <Text style={styles.title}>{l.title}</Text>
                <Text style={styles.titleZh}>{l.titleZh}</Text>
              </Row>
              <P dim style={{ fontSize: 12, lineHeight: 16 }} numberOfLines={2}>
                {l.summary}
              </P>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 6 }}>
              {done[l.id] ? <Pill text="Done" tone="ok" size="sm" /> : <Pill text={`${l.minutes} min`} icon="clock" size="sm" />}
              <Button small kind={done[l.id] ? 'ghost' : 'secondary'} title={done[l.id] ? 'Review' : 'Start'} onPress={() => app.go({ name: 'lesson', id: l.id })} />
            </View>
          </Card>
        ))}
      </View>
    </ScrollView>
  );
}

function DrillCard({ w, icon, tint, title, text, stat, statIcon, statTone, cta, kind, onPress }: { w?: number; icon: IconName; tint: string; title: string; text: string; stat?: string; statIcon?: IconName; statTone?: 'gold' | 'neutral'; cta: string; kind: 'gold' | 'danger' | 'primary' | 'secondary'; onPress: () => void }) {
  const plateIcon = (
    <View style={[styles.iconPlate, { backgroundColor: tint }]}>
      <View style={styles.iconShine} />
      <Icon name={icon} size={40} />
    </View>
  );
  const foot = (
    <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap', rowGap: 6, marginTop: 'auto' }}>
      {stat ? <Pill text={stat} icon={statIcon} tone={statTone ?? 'neutral'} size="sm" /> : <View />}
      <Button small kind={kind} title={cta} onPress={onPress} />
    </Row>
  );
  // Narrow columns (four across on tablets) stack the card vertically.
  if (w !== undefined && w < 320) {
    return (
      <Card style={{ width: w, gap: 8, padding: 12 }}>
        <Row gap={10}>
          {plateIcon}
          <Text style={[styles.drillTitle, { flex: 1 }]}>{title}</Text>
        </Row>
        <P dim style={{ fontSize: 12, lineHeight: 16 }} numberOfLines={3}>
          {text}
        </P>
        {foot}
      </Card>
    );
  }
  return (
    <Card style={{ width: w, flexDirection: 'row', gap: 12, padding: 12, alignItems: 'center' }}>
      {plateIcon}
      <View style={{ flex: 1, gap: 4, alignSelf: 'stretch' }}>
        <Text style={styles.drillTitle}>{title}</Text>
        <P dim style={{ fontSize: 12, lineHeight: 16 }} numberOfLines={2}>
          {text}
        </P>
        {foot}
      </View>
    </Card>
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
  // The tile last picked for each quiz step, so going back and forth keeps the answers.
  const [picks, setPicks] = useState<Record<number, string>>({});
  const step: LessonStep = lesson.steps[i];
  const last = i === lesson.steps.length - 1;
  const quiz = step.quiz;
  const answer = picks[i] ?? null;
  const answers = lessonAnswers(lesson.steps, picks);
  const correct = answers[i] === 'correct';
  const complete = lessonComplete(answers);

  const next = () => {
    if (last) {
      // Only a lesson whose every quiz was answered correctly counts as done.
      if (complete) app.setProgress((p) => ({ ...p, lessonsDone: { ...p.lessonsDone, [lesson.id]: true } }));
      app.back();
      return;
    }
    setI(i + 1);
  };

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <ScreenHeader title={lesson.title} onBack={app.back} sub={<Text style={styles.headerZh}>{lesson.titleZh}</Text>} />
      <Row gap={6}>
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
            <P style={{ color: colors.infoShelf, fontFamily: fonts.bodyHeavy }}>{quiz.prompt}</P>
            <HandView
              hand={quiz.hand}
              size="md"
              onPress={(code) => setPicks((p) => ({ ...p, [i]: code }))}
              selected={answer}
              // A wrong pick is marked but the answer stays hidden, so the player can try again.
              highlight={answer !== null ? (correct ? { [quiz.answer]: 'good' } : { [answer]: 'bad' }) : undefined}
            />
            {answer !== null && (
              <P style={{ color: correct ? colors.okText : colors.dangerText }}>
                {correct ? 'Correct! ' : 'Not quite: tap another tile to try again. '}
                {correct && <Text style={{ color: colors.ink }}>{quiz.explanation}</Text>}
              </P>
            )}
          </View>
        )}
      </Card>
      {last && !complete && <Pill icon="warning" text="Answer every quiz correctly to mark this lesson done." />}
      <Row style={{ justifyContent: 'space-between' }}>
        <Button kind="ghost" title="Previous" disabled={i === 0} onPress={() => setI(i - 1)} />
        <Button title={last ? (complete ? 'Finish lesson' : 'Leave lesson') : 'Next'} disabled={!!quiz && answer === null} onPress={next} />
      </Row>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  iconPlate: { width: 64, height: 64, borderRadius: 20, borderWidth: 3, borderColor: colors.ink, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  iconShine: { position: 'absolute', top: 0, left: 0, right: 0, height: '45%', backgroundColor: 'rgba(255,255,255,0.3)' },
  drillTitle: { fontFamily: fonts.display, color: colors.ink, fontSize: 19 },
  medal: { width: 46, height: 46, borderRadius: 23, backgroundColor: colors.gold, borderWidth: 3, borderColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.ink, fontSize: 16, fontFamily: fonts.uiBold },
  titleZh: { color: colors.inkDim, fontSize: 14, fontWeight: '900' },
  headerZh: { color: colors.ink, fontSize: 15, fontWeight: '900' },
  handRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingVertical: 8 },
  group: { flexDirection: 'row', gap: 2 },
  dot: { width: 14, height: 14, borderRadius: 7, backgroundColor: colors.cream, borderWidth: 2.5, borderColor: colors.ink },
});
