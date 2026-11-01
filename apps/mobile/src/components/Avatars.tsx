/**
 * Animal-bust avatars drawn in SVG: big heads, dot eyes, thick ink outline,
 * flat two-tone shading. Avatar ids are stored in the profile (see storage.ts);
 * legacy emoji values from older builds map onto the closest animal.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, ClipPath, Defs, Ellipse, G, Path, Polygon } from 'react-native-svg';
import { colors } from '../theme';

const INK = colors.ink;
const SW = 4;

export const AVATAR_IDS = ['panda', 'tiger', 'fox', 'frog', 'owl', 'cat', 'bunny', 'bear', 'monkey', 'penguin', 'pig', 'koala'] as const;
export type AvatarId = (typeof AVATAR_IDS)[number];

export const AVATAR_NAMES: Record<AvatarId, string> = {
  panda: 'Panda',
  tiger: 'Tiger',
  fox: 'Fox',
  frog: 'Frog',
  owl: 'Owl',
  cat: 'Cat',
  bunny: 'Bunny',
  bear: 'Bear',
  monkey: 'Monkey',
  penguin: 'Penguin',
  pig: 'Piglet',
  koala: 'Koala',
};

const LEGACY: Record<string, AvatarId> = {
  '🐼': 'panda',
  '🐯': 'tiger',
  '🦁': 'tiger',
  '🦊': 'fox',
  '🐸': 'frog',
  '🐉': 'frog',
  '🦉': 'owl',
  '🍵': 'owl',
  '🐱': 'cat',
  '🐰': 'bunny',
  '🦄': 'bunny',
  '🌸': 'bunny',
  '🐻': 'bear',
  '🐵': 'monkey',
  '🐧': 'penguin',
  '🐷': 'pig',
  '🐙': 'pig',
  '🐨': 'koala',
  '🎋': 'panda',
  '🧧': 'fox',
  '🀄': 'panda',
};

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Resolve whatever is stored (id, legacy emoji, nothing) to a drawable avatar. */
export function resolveAvatar(value: string | undefined | null, fallbackSeed = ''): AvatarId {
  if (value && (AVATAR_IDS as readonly string[]).includes(value)) return value as AvatarId;
  if (value && LEGACY[value]) return LEGACY[value];
  const seed = value || fallbackSeed;
  return AVATAR_IDS[hash(seed) % AVATAR_IDS.length];
}

const BOT_AVATARS: AvatarId[] = ['tiger', 'fox', 'frog', 'cat'];

/** Avatar for a table seat: the player's pick, a fixed animal per bot seat, or a stable hash of the name. */
export function seatAvatarId(info: { avatar?: string; isBot?: boolean; name?: string } | undefined, seat: number): string {
  if (info?.avatar) return info.avatar;
  if (info?.isBot) return BOT_AVATARS[seat % BOT_AVATARS.length];
  return resolveAvatar(undefined, info?.name || `seat-${seat}`);
}

interface Look {
  bg: string;
  shirt: string;
  shirtShade: string;
}

const LOOKS: Record<AvatarId, Look> = {
  panda: { bg: '#BDEBFF', shirt: '#52C41A', shirtShade: '#3A9A0E' },
  tiger: { bg: '#FFE08A', shirt: '#FF5A5F', shirtShade: '#C73A40' },
  fox: { bg: '#CFF5D6', shirt: '#2F8CFF', shirtShade: '#1C5FCC' },
  frog: { bg: '#FFD6E7', shirt: '#FFC53D', shirtShade: '#E09A00' },
  owl: { bg: '#D9CCFF', shirt: '#C68A55', shirtShade: '#9A6234' },
  cat: { bg: '#FFF0B3', shirt: '#B35CFF', shirtShade: '#7E3AE0' },
  bunny: { bg: '#C8F0FF', shirt: '#FF7AA8', shirtShade: '#D6336C' },
  bear: { bg: '#D4F5C8', shirt: '#2F8CFF', shirtShade: '#1C5FCC' },
  monkey: { bg: '#FFE1C7', shirt: '#52C41A', shirtShade: '#3A9A0E' },
  penguin: { bg: '#BFEFFF', shirt: '#FF5A5F', shirtShade: '#C73A40' },
  pig: { bg: '#D8F3FF', shirt: '#FFC53D', shirtShade: '#E09A00' },
  koala: { bg: '#E6F9D9', shirt: '#FF8C1A', shirtShade: '#C96A00' },
};

const eyes = (lx: number, rx: number, y: number, r = 3.8) => (
  <G>
    <Circle cx={lx} cy={y} r={r} fill={INK} />
    <Circle cx={rx} cy={y} r={r} fill={INK} />
    <Circle cx={lx + 1.2} cy={y - 1.3} r={r * 0.36} fill="#FFFFFF" />
    <Circle cx={rx + 1.2} cy={y - 1.3} r={r * 0.36} fill="#FFFFFF" />
  </G>
);
const cheeks = (lx: number, rx: number, y: number) => (
  <G opacity={0.6}>
    <Ellipse cx={lx} cy={y} rx={5} ry={3} fill="#FF7FA0" />
    <Ellipse cx={rx} cy={y} rx={5} ry={3} fill="#FF7FA0" />
  </G>
);
const smile = (y: number, w = 4) => <Path d={`M${50 - w} ${y} Q50 ${y + 4} ${50 + w} ${y}`} stroke={INK} strokeWidth={2.6} fill="none" strokeLinecap="round" />;
/** Head shading: a crescent on the lower right in a darker tone. */
const shade = (cx: number, cy: number, r: number, fill: string) => <Path d={`M${cx + r * 0.2} ${cy + r * 0.98} A${r} ${r} 0 0 0 ${cx + r * 0.98} ${cy + r * 0.2} A${r * 1.25} ${r * 1.25} 0 0 1 ${cx + r * 0.2} ${cy + r * 0.98} Z`} fill={fill} />;

function head(id: AvatarId): React.ReactNode {
  switch (id) {
    case 'panda':
      return (
        <G>
          <Circle cx={28} cy={26} r={10} fill="#2A2D3E" stroke={INK} strokeWidth={SW} />
          <Circle cx={72} cy={26} r={10} fill="#2A2D3E" stroke={INK} strokeWidth={SW} />
          <Circle cx={50} cy={49} r={28} fill="#FFFFFF" stroke={INK} strokeWidth={SW} />
          {shade(50, 49, 26, '#E2E8F2')}
          <Ellipse cx={39} cy={48} rx={7.5} ry={9.5} transform="rotate(25 39 48)" fill="#2A2D3E" />
          <Ellipse cx={61} cy={48} rx={7.5} ry={9.5} transform="rotate(-25 61 48)" fill="#2A2D3E" />
          <Circle cx={40} cy={47} r={3} fill="#FFFFFF" />
          <Circle cx={60} cy={47} r={3} fill="#FFFFFF" />
          <Circle cx={40.5} cy={47.5} r={1.6} fill={INK} />
          <Circle cx={60.5} cy={47.5} r={1.6} fill={INK} />
          <Ellipse cx={50} cy={58} rx={4.5} ry={3.2} fill={INK} />
          {smile(62, 3.5)}
          {cheeks(31, 69, 58)}
        </G>
      );
    case 'tiger':
      return (
        <G>
          <Circle cx={28} cy={27} r={10} fill="#FF9A2E" stroke={INK} strokeWidth={SW} />
          <Circle cx={72} cy={27} r={10} fill="#FF9A2E" stroke={INK} strokeWidth={SW} />
          <Circle cx={28} cy={27} r={4.5} fill="#FFE3C2" />
          <Circle cx={72} cy={27} r={4.5} fill="#FFE3C2" />
          <Circle cx={50} cy={50} r={28} fill="#FF9A2E" stroke={INK} strokeWidth={SW} />
          {shade(50, 50, 26, '#E57A10')}
          <Ellipse cx={50} cy={61} rx={14} ry={10} fill="#FFF4E3" />
          <Path d="M50 24 V32 M42 25 L44 31 M58 25 L56 31 M24 46 L31 48 M24 54 L31 54 M76 46 L69 48 M76 54 L69 54" stroke={INK} strokeWidth={3.2} strokeLinecap="round" />
          {eyes(40, 60, 46)}
          <Polygon points="45.5,55 54.5,55 50,60" fill="#FF6F91" stroke={INK} strokeWidth={2} strokeLinejoin="round" />
          <Path d="M50 60 Q47 65 43 62 M50 60 Q53 65 57 62" stroke={INK} strokeWidth={2.4} fill="none" strokeLinecap="round" />
        </G>
      );
    case 'fox':
      return (
        <G>
          <Polygon points="20,40 25,10 46,26" fill="#FF7A30" stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          <Polygon points="80,40 75,10 54,26" fill="#FF7A30" stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          <Polygon points="27,30 28,19 37,26" fill="#2A2D3E" />
          <Polygon points="73,30 72,19 63,26" fill="#2A2D3E" />
          <Path d="M21 44 C21 28 36 22 50 22 C64 22 79 28 79 44 C79 58 63 72 50 75 C37 72 21 58 21 44 Z" fill="#FF7A30" stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          <Path d="M23 48 C32 50 42 56 50 73 C38 70 26 60 23 48 Z M77 48 C68 50 58 56 50 73 C62 70 74 60 77 48 Z" fill="#FFFFFF" />
          {eyes(39, 61, 44)}
          <Ellipse cx={50} cy={66} rx={4.5} ry={3.2} fill={INK} />
        </G>
      );
    case 'frog':
      return (
        <G>
          <Ellipse cx={50} cy={53} rx={33} ry={24} fill="#6DD35A" stroke={INK} strokeWidth={SW} />
          <Path d="M24 64 C34 74 66 74 76 64 C70 72 60 77 50 77 C40 77 30 72 24 64 Z" fill="#4DB33C" />
          <Circle cx={33} cy={30} r={12} fill="#6DD35A" stroke={INK} strokeWidth={SW} />
          <Circle cx={67} cy={30} r={12} fill="#6DD35A" stroke={INK} strokeWidth={SW} />
          <Circle cx={33} cy={30} r={7.5} fill="#FFFFFF" />
          <Circle cx={67} cy={30} r={7.5} fill="#FFFFFF" />
          <Circle cx={34} cy={31} r={4} fill={INK} />
          <Circle cx={66} cy={31} r={4} fill={INK} />
          <Circle cx={35} cy={29.5} r={1.3} fill="#FFFFFF" />
          <Circle cx={67} cy={29.5} r={1.3} fill="#FFFFFF" />
          <Path d="M31 56 Q50 70 69 56" stroke={INK} strokeWidth={3.2} fill="none" strokeLinecap="round" />
          <Circle cx={46} cy={47} r={1.6} fill={INK} />
          <Circle cx={54} cy={47} r={1.6} fill={INK} />
          {cheeks(26, 74, 56)}
        </G>
      );
    case 'owl':
      return (
        <G>
          <Path d="M23 50 C21 32 25 20 29 13 L40 25 C46 23 54 23 60 25 L71 13 C75 20 79 32 77 50 C77 66 65 77 50 77 C35 77 23 66 23 50 Z" fill="#A86B3C" stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          {shade(50, 50, 26, '#8C5A30')}
          <Circle cx={39} cy={46} r={12} fill="#FFE7C2" stroke={INK} strokeWidth={3} />
          <Circle cx={61} cy={46} r={12} fill="#FFE7C2" stroke={INK} strokeWidth={3} />
          {eyes(39, 61, 46, 5)}
          <Polygon points="45.5,55 54.5,55 50,63" fill="#FF9A1A" stroke={INK} strokeWidth={2.4} strokeLinejoin="round" />
        </G>
      );
    case 'cat':
      return (
        <G>
          <Polygon points="23,42 25,13 46,27" fill="#B8C0D6" stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          <Polygon points="77,42 75,13 54,27" fill="#B8C0D6" stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          <Polygon points="28,32 29,21 38,28" fill="#FF9FB8" />
          <Polygon points="72,32 71,21 62,28" fill="#FF9FB8" />
          <Circle cx={50} cy={51} r={27} fill="#B8C0D6" stroke={INK} strokeWidth={SW} />
          {shade(50, 51, 25, '#9AA3BD')}
          <Path d="M50 25 V31 M44 26 L45 31 M56 26 L55 31" stroke="#7D86A3" strokeWidth={3} strokeLinecap="round" />
          {eyes(40, 60, 48)}
          <Polygon points="47,55 53,55 50,58.5" fill="#FF6F91" stroke={INK} strokeWidth={1.8} strokeLinejoin="round" />
          <Path d="M44 61 Q47 64 50 60.5 Q53 64 56 61" stroke={INK} strokeWidth={2.4} fill="none" strokeLinecap="round" />
          <Path d="M30 56 L15 54 M30 60 L16 63 M70 56 L85 54 M70 60 L84 63" stroke={INK} strokeWidth={2} strokeLinecap="round" />
        </G>
      );
    case 'bunny':
      return (
        <G>
          <Ellipse cx={38} cy={22} rx={8} ry={20} transform="rotate(-8 38 22)" fill="#FFFFFF" stroke={INK} strokeWidth={SW} />
          <Ellipse cx={62} cy={22} rx={8} ry={20} transform="rotate(8 62 22)" fill="#FFFFFF" stroke={INK} strokeWidth={SW} />
          <Ellipse cx={38} cy={24} rx={3.5} ry={13} transform="rotate(-8 38 24)" fill="#FFB3C8" />
          <Ellipse cx={62} cy={24} rx={3.5} ry={13} transform="rotate(8 62 24)" fill="#FFB3C8" />
          <Circle cx={50} cy={55} r={25} fill="#FFFFFF" stroke={INK} strokeWidth={SW} />
          {shade(50, 55, 23, '#E6ECF5')}
          {eyes(41, 59, 52)}
          <Ellipse cx={50} cy={59} rx={3.2} ry={2.4} fill="#FF6F91" />
          {smile(63, 3)}
          {cheeks(33, 67, 61)}
        </G>
      );
    case 'bear':
      return (
        <G>
          <Circle cx={28} cy={28} r={10} fill="#B07040" stroke={INK} strokeWidth={SW} />
          <Circle cx={72} cy={28} r={10} fill="#B07040" stroke={INK} strokeWidth={SW} />
          <Circle cx={28} cy={28} r={4.5} fill="#E8B98A" />
          <Circle cx={72} cy={28} r={4.5} fill="#E8B98A" />
          <Circle cx={50} cy={51} r={28} fill="#B07040" stroke={INK} strokeWidth={SW} />
          {shade(50, 51, 26, '#8F5630')}
          <Ellipse cx={50} cy={61} rx={12} ry={9} fill="#E8B98A" />
          {eyes(40, 60, 47)}
          <Ellipse cx={50} cy={57} rx={5} ry={3.5} fill={INK} />
          {smile(63, 3)}
        </G>
      );
    case 'monkey':
      return (
        <G>
          <Circle cx={22} cy={50} r={9} fill="#9A5B2E" stroke={INK} strokeWidth={SW} />
          <Circle cx={78} cy={50} r={9} fill="#9A5B2E" stroke={INK} strokeWidth={SW} />
          <Circle cx={22} cy={50} r={4.5} fill="#F2C7A0" />
          <Circle cx={78} cy={50} r={4.5} fill="#F2C7A0" />
          <Circle cx={50} cy={49} r={27} fill="#9A5B2E" stroke={INK} strokeWidth={SW} />
          <Circle cx={41} cy={46} r={10.5} fill="#F2C7A0" />
          <Circle cx={59} cy={46} r={10.5} fill="#F2C7A0" />
          <Ellipse cx={50} cy={59} rx={16} ry={12} fill="#F2C7A0" />
          {eyes(41, 59, 46, 3.4)}
          <Circle cx={47.5} cy={56} r={1.4} fill={INK} />
          <Circle cx={52.5} cy={56} r={1.4} fill={INK} />
          <Path d="M43 62 Q50 68 57 62" stroke={INK} strokeWidth={2.6} fill="none" strokeLinecap="round" />
        </G>
      );
    case 'penguin':
      return (
        <G>
          <Circle cx={50} cy={50} r={28} fill="#2A2D3E" stroke={INK} strokeWidth={SW} />
          <Circle cx={41} cy={52} r={12.5} fill="#FFFFFF" />
          <Circle cx={59} cy={52} r={12.5} fill="#FFFFFF" />
          <Ellipse cx={50} cy={61} rx={18} ry={12} fill="#FFFFFF" />
          {eyes(42, 58, 50, 3.4)}
          <Polygon points="44.5,56 55.5,56 50,63" fill="#FF9A1A" stroke={INK} strokeWidth={2.2} strokeLinejoin="round" />
          {cheeks(34, 66, 60)}
          <Path d="M30 30 Q40 24 48 26" stroke="#4A4F6A" strokeWidth={3} fill="none" strokeLinecap="round" />
        </G>
      );
    case 'pig':
      return (
        <G>
          <Polygon points="23,36 27,16 43,28" fill="#FFA8C0" stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          <Polygon points="77,36 73,16 57,28" fill="#FFA8C0" stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          <Circle cx={50} cy={51} r={27} fill="#FFB8CC" stroke={INK} strokeWidth={SW} />
          {shade(50, 51, 25, '#FF9AB6')}
          {eyes(39, 61, 46)}
          <Ellipse cx={50} cy={59} rx={10} ry={7} fill="#FF8FB0" stroke={INK} strokeWidth={3} />
          <Ellipse cx={46.5} cy={59} rx={1.8} ry={2.6} fill={INK} />
          <Ellipse cx={53.5} cy={59} rx={1.8} ry={2.6} fill={INK} />
          {cheeks(30, 70, 57)}
        </G>
      );
    case 'koala':
      return (
        <G>
          <Circle cx={24} cy={34} r={14} fill="#9AA5BD" stroke={INK} strokeWidth={SW} />
          <Circle cx={76} cy={34} r={14} fill="#9AA5BD" stroke={INK} strokeWidth={SW} />
          <Circle cx={24} cy={35} r={8} fill="#FFFFFF" />
          <Circle cx={76} cy={35} r={8} fill="#FFFFFF" />
          <Circle cx={50} cy={52} r={27} fill="#9AA5BD" stroke={INK} strokeWidth={SW} />
          {shade(50, 52, 25, '#7F8AA4')}
          {eyes(38, 62, 49, 3.4)}
          <Ellipse cx={50} cy={58} rx={7} ry={9} fill="#2A2D3E" />
          <Ellipse cx={48} cy={54} rx={2} ry={2.6} fill="#FFFFFF" opacity={0.5} />
          {cheeks(31, 69, 61)}
        </G>
      );
    default:
      return null;
  }
}

/** The bust alone, clipped into a round plate. */
export function Avatar({ id, size = 48, bg }: { id: string | undefined | null; size?: number; bg?: string }) {
  const a = resolveAvatar(id);
  const look = LOOKS[a];
  const clipId = `av-clip`;
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <ClipPath id={clipId}>
          <Circle cx={50} cy={50} r={48} />
        </ClipPath>
      </Defs>
      <G clipPath={`url(#${clipId})`}>
        <Circle cx={50} cy={50} r={50} fill={bg ?? look.bg} />
        <Circle cx={50} cy={34} r={30} fill="#FFFFFF" opacity={0.35} />
        <Path d="M10 104 C10 82 26 75 50 75 C74 75 90 82 90 104 Z" fill={look.shirt} stroke={INK} strokeWidth={SW} />
        <Path d="M62 77 C76 80 88 86 90 104 H70 Z" fill={look.shirtShade} />
        <Path d="M40 76 L50 86 L60 76" stroke={INK} strokeWidth={3} fill="#FFFFFF" strokeLinejoin="round" />
        {head(a)}
      </G>
    </Svg>
  );
}

/**
 * Round avatar plate for the table and lobby: ink rim, optional turn-timer
 * ring (fraction 0..1), dealer badge and seat-wind badge.
 */
export function AvatarPlate({
  id,
  size = 48,
  timer,
  timerUrgent,
  active,
  dealer,
  wind,
  offline,
}: {
  id: string | undefined | null;
  size?: number;
  timer?: number | null;
  timerUrgent?: boolean;
  active?: boolean;
  dealer?: boolean;
  wind?: string;
  offline?: boolean;
}) {
  const ringR = size / 2 + 5;
  const box = size + 14;
  const C = 2 * Math.PI * ringR;
  const frac = timer === null || timer === undefined ? null : Math.max(0, Math.min(1, timer));
  const badge = Math.max(16, Math.round(size * 0.4));
  return (
    <View style={{ width: size, height: size }}>
      {(active || frac !== null) && (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { left: -7, top: -7, width: box, height: box }]}>
          <Svg width={box} height={box}>
            <Circle cx={box / 2} cy={box / 2} r={ringR} stroke="rgba(16,20,47,0.55)" strokeWidth={6} fill="none" />
            {frac !== null ? (
              <Circle
                cx={box / 2}
                cy={box / 2}
                r={ringR}
                stroke={timerUrgent ? colors.danger : colors.gold}
                strokeWidth={5}
                fill="none"
                strokeLinecap="round"
                strokeDasharray={`${C * frac} ${C}`}
                transform={`rotate(-90 ${box / 2} ${box / 2})`}
              />
            ) : (
              <Circle cx={box / 2} cy={box / 2} r={ringR} stroke={colors.gold} strokeWidth={5} fill="none" />
            )}
          </Svg>
        </View>
      )}
      <View style={[styles.rim, { width: size, height: size, borderRadius: size / 2 }, offline && { opacity: 0.55 }]}>
        <Avatar id={id} size={size - 6} />
      </View>
      {dealer && (
        <View style={[styles.badge, styles.dealer, { width: badge, height: badge, borderRadius: badge / 2, right: -badge * 0.35, top: -badge * 0.3 }]}>
          <Text style={[styles.badgeText, { fontSize: badge * 0.58 }]}>莊</Text>
        </View>
      )}
      {wind && (
        <View style={[styles.badge, styles.wind, { width: badge, height: badge, borderRadius: badge / 2, left: -badge * 0.35, bottom: -badge * 0.25 }]}>
          <Text style={[styles.badgeText, { fontSize: badge * 0.58, color: '#FFFFFF' }]}>{wind}</Text>
        </View>
      )}
    </View>
  );
}

/** Coach mascot: the owl in a speech-bubble friendly size. */
export function CoachOwl({ size = 36 }: { size?: number }) {
  return <Avatar id="owl" size={size} bg="#FFE08A" />;
}

export function AvatarLine({ ids, size = 30 }: { ids: string[]; size?: number }) {
  return (
    <View style={{ flexDirection: 'row' }}>
      {ids.map((id, i) => (
        <View key={id} style={[styles.rim, { width: size, height: size, borderRadius: size / 2, marginLeft: i ? -size * 0.3 : 0 }]}>
          <Avatar id={id} size={size - 6} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  rim: { borderWidth: 3, borderColor: colors.ink, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  badge: { position: 'absolute', borderWidth: 2, borderColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  dealer: { backgroundColor: colors.gold },
  wind: { backgroundColor: colors.inkSoft },
  badgeText: { fontWeight: '900', color: colors.ink, lineHeight: undefined },
});

