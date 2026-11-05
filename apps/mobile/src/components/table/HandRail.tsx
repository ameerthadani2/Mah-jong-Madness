/** My seat under the table: plate, flowers, the hand on its wooden rack, and my melds. */
import React from 'react';
import { StyleSheet, View } from 'react-native';
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
  selected,
  canDiscard,
  drawn,
  best,
  onTile,
}: {
  me: PlayerView;
  layout: TableLayout;
  plate: PlateProps;
  handTile: number;
  plateW: number;
  selected: TileId | null;
  canDiscard: boolean;
  /** The tile just drawn (set apart at the end of the hand), if it is mine to discard. */
  drawn: TileId | null;
  /** The coach's recommended discard. */
  best?: TileId;
  onTile: (tile: TileId) => void;
}) {
  const { t, locale } = useT();
  const { portrait, tablet } = L;
  const myPlate = <SeatBadge {...plate} size={tablet ? 54 : portrait ? 36 : 40} vertical={!portrait} maxNameWidth={portrait ? 120 : plateW - 4} />;
  const hand = me.hand ?? [];
  return (
    <View style={[styles.footer, portrait && { paddingTop: 4 }]}>
      {portrait && (
        <Row gap={10} style={{ paddingHorizontal: 4, marginBottom: 2 }}>
          {myPlate}
          <MeldsAndFlowers player={me} size="sm" style={{ flex: 1 }} />
        </Row>
      )}
      <View style={styles.handRow}>
        {!portrait && (
          <View style={{ width: plateW }}>
            {/* Grows upward so my avatar overlaps the rail instead of stealing height from the felt. */}
            <View style={[styles.myPlateCol, { width: plateW }]}>
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
          <View style={[styles.handTiles, portrait && { flexWrap: 'wrap', rowGap: 6, justifyContent: 'center' }]} accessibilityRole="list" accessibilityLabel={t('table.a11y.hand', { n: hand.length })}>
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
        </View>
        {!portrait && me.melds.length > 0 && (
          <View style={styles.myMelds}>
            {me.melds.map((m, i) => (
              <MeldView key={i} meld={m} size="sm" />
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  footer: { paddingHorizontal: 12, paddingBottom: 4, paddingTop: 2 },
  handRow: { flexDirection: 'row', alignItems: 'flex-end' },
  myPlateCol: { position: 'absolute', left: 0, bottom: 4, alignItems: 'center', gap: 4 },
  myFlowers: { flexDirection: 'row', flexWrap: 'wrap', gap: 1, justifyContent: 'center' },
  myMelds: { flexDirection: 'row', alignItems: 'flex-end', marginLeft: 10, paddingBottom: 7 },
  rack: { position: 'absolute', left: -6, right: -6, bottom: 0, backgroundColor: colors.rail, borderWidth: 3, borderColor: colors.ink, borderRadius: 10, overflow: 'hidden' },
  rackTop: { position: 'absolute', top: 0, left: 0, right: 0, height: 5, backgroundColor: colors.railLight },
  handTiles: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, paddingTop: 12, paddingBottom: 7, paddingHorizontal: 4 },
});
