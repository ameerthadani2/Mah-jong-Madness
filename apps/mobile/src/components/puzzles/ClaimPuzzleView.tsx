import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { ClaimPuzzle } from '@mjm/engine';
import { colors } from '../../theme';
import { useT } from '../../i18n';
import { checkPuzzleAnswer, claimButtons, claimOutcomeKey, SEAT_KEYS, seatRelation, tileName, type ClaimButton } from '../../logic/puzzle';
import { Tile } from '../Tile';
import { Button, P, Pill, Row } from '../Ui';
import { Icon } from '../Icons';
import { Explanation, KindMeld, KindRow, Label, NextButton, partStyles, useAnswer, Verdict, type ThemeViewProps } from './PuzzleParts';

/**
 * Claim window: your hand and sets, the tile just thrown and who threw it (上家 / 對家 /
 * 下家), and one button per legal response: pass, each 吃 shape, 碰, 槓, 胡. Every accepted
 * response counts; once answered, each button says where it leaves the hand and whether it is fine.
 */
export function ClaimPuzzleView({ puzzle, onResult, onNext, nextLabel, autoAdvance }: ThemeViewProps<ClaimPuzzle>) {
  const { t, locale } = useT();
  const [picked, setPicked] = useState<string | null>(null);
  const { answered, report } = useAnswer('claim', puzzle.difficulty, onResult, onNext, autoAdvance);
  const buttons = useMemo(() => claimButtons(puzzle, locale), [puzzle, locale]);
  const seat = t(SEAT_KEYS[seatRelation(puzzle.from)]);
  const choose = (b: ClaimButton) => {
    if (answered !== null) return;
    setPicked(b.id);
    report(checkPuzzleAnswer(puzzle, b.option));
  };
  const best = buttons.find((b) => b.id === puzzle.answer.id)!;
  // After answering, the hand tiles the best claim uses light up.
  const used: number[] = best.type === 'chi' ? (best.option.kinds ?? []) : best.type === 'pong' || best.type === 'kong' ? [puzzle.discard] : [];
  return (
    <View style={{ gap: 8 }}>
      <Row style={{ flexWrap: 'wrap', rowGap: 6 }}>
        <Pill text={seat} tone="info" icon="users" />
        <Tile kind={puzzle.discard} size="md" highlight="wait" accessibilityLabel={tileName(puzzle.discard, locale)} />
      </Row>
      <P dim>{t('puzzles.claim.intro', { seat, tile: tileName(puzzle.discard, locale) })}</P>
      {puzzle.melds.length > 0 && (
        <>
          <Label>{t('puzzles.claim.yourMelds')}</Label>
          <View style={styles.melds}>
            {puzzle.melds.map((m, i) => (
              <KindMeld key={i} meld={m} size="sm" />
            ))}
          </View>
        </>
      )}
      {puzzle.opponents.map((o) => (
        <Row key={o.seat} gap={6} style={{ flexWrap: 'wrap', rowGap: 4 }}>
          <Pill size="sm" text={t(SEAT_KEYS[seatRelation(o.seat)])} />
          {o.melds.map((m, i) => (
            <KindMeld key={i} meld={m} size="xs" />
          ))}
          <KindRow kinds={o.discards} size="xs" />
        </Row>
      ))}
      {puzzle.ownDiscards.length > 0 && (
        <>
          <Label>{t('puzzles.defence.yourDiscards')}</Label>
          <KindRow kinds={puzzle.ownDiscards} />
        </>
      )}
      <Label>{t('puzzles.claim.yourHand')}</Label>
      <View style={partStyles.hand}>
        {puzzle.hand.map((k, i) => (
          <Tile key={i} kind={k} size="md" highlight={answered !== null && used.includes(k) ? 'good' : undefined} accessibilityLabel={tileName(k, locale)} />
        ))}
      </View>
      <View style={{ gap: 6 }}>
        {buttons.map((b) => {
          const fine = puzzle.answers.includes(b.id);
          const mark = answered !== null ? (fine ? 'good' : picked === b.id ? 'bad' : null) : null;
          const outcome = claimOutcomeKey(b.option);
          return (
            <Row key={b.id} gap={8} style={[styles.option, mark === 'good' && styles.good, mark === 'bad' && styles.bad]}>
              <Button testID={`claim-${b.id}`} title={t(b.label.key, b.label.params)} kind={b.type === 'pass' ? 'ghost' : b.type === 'hu' ? 'gold' : 'secondary'} small onPress={() => choose(b)} disabled={answered !== null && mark === null} />
              {b.kinds.length > 0 && <KindRow kinds={b.kinds} size="xs" />}
              {mark && <Icon name={mark === 'good' ? 'check' : 'cross'} size={20} color={mark === 'good' ? colors.cta : colors.danger} />}
              {answered !== null && <Pill size="sm" text={t(fine ? 'puzzles.claim.fine' : 'puzzles.claim.worse')} tone={fine ? 'gold' : 'neutral'} />}
              {answered !== null && <P style={{ fontSize: 13 }}>{t(outcome.key, outcome.params)}</P>}
            </Row>
          );
        })}
      </View>
      {answered !== null && (
        <View style={{ gap: 6 }}>
          <Verdict good={answered} goodKey="puzzles.claim.right" badKey="puzzles.claim.wrong" />
          {!answered && <P>{t('puzzles.claim.answer', { label: t(best.label.key, best.label.params) })}</P>}
          <Explanation puzzle={puzzle} />
          <NextButton onNext={onNext} autoAdvance={autoAdvance} label={nextLabel} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  melds: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 4 },
  option: { flexWrap: 'wrap', rowGap: 4, padding: 4, borderRadius: 12, borderWidth: 2, borderColor: 'transparent' },
  good: { borderColor: colors.cta },
  bad: { borderColor: colors.danger },
});
