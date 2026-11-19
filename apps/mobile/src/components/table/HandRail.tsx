/**
 * My seat under the table: plate, flowers, the hand on its wooden rack, and my melds. On a landscape phone the coach's
 * bar sits here too, just above the hand: beside my plate and melds where they have a row of their own (Large and
 * Extra-large tiles), or in a slim row of its own beside my plate (Normal tiles).
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { PlayerView, TileId } from '@mjm/engine';
import { colors } from '../../theme';
import { useT } from '../../i18n';
import { MeldsAndFlowers, MeldView, SeatBadge } from '../TableParts';
import { Tile } from '../Tile';
import { Row } from '../Ui';
import { tileName } from './ActionBar';
import type { PlateProps } from './Felt';
import type { TableLayout } from './layout';

export function HandRail({
  me,
  layout: L,
  plate,
  handTile,
  plateW,
  meldTile = 28,
  wide = false,
  scroll = false,
  selected,
  canDiscard,
  drawn,
  best,
  onTile,
  coach,
  onPlateTop,
}: {
  me: PlayerView;
  layout: TableLayout;
  plate: PlateProps;
  handTile: number;
  plateW: number;
  /** My melds' tile width (grows with Settings → Display → Tiles). */
  meldTile?: number;
  /** Landscape at Large and Extra-large: my plate and melds in a row above the hand, which spans the whole width (tableFit's `wide`). */
  wide?: boolean;
  /** Landscape at a large tile size: the hand is wider than the rail and scrolls sideways. */
  scroll?: boolean;
  selected: TileId | null;
  canDiscard: boolean;
  /** The tile just drawn (set apart at the end of the hand), if it is mine to discard. */
  drawn: TileId | null;
  /** The coach's recommended discard. */
  best?: TileId;
  onTile: (tile: TileId) => void;
  /** Landscape phones: the coach's bar (CoachPanel.tsx CoachBar), while the coach is on. */
  coach?: React.ReactNode;
  /**
   * Landscape at Normal tiles: where my plate column (my flowers over my plate) starts, as a window y; null where it has a
   * row of its own above the hand. The felt's left seat ends above it (Felt `leftSeatEnd`).
   */
  onPlateTop?: (y: number | null) => void;
}) {
  const { t, locale } = useT();
  const { portrait, tablet } = L;
  // Portrait, and landscape at a large tile size: my plate and melds have a row of their own above the hand.
  const above = portrait || wide;
  const myPlate = <SeatBadge {...plate} size={tablet ? 54 : above ? 36 : 40} vertical={!above} maxNameWidth={above ? 120 : plateW - 4} />;
  const hand = me.hand ?? [];
  const scroller = useRef<React.ComponentRef<typeof ScrollView>>(null);
  // My plate column grows upward over the felt's corner, the more the more flowers I have; measured in the window when it
  // is laid out, and again when the hand's size or my flowers change (its own box may not move then).
  const plateCol = useRef<React.ElementRef<typeof View>>(null);
  const reportPlate = useCallback(() => {
    if (!onPlateTop) return;
    if (above) {
      onPlateTop(null);
      return;
    }
    plateCol.current?.measureInWindow((_x, y, _w, h) => {
      if (h > 0) onPlateTop(Math.round(y));
    });
  }, [onPlateTop, above]);
  useEffect(() => {
    reportPlate();
  }, [reportPlate, handTile, me.flowers.length]);
  const tiles = (
    <View style={[styles.handTiles, portrait && { flexWrap: 'wrap', rowGap: 6, justifyContent: 'center' }]} accessibilityRole="list" accessibilityLabel={t('table.a11y.hand', { n: hand.length })} testID={canDiscard ? 'hand-discard' : 'hand'}>
      {hand.map((tile, i) => (
        <Tile
          key={tile}
          tile={tile}
          size={handTile}
          selected={selected === tile}
          dimmed={canDiscard ? false : undefined}
          highlight={best === tile && canDiscard ? 'good' : undefined}
          onPress={() => onTile(tile)}
          accessibilityLabel={selected === tile ? t('table.a11y.tileSelected', { tile: tileName(tile, locale) }) : tileName(tile, locale)}
          accessibilityHint={canDiscard ? t(selected === tile ? 'table.a11y.tapToDiscard' : 'table.a11y.tapToSelect') : undefined}
          style={drawn === tile && i === hand.length - 1 ? { marginLeft: 10 } : undefined}
        />
      ))}
    </View>
  );
  return (
    <View style={[styles.footer, above && { paddingTop: 4 }]}>
      {above && (
        // The coach's bar takes what my plate and melds leave of the row, or a line of its own when they leave too little.
        <Row gap={10} style={[{ paddingHorizontal: 4, marginBottom: 2 }, !!coach && styles.plateRowWrap]}>
          {myPlate}
          <MeldsAndFlowers player={me} size={meldTile} style={coach ? styles.meldsBesideCoach : { flex: 1 }} />
          {!!coach && (
            <View style={styles.coachBeside} testID="coach-slot">
              {coach}
            </View>
          )}
        </Row>
      )}
      {!above && !!coach && (
        // Normal tiles: my plate stands beside the hand, rising over the rail; the bar takes the row beside it.
        <View style={[styles.coachRow, { paddingLeft: plateW }]} testID="coach-slot">
          {coach}
        </View>
      )}
      {/* Over the coach's row (its press reaches below its bar), so a raised selected tile takes the press where it is; its
          empty space lets presses through to the bar. */}
      <View style={styles.handRow} pointerEvents="box-none">
        {!above && (
          <View style={{ width: plateW }}>
            {/* Grows upward so my avatar overlaps the rail instead of stealing height from the felt. */}
            <View ref={plateCol} style={[styles.myPlateCol, { width: plateW }]} onLayout={reportPlate}>
              {me.flowers.length > 0 && (
                <View style={styles.myFlowers}>
                  {me.flowers.map((f) => (
                    <Tile key={f} tile={f} size={tablet ? 20 : 16} />
                  ))}
                </View>
              )}
              {myPlate}
            </View>
          </View>
        )}
        <View style={{ flex: 1 }}>
          <View style={[styles.rack, { height: Math.round(handTile * 0.42) }]}>
            <View style={styles.rackTop} />
          </View>
          {scroll ? (
            // The drawn tile sits at the end of the row: keep it in view as the hand changes.
            <ScrollView ref={scroller} horizontal showsHorizontalScrollIndicator={false} onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: false })} testID="hand-scroll">
              {tiles}
            </ScrollView>
          ) : (
            tiles
          )}
        </View>
        {!above && me.melds.length > 0 && (
          <View style={styles.myMelds}>
            {me.melds.map((m, i) => (
              <MeldView key={i} meld={m} size={meldTile} />
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  footer: { paddingHorizontal: 12, paddingBottom: 4, paddingTop: 2 },
  handRow: { flexDirection: 'row', alignItems: 'flex-end', zIndex: 2 },
  myPlateCol: { position: 'absolute', left: 0, bottom: 4, alignItems: 'center', gap: 4 },
  myFlowers: { flexDirection: 'row', flexWrap: 'wrap', gap: 1, justifyContent: 'center' },
  myMelds: { flexDirection: 'row', alignItems: 'flex-end', marginLeft: 10, paddingBottom: 7 },
  rack: { position: 'absolute', left: -6, right: -6, bottom: 0, backgroundColor: colors.rail, borderWidth: 3, borderColor: colors.ink, borderRadius: 10, overflow: 'hidden' },
  rackTop: { position: 'absolute', top: 0, left: 0, right: 0, height: 5, backgroundColor: colors.railLight },
  handTiles: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, paddingTop: 12, paddingBottom: 7, paddingHorizontal: 4 },
  plateRowWrap: { flexWrap: 'wrap', rowGap: 4 },
  meldsBesideCoach: { flexShrink: 1 },
  coachBeside: { flexGrow: 1, flexBasis: 240, minWidth: 240, maxWidth: '100%' },
  // Drawn over the bottom of the felt's wooden frame (the felt's frame keeps 18 px under its last row, the felt 6 more),
  // so the bar costs the felt only about half its height.
  coachRow: { marginTop: -16, marginBottom: 2, zIndex: 1 },
});
