/**
 * The coach (offline bot tables only), in three forms that share one rule: while the coach is on, it is on screen,
 * whole, and what does not fit is one tap away.
 *
 * - CoachBar: phones. A slim bar, under the felt over its rail in portrait and above my hand in landscape (layout.ts
 *   coachBarLines), never in a share of the felt that the ponds or the claim buttons can take. It shows the advice
 *   (the win, the tile to discard or the claim to make; coachText.ts) on the lines it has, ending in an ellipsis
 *   when it is longer, and the whole bar is a button, marked "More", that opens the sheet.
 * - CoachPanel: tablets and tall landscape screens. Everything, under the right seat; past the height it is given it
 *   scrolls, and a "More" button under it opens the sheet.
 * - CoachSheet: everything the coach says (status, win, discard, waits with what is left of each, every claim with
 *   its reason, and Pass where it would let a claim go by), in a modal sheet at the reader's text size.
 */
import React, { useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import type { Hint } from '@mjm/engine';
import { colors, fonts, radius, space } from '../../theme';
import { useT } from '../../i18n';
import { useDisplayScale } from '../../display/DisplayScale';
import { scaleTextStyle } from '../../display/scale';
import { CoachOwl } from '../Avatars';
import { Icon } from '../Icons';
import { Scrim, useInertPage } from '../Scrim';
import { Tile } from '../Tile';
import { H2, IconButton, Row } from '../Ui';
import { coachLines } from './coachText';
import type { CoachBarLines } from './layout';

/**
 * The bar: the owl, the advice on the lines it has (or the status, when there is no advice), and "More". `face`, when
 * given, is the bar's height as drawn (the pinned bar in portrait, pinnedCoachFace in layout.ts): at least 44 px, so the
 * bar is its own press, and the same height at every decision, so the felt around it never moves.
 */
export function CoachBar({ hint, lines, onOpen, style, face }: { hint: Hint; lines: CoachBarLines; onOpen: () => void; style?: StyleProp<ViewStyle>; face?: number }) {
  const { t } = useT();
  const { status, advice } = coachLines(hint, t);
  // Without advice, the status has the advice's lines too (a drawn-to-height bar: as many as its height holds).
  const statusLines = advice ? lines.status : face !== undefined ? (lines.status > 0 ? 2 : 1) : Math.max(1, lines.status + lines.advice);
  // A bar drawn at least 44 px tall needs no press beyond its edges.
  const slop = face === undefined;
  return (
    <Pressable
      testID="coach"
      onPress={onOpen}
      accessibilityRole="button"
      // A screen reader hears every word, whatever the ellipsis leaves on screen.
      accessibilityLabel={advice ? `${status} ${advice}` : status}
      accessibilityHint={t('table.coach.moreHint')}
      // A one-line bar is 27 px tall: 9 px more above and below make a 44 pt press, short of the claim buttons above
      // and of the hand's tiles below (they stand 12 px down their row). On a phone hitSlop adds them; the web ignores
      // hitSlop, so there the press is padded by as much, with an equal negative margin that keeps the bar in place
      // (as IconButton does).
      hitSlop={slop && Platform.OS !== 'web' ? BAR_SLOP : undefined}
      style={slop && Platform.OS === 'web' ? styles.barWebPress : undefined}
    >
      {({ pressed }) => (
        <View style={[styles.bar, face !== undefined && { height: face }, pressed && styles.barPressed, style]} testID="coach-face">
          <CoachOwl size={18} />
          <View style={styles.barText} testID="coach-text">
            {statusLines > 0 && (
              <Text numberOfLines={statusLines} style={styles.barStatus} testID="coach-status">
                {status}
              </Text>
            )}
            {advice !== null && (
              <Text numberOfLines={lines.advice} style={styles.barAdvice} testID="coach-advice">
                {advice}
              </Text>
            )}
          </View>
          <View style={styles.more} testID="coach-more">
            <Text style={styles.moreText}>{t('table.coach.more')}</Text>
          </View>
        </View>
      )}
    </Pressable>
  );
}

/** What the bar's press reaches past its drawn edges (on a phone by hitSlop, on the web by padding). */
const BAR_SLOP = { top: 9, bottom: 9, left: 4, right: 4 } as const;

/** Everything the coach says, at `factor` times the table's type (the sheet passes the reader's text size). */
export function CoachDetails({ hint, factor = 1 }: { hint: Hint; factor?: number }) {
  const { t } = useT();
  const engine = (key: string, params?: Record<string, string | number>) => t(`engine.${key}`, params);
  const size = (s: TextStyle) => (factor === 1 ? s : scaleTextStyle(s, factor));
  const { status, advice, kind } = coachLines(hint, t);
  const preview = hint.winPreview ? advice : null;
  const discard = hint.discardReasonKey ? engine(hint.discardReasonKey, hint.discardReasonParams) : null;
  // The advice (coachText.ts) is the line the e2e checks look for: the win, else the discard, else the recommended claim,
  // else Pass at a claim chance the coach would let go by.
  const adviceIs = preview !== null ? 'preview' : discard !== null ? 'discard' : kind === 'pass' ? 'pass' : 'claim';
  return (
    <>
      <Text style={size(TYPE.status)} testID="coach-sheet-status">
        {status}
      </Text>
      {preview !== null && (
        <Text style={size(TYPE.line)} testID="coach-advice">
          {preview}
        </Text>
      )}
      {discard !== null && (
        <Text style={size(TYPE.line)} testID={adviceIs === 'discard' ? 'coach-advice' : undefined}>
          {discard}
        </Text>
      )}
      {hint.waits.length > 0 && (
        <Row style={{ flexWrap: 'wrap' }} gap={4}>
          <Text style={size(TYPE.label)}>{t('table.coach.waits')}</Text>
          {hint.waits.map((w) => (
            <View key={w.kind} style={{ alignItems: 'center' }}>
              <Tile kind={w.kind} size="xs" highlight="wait" />
              <Text style={size(TYPE.count)}>{t('table.coach.remaining', { n: w.remaining })}</Text>
            </View>
          ))}
        </Row>
      )}
      {adviceIs === 'pass' && (
        <Row gap={4} style={{ alignItems: 'flex-start' }}>
          <Icon name="check" size={16} color={colors.cta} />
          <Text style={[size(TYPE.line), { flex: 1 }, { color: colors.okText }]} testID="coach-advice">
            {advice}
          </Text>
        </Row>
      )}
      {hint.claims.map((c, i) => (
        <Row key={i} gap={4} style={{ alignItems: 'flex-start' }}>
          {c.recommended ? <Icon name="check" size={16} color={colors.cta} /> : <View style={styles.dot} />}
          <Text style={[size(TYPE.line), { flex: 1 }, c.recommended && { color: colors.okText }]} testID={c.recommended && adviceIs === 'claim' ? 'coach-advice' : undefined}>
            {t('table.coach.claimLine', { label: engine(c.labelKey, c.labelParams), reason: engine(c.reasonKey, c.reasonParams) })}
          </Text>
        </Row>
      ))}
    </>
  );
}

/** "More": opens the coach's sheet. */
function MoreButton({ onPress }: { onPress: () => void }) {
  const { t } = useT();
  return (
    // A 19 px pill: hitSlop makes a 44 pt press on a phone; the web ignores it, so there the padding does (as the bar's).
    <Pressable testID="coach-more" onPress={onPress} accessibilityRole="button" accessibilityLabel={t('table.coach.moreHint')} hitSlop={Platform.OS === 'web' ? undefined : 12} style={[styles.moreAlone, Platform.OS === 'web' && styles.moreWebPress]}>
      {({ pressed }) => (
        <View style={[styles.more, pressed && styles.barPressed]}>
          <Text style={styles.moreText}>{t('table.coach.more')}</Text>
        </View>
      )}
    </Pressable>
  );
}

/**
 * The full coach, under the right seat on tablets and tall landscape screens. It keeps the height it needs up to
 * `maxHeight`; past that its text scrolls and "More" (always shown then) opens the sheet, so nothing is cut unseen.
 */
export function CoachPanel({ hint, maxHeight, onOpen }: { hint: Hint; maxHeight?: number; onOpen: () => void }) {
  const { t } = useT();
  const [box, setBox] = useState(0);
  const [content, setContent] = useState(0);
  const overflow = box > 0 && content > box + 1;
  return (
    <View style={[styles.coach, maxHeight ? { maxHeight } : null]} accessibilityRole="summary" testID="coach">
      <Row gap={8}>
        <CoachOwl size={36} />
        <Text style={styles.coachTitle}>{t('table.coach.title')}</Text>
      </Row>
      <ScrollView
        style={styles.panelScroll}
        contentContainerStyle={{ gap: 4 }}
        onLayout={(e) => setBox(Math.round(e.nativeEvent.layout.height))}
        onContentSizeChange={(_w, h) => setContent(Math.round(h))}
        testID="coach-text"
      >
        <CoachDetails hint={hint} />
      </ScrollView>
      {overflow && <MoreButton onPress={onOpen} />}
    </View>
  );
}

/**
 * The coach's sheet: everything it says, at the reader's text size, in a modal sheet over the table (the game goes on
 * underneath and the sheet follows it). Closed by its Close button, the scrim or the Back key; the page behind is
 * inert on the web while it is open (../Scrim.tsx).
 */
export function CoachSheet({ hint, visible, onClose }: { hint: Hint | null; visible: boolean; onClose: () => void }) {
  const { t } = useT();
  const { height } = useWindowDimensions();
  const { fontFactor } = useDisplayScale();
  const open = visible && hint !== null;
  useInertPage(open);
  const label = t('table.coach.sheetLabel');
  // As LookPreview: on the web the Modal itself is the dialog and takes the name; on a phone the sheet is the dialog.
  const web = Platform.OS === 'web';
  const sheetA11y = web ? {} : { role: 'dialog' as const, 'aria-modal': true, 'aria-label': label, accessibilityViewIsModal: true };
  const modalA11y = (web ? { 'aria-label': label } : {}) as object;
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']} {...modalA11y}>
      <Scrim onPress={onClose} testID="coach-sheet-scrim" />
      <View style={styles.sheetWrap} pointerEvents="box-none">
        <View {...sheetA11y} testID="coach-sheet" style={[styles.sheetShell, { maxHeight: height - 2 * space.md }]}>
          {/* A Card's look, drawn here so the sheet can shrink to the window and scroll its middle (as LookPreview). */}
          <View style={styles.sheet}>
            <Row gap={8}>
              <CoachOwl size={36} />
              <H2 style={{ flex: 1 }}>{t('table.coach.title')}</H2>
              <IconButton icon="cross" kind="ghost" testID="coach-sheet-close" label={t('table.coach.close')} onPress={onClose} />
            </Row>
            <ScrollView style={styles.sheetScroll} contentContainerStyle={{ gap: 6 }}>
              {hint && <CoachDetails hint={hint} factor={fontFactor} />}
            </ScrollView>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** The coach's type at the table's size (the sheet scales it with the reader's text size). */
const TYPE = {
  status: { color: colors.ink, fontFamily: fonts.uiBold, fontSize: 13, lineHeight: 17 },
  line: { color: colors.inkDim, fontSize: 12, lineHeight: 15, fontWeight: '700' },
  label: { color: colors.ink, fontWeight: '900', fontSize: 13, lineHeight: 17 },
  count: { color: colors.inkDim, fontSize: 11, lineHeight: 14, fontWeight: '800' },
} satisfies Record<string, TextStyle>;

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0, backgroundColor: colors.cream, borderRadius: 14, borderWidth: 2.5, borderColor: colors.ink, paddingHorizontal: 6, paddingVertical: 2 },
  barPressed: { opacity: 0.85 },
  barWebPress: { paddingTop: BAR_SLOP.top, paddingBottom: BAR_SLOP.bottom, paddingLeft: BAR_SLOP.left, paddingRight: BAR_SLOP.right, marginTop: -BAR_SLOP.top, marginBottom: -BAR_SLOP.bottom, marginLeft: -BAR_SLOP.left, marginRight: -BAR_SLOP.right },
  barText: { flex: 1, minWidth: 0 },
  barStatus: { color: colors.ink, fontFamily: fonts.uiBold, fontSize: 13, lineHeight: 17 },
  barAdvice: { color: colors.ink, fontSize: 12, lineHeight: 15, fontWeight: '700' },
  more: { flexShrink: 0, backgroundColor: colors.info, borderRadius: 999, borderWidth: 2, borderColor: colors.ink, paddingHorizontal: 8 },
  moreAlone: { alignSelf: 'flex-end' },
  moreWebPress: { paddingVertical: 13, marginVertical: -13, paddingHorizontal: 6, marginHorizontal: -6 },
  moreText: { color: '#FFFFFF', fontFamily: fonts.uiBold, fontSize: 12, lineHeight: 15 },
  coach: { flexShrink: 0, backgroundColor: colors.cream, borderRadius: 16, padding: 8, gap: 4, borderWidth: 3, borderColor: colors.ink },
  coachTitle: { color: colors.ink, fontFamily: fonts.display, fontSize: 18 },
  panelScroll: { flexGrow: 0, flexShrink: 1 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.inkDim, marginTop: 5, marginHorizontal: 5 },
  sheetWrap: { flex: 1, justifyContent: 'flex-end', alignItems: 'center', padding: space.md },
  sheetShell: { width: '100%', maxWidth: 520, flexShrink: 1, borderWidth: 3, borderColor: colors.ink, borderRadius: radius.lg, paddingBottom: 5, backgroundColor: colors.creamShelf },
  sheet: { backgroundColor: colors.cream, borderRadius: radius.lg - 3, padding: 12, gap: space.sm, flexShrink: 1, overflow: 'hidden' },
  sheetScroll: { flexGrow: 0, flexShrink: 1 },
});
