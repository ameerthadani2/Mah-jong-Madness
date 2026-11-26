/**
 * Every discard at the table, in a modal sheet over it: each seat's whole pond in the order it was played, the newest
 * discard ringed, and its sets and flowers. A tap on an opponent's seat on the felt opens it with that seat first (Felt.tsx
 * `onSeatPress`); the felt shows only what fits it (display/portraitFit.ts keeps a pond's newest rows behind a "+N" chip on a
 * small phone), so this is where the earlier discards are. The game goes on underneath and the sheet follows it. Closed by
 * its Close button, the scrim or the Back key (Escape on the web); the page behind is inert on the web while it is open
 * (../Scrim.tsx), as for the coach's sheet.
 */
import React from 'react';
import { Modal, Platform, ScrollView, StyleSheet, View, useWindowDimensions, type TextStyle } from 'react-native';
import { Text } from '../Text';
import type { TableView, TileId } from '@mjm/engine';
import { colors, fonts, radius, space } from '../../theme';
import { useT } from '../../i18n';
import { useDisplayScale } from '../../display/DisplayScale';
import { scaleTextStyle } from '../../display/scale';
import { DiscardPool, MeldsAndFlowers } from '../TableParts';
import { scaledTile } from '../Tile';
import { tileDims } from '../tileDims';
import { Scrim, useInertPage } from '../Scrim';
import { H2, IconButton, Row } from '../Ui';

const REL_KEYS = ['me', 'right', 'across', 'left'] as const;

/** The seats in the order the sheet lists them: `first` (a seat relative to mine: 1 right, 2 across, 3 left), then right, across, left and me. */
export function discardsOrder(first: number | null): number[] {
  const rest = [1, 2, 3, 0];
  return first === null || !rest.includes(first) ? rest : [first, ...rest.filter((r) => r !== first)];
}

/** The sheet's tile width: the reader's tile size, but never so large that a row holds fewer than `minPerRow` tiles. */
export function discardsTile(contentW: number, tileScale: number, minPerRow = 6): { tile: number; perRow: number } {
  const want = tileDims(scaledTile('xs', tileScale)).w;
  const tile = Math.max(16, Math.min(want, Math.floor((contentW + 2) / minPerRow) - 2));
  return { tile, perRow: Math.max(1, Math.floor((contentW + 2) / (tile + 2))) };
}

export function DiscardsSheet({ visible, first, view, mySeat, seatName, onClose }: { visible: boolean; first: number | null; view: TableView | null; mySeat: number; seatName: (seat: number) => string; onClose: () => void }) {
  const { t } = useT();
  const { width, height } = useWindowDimensions();
  const { fontFactor, tileScale } = useDisplayScale();
  const open = visible && view !== null;
  useInertPage(open);
  const label = t('table.discards.sheetLabel');
  // As the coach's sheet: on the web the Modal itself is the dialog and takes the name; on a phone the sheet is the dialog.
  const web = Platform.OS === 'web';
  const sheetA11y = web ? {} : { role: 'dialog' as const, 'aria-modal': true, 'aria-label': label, accessibilityViewIsModal: true };
  const modalA11y = (web ? { 'aria-label': label } : {}) as object;
  const size = (s: TextStyle) => (fontFactor === 1 ? s : scaleTextStyle(s, fontFactor));
  // The sheet is at most 520 px wide, space.md from the window's edges; its card pads 12 px inside a 3 px border.
  const contentW = Math.min(width - 2 * space.md, 520) - 2 * 12 - 2 * 3;
  const { tile, perRow } = discardsTile(contentW, tileScale);
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']} {...modalA11y}>
      <Scrim onPress={onClose} testID="discards-sheet-scrim" />
      <View style={styles.sheetWrap} pointerEvents="box-none">
        <View {...sheetA11y} testID="discards-sheet" style={[styles.sheetShell, { maxHeight: height - 2 * space.md }]}>
          <View style={styles.sheet}>
            <Row gap={8}>
              <H2 style={{ flex: 1 }} heading>
                {t('table.discards.title')}
              </H2>
              <IconButton icon="cross" kind="ghost" testID="discards-sheet-close" label={t('table.discards.close')} onPress={onClose} />
            </Row>
            <ScrollView style={styles.scroll} contentContainerStyle={{ gap: 12 }}>
              {view &&
                discardsOrder(first).map((r) => {
                  const seat = (mySeat + r) % 4;
                  const p = view.players[seat];
                  const latest: TileId | undefined = view.lastDiscard && view.lastDiscard.seat === seat ? view.lastDiscard.tile : undefined;
                  return (
                    <View key={r} style={styles.section} testID={`discards-seat-${r}`}>
                      <Row gap={6} style={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <Text accessibilityRole="header" style={size(TYPE.seat)}>
                          {t('table.discards.seat', { name: seatName(seat), rel: t(`table.relSeat.${REL_KEYS[r]}`) })}
                        </Text>
                        <Text style={size(TYPE.count)}>{t('table.discards.count', { count: p.discards.length })}</Text>
                      </Row>
                      {p.discards.length > 0 ? (
                        <DiscardPool tiles={p.discards} size={tile} perRow={perRow} latest={latest} testID={`discards-pond-${r}`} />
                      ) : (
                        <Text style={size(TYPE.none)}>{t('table.discards.none')}</Text>
                      )}
                      {(p.melds.length > 0 || p.flowers.length > 0) && (
                        <View style={{ gap: 2 }} testID={`discards-sets-${r}`}>
                          <Text style={size(TYPE.count)}>{t('table.discards.sets')}</Text>
                          <MeldsAndFlowers player={p} size={tile} flowerSize={tile} />
                        </View>
                      )}
                    </View>
                  );
                })}
            </ScrollView>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** The sheet's type at the table's size (scaled with the reader's text size). */
const TYPE = {
  seat: { color: colors.ink, fontFamily: fonts.uiBold, fontSize: 14, lineHeight: 18 },
  count: { color: colors.inkDim, fontSize: 12, lineHeight: 16, fontWeight: '800' },
  none: { color: colors.inkDim, fontSize: 12, lineHeight: 16, fontWeight: '700' },
} satisfies Record<string, TextStyle>;

const styles = StyleSheet.create({
  sheetWrap: { flex: 1, justifyContent: 'flex-end', alignItems: 'center', padding: space.md },
  sheetShell: { width: '100%', maxWidth: 520, flexShrink: 1, borderWidth: 3, borderColor: colors.ink, borderRadius: radius.lg, paddingBottom: 5, backgroundColor: colors.creamShelf },
  sheet: { backgroundColor: colors.cream, borderRadius: radius.lg - 3, padding: 12, gap: space.sm, flexShrink: 1, overflow: 'hidden' },
  scroll: { flexGrow: 0, flexShrink: 1 },
  section: { gap: 4 },
});
