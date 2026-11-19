/**
 * The felt: three opponents (left, across, right) with their hands, melds and ponds, the compass and wall in
 * the middle, my pond and the claim buttons, and the coach in full under the right seat on tablets and tall landscape
 * screens (a phone has its bar under the felt in portrait, TableScreen.tsx, and above the hand in landscape, HandRail).
 * Geometry comes from ./layout.ts; in portrait nothing scrolls, and what gives way when the felt is short is
 * display/portraitFit.ts.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import type { Hint, PlayerView, TableView, TileId } from '@mjm/engine';
import { DiscardPool, FeltFrame, MeldsAndFlowers, SeatBadge, WallRing } from '../TableParts';
import { HiddenHand, scaledTile } from '../Tile';
import { tileDims } from '../tileDims';
import { useDisplayScale } from '../../display/DisplayScale';
import { fitPools, fitSideColumn, SIDE_GAP } from '../../display/tableFit';
import { CROSS_PAD, fitPortraitFelt } from '../../display/portraitFit';
import { Row } from '../Ui';
import { CoachPanel } from './CoachPanel';
import { slideFrom } from './feel';
import { compactCompassSize, dockHeight, landscapeWallSize, type ActionDock, type TableLayout } from './layout';

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
  onCoachMore,
  actions,
  dock = 'none',
  overlay,
  onShort,
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
  /** Opens the coach's sheet (the bar's "More"). */
  onCoachMore: () => void;
  /** The claim / discard buttons, docked just above my pond in landscape (portrait gives them a strip under the felt). */
  actions: React.ReactNode;
  /** What `actions` currently shows (nothing, the tap hint, or buttons): the dock makes room for it, never covering my pond. */
  dock?: ActionDock;
  /** Centre call-out and winner reveal, drawn over everything on the felt. */
  overlay?: React.ReactNode;
  /**
   * Portrait: the felt is too short even for what display/portraitFit.ts keeps at the least (each opponent's plate,
   * melds and newest row of discards, and my newest row). The table screen then gives the hand less height (smaller
   * tiles at Large and Extra-large).
   */
  onShort?: () => void;
}) {
  const { portrait, tablet, plate, sideWidth } = L;
  // Short landscape: the compass and my pond share the middle row (the action dock has a row of its own under it).
  const [columnH, setColumnH] = useState(0);
  const [pondH, setPondH] = useState(0);
  const centreDock = L.actions === 'center' ? dock : 'none';
  const dockH = dockHeight(centreDock, tablet);
  // Portrait: the felt's inner height, the opponents' plates and the status line, measured for the fit (portraitFit.ts).
  const [pBox, setPBox] = useState({ felt: 0, right: 0, left: 0, top: 0, status: 0 });
  const measureP = (key: 'felt' | 'right' | 'left' | 'top' | 'status') => (e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    setPBox((b) => (b[key] === h ? b : { ...b, [key]: h }));
  };
  // Settings → Display → Tiles grows the ponds and the opponents' melds (rows recomputed so they still fit).
  const { tileScale } = useDisplayScale();
  const pools = fitPools(L, tileScale);
  const { meldScale } = pools;
  const meldSize = (size: 'xs' | 'sm') => scaledTile(size, meldScale);
  // A side seat's kong (four tiles) must still fit its column.
  const sideMeld = meldScale === 1 ? 'xs' : Math.max(20, Math.min(Math.round(20 * meldScale), Math.floor(sideWidth / 4) - 1));
  const seatAt = (r: number) => (mySeat + r) % 4;
  const latestFor = (seat: number): TileId | undefined => (view.lastDiscard && view.lastDiscard.seat === seat ? view.lastDiscard.tile : undefined);
  const coach = coachOpen && hint ? hint : null;
  // Portrait: the felt fits its box (portraitFit.ts): the ring and the compass, the tile sizes, the rows of face-down
  // tiles, the older rows of each pond and then the melds' tiles lying on their side give way, in that order, as far as
  // they must.
  const seatOf = (r: number) => view.players[seatAt(r)];
  const portraitSeat = (r: number) => {
    const p = seatOf(r);
    return { melds: p.melds.map((m) => m.tiles.length), flowers: p.flowers.length, discards: p.discards.length, hand: p.handCount };
  };
  const topHandTile = tablet ? 15 : 9;
  const fit = fitPortraitFelt({
    felt: portrait ? pBox.felt : 0,
    sideW: sideWidth,
    // The cross is padded 6 px a side, so the centre column is that much narrower than layout.ts's centerW.
    centerW: L.centerW - 12,
    pondW: L.centerW + 2 * sideWidth,
    plates: { right: pBox.right, left: pBox.left, top: pBox.top },
    topHandH: (tablet ? 24 : 15) + 2,
    sideHandH: (tablet ? 22 : 15) + 2,
    status: status ? pBox.status || 20 : 0,
    right: portraitSeat(1),
    across: portraitSeat(2),
    left: portraitSeat(3),
    mine: view.players[mySeat].discards.length,
    pool: pools.tile,
    meld: tileDims(meldSize(tablet ? 'sm' : 'xs')).w,
    wallMax: L.wallSize,
    compass: L.compassSize,
  });
  const pool = portrait ? fit.pool : pools.tile;
  const centerPerRow = portrait ? fit.centerPerRow : pools.centerPerRow;
  const sidePerRow = portrait ? fit.sidePerRow : pools.sidePerRow;
  const myPerRow = pools.myPerRow;
  // Once per measured height: the table screen's answer (a smaller hand) changes the felt's height, which is
  // measured again before it is asked once more.
  const short = portrait && !fit.fits;
  const onShortRef = useRef(onShort);
  onShortRef.current = onShort;
  useEffect(() => {
    if (short) onShortRef.current?.();
  }, [short, pBox.felt]);

  const statusPill = status ? (
    <View style={styles.status} testID="table-status" onLayout={portrait ? measureP('status') : undefined}>
      <Text numberOfLines={1} style={styles.statusText}>
        {status}
      </Text>
    </View>
  ) : null;

  // Short landscape: when the centre column is short (large tiles, late in a hand, the claim buttons up), the across
  // seat gives way first, so my pond and the claim buttons keep their rows: its pond scrolls, kept at its newest
  // discards, down to one row (as a side seat's column does).
  const topPondScroll = useRef<React.ElementRef<typeof ScrollView> | null>(null);
  const [topPondH, setTopPondH] = useState(0);
  const topSeat = () => {
    const seat = seatAt(2);
    const p: PlayerView = view.players[seat];
    const pond = (portrait ? p.discards.length > 0 : true) && (
      <DiscardPool tiles={p.discards} size={pool} perRow={centerPerRow} align="center" latest={latestFor(seat)} enterFrom={slideFrom(2)} keepRows={portrait ? fit.keep.across : undefined} testID="pond-seat-2" />
    );
    const badge = <SeatBadge {...plateProps(seat)} size={plate} maxNameWidth={portrait ? 110 : 120} />;
    return (
      <View style={[styles.topSeat, L.compact && styles.topSeatCompact]} onLayout={(e) => setTopH(Math.round(e.nativeEvent.layout.height))}>
        {portrait ? (
          // Portrait: the plate, then its row of face-down tiles and its melds each on a line of their own (portraitFit.ts
          // stacks them with the column's gap), so they never run over the side plates.
          <>
            <View onLayout={measureP('top')} testID="plate-seat-2">
              {badge}
            </View>
            {/* Narrowed, as a side seat's, so the row fits the centre column. */}
            {fit.hands && <HiddenHand count={p.handCount} tileW={Math.max(5, Math.min(topHandTile, Math.floor((L.centerW - 18) / Math.max(1, p.handCount)) + 1))} tileH={tablet ? 24 : 15} />}
            <MeldsAndFlowers player={p} size={fit.meld} flowerSize={fit.meld} flat={fit.flat} style={styles.topMeldsPortrait} />
          </>
        ) : (
          <Row gap={10} style={styles.topRow}>
            {badge}
            <HiddenHand count={p.handCount} tileW={tablet ? 15 : 11} tileH={tablet ? 24 : 17} />
            {/* Landscape has the width for melds on the same line. */}
            <MeldsAndFlowers player={p} size={meldSize(tablet ? 'sm' : 'xs')} />
          </Row>
        )}
        {L.compact ? (
          <ScrollView
            ref={topPondScroll}
            style={[styles.topPond, { minHeight: Math.min(topPondH, tileDims(pool).h + 2) }]}
            contentContainerStyle={styles.topPondContent}
            showsVerticalScrollIndicator={false}
            testID="top-pond"
            onContentSizeChange={(_w, h) => {
              setTopPondH(Math.round(h));
              topPondScroll.current?.scrollToEnd({ animated: false });
            }}
          >
            {pond}
          </ScrollView>
        ) : (
          pond
        )}
      </View>
    );
  };

  // Landscape: a side seat's melds, flowers and pond share the short column under its plate. They shrink to fit
  // it (display/tableFit.ts fitSideSeat); if they still do not, the row of face-down tiles goes (its count is
  // what the melds leave of sixteen), and past that the column scrolls, kept at its end, where the newest
  // discards are. (Portrait scrolls the whole felt instead.)
  const [sideBox, setSideBox] = useState<Record<string, number>>({});
  const measure = (key: string) => (e: { nativeEvent: { layout: { height: number } } }) => {
    const h = Math.round(e.nativeEvent.layout.height);
    setSideBox((s) => (s[key] === h ? s : { ...s, [key]: h }));
  };
  const sideScroll = useRef<{ 1: React.ElementRef<typeof ScrollView> | null; 3: React.ElementRef<typeof ScrollView> | null }>({ 1: null, 3: null });
  const sideSeat = (r: 1 | 3) => {
    const seat = seatAt(r);
    const p = view.players[seat];
    const slim = Math.max(5, Math.min(11, Math.floor((sideWidth - 6) / Math.max(1, p.handCount)) + 1));
    const handH = tablet ? 22 : 15;
    // Portrait: the tag under the avatar keeps to two lines too (the name on one, its relation and score on the other).
    const badge = <SeatBadge {...plateProps(seat)} size={plate} vertical={portrait} side maxNameWidth={portrait ? sideWidth : sideWidth - plate - 12} />;
    const hidden = <HiddenHand count={p.handCount} tileW={slim} tileH={handH} />;
    const meldStyle = [{ maxWidth: sideWidth }, r === 1 ? { justifyContent: 'flex-end' as const } : undefined];
    const align = r === 1 ? 'flex-end' : 'flex-start';
    if (portrait) {
      return (
        <View style={[styles.sideSeat, { width: sideWidth }, r === 1 && { alignItems: 'flex-end' }]} key={seat}>
          <View onLayout={measureP(r === 1 ? 'right' : 'left')} testID={`plate-seat-${r}`}>{badge}</View>
          {fit.hands && hidden}
          <MeldsAndFlowers player={p} size={fit.meld} flowerSize={fit.meld} flat={fit.flat} style={meldStyle} />
          {p.discards.length > 0 && <DiscardPool tiles={p.discards} size={pool} perRow={sidePerRow} align={align} latest={latestFor(seat)} enterFrom={slideFrom(r)} keepRows={r === 1 ? fit.keep.right : fit.keep.left} testID={`pond-seat-${r}`} />}
        </View>
      );
    }
    const col = fitSideColumn({
      width: sideWidth,
      column: sideBox[`col${r}`] ?? 0,
      plate: sideBox[`plate${r}`] ?? 0,
      hand: p.handCount > 0 ? handH + 2 : 0,
      melds: p.melds.map((m) => m.tiles.length),
      flowers: p.flowers.length,
      discards: p.discards.length,
      meld: tileDims(sideMeld).w,
      pool: tileDims(pool).w,
    });
    const body = (
      <>
        <MeldsAndFlowers player={p} size={col.meld} flowerSize={col.meld} style={meldStyle} />
        <DiscardPool tiles={p.discards} size={col.pool} perRow={col.perRow} align={align} latest={latestFor(seat)} enterFrom={slideFrom(r)} testID={`pond-seat-${r}`} />
      </>
    );
    return (
      // The left seat is stretched by the felt's row; the right one shares a column with the coach and takes what is left of it.
      <View style={[styles.sideSeat, { width: sideWidth }, r === 1 && { alignItems: 'flex-end', flex: 1, minHeight: 0 }]} key={seat} onLayout={measure(`col${r}`)}>
        <View onLayout={measure(`plate${r}`)}>{badge}</View>
        {col.showHand && hidden}
        {col.scroll ? (
          <ScrollView
            ref={(el) => {
              sideScroll.current[r] = el;
            }}
            style={styles.sideBody}
            contentContainerStyle={[styles.sideBodyContent, { alignItems: align }]}
            testID={`side-seat-${r}`}
            onContentSizeChange={() => sideScroll.current[r]?.scrollToEnd({ animated: false })}
          >
            {body}
          </ScrollView>
        ) : (
          <View style={[styles.sideBodyContent, { alignItems: align }]} testID={`side-seat-${r}`}>
            {body}
          </View>
        )}
      </View>
    );
  };

  const myPond = (perRow: number, size: number = pool, keepRows?: number) => (
    <View testID="my-pond" onLayout={(e) => setPondH(Math.round(e.nativeEvent.layout.height))}>
      <DiscardPool tiles={view.players[mySeat].discards} size={size} perRow={perRow} align="center" latest={latestFor(mySeat)} enterFrom={slideFrom(0)} keepRows={keepRows} />
    </View>
  );
  const compassSize = L.compact ? compactCompassSize(columnH, L.compassSize) : L.compassSize;
  // Tablets in landscape: the ring takes what the across seat and my pond leave of the column (large tiles make
  // both taller), so my pond is never pushed off the bottom of the felt.
  const [topH, setTopH] = useState(0);
  const [centreH, setCentreH] = useState(0);
  const shownWall = portrait ? fit.wall : landscapeWallSize(centreH, topH, pondH, L.wallSize, L.compassSize + 16);
  // Portrait: the compass at the size the fit left it (0: it gave way), and the status line only where the fit kept it.
  const portraitCompass = fit.compass > 0 && fit.compass !== L.compassSize && React.isValidElement<{ size?: number }>(compass) ? React.cloneElement(compass, { size: fit.compass }) : compass;

  const centerColumn = (
    <View style={styles.centerCol} onLayout={(e) => setCentreH(Math.round(e.nativeEvent.layout.height))}>
      {topSeat()}
      {L.showWall ? (
        <>
          {(!portrait || fit.wall > 0 || fit.compass > 0 || fit.status) && (
            <View style={[styles.middle, { flexDirection: 'column', gap: 6 }]}>
              {shownWall > 0 ? (
                <WallRing remaining={view.tilesRemaining} size={shownWall}>
                  {portrait ? portraitCompass : compass}
                  {tablet && statusPill && (!portrait || fit.status) && <View style={{ marginTop: 22 }}>{statusPill}</View>}
                </WallRing>
              ) : portrait ? (
                fit.compass > 0 && portraitCompass
              ) : (
                compass
              )}
              {(!tablet || shownWall === 0) && (!portrait || fit.status) && statusPill}
            </View>
          )}
          {!portrait && myPond(centerPerRow)}
        </>
      ) : L.compact ? (
        // Short landscape: the compass sits beside my pond instead of above it, so my pond clears the hand rail.
        // The claim buttons get a row of their own under this one (below), so my pond moves up rather than being
        // covered, and the compass shrinks to the row that is left. (The coach is a bar above the hand: HandRail.)
        <View style={[styles.compactMiddle, { minHeight: pondH }]} testID="felt-centre" onLayout={(e) => setColumnH(Math.round(e.nativeEvent.layout.height))}>
          {compassSize > 0 && (
            <View style={{ alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 4 }}>
              {compassSize !== L.compassSize && React.isValidElement<{ size?: number }>(compass) ? React.cloneElement(compass, { size: compassSize }) : compass}
              {statusPill}
            </View>
          )}
          <View style={{ flex: 1, minWidth: 0, justifyContent: 'flex-end' }}>
            {/* My pond keeps the Normal size here: its row is the tightest on the felt (the opponents' ponds still grow). */}
            {tileScale > 1 ? myPond(L.myPerRow, tileDims(L.pool).w) : myPond(myPerRow)}
          </View>
        </View>
      ) : (
        <>
          <View style={styles.middle}>
            <View style={{ alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 8 }}>
              {compass}
              {statusPill}
            </View>
          </View>
          {myPond(centerPerRow)}
        </>
      )}
      {L.actions === 'center' &&
        (L.compact ? (
          // Short landscape: a row of its own under the compass and my pond (which moves up rather than being covered).
          dockH > 0 && (
            <View style={[styles.actionRow, { minHeight: dockH }]} pointerEvents="box-none" testID="action-dock">
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ alignSelf: 'stretch', flexGrow: 0 }} contentContainerStyle={styles.actionScroll}>
                {actions}
              </ScrollView>
            </View>
          )
        ) : (
          // Tablets and tall landscape: floating just above my pond, over the empty felt in the middle.
          <View style={[styles.actionCenter, { bottom: pondH + 4 }]} pointerEvents="box-none" testID="action-dock">
            {actions}
          </View>
        ))}
    </View>
  );

  return (
    <FeltFrame rail={L.rail} style={{ marginHorizontal: 8 }}>
      {portrait ? (
        // Nothing here scrolls: the seats fit the box (portraitFit.ts), with my pond pinned under them.
        <View style={styles.portraitFelt} testID="felt-portrait" onLayout={measureP('felt')}>
          <View style={[styles.cross, styles.portraitCross]} testID="felt-cross">
            {sideSeat(3)}
            {centerColumn}
            {sideSeat(1)}
          </View>
          <View style={styles.pinnedPond} testID="pinned-pond">
            {myPond(fit.myPerRow, fit.pool, fit.keep.mine)}
          </View>
        </View>
      ) : (
        <View style={styles.cross}>
          {sideSeat(3)}
          {centerColumn}
          <View style={{ gap: 8, flexShrink: 1 }}>
            {sideSeat(1)}
            {coach && L.coach === 'side' && (
              // The coach keeps its height (the right seat gives way); past most of the column it scrolls, with "More".
              <View style={{ width: sideWidth, flexShrink: 0 }}>
                <CoachPanel hint={coach} maxHeight={centreH > 0 ? Math.round(centreH * 0.62) : undefined} onOpen={onCoachMore} />
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
  // The fit keeps the seats inside (portraitFit.ts CROSS_PAD above and below them); anything past it (a measurement a
  // frame late) is cut at the felt, never drawn over my pond.
  portraitCross: { overflow: 'hidden', paddingVertical: CROSS_PAD },
  sideSeat: { gap: SIDE_GAP },
  sideBody: { flex: 1, minHeight: 0, alignSelf: 'stretch' },
  sideBodyContent: { gap: SIDE_GAP },
  centerCol: { flex: 1, alignItems: 'center', gap: 6, minWidth: 0 },
  topSeat: { alignItems: 'center', gap: 6, alignSelf: 'stretch' },
  topSeatCompact: { flexShrink: 1, minHeight: 0 },
  topPond: { flexGrow: 0, flexShrink: 1, alignSelf: 'stretch' },
  topPondContent: { alignItems: 'center' },
  topRow: { justifyContent: 'center', flexWrap: 'wrap', rowGap: 4, maxWidth: '100%' },
  topMeldsPortrait: { justifyContent: 'center', maxWidth: '100%' },
  compactMiddle: { flex: 1, flexDirection: 'row', alignSelf: 'stretch', gap: 6, minHeight: 0 },
  middle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, alignSelf: 'stretch', flexGrow: 1 },
  status: { backgroundColor: 'rgba(16,20,47,0.6)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2, maxWidth: 220 },
  statusText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
  actionCenter: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  // portraitFit.ts PINNED_POND_PAD.
  pinnedPond: { alignItems: 'center', paddingTop: 3, paddingBottom: 1 },
  portraitFelt: { flex: 1 },
  actionScroll: { flexGrow: 1, justifyContent: 'center', alignItems: 'flex-end' },
  actionRow: { alignSelf: 'stretch', alignItems: 'center', justifyContent: 'flex-end' },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 10, zIndex: 25 },
});
