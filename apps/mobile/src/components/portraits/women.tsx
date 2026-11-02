/**
 * Portraits: auntie, grandma, lady, hoops, sporty.
 */
import React from 'react';
import { Circle, Ellipse, Path } from 'react-native-svg';
import { both, circ, ell, flowers, linear, radial, speckle, star, sym, TORSO, volume, volume2, type Spec } from './kit';

const V_NECK = 'M0 100C1 92 10 87.5 28 86C35 85.4 39 84.6 41 83L50 94L59 83C61 84.6 65 85.4 72 86C90 87.5 99 92 100 100Z';

// ---------------------------------------------------------------- auntie
const AUNTIE_BACK =
  'M27 62A5 5 0 0 1 22.5 54A5.5 5.5 0 0 1 21 44A6 6 0 0 1 23 33A7 7 0 0 1 30 22A8 8 0 0 1 41 14A9 9 0 0 1 55 12.5A8.5 8.5 0 0 1 68 17.5A7.5 7.5 0 0 1 76 28A6.5 6.5 0 0 1 79 39A5.5 5.5 0 0 1 78.5 49A5.2 5.2 0 0 1 74 58Q50 66 27 62Z';
const AUNTIE_FRINGE =
  'M24.5 50C22 36 30 20 50 18.5C70 20 78.5 36 75.5 50A4.6 4.6 0 0 1 72.5 41.5A5.2 5.2 0 0 1 68 32.5A5 5 0 0 1 60 27.5A5 5 0 0 1 51 26.5A5 5 0 0 1 42 28A5 5 0 0 1 34.5 32.5A5.2 5.2 0 0 1 28.5 40.5A5.3 5.3 0 0 1 24.5 50Z';
const AUNTIE_CURLS =
  'M26.5 47a2.5 2.5 0 0 1 2 -4M24.5 38a3 3 0 0 1 3.5 -3.5M27 28a3 3 0 0 1 4.5 -2M33 21a3.5 3.5 0 0 1 5 -1M42 16.5a3.5 3.5 0 0 1 5.5 0M52 16a3.5 3.5 0 0 1 5 1.5M61 18.5a3.5 3.5 0 0 1 4.5 3M69 24a3 3 0 0 1 3 4M73 33a3 3 0 0 1 1.5 4.5M38 25a2.5 2.5 0 0 1 4 -1M47 22.5a2.5 2.5 0 0 1 4 0M56 23a2.5 2.5 0 0 1 3.5 1.5M64 26.5a2.5 2.5 0 0 1 3 2.5M22.5 56a2.5 2.5 0 0 1 1.5 -3.5M76.5 52a2.5 2.5 0 0 1 0 3.5';
const [AUNTIE_PETALS, AUNTIE_CENTRES] = flowers([
  [14, 94, 5],
  [28, 90, 4.4],
  [37, 99, 4.4],
  [67, 91, 4.4],
  [80, 96, 5],
  [59, 100, 4],
]);

export const auntie: Spec = {
  id: 'auntie',
  skin: { hi: '#FFE3C8', base: '#F1BE96', mid: '#D7976E', lo: '#AE6E4C', rim: '#FFE1EC', blush: '#F0607A', lip: '#D9405A' },
  face: { top: 20, cw: 23.5, cy: 49, jw: 19, jy: 66, by: 79, bw: 7.5 },
  eyes: { y: 50, dx: 9.6, rx: 4.4, ry: 3, iris: '#3A2216', ir: 2.5, tilt: 0.6, squint: 0.55, lash: 1.15, wing: 0.7 },
  brows: { y: 42.6, color: '#3B2420', th: 1.6, arch: 2, len: 9.6 },
  nose: { y: 60, w: 4.8 },
  mouth: { y: 68.5, w: 10, open: 5, curve: 2.6, ul: 1.4, ll: 2 },
  head: { tilt: 4 },
  defs: (k) => [
    volume(k.id('hair'), '#A0624A', '#4A2A22', '#1A0D0A'),
    volume2(k.id('cloth'), '#FF9A86', '#E5484D', '#9E2232'),
  ],
  back: (k) => (
    <>
      <Path d={AUNTIE_BACK} fill={k.url('hair')} />
      <Path d="M68.5 18.5A7.5 7.5 0 0 1 75.5 28.5A6.5 6.5 0 0 1 78 39A5.5 5.5 0 0 1 77.5 48.5" stroke="#D8C2FF" strokeWidth={1} fill="none" opacity={0.4} />
    </>
  ),
  body: (k) => (
    <>
      <Path d={V_NECK} fill={k.url('cloth')} />
      <Path d={AUNTIE_PETALS} fill="#FFE6EE" opacity={0.92} />
      <Path d={AUNTIE_CENTRES} fill="#FFC53D" />
    </>
  ),
  inFace: (k) => <Path d={AUNTIE_FRINGE} fill={k.skin.lo} opacity={0.45} transform="translate(0.6 1.8)" />,
  front: (k) => (
    <>
      <Path d={AUNTIE_FRINGE} fill={k.url('hair')} />
      <Path d={AUNTIE_CURLS} stroke="#C58A6C" strokeWidth={1} strokeLinecap="round" fill="none" opacity={0.75} />
      <Path d={both(circ(25.8, 61.4, 1.9))} fill="#F6F0F6" stroke="#B4A8C8" strokeWidth={0.5} />
    </>
  ),
};

// ---------------------------------------------------------------- grandma
const GRANDMA_BACK = 'M26 62C20 52 20 31 32 22C40 16 60 16 68 22C80 31 80 52 74 62Q50 66 26 62Z';
const GRANDMA_FRONT =
  'M25 52C21 36 29 20.5 50 19.5C71 20.5 79 36 75 52C73.5 45 72 38.5 67.5 33.5C62.5 29 56 28.5 51.5 30.5C46 27.5 39.5 28.5 34 32.5C29.5 36.5 27 44 25 52Z';

export const grandma: Spec = {
  id: 'grandma',
  skin: { hi: '#FFEDE4', base: '#F3C9B4', mid: '#D5A08A', lo: '#AD7563', rim: '#FFE4F0', blush: '#F07F8C', lip: '#C8505E' },
  face: { top: 21, cw: 22.5, cy: 50, jw: 18, jy: 67, by: 78.5, bw: 7.5 },
  eyes: { y: 51, dx: 9.3, rx: 3.9, ry: 2.4, iris: '#4A3020', ir: 2.1, tilt: -0.4, squint: 0.6, lash: 0.9, crease: 0.6 },
  brows: { y: 44, color: '#A4A2AE', th: 1.4, arch: 2.2, len: 9.4, drop: 1.2 },
  nose: { y: 61, w: 4.8 },
  mouth: { y: 69, w: 8.4, open: 3.4, curve: 2.4, ul: 1, ll: 1.6 },
  ageLines: true,
  smileLines: 0.55,
  defs: (k) => [volume(k.id('hair'), '#FFFFFF', '#D3D6DF', '#8D93A6'), volume2(k.id('cloth'), '#B697F0', '#8A63D2', '#4E2F8E')],
  back: (k) => (
    <>
      <Path d={GRANDMA_BACK} fill={k.url('hair')} />
      <Circle cx={50} cy={13} r={9} fill={k.url('hair')} />
      <Path d="M37 8.5L63 16" stroke="#2FAE6E" strokeWidth={1.8} strokeLinecap="round" />
    </>
  ),
  body: (k) => (
    <>
      <Path d="M40 82L47 100L53 100L60 82Z" fill="#FFF6EA" />
      <Path d="M0 100C1 92 10 87.5 28 86C35 85.4 39 84.6 41 83L47 100L53 100L59 83C61 84.6 65 85.4 72 86C90 87.5 99 92 100 100Z" fill={k.url('cloth')} />
      <Path
        d={sym(81.5, [
          ['C', 44, 81.5, 40, 82, 39.5, 84],
          ['C', 39, 87, 43.5, 89.5, 47.5, 88],
          ['C', 49, 87.3, 49.8, 86.3, 50, 85.5],
        ])}
        fill="#FFFFFF"
        stroke="#D9CFE6"
        strokeWidth={0.5}
      />
    </>
  ),
  inFace: (k) => <Path d={GRANDMA_FRONT} fill={k.skin.lo} opacity={0.35} transform="translate(0.6 1.6)" />,
  front: (k) => (
    <>
      <Path d={GRANDMA_FRONT} fill={k.url('hair')} />
      <Path d="M28 44C29 34 36 26 46 23.5M33 36C37 30 42 27.5 48 27M54 27C60 26 67 29 71 36M57 23C65 23.5 71 28 73.5 37M44 21C48 20 53 20 57 21M45 9C47 6 53 6 55 9" stroke="#FFFFFF" strokeWidth={0.9} strokeLinecap="round" fill="none" opacity={0.75} />
      <Path d={both(circ(40.7, 51.3, 6.3)) + 'M47 50.2Q50 48 53 50.2' + both('M34.4 50.6L27.6 49.4')} stroke="#C9A04A" strokeWidth={1} fill="#FFFFFF" fillOpacity={0.1} />
      <Path d="M36.4 48A5 5 0 0 1 39.6 45.6M55 48A5 5 0 0 1 58.2 45.6" stroke="#FFFFFF" strokeWidth={1.1} strokeLinecap="round" fill="none" opacity={0.75} />
    </>
  ),
};

// ---------------------------------------------------------------- lady
const LADY_BACK = 'M50 11.5C30 11.5 21.5 24 21.5 42C21.5 60 18 78 14 100L86 100C82 78 78.5 60 78.5 42C78.5 24 70 11.5 50 11.5Z';
const LADY_FRONT =
  'M48 12.5C36 12 26 19 24 31C22.5 45 22 62 20 76C19 86 18 94 17 100L27 100C28 92 29.5 82 30 72C30.5 62 29 52 29.5 42C30 33 35 26.5 48 24Z' +
  'M48 12.5C61 11.5 74 18 76 31C77.5 45 78 62 80 76C81 86 82 94 83 100L73 100C72 92 70.5 82 70 72C69.5 62 71 52 70.5 42C70 33 64 26.5 48 24Z';

export const lady: Spec = {
  id: 'lady',
  skin: { hi: '#FFEDE2', base: '#F8D0B6', mid: '#DFA488', lo: '#B97A62', rim: '#FFE2F2', blush: '#F2788E', lip: '#D21F3C' },
  face: { top: 19, cw: 21, cy: 47, jw: 15.5, jy: 66, by: 79, bw: 5 },
  eyes: { y: 49, dx: 9.2, rx: 4.8, ry: 3.1, iris: '#2B1A12', ir: 2.7, tilt: 1, squint: 0.25, lash: 1.45, wing: 1.7, crease: 0.5 },
  brows: { y: 42, color: '#1E1A1E', th: 1.4, arch: 2, len: 10.5, drop: 0.8 },
  nose: { y: 59.5, w: 3.9 },
  mouth: { y: 67.6, w: 8.6, open: 3.8, curve: 2, ul: 1.8, ll: 2.4 },
  ears: false,
  smileLines: 0.3,
  defs: (k) => [volume(k.id('hair'), '#4E5A86', '#16161F', '#06060A'), volume2(k.id('cloth'), '#FFF2CF', '#EBC889', '#A67A3A')],
  back: (k) => (
    <>
      <Path d={LADY_BACK} fill={k.url('hair')} />
      <Path d="M70 18.5C75.5 24.5 77.8 32 77.8 42C77.8 60 81.2 78 85.2 100" stroke="#C9B8FF" strokeWidth={1} fill="none" opacity={0.4} />
    </>
  ),
  body: (k) => (
    <>
      <Path d="M0 100C1 92 10 87.5 28 86C35 85.4 39 84.6 41 83L50 95L59 83C61 84.6 65 85.4 72 86C90 87.5 99 92 100 100Z" fill={k.url('cloth')} />
      <Path d="M33 92C38 90 42 93 44 99M60 96C63 92 67 91 70 92" stroke="#FFFFFF" strokeWidth={1.2} strokeLinecap="round" fill="none" opacity={0.4} />
      <Path d="M41.5 84C44 89.5 47.5 91.5 50 91.5C52.5 91.5 56 89.5 58.5 84" stroke="#F2D27A" strokeWidth={0.6} fill="none" />
      <Circle cx={50} cy={92.8} r={1.3} fill="#D21F3C" />
    </>
  ),
  inFace: (k) => <Path d={LADY_FRONT} fill={k.skin.lo} opacity={0.45} transform="translate(0.8 1.6)" />,
  front: (k) => (
    <>
      <Path d={LADY_FRONT} fill={k.url('hair')} />
      <Path d="M29.5 27C35 19.5 41 17 46.5 16.5M50 16.5C57 16 65 19 70.5 26M25.5 45C25 60 23 75 21 90M74.5 45C75 60 77 75 79 90" stroke="#8E9CD4" strokeWidth={1.5} strokeLinecap="round" fill="none" opacity={0.55} />
    </>
  ),
};

// ---------------------------------------------------------------- hoops
const HOOPS_BACK =
  'M22 66A6.5 6.5 0 0 1 14.5 56A6.5 6.5 0 0 1 12 44A6.5 6.5 0 0 1 14 32A7 7 0 0 1 20 21A7.5 7.5 0 0 1 29 12.5A7.5 7.5 0 0 1 40 7.5A7 7 0 0 1 52 6A7 7 0 0 1 64 8A7.5 7.5 0 0 1 74 14A7.5 7.5 0 0 1 82 23A7 7 0 0 1 87 34A6.5 6.5 0 0 1 88 46A6.5 6.5 0 0 1 85.5 57A6.5 6.5 0 0 1 78 66Q50 74 22 66Z';
const HOOPS_FRONT =
  'M27 44C25 29 34 19.5 50 19C66 19.5 75 29 73 44A4 4 0 0 1 70.5 36.5A4.5 4.5 0 0 1 64.5 30A4.2 4.2 0 0 1 57 26.8A4 4 0 0 1 50 26A4 4 0 0 1 43 26.8A4.2 4.2 0 0 1 35.5 30A4.5 4.5 0 0 1 29.5 36.5A4 4 0 0 1 27 44Z';
const HOOPS_CURLS =
  'M17 52a3 3 0 0 1 3 -4M15.5 40a3.2 3.2 0 0 1 4 -3M19 28a3.2 3.2 0 0 1 4.5 -2.5M26 18.5a3.5 3.5 0 0 1 5 -1.5M36 12.5a3.5 3.5 0 0 1 5 -0.5M47 10.5a3.5 3.5 0 0 1 5 0.5M58 11.5a3.5 3.5 0 0 1 4.5 2M68 16a3.5 3.5 0 0 1 4 3M18 61a3 3 0 0 1 2 -3.5M30 26a2.6 2.6 0 0 1 3.5 -2M40 21a2.6 2.6 0 0 1 4 -1M54 20.5a2.6 2.6 0 0 1 4 1M64 23a2.6 2.6 0 0 1 3.5 2.5';

export const hoops: Spec = {
  id: 'hoops',
  skin: { hi: '#C98F68', base: '#8E5A3C', mid: '#6C4029', lo: '#4A2817', rim: '#E2B6FF', blush: '#B8485E', lip: '#C0155E' },
  face: { top: 20, cw: 21.5, cy: 48, jw: 16.5, jy: 66.5, by: 79, bw: 6 },
  eyes: { y: 49.5, dx: 9.4, rx: 4.6, ry: 3, iris: '#3A1E10', ir: 2.6, tilt: 0.7, squint: 0.3, lash: 1.45, wing: 1.5 },
  brows: { y: 42.4, color: '#1A100C', th: 1.7, arch: 2.2, len: 10 },
  nose: { y: 60, w: 5.8 },
  mouth: { y: 68.6, w: 9.6, open: 4.6, curve: 2.2, ul: 2, ll: 2.6 },
  ears: false,
  defs: (k) => [
    volume(k.id('hair'), '#7A4E34', '#2B1A12', '#120A06'),
    volume2(k.id('cloth'), '#FFC27A', '#F28A26', '#A8520E'),
    linear(k.id('gold'), [
      [0, '#FFF3A8'],
      [0.55, '#D99A20'],
      [1, '#8A5A0C'],
    ]),
  ],
  back: (k) => (
    <>
      <Path d={HOOPS_BACK} fill={k.url('hair')} />
      <Path d="M74.5 15A7.5 7.5 0 0 1 81.5 23.5A7 7 0 0 1 86.2 34A6.5 6.5 0 0 1 87.2 46A6.5 6.5 0 0 1 84.8 56.5" stroke="#C9A0F0" strokeWidth={1} fill="none" opacity={0.45} />
      <Path d={HOOPS_CURLS + 'M76 24a3.2 3.2 0 0 1 2.5 4M80.5 36a3 3 0 0 1 1.5 4.5M81 49a3 3 0 0 1 0 4.5'} stroke="#9A6444" strokeWidth={1.1} strokeLinecap="round" fill="none" opacity={0.75} />
    </>
  ),
  body: (k) => (
    <>
      <Path d="M0 100C1 92 10 87.5 28 86C35 85.4 38.5 84.6 40.5 83Q50 92 59.5 83C61.5 84.6 65 85.4 72 86C90 87.5 99 92 100 100Z" fill={k.url('cloth')} />
    </>
  ),
  inFace: (k) => <Path d={HOOPS_FRONT} fill={k.skin.lo} opacity={0.5} transform="translate(0.6 1.6)" />,
  front: (k) => (
    <>
      <Path d={HOOPS_FRONT} fill={k.url('hair')} />
      <Path d={both(ell(26.6, 64.6, 4.2, 5.6))} stroke={k.url('gold')} strokeWidth={1.6} fill="none" />
    </>
  ),
};

// ---------------------------------------------------------------- sporty
const SPORTY_CROWN = 'M25.5 37C23.5 22 34 12 50 11.5C66 12 76.5 22 74.5 37Q50 31 25.5 37Z';
const SPORTY_VISOR = 'M21.5 37.5C30 31.5 70 31.5 78.5 37.5C79 40 76 41.5 71.5 41C60 39 40 39 28.5 41C24 41.5 21 40 21.5 37.5Z';

export const sporty: Spec = {
  id: 'sporty',
  skin: { hi: '#F3C6A0', base: '#CF9468', mid: '#AA6E46', lo: '#7C4A2C', rim: '#D9E2FF', blush: '#E0606A', lip: '#CF5A68' },
  face: { top: 20, cw: 21.5, cy: 48, jw: 16, jy: 66, by: 78.5, bw: 5.5 },
  eyes: { y: 50.5, dx: 9.3, rx: 4.6, ry: 3.1, iris: '#3A2414', ir: 2.6, tilt: 0.6, squint: 0.4, lash: 1.3, wing: 0.8 },
  brows: { y: 43.5, color: '#3A2214', th: 1.6, arch: 1.6, len: 9.6 },
  nose: { y: 60, w: 4.4 },
  mouth: { y: 68.6, w: 9.4, open: 4.8, curve: 2.6, ul: 1.3, ll: 2 },
  head: { tilt: -3 },
  sheen: false,
  smileLines: 0.3,
  defs: (k) => [
    volume(k.id('hair'), '#B07A50', '#5A3320', '#2A140A'),
    volume2(k.id('cloth'), '#8AE6F5', '#1BB4D2', '#0A6E8C'),
    volume2(k.id('cap'), '#FF8FB0', '#F2386B', '#9A1238'),
  ],
  back: (k) => (
    <>
      <Path d="M64 30C78 27 87 36 86.5 49C86 61 80.5 71 73.5 79C76 67 76 57 72.5 49C70.5 43 68 36 64 30Z" fill={k.url('hair')} />
    </>
  ),
  body: (k) => (
    <>
      <Path d={TORSO} fill={k.url('cloth')} />
      <Path d="M39 85C31 86.5 22 89 15 95M61 85C69 86.5 78 89 85 95" stroke="#FFFFFF" strokeWidth={2.2} fill="none" />
      <Path d="M40 82C44 84.5 56 84.5 60 82L60.5 86C56 88.5 44 88.5 39.5 86Z" fill="#F4FBFF" />
    </>
  ),
  inFace: (k) => (
    <>
      <Ellipse cx={50} cy={41} rx={27} ry={5} fill={k.url('shade')} />
      <Path d={speckle(7, 16, 50, 56, 15, 4, 0.42)} fill={k.skin.lo} opacity={0.55} />
    </>
  ),
  front: (k) => (
    <>
      <Path d={both('M26.5 38C25 44 25.5 50 27 55C28 50 28.8 44 30.5 39Z')} fill={k.url('hair')} />
      <Path d={SPORTY_CROWN} fill={k.url('cap')} />
      <Path d={SPORTY_VISOR} fill={k.url('cap')} />
      <Path d={star(50, 24, 3.4, 1.5, 5) + circ(50, 12, 1.6)} fill="#FFFFFF" />
    </>
  ),
};
