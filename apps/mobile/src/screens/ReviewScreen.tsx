import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { kindInfo, kindOf, reviewHand, type MoveGrade, type ReviewedMove } from '@mjm/engine';
import { useApp } from '../app-state';
import { canUse, consume } from '../monetisation/store';
import { rollingAccuracy } from '../logic/accuracy';
import { colors, fonts, space } from '../theme';
import { Tile } from '../components/Tile';
import { Button, Card, H1, P, Pill, Row, ScreenHeader, SectionLabel, StrokeText } from '../components/Ui';
import { Icon, type IconName } from '../components/Icons';
import { useT } from '../i18n';

/** How each grade looks; its label is `review.grade.<grade>`. */
const GRADE_STYLE: Record<MoveGrade, { tone: 'ok' | 'gold' | 'neutral' | 'danger'; icon?: IconName }> = {
  best: { tone: 'ok', icon: 'star' },
  good: { tone: 'ok', icon: 'check' },
  inaccuracy: { tone: 'gold' },
  mistake: { tone: 'danger' },
  blunder: { tone: 'danger' },
};

export function ReviewScreen() {
  const app = useApp();
  const { t } = useT();
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
        <H1 style={{ fontSize: 26 }}>{t('review.dailyUsedTitle')}</H1>
        <P style={{ textAlign: 'center', maxWidth: 420 }}>{t('review.dailyUsedText')}</P>
        <Row>
          <Button title={t('review.seePlans')} onPress={() => app.go({ name: 'shop' })} />
          <Button kind="ghost" title={t('review.back')} onPress={app.back} />
        </Row>
      </View>
    );
  }
  if (!review) {
    return (
      <View style={styles.center}>
        <Card style={{ alignItems: 'center' }}>
          <Icon name="magnifier" size={40} />
          <P>{t('review.nothing')}</P>
          <Button title={t('review.back')} onPress={app.back} />
        </Card>
      </View>
    );
  }
  const mistakes = review.moves.filter((m) => m.grade !== 'best' && m.grade !== 'good');
  const rolling = rollingAccuracy(app.progress.reviewAccuracies);
  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <ScreenHeader title={t('review.title')} onBack={app.back} />
      <Card style={{ alignItems: 'center' }}>
        <View style={styles.accuracyBadge}>
          <StrokeText style={styles.accuracy} strokeWidth={3} drop={3}>
            {`${review.accuracy}%`}
          </StrokeText>
        </View>
        <P dim>{t('review.accuracyOver', { n: review.moves.length })}</P>
        {rolling !== null && (
          <P dim style={{ fontSize: 12 }}>
            {t('review.rolling', { count: app.progress.reviewAccuracies.length, pct: rolling })}
          </P>
        )}
        <Row style={{ flexWrap: 'wrap', justifyContent: 'center', rowGap: 6 }}>
          {(Object.keys(GRADE_STYLE) as MoveGrade[]).map((g) => (
            <Pill key={g} icon={GRADE_STYLE[g].icon} text={t('review.gradeCount', { label: t(`review.grade.${g}`), n: review.counts[g] })} tone={review.counts[g] ? GRADE_STYLE[g].tone : 'neutral'} />
          ))}
        </Row>
      </Card>
      <SectionLabel>{t(mistakes.length ? 'review.keyMoments' : 'review.clean')}</SectionLabel>
      {mistakes.map((m) => (
        <MoveCard key={m.n} move={m} />
      ))}
      {mistakes.length > 0 && <SectionLabel>{t('review.allDecisions')}</SectionLabel>}
      {review.moves
        .filter((m) => m.grade === 'best' || m.grade === 'good')
        .map((m) => (
          <MoveCard key={m.n} move={m} compact />
        ))}
    </ScrollView>
  );
}

function MoveCard({ move, compact }: { move: ReviewedMove; compact?: boolean }) {
  const { t } = useT();
  const g = GRADE_STYLE[move.grade];
  const label = t(`review.grade.${move.grade}`);
  const describe = (a: ReviewedMove['actual'] | null) => {
    if (!a) return t('review.action.none');
    switch (a.type) {
      case 'discard':
        return t('review.action.discard', { tile: kindInfo(kindOf(a.tile)).nameZh });
      case 'chi':
        return t('review.action.chi', { tiles: a.tiles.map((tile) => kindInfo(kindOf(tile)).nameZh).join('') });
      case 'kong':
        return t('review.action.kong', { tile: kindInfo(kindOf(a.tile)).nameZh });
      case 'hu':
        return t('review.action.hu');
      case 'pong':
        return t('review.action.pong');
      default:
        // The only action left is a pass.
        return t('review.action.pass');
    }
  };
  return (
    <Card style={{ gap: 6 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Row>
          <Pill icon={g.icon} text={label} tone={g.tone} />
          <P dim style={{ fontSize: 12 }}>
            {t('review.moveMeta', { n: move.n + 1, phase: t(move.phase === 'claim' ? 'review.onDiscard' : 'review.yourTurn') })}
          </P>
        </Row>
        <P style={{ fontSize: 13 }}>
          {t('review.you', { move: describe(move.actual) })}
          {move.best && move.grade !== 'best' ? t('review.best', { move: describe(move.best) }) : ''}
        </P>
      </Row>
      {!compact && (
        <>
          <View style={styles.hand}>
            {move.hand.map((t, i) => (
              <Tile key={`${t}-${i}`} tile={t} size="sm" highlight={move.highlightBest === kindOf(t) ? 'good' : move.highlightActual === kindOf(t) ? 'bad' : undefined} />
            ))}
          </View>
          <P style={{ fontSize: 13 }}>{t(`engine.${move.reasonKey}`, move.reasonParams)}</P>
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  accuracy: { fontSize: 52, fontFamily: fonts.display },
  accuracyBadge: { backgroundColor: colors.cta, borderWidth: 3, borderColor: colors.ink, borderRadius: 24, paddingHorizontal: 22, paddingVertical: 2, borderBottomWidth: 8 },
  hand: { flexDirection: 'row', flexWrap: 'wrap', gap: 2 },
});
