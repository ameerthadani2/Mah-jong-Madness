import React, { useContext, useEffect, useState } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, G, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { WINDS, type Meld, type PlayerView, type TileId } from '@mjm/engine';
import type { SeatInfo } from '@mjm/net';
import { colors, fonts, nameFont } from '../theme';
import { TableThemeContext } from '../themes';
import { Tile, type TileSize } from './Tile';
import { AvatarPlate, seatAvatarId, type AvatarMood } from './Avatars';
import { Emote } from './Emotes';
import { SeatMotion, type SeatReaction } from './SeatMotion';

export function MeldView({ meld, size = 'sm' }: { meld: Meld; size?: TileSize | number }) {
  return (
    <View style={styles.meld}>
      {meld.tiles.map((t, i) => {
        const hidden = meld.type === 'kong' && meld.concealed && (i === 0 || i === 3);
        return <Tile key={t} tile={t} size={size} faceDown={hidden} rotated={!meld.concealed && meld.claimed === t} />;
      })}
    </View>
  );
}

/** A seat's exposed melds and set-aside flowers, in one wrapping row. */
export function MeldsAndFlowers({ player, size = 'xs', flowerSize = 'xs', style }: { player: PlayerView; size?: TileSize | number; flowerSize?: TileSize | number; style?: StyleProp<ViewStyle> }) {
  if (player.melds.length === 0 && player.flowers.length === 0) return null;
  return (
    <View style={[styles.meldRow, style]}>
      {player.melds.map((m, i) => (
        <MeldView key={i} meld={m} size={size} />
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

export function DiscardPool({ tiles, size = 'xs', perRow = 8, latest, align = 'flex-start' }: { tiles: TileId[]; size?: TileSize | number; perRow?: number; latest?: TileId; align?: 'flex-start' | 'center' | 'flex-end' }) {
  const rows: TileId[][] = [];
  const n = Math.max(1, perRow);
  for (let i = 0; i < tiles.length; i += n) rows.push(tiles.slice(i, i + n));
  return (
    <View style={{ gap: 2, alignItems: align }}>
      {rows.map((row, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 2 }}>
          {row.map((t) => (
            <Tile key={t} tile={t} size={size} highlight={t === latest ? 'wait' : undefined} />
          ))}
        </View>
      ))}
    </View>
  );
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
  timer,
  timerUrgent,
  emote,
  vertical,
  maxNameWidth = 110,
  reaction,
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
  timer?: number | null;
  timerUrgent?: boolean;
  emote?: string;
  vertical?: boolean;
  maxNameWidth?: number;
  /** Latest table event for this seat (call-outs, win celebration, deal-in shake). */
  reaction?: SeatReaction;
}) {
  const wind = WINDS[(seat - dealerSeat + 4) % 4];
  const rel = (seat - viewerSeat + 4) % 4;
  const relLabel = rel === 0 ? '你' : rel === 1 ? '下家' : rel === 2 ? '對家' : '上家';
  const name = info?.name || `Seat ${seat + 1}`;
  const offline = !!info && !info.connected && !info.isBot;
  // Win and deal-in reactions switch the portrait to its win/lose clip for a few seconds (if it has clips).
  const [mood, setMood] = useState<AvatarMood | null>(null);
  useEffect(() => {
    if (!reaction) return;
    const m: AvatarMood | null = reaction.kind === 'win' || reaction.kind === 'selfdraw' ? 'win' : reaction.kind === 'dealin' ? 'lose' : null;
    if (!m) return;
    setMood(m);
    const t = setTimeout(() => setMood(null), 3200);
    return () => clearTimeout(t);
  }, [reaction?.key]);
  void player;
  void compact;
  return (
    <View style={[styles.seat, vertical && styles.seatVertical]}>
      <View>
        <SeatMotion size={size} seat={seat} active={isTurn && !offline} reaction={reaction}>
          <AvatarPlate id={seatAvatarId(info, seat)} size={size} active={isTurn} timer={isTurn ? timer : null} timerUrgent={timerUrgent} dealer={seat === dealerSeat} wind={wind} offline={offline} mood={mood} />
        </SeatMotion>
        {emote && (
          <View style={[styles.bubble, { left: size * 0.6, top: -size * 0.55 }]}>
            <Emote id={emote} size={Math.max(26, size * 0.7)} />
          </View>
        )}
      </View>
      <View style={[styles.tag, vertical && { alignItems: 'center', marginTop: 4 }, { maxWidth: maxNameWidth }]}>
        <Text numberOfLines={1} style={[styles.tagName, nameFont(name)]}>
          {name}
        </Text>
        <View style={styles.tagRow}>
          <Text style={styles.tagRel}>{relLabel}</Text>
          <Text style={[styles.tagScore, score < 0 && { color: '#FF9C9F' }]}>
            {score >= 0 ? '+' : ''}
            {score}
          </Text>
          {offline && <Text style={styles.offline}>離線</Text>}
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
 */
export function Compass({ prevailing, drawsLeft, seatWinds, active, size = 72 }: { prevailing: string; drawsLeft: number; seatWinds: [string, string, string, string]; active: number | null; size?: number }) {
  // seatWinds / active are relative to the viewer: 0 = me (bottom), 1 = right, 2 = top, 3 = left.
  const b = Math.round(size * 0.32);
  const mid = (size - b) / 2 - 3;
  const pos: ViewStyle[] = [
    { bottom: -b / 2, left: mid },
    { right: -b / 2, top: mid },
    { top: -b / 2, left: mid },
    { left: -b / 2, top: mid },
  ];
  return (
    <View style={[styles.compass, { width: size, height: size, borderRadius: size * 0.26 }]}>
      <View style={[styles.compassInner, { borderRadius: size * 0.2 }]} />
      <Text style={[styles.compassMain, { fontSize: size * 0.34, lineHeight: size * 0.42 }]}>{prevailing}</Text>
      <View style={styles.compassCountWrap}>
        <Text style={[styles.compassCount, { fontSize: size * 0.17 }]}>{drawsLeft}</Text>
      </View>
      {seatWinds.map((w, i) => (
        <View key={i} pointerEvents="none" style={[styles.compassWind, pos[i], { width: b, height: b, borderRadius: b / 2 }, active === i && styles.compassWindOn]}>
          <Text style={[styles.compassWindText, { fontSize: b * 0.56 }, active === i && { color: colors.ink }]}>{w}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  meld: { flexDirection: 'row', alignItems: 'flex-end', gap: 1, marginRight: 5 },
  meldRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', rowGap: 3 },
  flowers: { flexDirection: 'row', gap: 1, alignItems: 'flex-end' },
  strip: { flexDirection: 'row', flexWrap: 'wrap', gap: 2 },
  seat: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  seatVertical: { flexDirection: 'column', gap: 0 },
  tag: { backgroundColor: 'rgba(16,20,47,0.78)', borderWidth: 2, borderColor: colors.ink, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2, minWidth: 0 },
  tagName: { color: '#FFFFFF', fontSize: 12 },
  tagRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  tagRel: { color: '#B9C6E4', fontSize: 10, fontWeight: '900' },
  tagScore: { color: colors.gold, fontFamily: fonts.display, fontSize: 12 },
  offline: { color: colors.danger, fontSize: 10, fontWeight: '900' },
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
