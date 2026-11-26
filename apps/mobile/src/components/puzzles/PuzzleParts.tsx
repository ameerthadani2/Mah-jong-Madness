import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../Text';
import type { AnyPuzzle, Kind, PuzzleMeld, PuzzleQuestion } from '@mjm/engine';
import { colors, fonts } from '../../theme';
import { useT } from '../../i18n';
import { explanationFor, reasonTitleKey, wireAnswer, type Judge, type Judged, type PuzzleAnswer, type PuzzleResult } from '../../logic/puzzle';
import { Tile, type TileSize } from '../Tile';
import { Button, fontFor, H2, P, Row } from '../Ui';
import { Icon } from '../Icons';
import { Live } from '../Live';

/**
 * Props every theme's view takes: the question (all a view may read before the answer: it holds no
 * answer field, so a view cannot show one early) and the judge that gives the verdict and reveals
 * the whole puzzle once the player has answered.
 */
export interface ThemeViewProps<Q extends PuzzleQuestion> {
  question: Q;
  judge: Judge;
  onResult: (r: PuzzleResult) => void;
  onNext?: () => void;
  nextLabel: string;
  autoAdvance?: boolean;
}

/** The whole puzzle of a question's theme, as the judge reveals it. */
export type Revealed<Q extends PuzzleQuestion> = Extract<AnyPuzzle, { type: Q['type'] }>;

/**
 * Answer bookkeeping shared by the views: times the answer from mount, sends it to the judge once
 * (on the device it answers at once; the game server answers a ranked puzzle with its verdict and
 * the revealed puzzle), reports the verdict, and in a rush moves on by itself (quickly after a
 * right answer, later after a wrong one so the explanation can be read). `revealed` is null until
 * the verdict: what a view shows about the answer comes from it. The timer is cleared, and a late
 * verdict ignored, if the view goes away first.
 */
export function useAnswer<Q extends PuzzleQuestion>(question: Q, judge: Judge, onResult: (r: PuzzleResult) => void, onNext: (() => void) | undefined, autoAdvance: boolean | undefined) {
  const [started] = useState(() => Date.now());
  const [answered, setAnswered] = useState<boolean | null>(null);
  const [revealed, setRevealed] = useState<Revealed<Q> | null>(null);
  // An answer was given: waiting for the verdict, or it could not be judged. Either way no second answer.
  const [sent, setSent] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const settle = (j: Judged | null, answer: PuzzleAnswer, ms: number) => {
    // A verdict on another theme's puzzle is not this question's: treated as not judged.
    if (!live.current || !j || j.puzzle.type !== question.type) return;
    setAnswered(j.correct);
    setRevealed(j.puzzle as Revealed<Q>);
    onResult({ correct: j.correct, ms, type: question.type, difficulty: question.difficulty, answer: wireAnswer(answer) });
    if (autoAdvance && onNext) timer.current = setTimeout(onNext, j.correct ? 700 : 2600);
  };
  const submit = (answer: PuzzleAnswer) => {
    if (sent) return;
    setSent(true);
    const ms = Date.now() - started;
    const j = judge(wireAnswer(answer));
    if (j instanceof Promise) void j.then((v) => settle(v, answer, ms)).catch(() => undefined);
    else settle(j, answer, ms);
  };
  /** True while the answer is with the judge: the view says it is being checked. */
  const checking = sent && answered === null;
  return { answered, revealed, submit, sent, checking };
}

/** A quiet line while a ranked answer is being judged by the game server. */
export function Checking({ show }: { show: boolean }) {
  const { t } = useT();
  if (!show) return null;
  return (
    <View testID="puzzle-checking">
      <P dim style={{ fontSize: 12 }}>
        {t('puzzles.server.checking')}
      </P>
    </View>
  );
}

/** ✓ / ✗ and a headline. */
export function Verdict({ good, goodKey, badKey }: { good: boolean; goodKey: string; badKey: string }) {
  const { t } = useT();
  return (
    <Row>
      <Icon name={good ? 'check' : 'cross'} size={26} color={good ? colors.cta : colors.danger} />
      <H2 style={{ color: good ? colors.okText : colors.dangerText }}>{t(good ? goodKey : badKey)}</H2>
    </Row>
  );
}

/**
 * Everything shown once a puzzle is answered: the verdict, the explanation, the way on. It appears below the
 * hand, away from the tile or button that was pressed, so it is a live region and a screen reader speaks it
 * (`spoken` is what iOS announces: the verdict and the sentence that explains it).
 */
export function Answer({ spoken, children }: { spoken: string; children: React.ReactNode }) {
  return (
    <Live message={spoken} testID="puzzle-answer" style={{ gap: 6 }}>
      {children}
    </Live>
  );
}

/** The engine's reason, as a short headline and its full explanation in the app's language. */
export function Explanation({ puzzle }: { puzzle: { reasonKey: string; explanation: string; explanationZh: string } }) {
  const { t, locale } = useT();
  const title = reasonTitleKey(puzzle.reasonKey);
  return (
    <View style={styles.explain} testID="puzzle-explanation">
      {title && <Text style={[styles.reason, fontFor(t(title), fonts.uiBold)]}>{t(title)}</Text>}
      <P>{explanationFor(puzzle, locale)}</P>
    </View>
  );
}

export function NextButton({ onNext, autoAdvance, label }: { onNext?: () => void; autoAdvance?: boolean; label: string }) {
  if (!onNext || autoAdvance) return null;
  return <Button testID="puzzle-next" title={label} onPress={onNext} />;
}

/** A set shown from kinds: an exposed set turns its claimed tile (the last), a concealed kong hides its ends. */
export function KindMeld({ meld, size = 'xs' }: { meld: PuzzleMeld; size?: TileSize | number }) {
  return (
    <View style={styles.meld}>
      {meld.kinds.map((k, i) => (
        <Tile key={i} kind={k} size={size} faceDown={meld.concealed && meld.type === 'kong' && (i === 0 || i === 3)} rotated={!meld.concealed && i === meld.kinds.length - 1} />
      ))}
    </View>
  );
}

/** A wrapping row of tiles (a hand or a discard row). */
export function KindRow({ kinds, size = 'xs', highlight }: { kinds: readonly Kind[]; size?: TileSize | number; highlight?: (k: Kind) => 'good' | 'bad' | 'wait' | undefined }) {
  return (
    <View style={styles.row}>
      {kinds.map((k, i) => (
        <Tile key={i} kind={k} size={size} highlight={highlight?.(k)} />
      ))}
    </View>
  );
}

export function Label({ children }: { children: React.ReactNode }) {
  return <Text style={styles.label}>{children}</Text>;
}

export const partStyles = StyleSheet.create({
  hand: { flexDirection: 'row', flexWrap: 'wrap', gap: 3, paddingVertical: 6 },
});

const styles = StyleSheet.create({
  explain: { gap: 4, padding: 10, borderRadius: 12, backgroundColor: colors.creamLight, borderWidth: 2, borderColor: colors.ink },
  reason: { color: colors.ink, fontSize: 15 },
  meld: { flexDirection: 'row', gap: 1, marginRight: 6 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 2 },
  label: { color: colors.inkDim, fontSize: 12, fontFamily: fonts.uiBold, textTransform: 'uppercase', letterSpacing: 1 },
});
