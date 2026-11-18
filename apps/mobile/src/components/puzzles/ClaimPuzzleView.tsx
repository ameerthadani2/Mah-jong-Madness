import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { ClaimQuestion } from '@mjm/engine';
import { colors } from '../../theme';
import { useT } from '../../i18n';
import { answerExplanationFor, explanationFor, claimButtons, claimOutcomeKey, SEAT_KEYS, seatRelation, tileName, type ClaimButton } from '../../logic/puzzle';
import { Tile } from '../Tile';
import { Button, P, Pill, Row } from '../Ui';
import { Icon } from '../Icons';
import { Answer, Checking, Explanation, KindMeld, KindRow, Label, NextButton, partStyles, useAnswer, Verdict, type ThemeViewProps } from './PuzzleParts';

/**
 * Claim window: your hand and sets, the tile just thrown and who threw it (上家 / 對家 /
 * 下家), and one button per legal response: pass, each 吃 shape, 碰, 槓, 胡. Every accepted
 * response counts; once answered, each button says where it leaves the hand and whether it is fine.
 */
export function ClaimPuzzleView({ question, judge, onResult, onNext, nextLabel, autoAdvance }: ThemeViewProps<ClaimQuestion>) {
  const { t, locale } = useT();
  const [picked, setPicked] = useState<string | null>(null);
  // `revealed` (the whole puzzle) is null until the verdict: the answer, each claim's outcome and the explanation come from it.
  const { answered, revealed, submit, sent, checking } = useAnswer(question, judge, onResult, onNext, autoAdvance);
  const buttons = useMemo(() => claimButtons(question, locale), [question, locale]);
  const seat = t(SEAT_KEYS[seatRelation(question.from)]);
  const choose = (b: ClaimButton) => {
    if (sent) return;
    setPicked(b.id);
    submit(b.id);
  };
  const best = revealed ? buttons.find((b) => b.id === revealed.answer.id) : undefined;
  // After answering, the hand tiles the best claim uses light up.
  const used: number[] = !best ? [] : best.type === 'chi' ? (best.option.kinds ?? []) : best.type === 'pong' || best.type === 'kong' ? [question.discard] : [];
  return (
    <View style={{ gap: 8 }}>
      <Row style={{ flexWrap: 'wrap', rowGap: 6 }}>
        <Pill text={seat} tone="info" icon="users" />
        <Tile kind={question.discard} size="md" highlight="wait" accessibilityLabel={tileName(question.discard, locale)} />
      </Row>
      <P dim>{t('puzzles.claim.intro', { seat, tile: tileName(question.discard, locale) })}</P>
      {question.melds.length > 0 && (
        <>
          <Label>{t('puzzles.claim.yourMelds')}</Label>
          <View style={styles.melds}>
            {question.melds.map((m, i) => (
              <KindMeld key={i} meld={m} size="sm" />
            ))}
          </View>
        </>
      )}
      {question.opponents.map((o) => (
        <Row key={o.seat} gap={6} style={{ flexWrap: 'wrap', rowGap: 4 }}>
          <Pill size="sm" text={t(SEAT_KEYS[seatRelation(o.seat)])} />
          {o.melds.map((m, i) => (
            <KindMeld key={i} meld={m} size="xs" />
          ))}
          <KindRow kinds={o.discards} size="xs" />
        </Row>
      ))}
      {question.ownDiscards.length > 0 && (
        <>
          <Label>{t('puzzles.defence.yourDiscards')}</Label>
          <KindRow kinds={question.ownDiscards} />
        </>
      )}
      <Label>{t('puzzles.claim.yourHand')}</Label>
      <View style={partStyles.hand}>
        {question.hand.map((k, i) => (
          <Tile key={i} kind={k} size="md" highlight={used.includes(k) ? 'good' : undefined} accessibilityLabel={tileName(k, locale)} />
        ))}
      </View>
      <View style={{ gap: 6 }}>
        {buttons.map((b) => {
          const fine = revealed ? revealed.answers.includes(b.id) : false;
          const mark = revealed ? (fine ? 'good' : picked === b.id ? 'bad' : null) : null;
          const full = revealed?.options.find((o) => o.id === b.id);
          const outcome = full ? claimOutcomeKey(full) : null;
          return (
            <Row key={b.id} gap={8} style={[styles.option, mark === 'good' && styles.good, mark === 'bad' && styles.bad]}>
              <Button
                testID={`claim-${b.id}`}
                title={t(b.label.key, b.label.params)}
                kind={b.type === 'pass' ? 'ghost' : b.type === 'hu' ? 'gold' : 'secondary'}
                small
                onPress={() => choose(b)}
                disabled={revealed !== null ? mark === null : sent}
              />
              {b.kinds.length > 0 && <KindRow kinds={b.kinds} size="xs" />}
              {mark && <Icon name={mark === 'good' ? 'check' : 'cross'} size={20} color={mark === 'good' ? colors.cta : colors.danger} />}
              {revealed && <Pill size="sm" text={t(fine ? 'puzzles.claim.fine' : 'puzzles.claim.worse')} tone={fine ? 'gold' : 'neutral'} />}
              {outcome && <P style={{ fontSize: 13 }}>{t(outcome.key, outcome.params)}</P>}
            </Row>
          );
        })}
      </View>
      <Checking show={checking} />
      {revealed && best && answered !== null && (
        <Answer spoken={[t(answered ? 'puzzles.claim.right' : 'puzzles.claim.wrong'), ...(answered ? [] : [t('puzzles.claim.answer', { label: t(best.label.key, best.label.params) })]), explanationFor(answerExplanationFor(revealed, picked), locale)].join(' ')}>
          <Verdict good={answered} goodKey="puzzles.claim.right" badKey="puzzles.claim.wrong" />
          {!answered && <P>{t('puzzles.claim.answer', { label: t(best.label.key, best.label.params) })}</P>}
          <Explanation puzzle={answerExplanationFor(revealed, picked)} />
          <NextButton onNext={onNext} autoAdvance={autoAdvance} label={nextLabel} />
        </Answer>
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
