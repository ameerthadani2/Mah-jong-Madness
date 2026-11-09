/**
 * The emotes of the paid emote packs (monetisation/cosmetics.ts `EMOTE_PACKS`), drawn in the
 * same 48-unit box and ink style as the free emotes (components/Emotes.tsx). Food, festival and
 * zodiac motifs only: no coins, chips or money.
 */
import React from 'react';
import Svg, { Circle, Ellipse, G, Path, Polygon, Rect } from 'react-native-svg';
import { isPackEmoteId, type PackEmoteId } from '../monetisation/cosmetics';
import { colors } from '../theme';

const INK = colors.ink;
const SW = 3;

/** A round animal face for the zodiac pack: the head, its ears and its own features. */
function animal(fill: string, ears: React.ReactNode, features: React.ReactNode) {
  return (
    <G>
      {ears}
      <Circle cx={24} cy={27} r={16} fill={fill} stroke={INK} strokeWidth={SW} />
      <Circle cx={18} cy={25} r={2.2} fill={INK} />
      <Circle cx={30} cy={25} r={2.2} fill={INK} />
      {features}
    </G>
  );
}

function art(id: PackEmoteId): React.ReactNode {
  switch (id) {
    // ---- Tea House
    case 'th.tea':
      return (
        <G>
          <Path d="M10 20 H34 V30 C34 38 28 42 22 42 C16 42 10 38 10 30 Z" fill="#FFFFFF" stroke={INK} strokeWidth={SW} />
          <Path d="M34 24 C42 24 42 34 34 34" fill="none" stroke={INK} strokeWidth={SW} />
          <Rect x={13} y={22} width={18} height={5} fill="#7CC36A" />
          <Path d="M16 14 Q19 10 16 6 M24 14 Q27 10 24 6" stroke={colors.inkSoft} strokeWidth={2.4} fill="none" strokeLinecap="round" />
        </G>
      );
    case 'th.bun':
      return (
        <G>
          <Path d="M8 34 C8 20 16 12 24 12 C32 12 40 20 40 34 Z" fill="#FFF6E6" stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          <Path d="M24 14 Q20 22 16 30 M24 14 Q24 23 24 31 M24 14 Q28 22 32 30" stroke="#E2CFAE" strokeWidth={2.4} fill="none" />
          <Rect x={6} y={34} width={36} height={6} rx={3} fill="#C9A26B" stroke={INK} strokeWidth={2.4} />
        </G>
      );
    case 'th.dumpling':
      return (
        <G>
          <Path d="M6 32 C6 18 42 18 42 32 C42 38 6 38 6 32 Z" fill="#FFF8EC" stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          <Path d="M10 24 Q13 19 16 24 Q19 19 22 24 Q25 19 28 24 Q31 19 34 24 Q37 19 40 25" stroke={INK} strokeWidth={2.2} fill="none" />
        </G>
      );
    case 'th.noodles':
      return (
        <G>
          <Path d="M14 6 L22 26 M22 6 L26 26" stroke="#B5722F" strokeWidth={2.6} strokeLinecap="round" />
          <Path d="M6 24 H42 C42 34 34 42 24 42 C14 42 6 34 6 24 Z" fill={colors.danger} stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          <Path d="M10 24 Q16 18 22 24 T34 24" stroke="#FFE8A3" strokeWidth={3} fill="none" />
        </G>
      );
    case 'th.mooncake':
      return (
        <G>
          <Circle cx={24} cy={25} r={17} fill="#D99A55" stroke={INK} strokeWidth={SW} />
          <Circle cx={24} cy={25} r={11} fill="none" stroke="#8C5420" strokeWidth={2.4} />
          <Path d="M24 17 V33 M16 25 H32" stroke="#8C5420" strokeWidth={2.4} />
        </G>
      );
    case 'th.tangerine':
      return (
        <G>
          <Circle cx={24} cy={28} r={15} fill="#FF9A1A" stroke={INK} strokeWidth={SW} />
          <Path d="M24 13 Q30 6 38 10 Q32 16 24 13 Z" fill="#35A85A" stroke={INK} strokeWidth={2.4} strokeLinejoin="round" />
          <Ellipse cx={18} cy={23} rx={4} ry={2.5} fill="#FFFFFF" opacity={0.6} />
        </G>
      );
    // ---- Night Market
    case 'nm.boba':
      return (
        <G>
          <Path d="M27 4 L30 16" stroke={colors.danger} strokeWidth={3} strokeLinecap="round" />
          <Path d="M12 14 H36 L32 42 H16 Z" fill="#E8C9A0" stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          {[18, 24, 30, 21, 27].map((x, i) => (
            <Circle key={i} cx={x} cy={i < 3 ? 36 : 32} r={2.4} fill={INK} />
          ))}
        </G>
      );
    case 'nm.skewer':
      return (
        <G>
          <Path d="M8 42 L40 8" stroke="#B5722F" strokeWidth={3} strokeLinecap="round" />
          {[
            [16, 33],
            [24, 25],
            [32, 17],
          ].map(([x, y]) => (
            <Rect key={x} x={x - 5} y={y - 5} width={10} height={10} rx={3} fill="#C2321B" stroke={INK} strokeWidth={2.4} transform={`rotate(45 ${x} ${y})`} />
          ))}
        </G>
      );
    case 'nm.shavedice':
      return (
        <G>
          <Path d="M10 24 C10 12 38 12 38 24 Z" fill="#FFFFFF" stroke={INK} strokeWidth={SW} />
          <Path d="M14 20 Q20 14 26 20" stroke="#FF6B9A" strokeWidth={3} fill="none" />
          <Circle cx={30} cy={18} r={2.6} fill="#35A85A" />
          <Path d="M8 24 H40 L34 40 H14 Z" fill={colors.info} stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
        </G>
      );
    case 'nm.corn':
      return (
        <G>
          <Path d="M24 6 C34 10 34 34 24 42 C14 34 14 10 24 6 Z" fill={colors.gold} stroke={INK} strokeWidth={SW} />
          <Path d="M19 16 H29 M18 22 H30 M18 28 H30 M19 34 H29 M24 8 V40" stroke="#C98144" strokeWidth={1.8} />
          <Path d="M24 42 C14 40 10 30 12 22 C16 30 20 36 24 42 Z" fill="#35A85A" stroke={INK} strokeWidth={2.2} />
        </G>
      );
    case 'nm.lantern':
      return (
        <G>
          <Path d="M24 4 V9" stroke={INK} strokeWidth={2.4} />
          <Rect x={16} y={9} width={16} height={4} rx={1.5} fill={colors.gold} stroke={INK} strokeWidth={2.2} />
          <Ellipse cx={24} cy={25} rx={14} ry={12} fill={colors.danger} stroke={INK} strokeWidth={SW} />
          <Path d="M24 13 V37 M17 15 Q12 25 17 35 M31 15 Q36 25 31 35" stroke="#8A1A12" strokeWidth={1.8} fill="none" />
          <Rect x={16} y={37} width={16} height={4} rx={1.5} fill={colors.gold} stroke={INK} strokeWidth={2.2} />
          <Path d="M24 41 V46" stroke={colors.gold} strokeWidth={2.4} />
        </G>
      );
    case 'nm.firecracker':
      return (
        <G>
          <Rect x={14} y={14} width={12} height={28} rx={3} fill={colors.danger} stroke={INK} strokeWidth={SW} transform="rotate(-20 20 28)" />
          <Path d="M24 12 Q28 6 32 8" stroke={INK} strokeWidth={2.2} fill="none" />
          <Path d="M34 4 L36 8 L40 7 L37 10 L40 13 L36 12 L34 16 L33 12 L29 12 L32 9 Z" fill={colors.gold} stroke={INK} strokeWidth={1.6} strokeLinejoin="round" />
        </G>
      );
    // ---- Festival
    case 'fs.firework':
      return (
        <G stroke={INK} strokeWidth={2.2} strokeLinecap="round">
          {Array.from({ length: 8 }, (_, i) => {
            const a = (i * Math.PI) / 4;
            return <Path key={i} d={`M${24 + Math.cos(a) * 6} ${22 + Math.sin(a) * 6} L${24 + Math.cos(a) * 17} ${22 + Math.sin(a) * 17}`} stroke={i % 2 ? colors.gold : colors.danger} strokeWidth={3.4} />;
          })}
          <Circle cx={24} cy={22} r={4} fill={colors.gold} />
          <Path d="M24 40 V46" stroke={colors.inkSoft} />
        </G>
      );
    case 'fs.knot':
      return (
        <G stroke={INK} strokeWidth={2.4} strokeLinejoin="round">
          <Rect x={14} y={10} width={20} height={20} fill={colors.danger} transform="rotate(45 24 20)" />
          <Path d="M17 13 L31 27 M31 13 L17 27" stroke="#FFD34D" strokeWidth={2.2} />
          <Path d="M20 32 L18 44 M24 32 V46 M28 32 L30 44" stroke={colors.danger} strokeWidth={3} />
        </G>
      );
    case 'fs.drum':
      return (
        <G>
          <Ellipse cx={24} cy={16} rx={16} ry={6} fill="#FFF0D0" stroke={INK} strokeWidth={SW} />
          <Path d="M8 16 V32 C8 40 40 40 40 32 V16" fill={colors.danger} stroke={INK} strokeWidth={SW} />
          <Ellipse cx={24} cy={16} rx={16} ry={6} fill="#FFF0D0" stroke={INK} strokeWidth={SW} />
          <Path d="M36 4 L28 14 M42 8 L32 16" stroke="#B5722F" strokeWidth={3} strokeLinecap="round" />
        </G>
      );
    case 'fs.kite':
      return (
        <G>
          <Polygon points="24,4 38,20 24,34 10,20" fill={colors.info} stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          <Path d="M24 4 V34 M10 20 H38" stroke={INK} strokeWidth={1.8} />
          <Path d="M24 34 Q20 38 24 40 Q28 42 24 46" stroke={colors.danger} strokeWidth={2.4} fill="none" />
        </G>
      );
    case 'fs.moon':
      return (
        <G>
          <Circle cx={24} cy={24} r={17} fill="#FFE8A3" stroke={INK} strokeWidth={SW} />
          <Circle cx={18} cy={20} r={3} fill="#E9C46A" />
          <Circle cx={29} cy={30} r={4} fill="#E9C46A" />
          <Path d="M8 40 Q24 34 40 40" stroke="#7A86E8" strokeWidth={3} fill="none" strokeLinecap="round" />
        </G>
      );
    case 'fs.dragonboat':
      return (
        <G>
          <Path d="M4 28 H40 C40 36 34 40 26 40 H14 C8 40 4 34 4 28 Z" fill={colors.danger} stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          <Path d="M40 28 C42 20 38 14 32 14 L36 20 L32 22 Z" fill="#35A85A" stroke={INK} strokeWidth={2.4} strokeLinejoin="round" />
          <Path d="M12 28 V20 M20 28 V18 M28 28 V20" stroke={INK} strokeWidth={2.4} strokeLinecap="round" />
          <Path d="M4 44 Q14 40 24 44 T44 44" stroke={colors.info} strokeWidth={2.6} fill="none" />
        </G>
      );
    // ---- Zodiac
    case 'zd.rat':
      return animal('#B9C6E4', <G><Circle cx={11} cy={14} r={7} fill="#B9C6E4" stroke={INK} strokeWidth={SW} /><Circle cx={37} cy={14} r={7} fill="#B9C6E4" stroke={INK} strokeWidth={SW} /></G>, <G><Circle cx={24} cy={32} r={2.6} fill="#FF8AA0" /><Path d="M14 33 H6 M14 35 L7 38 M34 33 H42 M34 35 L41 38" stroke={INK} strokeWidth={1.4} /></G>);
    case 'zd.ox':
      return animal('#C98144', <Path d="M10 18 C4 12 6 6 10 6 C10 12 14 14 16 15 M38 18 C44 12 42 6 38 6 C38 12 34 14 32 15" fill="#FFF0D0" stroke={INK} strokeWidth={2.4} />, <G><Ellipse cx={24} cy={34} rx={8} ry={5} fill="#E8C9A0" stroke={INK} strokeWidth={2} /><Circle cx={21} cy={34} r={1.2} fill={INK} /><Circle cx={27} cy={34} r={1.2} fill={INK} /></G>);
    case 'zd.tiger':
      return animal('#FF9A1A', <G><Circle cx={12} cy={14} r={5} fill="#FF9A1A" stroke={INK} strokeWidth={SW} /><Circle cx={36} cy={14} r={5} fill="#FF9A1A" stroke={INK} strokeWidth={SW} /></G>, <G><Path d="M24 13 V18 M20 14 L21 18 M28 14 L27 18 M9 26 H13 M35 26 H39" stroke={INK} strokeWidth={2} /><Path d="M20 33 Q24 36 28 33" stroke={INK} strokeWidth={2} fill="none" /></G>);
    case 'zd.rabbit':
      return animal('#FFFFFF', <G><Ellipse cx={17} cy={9} rx={4} ry={10} fill="#FFFFFF" stroke={INK} strokeWidth={SW} /><Ellipse cx={31} cy={9} rx={4} ry={10} fill="#FFFFFF" stroke={INK} strokeWidth={SW} /></G>, <G><Circle cx={24} cy={31} r={2} fill="#FF8AA0" /><Circle cx={14} cy={31} r={3} fill="#FFC2D1" /><Circle cx={34} cy={31} r={3} fill="#FFC2D1" /></G>);
    case 'zd.dragon':
      return animal('#35A85A', <Path d="M14 14 L10 2 L19 11 M34 14 L38 2 L29 11" fill="#FFD34D" stroke={INK} strokeWidth={2.4} strokeLinejoin="round" />, <G><Path d="M18 34 Q24 38 30 34" stroke={INK} strokeWidth={2} fill="none" /><Path d="M12 30 Q4 32 4 40 M36 30 Q44 32 44 40" stroke={colors.gold} strokeWidth={2.4} fill="none" /></G>);
    case 'zd.rooster':
      return animal('#FFF6E6', <Path d="M18 12 Q18 4 22 6 Q24 0 27 6 Q32 4 30 12 Z" fill={colors.danger} stroke={INK} strokeWidth={2.4} strokeLinejoin="round" />, <G><Polygon points="21,29 27,29 24,35" fill="#FF9A1A" stroke={INK} strokeWidth={1.8} strokeLinejoin="round" /><Ellipse cx={24} cy={38} rx={2.5} ry={3} fill={colors.danger} /></G>);
  }
}

/** One pack emote at `size`; null for an id that is not a pack emote. */
export function PackEmote({ id, size = 32 }: { id: string; size?: number }) {
  if (!isPackEmoteId(id)) return null;
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      {art(id)}
    </Svg>
  );
}
