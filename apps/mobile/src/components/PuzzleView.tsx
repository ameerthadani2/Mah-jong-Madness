import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { checkDiscardAnswer, checkWaitsAnswer, kindInfo, kindsToString, type DiscardPuzzle, type Kind, type Puzzle, type WaitsPuzzle } from '@mjm/engine';
import { colors, fonts } from '../theme';
import { Tile } from './Tile';
import { Button, H2, P, Pill, Row } from './Ui';
import { Icon } from './Icons';

export interface PuzzleResult {
  correct: boolean;
  /** Milliseconds from mount to answer. */
  ms: number;
}

/** Renders a discard or waits puzzle and reports the result once answered. */
export function PuzzleView({ puzzle, onResult, onNext, nextLabel = 'Next', autoAdvance }: { puzzle: Puzzle; onResult: (r: PuzzleResult) => void; onNext?: () => void; nextLabel?: string; autoAdvance?: boolean }) {
  return puzzle.type === 'discard' ? (
    <DiscardPuzzleView key={puzzle.seed} puzzle={puzzle} onResult={onResult} onNext={onNext} nextLabel={nextLabel} autoAdvance={autoAdvance} />
  ) : (
    <WaitsPuzzleView key={puzzle.seed} puzzle={puzzle} onResult={onResult} onNext={onNext} nextLabel={nextLabel} autoAdvance={autoAdvance} />
  );
}

function DiscardPuzzleView({ puzzle, onResult, onNext, nextLabel, autoAdvance }: { puzzle: DiscardPuzzle; onResult: (r: PuzzleResult) => void; onNext?: () => void; nextLabel: string; autoAdvance?: boolean }) {
  const [picked, setPicked] = useState<number | null>(null);
  const [started] = useState(() => Date.now());
  const pick = (i: number) => {
    if (picked !== null) return;
    setPicked(i);
    const correct = checkDiscardAnswer(puzzle, puzzle.hand[i]);
    onResult({ correct, ms: Date.now() - started });
    if (autoAdvance && onNext) setTimeout(onNext, correct ? 600 : 1800);
  };
  const pickedOpt = picked !== null ? puzzle.options.find((o) => o.kind === puzzle.hand[picked]) : null;
  const bestOpt = puzzle.options.find((o) => o.kind === puzzle.best)!;
  const good = picked !== null && checkDiscardAnswer(puzzle, puzzle.hand[picked]);
  return (
    <View style={{ gap: 8 }}>
      <P dim>You just drew. {puzzle.currentShanten <= 0 ? 'The hand is ready.' : `${puzzle.currentShanten} from ready.`} Which tile do you discard?</P>
      <View style={styles.hand}>
        {puzzle.hand.map((k, i) => (
          <Tile key={i} kind={k} size="md" onPress={() => pick(i)} selected={picked === i} highlight={picked !== null ? (puzzle.answers.includes(k) ? 'good' : picked === i ? 'bad' : undefined) : undefined} />
        ))}
      </View>
      {picked !== null && pickedOpt && (
        <View style={{ gap: 6 }}>
          <Row>
            <Icon name={good ? 'check' : 'cross'} size={26} color={good ? colors.cta : colors.danger} />
            <H2 style={{ color: good ? colors.okText : colors.dangerText }}>{good ? 'Good discard!' : 'There is a better one.'}</H2>
          </Row>
          <P>
            {kindInfo(pickedOpt.kind).nameZh}: {pickedOpt.shanten <= 0 ? 'ready' : `${pickedOpt.shanten} from ready`}, {pickedOpt.accepts.length} kinds / {pickedOpt.acceptance} tiles improve you.
          </P>
          {!good && (
            <P>
              Best is {kindInfo(bestOpt.kind).nameZh}: {bestOpt.shanten <= 0 ? 'ready' : `${bestOpt.shanten} from ready`}, {bestOpt.accepts.length} kinds / {bestOpt.acceptance} tiles ({kindsToString(bestOpt.accepts)}).
            </P>
          )}
          {onNext && !autoAdvance && <Button title={nextLabel} onPress={onNext} />}
        </View>
      )}
    </View>
  );
}

function WaitsPuzzleView({ puzzle, onResult, onNext, nextLabel, autoAdvance }: { puzzle: WaitsPuzzle; onResult: (r: PuzzleResult) => void; onNext?: () => void; nextLabel: string; autoAdvance?: boolean }) {
  const [chosen, setChosen] = useState<Set<Kind>>(new Set());
  const [checked, setChecked] = useState(false);
  const [started] = useState(() => Date.now());
  const toggle = (k: Kind) => {
    if (checked) return;
    const next = new Set(chosen);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setChosen(next);
  };
  const correct = checked && checkWaitsAnswer(puzzle, [...chosen]);
  const check = () => {
    setChecked(true);
    const ok = checkWaitsAnswer(puzzle, [...chosen]);
    onResult({ correct: ok, ms: Date.now() - started });
    if (autoAdvance && onNext) setTimeout(onNext, ok ? 600 : 1800);
  };
  return (
    <View style={{ gap: 8 }}>
      <P dim>This 16-tile hand is ready. Select every tile that completes it.</P>
      <View style={styles.hand}>
        {puzzle.hand.map((k, i) => (
          <Tile key={i} kind={k} size="md" />
        ))}
      </View>
      <Text style={styles.label}>Candidates</Text>
      <View style={styles.hand}>
        {puzzle.candidates.map((k) => (
          <Tile key={k} kind={k} size="sm" onPress={() => toggle(k)} selected={chosen.has(k)} highlight={checked ? (puzzle.answers.includes(k) ? 'good' : chosen.has(k) ? 'bad' : undefined) : undefined} />
        ))}
      </View>
      {!checked ? (
        <Button title="Check" onPress={check} disabled={chosen.size === 0} />
      ) : (
        <View style={{ gap: 6 }}>
          <Row>
            <Icon name={correct ? 'check' : 'cross'} size={26} color={correct ? colors.cta : colors.danger} />
            <H2 style={{ color: correct ? colors.okText : colors.dangerText }}>{correct ? 'Exactly right!' : 'Not all of them.'}</H2>
          </Row>
          <Row style={{ flexWrap: 'wrap' }}>
            <Text style={{ color: colors.ink, fontFamily: fonts.uiBold }}>Waits:</Text>
            {puzzle.answers.map((k) => (
              <Pill key={k} text={kindInfo(k).nameZh} tone="gold" />
            ))}
          </Row>
          {onNext && !autoAdvance && <Button title={nextLabel} onPress={onNext} />}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  hand: { flexDirection: 'row', flexWrap: 'wrap', gap: 3, paddingVertical: 6 },
  label: { color: colors.inkDim, fontSize: 12, fontFamily: fonts.uiBold, textTransform: 'uppercase', letterSpacing: 1 },
});
