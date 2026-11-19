/**
 * The felt: three opponents (left, across, right) with their hands, melds and ponds, the compass and wall in
 * the middle, my pond and the claim buttons, and the coach in full under the right seat on tablets and tall landscape
 * screens (a phone has its bar under the felt in portrait, TableScreen.tsx, and above the hand in landscape, HandRail).
 * Geometry comes from ./layout.ts; in portrait nothing scrolls, and what gives way when the felt is short is
 * display/portraitFit.ts. Each opponent's seat is one button that opens the table's discards (`onSeatPress`,
 * DiscardsSheet.tsx), so what the felt has no room for is one tap away.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import type { Hint, PlayerView, TableView, TileId } from '@mjm/engine';
import { DiscardPool, FeltFrame, MeldsAndFlowers, SeatBadge, WallRing } from '../TableParts';
import { HiddenHand, scaledTile } from '../Tile';
import { tileDims } from '../tileDims';
import { useDisplayScale } from '../../display/DisplayScale';
import { useT } from '../../i18n';
import { COMPACT_GAP, COMPACT_TOP_MELD, compactTopMeld, fitCompactCentre, fitPools, fitSideColumn, SIDE_GAP } from '../../display/tableFit';
import { CROSS_PAD, fitPortraitFelt, portraitDealFits } from '../../display/portraitFit';
import { CoachPanel } from './CoachPanel';
import { slideFrom } from './feel';
import { compactCompassSize, dockHeight, landscapeWallSize, type ActionDock, type TableLayout } from './layout';

export type PlateProps = Omit<React.ComponentProps<typeof SeatBadge>, 'size' | 'vertical' | 'maxNameWidth'>;

/** An opponent's seat as one button: what a screen reader hears, and what a tap and a long press do. */
interface SeatButton {
  label: string;
  hint: string;
  onPress: () => void;
  onLongPress?: () => void;
}

/**
 * An opponent's seat on the felt (its plate, melds and pond): with `button`, one button that opens the table's discards
 * (DiscardsSheet.tsx, this seat first), so the discards a small felt keeps behind its "+N" chip are one tap away; on an
 * online table a long press on it reports the player (the plate's own long press moves here, so no button is inside
 * another). Without `button`, a plain view.
 */
const SeatBox = React.forwardRef<React.ElementRef<typeof View>, { button: SeatButton | null; style?: StyleProp<ViewStyle>; onLayout?: (e: LayoutChangeEvent) => void; testID?: string; children: React.ReactNode }>(function SeatBox({ button, style, onLayout, testID, children }, ref) {
  if (!button)
    return (
      <View ref={ref} style={style} onLayout={onLayout} testID={testID}>
        {children}
      </View>
    );
  return (
    <Pressable
      ref={ref}
      onPress={button.onPress}
      onLongPress={button.onLongPress}
      accessibilityRole="button"
      accessibilityLabel={button.label}
      accessibilityHint={button.hint}
      style={({ pressed }) => [style, pressed && styles.seatPressed]}
      onLayout={onLayout}
      testID={testID}
    >
      {children}
    </Pressable>
  );
});

/** Landscape: the gap between the across seat's plate and its melds. */
const TOP_ROW_GAP = 10;
/** The status line under the compass: at most this wide, and never wider than the centre column. */
const STATUS_MAX_W = 220;

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
  leftSeatEnd = null,
  onSeatPress,
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
   * melds and newest row of discards, and my newest row), now or, from the deal, for a middle game (portraitDealFits). The
   * table screen then gives the hand less height (smaller tiles at Large and Extra-large), and says so.
   */
  onShort?: () => void;
  /**
   * Landscape at Normal tiles: where my plate column, growing up from the hand rail over the felt's corner, starts (a
   * window y: HandRail `onPlateTop`). The left seat's column ends 4 px above it, so my flowers never cover its discards.
   */
  leftSeatEnd?: number | null;
  /** A tap on an opponent's seat (1 right, 2 across, 3 left, relative to mine): the table opens its discards sheet. */
  onSeatPress?: (rel: 1 | 2 | 3) => void;
}) {
  const { t } = useT();
  const { portrait, tablet, plate, sideWidth } = L;
  // Short landscape: the compass and my pond share the middle row (the action dock has a row of its own under it).
  const [columnH, setColumnH] = useState(0);
  const [pondH, setPondH] = useState(0);
  // Short landscape: the dock's width, which the claim row is drawn to fit (ActionBar `maxWidth`: it never scrolls a button out of view).
  const [dockW, setDockW] = useState(0);
  const centreDock = L.actions === 'center' ? dock : 'none';
  const dockH = dockHeight(centreDock, tablet, L.compact);
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
  // Each opponent's seat is one button (SeatBox) that opens the discards sheet; it carries the plate's long press too.
  const seatButton = (r: 1 | 2 | 3): SeatButton | null => {
    if (!onSeatPress) return null;
    const seat = seatAt(r);
    const props = plateProps(seat);
    const offline = !!props.info && !props.info.connected && !props.info.isBot;
    const label = t('table.a11y.seatButton', {
      name: props.info?.name || t('table.seat', { n: seat + 1 }),
      rel: t(`table.relSeatShort.${r === 1 ? 'right' : r === 2 ? 'across' : 'left'}`),
      score: `${props.score >= 0 ? '+' : ''}${props.score}`,
      count: view.players[seat].discards.length,
    });
    const brk = t('table.a11y.sentenceBreak');
    return {
      label: offline ? `${label}${brk}${t('table.offline')}` : label,
      hint: props.onLongPress && props.onLongPressHint ? `${t('table.a11y.seatHint')}${brk}${props.onLongPressHint}` : t('table.a11y.seatHint'),
      onPress: () => onSeatPress(r),
      onLongPress: props.onLongPress,
    };
  };
  // The plate's own props: no long press of its own when its seat is the button that carries it.
  const plateFor = (seat: number): PlateProps => (onSeatPress ? { ...plateProps(seat), onLongPress: undefined, onLongPressHint: undefined } : plateProps(seat));
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

  // The centre column's width, measured: the status line keeps inside it (a long "X discarded Y" on a 360 px phone ran
  // over the left seat's newest discards), and in short landscape it sets the across seat's meld size (below).
  const [centreW, setCentreW] = useState(0);
  const statusPill = status ? (
    <View style={[styles.status, centreW > 0 && { maxWidth: Math.min(STATUS_MAX_W, centreW) }]} testID="table-status" onLayout={portrait ? measureP('status') : undefined}>
      <Text numberOfLines={1} style={styles.statusText}>
        {status}
      </Text>
    </View>
  ) : null;

  // Short landscape: the across seat's plate row and its plate, measured for fitCompactCentre (display/tableFit.ts), and the
  // column's width, which with the plate's sets the size that keeps its melds on the plate's line (compactTopMeld).
  const [compactTopRow, setCompactTopRow] = useState(0);
  const [compactPlate, setCompactPlate] = useState({ w: 0, h: 0 });
  const topSeat = () => {
    const seat = seatAt(2);
    const p: PlayerView = view.players[seat];
    const pond = (portrait ? p.discards.length > 0 : true) && (
      <DiscardPool tiles={p.discards} size={pool} perRow={centerPerRow} align="center" latest={latestFor(seat)} enterFrom={slideFrom(2)} keepRows={portrait ? fit.keep.across : undefined} testID="pond-seat-2" />
    );
    const badge = <SeatBadge {...plateFor(seat)} size={plate} maxNameWidth={portrait ? 110 : 120} />;
    return (
      <SeatBox button={seatButton(2)} style={[styles.topSeat, L.compact && styles.topSeatCompact]} onLayout={(e) => setTopH(Math.round(e.nativeEvent.layout.height))} testID="seat-press-2">
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
          // Landscape has the width for melds on the same line. Short landscape leaves out the row of face-down tiles (what
          // the seat holds is what its melds leave of sixteen): on a 568 px phone it took a line of its own.
          // Its row is measured with the melds in it: not while they give way (hideTopMelds), so the fit's answer holds.
          <View style={styles.topRow} onLayout={L.compact && !compactFit.hideTopMelds ? (e) => setCompactTopRow(Math.round(e.nativeEvent.layout.height)) : undefined}>
            {L.compact ? <View onLayout={(e) => setCompactPlate({ w: Math.round(e.nativeEvent.layout.width), h: Math.round(e.nativeEvent.layout.height) })}>{badge}</View> : badge}
            {!L.compact && <HiddenHand count={p.handCount} tileW={tablet ? 15 : 11} tileH={tablet ? 24 : 17} />}
            {!(L.compact && compactFit.hideTopMelds) && <MeldsAndFlowers player={p} size={L.compact ? topMeld : meldSize(tablet ? 'sm' : 'xs')} flowerSize={L.compact ? topMeld : 'xs'} />}
          </View>
        )}
        {L.compact ? (
          // Short landscape: its newest rows that fit above my row and the buttons (fitCompactCentre), never under them.
          p.discards.length > 0 && (
            <View testID="top-pond">
              <DiscardPool tiles={p.discards} size={compactFit.acrossTile} perRow={compactTop.perRow} align="center" latest={latestFor(seat)} enterFrom={slideFrom(2)} keepRows={compactFit.keepAcross} testID="pond-seat-2" />
            </View>
          )
        ) : (
          pond
        )}
      </SeatBox>
    );
  };

  // Landscape: a side seat's melds, flowers and pond share the short column under its plate. They shrink to fit
  // it (display/tableFit.ts fitSideSeat); if they still do not, the row of face-down tiles goes (its count is
  // what the melds leave of sixteen), then the pond keeps its newest rows under the melds, which stay whole, and
  // only past that does the column scroll, kept at its end, where the newest discards are.
  const [sideBox, setSideBox] = useState<Record<string, number>>({});
  const measure = (key: string) => (e: { nativeEvent: { layout: { height: number } } }) => {
    const h = Math.round(e.nativeEvent.layout.height);
    setSideBox((s) => (s[key] === h ? s : { ...s, [key]: h }));
  };
  const sideScroll = useRef<{ 1: React.ElementRef<typeof ScrollView> | null; 3: React.ElementRef<typeof ScrollView> | null }>({ 1: null, 3: null });
  // Landscape: the left seat's column, measured in the window against my plate column's top (leftSeatEnd). Its padding
  // keeps its discards above my flowers; its outer box, and so this measure, does not change with it.
  const leftRef = useRef<React.ElementRef<typeof View>>(null);
  const [leftBottom, setLeftBottom] = useState<number | null>(null);
  const leftClear = !portrait && leftSeatEnd !== null && leftBottom !== null ? Math.max(0, leftBottom - leftSeatEnd + 4) : 0;
  const onLeftLayout = (e: LayoutChangeEvent) => {
    measure('col3')(e);
    leftRef.current?.measureInWindow((_x, y, _w, h) => {
      if (h > 0) setLeftBottom(Math.round(y + h));
    });
  };
  const sideSeat = (r: 1 | 3) => {
    const seat = seatAt(r);
    const p = view.players[seat];
    const slim = Math.max(5, Math.min(11, Math.floor((sideWidth - 6) / Math.max(1, p.handCount)) + 1));
    const handH = tablet ? 22 : 15;
    // Portrait: the tag under the avatar keeps to two lines too (the name on one, its relation and score on the other).
    const badge = <SeatBadge {...plateFor(seat)} size={plate} vertical={portrait} side maxNameWidth={portrait ? sideWidth : sideWidth - plate - 12} />;
    const hidden = <HiddenHand count={p.handCount} tileW={slim} tileH={handH} />;
    const meldStyle = [{ maxWidth: sideWidth }, r === 1 ? { justifyContent: 'flex-end' as const } : undefined];
    const align = r === 1 ? 'flex-end' : 'flex-start';
    if (portrait) {
      return (
        <SeatBox button={seatButton(r)} style={[styles.sideSeat, { width: sideWidth }, r === 1 && { alignItems: 'flex-end' }]} key={seat} testID={`seat-press-${r}`}>
          <View onLayout={measureP(r === 1 ? 'right' : 'left')} testID={`plate-seat-${r}`}>{badge}</View>
          {fit.hands && hidden}
          <MeldsAndFlowers player={p} size={fit.meld} flowerSize={fit.meld} flat={fit.flat} style={meldStyle} />
          {p.discards.length > 0 && <DiscardPool tiles={p.discards} size={pool} perRow={sidePerRow} align={align} latest={latestFor(seat)} enterFrom={slideFrom(r)} keepRows={r === 1 ? fit.keep.right : fit.keep.left} testID={`pond-seat-${r}`} />}
        </SeatBox>
      );
    }
    const col = fitSideColumn({
      width: sideWidth,
      column: Math.max(0, (sideBox[`col${r}`] ?? 0) - (r === 3 ? leftClear : 0)),
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
        <MeldsAndFlowers player={p} size={col.meld} flowerSize={col.meld} flat={col.flat} style={meldStyle} />
        <DiscardPool tiles={p.discards} size={col.pool} perRow={col.perRow} align={align} latest={latestFor(seat)} enterFrom={slideFrom(r)} keepRows={col.keep} testID={`pond-seat-${r}`} />
      </>
    );
    return (
      // The left seat is stretched by the felt's row; the right one shares a column with the coach and takes what is left of it.
      <SeatBox
        button={seatButton(r)}
        ref={r === 3 ? leftRef : undefined}
        style={[styles.sideSeat, { width: sideWidth }, r === 1 && { alignItems: 'flex-end', flex: 1, minHeight: 0 }, r === 3 && leftClear > 0 && { paddingBottom: leftClear }]}
        key={seat}
        onLayout={r === 3 ? onLeftLayout : measure(`col${r}`)}
        testID={`seat-press-${r}`}
      >
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
      </SeatBox>
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
  // Short landscape: what of the two ponds fits above the buttons, and whether the buttons take my row's place.
  // My pond keeps the Normal size here (its row is the tightest on the felt; the opponents' ponds still grow).
  const myCompact = tileScale > 1 ? { perRow: L.myPerRow, tile: tileDims(L.pool).w } : { perRow: myPerRow, tile: tileDims(pool).w };
  // The across seat's pond keeps the Normal size here too: with its plate row, my row and the buttons it shares a column
  // of 120 to 160 px on a 568 px phone (the side seats' ponds still grow).
  const compactTop = { tile: tileDims(L.pool).w, perRow: L.centerPerRow };
  const across = seatOf(2);
  const topMeld = centreW > 0 && compactPlate.w > 0 ? compactTopMeld(centreW - compactPlate.w - TOP_ROW_GAP, across.melds.map((m) => m.tiles.length), across.flowers.length) : COMPACT_TOP_MELD;
  const compactFit = fitCompactCentre({
    column: L.compact ? centreH : 0,
    topRow: compactTopRow,
    plate: compactPlate.h,
    dock: L.compact ? dockH : 0,
    across: { discards: seatOf(2).discards.length, perRow: compactTop.perRow, tile: compactTop.tile },
    mine: { discards: view.players[mySeat].discards.length, perRow: myCompact.perRow, tile: myCompact.tile },
  });
  const swapped = L.compact && compactFit.swap && dockH > 0;
  // Once per measured height: the table screen's answer (a smaller hand) changes the felt's height, which is
  // measured again before it is asked once more. In portrait also from the deal, where the felt cannot hold a middle game
  // even at the least sizes (portraitDealFits), so the hand does not drop a size a turn or two in.
  const dealFits = portraitDealFits({ felt: pBox.felt, sideW: sideWidth, plates: { right: pBox.right, left: pBox.left, top: pBox.top } });
  const short = portrait ? !fit.fits || !dealFits : L.compact && !compactFit.fits;
  const onShortRef = useRef(onShort);
  onShortRef.current = onShort;
  useEffect(() => {
    if (short) onShortRef.current?.();
  }, [short, pBox.felt, centreH]);
  // Portrait: the compass at the size the fit left it (0: it gave way), and the status line only where the fit kept it.
  const portraitCompass = fit.compass > 0 && fit.compass !== L.compassSize && React.isValidElement<{ size?: number }>(compass) ? React.cloneElement(compass, { size: fit.compass }) : compass;

  const centerColumn = (
    <View
      style={[styles.centerCol, L.compact && { gap: COMPACT_GAP }]}
      testID="centre-col"
      onLayout={(e) => {
        setCentreH(Math.round(e.nativeEvent.layout.height));
        setCentreW(Math.floor(e.nativeEvent.layout.width));
      }}
    >
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
        // While the buttons are up and the column is too short for both, they take this row's place (`swapped`): my pond
        // is not drawn under them and comes back when they go.
        !swapped && (
          <View style={[styles.compactMiddle, { minHeight: compactFit.mineH }]} testID="felt-centre" onLayout={(e) => setColumnH(Math.round(e.nativeEvent.layout.height))}>
            {compassSize > 0 && (
              <View style={{ alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 4 }}>
                {compassSize !== L.compassSize && React.isValidElement<{ size?: number }>(compass) ? React.cloneElement(compass, { size: compassSize }) : compass}
                {statusPill}
              </View>
            )}
            <View style={{ flex: 1, minWidth: 0, justifyContent: 'flex-end' }}>{myPond(myCompact.perRow, myCompact.tile, compactFit.keepMine)}</View>
          </View>
        )
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
          // Short landscape: a row of its own under the compass and my pond (which moves up rather than being covered), or
          // in my row's place while it is up when the column has no room for both.
          dockH > 0 && (
            <View style={[styles.actionRow, { minHeight: dockH }, swapped && { flex: 1, justifyContent: 'center' }]} pointerEvents="box-none" testID="action-dock">
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ alignSelf: 'stretch', flexGrow: 0 }} contentContainerStyle={styles.actionScroll} onLayout={(e) => setDockW(Math.floor(e.nativeEvent.layout.width))}>
                {dockW > 0 && React.isValidElement<{ maxWidth?: number }>(actions) ? React.cloneElement(actions, { maxWidth: dockW }) : actions}
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
  seatPressed: { opacity: 0.85 },
  sideBody: { flex: 1, minHeight: 0, alignSelf: 'stretch' },
  sideBodyContent: { gap: SIDE_GAP },
  centerCol: { flex: 1, alignItems: 'center', gap: 6, minWidth: 0 },
  topSeat: { alignItems: 'center', gap: 6, alignSelf: 'stretch' },
  // Short landscape: its blocks stack COMPACT_GAP apart, and what does not fit is cut here, never drawn under the buttons.
  topSeatCompact: { gap: COMPACT_GAP, flexShrink: 1, minHeight: 0, overflow: 'hidden' },
  // Gaps set one by one: react-native-web lets a `gap` win over a `rowGap` given with it.
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', columnGap: TOP_ROW_GAP, rowGap: 4, maxWidth: '100%' },
  topMeldsPortrait: { justifyContent: 'center', maxWidth: '100%' },
  compactMiddle: { flex: 1, flexDirection: 'row', alignSelf: 'stretch', gap: 6, minHeight: 0 },
  middle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, alignSelf: 'stretch', flexGrow: 1 },
  status: { backgroundColor: 'rgba(16,20,47,0.6)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2, maxWidth: STATUS_MAX_W },
  statusText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
  actionCenter: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  // portraitFit.ts PINNED_POND_PAD.
  pinnedPond: { alignItems: 'center', paddingTop: 3, paddingBottom: 1 },
  portraitFelt: { flex: 1 },
  actionScroll: { flexGrow: 1, justifyContent: 'center', alignItems: 'flex-end' },
  actionRow: { alignSelf: 'stretch', alignItems: 'center', justifyContent: 'flex-end' },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 10, zIndex: 25 },
});
