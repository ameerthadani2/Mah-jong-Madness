/**
 * Drawn emotes. Emote ids travel over the network (≤16 chars); anything we do
 * not recognise (e.g. text from an older client) is shown as plain text.
 */
import React from 'react';
import { Text } from 'react-native';
import Svg, { Circle, Ellipse, G, Path, Rect, Text as SvgText } from 'react-native-svg';
import { colors } from '../theme';

const INK = colors.ink;

export const EMOTE_IDS = ['thumbs', 'lol', 'wow', 'cry', 'fire', 'love', 'zzz', 'hu'] as const;
export type EmoteId = (typeof EMOTE_IDS)[number];

function face(children: React.ReactNode) {
  return (
    <G>
      <Circle cx={24} cy={25} r={19} fill={colors.gold} stroke={INK} strokeWidth={3.5} />
      <Path d="M9 30 A16 16 0 0 0 39 30 A19 19 0 0 1 9 30 Z" fill={colors.goldShelf} />
      <Ellipse cx={17} cy={13} rx={5} ry={2.5} fill="#FFFFFF" opacity={0.7} transform="rotate(-25 17 13)" />
      {children}
    </G>
  );
}

function art(id: EmoteId): React.ReactNode {
  switch (id) {
    case 'thumbs':
      return (
        <G>
          <Rect x={6} y={22} width={10} height={20} rx={3} fill={colors.info} stroke={INK} strokeWidth={3} />
          <Path d="M16 24 H24 L22 10 C22 6 28 5 29 9 L31 20 H39 C42 20 43 23 42 26 L39 39 C38 41 37 42 35 42 H16 Z" fill="#FFD9BD" stroke={INK} strokeWidth={3} strokeLinejoin="round" />
          <Path d="M31 27 H40 M31 33 H39" stroke={INK} strokeWidth={2.2} strokeLinecap="round" />
        </G>
      );
    case 'lol':
      return face(
        <G>
          <Path d="M12 20 Q16 15 20 20 M28 20 Q32 15 36 20" stroke={INK} strokeWidth={3} fill="none" strokeLinecap="round" />
          <Path d="M13 27 H35 Q34 38 24 38 Q14 38 13 27 Z" fill="#8B1E2D" stroke={INK} strokeWidth={2.6} strokeLinejoin="round" />
          <Path d="M17 34 Q24 30 31 34 Q28 38 24 38 Q20 38 17 34 Z" fill="#FF7F8F" />
          <Path d="M6 20 Q2 26 6 29 Q10 26 6 20 Z M42 20 Q38 26 42 29 Q46 26 42 20 Z" fill="#63C7FF" stroke={INK} strokeWidth={1.8} />
        </G>,
      );
    case 'wow':
      return face(
        <G>
          <Circle cx={17} cy={20} r={4} fill="#FFFFFF" stroke={INK} strokeWidth={2.4} />
          <Circle cx={31} cy={20} r={4} fill="#FFFFFF" stroke={INK} strokeWidth={2.4} />
          <Circle cx={17} cy={20.5} r={2} fill={INK} />
          <Circle cx={31} cy={20.5} r={2} fill={INK} />
          <Ellipse cx={24} cy={32} rx={5} ry={6} fill="#8B1E2D" stroke={INK} strokeWidth={2.6} />
        </G>,
      );
    case 'cry':
      return face(
        <G>
          <Path d="M12 19 Q17 22 21 18 M27 18 Q31 22 36 19" stroke={INK} strokeWidth={3} fill="none" strokeLinecap="round" />
          <Path d="M15 22 V40 M33 22 V40" stroke="#63C7FF" strokeWidth={4.5} strokeLinecap="round" />
          <Path d="M18 35 Q24 29 30 35" stroke={INK} strokeWidth={3} fill="none" strokeLinecap="round" />
        </G>,
      );
    case 'fire':
      return (
        <G>
          <Path d="M24 4 C30 12 39 18 39 30 C39 39 32 45 24 45 C16 45 9 39 9 30 C9 22 14 18 16 12 C19 17 20 19 22 20 C22 14 22 9 24 4 Z" fill="#FF7A1A" stroke={INK} strokeWidth={3.5} strokeLinejoin="round" />
          <Path d="M24 22 C28 27 32 30 32 35 C32 40 28 43 24 43 C20 43 16 40 16 35 C16 31 19 29 20 26 C22 29 23 29 24 22 Z" fill={colors.gold} />
        </G>
      );
    case 'love':
      return face(
        <G>
          <Path d="M17 23 C11 19 11 14 14 13 C16 12 17 14 17 15 C17 14 18 12 20 13 C23 14 23 19 17 23 Z" fill={colors.danger} stroke={INK} strokeWidth={1.8} />
          <Path d="M31 23 C25 19 25 14 28 13 C30 12 31 14 31 15 C31 14 32 12 34 13 C37 14 37 19 31 23 Z" fill={colors.danger} stroke={INK} strokeWidth={1.8} />
          <Path d="M16 29 Q24 37 32 29" stroke={INK} strokeWidth={3} fill="none" strokeLinecap="round" />
        </G>,
      );
    case 'zzz':
      return face(
        <G>
          <Path d="M12 22 H21 M27 22 H36" stroke={INK} strokeWidth={3} strokeLinecap="round" />
          <Ellipse cx={24} cy={33} rx={3.5} ry={2.5} fill="#8B1E2D" />
          <SvgText x={40} y={14} fontSize={13} fontWeight="900" fill={colors.info} stroke={INK} strokeWidth={0.8} textAnchor="middle">
            Z
          </SvgText>
        </G>,
      );
    case 'hu':
      return (
        <G>
          <Rect x={11} y={5} width={26} height={38} rx={5} fill={colors.feltDark} stroke={INK} strokeWidth={3} />
          <Rect x={11} y={5} width={26} height={33} rx={5} fill="#FFF9EE" stroke={INK} strokeWidth={3} />
          <SvgText x={24} y={30} fontSize={20} fontWeight="900" fill={colors.red} textAnchor="middle">
            中
          </SvgText>
        </G>
      );
    default:
      return null;
  }
}

export function isEmoteId(s: string): s is EmoteId {
  return (EMOTE_IDS as readonly string[]).includes(s);
}

export function Emote({ id, size = 32 }: { id: string; size?: number }) {
  if (!isEmoteId(id)) return <Text style={{ fontSize: size * 0.6, fontWeight: '900', color: colors.ink }}>{id}</Text>;
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      {art(id)}
    </Svg>
  );
}
