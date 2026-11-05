import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { kindInfo, kindsFromString, LESSONS, type Lesson, type LessonStep } from '@mjm/engine';
import { useApp } from '../app-state';
import { effectiveStreak } from '../storage';
import { rollingAccuracy } from '../logic/accuracy';
import { lessonAnswers, lessonComplete } from '../logic/lesson';
import { colors, fonts, space } from '../theme';
import { Tile, tileDims } from '../components/Tile';
import { fitTile } from '../components/table/layout';
import { Button, Card, H2, P, Pill, Row, ScreenHeader, SectionLabel, StrokeText } from '../components/Ui';
import { Icon, type IconName } from '../components/Icons';
import { useT, type Locale } from '../i18n';

/**
 * Lesson copy lives in the engine. Traditional Chinese versions arrive as optional `…Zh` fields next to the
 * English ones (titleZh, bodyZh, summaryZh, promptZh, explanationZh); until a field exists the English is shown.
 */
interface ZhFields {
  titleZh?: string;
  bodyZh?: string;
  summaryZh?: string;
  promptZh?: string;
  explanationZh?: string;
}

/** Type guard: does this lesson, step or quiz carry a non-empty Chinese version of `field`? */
function hasZh<K extends keyof ZhFields>(source: object | undefined, field: K): source is Record<K, string> {
  const v = source ? (source as Record<string, unknown>)[field] : undefined;
  return typeof v === 'string' && v.length > 0;
}

function localised<K extends keyof ZhFields>(locale: Locale, source: object | undefined, en: string, zhKey: K): string {
  return locale === 'zh-TW' && hasZh(source, zhKey) ? source[zhKey] : en;
}

const lessonTitle = (l: Lesson, locale: Locale) => (locale === 'zh-TW' ? l.titleZh : l.title);
const lessonSummary = (l: Lesson, locale: Locale) => localised(locale, l, l.summary, 'summaryZh');

export function LearnScreen() {
  const app = useApp();
  const { t, locale } = useT();
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
      <ScreenHeader title={t('learn.title')} onBack={app.back} backTestID="back" right={<Pill text={t('learn.lessonsCount', { done: lessonsDone, total: LESSONS.length })} icon="book" tone="gold" />} />
      <View style={styles.grid}>
        <DrillCard w={drillW} icon="scroll" tint={colors.gold} title={t('learn.daily.title')} text={t('learn.daily.text')} stat={t('learn.daily.streak', { n: streak })} statIcon="flame" statTone={streak > 0 ? 'gold' : 'neutral'} cta={t('learn.daily.cta')} kind="gold" onPress={() => app.go({ name: 'daily' })} />
        <DrillCard w={drillW} icon="bolt" tint={colors.danger} title={t('learn.rush.title')} text={t('learn.rush.text')} stat={t('learn.rush.stat', { best: app.progress.rushBest, runs: app.progress.rushRuns })} statIcon="trophy" cta={t('learn.rush.cta')} kind="danger" onPress={() => app.go({ name: 'rush' })} />
        <DrillCard w={drillW} icon="target" tint={colors.cta} title={t('learn.discard.title')} text={t('learn.discard.text')} stat={acc === null ? t('learn.discard.none') : t('learn.discard.stat', { pct: acc, n: app.progress.drillsPlayed })} statIcon="check" cta={t('learn.discard.cta')} kind="primary" onPress={() => app.go({ name: 'drill', kind: 'discard' })} />
        <DrillCard w={drillW} icon="magnifier" tint={colors.info} title={t('learn.waits.title')} text={t('learn.waits.text')} cta={t('learn.waits.cta')} kind="secondary" onPress={() => app.go({ name: 'drill', kind: 'waits' })} />
      </View>
      <Row style={{ flexWrap: 'wrap', rowGap: 6 }}>
        <Pill icon="magnifier" text={reviewAcc === null ? t('learn.reviewAccNone') : t('learn.reviewAcc', { pct: reviewAcc, n: app.progress.reviewAccuracies.length })} tone={reviewAcc === null ? 'neutral' : 'ok'} />
      </Row>
      <SectionLabel>{t('learn.lessons')}</SectionLabel>
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
                <Text style={styles.title}>{lessonTitle(l, locale)}</Text>
                {/* English shows the Chinese name alongside; in zh-TW the title already is the Chinese name. */}
                {locale !== 'zh-TW' && <Text style={styles.titleZh}>{l.titleZh}</Text>}
              </Row>
              <P dim style={{ fontSize: 12, lineHeight: 16 }} numberOfLines={2}>
                {lessonSummary(l, locale)}
              </P>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 6 }}>
              {done[l.id] ? <Pill text={t('learn.done')} tone="ok" size="sm" /> : <Pill text={t('learn.minutes', { n: l.minutes })} icon="clock" size="sm" />}
              <Button small kind={done[l.id] ? 'ghost' : 'secondary'} title={t(done[l.id] ? 'learn.review' : 'learn.start')} onPress={() => app.go({ name: 'lesson', id: l.id })} />
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
  const groups = hand.trim().split(/\s+/).map((g) => kindsFromString(g));
  // Shrink the tiles until the longest group fits the card, so a run of nine (九萬) is never clipped on a phone.
  const [room, setRoom] = useState<number | null>(null);
  const longest = Math.max(1, ...groups.map((g) => g.length));
  const tile = room === null ? tileDims(size).w : fitTile(room, longest, tileDims(size).w);
  return (
    <View style={styles.handRow} onLayout={(e) => setRoom(Math.floor(e.nativeEvent.layout.width))}>
      {groups.map((kinds, gi) => (
        <View key={gi} style={styles.group}>
          {kinds.map((k, i) => {
            const code = codeOf(k);
            return <Tile key={`${gi}-${i}`} kind={k} size={tile} selected={selected === code} highlight={highlight?.[code]} onPress={onPress ? () => onPress(code, i) : undefined} accessibilityLabel={kindInfo(k).nameEn} />;
          })}
        </View>
      ))}
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
  const { t, locale } = useT();
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
      <ScreenHeader title={lessonTitle(lesson, locale)} onBack={app.back} sub={locale !== 'zh-TW' ? <Text style={styles.headerZh}>{lesson.titleZh}</Text> : undefined} />
      <Row gap={6}>
        {lesson.steps.map((_, j) => (
          <View key={j} style={[styles.dot, j <= i && { backgroundColor: colors.gold }]} />
        ))}
      </Row>
      <Card>
        <H2>{localised(locale, step, step.title, 'titleZh')}</H2>
        <P>{localised(locale, step, step.body, 'bodyZh')}</P>
        {step.hand && <HandView hand={step.hand} size="md" />}
        {quiz && (
          <View style={{ gap: 8 }}>
            <P style={{ color: colors.infoShelf, fontFamily: fonts.bodyHeavy }}>{localised(locale, quiz, quiz.prompt, 'promptZh')}</P>
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
                {t(correct ? 'learn.correct' : 'learn.notQuite')}
                {correct && <Text style={{ color: colors.ink }}>{localised(locale, quiz, quiz.explanation, 'explanationZh')}</Text>}
              </P>
            )}
          </View>
        )}
      </Card>
      {last && !complete && <Pill icon="warning" text={t('learn.answerAll')} />}
      <Row style={{ justifyContent: 'space-between' }}>
        <Button kind="ghost" title={t('learn.previous')} disabled={i === 0} onPress={() => setI(i - 1)} />
        <Button title={t(last ? (complete ? 'learn.finish' : 'learn.leaveLesson') : 'learn.next')} disabled={!!quiz && answer === null} onPress={next} />
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
