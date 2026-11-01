import React, { useEffect, useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { kindInfo, kindOf, reviewHand, type MoveGrade, type ReviewedMove } from '@mjm/engine';
import { useApp } from '../app-state';
import { useSession } from '../game/useTable';
import { colors, space } from '../theme';
import { Tile } from '../components/Tile';
import { Button, Card, H1, H2, P, Pill, Row } from '../components/Ui';

const GRADE_LABEL: Record<MoveGrade, { label: string; tone: 'ok' | 'gold' | 'neutral' | 'danger'; icon: string }> = {
  best: { label: 'Best', tone: 'ok', icon: '★' },
  good: { label: 'Good', tone: 'ok', icon: '✓' },
  inaccuracy: { label: 'Inaccuracy', tone: 'gold', icon: '?!' },
  mistake: { label: 'Mistake', tone: 'danger', icon: '?' },
  blunder: { label: 'Blunder', tone: 'danger', icon: '??' },
};

export function ReviewScreen() {
  const app = useApp();
  const session = app.session;
  const state = useSession(session);
  const audit = state?.lastAudit ?? null;
  const snapshot = session?.client.handSnapshot() ?? null;
  const seat = state?.seat ?? 0;
  const rules = state?.rules ?? null;

  const review = useMemo(() => {
    if (!audit || !snapshot || !rules) return null;
    try {
      return reviewHand(snapshot, audit.seed, rules, audit.log, seat);
    } catch {
      return null;
    }
  }, [audit, snapshot, rules, seat]);

  useEffect(() => {
    if (!review) return;
    app.setProgress((p) => ({ ...p, reviewAccuracies: [...p.reviewAccuracies.slice(-19), review.accuracy] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review?.accuracy]);

  if (!review) {
    return (
      <View style={styles.center}>
        <P>Nothing to review yet. Finish a hand first.</P>
        <Button title="Back" onPress={app.back} />
      </View>
    );
  }
  const mistakes = review.moves.filter((m) => m.grade !== 'best' && m.grade !== 'good');
  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Row style={{ justifyContent: 'space-between' }}>
        <H1 style={{ fontSize: 22 }}>Hand review</H1>
        <Button small kind="ghost" title="Back" onPress={app.back} />
      </Row>
      <Card style={{ alignItems: 'center' }}>
        <Text style={styles.accuracy}>{review.accuracy}%</Text>
        <P dim>accuracy over {review.moves.length} decisions</P>
        <Row style={{ flexWrap: 'wrap', justifyContent: 'center' }}>
          {(Object.keys(GRADE_LABEL) as MoveGrade[]).map((g) => (
            <Pill key={g} text={`${GRADE_LABEL[g].icon} ${GRADE_LABEL[g].label} ${review.counts[g]}`} tone={review.counts[g] ? GRADE_LABEL[g].tone : 'neutral'} />
          ))}
        </Row>
      </Card>
      <H2>{mistakes.length ? 'Key moments' : 'Clean hand — every decision matched the coach'}</H2>
      {mistakes.map((m) => (
        <MoveCard key={m.n} move={m} />
      ))}
      {mistakes.length > 0 && <H2>All decisions</H2>}
      {review.moves
        .filter((m) => m.grade === 'best' || m.grade === 'good')
        .map((m) => (
          <MoveCard key={m.n} move={m} compact />
        ))}
    </ScrollView>
  );
}

function MoveCard({ move, compact }: { move: ReviewedMove; compact?: boolean }) {
  const g = GRADE_LABEL[move.grade];
  const describe = (a: ReviewedMove['actual'] | null) => {
    if (!a) return '—';
    switch (a.type) {
      case 'discard':
        return `Discard ${kindInfo(kindOf(a.tile)).nameZh}`;
      case 'chi':
        return `Chi ${a.tiles.map((t) => kindInfo(kindOf(t)).nameZh).join('')}`;
      case 'kong':
        return `Kong ${kindInfo(kindOf(a.tile)).nameZh}`;
      case 'hu':
        return 'Win';
      case 'pong':
        return 'Pong';
      default:
        return a.type;
    }
  };
  return (
    <Card style={{ gap: 6 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Row>
          <Pill text={`${g.icon} ${g.label}`} tone={g.tone} />
          <P dim style={{ fontSize: 12 }}>
            move {move.n + 1} · {move.phase === 'claim' ? 'on a discard' : 'your turn'}
          </P>
        </Row>
        <P style={{ fontSize: 13 }}>
          You: {describe(move.actual)}
          {move.best && move.grade !== 'best' ? ` · Best: ${describe(move.best)}` : ''}
        </P>
      </Row>
      {!compact && (
        <>
          <View style={styles.hand}>
            {move.hand.map((t, i) => (
              <Tile key={`${t}-${i}`} tile={t} size="sm" highlight={move.highlightBest === kindOf(t) ? 'good' : move.highlightActual === kindOf(t) ? 'bad' : undefined} />
            ))}
          </View>
          <P style={{ fontSize: 13 }}>{move.explanation}</P>
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  accuracy: { color: colors.gold, fontSize: 56, fontWeight: '900' },
  hand: { flexDirection: 'row', flexWrap: 'wrap', gap: 2 },
});
