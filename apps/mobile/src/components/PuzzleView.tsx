import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { AnyPuzzle, DiscardQuestion, Kind, PuzzleDifficulty, PuzzleQuestion, WaitsQuestion } from '@mjm/engine';
import { colors, fonts } from '../theme';
import { useT } from '../i18n';
import { localPuzzle, puzzleStatus, tileListText, tileName, type Judge, type PuzzleResult } from '../logic/puzzle';
import { Tile } from './Tile';
import { Button, P, Pill, Row } from './Ui';
import { Answer, Checking, NextButton, partStyles, useAnswer, Verdict, type ThemeViewProps } from './puzzles/PuzzleParts';
import { DefencePuzzleView } from './puzzles/DefencePuzzleView';
import { ClaimPuzzleView } from './puzzles/ClaimPuzzleView';
import { ValuePuzzleView } from './puzzles/ValuePuzzleView';

export type { PuzzleResult } from '../logic/puzzle';

interface ViewOptions {
  onResult: (r: PuzzleResult) => void;
  onNext?: () => void;
  nextLabel?: string;
  autoAdvance?: boolean;
}

/**
 * Renders a puzzle of any of the five themes and reports the result once answered. A puzzle made
 * on the device is passed whole (`puzzle`, with the difficulty it was made at for the themes that
 * carry none) and judged here at once; a ranked puzzle is passed as the question the game server
 * served and a `judge` that sends the answer and brings back the verdict and the revealed puzzle.
 * Either way the theme views see only the question until the answer is judged.
 */
export function PuzzleView(props: ViewOptions & ({ puzzle: AnyPuzzle; difficulty?: PuzzleDifficulty } | { question: PuzzleQuestion; judge: Judge })) {
  const local = 'puzzle' in props ? props.puzzle : null;
  const localDifficulty = 'puzzle' in props ? props.difficulty : undefined;
  const made = useMemo(() => (local ? localPuzzle(local, localDifficulty) : null), [local, localDifficulty]);
  const { question, judge } = made ?? (props as { question: PuzzleQuestion; judge: Judge });
  return <QuestionView question={question} judge={judge} onResult={props.onResult} onNext={props.onNext} nextLabel={props.nextLabel} autoAdvance={props.autoAdvance} />;
}

function QuestionView({ question, judge, onResult, onNext, nextLabel, autoAdvance }: ViewOptions & { question: PuzzleQuestion; judge: Judge }) {
  const { t } = useT();
  const props = { judge, onResult, onNext, nextLabel: nextLabel ?? t('puzzles.view.next'), autoAdvance };
  // Keyed by seed and theme so the next puzzle always mounts fresh.
  const key = `${question.type}:${question.seed}`;
  switch (question.type) {
    case 'discard':
      return <DiscardPuzzleView key={key} question={question} {...props} />;
    case 'waits':
      return <WaitsPuzzleView key={key} question={question} {...props} />;
    case 'defence':
      return <DefencePuzzleView key={key} question={question} {...props} />;
    case 'claim':
      return <ClaimPuzzleView key={key} question={question} {...props} />;
    case 'value':
      return <ValuePuzzleView key={key} question={question} {...props} />;
  }
}

function DiscardPuzzleView({ question, judge, onResult, onNext, nextLabel, autoAdvance }: ThemeViewProps<DiscardQuestion>) {
  const { t, locale } = useT();
  const [picked, setPicked] = useState<number | null>(null);
  const { answered, revealed, submit, checking } = useAnswer(question, judge, onResult, onNext, autoAdvance);
  const pick = (i: number) => {
    if (picked !== null) return;
    setPicked(i);
    submit(question.hand[i]);
  };
  const shape = (shanten: number) => (shanten <= 0 ? t('puzzles.view.ready') : t('puzzles.view.fromReady', { n: shanten }));
  const status = puzzleStatus(question.currentShanten);
  return (
    <View style={{ gap: 8 }}>
      <P dim>{t('puzzles.view.discardIntro', { status: t(status.key, status.params) })}</P>
      <View style={partStyles.hand}>
        {question.hand.map((k, i) => (
          <Tile
            key={i}
            kind={k}
            size="md"
            onPress={() => pick(i)}
            selected={picked === i}
            highlight={revealed ? (revealed.answers.includes(k) ? 'good' : picked === i ? 'bad' : undefined) : undefined}
            accessibilityLabel={tileName(k, locale)}
          />
        ))}
      </View>
      <Checking show={checking} />
      {revealed &&
        picked !== null &&
        answered !== null &&
        (() => {
          const good = answered;
          const pickedOpt = revealed.options.find((o) => o.kind === question.hand[picked]);
          const bestOpt = revealed.options.find((o) => o.kind === revealed.best)!;
          const pickedText = pickedOpt ? t('puzzles.view.picked', { tile: tileName(pickedOpt.kind, locale), shape: shape(pickedOpt.shanten), kinds: pickedOpt.accepts.length, tiles: pickedOpt.acceptance }) : '';
          // The tiles that improve the hand are listed by name, as the rest of the sentence names tiles.
          const bestText = t('puzzles.view.best', { tile: tileName(bestOpt.kind, locale), shape: shape(bestOpt.shanten), kinds: bestOpt.accepts.length, tiles: bestOpt.acceptance, list: tileListText(bestOpt.accepts, locale) });
          return (
            <Answer spoken={[t(good ? 'puzzles.view.good' : 'puzzles.view.better'), pickedText, ...(good ? [] : [bestText])].join(' ')}>
              <Verdict good={good} goodKey="puzzles.view.good" badKey="puzzles.view.better" />
              {pickedText ? <P>{pickedText}</P> : null}
              {!good && <P>{bestText}</P>}
              <NextButton onNext={onNext} autoAdvance={autoAdvance} label={nextLabel} />
            </Answer>
          );
        })()}
    </View>
  );
}

function WaitsPuzzleView({ question, judge, onResult, onNext, nextLabel, autoAdvance }: ThemeViewProps<WaitsQuestion>) {
  const { t, locale } = useT();
  const [chosen, setChosen] = useState<Set<Kind>>(new Set());
  const { answered, revealed, submit, sent, checking } = useAnswer(question, judge, onResult, onNext, autoAdvance);
  const toggle = (k: Kind) => {
    if (sent) return;
    const next = new Set(chosen);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setChosen(next);
  };
  return (
    <View style={{ gap: 8 }}>
      <P dim>{t('puzzles.view.waitsIntro')}</P>
      <View style={partStyles.hand}>
        {question.hand.map((k, i) => (
          <Tile key={i} kind={k} size="md" />
        ))}
      </View>
      <Text style={styles.label}>{t('puzzles.view.candidates')}</Text>
      <View style={partStyles.hand}>
        {question.candidates.map((k) => (
          <Tile key={k} kind={k} size="sm" onPress={() => toggle(k)} selected={chosen.has(k)} highlight={revealed ? (revealed.answers.includes(k) ? 'good' : chosen.has(k) ? 'bad' : undefined) : undefined} />
        ))}
      </View>
      {!sent ? <Button title={t('puzzles.view.check')} onPress={() => submit([...chosen])} disabled={chosen.size === 0} /> : <Checking show={checking} />}
      {revealed && answered !== null && (
        <Answer spoken={`${t(answered ? 'puzzles.view.exact' : 'puzzles.view.notAll')} ${t('puzzles.view.waits')} ${tileListText(revealed.answers, locale)}`}>
          <Verdict good={answered} goodKey="puzzles.view.exact" badKey="puzzles.view.notAll" />
          <Row style={{ flexWrap: 'wrap' }}>
            <Text style={{ color: colors.ink, fontFamily: fonts.uiBold }}>{t('puzzles.view.waits')}</Text>
            {revealed.answers.map((k) => (
              <Pill key={k} text={tileName(k, locale)} tone="gold" />
            ))}
          </Row>
          <NextButton onNext={onNext} autoAdvance={autoAdvance} label={nextLabel} />
        </Answer>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { color: colors.inkDim, fontSize: 12, fontFamily: fonts.uiBold, textTransform: 'uppercase', letterSpacing: 1 },
});
