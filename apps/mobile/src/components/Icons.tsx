/**
 * Drawn icon set. Every icon lives in a 48×48 box, flat two-tone fills inside
 * a thick ink outline so they read like the rest of the Tycoon Parlour UI.
 */
import React from 'react';
import { View } from 'react-native';
import Svg, { Circle, Ellipse, G, Line, Path, Polygon, Rect } from 'react-native-svg';
import { colors } from '../theme';

export type IconName =
  | 'gem'
  | 'back'
  | 'cog'
  | 'lock'
  | 'flame'
  | 'check'
  | 'cross'
  | 'star'
  | 'cap'
  | 'smile'
  | 'exit'
  | 'hourglass'
  | 'trophy'
  | 'bolt'
  | 'target'
  | 'magnifier'
  | 'users'
  | 'bot'
  | 'shield'
  | 'warning'
  | 'share'
  | 'book'
  | 'crown'
  | 'play'
  | 'plus'
  | 'minus'
  | 'wall'
  | 'heart'
  | 'scroll'
  | 'clock'
  | 'pencil';

const INK = colors.ink;
const SW = 3.5;

export function Icon({ name, size = 24, color }: { name: IconName; size?: number; color?: string }) {
  // Wrapped in a View so it stacks in DOM order above absolutely-positioned button tones on web.
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 48 48">
        {draw(name, color)}
      </Svg>
    </View>
  );
}

function chunkyStroke(d: string, fill: string) {
  return (
    <>
      <Path d={d} stroke={INK} strokeWidth={12} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d={d} stroke={fill} strokeWidth={5.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </>
  );
}

function draw(name: IconName, color?: string): React.ReactNode {
  switch (name) {
    case 'gem':
      return <Gem x={0} y={0} s={1} />;
    case 'back':
      return chunkyStroke('M29 11 L16 24 L29 37', color ?? '#FFFFFF');
    case 'play':
      return <Path d="M16 9 L39 24 L16 39 Z" fill={color ?? '#FFFFFF'} stroke={INK} strokeWidth={SW} strokeLinejoin="round" />;
    case 'plus':
      return chunkyStroke('M24 12 V36 M12 24 H36', color ?? '#FFFFFF');
    case 'minus':
      return chunkyStroke('M12 24 H36', color ?? '#FFFFFF');
    case 'check':
      return chunkyStroke('M11 25 L20 34 L37 14', color ?? '#FFFFFF');
    case 'cross':
      return chunkyStroke('M14 14 L34 34 M34 14 L14 34', color ?? '#FFFFFF');
    case 'cog': {
      const teeth = [0, 45, 90, 135, 180, 225, 270, 315];
      return (
        <G>
          {teeth.map((a) => (
            <Rect key={a} x={20} y={3} width={8} height={12} rx={2.5} fill={color ?? '#E7ECF7'} stroke={INK} strokeWidth={SW} transform={`rotate(${a} 24 24)`} />
          ))}
          <Circle cx={24} cy={24} r={15} fill={color ?? '#E7ECF7'} stroke={INK} strokeWidth={SW} />
          <Path d="M12 26 A12 12 0 0 0 36 26" fill="#B7C1DA" />
          <Circle cx={24} cy={24} r={6} fill={colors.info} stroke={INK} strokeWidth={SW} />
        </G>
      );
    }
    case 'lock':
      return (
        <G>
          <Path d="M15 22 V16 A9 9 0 0 1 33 16 V22" stroke={INK} strokeWidth={9} fill="none" strokeLinecap="round" />
          <Path d="M15 22 V16 A9 9 0 0 1 33 16 V22" stroke="#C9D2E6" strokeWidth={3.5} fill="none" strokeLinecap="round" />
          <Rect x={9} y={21} width={30} height={22} rx={6} fill={colors.gold} stroke={INK} strokeWidth={SW} />
          <Rect x={11.5} y={32} width={25} height={8.5} rx={3} fill={colors.goldShelf} />
          <Circle cx={24} cy={30} r={3.4} fill={INK} />
          <Rect x={22.6} y={30} width={2.8} height={7} rx={1.4} fill={INK} />
        </G>
      );
    case 'flame':
      return (
        <G>
          <Path d="M24 4 C30 12 39 18 39 30 C39 39 32 45 24 45 C16 45 9 39 9 30 C9 22 14 18 16 12 C19 17 20 19 22 20 C22 14 22 9 24 4 Z" fill="#FF7A1A" stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          <Path d="M24 22 C28 27 32 30 32 35 C32 40 28 43 24 43 C20 43 16 40 16 35 C16 31 19 29 20 26 C22 29 23 29 24 22 Z" fill={colors.gold} />
        </G>
      );
    case 'star':
      return <Path d="M24 4 L29.6 16.6 L43 17.8 L32.8 26.8 L35.8 40 L24 33 L12.2 40 L15.2 26.8 L5 17.8 L18.4 16.6 Z" fill={color ?? colors.gold} stroke={INK} strokeWidth={SW} strokeLinejoin="round" />;
    case 'cap':
      return (
        <G>
          <Path d="M13 24 V33 C13 37 35 37 35 33 V24" fill="#2B5FCC" stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          <Polygon points="24,9 45,19 24,29 3,19" fill={colors.info} stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          <Path d="M24 19 L39 24 V33" stroke={INK} strokeWidth={2.5} fill="none" />
          <Circle cx={39} cy={35} r={3.5} fill={colors.gold} stroke={INK} strokeWidth={2.5} />
        </G>
      );
    case 'smile':
      return (
        <G>
          <Circle cx={24} cy={24} r={19} fill={colors.gold} stroke={INK} strokeWidth={SW} />
          <Path d="M10 28 A15 15 0 0 0 38 28 A19 19 0 0 1 10 28 Z" fill={colors.goldShelf} />
          <Ellipse cx={17.5} cy={20} rx={2.8} ry={3.6} fill={INK} />
          <Ellipse cx={30.5} cy={20} rx={2.8} ry={3.6} fill={INK} />
          <Path d="M15 27 Q24 36 33 27" stroke={INK} strokeWidth={3.2} fill="none" strokeLinecap="round" />
        </G>
      );
    case 'exit':
      return (
        <G>
          <Rect x={7} y={6} width={22} height={36} rx={3} fill="#A9652B" stroke={INK} strokeWidth={SW} />
          <Rect x={11} y={10} width={14} height={28} rx={2} fill="#C98144" />
          <Circle cx={22} cy={25} r={2.2} fill={colors.gold} stroke={INK} strokeWidth={1.5} />
          {chunkyStroke('M27 24 H41 M35 17 L42 24 L35 31', '#FFFFFF')}
        </G>
      );
    case 'hourglass':
      return (
        <G>
          <Path d="M13 8 H35 C35 18 28 21 28 24 C28 27 35 30 35 40 H13 C13 30 20 27 20 24 C20 21 13 18 13 8 Z" fill="#E9F6FF" stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          <Path d="M17 37 C18 32 22 30 24 29 C26 30 30 32 31 37 Z" fill={colors.gold} />
          <Path d="M19 14 H29 C28 17 25 19 24 20 C23 19 20 17 19 14 Z" fill={colors.gold} />
          <Rect x={9} y={4} width={30} height={6} rx={3} fill="#A9652B" stroke={INK} strokeWidth={3} />
          <Rect x={9} y={38} width={30} height={6} rx={3} fill="#A9652B" stroke={INK} strokeWidth={3} />
        </G>
      );
    case 'clock':
      return (
        <G>
          <Circle cx={24} cy={25} r={18} fill="#FFFFFF" stroke={INK} strokeWidth={SW} />
          <Path d="M24 14 V25 L31 30" stroke={INK} strokeWidth={3.5} strokeLinecap="round" fill="none" />
          <Rect x={19} y={3} width={10} height={5} rx={2} fill={colors.danger} stroke={INK} strokeWidth={2.5} />
        </G>
      );
    case 'trophy':
      return (
        <G>
          <Path d="M12 10 C3 10 4 24 15 24 M36 10 C45 10 44 24 33 24" stroke={INK} strokeWidth={3.5} fill="none" />
          <Path d="M12 6 H36 V18 C36 26 30 30 24 30 C18 30 12 26 12 18 Z" fill={colors.gold} stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          <Path d="M28 9 H33 V18 C33 22 31 25 28 27 Z" fill={colors.goldShelf} />
          <Rect x={20} y={29} width={8} height={7} fill={colors.goldShelf} stroke={INK} strokeWidth={3} />
          <Rect x={13} y={36} width={22} height={7} rx={2.5} fill="#A9652B" stroke={INK} strokeWidth={SW} />
        </G>
      );
    case 'bolt':
      return <Path d="M28 3 L9 27 H22 L18 45 L39 19 H26 Z" fill={colors.gold} stroke={INK} strokeWidth={SW} strokeLinejoin="round" />;
    case 'target':
      return (
        <G>
          <Circle cx={22} cy={26} r={18} fill={colors.danger} stroke={INK} strokeWidth={SW} />
          <Circle cx={22} cy={26} r={12} fill="#FFFFFF" />
          <Circle cx={22} cy={26} r={6.5} fill={colors.danger} />
          <Path d="M22 26 L42 6" stroke={INK} strokeWidth={4} strokeLinecap="round" />
          <Path d="M36 5 L44 4 L43 12 Z" fill={colors.info} stroke={INK} strokeWidth={2.5} strokeLinejoin="round" />
        </G>
      );
    case 'magnifier':
      return (
        <G>
          <Path d="M30 30 L42 42" stroke={INK} strokeWidth={10} strokeLinecap="round" />
          <Path d="M30 30 L42 42" stroke="#A9652B" strokeWidth={5} strokeLinecap="round" />
          <Circle cx={20} cy={20} r={14} fill="#BFEFFF" stroke={INK} strokeWidth={SW} />
          <Path d="M12 18 A9 9 0 0 1 20 10" stroke="#FFFFFF" strokeWidth={3.5} fill="none" strokeLinecap="round" />
        </G>
      );
    case 'users':
      return (
        <G>
          <Circle cx={32} cy={16} r={7} fill="#FFC9A6" stroke={INK} strokeWidth={3} />
          <Path d="M20 40 C20 28 44 28 44 40 Z" fill={colors.cta} stroke={INK} strokeWidth={3} strokeLinejoin="round" />
          <Circle cx={18} cy={18} r={8} fill="#FFD9BD" stroke={INK} strokeWidth={3} />
          <Path d="M4 42 C4 29 32 29 32 42 Z" fill={colors.info} stroke={INK} strokeWidth={3} strokeLinejoin="round" />
        </G>
      );
    case 'bot':
      return (
        <G>
          <Line x1={24} y1={4} x2={24} y2={12} stroke={INK} strokeWidth={3} />
          <Circle cx={24} cy={5} r={3.5} fill={colors.danger} stroke={INK} strokeWidth={2.5} />
          <Rect x={8} y={12} width={32} height={26} rx={9} fill="#B9C6E4" stroke={INK} strokeWidth={SW} />
          <Rect x={13} y={18} width={22} height={13} rx={6} fill={colors.inkSoft} />
          <Circle cx={19} cy={24.5} r={3} fill={colors.gem} />
          <Circle cx={29} cy={24.5} r={3} fill={colors.gem} />
        </G>
      );
    case 'shield':
      return (
        <G>
          <Path d="M24 4 L40 10 V22 C40 33 33 40 24 44 C15 40 8 33 8 22 V10 Z" fill={color ?? colors.cta} stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          <Path d="M24 8 L36 13 V22 C36 30 31 36 24 39 Z" fill="rgba(0,0,0,0.12)" />
          {chunkyStroke('M16 24 L22 30 L32 18', '#FFFFFF')}
        </G>
      );
    case 'warning':
      return (
        <G>
          <Path d="M24 5 L44 41 H4 Z" fill={colors.gold} stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          <Rect x={21.5} y={16} width={5} height={14} rx={2.5} fill={INK} />
          <Circle cx={24} cy={35} r={2.8} fill={INK} />
        </G>
      );
    case 'share':
      return (
        <G>
          <Path d="M10 22 V40 H38 V22" stroke={INK} strokeWidth={10} fill="none" strokeLinejoin="round" strokeLinecap="round" />
          <Path d="M10 22 V40 H38 V22" stroke="#FFFFFF" strokeWidth={4.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
          {chunkyStroke('M24 30 V8 M16 15 L24 7 L32 15', '#FFFFFF')}
        </G>
      );
    case 'book':
      return (
        <G>
          <Path d="M24 12 C18 8 10 8 4 10 V40 C10 38 18 38 24 42 Z" fill="#FFFFFF" stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          <Path d="M24 12 C30 8 38 8 44 10 V40 C38 38 30 38 24 42 Z" fill="#E8F4FF" stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          <Path d="M9 17 C13 16 16 16 19 17.5 M9 23 C13 22 16 22 19 23.5 M29 17.5 C32 16 35 16 39 17 M29 23.5 C32 22 35 22 39 23" stroke={colors.info} strokeWidth={2.5} strokeLinecap="round" fill="none" />
        </G>
      );
    case 'crown':
      return (
        <G>
          <Path d="M5 16 L15 26 L24 10 L33 26 L43 16 L39 38 H9 Z" fill={color ?? colors.gold} stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          <Rect x={9} y={33} width={30} height={5} fill="rgba(0,0,0,0.15)" />
          <Circle cx={24} cy={28} r={3.5} fill={colors.danger} stroke={INK} strokeWidth={2} />
          <Circle cx={5} cy={15} r={3} fill={color ?? colors.gold} stroke={INK} strokeWidth={2.5} />
          <Circle cx={24} cy={8} r={3} fill={color ?? colors.gold} stroke={INK} strokeWidth={2.5} />
          <Circle cx={43} cy={15} r={3} fill={color ?? colors.gold} stroke={INK} strokeWidth={2.5} />
        </G>
      );
    case 'wall':
      return (
        <G>
          <Rect x={10} y={8} width={28} height={34} rx={5} fill={colors.ivory} stroke={INK} strokeWidth={SW} />
          <Rect x={10} y={8} width={28} height={28} rx={5} fill={colors.feltLight} stroke={INK} strokeWidth={SW} />
          <Path d="M24 15 L30 22 L24 29 L18 22 Z" fill="rgba(255,255,255,0.55)" />
        </G>
      );
    case 'heart':
      return <Path d="M24 42 C10 32 4 25 4 17 C4 10 9 6 15 6 C19 6 22 8 24 12 C26 8 29 6 33 6 C39 6 44 10 44 17 C44 25 38 32 24 42 Z" fill={colors.danger} stroke={INK} strokeWidth={SW} strokeLinejoin="round" />;
    case 'scroll':
      return (
        <G>
          <Rect x={9} y={10} width={30} height={28} fill="#FFF1CF" stroke={INK} strokeWidth={SW} />
          <Rect x={5} y={6} width={38} height={7} rx={3.5} fill="#B5722F" stroke={INK} strokeWidth={3} />
          <Rect x={5} y={35} width={38} height={7} rx={3.5} fill="#B5722F" stroke={INK} strokeWidth={3} />
          <Path d="M15 20 H33 M15 27 H28" stroke={colors.danger} strokeWidth={3} strokeLinecap="round" />
        </G>
      );
    case 'pencil':
      return (
        <G>
          <Path d="M10 38 L12 30 L32 10 L38 16 L18 36 Z" fill={colors.gold} stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          <Path d="M28 14 L34 20" stroke={INK} strokeWidth={3} />
          <Path d="M10 38 L12 30 L18 36 Z" fill="#FFD9BD" stroke={INK} strokeWidth={2.5} strokeLinejoin="round" />
        </G>
      );
    default:
      return null;
  }
}

/** A single faceted gem, drawn in a 48×48 box at (x, y) scaled by s. */
export function Gem({ x, y, s, hue = 'blue' }: { x: number; y: number; s: number; hue?: 'blue' | 'purple' | 'red' | 'green' | 'gold' }) {
  const pal = GEM_HUES[hue];
  return (
    <G transform={`translate(${x} ${y}) scale(${s})`}>
      <Polygon points="12,9 36,9 45,19 24,43 3,19" fill={pal.fill} stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
      <Polygon points="12,9 36,9 45,19 3,19" fill={pal.light} />
      <Polygon points="24,43 45,19 31,19" fill={pal.shade} />
      <Polygon points="24,43 17,19 31,19" fill={pal.fill} />
      <Polygon points="12,9 36,9 45,19 24,43 3,19" fill="none" stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
      <Line x1={4} y1={19} x2={44} y2={19} stroke={INK} strokeWidth={2} />
      <Polygon points="14,12 21,12 18,17" fill="#FFFFFF" opacity={0.9} />
    </G>
  );
}

export const GEM_HUES = {
  blue: { fill: '#38D6FF', light: '#A6F0FF', shade: '#1A93D9' },
  purple: { fill: '#B35CFF', light: '#DDB2FF', shade: '#7E3AE0' },
  red: { fill: '#FF4F6D', light: '#FFA6B5', shade: '#C7243F' },
  green: { fill: '#3FD67A', light: '#A8F5C6', shade: '#1E9E57' },
  gold: { fill: '#FFC53D', light: '#FFE79E', shade: '#E09A00' },
} as const;
