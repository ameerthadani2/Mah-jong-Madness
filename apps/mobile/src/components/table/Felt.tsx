/**
 * The felt: three opponents (left, across, right) with their hands, melds and ponds, the compass and wall in
 * the middle, my pond and the claim buttons, and the coach where the layout puts it on the felt: pinned above my
 * pond in portrait, in full under the right seat on tablets (a landscape phone has it above the hand: HandRail).
 * Geometry comes from ./layout.ts.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Hint, PlayerView, TableView, TileId } from '@mjm/engine';
import { DiscardPool, FeltFrame, MeldsAndFlowers, SeatBadge, WallRing } from '../TableParts';
import { HiddenHand, scaledTile } from '../Tile';
import { tileDims } from '../tileDims';
import { useDisplayScale } from '../../display/DisplayScale';
import { fitPools, fitSideColumn, SIDE_GAP } from '../../display/tableFit';
import { Row } from '../Ui';
import { CoachBar, CoachPanel } from './CoachPanel';
import { slideFrom } from './feel';
import { coachBarLines, compactCompassSize, dockHeight, fitWallSize, landscapeWallSize, type ActionDock, type TableLayout } from './layout';

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
}) {
  const { portrait, tablet, plate, sideWidth } = L;
  // Short landscape: the compass and my pond share the middle row (the action dock has a row of its own under it).
  const [columnH, setColumnH] = useState(0);
  const [pondH, setPondH] = useState(0);
  const centreDock = L.actions === 'center' ? dock : 'none';
  const dockH = dockHeight(centreDock, tablet);
  // Portrait: the wall ring shrinks (or goes) so the felt's content fits its scroll view late in a hand.
  const [wallSize, setWallSize] = useState(L.wallSize);
  const [scrollBox, setScrollBox] = useState({ view: 0, content: 0 });
  useEffect(() => setWallSize(L.wallSize), [L.wallSize]);
  useEffect(() => {
    if (!portrait) return;
    setWallSize((w) => fitWallSize(w, scrollBox.content, scrollBox.view, L.wallSize, L.compassSize + 16));
  }, [portrait, scrollBox.content, scrollBox.view, L.wallSize, L.compassSize]);
  // Settings → Display → Tiles grows the ponds and the opponents' melds (rows recomputed so they still fit).
  const { tileScale } = useDisplayScale();
  const { tile: pool, centerPerRow, sidePerRow, myPerRow, meldScale } = fitPools(L, tileScale);
  const meldSize = (size: 'xs' | 'sm') => scaledTile(size, meldScale);
  // A side seat's kong (four tiles) must still fit its column.
  const sideMeld = meldScale === 1 ? 'xs' : Math.max(20, Math.min(Math.round(20 * meldScale), Math.floor(sideWidth / 4) - 1));
  const seatAt = (r: number) => (mySeat + r) % 4;
  const latestFor = (seat: number): TileId | undefined => (view.lastDiscard && view.lastDiscard.seat === seat ? view.lastDiscard.tile : undefined);
  const coach = coachOpen && hint ? hint : null;

  const statusPill = status ? (
    <View style={styles.status} testID="table-status">
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
    const pond = <DiscardPool tiles={p.discards} size={pool} perRow={centerPerRow} align="center" latest={latestFor(seat)} enterFrom={slideFrom(2)} />;
    return (
      <View style={[styles.topSeat, L.compact && styles.topSeatCompact]} onLayout={(e) => setTopH(Math.round(e.nativeEvent.layout.height))}>
        <Row gap={10} style={styles.topRow}>
          <SeatBadge {...plateProps(seat)} size={plate} maxNameWidth={portrait ? 110 : 120} />
          <HiddenHand count={p.handCount} tileW={tablet ? 15 : portrait ? 9 : 11} tileH={tablet ? 24 : portrait ? 15 : 17} />
          {/* Landscape has the width for melds on the same line; portrait gives them their own line so they never run over the side plates. */}
          {!portrait && <MeldsAndFlowers player={p} size={meldSize(tablet ? 'sm' : 'xs')} />}
        </Row>
        {portrait && <MeldsAndFlowers player={p} size={meldSize('xs')} style={styles.topMeldsPortrait} />}
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
    const badge = <SeatBadge {...plateProps(seat)} size={plate} vertical={portrait} side={!portrait} maxNameWidth={portrait ? sideWidth : sideWidth - plate - 12} />;
    const hidden = <HiddenHand count={p.handCount} tileW={slim} tileH={handH} />;
    const meldStyle = [{ maxWidth: sideWidth }, r === 1 ? { justifyContent: 'flex-end' as const } : undefined];
    const align = r === 1 ? 'flex-end' : 'flex-start';
    if (portrait) {
      return (
        <View style={[styles.sideSeat, { width: sideWidth }, r === 1 && { alignItems: 'flex-end' }]} key={seat}>
          {badge}
          {hidden}
          <MeldsAndFlowers player={p} size={sideMeld} style={meldStyle} />
          <DiscardPool tiles={p.discards} size={pool} perRow={sidePerRow} align={align} latest={latestFor(seat)} enterFrom={slideFrom(r)} />
        </View>
      );
    }
    const fit = fitSideColumn({
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
        <MeldsAndFlowers player={p} size={fit.meld} flowerSize={fit.meld} style={meldStyle} />
        <DiscardPool tiles={p.discards} size={fit.pool} perRow={fit.perRow} align={align} latest={latestFor(seat)} enterFrom={slideFrom(r)} />
      </>
    );
    return (
      // The left seat is stretched by the felt's row; the right one shares a column with the coach and takes what is left of it.
      <View style={[styles.sideSeat, { width: sideWidth }, r === 1 && { alignItems: 'flex-end', flex: 1, minHeight: 0 }]} key={seat} onLayout={measure(`col${r}`)}>
        <View onLayout={measure(`plate${r}`)}>{badge}</View>
        {fit.showHand && hidden}
        {fit.scroll ? (
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

  const myPond = (perRow: number, size: number = pool) => (
    <View testID="my-pond" onLayout={(e) => setPondH(Math.round(e.nativeEvent.layout.height))}>
      <DiscardPool tiles={view.players[mySeat].discards} size={size} perRow={perRow} align="center" latest={latestFor(mySeat)} enterFrom={slideFrom(0)} />
    </View>
  );
  // Portrait: my pond is pinned under the scrolling part of the felt, across its whole width, so it can never
  // scroll out of view late in a hand or at a large tile size (the opponents and the compass scroll instead).
  const pinnedPerRow = Math.max(centerPerRow, Math.min(12, Math.floor((L.centerW + 2 * sideWidth) / (pool + 2))));
  const compassSize = L.compact ? compactCompassSize(columnH, L.compassSize) : L.compassSize;
  // Tablets in landscape: the ring takes what the across seat and my pond leave of the column (large tiles make
  // both taller), so my pond is never pushed off the bottom of the felt.
  const [topH, setTopH] = useState(0);
  const [centreH, setCentreH] = useState(0);
  const shownWall = portrait ? wallSize : landscapeWallSize(centreH, topH, pondH, L.wallSize, L.compassSize + 16);

  const centerColumn = (
    <View style={styles.centerCol} onLayout={(e) => setCentreH(Math.round(e.nativeEvent.layout.height))}>
      {topSeat()}
      {L.showWall ? (
        <>
          <View style={[styles.middle, { flexDirection: 'column', gap: 6 }]}>
            {shownWall > 0 ? (
              <WallRing remaining={view.tilesRemaining} size={shownWall}>
                {compass}
                {tablet && statusPill && <View style={{ marginTop: 22 }}>{statusPill}</View>}
              </WallRing>
            ) : (
              compass
            )}
            {(!tablet || shownWall === 0) && statusPill}
          </View>
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
        <>
          <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.portraitBody}
          testID="felt-scroll"
          onLayout={(e) => {
            const v = Math.round(e.nativeEvent.layout.height);
            setScrollBox((b) => (b.view === v ? b : { ...b, view: v }));
          }}
          onContentSizeChange={(_w, h) => {
            const c = Math.round(h);
            setScrollBox((b) => (b.content === c ? b : { ...b, content: c }));
          }}
        >
          <View style={styles.cross}>
            {sideSeat(3)}
            {centerColumn}
            {sideSeat(1)}
          </View>
          </ScrollView>
          {/* Pinned with my pond under the scrolling part, so the coach can never be scrolled out of view. */}
          {coach && (
            <View style={styles.pinnedCoach}>
              <CoachBar hint={coach} lines={coachBarLines('pinned')} onOpen={onCoachMore} />
            </View>
          )}
          <View style={styles.pinnedPond}>{myPond(pinnedPerRow)}</View>
        </>
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
  portraitBody: { flexGrow: 1, paddingBottom: 8 },
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
  pinnedPond: { alignItems: 'center', paddingTop: 4, paddingBottom: 2 },
  pinnedCoach: { paddingHorizontal: 6, paddingTop: 4 },
  actionScroll: { flexGrow: 1, justifyContent: 'center', alignItems: 'flex-end' },
  actionRow: { alignSelf: 'stretch', alignItems: 'center', justifyContent: 'flex-end' },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 10, zIndex: 25 },
});
