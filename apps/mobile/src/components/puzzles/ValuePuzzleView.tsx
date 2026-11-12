import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { KIND_WIND, type ValuePuzzle } from '@mjm/engine';
import { colors, fonts } from '../../theme';
import { useT } from '../../i18n';
import { checkPuzzleAnswer, explanationFor, taiFigure, tileName, valueProjections, type ValueProjection } from '../../logic/puzzle';
import { Tile } from '../Tile';
import { P, Pill, Row } from '../Ui';
import { Answer, Explanation, KindMeld, KindRow, Label, NextButton, partStyles, useAnswer, Verdict, type ThemeViewProps } from './PuzzleParts';

/**
 * Value: several discards leave the hand ready; they differ in how many winning tiles stay live
 * and what a win is worth. Tap the tile to throw; afterwards every ready discard shows a card
 * (average and best 台 of a win, its patterns, winning tiles, and its expected score as a share of
 * the best), so the player sees why the accepted ones are fine and the others worse.
 */
export function ValuePuzzleView({ puzzle, onResult, onNext, nextLabel, autoAdvance }: ThemeViewProps<ValuePuzzle>) {
  const { t, locale } = useT();
  const [picked, setPicked] = useState<number | null>(null);
  const { answered, report } = useAnswer('value', puzzle.difficulty, onResult, onNext, autoAdvance);
  const projections = useMemo(() => valueProjections(puzzle), [puzzle]);
  const pick = (i: number) => {
    if (answered !== null) return;
    setPicked(i);
    report(checkPuzzleAnswer(puzzle, puzzle.hand[i]));
  };
  return (
    <View style={{ gap: 8 }}>
      <P dim>{t('puzzles.value.intro')}</P>
      <Row style={{ flexWrap: 'wrap', rowGap: 6 }} gap={6}>
        <Pill size="sm" text={t('puzzles.value.seatWind', { wind: tileName(puzzle.seatWind, locale) })} />
        <Pill size="sm" text={t('puzzles.value.roundWind', { wind: tileName(KIND_WIND + puzzle.prevailingWind, locale) })} />
      </Row>
      {puzzle.melds.length > 0 && (
        <>
          <Label>{t('puzzles.value.yourMelds')}</Label>
          <View style={styles.melds}>
            {puzzle.melds.map((m, i) => (
              <KindMeld key={i} meld={m} size="sm" />
            ))}
          </View>
        </>
      )}
      <View style={partStyles.hand}>
        {puzzle.hand.map((k, i) => (
          <Tile
            key={i}
            kind={k}
            size="md"
            onPress={() => pick(i)}
            selected={picked === i}
            highlight={answered !== null ? (puzzle.answers.includes(k) ? 'good' : picked === i ? 'bad' : undefined) : undefined}
            accessibilityLabel={tileName(k, locale)}
          />
        ))}
      </View>
      {answered !== null && (
        <Answer spoken={[t(answered ? 'puzzles.value.good' : 'puzzles.value.bad'), explanationFor(puzzle, locale)].join(' ')}>
          <Verdict good={answered} goodKey="puzzles.value.good" badKey="puzzles.value.bad" />
          <Label>{t('puzzles.value.projections')}</Label>
          <Row style={{ flexWrap: 'wrap', alignItems: 'stretch', rowGap: 6 }}>
            {projections.map((p) => (
              <Projection key={p.kind} p={p} />
            ))}
          </Row>
          <Explanation puzzle={puzzle} />
          <NextButton onNext={onNext} autoAdvance={autoAdvance} label={nextLabel} />
        </Answer>
      )}
    </View>
  );
}

const ROLE_KEYS: Record<ValueProjection['role'], string> = { best: 'puzzles.value.best', accepted: 'puzzles.value.fine', worse: 'puzzles.value.worse' };

function Projection({ p }: { p: ValueProjection }) {
  const { t, locale } = useT();
  const good = p.role !== 'worse';
  return (
    <View style={[styles.proj, { borderColor: good ? colors.cta : colors.creamDeep }]} testID={`value-${p.role}`}>
      <Row gap={6}>
        <Tile kind={p.kind} size="sm" />
        <Text style={styles.projTitle}>{t('puzzles.value.discard', { tile: tileName(p.kind, locale) })}</Text>
        <Pill size="sm" text={t(ROLE_KEYS[p.role])} tone={good ? 'gold' : 'neutral'} />
      </Row>
      <Text style={[styles.tai, { color: good ? colors.okText : colors.ink }]}>{t('puzzles.value.avgTai', { n: taiFigure(p.expectedTai) })}</Text>
      <Text style={styles.item}>{p.bestTai >= 0 ? t('puzzles.value.bestTai', { n: p.bestTai }) : t('puzzles.value.noLive')}</Text>
      {p.items.map((it) => (
        <Text key={it.key} style={styles.item}>
          {(locale === 'zh-TW' ? it.nameZh : it.nameEn) + ' · ' + t('puzzles.value.tai', { n: it.tai })}
        </Text>
      ))}
      {p.waits.length > 0 && (
        <>
          <KindRow kinds={p.waits} size="xs" />
          <Text style={styles.item}>{t('puzzles.value.waits', { kinds: p.waits.length, tiles: p.acceptance })}</Text>
        </>
      )}
      <Text style={[styles.item, { fontFamily: fonts.uiBold }]}>{t('puzzles.value.share', { n: p.share })}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  melds: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 4 },
  proj: { flexGrow: 1, flexBasis: 150, gap: 4, padding: 8, borderRadius: 12, borderWidth: 2, backgroundColor: colors.creamLight },
  projTitle: { color: colors.ink, fontFamily: fonts.uiBold, fontSize: 14, flexShrink: 1 },
  tai: { fontFamily: fonts.uiBold, fontSize: 20 },
  item: { color: colors.inkDim, fontSize: 13 },
});
