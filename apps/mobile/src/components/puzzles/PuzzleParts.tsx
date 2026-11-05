import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Kind, PuzzleDifficulty, PuzzleMeld, PuzzleType } from '@mjm/engine';
import { colors, fonts } from '../../theme';
import { useT } from '../../i18n';
import { explanationFor, reasonTitleKey, type PuzzleResult } from '../../logic/puzzle';
import { Tile, type TileSize } from '../Tile';
import { Button, fontFor, H2, P, Row } from '../Ui';
import { Icon } from '../Icons';

/** Props every theme's view takes. */
export interface ThemeViewProps<P> {
  puzzle: P;
  onResult: (r: PuzzleResult) => void;
  onNext?: () => void;
  nextLabel: string;
  autoAdvance?: boolean;
}

/**
 * Answer bookkeeping shared by the views: times the answer from mount, reports it once,
 * and in a rush moves on by itself (quickly after a right answer, later after a wrong one
 * so the explanation can be read). The timer is cleared if the view goes away first.
 */
export function useAnswer(type: PuzzleType, difficulty: PuzzleDifficulty | undefined, onResult: (r: PuzzleResult) => void, onNext: (() => void) | undefined, autoAdvance: boolean | undefined) {
  const [started] = useState(() => Date.now());
  const [answered, setAnswered] = useState<boolean | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const report = (correct: boolean) => {
    if (answered !== null) return;
    setAnswered(correct);
    onResult({ correct, ms: Date.now() - started, type, ...(difficulty ? { difficulty } : {}) });
    if (autoAdvance && onNext) timer.current = setTimeout(onNext, correct ? 700 : 2600);
  };
  return { answered, report };
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
