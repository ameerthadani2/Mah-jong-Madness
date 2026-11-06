import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { kindsToString, type AnyPuzzle, type DiscardPuzzle, type Kind, type WaitsPuzzle } from '@mjm/engine';
import { colors, fonts } from '../theme';
import { useT } from '../i18n';
import { checkPuzzleAnswer, puzzleStatus, tileName, type PuzzleResult } from '../logic/puzzle';
import { Tile } from './Tile';
import { Button, P, Pill, Row } from './Ui';
import { NextButton, partStyles, useAnswer, Verdict, type ThemeViewProps } from './puzzles/PuzzleParts';
import { DefencePuzzleView } from './puzzles/DefencePuzzleView';
import { ClaimPuzzleView } from './puzzles/ClaimPuzzleView';
import { ValuePuzzleView } from './puzzles/ValuePuzzleView';

export type { PuzzleResult } from '../logic/puzzle';

/** Renders a puzzle of any of the five themes and reports the result once answered. */
export function PuzzleView({ puzzle, onResult, onNext, nextLabel, autoAdvance }: { puzzle: AnyPuzzle; onResult: (r: PuzzleResult) => void; onNext?: () => void; nextLabel?: string; autoAdvance?: boolean }) {
  const { t } = useT();
  const props = { onResult, onNext, nextLabel: nextLabel ?? t('puzzles.view.next'), autoAdvance };
  // Keyed by seed and theme so the next puzzle always mounts fresh.
  const key = `${puzzle.type}:${puzzle.seed}`;
  switch (puzzle.type) {
    case 'discard':
      return <DiscardPuzzleView key={key} puzzle={puzzle} {...props} />;
    case 'waits':
      return <WaitsPuzzleView key={key} puzzle={puzzle} {...props} />;
    case 'defence':
      return <DefencePuzzleView key={key} puzzle={puzzle} {...props} />;
    case 'claim':
      return <ClaimPuzzleView key={key} puzzle={puzzle} {...props} />;
    case 'value':
      return <ValuePuzzleView key={key} puzzle={puzzle} {...props} />;
  }
}

function DiscardPuzzleView({ puzzle, onResult, onNext, nextLabel, autoAdvance }: ThemeViewProps<DiscardPuzzle>) {
  const { t, locale } = useT();
  const [picked, setPicked] = useState<number | null>(null);
  const { answered, report } = useAnswer('discard', undefined, onResult, onNext, autoAdvance);
  const pick = (i: number) => {
    if (answered !== null) return;
    setPicked(i);
    report(checkPuzzleAnswer(puzzle, puzzle.hand[i]));
  };
  const pickedOpt = picked !== null ? puzzle.options.find((o) => o.kind === puzzle.hand[picked]) : null;
  const bestOpt = puzzle.options.find((o) => o.kind === puzzle.best)!;
  const good = answered === true;
  const shape = (shanten: number) => (shanten <= 0 ? t('puzzles.view.ready') : t('puzzles.view.fromReady', { n: shanten }));
  const status = puzzleStatus(puzzle.currentShanten);
  return (
    <View style={{ gap: 8 }}>
      <P dim>{t('puzzles.view.discardIntro', { status: t(status.key, status.params) })}</P>
      <View style={partStyles.hand}>
        {puzzle.hand.map((k, i) => (
          <Tile key={i} kind={k} size="md" onPress={() => pick(i)} selected={picked === i} highlight={answered !== null ? (puzzle.answers.includes(k) ? 'good' : picked === i ? 'bad' : undefined) : undefined} accessibilityLabel={tileName(k, locale)} />
        ))}
      </View>
      {answered !== null && pickedOpt && (
        <View style={{ gap: 6 }}>
          <Verdict good={good} goodKey="puzzles.view.good" badKey="puzzles.view.better" />
          <P>{t('puzzles.view.picked', { tile: tileName(pickedOpt.kind, locale), shape: shape(pickedOpt.shanten), kinds: pickedOpt.accepts.length, tiles: pickedOpt.acceptance })}</P>
          {!good && <P>{t('puzzles.view.best', { tile: tileName(bestOpt.kind, locale), shape: shape(bestOpt.shanten), kinds: bestOpt.accepts.length, tiles: bestOpt.acceptance, list: kindsToString(bestOpt.accepts) })}</P>}
          <NextButton onNext={onNext} autoAdvance={autoAdvance} label={nextLabel} />
        </View>
      )}
    </View>
  );
}

function WaitsPuzzleView({ puzzle, onResult, onNext, nextLabel, autoAdvance }: ThemeViewProps<WaitsPuzzle>) {
  const { t, locale } = useT();
  const [chosen, setChosen] = useState<Set<Kind>>(new Set());
  const { answered, report } = useAnswer('waits', undefined, onResult, onNext, autoAdvance);
  const checked = answered !== null;
  const toggle = (k: Kind) => {
    if (checked) return;
    const next = new Set(chosen);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setChosen(next);
  };
  return (
    <View style={{ gap: 8 }}>
      <P dim>{t('puzzles.view.waitsIntro')}</P>
      <View style={partStyles.hand}>
        {puzzle.hand.map((k, i) => (
          <Tile key={i} kind={k} size="md" />
        ))}
      </View>
      <Text style={styles.label}>{t('puzzles.view.candidates')}</Text>
      <View style={partStyles.hand}>
        {puzzle.candidates.map((k) => (
          <Tile key={k} kind={k} size="sm" onPress={() => toggle(k)} selected={chosen.has(k)} highlight={checked ? (puzzle.answers.includes(k) ? 'good' : chosen.has(k) ? 'bad' : undefined) : undefined} />
        ))}
      </View>
      {!checked ? (
        <Button title={t('puzzles.view.check')} onPress={() => report(checkPuzzleAnswer(puzzle, [...chosen]))} disabled={chosen.size === 0} />
      ) : (
        <View style={{ gap: 6 }}>
          <Verdict good={answered === true} goodKey="puzzles.view.exact" badKey="puzzles.view.notAll" />
          <Row style={{ flexWrap: 'wrap' }}>
            <Text style={{ color: colors.ink, fontFamily: fonts.uiBold }}>{t('puzzles.view.waits')}</Text>
            {puzzle.answers.map((k) => (
              <Pill key={k} text={tileName(k, locale)} tone="gold" />
            ))}
          </Row>
          <NextButton onNext={onNext} autoAdvance={autoAdvance} label={nextLabel} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { color: colors.inkDim, fontSize: 12, fontFamily: fonts.uiBold, textTransform: 'uppercase', letterSpacing: 1 },
});
