import React, { useContext } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, Ellipse, G, LinearGradient, Line, Path, Polygon, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { kindInfo, kindOf, type Kind, type TileId } from '@mjm/engine';
import { colors } from '../theme';
import { TableThemeContext, type TableTheme } from '../themes';
import { tileBackById, type TileBackDesign } from '../monetisation/cosmetics';
import { useEquipped } from '../monetisation/useEquipped';

import { tileDims, type TileSize } from './tileDims';

export { scaledTile, tileDims, type TileSize } from './tileDims';

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

export interface TileProps {
  tile?: TileId;
  kind?: Kind;
  /** Named size, or an explicit width in pixels (height and art scale with it). */
  size?: TileSize | number;
  faceDown?: boolean;
  selected?: boolean;
  dimmed?: boolean;
  highlight?: 'good' | 'bad' | 'wait';
  onPress?: () => void;
  onLongPress?: () => void;
  style?: ViewStyle;
  /** Rotate 90° to show a claimed tile in a meld. */
  rotated?: boolean;
  /** Screen-reader name for a pressable tile (defaults to the tile's English name). */
  accessibilityLabel?: string;
  accessibilityHint?: string;
}

/* ------------------------------------------------------------------ */
/* Suit art, drawn in a 100 × 126 face box                             */
/* ------------------------------------------------------------------ */

const PAL = {
  blue: { c: '#1F63C6', d: '#0F3E86' },
  red: { c: '#E0312F', d: '#981817' },
  green: { c: '#189A52', d: '#0A6233' },
} as const;
type Hue = keyof typeof PAL;
const IVORY = '#FFF9EE';
const INK = colors.ink;
const WIND_NAVY = '#1A2766';

function dot(cx: number, cy: number, r: number, hue: Hue, key: string | number) {
  const p = PAL[hue];
  return (
    <G key={key}>
      <Circle cx={cx} cy={cy} r={r} fill={p.c} stroke={p.d} strokeWidth={2.2} />
      <Circle cx={cx} cy={cy} r={r * 0.7} fill={IVORY} />
      <Circle cx={cx} cy={cy} r={r * 0.52} fill={p.c} />
      <Circle cx={cx - r * 0.12} cy={cy - r * 0.14} r={r * 0.2} fill={IVORY} />
    </G>
  );
}

const DOTS: Record<number, Array<[number, number, number, Hue]>> = {
  2: [
    [50, 35, 21, 'green'],
    [50, 91, 21, 'blue'],
  ],
  3: [
    [25, 25, 16, 'blue'],
    [50, 63, 16, 'red'],
    [75, 101, 16, 'green'],
  ],
  4: [
    [29, 36, 18, 'blue'],
    [71, 36, 18, 'green'],
    [29, 90, 18, 'green'],
    [71, 90, 18, 'blue'],
  ],
  5: [
    [26, 28, 16, 'blue'],
    [74, 28, 16, 'green'],
    [50, 63, 16, 'red'],
    [26, 98, 16, 'green'],
    [74, 98, 16, 'blue'],
  ],
  6: [
    [30, 24, 15, 'green'],
    [70, 24, 15, 'green'],
    [30, 65, 15, 'red'],
    [70, 65, 15, 'red'],
    [30, 102, 15, 'red'],
    [70, 102, 15, 'red'],
  ],
  7: [
    [22, 17, 11.5, 'green'],
    [50, 31, 11.5, 'green'],
    [78, 45, 11.5, 'green'],
    [30, 75, 13.5, 'red'],
    [70, 75, 13.5, 'red'],
    [30, 106, 13.5, 'red'],
    [70, 106, 13.5, 'red'],
  ],
  8: [
    [30, 19, 13, 'blue'],
    [70, 19, 13, 'blue'],
    [30, 48, 13, 'blue'],
    [70, 48, 13, 'blue'],
    [30, 78, 13, 'blue'],
    [70, 78, 13, 'blue'],
    [30, 107, 13, 'blue'],
    [70, 107, 13, 'blue'],
  ],
  9: [
    [21, 22, 13.5, 'blue'],
    [50, 22, 13.5, 'blue'],
    [79, 22, 13.5, 'blue'],
    [21, 63, 13.5, 'red'],
    [50, 63, 13.5, 'red'],
    [79, 63, 13.5, 'red'],
    [21, 104, 13.5, 'green'],
    [50, 104, 13.5, 'green'],
    [79, 104, 13.5, 'green'],
  ],
};

function oneDot() {
  const petals = Array.from({ length: 8 }).map((_, i) => {
    const a = (i / 8) * Math.PI * 2;
    return <Circle key={i} cx={50 + Math.cos(a) * 22} cy={63 + Math.sin(a) * 22} r={4.2} fill={IVORY} />;
  });
  return (
    <G>
      <Circle cx={50} cy={63} r={38} fill={PAL.blue.c} stroke={PAL.blue.d} strokeWidth={2.5} />
      <Circle cx={50} cy={63} r={32} fill={IVORY} />
      <Circle cx={50} cy={63} r={29} fill={PAL.red.c} />
      {petals}
      <Circle cx={50} cy={63} r={15} fill={IVORY} />
      <Circle cx={50} cy={63} r={11.5} fill={PAL.green.c} />
      <Circle cx={47} cy={60} r={4} fill={IVORY} />
    </G>
  );
}

function stick(cx: number, cy: number, len: number, hue: Hue, key: string | number, rot = 0, w = 12) {
  const p = PAL[hue];
  const top = cy - len / 2;
  return (
    <G key={key} transform={rot ? `rotate(${rot} ${cx} ${cy})` : undefined}>
      <Rect x={cx - w / 2} y={top} width={w} height={len} rx={w / 2} fill={p.c} stroke={p.d} strokeWidth={2.4} />
      <Rect x={cx - w / 2 - 1.6} y={cy - 2.4} width={w + 3.2} height={4.8} rx={2.4} fill={p.d} />
      <Rect x={cx - w / 2 + 2.4} y={top + 4} width={2.6} height={len / 2 - 8} rx={1.3} fill="#FFFFFF" opacity={0.55} />
      <Rect x={cx - w / 2 + 2.4} y={cy + 4} width={2.6} height={len / 2 - 8} rx={1.3} fill="#FFFFFF" opacity={0.55} />
    </G>
  );
}

const STICKS: Record<number, Array<[number, number, number, Hue, number?, number?]>> = {
  2: [
    [50, 36, 44, 'blue'],
    [50, 90, 44, 'green'],
  ],
  3: [
    [50, 36, 44, 'blue'],
    [31, 90, 44, 'green'],
    [69, 90, 44, 'green'],
  ],
  4: [
    [31, 36, 44, 'blue'],
    [69, 36, 44, 'green'],
    [31, 90, 44, 'green'],
    [69, 90, 44, 'blue'],
  ],
  5: [
    [24, 36, 44, 'green'],
    [76, 36, 44, 'blue'],
    [50, 63, 44, 'red'],
    [24, 90, 44, 'blue'],
    [76, 90, 44, 'green'],
  ],
  6: [
    [24, 36, 44, 'green'],
    [50, 36, 44, 'green'],
    [76, 36, 44, 'green'],
    [24, 90, 44, 'blue'],
    [50, 90, 44, 'blue'],
    [76, 90, 44, 'blue'],
  ],
  7: [
    [50, 20, 30, 'red'],
    [24, 62, 32, 'green'],
    [50, 62, 32, 'green'],
    [76, 62, 32, 'green'],
    [24, 104, 32, 'green'],
    [50, 104, 32, 'green'],
    [76, 104, 32, 'green'],
  ],
  8: [
    [16, 36, 42, 'green', 0, 10],
    [38, 36, 44, 'green', 24, 10],
    [62, 36, 44, 'green', -24, 10],
    [84, 36, 42, 'green', 0, 10],
    [16, 90, 42, 'green', 0, 10],
    [38, 90, 44, 'green', -24, 10],
    [62, 90, 44, 'green', 24, 10],
    [84, 90, 42, 'green', 0, 10],
  ],
  9: [
    [22, 22, 32, 'green'],
    [50, 22, 32, 'red'],
    [78, 22, 32, 'blue'],
    [22, 63, 32, 'green'],
    [50, 63, 32, 'red'],
    [78, 63, 32, 'blue'],
    [22, 104, 32, 'green'],
    [50, 104, 32, 'red'],
    [78, 104, 32, 'blue'],
  ],
};

function bird() {
  return (
    <G>
      <Rect x={14} y={104} width={74} height={9} rx={4.5} fill={PAL.green.c} stroke={INK} strokeWidth={2.5} />
      <Ellipse cx={78} cy={92} rx={9} ry={24} transform="rotate(-38 78 92)" fill={PAL.blue.c} stroke={INK} strokeWidth={2.5} />
      <Ellipse cx={74} cy={98} rx={8} ry={22} transform="rotate(-62 74 98)" fill={PAL.red.c} stroke={INK} strokeWidth={2.5} />
      <Line x1={42} y1={92} x2={40} y2={106} stroke="#FF9A1A" strokeWidth={4} strokeLinecap="round" />
      <Line x1={53} y1={92} x2={54} y2={106} stroke="#FF9A1A" strokeWidth={4} strokeLinecap="round" />
      <Ellipse cx={48} cy={72} rx={25} ry={25} fill="#2DB46A" stroke={INK} strokeWidth={3} />
      <Ellipse cx={42} cy={79} rx={14} ry={15} fill="#FFE08A" />
      <Path d="M54 62 C70 62 74 78 62 88 C58 80 54 72 54 62 Z" fill={PAL.green.c} stroke={INK} strokeWidth={2.5} strokeLinejoin="round" />
      <Circle cx={39} cy={18} r={4.5} fill={PAL.red.c} stroke={INK} strokeWidth={2} />
      <Circle cx={47} cy={15} r={4.8} fill={PAL.red.c} stroke={INK} strokeWidth={2} />
      <Circle cx={55} cy={18} r={4.5} fill={PAL.red.c} stroke={INK} strokeWidth={2} />
      <Circle cx={46} cy={38} r={17} fill="#2DB46A" stroke={INK} strokeWidth={3} />
      <Polygon points="30,38 18,43 30,48" fill="#FF9A1A" stroke={INK} strokeWidth={2.2} strokeLinejoin="round" />
      <Circle cx={40} cy={35} r={5} fill="#FFFFFF" />
      <Circle cx={39} cy={35.5} r={3} fill={INK} />
      <Ellipse cx={46} cy={46} rx={4} ry={2.6} fill="#FF8FB0" opacity={0.85} />
    </G>
  );
}

const FLOWER_HUES = ['#FF6FA0', '#B35CFF', '#3FBF6A', '#FFB020', '#5CCB5F', '#FF5A5F', '#FF8C1A', '#3FA9F5'];
const FLOWER_INK = ['#C2185B', '#7E3AE0', '#0A7A3C', '#B26B00', '#2E8A31', '#C73A40', '#B65400', '#1C5FCC'];

function blossom(cx: number, cy: number, r: number, hue: string) {
  return (
    <G>
      {Array.from({ length: 5 }).map((_, i) => {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        return <Circle key={i} cx={cx + Math.cos(a) * r * 0.62} cy={cy + Math.sin(a) * r * 0.62} r={r * 0.48} fill={hue} stroke={INK} strokeWidth={2} />;
      })}
      <Circle cx={cx} cy={cy} r={r * 0.36} fill="#FFE08A" stroke={INK} strokeWidth={2} />
    </G>
  );
}

function zh(text: string, y: number, size: number, fill: string) {
  return (
    <SvgText x={50} y={y} fontSize={size} fontWeight="900" fill={fill} textAnchor="middle">
      {text}
    </SvgText>
  );
}

/**
 * Colour-blind-safe suit mark: a small ink shape in the top-right corner that names the suit without
 * relying on colour (萬 square, 筒 ring, 條 bar). Honours and flowers need none: their faces are words.
 * Drawn only on tiles at least 26 px wide, where it is legible.
 */
const MARKS = new Map<Kind, React.ReactElement | null>();
export const SUIT_MARK_SHAPE = { m: 'square', p: 'ring', s: 'bar' } as const;

function suitMark(kind: Kind): React.ReactElement | null {
  if (MARKS.has(kind)) return MARKS.get(kind)!;
  const suit = kindInfo(kind).suit;
  // An ivory backing keeps the mark readable where the suit art reaches the corner.
  const shape =
    suit === 'm' ? <Rect x={84.5} y={4.5} width={7} height={7} rx={1.2} fill={INK} />
    : suit === 'p' ? <Circle cx={88} cy={8} r={3.6} fill="none" stroke={INK} strokeWidth={2.2} />
    : suit === 's' ? <Rect x={86.5} y={3.5} width={3} height={9} rx={1.5} fill={INK} />
    : null;
  const mark = shape && (
    <G opacity={0.6}>
      <Circle cx={88} cy={8} r={6.8} fill={IVORY} opacity={0.9} />
      {shape}
    </G>
  );
  MARKS.set(kind, mark);
  return mark;
}

const ART = new Map<Kind, React.ReactElement>();

function artFor(kind: Kind): React.ReactElement {
  const cached = ART.get(kind);
  if (cached) return cached;
  const info = kindInfo(kind);
  let art: React.ReactElement;
  switch (info.suit) {
    case 'p':
      art = info.rank === 1 ? oneDot() : <G>{DOTS[info.rank].map(([x, y, r, h], i) => dot(x, y, r, h, i))}</G>;
      break;
    case 's':
      art = info.rank === 1 ? bird() : <G>{STICKS[info.rank].map(([x, y, l, h, rot, w], i) => stick(x, y, l, h, i, rot ?? 0, w ?? 12))}</G>;
      break;
    case 'm':
      art = (
        <G>
          {zh(CN_NUM[info.rank - 1], 55, 50, INK)}
          {zh('萬', 113, 50, PAL.red.c)}
        </G>
      );
      break;
    case 'w':
      art = zh(info.nameZh, 89, 74, WIND_NAVY);
      break;
    case 'd':
      art =
        info.rank === 3 ? (
          <G>
            <Rect x={15} y={15} width={70} height={96} rx={9} fill="none" stroke={PAL.blue.c} strokeWidth={7} />
            <Rect x={25} y={25} width={50} height={76} rx={4} fill="none" stroke={PAL.blue.c} strokeWidth={2.6} />
          </G>
        ) : (
          zh(info.nameZh, 91, 78, info.rank === 1 ? PAL.red.c : PAL.green.c)
        );
      break;
    default: {
      const i = info.rank - 1;
      art = (
        <G>
          {blossom(50, 42, 30, FLOWER_HUES[i])}
          <SvgText x={14} y={26} fontSize={22} fontWeight="900" fill={PAL.blue.c} textAnchor="middle">
            {String((i % 4) + 1)}
          </SvgText>
          {zh(info.nameZh, 114, 40, FLOWER_INK[i])}
        </G>
      );
    }
  }
  ART.set(kind, art);
  return art;
}

/* ------------------------------------------------------------------ */
/* Tile body                                                           */
/* ------------------------------------------------------------------ */

/** The motif of an equipped tile back, in the tile's 100×126 face units (centre 50, 63). */
function backMotif(back: TileBackDesign): React.ReactNode {
  const c = back.ink;
  switch (back.motif) {
    case 'jade':
      return (
        <G>
          <Circle cx={50} cy={63} r={24} fill="none" stroke={c} strokeOpacity={0.75} strokeWidth={7} />
          <Circle cx={50} cy={63} r={9} fill={c} fillOpacity={0.35} />
          <Path d="M36 44 Q44 38 54 39" stroke="#FFFFFF" strokeOpacity={0.6} strokeWidth={4} fill="none" strokeLinecap="round" />
        </G>
      );
    case 'knot':
      return (
        <G stroke={c} strokeWidth={5} fill="none" strokeLinejoin="round">
          <Rect x={33} y={46} width={34} height={34} transform="rotate(45 50 63)" />
          <Path d="M38 51 L62 75 M62 51 L38 75" strokeOpacity={0.8} />
          {[
            [50, 34],
            [79, 63],
            [50, 92],
            [21, 63],
          ].map(([x, y]) => (
            <Circle key={`${x}-${y}`} cx={x} cy={y} r={6} />
          ))}
          <Path d="M50 98 V112 M44 112 H56" />
        </G>
      );
    case 'star':
      return <Path d="M50 36 L57.6 54 L77 55.4 L62.2 68 L66.8 87 L50 76.8 L33.2 87 L37.8 68 L23 55.4 L42.4 54 Z" fill={c} stroke="#FFFFFF" strokeOpacity={0.5} strokeWidth={3} strokeLinejoin="round" />;
    case 'lotus':
      return (
        <G fill={c} stroke={back.base} strokeWidth={2.5}>
          <Path d="M50 40 C62 52 62 70 50 82 C38 70 38 52 50 40 Z" />
          <Path d="M50 82 C40 80 28 70 24 56 C36 56 46 66 50 82 Z" />
          <Path d="M50 82 C60 80 72 70 76 56 C64 56 54 66 50 82 Z" />
          <Path d="M28 88 Q50 98 72 88" fill="none" stroke={c} strokeWidth={4} strokeLinecap="round" />
        </G>
      );
    case 'bamboo':
      return (
        <G stroke={c} strokeLinecap="round" fill="none">
          <Path d="M40 30 V98 M60 38 V102" strokeWidth={8} />
          <Path d="M35 52 H45 M35 76 H45 M55 60 H65 M55 84 H65" strokeWidth={3} stroke={back.base} />
          <Path d="M60 50 Q74 40 82 44 Q72 52 60 52 Z" fill={c} strokeWidth={2} />
        </G>
      );
    case 'wave':
      return (
        <G stroke={c} strokeWidth={5} fill="none" strokeLinecap="round">
          <Path d="M22 58 C30 44 46 44 50 56 C52 64 44 68 40 62" />
          <Path d="M50 80 C58 66 74 66 78 78 C80 86 72 90 68 84" />
          <Path d="M22 96 Q36 88 50 96 T78 96" />
        </G>
      );
    case 'cloud':
      return <Path d="M26 74 a12 12 0 0 1 14 -14 a14 14 0 0 1 26 -2 a11 11 0 0 1 10 16 Z M48 58 a6 6 0 1 1 8 6" fill={c} fillOpacity={0.85} stroke="#FFFFFF" strokeOpacity={0.5} strokeWidth={3} strokeLinejoin="round" />;
    case 'lattice':
      return (
        <G stroke={c} strokeWidth={4} fill="none">
          <Rect x={24} y={36} width={52} height={54} rx={4} />
          <Path d="M50 36 V90 M24 63 H76 M37 36 V90 M63 36 V90" strokeOpacity={0.7} />
          <Rect x={41} y={54} width={18} height={18} transform="rotate(45 50 63)" fill={back.base} />
        </G>
      );
    case 'sun':
      return (
        <G>
          {Array.from({ length: 10 }, (_, i) => {
            const a = (i * Math.PI) / 5;
            return <Path key={i} d={`M${50 + Math.cos(a) * 20} ${63 + Math.sin(a) * 20} L${50 + Math.cos(a) * 32} ${63 + Math.sin(a) * 32}`} stroke={c} strokeWidth={4} strokeLinecap="round" />;
          })}
          <Circle cx={50} cy={63} r={14} fill={c} />
        </G>
      );
    case 'scales':
      return (
        <G stroke={c} strokeWidth={4} fill="none">
          {[44, 62, 80, 98].map((y, row) =>
            (row % 2 ? [38, 62] : [26, 50, 74]).map((x) => <Path key={`${row}-${x}`} d={`M${x - 12} ${y} A12 12 0 0 0 ${x + 12} ${y}`} />),
          )}
        </G>
      );
  }
}

function TileSvg({ w, h, kind, faceDown, theme, back }: { w: number; h: number; kind?: Kind; faceDown?: boolean; theme: TableTheme; back?: TileBackDesign | null }) {
  const sw = w < 26 ? 1.3 : w < 36 ? 1.7 : 2.2;
  const depth = Math.max(2.5, Math.round(h * 0.085));
  const r = w * 0.17;
  const faceH = h - depth;
  const fw = w - sw;
  const scale = fw / 100;
  const unitsH = (faceH - sw) / scale;
  const faceId = `tf-${theme.id}`;
  const backId = back ? `tb-${back.id.replace('.', '-')}` : `tb-${theme.id}`;
  return (
    <Svg width={w} height={h}>
      <Defs>
        <LinearGradient id={faceId} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#FFFFFF" />
          <Stop offset="0.55" stopColor={theme.tileFace} />
          <Stop offset="1" stopColor={theme.tileEdge} />
        </LinearGradient>
        <LinearGradient id={backId} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={back?.light ?? theme.feltLight} />
          <Stop offset="1" stopColor={back?.base ?? theme.tileBack} />
        </LinearGradient>
      </Defs>
      {/* Body: the coloured back layer (or ivory when face down) shows as the tile's thickness. */}
      <Rect x={sw / 2} y={sw / 2} width={w - sw} height={h - sw} rx={r} fill={faceDown ? theme.tileEdge : (back?.base ?? theme.tileBack)} stroke={INK} strokeWidth={sw} />
      <Rect x={sw / 2} y={sw / 2} width={w - sw} height={faceH - sw / 2} rx={r} fill={faceDown ? `url(#${backId})` : `url(#${faceId})`} stroke={INK} strokeWidth={sw} />
      {/* Soft bevel: bright inner rim on the top-left. */}
      <Path d={`M${sw + 1.2} ${faceH * 0.6} V${sw + r} Q${sw + 1.2} ${sw + 1.2} ${sw + r} ${sw + 1.2} H${w * 0.72}`} stroke="#FFFFFF" strokeOpacity={faceDown ? 0.4 : 0.95} strokeWidth={Math.max(1, sw * 0.7)} fill="none" strokeLinecap="round" />
      {faceDown ? (
        <G transform={`translate(${sw / 2} ${sw / 2 + (unitsH - 126) * scale * 0.5}) scale(${scale})`}>
          <Rect x={14} y={14} width={72} height={98} rx={12} fill="none" stroke="#FFFFFF" strokeOpacity={0.35} strokeWidth={4} />
          {back ? (
            backMotif(back)
          ) : (
            <G>
              <Polygon points="50,34 72,63 50,92 28,63" fill="#FFFFFF" fillOpacity={0.2} stroke="#FFFFFF" strokeOpacity={0.45} strokeWidth={3.5} strokeLinejoin="round" />
              <Circle cx={50} cy={63} r={8} fill="#FFFFFF" fillOpacity={0.45} />
            </G>
          )}
        </G>
      ) : (
        kind !== undefined && (
          <G transform={`translate(${sw / 2} ${sw / 2 + (unitsH - 126) * scale * 0.5}) scale(${scale})`}>
            {artFor(kind)}
            {w >= 26 && suitMark(kind)}
          </G>
        )
      )}
    </Svg>
  );
}

/** A face-down tile in a given back design (or the table's own back), for the Shop and Settings previews. */
export function TileBackPreview({ back, w = 40, theme }: { back: TileBackDesign | null; w?: number; theme?: TableTheme }) {
  const fallback = useContext(TableThemeContext);
  return <TileSvg w={w} h={Math.round(w * 1.36)} faceDown theme={theme ?? fallback} back={back} />;
}

const RING: Record<'good' | 'bad' | 'wait' | 'selected', string> = { good: '#35D04A', bad: colors.danger, wait: colors.gold, selected: colors.gold };

export const Tile = React.memo(function Tile({ tile, kind, size = 'md', faceDown, selected, dimmed, highlight, onPress, onLongPress, style, rotated, accessibilityLabel, accessibilityHint }: TileProps) {
  const { w, h } = tileDims(size);
  const theme = useContext(TableThemeContext);
  const back = tileBackById(useEquipped().tileBack);
  const k = kind ?? (tile !== undefined ? kindOf(tile) : undefined);
  const info = k !== undefined ? kindInfo(k) : undefined;
  const ring = selected ? RING.selected : highlight ? RING[highlight] : null;
  const r = w * 0.17;
  const face = (
    <View style={[styles.shadow, { width: w, height: h, borderRadius: r }]}>
      <TileSvg w={w} h={h} kind={faceDown ? undefined : k} faceDown={faceDown} theme={theme} back={back} />
      {ring && <View pointerEvents="none" style={[styles.ring, { borderColor: ring, borderRadius: r + 3, borderWidth: w < 26 ? 2 : 3 }]} />}
    </View>
  );
  const body = (
    <View
      testID={faceDown ? 'tile-back' : `tile-${info?.code ?? 'x'}`}
      style={[
        { width: rotated ? h : w, height: rotated ? w : h },
        rotated && styles.rotatedBox,
        selected && styles.selected,
        dimmed && styles.dimmed,
        style,
      ]}
    >
      {rotated ? <View style={{ transform: [{ rotate: '90deg' }] }}>{face}</View> : face}
    </View>
  );
  if (!onPress && !onLongPress) return body;
  return (
    // Neighbouring tiles sit 2 px apart, so the extra touch area goes above and below (hand tiles are 39+ px tall).
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={{ top: Math.max(4, Math.ceil((44 - h) / 2)), bottom: Math.max(4, Math.ceil((44 - h) / 2)), left: 1, right: 1 }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (faceDown ? undefined : info?.nameEn)}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected: !!selected }}
      style={({ pressed }) => pressed && { opacity: 0.85 }}
    >
      {body}
    </Pressable>
  );
});

/**
 * A whole concealed hand drawn as one SVG: a row of tile backs seen edge-on.
 * Much cheaper than N Tile components for opponents' hands.
 */
export function HiddenHand({ count, tileW = 12, tileH = 18, vertical }: { count: number; tileW?: number; tileH?: number; vertical?: boolean }) {
  const theme = useContext(TableThemeContext);
  const backColor = tileBackById(useEquipped().tileBack)?.base ?? theme.tileBack;
  const n = Math.max(0, count);
  const step = tileW - 1;
  const len = n > 0 ? step * (n - 1) + tileW + 1 : 0;
  const W = vertical ? tileH + 2 : len;
  const H = vertical ? len : tileH + 2;
  if (n === 0) return null;
  return (
    <Svg width={W} height={H}>
      {Array.from({ length: n }).map((_, i) => {
        const x = vertical ? 1 : i * step + 0.5;
        const y = vertical ? i * step + 0.5 : 1;
        const tw = vertical ? tileH : tileW;
        const th = vertical ? tileW : tileH;
        return (
          <G key={i}>
            <Rect x={x} y={y} width={tw} height={th} rx={2.5} fill={theme.tileEdge} stroke={INK} strokeWidth={1.2} />
            <Rect x={x} y={y} width={vertical ? tw - 3 : tw} height={vertical ? th : th - 3.5} rx={2.5} fill={backColor} stroke={INK} strokeWidth={1.2} />
            <Rect x={x + 2} y={y + 2} width={vertical ? tw - 8 : tw - 5} height={vertical ? 2 : 2} rx={1} fill="#FFFFFF" opacity={0.35} />
          </G>
        );
      })}
    </Svg>
  );
}

const styles = StyleSheet.create({
  shadow: {
    shadowColor: colors.ink,
    shadowOpacity: 0.28,
    shadowRadius: 1.5,
    shadowOffset: { width: 0, height: 2 },
  },
  rotatedBox: { alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', top: -3, left: -3, right: -3, bottom: -3 },
  selected: { transform: [{ translateY: -10 }] },
  dimmed: { opacity: 0.45 },
});
