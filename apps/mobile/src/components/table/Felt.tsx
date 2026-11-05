/**
 * The felt: three opponents (left, across, right) with their hands, melds and ponds, the compass and wall in
 * the middle, my pond, the coach bubble and the claim buttons. Geometry comes from ./layout.ts.
 */
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Hint, PlayerView, TableView, TileId } from '@mjm/engine';
import { DiscardPool, FeltFrame, MeldsAndFlowers, SeatBadge, WallRing } from '../TableParts';
import { HiddenHand, scaledTile } from '../Tile';
import { useDisplayScale } from '../../display/DisplayScale';
import { fitPools } from '../../display/tableFit';
import { Row } from '../Ui';
import { CoachPanel } from './CoachPanel';
import { slideFrom } from './feel';
import type { TableLayout } from './layout';

export type PlateProps = Omit<React.ComponentProps<typeof SeatBadge>, 'size' | 'vertical' | 'maxNameWidth'>;

export function Felt({
  view,
  mySeat,
  layout: L,
  plateProps,
  compass,
  status,
  hint,
  coachOpen,
  actions,
  overlay,
}: {
  view: TableView;
  mySeat: number;
  layout: TableLayout;
  plateProps: (seat: number) => PlateProps;
  compass: React.ReactNode;
  /** Status line under the compass (null when it is shown in the HUD, or there is nothing to say). */
  status: string | null;
  hint: Hint | null;
  coachOpen: boolean;
  /** The claim / discard buttons, docked over my pond in landscape (portrait gives them a strip under the felt). */
  actions: React.ReactNode;
  /** Centre call-out and winner reveal, drawn over everything on the felt. */
  overlay?: React.ReactNode;
}) {
  const { portrait, tablet, plate, sideWidth } = L;
  // Settings → Display → Tiles grows the ponds and the opponents' melds (rows recomputed so they still fit).
  const { tileScale } = useDisplayScale();
  const { tile: pool, centerPerRow, sidePerRow, myPerRow, meldScale } = fitPools(L, tileScale);
  const meldSize = (size: 'xs' | 'sm') => scaledTile(size, meldScale);
  // A side seat's kong (four tiles) must still fit its column.
  const sideMeld = meldScale === 1 ? 'xs' : Math.max(20, Math.min(Math.round(20 * meldScale), Math.floor(sideWidth / 4) - 1));
  const seatAt = (r: number) => (mySeat + r) % 4;
  const latestFor = (seat: number): TileId | undefined => (view.lastDiscard && view.lastDiscard.seat === seat ? view.lastDiscard.tile : undefined);
  const waitKinds = new Set(hint?.waits.map((w) => w.kind) ?? []);
  const coach = coachOpen && hint ? hint : null;

  const statusPill = status ? (
    <View style={styles.status} testID="table-status">
      <Text numberOfLines={1} style={styles.statusText}>
        {status}
      </Text>
    </View>
  ) : null;

  const topSeat = () => {
    const seat = seatAt(2);
    const p: PlayerView = view.players[seat];
    return (
      <View style={styles.topSeat}>
        <Row gap={10} style={styles.topRow}>
          <SeatBadge {...plateProps(seat)} size={plate} maxNameWidth={portrait ? 80 : 120} />
          <HiddenHand count={p.handCount} tileW={tablet ? 15 : portrait ? 9 : 11} tileH={tablet ? 24 : portrait ? 15 : 17} />
          {/* Landscape has the width for melds on the same line; portrait gives them their own line so they never run over the side plates. */}
          {!portrait && <MeldsAndFlowers player={p} size={meldSize(tablet ? 'sm' : 'xs')} />}
        </Row>
        {portrait && <MeldsAndFlowers player={p} size={meldSize('xs')} style={styles.topMeldsPortrait} />}
        <DiscardPool tiles={p.discards} size={pool} perRow={centerPerRow} align="center" latest={latestFor(seat)} enterFrom={slideFrom(2)} />
      </View>
    );
  };

  const sideSeat = (r: 1 | 3) => {
    const seat = seatAt(r);
    const p = view.players[seat];
    const slim = Math.max(5, Math.min(11, Math.floor((sideWidth - 6) / Math.max(1, p.handCount)) + 1));
    return (
      <View style={[styles.sideSeat, { width: sideWidth }, r === 1 && { alignItems: 'flex-end' }]} key={seat}>
        <SeatBadge {...plateProps(seat)} size={plate} vertical={portrait} maxNameWidth={portrait ? sideWidth : sideWidth - plate - 12} />
        <HiddenHand count={p.handCount} tileW={slim} tileH={tablet ? 22 : 15} />
        <MeldsAndFlowers player={p} size={sideMeld} style={[{ maxWidth: sideWidth }, r === 1 ? { justifyContent: 'flex-end' } : undefined]} />
        <DiscardPool tiles={p.discards} size={pool} perRow={sidePerRow} align={r === 1 ? 'flex-end' : 'flex-start'} latest={latestFor(seat)} enterFrom={slideFrom(r)} />
      </View>
    );
  };

  const myPond = (perRow: number) => <DiscardPool tiles={view.players[mySeat].discards} size={pool} perRow={perRow} align="center" latest={latestFor(mySeat)} enterFrom={slideFrom(0)} />;

  const centerColumn = (
    <View style={styles.centerCol}>
      {topSeat()}
      {L.showWall ? (
        <>
          <View style={[styles.middle, { flexDirection: 'column', gap: 6 }]}>
            <WallRing remaining={view.tilesRemaining} size={L.wallSize}>
              {compass}
              {tablet && statusPill && <View style={{ marginTop: 22 }}>{statusPill}</View>}
            </WallRing>
            {!tablet && statusPill}
          </View>
          {myPond(centerPerRow)}
        </>
      ) : L.compact ? (
        // Short landscape: the compass sits beside the coach and my pond instead of above them, so my pond
        // clears the hand rail; the coach is top-aligned and ends above the claim buttons docked over my pond.
        <View style={styles.compactMiddle}>
          <View style={{ alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 4 }}>
            {compass}
            {statusPill}
          </View>
          <View style={{ flex: 1, minWidth: 0, justifyContent: 'space-between', gap: 4 }}>
            {coach && L.coach === 'center' ? <CoachPanel hint={coach} waitKinds={waitKinds} compact lines={4} /> : <View />}
            {myPond(myPerRow)}
          </View>
        </View>
      ) : (
        <>
          <View style={styles.middle}>
            <View style={{ alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 8 }}>
              {compass}
              {statusPill}
            </View>
            {coach && L.coach === 'center' && <CoachPanel hint={coach} waitKinds={waitKinds} compact />}
          </View>
          {myPond(centerPerRow)}
        </>
      )}
      {L.actions === 'center' && (
        // Over my own pond: a claim decision never needs it, and the side opponents' ponds stay visible.
        <View style={styles.actionCenter} pointerEvents="box-none">
          {actions}
        </View>
      )}
    </View>
  );

  return (
    <FeltFrame rail={L.rail} style={{ marginHorizontal: 8 }}>
      {portrait ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.portraitBody}>
          <View style={styles.cross}>
            {sideSeat(3)}
            {centerColumn}
            {sideSeat(1)}
          </View>
          {coach && <CoachPanel hint={coach} waitKinds={waitKinds} compact />}
        </ScrollView>
      ) : (
        <View style={styles.cross}>
          {sideSeat(3)}
          {centerColumn}
          <View style={{ gap: 8, flexShrink: 1 }}>
            {sideSeat(1)}
            {coach && L.coach === 'side' && (
              <View style={{ width: sideWidth }}>
                <CoachPanel hint={coach} waitKinds={waitKinds} />
              </View>
            )}
          </View>
        </View>
      )}
      {overlay && (
        // Short screens: the call-out rides high, over the across seat, so the coach and the claim buttons stay readable.
        <View style={[styles.overlay, L.compact && { justifyContent: 'flex-start', paddingTop: 4 }]} pointerEvents="none">
          {overlay}
        </View>
      )}
    </FeltFrame>
  );
}

const styles = StyleSheet.create({
  cross: { flex: 1, flexDirection: 'row', gap: 8, padding: 6 },
  portraitBody: { flexGrow: 1, paddingBottom: 8 },
  sideSeat: { gap: 6 },
  centerCol: { flex: 1, alignItems: 'center', gap: 6, minWidth: 0 },
  topSeat: { alignItems: 'center', gap: 6, alignSelf: 'stretch' },
  topRow: { justifyContent: 'center', flexWrap: 'wrap', rowGap: 4, maxWidth: '100%' },
  topMeldsPortrait: { justifyContent: 'center', maxWidth: '100%' },
  compactMiddle: { flex: 1, flexDirection: 'row', alignSelf: 'stretch', gap: 6, minHeight: 0 },
  middle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, alignSelf: 'stretch', flexGrow: 1 },
  status: { backgroundColor: 'rgba(16,20,47,0.6)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2, maxWidth: 220 },
  statusText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
  actionCenter: { position: 'absolute', left: 0, right: 0, bottom: 2, alignItems: 'center' },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 10, zIndex: 25 },
});
