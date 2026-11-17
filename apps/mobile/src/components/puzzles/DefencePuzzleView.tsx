import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { DefenceQuestion } from '@mjm/engine';
import { colors } from '../../theme';
import { useT } from '../../i18n';
import { explanationFor, defenceSeats, defenceVerdicts, percent, SEAT_KEYS, threatKey, tileName } from '../../logic/puzzle';
import { Tile } from '../Tile';
import { P, Pill, Row } from '../Ui';
import { Answer, Checking, Explanation, KindMeld, KindRow, Label, NextButton, partStyles, useAnswer, Verdict, type ThemeViewProps } from './PuzzleParts';

/**
 * Defence: your 17 tiles, the threatening seat's exposed sets and discards (the other seats'
 * discards too, since visible copies are what make an honour safe) and your own discards.
 * Tap the tile to throw.
 */
export function DefencePuzzleView({ question, judge, onResult, onNext, nextLabel, autoAdvance }: ThemeViewProps<DefenceQuestion>) {
  const { t, locale } = useT();
  const [picked, setPicked] = useState<number | null>(null);
  // `revealed` (the whole puzzle) is null until the verdict: the answer, the chances and the explanation come from it.
  const { answered, revealed, submit, checking } = useAnswer(question, judge, onResult, onNext, autoAdvance);
  const seats = useMemo(() => defenceSeats(question), [question]);
  const verdicts = useMemo(() => (revealed ? defenceVerdicts(revealed) : []), [revealed]);
  const keeps = useMemo(() => (revealed ? new Set(revealed.options.filter((o) => o.shanten === revealed.bestShanten).map((o) => o.kind)) : null), [revealed]);
  const pick = (i: number) => {
    if (picked !== null) return;
    setPicked(i);
    submit(question.hand[i]);
  };
  const threat = threatKey(question);
  return (
    <View style={{ gap: 8 }}>
      <P dim>{t('puzzles.defence.intro')}</P>
      {seats.map((s) => (
        <View key={s.seat} style={[styles.seat, s.threat && styles.threat]} testID={s.threat ? 'defence-threat' : undefined}>
          <Row style={{ flexWrap: 'wrap', rowGap: 4 }} gap={6}>
            <Pill text={t(SEAT_KEYS[s.relation])} tone={s.threat ? 'danger' : 'neutral'} size="sm" icon={s.threat ? 'warning' : undefined} />
            {s.threat && <P style={{ fontSize: 12 }}>{t(threat.key, threat.params)}</P>}
          </Row>
          {s.melds.length > 0 ? (
            <View style={styles.melds}>
              {s.melds.map((m, i) => (
                <KindMeld key={i} meld={m} size={s.threat ? 'sm' : 'xs'} />
              ))}
            </View>
          ) : null}
          <Label>{t('puzzles.defence.discards')}</Label>
          <KindRow kinds={s.discards} size={s.threat ? 'sm' : 'xs'} highlight={revealed ? (k) => (revealed.answers.includes(k) ? 'good' : undefined) : undefined} />
        </View>
      ))}
      <Label>{t('puzzles.defence.yourDiscards')}</Label>
      <KindRow kinds={question.ownDiscards} />
      <View style={partStyles.hand}>
        {question.hand.map((k, i) => (
          <Tile
            key={i}
            kind={k}
            size="md"
            onPress={() => pick(i)}
            selected={picked === i}
            dimmed={keeps !== null && !keeps.has(k)}
            highlight={revealed ? (revealed.answers.includes(k) ? 'good' : picked === i ? 'bad' : undefined) : undefined}
            accessibilityLabel={tileName(k, locale)}
          />
        ))}
      </View>
      <Checking show={checking} />
      {revealed && answered !== null && (
        <Answer spoken={[t(answered ? 'puzzles.defence.safe' : 'puzzles.defence.unsafe'), ...(answered ? [] : [t('puzzles.defence.answer', { tile: tileName(revealed.answer, locale) })]), explanationFor(revealed, locale)].join(' ')}>
          <Verdict good={answered} goodKey="puzzles.defence.safe" badKey="puzzles.defence.unsafe" />
          {!answered && <P>{t('puzzles.defence.answer', { tile: tileName(revealed.answer, locale) })}</P>}
          <Explanation puzzle={revealed} />
          <Label>{t('puzzles.defence.verdicts')}</Label>
          <View style={{ gap: 4 }} testID="defence-verdicts">
            {verdicts.map((v) => (
              <Row key={v.kind} gap={8}>
                <Tile kind={v.kind} size="xs" highlight={v.accepted ? 'good' : undefined} accessibilityLabel={tileName(v.kind, locale)} />
                <Pill size="sm" text={t(v.accepted ? 'puzzles.defence.fine' : 'puzzles.defence.riskier')} tone={v.accepted ? 'gold' : 'neutral'} />
                <P style={{ fontSize: 13, flexShrink: 1 }}>{t('puzzles.defence.chance', { pct: percent(v.chance) })}</P>
              </Row>
            ))}
          </View>
          <NextButton onNext={onNext} autoAdvance={autoAdvance} label={nextLabel} />
        </Answer>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  seat: { gap: 4, padding: 8, borderRadius: 12, borderWidth: 2, borderColor: colors.creamDeep },
  threat: { borderColor: colors.danger, backgroundColor: colors.creamLight },
  melds: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 4 },
});
