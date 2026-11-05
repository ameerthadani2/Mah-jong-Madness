import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { kindInfo, kindsFromString, LESSON_TRACKS, LESSONS, type Lesson, type LessonStep } from '@mjm/engine';
import { useApp } from '../app-state';
import { effectiveStreak } from '../storage';
import { rollingAccuracy } from '../logic/accuracy';
import { lessonAnswers, lessonComplete } from '../logic/lesson';
import { groupByTrack, learnSummary, nextLesson, trackTitle, type TrackGroup } from '../logic/learn';
import { useDisplayScale } from '../display/DisplayScale';
import { colors, fonts, space } from '../theme';
import { Tile, tileDims } from '../components/Tile';
import { fitTile } from '../components/table/layout';
import { Button, Card, H2, P, Pill, Row, ScreenHeader, SectionLabel, StrokeText } from '../components/Ui';
import { Icon, type IconName } from '../components/Icons';
import { RatingPill } from '../components/puzzles/RatingPill';
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
  const groups = groupByTrack(LESSONS, LESSON_TRACKS, done);
  const summary = learnSummary(LESSONS, LESSON_TRACKS, done);
  const first = summary.startId ? LESSONS.find((l) => l.id === summary.startId) : undefined;
  const reviewAcc = rollingAccuracy(app.progress.reviewAccuracies);
  return (
    <ScrollView contentContainerStyle={[styles.wrap, { padding: pad }]}>
      <ScreenHeader title={t('learn.title')} onBack={app.back} backTestID="back" right={<Pill text={t('learn.lessonsCount', { done: summary.done, total: summary.total })} icon="book" tone="gold" />} />
      {summary.empty && first && (
        // A new player: a friendly welcome and one obvious place to begin.
        <Card tone="sky" testID="learn-welcome" style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: 14 }}>
          <View style={[styles.iconPlate, { backgroundColor: colors.premium }]}>
            <View style={styles.iconShine} />
            <Icon name="book" size={40} />
          </View>
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={styles.drillTitle}>{t('learn.empty.title')}</Text>
            <P dim>{t('learn.empty.body')}</P>
            <Row>
              <Button small kind="primary" title={t('learn.empty.cta', { title: lessonTitle(first, locale) })} onPress={() => app.go({ name: 'lesson', id: first.id })} />
            </Row>
          </View>
        </Card>
      )}
      {summary.allDone && (
        <Card tone="gold" testID="learn-all-done" style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: 12 }}>
          <Icon name="trophy" size={36} />
          <P style={{ flex: 1 }}>{t('learn.allDone')}</P>
        </Card>
      )}
      <View style={styles.grid}>
        <RatingPill rating={app.progress.puzzleRating} history={app.progress.ratingHistory} />
        <DrillCard w={drillW} icon="scroll" tint={colors.gold} title={t('learn.daily.title')} text={t('learn.daily.text')} stat={t('learn.daily.streak', { n: streak })} statIcon="flame" statTone={streak > 0 ? 'gold' : 'neutral'} cta={t('learn.daily.cta')} kind="gold" onPress={() => app.go({ name: 'daily' })} />
        <DrillCard w={drillW} icon="bolt" tint={colors.danger} title={t('learn.rush.title')} text={t('learn.rush.text')} stat={t('learn.rush.stat', { best: app.progress.rushBest, runs: app.progress.rushRuns })} statIcon="trophy" cta={t('learn.rush.cta')} kind="danger" onPress={() => app.go({ name: 'rush' })} />
        <DrillCard w={drillW} icon="target" tint={colors.cta} title={t('learn.discard.title')} text={t('learn.discard.text')} stat={acc === null ? t('learn.discard.none') : t('learn.discard.stat', { pct: acc, n: app.progress.drillsPlayed })} statIcon="check" cta={t('learn.discard.cta')} kind="primary" onPress={() => app.go({ name: 'drill', kind: 'discard' })} />
        <DrillCard w={drillW} icon="magnifier" tint={colors.info} title={t('learn.waits.title')} text={t('learn.waits.text')} cta={t('learn.waits.cta')} kind="secondary" onPress={() => app.go({ name: 'drill', kind: 'waits' })} />
      </View>
      <Row style={{ flexWrap: 'wrap', rowGap: 6 }}>
        <Pill icon="magnifier" text={reviewAcc === null ? t('learn.reviewAccNone') : t('learn.reviewAcc', { pct: reviewAcc, n: app.progress.reviewAccuracies.length })} tone={reviewAcc === null ? 'neutral' : 'ok'} />
      </Row>
      <SectionLabel>{t('learn.lessons')}</SectionLabel>
      {groups.map((g) => (
        <TrackSection key={g.track.id} group={g} width={lessonW} done={done} onOpen={(id) => app.go({ name: 'lesson', id })} />
      ))}
    </ScrollView>
  );
}

/** One curriculum track: its name in both languages, done/total and minutes to go, then its lesson cards. */
function TrackSection({ group: g, width, done, onOpen }: { group: TrackGroup<Lesson, (typeof LESSON_TRACKS)[number]>; width: number; done: Record<string, boolean>; onOpen: (id: string) => void }) {
  const { t, locale } = useT();
  const title = trackTitle(g.track, locale);
  return (
    <View style={{ gap: space.sm }} testID={`track-${g.track.id}`}>
      <Row gap={8} style={{ flexWrap: 'wrap', rowGap: 4 }}>
        <StrokeText style={{ fontSize: 18 }} strokeWidth={1.8} drop={1.5}>
          {title.main}
        </StrokeText>
        {title.aside && (
          <StrokeText style={{ fontSize: 15 }} strokeWidth={1.5} drop={1}>
            {title.aside}
          </StrokeText>
        )}
        <Pill size="sm" tone={g.complete ? 'ok' : 'neutral'} icon={g.complete ? 'check' : undefined} text={g.complete ? t('learn.trackComplete') : t('learn.trackProgress', { done: g.done, total: g.total })} />
        {!g.complete && <Pill size="sm" tone="dark" icon="clock" text={t('learn.minutesLeft', { n: g.minutesLeft })} />}
      </Row>
      <View style={styles.trackBar} accessible accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: g.total, now: g.done }} accessibilityLabel={title.main}>
        <View style={[styles.trackFill, { width: `${Math.round((g.done / Math.max(1, g.total)) * 100)}%` }]} />
      </View>
      <View style={styles.grid}>
        {g.lessons.map((l, i) => (
          <LessonCard key={l.id} lesson={l} n={i + 1} width={width} done={!!done[l.id]} next={g.nextId === l.id} onOpen={() => onOpen(l.id)} />
        ))}
      </View>
    </View>
  );
}

/** A lesson: number (a tick once done), title, summary, minutes; the track's first unfinished lesson is highlighted. */
function LessonCard({ lesson: l, n, width, done, next, onOpen }: { lesson: Lesson; n: number; width: number; done: boolean; next: boolean; onOpen: () => void }) {
  const { t, locale } = useT();
  return (
    <Card tone={next ? 'gold' : 'cream'} testID={next ? 'lesson-next' : undefined} style={{ width, flexDirection: 'row', alignItems: 'center', gap: space.md, padding: 12 }}>
      <View style={[styles.medal, done && { backgroundColor: colors.cta }]} accessible accessibilityLabel={done ? t('learn.done') : String(n)}>
        {done ? (
          <Icon name="check" size={28} />
        ) : (
          <StrokeText style={{ fontSize: 22 }} strokeWidth={1.8} drop={1.5}>
            {n}
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
        {next && <Pill text={t('learn.upNext')} tone="premium" size="sm" />}
        <Pill text={t('learn.minutes', { n: l.minutes })} icon={done ? 'check' : 'clock'} tone={done ? 'ok' : 'neutral'} size="sm" />
        <Button small kind={done ? 'ghost' : next ? 'primary' : 'secondary'} title={t(done ? 'learn.review' : 'learn.start')} onPress={onOpen} />
      </View>
    </Card>
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
  // Settings → Display → Tiles raises the largest size; the fit still shrinks it so nothing is clipped.
  const { tileScale } = useDisplayScale();
  const max = Math.round(tileDims(size).w * tileScale);
  const tile = room === null ? max : fitTile(room, longest, max);
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

/** Keyed by lesson, so moving on to the next lesson starts it from its first step. */
export function LessonScreen({ id }: { id: string }) {
  return <LessonBody key={id} id={id} />;
}

function LessonBody({ id }: { id: string }) {
  const app = useApp();
  const { t, locale } = useT();
  const lesson = LESSONS.find((l) => l.id === id)!;
  const [i, setI] = useState(0);
  // Shown after the last step of a lesson passed in full: what was finished and what comes next.
  const [finished, setFinished] = useState(false);
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
      if (complete) {
        app.setProgress((p) => ({ ...p, lessonsDone: { ...p.lessonsDone, [lesson.id]: true } }));
        setFinished(true);
        return;
      }
      app.back();
      return;
    }
    setI(i + 1);
  };

  if (finished) {
    return <LessonEnd lesson={lesson} done={{ ...app.progress.lessonsDone, [lesson.id]: true }} />;
  }

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

/** The lesson end screen: a cheer, progress in the track, and the next lesson (or the next track). */
function LessonEnd({ lesson, done }: { lesson: Lesson; done: Record<string, boolean> }) {
  const app = useApp();
  const { t, locale } = useT();
  const track = LESSON_TRACKS.find((x) => x.id === lesson.track) ?? LESSON_TRACKS[0];
  const group = groupByTrack(LESSONS, [track], done)[0];
  const next = nextLesson(LESSONS, LESSON_TRACKS, lesson.id, done);
  const trackName = trackTitle(track, locale).main;
  const nextTrack = next.kind === 'newTrack' ? LESSON_TRACKS.find((x) => x.id === next.trackId) : undefined;
  const lead = next.kind === 'track' ? t('learn.end.nextInTrack', { track: trackName }) : next.kind === 'newTrack' && nextTrack ? t('learn.end.trackDone', { track: trackName, next: trackTitle(nextTrack, locale).main }) : t('learn.end.allDone');
  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <ScreenHeader title={lessonTitle(lesson, locale)} onBack={app.back} sub={locale !== 'zh-TW' ? <Text style={styles.headerZh}>{lesson.titleZh}</Text> : undefined} />
      <Card tone="gold" testID="lesson-end" style={{ alignItems: 'center', gap: space.md }}>
        <View style={[styles.medal, styles.bigMedal]}>
          <Icon name="check" size={40} />
        </View>
        <StrokeText style={{ fontSize: 28 }} strokeWidth={2.2} drop={2}>
          {t('learn.end.title')}
        </StrokeText>
        {group && <P style={{ textAlign: 'center' }}>{t('learn.end.progress', { done: group.done, total: group.total, track: trackName })}</P>}
        {group && (
          <View style={[styles.trackBar, { alignSelf: 'stretch' }]}>
            <View style={[styles.trackFill, { width: `${Math.round((group.done / Math.max(1, group.total)) * 100)}%` }]} />
          </View>
        )}
      </Card>
      <StrokeText style={{ fontSize: 18 }} strokeWidth={1.8} drop={1.5}>
        {lead}
      </StrokeText>
      {next.kind !== 'none' && (
        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: 12 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Row gap={6} style={{ flexWrap: 'wrap' }}>
              <Text style={styles.title}>{lessonTitle(next.lesson, locale)}</Text>
              {locale !== 'zh-TW' && <Text style={styles.titleZh}>{next.lesson.titleZh}</Text>}
            </Row>
            <P dim style={{ fontSize: 12, lineHeight: 16 }} numberOfLines={2}>
              {lessonSummary(next.lesson, locale)}
            </P>
          </View>
          <Pill text={t('learn.minutes', { n: next.lesson.minutes })} icon="clock" size="sm" />
        </Card>
      )}
      <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap', rowGap: 8 }}>
        <Button kind="ghost" title={t('learn.end.back')} testID="lesson-end-back" onPress={app.back} />
        {next.kind !== 'none' && (
          <Button
            title={t('learn.end.nextCta')}
            testID="lesson-end-next"
            onPress={() => {
              // Replace this lesson on the stack, so Back from the next one returns to Learn.
              app.back();
              app.go({ name: 'lesson', id: next.lesson.id });
            }}
          />
        )}
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
  bigMedal: { width: 72, height: 72, borderRadius: 36, backgroundColor: colors.cta },
  medal: { width: 46, height: 46, borderRadius: 23, backgroundColor: colors.gold, borderWidth: 3, borderColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.ink, fontSize: 16, fontFamily: fonts.uiBold },
  titleZh: { color: colors.inkDim, fontSize: 14, fontWeight: '900' },
  headerZh: { color: colors.ink, fontSize: 15, fontWeight: '900' },
  handRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingVertical: 8 },
  group: { flexDirection: 'row', gap: 2 },
  trackBar: { height: 10, borderRadius: 5, borderWidth: 2.5, borderColor: colors.ink, backgroundColor: colors.creamDeep, overflow: 'hidden' },
  trackFill: { height: '100%', backgroundColor: colors.cta },
  dot: { width: 14, height: 14, borderRadius: 7, backgroundColor: colors.cream, borderWidth: 2.5, borderColor: colors.ink },
});
