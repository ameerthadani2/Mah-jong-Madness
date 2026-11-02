/**
 * Player avatars: 3D-shaded caricature busts in the PokerBros spirit (big
 * heads, glossy highlights, cool rim light on a dark blue-violet disc), drawn
 * in SVG by components/portraits. Avatar ids are stored in the profile (see
 * storage.ts); animal ids and emoji from older builds map onto a portrait.
 *
 * The coach owl keeps its original flat cartoon look.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, ClipPath, Defs, G, Image as SvgImage, Path, Polygon } from 'react-native-svg';
import { colors } from '../theme';
import { linear, radial } from './portraits/kit';
import { portraitArt } from './portraits';
import { PORTRAIT_IMAGES } from './portraits/images';

/**
 * Portrait content in a 100×100 box: the image art from assets/avatars/ when one has been imported
 * for this id (see scripts/import-avatars.cjs), otherwise the drawn SVG portrait.
 */
function portraitLayer(aid: AvatarId): React.ReactNode {
  const img = PORTRAIT_IMAGES[aid];
  if (!img) {
    const p = portraitArt(aid);
    return (
      <>
        {p.backdrop}
        {p.art}
      </>
    );
  }
  return (
    <>
      <Defs>
        <ClipPath id="pt-img-clip">
          <Circle cx={50} cy={50} r={50} />
        </ClipPath>
      </Defs>
      <SvgImage href={img} x={0} y={0} width={100} height={100} preserveAspectRatio="xMidYMid slice" clipPath="url(#pt-img-clip)" />
    </>
  );
}

export const AVATAR_IDS = ['auntie', 'uncle', 'grandma', 'boss', 'lady', 'shades', 'hoops', 'cowboy', 'student', 'chef', 'sporty', 'gent'] as const;
export type AvatarId = (typeof AVATAR_IDS)[number];

export const AVATAR_NAMES: Record<AvatarId, string> = {
  auntie: 'Auntie',
  uncle: 'Uncle',
  grandma: 'Grandma',
  boss: 'The Boss',
  lady: 'Leading Lady',
  shades: 'Mr Cool',
  hoops: 'Hoops',
  cowboy: 'Sheriff',
  student: 'Student',
  chef: 'Chef',
  sporty: 'Sporty',
  gent: 'Gentleman',
};

/** Avatar ids from the animal era, each mapped to the portrait that took its place. */
const ANIMALS: Record<string, AvatarId> = {
  panda: 'student',
  tiger: 'boss',
  fox: 'lady',
  frog: 'uncle',
  owl: 'grandma',
  cat: 'hoops',
  bunny: 'sporty',
  bear: 'cowboy',
  monkey: 'shades',
  penguin: 'gent',
  pig: 'chef',
  koala: 'auntie',
};

/** Emoji avatars from the earliest builds, routed through the animal they became. */
const EMOJI: Record<string, string> = {
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

const LEGACY: Record<string, AvatarId> = { ...ANIMALS };
for (const [emoji, animal] of Object.entries(EMOJI)) LEGACY[emoji] = ANIMALS[animal];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Resolve whatever is stored (id, legacy animal or emoji, nothing) to a drawable avatar. */
export function resolveAvatar(value: string | undefined | null, fallbackSeed = ''): AvatarId {
  if (value && (AVATAR_IDS as readonly string[]).includes(value)) return value as AvatarId;
  if (value && LEGACY[value]) return LEGACY[value];
  const seed = value || fallbackSeed;
  return AVATAR_IDS[hash(seed) % AVATAR_IDS.length];
}

/** Bots by seat, matching the host's default names (阿明, 小美, 老王, 阿花). */
const BOT_AVATARS: AvatarId[] = ['shades', 'lady', 'uncle', 'auntie'];

/** Avatar for a table seat: the player's pick, a fixed portrait per bot seat, or a stable hash of the name. */
export function seatAvatarId(info: { avatar?: string; isBot?: boolean; name?: string } | undefined, seat: number): string {
  if (info?.avatar) return info.avatar;
  if (info?.isBot) return BOT_AVATARS[seat % BOT_AVATARS.length];
  return resolveAvatar(undefined, info?.name || `seat-${seat}`);
}

/** The portrait alone on its round backdrop (or on a flat `bg`). */
export const Avatar = React.memo(function Avatar({ id, size = 48, bg }: { id: string | undefined | null; size?: number; bg?: string }) {
  const aid = resolveAvatar(id);
  if (bg && !PORTRAIT_IMAGES[aid]) {
    const p = portraitArt(aid);
    return (
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Circle cx={50} cy={50} r={50} fill={bg} />
        {p.art}
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      {portraitLayer(aid)}
    </Svg>
  );
});

// Plate chrome, identical in every plate so the shared ids never disagree.
const PLATE_GOLD = linear(
  'pt-plate-gold',
  [
    [0, '#FFF4C2'],
    [0.28, '#F4C24A'],
    [0.52, '#A86E14'],
    [0.76, '#FFE07A'],
    [1, '#B07A1E'],
  ],
  10,
  0,
  90,
  100,
);
const PLATE_GLOW = radial('pt-plate-glow', [
  [0.6, '#FFD34D', 0.95],
  [0.76, '#FFC53D', 0.45],
  [1, '#FFC53D', 0],
]);

/**
 * Round avatar plate for the table and lobby: the portrait inside a thin
 * metallic gold ring with an ink edge, a soft gold glow when active, an
 * optional turn-timer ring (fraction 0..1), dealer badge and seat-wind badge.
 */
export const AvatarPlate = React.memo(function AvatarPlate({
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
  const aid = resolveAvatar(id);
  // Ring widths are set in pixels and converted to the 100-unit viewBox.
  const u = 100 / size;
  const ink = (size >= 44 ? 2 : 1.5) * u;
  const gold = Math.max(2, size * 0.055) * u;
  const R = 50 - ink - gold * 0.6;
  const glow = Math.round(size * 1.5);
  return (
    <View style={{ width: size, height: size }}>
      {active && (
        <View pointerEvents="none" style={{ position: 'absolute', left: (size - glow) / 2, top: (size - glow) / 2, width: glow, height: glow }}>
          <Svg width={glow} height={glow} viewBox="0 0 100 100">
            <Defs>{PLATE_GLOW}</Defs>
            <Circle cx={50} cy={50} r={50} fill="url(#pt-plate-glow)" />
          </Svg>
        </View>
      )}
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
      <View style={[{ width: size, height: size, borderRadius: size / 2 }, offline && { opacity: 0.55 }]}>
        <Svg width={size} height={size} viewBox="0 0 100 100">
          <Defs>{PLATE_GOLD}</Defs>
          <Circle cx={50} cy={50} r={50} fill={colors.ink} />
          <G transform={`translate(${50 - R} ${50 - R}) scale(${R / 50})`}>{portraitLayer(aid)}</G>
          <Circle cx={50} cy={50} r={50 - ink - gold / 2} stroke="url(#pt-plate-gold)" strokeWidth={gold} fill="none" />
          <Circle cx={50} cy={50} r={50 - ink / 2} stroke={colors.ink} strokeWidth={ink} fill="none" />
        </Svg>
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
});

export const AvatarLine = React.memo(function AvatarLine({ ids, size = 30 }: { ids: string[]; size?: number }) {
  return (
    <View style={{ flexDirection: 'row' }}>
      {ids.map((id, i) => (
        <View key={id} style={{ marginLeft: i ? -size * 0.3 : 0 }}>
          <AvatarPlate id={id} size={size} />
        </View>
      ))}
    </View>
  );
});

// ---------------------------------------------------------------- coach owl
// The owl mascot keeps the original flat cartoon style: dot eyes, ink outline.

const INK = colors.ink;
const SW = 4;

const owlEyes = (lx: number, rx: number, y: number, r = 3.8) => (
  <G>
    <Circle cx={lx} cy={y} r={r} fill={INK} />
    <Circle cx={rx} cy={y} r={r} fill={INK} />
    <Circle cx={lx + 1.2} cy={y - 1.3} r={r * 0.36} fill="#FFFFFF" />
    <Circle cx={rx + 1.2} cy={y - 1.3} r={r * 0.36} fill="#FFFFFF" />
  </G>
);
/** Head shading: a crescent on the lower right in a darker tone. */
const owlShade = (cx: number, cy: number, r: number, fill: string) => <Path d={`M${cx + r * 0.2} ${cy + r * 0.98} A${r} ${r} 0 0 0 ${cx + r * 0.98} ${cy + r * 0.2} A${r * 1.25} ${r * 1.25} 0 0 1 ${cx + r * 0.2} ${cy + r * 0.98} Z`} fill={fill} />;

/** Coach mascot: the owl in a speech-bubble friendly size. */
export const CoachOwl = React.memo(function CoachOwl({ size = 36 }: { size?: number }) {
  const clipId = `av-clip`;
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <ClipPath id={clipId}>
          <Circle cx={50} cy={50} r={48} />
        </ClipPath>
      </Defs>
      <G clipPath={`url(#${clipId})`}>
        <Circle cx={50} cy={50} r={50} fill="#FFE08A" />
        <Circle cx={50} cy={34} r={30} fill="#FFFFFF" opacity={0.35} />
        <Path d="M10 104 C10 82 26 75 50 75 C74 75 90 82 90 104 Z" fill="#C68A55" stroke={INK} strokeWidth={SW} />
        <Path d="M62 77 C76 80 88 86 90 104 H70 Z" fill="#9A6234" />
        <Path d="M40 76 L50 86 L60 76" stroke={INK} strokeWidth={3} fill="#FFFFFF" strokeLinejoin="round" />
        <G>
          <Path d="M23 50 C21 32 25 20 29 13 L40 25 C46 23 54 23 60 25 L71 13 C75 20 79 32 77 50 C77 66 65 77 50 77 C35 77 23 66 23 50 Z" fill="#A86B3C" stroke={INK} strokeWidth={SW} strokeLinejoin="round" />
          {owlShade(50, 50, 26, '#8C5A30')}
          <Circle cx={39} cy={46} r={12} fill="#FFE7C2" stroke={INK} strokeWidth={3} />
          <Circle cx={61} cy={46} r={12} fill="#FFE7C2" stroke={INK} strokeWidth={3} />
          {owlEyes(39, 61, 46, 5)}
          <Polygon points="45.5,55 54.5,55 50,63" fill="#FF9A1A" stroke={INK} strokeWidth={2.4} strokeLinejoin="round" />
        </G>
      </G>
    </Svg>
  );
});

const styles = StyleSheet.create({
  badge: { position: 'absolute', borderWidth: 2, borderColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  dealer: { backgroundColor: colors.gold },
  wind: { backgroundColor: colors.inkSoft },
  badgeText: { fontWeight: '900', color: colors.ink, lineHeight: undefined },
});
