/** End of hand: the result sheet (winner cards with a 台 roll-up, scores, audit, next hand) and the match-over card. */
import React, { useState } from 'react';
import { caveatText, failureText } from '../../logic/fairnessText';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { HandResult, TableView, WinRecord } from '@mjm/engine';
import type { ClientState } from '@mjm/net';
import { colors, fonts, nameFont, space } from '../../theme';
import { useT } from '../../i18n';
import { AvatarPlate, seatAvatarId } from '../Avatars';
import { Icon } from '../Icons';
import { MeldView } from '../TableParts';
import { scaledTile, Tile } from '../Tile';
import { useDisplayScale } from '../../display/DisplayScale';
import { scaleTextStyle } from '../../display/scale';
import { Button, P, Pill, Row, StrokeText } from '../Ui';
import { resultLayout } from './layout';
import { useRollUp } from './Motion';

const signed = (n: number) => `${n >= 0 ? '+' : ''}${n}`;

function WinCard({ w, state }: { w: WinRecord; state: ClientState }) {
  const { t, locale } = useT();
  const seatOf = (seat: number) => state.seats.find((s) => s.seat === seat);
  const name = (seat: number) => seatOf(seat)?.name ?? t('table.seat', { n: seat + 1 });
  const tai = useRollUp(w.score.tai);
  // Settings → Display: the winning hand grows with the tile size (the row wraps), the 台 list with the text size.
  const { tileScale, fontFactor } = useDisplayScale();
  const tileSize = scaledTile('sm', tileScale);
  const itemText = scaleTextStyle(styles.itemText, fontFactor);
  const itemEn = scaleTextStyle(styles.itemEn, fontFactor);
  const itemTai = scaleTextStyle(styles.itemTai, fontFactor);
  const payment = scaleTextStyle(styles.payment, fontFactor);
  // Flower wins (八仙過海 / 七搶一) end the hand on a bonus tile: the winning tile sits in the flowers row.
  const flowerWin = w.score.flowerWin;
  const how = flowerWin === 'eight' ? t('table.win.eightFlowers') : flowerWin === 'sevenRob' ? t('table.win.sevenRob', { name: name(w.fromSeat!) }) : w.selfDrawn ? t('table.win.selfDrawn') : t('table.win.dealtIn', { name: name(w.fromSeat!) });
  return (
    <View style={styles.winCard}>
      <Row gap={10}>
        <AvatarPlate id={seatAvatarId(seatOf(w.seat), w.seat)} size={40} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.winTitle, nameFont(name(w.seat))]}>{t('table.win.title', { name: name(w.seat) })}</Text>
          <Text style={styles.winSub}>{how}</Text>
        </View>
        <View style={styles.taiBadge} accessible accessibilityLabel={t('table.win.tai', { tai: w.score.tai })} testID="tai-total">
          <StrokeText style={{ fontSize: 24 }} strokeWidth={2} drop={1.5}>
            {tai}
          </StrokeText>
          <Text style={styles.taiLabel}>{t('table.win.taiLabel')}</Text>
        </View>
      </Row>
      <Row style={{ flexWrap: 'wrap', rowGap: 4 }} gap={2}>
        {w.melds.map((m, i) => (
          <MeldView key={i} meld={m} size={tileSize} />
        ))}
        {w.hand.map((tile) => (
          <Tile key={tile} tile={tile} size={tileSize} highlight={tile === w.winningTile ? 'wait' : undefined} />
        ))}
        {w.flowers.map((f) => (
          <Tile key={f} tile={f} size={tileSize} highlight={flowerWin && f === w.winningTile ? 'wait' : undefined} />
        ))}
      </Row>
      <View style={styles.items}>
        {w.score.items.map((it) => (
          <Row key={it.key} style={styles.itemRow}>
            <Text style={[itemText, { flex: 1 }]}>
              {/* zh-TW reads the 台 name alone; English adds its English name after the Chinese. */}
              {it.nameZh}
              {locale !== 'zh-TW' && <Text style={itemEn}> {it.nameEn}</Text>}
            </Text>
            <Text style={itemTai}>{t('table.win.tai', { tai: it.tai })}</Text>
          </Row>
        ))}
        {w.payments.map((p, i) => (
          <Text key={i} style={payment}>
            {t('table.win.payment', { from: name(p.from), to: name(p.to), points: p.points, tai: p.tai })}
          </Text>
        ))}
      </View>
    </View>
  );
}

function ScoreChip({ name, avatar, total, delta, mine, small, cols }: { name: string; avatar: string; total: number; delta: number; mine: boolean; small: boolean; cols: 1 | 2 | 4 }) {
  const d = useRollUp(delta);
  return (
    <View style={[styles.scoreChip, mine && { backgroundColor: '#FFF1C4' }, cols === 1 && { alignSelf: 'stretch' }, cols === 2 && { flexBasis: '47%', flexGrow: 1 }]} accessible accessibilityLabel={`${name} ${signed(total)} (${signed(delta)})`}>
      <AvatarPlate id={avatar} size={small ? 26 : 30} />
      <View style={{ flexShrink: 1 }}>
        <Text numberOfLines={1} style={[styles.scoreName, nameFont(name)]}>
          {name}
        </Text>
        <Text style={styles.scoreNum}>
          {signed(total - delta + d)} <Text style={{ color: delta >= 0 ? colors.okText : colors.dangerText }}>({signed(d)})</Text>
        </Text>
      </View>
    </View>
  );
}

export function ResultSheet({ result, view, state, mySeat, onNext, onLeave, onReview, onFairness }: { result: HandResult; view: TableView; state: ClientState; mySeat: number; onNext: () => void; onLeave: () => void; onReview: () => void; onFairness: () => void }) {
  const { t } = useT();
  const [ready, setReady] = useState(false);
  const { width, height } = useWindowDimensions();
  const layout = resultLayout(width, height);
  const { twoCol } = layout;
  const iWon = result.wins.some((w) => w.seat === mySeat);
  const audit = state.auditStatus;
  // Each locale decides whether the ribbon carries a subtitle (en: an English line under the Chinese; zh-TW: none).
  const title = t(result.type === 'draw' ? 'table.result.drawTitle' : iWon ? 'table.result.wonTitle' : 'table.result.overTitle');
  const sub = t(result.type === 'draw' ? 'table.result.drawSub' : iWon ? 'table.result.wonSub' : 'table.result.overSub');
  const ribbon = result.type === 'draw' ? colors.info : iWon ? colors.gold : colors.premium;
  const ribbonView = (
    <View style={[styles.ribbon, { backgroundColor: ribbon }, twoCol && { alignSelf: 'flex-start', paddingVertical: 3 }]} accessibilityRole="header">
      {iWon && <Icon name="star" size={twoCol ? 24 : 30} />}
      <StrokeText style={{ fontSize: twoCol ? 24 : 30, lineHeight: twoCol ? 30 : 36 }} strokeWidth={2.5} drop={2}>
        {title}
      </StrokeText>
      {!!sub && (
        <StrokeText style={{ fontSize: twoCol ? 15 : 18 }} strokeWidth={2} drop={1.5}>
          {sub}
        </StrokeText>
      )}
      {iWon && <Icon name="star" size={twoCol ? 24 : 30} />}
    </View>
  );
  const results = (
    <>
      {result.wins.map((w) => (
        <WinCard key={w.seat} w={w} state={state} />
      ))}
      {result.type === 'draw' && <P>{t(result.dealerContinues ? 'table.result.drawKeeps' : 'table.result.drawPasses')}</P>}
    </>
  );
  const scores = (
    <View style={[styles.scoreRow, layout.scoreCols === 1 && { flexDirection: 'column', flexWrap: 'nowrap', gap: 5 }, twoCol && { gap: 5 }]}>
      {view.scores.map((s, i) => {
        const info = state.seats.find((x) => x.seat === i);
        return <ScoreChip key={i} name={info?.name ?? String(i)} avatar={seatAvatarId(info, i)} total={s} delta={result.scoreDelta[i]} mine={i === mySeat} small={twoCol} cols={layout.scoreCols} />;
      })}
    </View>
  );
  // 'partial': every check passed, but the server could have picked the deal (it made this seat's share, the seat
  // joined mid-hand, the deal was restarted, or the link dropped during it). Amber with no shield, never green.
  const auditText = t(
    audit === 'ok' ? (twoCol ? 'table.audit.okShort' : 'table.audit.ok')
    : audit === 'partial' ? (twoCol ? 'fairness.result.partialShort' : 'fairness.result.partial')
    : audit === 'failed' ? 'table.audit.failed'
    : 'table.audit.pending',
  );
  const auditRow = (
    <Row style={{ flexWrap: 'wrap', rowGap: 8 }}>
      <Pressable onPress={onFairness} testID="audit-status" accessibilityRole="button" accessibilityLabel={auditText} hitSlop={10}>
        <Pill size={twoCol ? 'sm' : 'md'} text={auditText} icon={audit === 'ok' ? 'shield' : audit === 'failed' ? 'warning' : audit === 'partial' ? undefined : 'hourglass'} wrap={audit === 'partial' && !twoCol} tone={audit === 'ok' ? 'ok' : audit === 'partial' ? 'gold' : audit === 'failed' ? 'danger' : 'neutral'} />
      </Pressable>
      {state.auditFailures.map((f, i) => (
        <Text key={`f${i}`} style={{ color: colors.dangerText, fontSize: 12 }}>
          {t('fairness.note', { text: failureText(t, f) })}
        </Text>
      ))}
      {state.auditCaveats.map((c, i) => (
        <Text key={`c${i}`} style={{ color: colors.goldDim, fontSize: 12 }}>
          {t('fairness.note', { text: caveatText(t, c) })}
        </Text>
      ))}
    </Row>
  );
  const next = (
    <Button
      large={!twoCol}
      title={t(ready ? 'table.result.waiting' : 'table.result.nextHand')}
      disabled={ready}
      style={layout.stackButtons ? { alignSelf: 'stretch' } : undefined}
      onPress={() => {
        setReady(true);
        onNext();
      }}
    />
  );
  if (twoCol) {
    return (
      <View style={[styles.overlay, { padding: height < 420 ? 8 : space.md }]}>
        <View style={[styles.overlayCard, styles.overlayWide]} testID="result-sheet">
          <ScrollView style={{ flex: 1.45 }} contentContainerStyle={{ gap: 8 }}>
            {ribbonView}
            {results}
          </ScrollView>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, gap: 8, justifyContent: 'space-between' }}>
            {scores}
            {auditRow}
            <View style={{ gap: 6 }}>
              {next}
              <Row gap={6}>
                <Button small kind="secondary" title={t('table.result.review')} onPress={onReview} style={{ flex: 1 }} />
                <Button small kind="ghost" title={t('table.result.leaveTable')} onPress={onLeave} style={{ flex: 1 }} />
              </Row>
            </View>
          </ScrollView>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.overlay}>
      <ScrollView style={{ width: '100%' }} contentContainerStyle={styles.overlayScroll}>
        <View style={styles.overlayCard} testID="result-sheet">
          {ribbonView}
          {results}
          {scores}
          {auditRow}
          {layout.stackButtons ? (
            // Narrow phones: one full-width primary, the two secondary actions sharing a row at equal widths.
            <View style={{ gap: 8 }}>
              {next}
              <Row gap={8}>
                <Button kind="secondary" title={t('table.result.reviewMyHand')} onPress={onReview} style={{ flex: 1 }} />
                <Button kind="ghost" title={t('table.result.leaveTable')} onPress={onLeave} style={{ flex: 1 }} />
              </Row>
            </View>
          ) : (
            <Row style={{ flexWrap: 'wrap', rowGap: 8 }}>
              {next}
              <Button kind="secondary" title={t('table.result.reviewMyHand')} onPress={onReview} />
              <Button kind="ghost" title={t('table.result.leaveTable')} onPress={onLeave} />
            </Row>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

export function MatchOverSheet({ state, onLeave }: { state: ClientState; onLeave: () => void }) {
  const { t } = useT();
  const scores = state.finalScores ?? [];
  const order = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s);
  return (
    <View style={styles.overlay}>
      <View style={[styles.overlayCard, { maxWidth: 460 }]}>
        <View style={[styles.ribbon, { backgroundColor: colors.gold }]} accessibilityRole="header">
          <Icon name="trophy" size={34} />
          <StrokeText style={{ fontSize: 28 }} strokeWidth={2.5} drop={2}>
            {t('table.matchOver')}
          </StrokeText>
        </View>
        {order.map(({ s, i }, rank) => {
          const info = state.seats.find((x) => x.seat === i);
          return (
            <Row key={i} style={styles.rankRow}>
              <View style={[styles.rankNum, rank === 0 && { backgroundColor: colors.gold }]}>
                <Text style={styles.rankNumText}>{rank + 1}</Text>
              </View>
              <AvatarPlate id={seatAvatarId(info, i)} size={34} />
              <Text style={[styles.itemText, { flex: 1 }, nameFont(info?.name)]}>{info?.name}</Text>
              <Text style={[styles.rankScore, { color: s >= 0 ? colors.okText : colors.dangerText }]}>{signed(s)}</Text>
            </Row>
          );
        })}
        <Button large title={t('table.backHome')} onPress={onLeave} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(16,20,47,0.72)', alignItems: 'center', justifyContent: 'center', padding: space.md, zIndex: 40 },
  overlayScroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 16 },
  overlayCard: { backgroundColor: colors.cream, borderRadius: 26, padding: space.lg, paddingTop: 10, gap: space.md, width: '100%', maxWidth: 720, borderWidth: 3, borderColor: colors.ink, borderBottomWidth: 8 },
  overlayWide: { flexDirection: 'row', maxWidth: 860, flex: 1, padding: 10, paddingTop: 8, gap: 10 },
  ribbon: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, borderWidth: 3, borderColor: colors.ink, borderRadius: 18, paddingVertical: 6, paddingHorizontal: 16, alignSelf: 'center', marginTop: -2, flexWrap: 'wrap' },
  winCard: { gap: 8, backgroundColor: '#FFFFFF', borderWidth: 2.5, borderColor: colors.ink, borderRadius: 18, padding: 12 },
  winTitle: { color: colors.ink, fontSize: 17 },
  winSub: { color: colors.inkDim, fontSize: 13, fontWeight: '900' },
  taiBadge: { flexDirection: 'row', alignItems: 'center', gap: 2, backgroundColor: colors.danger, borderWidth: 2.5, borderColor: colors.ink, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 2, minWidth: 64, justifyContent: 'center' },
  taiLabel: { color: '#FFFFFF', fontWeight: '900', fontSize: 15 },
  items: { gap: 3 },
  itemRow: { justifyContent: 'space-between', borderBottomWidth: 1.5, borderBottomColor: colors.creamDeep, paddingVertical: 2 },
  itemText: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  itemEn: { color: colors.inkDim, fontWeight: '600', fontSize: 12 },
  itemTai: { color: colors.goldDim, fontWeight: '900', fontSize: 14 },
  payment: { color: colors.inkDim, fontSize: 12, fontWeight: '700' },
  scoreRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  scoreChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#FFFFFF', borderWidth: 2, borderColor: colors.ink, borderRadius: 999, paddingLeft: 3, paddingRight: 12, paddingVertical: 3 },
  scoreName: { color: colors.ink, fontSize: 12, maxWidth: 110 },
  scoreNum: { color: colors.ink, fontFamily: fonts.display, fontSize: 13 },
  rankRow: { paddingVertical: 4, borderBottomWidth: 2, borderBottomColor: colors.creamDeep },
  rankNum: { width: 30, height: 30, borderRadius: 15, borderWidth: 2.5, borderColor: colors.ink, backgroundColor: colors.creamDeep, alignItems: 'center', justifyContent: 'center' },
  rankNumText: { fontFamily: fonts.display, color: colors.ink, fontSize: 16 },
  rankScore: { fontFamily: fonts.display, fontSize: 20 },
});
