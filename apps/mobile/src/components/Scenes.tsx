/**
 * Flat two-tone scene illustrations with thick ink outlines, used on the home
 * mode cards, Learn and Shop. Each scene draws in its own viewBox and scales
 * to whatever box it is given.
 */
import React from 'react';
import Svg, { Circle, Ellipse, G, Line, Path, Polygon, Rect, Text as SvgText } from 'react-native-svg';
import { colors, fonts } from '../theme';
import type { TableTheme } from '../themes';
import { Gem } from './Icons';

const INK = colors.ink;
const IVORY = '#FFF9EE';

function Sparkle({ x, y, s = 1, fill = '#FFFFFF' }: { x: number; y: number; s?: number; fill?: string }) {
  return <Path d={`M${x} ${y - 7 * s} Q${x + 1.2 * s} ${y - 1.2 * s} ${x + 7 * s} ${y} Q${x + 1.2 * s} ${y + 1.2 * s} ${x} ${y + 7 * s} Q${x - 1.2 * s} ${y + 1.2 * s} ${x - 7 * s} ${y} Q${x - 1.2 * s} ${y - 1.2 * s} ${x} ${y - 7 * s} Z`} fill={fill} />;
}

/** Tiny face-up tile for scenes (w×h at x,y) with an optional glyph painter. */
function MiniTile({ x, y, w, h, rot = 0, children }: { x: number; y: number; w: number; h: number; rot?: number; children?: React.ReactNode }) {
  const d = Math.max(2, h * 0.12);
  return (
    <G transform={rot ? `rotate(${rot} ${x + w / 2} ${y + h / 2})` : undefined}>
      <Rect x={x} y={y} width={w} height={h} rx={w * 0.2} fill={colors.feltDark} stroke={INK} strokeWidth={2.4} />
      <Rect x={x} y={y} width={w} height={h - d} rx={w * 0.2} fill={IVORY} stroke={INK} strokeWidth={2.4} />
      {children}
    </G>
  );
}

function stool(cx: number, cy: number) {
  return (
    <G>
      <Circle cx={cx} cy={cy + 3} r={15} fill="#A12A2E" stroke={INK} strokeWidth={4} />
      <Circle cx={cx} cy={cy} r={15} fill="#FF5A5F" stroke={INK} strokeWidth={4} />
      <Circle cx={cx - 3} cy={cy - 3} r={7} fill="#FF8A8D" />
    </G>
  );
}

/** Top-down mahjong table with tile walls, dice and four stools. */
export function TableScene({ width, height }: { width: number | string; height: number | string }) {
  const top = Array.from({ length: 7 });
  const side = Array.from({ length: 5 });
  return (
    <Svg width={width} height={height} viewBox="0 0 200 140">
      <Ellipse cx={100} cy={128} rx={86} ry={10} fill="rgba(16,20,47,0.18)" />
      {stool(100, 14)}
      {stool(24, 72)}
      {stool(176, 72)}
      <Rect x={44} y={22} width={112} height={104} rx={16} fill={colors.railEdge} stroke={INK} strokeWidth={4} />
      <Rect x={44} y={20} width={112} height={100} rx={16} fill={colors.rail} stroke={INK} strokeWidth={4} />
      <Rect x={50} y={24} width={100} height={8} rx={4} fill={colors.railLight} opacity={0.8} />
      <Rect x={55} y={31} width={90} height={80} rx={9} fill={colors.felt} stroke={INK} strokeWidth={3} />
      <Rect x={58} y={34} width={84} height={30} rx={7} fill={colors.feltLight} opacity={0.55} />
      {top.map((_, i) => (
        <G key={`t${i}`}>
          <Rect x={64 + i * 10.5} y={36} width={9} height={11} rx={2} fill={colors.feltDark} stroke={INK} strokeWidth={1.6} />
          <Rect x={64 + i * 10.5} y={36} width={9} height={8.5} rx={2} fill={IVORY} stroke={INK} strokeWidth={1.6} />
        </G>
      ))}
      {top.map((_, i) => (
        <G key={`b${i}`}>
          <Rect x={64 + i * 10.5} y={95} width={9} height={11} rx={2} fill={colors.feltDark} stroke={INK} strokeWidth={1.6} />
          <Rect x={64 + i * 10.5} y={95} width={9} height={8.5} rx={2} fill={IVORY} stroke={INK} strokeWidth={1.6} />
        </G>
      ))}
      {side.map((_, i) => (
        <Rect key={`l${i}`} x={60} y={51 + i * 8.5} width={11} height={7.5} rx={2} fill={IVORY} stroke={INK} strokeWidth={1.6} />
      ))}
      {side.map((_, i) => (
        <Rect key={`r${i}`} x={129} y={51 + i * 8.5} width={11} height={7.5} rx={2} fill={IVORY} stroke={INK} strokeWidth={1.6} />
      ))}
      <MiniTile x={82} y={56} w={16} h={22} rot={-10}>
        <SvgText x={90} y={72} fontSize={13} fontWeight="900" fill={colors.red} textAnchor="middle" transform="rotate(-10 90 67)">
          中
        </SvgText>
      </MiniTile>
      <MiniTile x={101} y={57} w={16} h={22} rot={8}>
        <Circle cx={109} cy={66} r={5.5} fill={colors.blue} stroke="#0F3E86" strokeWidth={1.2} />
        <Circle cx={109} cy={66} r={3.4} fill={IVORY} />
        <Circle cx={109} cy={66} r={2.2} fill={colors.blue} />
      </MiniTile>
      <G transform="rotate(12 122 82)">
        <Rect x={115} y={75} width={13} height={13} rx={3} fill="#FFFFFF" stroke={INK} strokeWidth={2.4} />
        <Circle cx={118.5} cy={78.5} r={1.5} fill={colors.red} />
        <Circle cx={124.5} cy={84.5} r={1.5} fill={INK} />
      </G>
      <G transform="rotate(-14 72 82)">
        <Rect x={66} y={76} width={12} height={12} rx={3} fill="#FFFFFF" stroke={INK} strokeWidth={2.4} />
        <Circle cx={72} cy={82} r={2} fill={colors.red} />
      </G>
      {stool(100, 132)}
      <Sparkle x={178} y={22} s={1.1} />
      <Sparkle x={22} y={118} s={0.8} />
    </Svg>
  );
}

function lantern(cx: number, top: number) {
  return (
    <G>
      <Line x1={cx} y1={top - 6} x2={cx} y2={top + 2} stroke={INK} strokeWidth={2.5} />
      <Rect x={cx - 6} y={top} width={12} height={5} rx={2} fill={colors.gold} stroke={INK} strokeWidth={2.4} />
      <Ellipse cx={cx} cy={top + 17} rx={11} ry={13} fill="#E0312F" stroke={INK} strokeWidth={3} />
      <Path d={`M${cx + 4} ${top + 6} Q${cx + 11} ${top + 17} ${cx + 4} ${top + 28}`} stroke="#A61B1B" strokeWidth={3} fill="none" />
      <Path d={`M${cx - 4} ${top + 6} Q${cx - 9} ${top + 17} ${cx - 4} ${top + 28}`} stroke="#FF7A6E" strokeWidth={2.5} fill="none" />
      <Rect x={cx - 6} y={top + 28} width={12} height={5} rx={2} fill={colors.gold} stroke={INK} strokeWidth={2.4} />
      <Line x1={cx} y1={top + 33} x2={cx} y2={top + 41} stroke={colors.goldShelf} strokeWidth={3} strokeLinecap="round" />
    </G>
  );
}

/** Clubhouse facade: pagoda roof, glowing windows, red lanterns. */
export function ClubhouseScene({ width, height }: { width: number | string; height: number | string }) {
  return (
    <Svg width={width} height={height} viewBox="0 0 200 140">
      <Rect x={0} y={118} width={200} height={22} fill="#7BD06A" />
      <Line x1={0} y1={118} x2={200} y2={118} stroke={INK} strokeWidth={3} />
      <Circle cx={30} cy={116} r={12} fill="#52B847" stroke={INK} strokeWidth={3} />
      <Circle cx={172} cy={116} r={13} fill="#52B847" stroke={INK} strokeWidth={3} />
      <Rect x={42} y={56} width={116} height={64} fill="#FFE3B3" stroke={INK} strokeWidth={4} />
      <Rect x={130} y={58} width={26} height={60} fill="#F3C98A" />
      <Path d="M22 52 Q34 58 46 54 L62 26 H138 L154 54 Q166 58 178 52 L172 66 H28 Z" fill="#E0312F" stroke={INK} strokeWidth={4} strokeLinejoin="round" />
      <Path d="M52 50 L66 32 H134 L148 50 Z" fill="#FF5A4F" />
      <Rect x={58} y={20} width={84} height={9} rx={4.5} fill="#B5222A" stroke={INK} strokeWidth={3.5} />
      <Circle cx={100} cy={16} r={6} fill={colors.gold} stroke={INK} strokeWidth={3} />
      <Rect x={72} y={70} width={56} height={16} rx={4} fill={colors.inkSoft} stroke={INK} strokeWidth={3} />
      <SvgText x={100} y={83} fontSize={12} fontWeight="900" fill={colors.gold} textAnchor="middle">
        麻將館
      </SvgText>
      <Path d="M86 120 V100 Q86 90 100 90 Q114 90 114 100 V120 Z" fill="#A9652B" stroke={INK} strokeWidth={3.5} />
      <Line x1={100} y1={91} x2={100} y2={120} stroke={INK} strokeWidth={2.5} />
      <Circle cx={95} cy={106} r={2} fill={colors.gold} />
      <Circle cx={105} cy={106} r={2} fill={colors.gold} />
      {[60, 140].map((x) => (
        <G key={x}>
          <Circle cx={x} cy={98} r={11} fill="#FFD45E" stroke={INK} strokeWidth={3.5} />
          <Path d={`M${x - 11} 98 H${x + 11} M${x} 87 V109`} stroke="#B5722F" strokeWidth={2.5} />
          <Path d={`M${x - 6} 92 Q${x - 2} 89 ${x + 2} 90`} stroke="#FFFFFF" strokeWidth={2} fill="none" strokeLinecap="round" />
        </G>
      ))}
      {lantern(36, 62)}
      {lantern(164, 62)}
      <Sparkle x={182} y={20} s={1} />
    </Svg>
  );
}

/** Open scroll with a dots tile and a check: lessons and the daily puzzle. */
export function ScrollScene({ width, height }: { width: number | string; height: number | string }) {
  return (
    <Svg width={width} height={height} viewBox="0 0 200 140">
      <Ellipse cx={100} cy={128} rx={80} ry={8} fill="rgba(16,20,47,0.18)" />
      <Rect x={30} y={30} width={140} height={86} fill="#FFF1CF" stroke={INK} strokeWidth={4} />
      <Rect x={32} y={100} width={136} height={14} fill="#F7DFAA" />
      {[28, 172].map((x) => (
        <G key={x}>
          <Rect x={x - 9} y={22} width={18} height={102} rx={9} fill="#B5722F" stroke={INK} strokeWidth={4} />
          <Rect x={x - 5} y={28} width={4} height={90} rx={2} fill="#D99A55" />
          <Circle cx={x} cy={20} r={7} fill={colors.gold} stroke={INK} strokeWidth={3} />
          <Circle cx={x} cy={126} r={7} fill={colors.gold} stroke={INK} strokeWidth={3} />
        </G>
      ))}
      <MiniTile x={48} y={44} w={38} h={52} rot={-6}>
        <G transform="rotate(-6 67 68)">
          <Circle cx={67} cy={66} r={14} fill={colors.blue} stroke="#0F3E86" strokeWidth={2} />
          <Circle cx={67} cy={66} r={10} fill={IVORY} />
          <Circle cx={67} cy={66} r={8} fill={colors.red} />
          <Circle cx={67} cy={66} r={3.5} fill={colors.green} />
        </G>
      </MiniTile>
      <Path d="M98 52 H152 M98 66 H146 M98 80 H132" stroke="#E0B87A" strokeWidth={6} strokeLinecap="round" />
      <Circle cx={150} cy={90} r={14} fill={colors.cta} stroke={INK} strokeWidth={3.5} />
      <Path d="M143 90 L148 96 L157 85" stroke={INK} strokeWidth={8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M143 90 L148 96 L157 85" stroke="#FFFFFF" strokeWidth={4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <Sparkle x={186} y={14} s={1.1} />
      <Sparkle x={14} y={56} s={0.8} />
    </Svg>
  );
}

function coin(cx: number, cy: number, r = 7, key?: string | number) {
  return (
    <G key={key}>
      <Ellipse cx={cx} cy={cy + 1.5} rx={r} ry={r * 0.9} fill={colors.goldShelf} stroke={INK} strokeWidth={2.4} />
      <Ellipse cx={cx} cy={cy} rx={r} ry={r * 0.9} fill={colors.gold} stroke={INK} strokeWidth={2.4} />
      <Ellipse cx={cx} cy={cy} rx={r * 0.5} ry={r * 0.42} fill="none" stroke={colors.goldShelf} strokeWidth={1.8} />
    </G>
  );
}

/** Treasure chest overflowing with gems and coins. */
export function ChestScene({ width, height }: { width: number | string; height: number | string }) {
  return (
    <Svg width={width} height={height} viewBox="0 0 200 140">
      <Circle cx={100} cy={62} r={58} fill="#FFF3B0" opacity={0.55} />
      <Ellipse cx={100} cy={126} rx={70} ry={8} fill="rgba(16,20,47,0.18)" />
      <Path d="M48 72 L54 36 Q100 20 146 36 L152 72 Z" fill="#C98144" stroke={INK} strokeWidth={4} strokeLinejoin="round" />
      <Path d="M58 68 L62 42 Q100 30 138 42 L142 68 Z" fill="#6E3F12" />
      <Gem x={58} y={36} s={0.62} hue="purple" />
      <Gem x={110} y={34} s={0.62} hue="red" />
      <Gem x={82} y={26} s={0.75} hue="blue" />
      {coin(70, 66, 8, 'c1')}
      {coin(132, 64, 8, 'c2')}
      <Gem x={98} y={50} s={0.55} hue="green" />
      <Rect x={46} y={68} width={108} height={54} rx={8} fill="#B5722F" stroke={INK} strokeWidth={4} />
      <Rect x={50} y={72} width={100} height={8} rx={3} fill="#D99A55" />
      <Line x1={48} y1={96} x2={152} y2={96} stroke="#8C5420" strokeWidth={3} />
      <Rect x={60} y={68} width={11} height={54} fill={colors.gold} stroke={INK} strokeWidth={3} />
      <Rect x={129} y={68} width={11} height={54} fill={colors.gold} stroke={INK} strokeWidth={3} />
      <Rect x={91} y={80} width={18} height={22} rx={4} fill={colors.gold} stroke={INK} strokeWidth={3} />
      <Circle cx={100} cy={89} r={3} fill={INK} />
      <Rect x={98.6} y={89} width={2.8} height={7} rx={1.4} fill={INK} />
      <Gem x={150} y={100} s={0.45} hue="blue" />
      {coin(40, 116, 7, 'c3')}
      {coin(166, 122, 6, 'c4')}
      <Sparkle x={36} y={30} s={1.2} />
      <Sparkle x={172} y={24} s={1} />
      <Sparkle x={150} y={48} s={0.7} />
    </Svg>
  );
}

const PILE_HUES = ['blue', 'purple', 'blue', 'red', 'green', 'blue', 'purple', 'gold', 'blue', 'red'] as const;

/** Gem pile that grows with the pack tier (0 = smallest). */
export function GemPile({ tier, width, height }: { tier: number; width: number | string; height: number | string }) {
  const rows = tier <= 0 ? 1 : tier === 1 ? 2 : tier <= 3 ? 3 : 4;
  const s = rows >= 4 ? 0.5 : rows === 3 ? 0.56 : rows === 2 ? 0.66 : 0.95;
  const gw = 48 * s;
  const spacing = gw * 0.82;
  const rowH = gw * 0.62;
  const baseY = 96 - gw;
  const gems: React.ReactNode[] = [];
  let n = 0;
  for (let r = 0; r < rows; r++) {
    const count = rows - r;
    const totalW = spacing * (count - 1) + gw;
    const x0 = 60 - totalW / 2;
    for (let c = 0; c < count; c++) {
      gems.push(<Gem key={`${r}-${c}`} x={x0 + c * spacing} y={baseY - r * rowH} s={s} hue={PILE_HUES[n++ % PILE_HUES.length]} />);
    }
  }
  return (
    <Svg width={width} height={height} viewBox="0 0 120 100">
      <Circle cx={60} cy={58} r={30 + rows * 7} fill="#FFFFFF" opacity={0.35} />
      <Ellipse cx={60} cy={95} rx={18 + rows * 10} ry={4} fill="rgba(16,20,47,0.2)" />
      {tier >= 5 && (
        <G>
          <Path d="M22 70 L26 40 Q60 26 94 40 L98 70 Z" fill="#C98144" stroke={INK} strokeWidth={3} />
          <Rect x={20} y={64} width={80} height={30} rx={6} fill="#B5722F" stroke={INK} strokeWidth={3} />
          <Rect x={30} y={64} width={8} height={30} fill={colors.gold} stroke={INK} strokeWidth={2.4} />
          <Rect x={82} y={64} width={8} height={30} fill={colors.gold} stroke={INK} strokeWidth={2.4} />
        </G>
      )}
      {tier === 4 && (
        <G>
          <Path d="M34 92 C22 92 22 60 42 50 L38 38 H82 L78 50 C98 60 98 92 86 92 Z" fill={colors.premium} stroke={INK} strokeWidth={3} strokeLinejoin="round" />
          <Rect x={40} y={44} width={40} height={8} rx={4} fill={colors.gold} stroke={INK} strokeWidth={2.4} />
        </G>
      )}
      {gems}
      {tier >= 3 && (
        <G>
          {coin(16, 88, 7, 'a')}
          {coin(104, 86, 7, 'b')}
          {tier >= 5 && coin(24, 78, 6, 'c')}
        </G>
      )}
      <Sparkle x={100} y={16} s={0.9} />
      {tier >= 2 && <Sparkle x={18} y={26} s={0.7} />}
    </Svg>
  );
}

const MEDAL = {
  gold: { fill: colors.gold, shade: colors.goldShelf },
  fourwinds: { fill: '#7DDBB4', shade: '#2E9A72' },
  diamond: { fill: '#7FE3FF', shade: '#2FA8E0' },
} as const;

/** Ribbon medal for coaching tiers; The Four Winds Club carries a four-point compass for the four winds. */
export function MedalScene({ tier, width, height }: { tier: 'gold' | 'fourwinds' | 'diamond'; width: number | string; height: number | string }) {
  const m = MEDAL[tier];
  return (
    <Svg width={width} height={height} viewBox="0 0 120 100">
      <Circle cx={60} cy={52} r={44} fill="#FFFFFF" opacity={0.35} />
      <Polygon points="40,8 58,8 66,46 48,46" fill={colors.info} stroke={INK} strokeWidth={3} strokeLinejoin="round" />
      <Polygon points="80,8 62,8 54,46 72,46" fill={colors.danger} stroke={INK} strokeWidth={3} strokeLinejoin="round" />
      <Circle cx={60} cy={60} r={28} fill={m.shade} stroke={INK} strokeWidth={4} />
      <Circle cx={60} cy={57} r={25} fill={m.fill} />
      <Circle cx={60} cy={57} r={18} fill="none" stroke={m.shade} strokeWidth={3} />
      {tier === 'diamond' ? (
        <Gem x={45} y={42} s={0.62} hue="blue" />
      ) : tier === 'fourwinds' ? (
        <G>
          <Path d="M60 38 L65 52 L79 57 L65 62 L60 76 L55 62 L41 57 L55 52 Z" fill="#FFFFFF" stroke={INK} strokeWidth={2.6} strokeLinejoin="round" />
          <Circle cx={60} cy={57} r={4} fill={m.shade} stroke={INK} strokeWidth={2} />
        </G>
      ) : (
        <Path d="M60 42 L64.5 52 L75 53 L67 60 L69.5 71 L60 65.5 L50.5 71 L53 60 L45 53 L55.5 52 Z" fill="#FFFFFF" stroke={INK} strokeWidth={2.6} strokeLinejoin="round" />
      )}
      <Sparkle x={98} y={22} s={0.9} />
    </Svg>
  );
}

const VIP = {
  bronze: { fill: '#E0955A', light: '#F2B886', shade: '#A9632B' },
  silver: { fill: '#C9D2E0', light: '#E8EDF5', shade: '#8E9AB0' },
  gold: { fill: colors.gold, light: colors.goldLight, shade: colors.goldShelf },
} as const;

/** Prepaid VIP card with a crown. */
export function VipCardScene({ tier, width, height }: { tier: 'bronze' | 'silver' | 'gold'; width: number | string; height: number | string }) {
  const v = VIP[tier];
  return (
    <Svg width={width} height={height} viewBox="0 0 120 100">
      <G transform="rotate(-8 60 52)">
        <Rect x={16} y={24} width={88} height={58} rx={10} fill={v.shade} stroke={INK} strokeWidth={4} />
        <Rect x={16} y={22} width={88} height={54} rx={10} fill={v.fill} stroke={INK} strokeWidth={4} />
        <Rect x={20} y={26} width={80} height={20} rx={7} fill={v.light} />
        <Path d="M30 36 L38 44 L46 30 L54 44 L62 36 L58 54 H34 Z" fill="#FFFFFF" stroke={INK} strokeWidth={3} strokeLinejoin="round" />
        <SvgText x={84} y={68} fontSize={22} fontFamily={fonts.display} fill={INK} stroke={INK} strokeWidth={5} strokeLinejoin="round" textAnchor="middle">
          VIP
        </SvgText>
        <SvgText x={84} y={68} fontSize={22} fontFamily={fonts.display} fill="#FFFFFF" textAnchor="middle">
          VIP
        </SvgText>
      </G>
      <Sparkle x={104} y={16} s={1} />
    </Svg>
  );
}

/** Mini table in a theme's colours, for table-look cosmetics. */
export function ThemeScene({ theme, width, height }: { theme: Pick<TableTheme, 'felt' | 'feltDark' | 'feltLight' | 'tileFace' | 'tileBack' | 'accent'>; width: number | string; height: number | string }) {
  return (
    <Svg width={width} height={height} viewBox="0 0 120 100">
      <Rect x={8} y={12} width={104} height={80} rx={14} fill={colors.railEdge} stroke={INK} strokeWidth={4} />
      <Rect x={8} y={10} width={104} height={76} rx={14} fill={colors.rail} stroke={INK} strokeWidth={4} />
      <Rect x={17} y={18} width={86} height={60} rx={8} fill={theme.felt} stroke={INK} strokeWidth={3} />
      <Ellipse cx={60} cy={44} rx={34} ry={22} fill={theme.feltLight} opacity={0.6} />
      {[0, 1, 2].map((i) => (
        <G key={i}>
          <Rect x={33 + i * 19} y={33} width={16} height={23} rx={3} fill={theme.tileBack} stroke={INK} strokeWidth={2.4} />
          <Rect x={33 + i * 19} y={33} width={16} height={19.5} rx={3} fill={theme.tileFace} stroke={INK} strokeWidth={2.4} />
        </G>
      ))}
      <SvgText x={41} y={48} fontSize={11} fontWeight="900" fill={colors.red} textAnchor="middle">
        中
      </SvgText>
      <SvgText x={60} y={48} fontSize={11} fontWeight="900" fill={colors.green} textAnchor="middle">
        發
      </SvgText>
      <Rect x={74.5} y={37} width={9} height={11.5} rx={1.5} fill="none" stroke={colors.blue} strokeWidth={2} />
      <Rect x={84} y={60} width={14} height={10} rx={3} fill={theme.tileBack} stroke={INK} strokeWidth={2.2} />
      <Circle cx={26} cy={66} r={5} fill={theme.accent} stroke={INK} strokeWidth={2.2} />
    </Svg>
  );
}
