import React, { useContext, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, G, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { PLACEHOLDER_TILE, WINDS, type Meld, type PlayerView, type TileId } from '@mjm/engine';
import type { SeatInfo } from '@mjm/net';
import { colors, fonts, nameFont } from '../theme';
import { TableThemeContext } from '../themes';
import { useT } from '../i18n';
import { Tile, type TileSize } from './Tile';
import { tileDims } from './tileDims';
import { pondRowsShown } from '../display/portraitFit';
import { AvatarPlate, seatAvatarId, type AvatarMood } from './Avatars';
import { Emote } from './Emotes';
import { SeatMotion, type SeatReaction } from './SeatMotion';
import { SlideIn } from './table/Motion';
import { FeltPattern } from './FeltPattern';
import { useTurnCountdown } from '../game/useTable';
import { clockUrgent, timerFraction, type TurnClock } from './table/turnClock';
import { reactionShouldPlay } from './table/feel';
import { slopFor } from './table/layout';
import { compassSentence, wallSentence, type Relation } from './table/hudSpeech';
import { CompassNotice } from './table/CompassNotice';
import { relLineExtra, relTagLabel, SEAT_TAG_CHROME, seatTagText, sideNameSize } from '../logic/seatName';
import { useDisplayScale } from '../display/DisplayScale';

/**
 * One meld: its tiles a pixel apart, the claimed one lying on its side. `flat` (the portrait felt's last stage,
 * display/portraitFit.ts): every tile upright and less room after the meld, so two share a narrow column.
 */
export function MeldView({ meld, size = 'sm', flat }: { meld: Meld; size?: TileSize | number; flat?: boolean }) {
  // Another seat's concealed kong arrives as placeholders until the hand ends: show all four face down.
  const unknown = meld.concealed && meld.tiles.every((t) => t === PLACEHOLDER_TILE);
  return (
    <View style={[styles.meld, flat && styles.meldFlat]}>
      {meld.tiles.map((t, i) => {
        const hidden = unknown || (meld.type === 'kong' && meld.concealed && (i === 0 || i === 3));
        return <Tile key={`${t}-${i}`} tile={t} size={size} faceDown={hidden} rotated={!flat && !meld.concealed && meld.claimed === t} />;
      })}
    </View>
  );
}

/** A seat's exposed melds and set-aside flowers, in one wrapping row. */
export function MeldsAndFlowers({ player, size = 'xs', flowerSize = 'xs', style, flat }: { player: PlayerView; size?: TileSize | number; flowerSize?: TileSize | number; style?: StyleProp<ViewStyle>; flat?: boolean }) {
  if (player.melds.length === 0 && player.flowers.length === 0) return null;
  return (
    <View style={[styles.meldRow, style]}>
      {player.melds.map((m, i) => (
        <MeldView key={i} meld={m} size={size} flat={flat} />
      ))}
      {player.flowers.length > 0 && (
        <View style={styles.flowers}>
          {player.flowers.map((f) => (
            <Tile key={f} tile={f} size={flowerSize} />
          ))}
        </View>
      )}
    </View>
  );
}

export function TileStrip({ tiles, size = 'xs', max = 20 }: { tiles: TileId[]; size?: TileSize; max?: number }) {
  const shown = tiles.slice(-max);
  return (
    <View style={styles.strip}>
      {shown.map((t) => (
        <Tile key={t} tile={t} size={size} />
      ))}
    </View>
  );
}

/**
 * The "+N" chip's text in a tile `w` px wide: "+12" on one line where it fits (a bold digit is about 0.62 of the font
 * size), else the "+" over the number, so the count is never cut to "+…" on the smallest tiles.
 */
export function earlierChip(earlier: number, w: number): { text: string; lines: 1 | 2; font: number } {
  const font = Math.max(8, Math.round(w * 0.45));
  const room = w - 3;
  return `+${earlier}`.length * font * 0.62 <= room ? { text: `+${earlier}`, lines: 1, font } : { text: `+\n${earlier}`, lines: 2, font };
}

/**
 * A seat's pond. The latest discard is ringed and, when `enterFrom` is given, slides in from that side. With `keepRows`
 * only the newest rows are drawn, after a "+N" chip that says how many earlier discards are not.
 */
export function DiscardPool({ tiles, size = 'xs', perRow = 8, latest, align = 'flex-start', enterFrom, keepRows, testID }: { tiles: TileId[]; size?: TileSize | number; perRow?: number; latest?: TileId; align?: 'flex-start' | 'center' | 'flex-end'; enterFrom?: { x: number; y: number }; keepRows?: number; testID?: string }) {
  const { t: tr } = useT();
  const { rows, earlier } = pondRowsShown(tiles, perRow, keepRows);
  const { w, h } = tileDims(size);
  const chip = earlierChip(earlier, w);
  return (
    <View style={{ gap: 2, alignItems: align }} testID={testID}>
      {rows.map((row, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 2 }}>
          {i === 0 && earlier > 0 && (
            <View style={[styles.earlier, { width: w, height: h, borderRadius: w * 0.17 }]} accessible accessibilityRole="text" accessibilityLabel={tr('table.a11y.pondEarlier', { n: earlier })} testID="pond-earlier">
              <Text style={[styles.earlierText, { fontSize: chip.font, lineHeight: chip.lines === 2 ? Math.round(chip.font * 1.1) : undefined }]} numberOfLines={chip.lines}>
                {chip.text}
              </Text>
            </View>
          )}
          {row.map((t) =>
            t === latest && enterFrom ? (
              <SlideIn key={t} from={enterFrom}>
                <Tile tile={t} size={size} highlight="wait" />
              </SlideIn>
            ) : (
              <Tile key={t} tile={t} size={size} highlight={t === latest ? 'wait' : undefined} />
            ),
          )}
        </View>
      ))}
    </View>
  );
}

/**
 * The seat's portrait with its timer ring. The ring counts the turn clock down here, so only this plate
 * re-renders every second, never the table around it.
 */
function SeatPlate({ clock, ...plate }: Omit<React.ComponentProps<typeof AvatarPlate>, 'timer' | 'timerUrgent'> & { clock: TurnClock | null }) {
  // My own plate counts my own clock (the turn, then the bank, as its own period); another seat's its deadline.
  const { left, bank, total, period } = useTurnCountdown(clock);
  const now = { deadline: period, total, bank };
  return <AvatarPlate {...plate} timer={clock ? timerFraction(left, now) : null} timerUrgent={clock ? clockUrgent(left, now) : false} />;
}

/** Avatar plate with name tag, score, dealer and wind badges, turn ring and emote bubble. */
export function SeatBadge({
  seat,
  info,
  player,
  dealerSeat,
  isTurn,
  score,
  compact,
  viewerSeat,
  size = 40,
  clock,
  emote,
  vertical,
  maxNameWidth = 110,
  reaction,
  onLongPress,
  onLongPressHint,
  frame,
  side,
}: {
  seat: number;
  info?: SeatInfo;
  player: PlayerView;
  dealerSeat: number;
  isTurn: boolean;
  score: number;
  compact?: boolean;
  viewerSeat: number;
  size?: number;
  /** This seat's turn clock while it is on the clock (the plate's ring counts it down on its own). */
  clock?: TurnClock | null;
  emote?: string;
  vertical?: boolean;
  maxNameWidth?: number;
  /** Latest table event for this seat (call-outs, win celebration, deal-in shake). */
  reaction?: SeatReaction;
  /** Long-press action on the portrait (online tables: report this player). */
  onLongPress?: () => void;
  onLongPressHint?: string;
  /** An owned avatar frame to draw round the portrait (the player's own seat). */
  frame?: string | null;
  /**
   * A landscape side seat, whose tag sits in a narrow column beside its plate: the tag keeps to two lines, the name
   * on one (drawn smaller when it must, `sideNameSize`) and the relation label and score on the other.
   */
  side?: boolean;
}) {
  const wind = WINDS[(seat - dealerSeat + 4) % 4];
  const rel = (seat - viewerSeat + 4) % 4;
  const { t } = useT();
  const relKey = rel === 0 ? 'me' : rel === 1 ? 'right' : rel === 2 ? 'across' : 'left';
  // One line, never broken inside 下家: the short form when the whole label does not fit the tag (the OS text size grows it).
  const { osScale } = useDisplayScale();
  const name = info?.name || t('table.seat', { n: seat + 1 });
  const offline = !!info && !info.connected && !info.isBot;
  const tagWidth = maxNameWidth - SEAT_TAG_CHROME;
  // A side seat's relation label shares its line with the score (and "offline"), so it is chosen to fit beside them.
  const relWidth = side ? tagWidth - relLineExtra(score, offline ? t('table.offline') : null, 11 * osScale) : tagWidth;
  const relLabel = relTagLabel(t(`table.relSeat.${relKey}`), t(`table.relSeatShort.${relKey}`), relWidth, 11 * osScale);
  // The size is in the style's units, which the OS text size then scales: measure at the scaled size, draw unscaled.
  const sideSize = side ? sideNameSize(name, tagWidth, 12 * osScale) : null;
  const nameSize = sideSize === null ? null : sideSize / osScale;
  // Win and deal-in reactions switch the portrait to its win/lose clip for a few seconds (if it has clips).
  const [mood, setMood] = useState<AvatarMood | null>(null);
  // The effect runs once per event (its key), not each time the table re-renders with a new object for the same one:
  // a re-run would clear the timer that brings the usual face back. It reads the event itself from this ref.
  const latestReaction = useRef(reaction);
  latestReaction.current = reaction;
  const reactionKey = reaction?.key;
  useEffect(() => {
    const reaction = latestReaction.current;
    // Only a fresh reaction: a plate remounted by a rotation or resize keeps its usual face.
    if (!reaction || !reactionShouldPlay(reaction, false, Date.now())) return;
    const m: AvatarMood | null = reaction.kind === 'win' || reaction.kind === 'selfdraw' ? 'win' : reaction.kind === 'dealin' ? 'lose' : null;
    if (!m) return;
    setMood(m);
    const id = setTimeout(() => setMood(null), 3200);
    return () => clearTimeout(id);
  }, [reactionKey]);
  void player;
  void compact;
  return (
    <View style={[styles.seat, vertical && styles.seatVertical]}>
      <Pressable onLongPress={onLongPress} disabled={!onLongPress} hitSlop={slopFor(size)} accessibilityRole={onLongPress ? 'button' : undefined} accessibilityLabel={name} accessibilityHint={onLongPress ? onLongPressHint : undefined}>
        <SeatMotion size={size} seat={seat} active={isTurn && !offline} reaction={reaction}>
          <SeatPlate clock={isTurn ? (clock ?? null) : null} id={seatAvatarId(info, seat)} size={size} active={isTurn} dealer={seat === dealerSeat} wind={wind} offline={offline} mood={mood} frame={frame} />
        </SeatMotion>
        {emote && (
          <View style={[styles.bubble, { left: size * 0.6, top: -size * 0.55 }]}>
            <Emote id={emote} size={Math.max(26, size * 0.7)} />
          </View>
        )}
      </Pressable>
      <View testID={side ? 'seat-tag-side' : 'seat-tag'} style={[styles.tag, vertical && { alignItems: 'center', marginTop: 2 }, { maxWidth: maxNameWidth }]}>
        {/* A name uses the tag's room and takes a second line rather than being cut (logic/seatName.ts); a side seat's stays on one line. */}
        <Text testID="seat-name" numberOfLines={nameSize === null ? 2 : 1} style={[styles.tagName, nameFont(name), vertical && { textAlign: 'center' }, nameSize !== null && { fontSize: nameSize }]}>
          {nameSize === null ? seatTagText(name, tagWidth) : name}
        </Text>
        <View testID="seat-row" style={[styles.tagRow, side && { flexWrap: 'nowrap' }]}>
          <Text testID="seat-rel" numberOfLines={1} style={styles.tagRel}>
            {relLabel}
          </Text>
          <Text style={[styles.tagScore, score < 0 && { color: '#FF9C9F' }]}>
            {score >= 0 ? '+' : ''}
            {score}
          </Text>
          {offline && <Text style={styles.offline}>{t('table.offline')}</Text>}
        </View>
      </View>
    </View>
  );
}

/**
 * The table itself: a chunky wood rail drawn around a radial felt. Children
 * are laid out inside the felt.
 */
export function FeltFrame({ children, rail = 11, style }: { children: React.ReactNode; rail?: number; style?: StyleProp<ViewStyle> }) {
  const theme = useContext(TableThemeContext);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const R = rail * 2.4;
  return (
    <View style={[{ flex: 1 }, style]} onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      {box && box.w > 0 && (
        <Svg width={box.w} height={box.h} style={StyleSheet.absoluteFill} pointerEvents="none">
          <Defs>
            <RadialGradient id="feltGlow" cx="50%" cy="46%" r="62%">
              <Stop offset="0" stopColor={theme.feltLight} />
              <Stop offset="0.55" stopColor={theme.felt} />
              <Stop offset="1" stopColor={theme.feltDark} />
            </RadialGradient>
            <LinearGradient id="railWood" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={theme.rail?.light ?? colors.railLight} />
              <Stop offset="0.5" stopColor={theme.rail?.mid ?? colors.rail} />
              <Stop offset="1" stopColor={theme.rail?.edge ?? colors.railEdge} />
            </LinearGradient>
          </Defs>
          {/* Shelf under the rail, then the rail itself */}
          <Rect x={1.5} y={4} width={box.w - 3} height={box.h - 5.5} rx={R} fill={theme.rail?.deep ?? colors.railDeep} stroke={colors.ink} strokeWidth={3} />
          <Rect x={1.5} y={1.5} width={box.w - 3} height={box.h - 6} rx={R} fill="url(#railWood)" stroke={colors.ink} strokeWidth={3} />
          <Path d={`M${R} ${4.5} H${box.w - R}`} stroke="#F4C38A" strokeWidth={2.5} strokeLinecap="round" opacity={0.9} />
          {/* Felt */}
          <Rect x={rail} y={rail} width={box.w - rail * 2} height={box.h - rail * 2 - 4.5} rx={R - rail * 0.6} fill="url(#feltGlow)" stroke={colors.ink} strokeWidth={2.5} />
          {theme.pattern && <FeltPattern pattern={theme.pattern} x={rail} y={rail} width={box.w - rail * 2} height={box.h - rail * 2 - 4.5} rx={R - rail * 0.6} color={theme.patternColor} />}
          <Rect x={rail + 3} y={rail + 3} width={box.w - rail * 2 - 6} height={box.h - rail * 2 - 10.5} rx={R - rail * 0.6 - 2} fill="none" stroke={theme.feltDark} strokeWidth={4} opacity={0.55} />
          {/* Felt emblem */}
          <G opacity={0.16}>
            <Circle cx={box.w / 2} cy={(box.h - 4.5) / 2} r={Math.min(box.w, box.h) * 0.3} fill="none" stroke="#FFFFFF" strokeWidth={3} />
            <Circle cx={box.w / 2} cy={(box.h - 4.5) / 2} r={Math.min(box.w, box.h) * 0.3 - 8} fill="none" stroke="#FFFFFF" strokeWidth={1.5} />
          </G>
          {/* Brass studs on the rail corners */}
          {[
            [rail * 0.5 + R * 0.35, rail * 0.5 + R * 0.35],
            [box.w - rail * 0.5 - R * 0.35, rail * 0.5 + R * 0.35],
            [rail * 0.5 + R * 0.35, box.h - 6 - rail * 0.5 - R * 0.35],
            [box.w - rail * 0.5 - R * 0.35, box.h - 6 - rail * 0.5 - R * 0.35],
          ].map(([x, y], i) => (
            <G key={i}>
              <Circle cx={x} cy={y} r={rail * 0.32} fill={theme.rail?.stud ?? colors.gold} stroke={colors.ink} strokeWidth={1.5} />
              <Circle cx={x - rail * 0.08} cy={y - rail * 0.08} r={rail * 0.11} fill="#FFFFFF" opacity={0.8} />
            </G>
          ))}
        </Svg>
      )}
      <View style={{ flex: 1, margin: rail + 3, marginBottom: rail + 7, overflow: 'hidden', borderRadius: R - rail }}>{children}</View>
    </View>
  );
}

/**
 * The live wall seen from above: a square of two-high stacks around the
 * centre (18 per side when full) that empties as tiles are drawn.
 */
export function WallRing({ remaining, size, children }: { remaining: number; size: number; children?: React.ReactNode }) {
  const theme = useContext(TableThemeContext);
  const perSide = 18;
  const tw = size / (perSide + 2.7);
  const th = tw * 1.35;
  const S = th * 2 + perSide * tw;
  const stacks = Math.max(0, Math.min(perSide * 4, Math.ceil(remaining / 2)));
  const cells: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (let i = 0; i < perSide; i++) cells.push({ x: th + i * tw, y: S - th, w: tw, h: th });
  for (let i = 0; i < perSide; i++) cells.push({ x: S - th, y: S - th - (i + 1) * tw, w: th, h: tw });
  for (let i = 0; i < perSide; i++) cells.push({ x: S - th - (i + 1) * tw, y: 0, w: tw, h: th });
  for (let i = 0; i < perSide; i++) cells.push({ x: 0, y: th + i * tw, w: th, h: tw });
  const sw = tw < 9 ? 0.9 : 1.3;
  return (
    <View style={{ width: S, height: S, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={S} height={S + 2} style={StyleSheet.absoluteFill} pointerEvents="none">
        <Rect x={th * 0.5} y={th * 0.5} width={S - th} height={S - th} rx={th * 0.6} fill="none" stroke="#FFFFFF" strokeOpacity={0.14} strokeWidth={th} />
        <Rect x={th + 2} y={th + 2} width={S - th * 2 - 4} height={S - th * 2 - 4} rx={th * 0.4} fill="#000000" fillOpacity={0.06} />
        {cells.slice(0, stacks).map((c, i) => (
          <G key={i}>
            <Rect x={c.x + 0.4} y={c.y + 0.4} width={c.w - 0.8} height={c.h - 0.8 + 1.8} rx={Math.min(c.w, c.h) * 0.22} fill={theme.tileEdge} stroke={colors.ink} strokeWidth={sw} />
            <Rect x={c.x + 0.4} y={c.y + 0.4} width={c.w - 0.8} height={c.h - 0.8} rx={Math.min(c.w, c.h) * 0.22} fill={theme.tileBack} stroke={colors.ink} strokeWidth={sw} />
            <Rect x={c.x + 1.6} y={c.y + 1.6} width={Math.max(0, c.w - 3.2)} height={Math.max(0, Math.min(2, c.h * 0.18))} fill="#FFFFFF" opacity={0.3} />
          </G>
        ))}
      </Svg>
      {children}
    </View>
  );
}

/**
 * Centre compass: prevailing wind and tiles left in the wall; each seat's wind
 * sits on its edge of the plate, and the seat whose turn it is glows gold.
 * A screen reader reads the plate as one item ("East round, you are South, the dealer is on your left.
 * 17 tiles left in the wall"), and the hidden live region beside it (./table/CompassNotice.tsx) speaks only
 * when the round or the seats turn or the wall drops to 10, 5 or its last tile.
 */
export function Compass({ prevailing, drawsLeft, seatWinds, active, size = 72, round, myWind, dealerRel }: { prevailing: string; drawsLeft: number; seatWinds: [string, string, string, string]; active: number | null; size?: number; round: number; myWind: number; dealerRel: Relation }) {
  // seatWinds / active are relative to the viewer: 0 = me (bottom), 1 = right, 2 = top, 3 = left.
  const { t } = useT();
  const b = Math.round(size * 0.32);
  const mid = (size - b) / 2 - 3;
  const pos: ViewStyle[] = [
    { bottom: -b / 2, left: mid },
    { right: -b / 2, top: mid },
    { top: -b / 2, left: mid },
    { left: -b / 2, top: mid },
  ];
  const compassText = compassSentence(t, { round, myWind, dealerRel });
  const wallText = wallSentence(t, drawsLeft);
  return (
    <>
      <View
        style={[styles.compass, { width: size, height: size, borderRadius: size * 0.26 }]}
        accessible
        accessibilityRole="image"
        accessibilityLabel={compassText + t('table.a11y.sentenceBreak') + wallText}
        testID="compass"
      >
        <View style={[styles.compassInner, { borderRadius: size * 0.2 }]} />
        <Text style={[styles.compassMain, { fontSize: size * 0.34, lineHeight: size * 0.42 }]}>{prevailing}</Text>
        <View style={styles.compassCountWrap}>
          <Text style={[styles.compassCount, { fontSize: Math.max(11, size * 0.17) }]}>{drawsLeft}</Text>
        </View>
        {seatWinds.map((w, i) => (
          <View key={i} pointerEvents="none" style={[styles.compassWind, pos[i], { width: b, height: b, borderRadius: b / 2 }, active === i && styles.compassWindOn]}>
            <Text style={[styles.compassWindText, { fontSize: b * 0.56 }, active === i && { color: colors.ink }]}>{w}</Text>
          </View>
        ))}
      </View>
      <CompassNotice facts={{ round, myWind, dealerRel, drawsLeft }} compassText={compassText} wallText={wallText} />
    </>
  );
}

const styles = StyleSheet.create({
  meld: { flexDirection: 'row', alignItems: 'flex-end', gap: 1, marginRight: 5 },
  // display/tableFit.ts FLAT_MELD_GAP.
  meldFlat: { marginRight: 3 },
  meldRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', rowGap: 3 },
  // Wraps inside a narrow column (a side seat with many flowers) instead of running out of it.
  flowers: { flexDirection: 'row', flexWrap: 'wrap', gap: 1, rowGap: 3, alignItems: 'flex-end', maxWidth: '100%' },
  strip: { flexDirection: 'row', flexWrap: 'wrap', gap: 2 },
  // In a pond's first place: earlier discards that are not drawn (a dark tile-sized chip, so the rows keep their shape).
  earlier: { backgroundColor: 'rgba(16,20,47,0.72)', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.55)', alignItems: 'center', justifyContent: 'center' },
  earlierText: { color: '#FFFFFF', fontWeight: '900', textAlign: 'center' },
  seat: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  seatVertical: { flexDirection: 'column', gap: 0 },
  tag: { backgroundColor: 'rgba(16,20,47,0.78)', borderWidth: 2, borderColor: colors.ink, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2, minWidth: 0 },
  tagName: { color: '#FFFFFF', fontSize: 12 },
  // The score wraps under the relation label rather than squeezing it onto two lines.
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 5 },
  tagRel: { color: '#B9C6E4', fontSize: 11, fontWeight: '900', flexShrink: 0 },
  tagScore: { color: colors.gold, fontFamily: fonts.display, fontSize: 12 },
  offline: { color: colors.danger, fontSize: 11, fontWeight: '900' },
  bubble: { position: 'absolute', backgroundColor: '#FFFFFF', borderWidth: 2.5, borderColor: colors.ink, borderRadius: 999, padding: 3, zIndex: 5 },
  compass: { backgroundColor: '#14204A', borderWidth: 3, borderColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  compassInner: { position: 'absolute', top: 4, left: 4, right: 4, bottom: 4, borderWidth: 1.5, borderColor: 'rgba(255,197,61,0.5)' },
  compassWind: { position: 'absolute', alignItems: 'center', justifyContent: 'center', backgroundColor: '#2A3A78', borderWidth: 2, borderColor: colors.ink },
  compassWindOn: { backgroundColor: colors.gold },
  compassWindText: { color: '#C9D4F5', fontWeight: '900' },
  compassMain: { color: colors.gold, fontWeight: '900' },
  compassCountWrap: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  compassCount: { color: '#FFFFFF', fontFamily: fonts.display },
});
