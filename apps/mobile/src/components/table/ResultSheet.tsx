/**
 * End of hand: the result sheet (winner cards with a 台 roll-up, scores, audit, next hand) and the match-over card. Each
 * is a modal dialog over the table (EndModal): named for its title, the table behind it inert on the web, Tab and
 * Shift+Tab kept on its own buttons, the dimmed scrim no control (../Scrim.tsx).
 */
import React, { useState } from 'react';
import { caveatText, endUnverified, failureText } from '../../logic/fairnessText';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
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
import { Button, P, Pill, Row, StrokeText, webPress } from '../Ui';
import { matchOverLayout, resultLayout, slopFor } from './layout';
import { useRollUp } from './Motion';
import { NextHandCountdown } from './ClockParts';
import { taiCapNote } from '../../logic/taiCap';
import { signedChange } from '../../logic/tableRating';
import { Scrim, useInertPage } from '../Scrim';

/**
 * The end-of-hand sheets' modal: a Modal over the whole table with the dimmed scrim, which does nothing on a tap (the
 * sheet closes only by its own buttons; Android's Back key does what `onBack` says, as at the table). As LookPreview: on
 * the web the Modal itself is the dialog (react-native-web makes it one) and takes the name; on a phone the sheet is.
 * `notice` is drawn over the sheet: the table's link banner, which must stay in reach while the sheet is up.
 */
function EndModal({ label, onBack, notice, children }: { label: string; onBack: () => void; notice?: React.ReactNode; children: (sheetA11y: object) => React.ReactNode }) {
  useInertPage(true);
  const web = Platform.OS === 'web';
  const sheetA11y = web ? {} : { role: 'dialog' as const, 'aria-modal': true, 'aria-label': label, accessibilityViewIsModal: true };
  const modalA11y = (web ? { 'aria-label': label } : {}) as object;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onBack} supportedOrientations={['portrait', 'landscape']} {...modalA11y}>
      <Scrim color={END_SCRIM} />
      {children(sheetA11y)}
      {notice}
    </Modal>
  );
}

/** The table dims under the end-of-hand sheets a little more than under the other sheets. */
const END_SCRIM = 'rgba(16,20,47,0.72)';

const signed = (n: number) => `${n >= 0 ? '+' : ''}${n}`;

/** The audit pill's drawn height (Ui.tsx Pill, 'md' and 'sm'). */
const AUDIT_PILL = 27;
const AUDIT_PILL_SM = 20;

function WinCard({ w, state }: { w: WinRecord; state: ClientState }) {
  const { t, locale } = useT();
  const seatOf = (seat: number) => state.seats.find((s) => s.seat === seat);
  const name = (seat: number) => seatOf(seat)?.name ?? t('table.seat', { n: seat + 1 });
  const tai = useRollUp(w.score.tai);
  // The rules' 台 cap (封頂) bit: the items below add up to more than the total, so say why.
  const capNote = taiCapNote(w.score);
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
        <View style={styles.taiBadge} accessible accessibilityLabel={capNote ? `${t('table.win.tai', { tai: w.score.tai })}. ${t(capNote.key, capNote.params)}` : t('table.win.tai', { tai: w.score.tai })} testID="tai-total">
          <StrokeText style={{ fontSize: 24 }} strokeWidth={2} drop={1.5}>
            {tai}
          </StrokeText>
          <Text style={styles.taiLabel}>{t('table.win.taiLabel')}</Text>
        </View>
      </Row>
      {capNote && (
        <Text testID="tai-capped" style={scaleTextStyle(styles.capNote, fontFactor)}>
          {t(capNote.key, capNote.params)}
        </Text>
      )}
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

/**
 * Beside final scores this phone could not check: the match is over, but the hands it verified do
 * not lead to that end. Amber like a logged hand, never a failure.
 */
function EndUnverifiedNote({ state, testID }: { state: ClientState; testID: string }) {
  const { t } = useT();
  const { fontFactor } = useDisplayScale();
  if (!endUnverified(state)) return null;
  return (
    <Text testID={testID} style={scaleTextStyle(styles.endNote, fontFactor)}>
      {t('fairness.endUnverified')}
    </Text>
  );
}

export function ResultSheet({ result, view, state, mySeat, autoNext, onNext, onLeave, onReview, onFairness, notice }: { result: HandResult; view: TableView; state: ClientState; mySeat: number; /** An online table: the next hand is dealt by itself a few seconds after this one, ready or not. */ autoNext?: boolean; onNext: () => void; onLeave: () => void; onReview: () => void; onFairness: () => void; /** The table's link banner, drawn over the sheet. */ notice?: React.ReactNode }) {
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
  // The pill is 27 px tall (20 in the two-column sheet): a 44 px press by hitSlop on a phone, by padding on the web.
  const pillH = twoCol ? AUDIT_PILL_SM : AUDIT_PILL;
  const auditRow = (
    <Row style={{ flexWrap: 'wrap', rowGap: 8 }}>
      <Pressable onPress={onFairness} testID="audit-status" accessibilityRole="button" accessibilityLabel={auditText} hitSlop={slopFor(pillH)} style={webPress(pillH)}>
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
  // Online the table does not wait for this sheet: say so, or a player reading on finds a hand already under way.
  // The host says when it deals the next hand: count down to it (./ClockParts.tsx, so only the line re-renders).
  const autoNextNote = autoNext ? <NextHandCountdown deadline={state.intermissionDeadline ?? null} style={styles.autoNext} /> : null;
  // The dialog's name is the ribbon's text: the title, and the English line under it where there is one.
  const label = sub ? `${title} ${sub}` : title;
  if (twoCol) {
    return (
      <EndModal label={label} onBack={onLeave} notice={notice}>
        {(a11y) => (
          <View style={[styles.overlay, { padding: height < 420 ? 8 : space.md }]} pointerEvents="box-none">
            <View style={[styles.overlayCard, styles.overlayWide]} testID="result-sheet" {...a11y}>
              <ScrollView style={{ flex: 1.45 }} contentContainerStyle={{ gap: 8 }}>
                {ribbonView}
                {results}
              </ScrollView>
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, gap: 8, justifyContent: 'space-between' }}>
                {scores}
                <EndUnverifiedNote state={state} testID="result-end-unverified" />
                {auditRow}
                <View style={{ gap: 6 }}>
                  {autoNextNote}
                  {next}
                  <Row gap={6}>
                    <Button small kind="secondary" title={t('table.result.review')} onPress={onReview} style={{ flex: 1 }} />
                    <Button small kind="ghost" title={t('table.result.leaveTable')} onPress={onLeave} style={{ flex: 1 }} />
                  </Row>
                </View>
              </ScrollView>
            </View>
          </View>
            )}
          </EndModal>
        );
      }
      return (
        <EndModal label={label} onBack={onLeave} notice={notice}>
      {(a11y) => (
        <View style={styles.overlay} pointerEvents="box-none">
          <ScrollView style={{ width: '100%' }} contentContainerStyle={styles.overlayScroll}>
            <View style={styles.overlayCard} testID="result-sheet" {...a11y}>
              {ribbonView}
              {results}
              {scores}
              <EndUnverifiedNote state={state} testID="result-end-unverified" />
              {auditRow}
              {layout.stackButtons ? (
                // Narrow phones: one full-width primary, the two secondary actions sharing a row at equal widths.
                <View style={{ gap: 8 }}>
                  {autoNextNote}
                  {next}
                  <Row gap={8}>
                    <Button kind="secondary" title={t(layout.shortReview ? 'table.result.review' : 'table.result.reviewMyHand')} accessibilityLabel={t('table.result.reviewMyHand')} onPress={onReview} style={{ flex: 1 }} />
                    <Button kind="ghost" title={t('table.result.leaveTable')} onPress={onLeave} style={{ flex: 1 }} />
                  </Row>
                </View>
              ) : (
                <Row style={{ flexWrap: 'wrap', rowGap: 8 }}>
                  {autoNextNote && <View style={{ flexBasis: '100%' }}>{autoNextNote}</View>}
                  {next}
                  <Button kind="secondary" title={t('table.result.reviewMyHand')} onPress={onReview} />
                  <Button kind="ghost" title={t('table.result.leaveTable')} onPress={onLeave} />
                </Row>
              )}
            </View>
          </ScrollView>
        </View>
      )}
    </EndModal>
  );
}

/**
 * The match-over card. After a quick match `rating` is the player's quick-match rating: 'pending'
 * while the server applies the match, then the new rating and its change (null or absent: no line).
 */
export function MatchOverSheet({ state, onLeave, rating }: { state: ClientState; onLeave: () => void; rating?: { rating: number; change: number } | 'pending' | null }) {
  const { t } = useT();
  const { height } = useWindowDimensions();
  const L = matchOverLayout(height);
  const scores = state.finalScores ?? [];
  const order = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s);
  return (
    <EndModal label={t('table.matchOver')} onBack={onLeave}>
      {(a11y) => (
        <View style={[styles.overlay, { padding: L.pad }]} pointerEvents="box-none">
          {/* Never taller than the window: the ranks scroll inside the card (a short phone, a large text size, the note). */}
          <View style={[styles.overlayCard, styles.matchCard, { maxHeight: L.maxHeight }, L.compact && { paddingVertical: 8 }]} testID="match-over" {...a11y}>
            <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap: L.compact ? 6 : space.md }} testID="match-over-scroll">
              <View style={[styles.ribbon, { backgroundColor: colors.gold }, L.compact && { paddingVertical: 2 }]} accessibilityRole="header">
                <Icon name="trophy" size={L.trophy} />
                <StrokeText style={{ fontSize: L.title }} strokeWidth={2.5} drop={2}>
                  {t('table.matchOver')}
                </StrokeText>
              </View>
              {order.map(({ s, i }, rank) => {
                const info = state.seats.find((x) => x.seat === i);
                return (
                  <Row key={i} style={[styles.rankRow, { paddingVertical: L.rowPad }]}>
                    <View style={[styles.rankNum, rank === 0 && { backgroundColor: colors.gold }, L.compact && styles.rankNumSmall]}>
                      <Text style={styles.rankNumText}>{rank + 1}</Text>
                    </View>
                    <AvatarPlate id={seatAvatarId(info, i)} size={L.avatar} />
                    <Text style={[styles.itemText, { flex: 1 }, nameFont(info?.name)]}>{info?.name}</Text>
                    <Text style={[styles.rankScore, { color: s >= 0 ? colors.okText : colors.dangerText }]}>{signed(s)}</Text>
                  </Row>
                );
              })}
              {rating === 'pending' && (
                <Text style={styles.ratingNote} testID="match-rating">
                  {t('table.ratingPending')}
                </Text>
              )}
              {rating && rating !== 'pending' && (
                <Text style={styles.ratingNote} testID="match-rating">
                  {t('table.ratingChange', { rating: rating.rating, change: signedChange(rating.change) })}
                </Text>
              )}
              <EndUnverifiedNote state={state} testID="match-end-unverified" />
              <Button large={!L.compact} title={t('table.backHome')} onPress={onLeave} testID="match-over-home" />
            </ScrollView>
          </View>
        </View>
      )}
    </EndModal>
  );
}

const styles = StyleSheet.create({
  // In the modal, over its scrim (EndModal): lays the card out in the middle of the window.
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: space.md },
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
  capNote: { color: colors.ink, fontSize: 12, lineHeight: 16, fontWeight: '700', backgroundColor: colors.gold, borderWidth: 2, borderColor: colors.ink, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, overflow: 'hidden' },
  scoreRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  scoreChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#FFFFFF', borderWidth: 2, borderColor: colors.ink, borderRadius: 999, paddingLeft: 3, paddingRight: 12, paddingVertical: 3 },
  scoreName: { color: colors.ink, fontSize: 12, maxWidth: 110 },
  scoreNum: { color: colors.ink, fontFamily: fonts.display, fontSize: 13 },
  matchCard: { maxWidth: 460, flexShrink: 1 },
  rankRow: { paddingVertical: 4, borderBottomWidth: 2, borderBottomColor: colors.creamDeep },
  rankNumSmall: { width: 26, height: 26, borderRadius: 13 },
  rankNum: { width: 30, height: 30, borderRadius: 15, borderWidth: 2.5, borderColor: colors.ink, backgroundColor: colors.creamDeep, alignItems: 'center', justifyContent: 'center' },
  rankNumText: { fontFamily: fonts.display, color: colors.ink, fontSize: 16 },
  rankScore: { fontFamily: fonts.display, fontSize: 20 },
  autoNext: { color: colors.inkDim, fontSize: 12, fontFamily: fonts.bodyBold },
  endNote: { color: colors.goldDim, fontSize: 12, fontFamily: fonts.bodyBold },
  ratingNote: { color: colors.ink, fontSize: 14, fontFamily: fonts.bodyBold, textAlign: 'center' },
});
