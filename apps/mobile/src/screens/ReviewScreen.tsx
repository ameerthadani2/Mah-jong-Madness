import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { kindInfo, kindOf, reviewHand, type MoveGrade, type ReviewedMove } from '@mjm/engine';
import { useApp } from '../app-state';
import { useSession } from '../game/useTable';
import { canUse, consume } from '../monetisation/store';
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
  // Freeze the hand being reviewed at mount so an intermission ending mid-review cannot swap it.
  const [frozen] = useState(() => ({
    audit: session?.client.state.lastAudit ?? null,
    snapshot: session?.client.handSnapshot() ?? null,
    seat: session?.client.state.seat ?? 0,
    rules: session?.client.state.rules ?? null,
  }));
  const { audit, snapshot, seat, rules } = frozen;
  const key = audit ? `${audit.matchId}:${audit.handNumber}` : null;
  const alreadyReviewed = !!key && app.progress.reviewedHands.includes(key);
  // Free tier: one full review per day (re-opening a reviewed hand is always free).
  const [allowance] = useState(() => (alreadyReviewed ? { ok: true, left: Infinity, limit: null } : canUse(app.wallet, 'reviews')));
  useEffect(() => {
    if (allowance.ok && !alreadyReviewed && allowance.limit !== null) app.setWallet(consume(app.wallet, 'reviews'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const review = useMemo(() => {
    if (!allowance.ok) return null;
    if (!audit || !snapshot || !rules) return null;
    try {
      return reviewHand(snapshot, audit.seed, rules, audit.log, seat);
    } catch {
      return null;
    }
  }, [audit, snapshot, rules, seat]);

  useEffect(() => {
    if (!review || !audit) return;
    const key = `${audit.matchId}:${audit.handNumber}`;
    app.setProgress((p) => (p.reviewedHands.includes(key) ? p : { ...p, reviewedHands: [...p.reviewedHands.slice(-199), key], reviewAccuracies: [...p.reviewAccuracies.slice(-19), review.accuracy] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review?.accuracy]);

  if (!allowance.ok) {
    return (
      <View style={styles.center}>
        <H1 style={{ fontSize: 22 }}>Daily review used</H1>
        <P dim style={{ textAlign: 'center', maxWidth: 420 }}>
          Free accounts get one full hand review a day. Coach Platinum reviews every hand you play, with move-by-move explanations on Diamond.
        </P>
        <Row>
          <Button title="See Coach plans" onPress={() => app.go({ name: 'shop' })} />
          <Button kind="ghost" title="Back" onPress={app.back} />
        </Row>
      </View>
    );
  }
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
