/**
 * Portraits: uncle, boss, shades, cowboy, student, chef, gent.
 */
import React from 'react';
import { Ellipse, Path } from 'react-native-svg';
import { both, circ, ell, linear, rr, speckle, star, sym, TORSO, volume, volume2, type Spec } from './kit';

/** Jacket open over a shirt (boss, gent). */
const JACKET = 'M0 100C1 92 10 87.5 28 86C34 85.4 37.5 84.6 39.5 83L46.5 100L53.5 100L60.5 83C62.5 84.6 66 85.4 72 86C90 87.5 99 92 100 100Z';
/** Shirt front in the jacket's V, with collar points (drawn over the jacket). */
const SHIRT_COLLAR = 'M39.5 83L46.5 100L53.5 100L60.5 83L58.6 81.4L53.4 86.6L50 84.6L46.6 86.6L41.4 81.4Z';
const LAPELS = both('M39.5 83L35 87.5L38.4 89.3L36 91.2L46.5 100L47.2 100Z');

/** Stubble patch over the jaw, chin and upper lip. */
const STUBBLE = 'M27 56C29 69 39 81 50 81C61 81 71 69 73 56C70 60 64 63 58.5 62.5C56 60.5 53 60.2 50 61C47 60.2 44 60.5 41.5 62.5C36 63 30 60 27 56Z';

// ---------------------------------------------------------------- uncle
export const uncle: Spec = {
  id: 'uncle',
  skin: { hi: '#F6CFA8', base: '#D9A174', mid: '#B9794F', lo: '#8A5232', rim: '#FFD9CF', blush: '#D9705A', lip: '#B5654E' },
  face: { top: 21, cw: 24, cy: 49, jw: 20, jy: 68, by: 79.5, bw: 9 },
  eyes: { y: 50.5, dx: 9.8, rx: 4.2, ry: 2.7, iris: '#3A2418', ir: 2.4, tilt: -0.5, squint: 0.45, lash: 0.95, crease: 0.3 },
  brows: { y: 43.5, color: '#3A302C', th: 2.4, arch: 1.1, len: 10.5, drop: 1.2 },
  nose: { y: 61, w: 5.6 },
  mouth: { y: 69.8, w: 9.6, open: 3.8, curve: 2, ul: 0.8, ll: 1.6 },
  ageLines: true,
  smileLines: 0.45,
  defs: (k) => [volume2(k.id('cap'), '#A8987E', '#6E604E', '#352C22'), volume2(k.id('cloth'), '#B6DEFA', '#6CB0EA', '#2E6CB0')],
  body: (k) => (
    <>
      <Path d={TORSO} fill={k.url('cloth')} />
      <Path d={both('M41 82.5L35.5 88.5L44.5 89.2L49.6 85.5Z')} fill="#8CC4F2" stroke="#2E6CB0" strokeWidth={0.5} />
      <Path d="M48 85.5H52V96H48Z" stroke="#2E6CB0" strokeWidth={0.6} fill="none" />
      <Path d={circ(50, 89, 0.8) + circ(50, 93, 0.8)} fill="#FFFFFF" />
    </>
  ),
  inFace: (k) => (
    <>
      <Ellipse cx={50} cy={37} rx={28} ry={4.5} fill={k.url('shade')} />
      <Path d={STUBBLE} fill={k.url('shade')} />
      <Path d={speckle(11, 44, 50, 71, 20, 10, 0.2, 62)} fill="#2A201C" opacity={0.3} />
    </>
  ),
  front: (k) => (
    <>
      <Path d={both('M25 33C23.5 38.5 24 44 25.5 48.5L28.2 47.5C27.5 42.5 27.6 37.5 29.3 33.5Z')} fill="#6A6460" />
      <Path d="M22 34C20.5 23 30 12.5 51 12C70.5 12 81.5 21 78.5 34Q50 29 22 34Z" fill={k.url('cap')} />
      <Path d="M51 13C40 15 31 22 28 32M51 13C62 14.5 70 21 73 31" stroke="#4A3E32" strokeWidth={0.7} fill="none" opacity={0.8} />
      <Path d="M26.5 33C34 29.5 66 29 74 32.8C76.5 34.5 75.5 37 72.5 37.4C62 34.6 38 34.8 28 37.8C25 37.5 24.5 34.6 26.5 33Z" fill="#4A3E32" />
    </>
  ),
};

// ---------------------------------------------------------------- boss
const BOSS_HAIR =
  'M27.5 45C26 35 26.5 24 33.5 18C40 12.5 50 10.5 58.5 11.5C68.5 13 75.5 20 76 30.5C76.3 36.5 75 41.5 72.5 45C72 39 70 33 66 29C60 25.5 53 25.6 46.5 26C38.5 26.5 33 29.5 30.5 35.5C29 39 28 42 27.5 45Z';

export const boss: Spec = {
  id: 'boss',
  skin: { hi: '#FCDDBF', base: '#E7B58C', mid: '#C48862', lo: '#946042', rim: '#E4DAFF', blush: '#E07C6E', lip: '#B46450' },
  face: { top: 18, cw: 21.5, cy: 47, jw: 19.4, jy: 68.5, by: 80.5, bw: 9.5 },
  eyes: { y: 48.5, dx: 9.2, rx: 4.3, ry: 2.6, iris: '#2E1E14', ir: 2.3, tilt: 0.8, squint: 0.3, lash: 1, look: 0.5 },
  brows: { y: 41.8, color: '#15151C', th: 2, arch: 1.2, len: 10, drop: 0.4, raiseR: 1.8 },
  nose: { y: 59.5, w: 4.8 },
  mouth: { y: 68.6, w: 8.6, open: 2.8, curve: 1.4, smirk: 2.2, ul: 0.8, ll: 1.5 },
  defs: (k) => [volume(k.id('hair'), '#5A6488', '#1C1E2A', '#08080E'), volume2(k.id('cloth'), '#5068A8', '#26355F', '#10162E')],
  body: (k) => (
    <>
      <Path d={JACKET} fill={k.url('cloth')} />
      <Path d={SHIRT_COLLAR} fill="#F6F8FC" stroke="#B9C2D6" strokeWidth={0.5} strokeLinejoin="round" />
      <Path d={LAPELS} fill="#33467C" />
      <Path d="M47.6 84.6H52.4L51.6 88.4H48.4ZM48.4 88.4H51.6L53.4 99L50 101.5L46.6 99Z" fill="#D0263A" />
    </>
  ),
  inFace: (k) => <Path d={BOSS_HAIR} fill={k.skin.lo} opacity={0.4} transform="translate(0.6 1.6)" />,
  front: (k) => (
    <>
      <Path d={BOSS_HAIR} fill={k.url('hair')} />
      <Path d="M33 31C36 22 45 16.5 57 15.6M40 27.5C45 21 53 18.5 63 19M50 26C56 22.5 63 22.5 70 26.5" stroke="#A8B4E0" strokeWidth={1.6} strokeLinecap="round" fill="none" opacity={0.45} />
      <Path d="M66.5 14.8C72 18 75.3 23.5 75.3 30.5C75.6 36.5 74.3 41.2 72 44.5" stroke="#C9B8FF" strokeWidth={1} fill="none" opacity={0.4} />
      <Path d={both(rr(34.4, 44.4, 46.4, 52.6, 1.6)) + 'M46.4 46.8Q50 45.2 53.6 46.8' + both('M34.4 46.5L28.5 45.8')} stroke="#16161E" strokeWidth={1.3} fill="#CFE0FF" fillOpacity={0.14} />
      <Path d="M36 51L40 45.5M38.4 51.5L41 48M54.6 51L58.6 45.5M57 51.5L59.6 48" stroke="#FFFFFF" strokeWidth={0.9} strokeLinecap="round" opacity={0.55} />
    </>
  ),
};

// ---------------------------------------------------------------- shades
const SHADES_QUIFF =
  'M28.5 33C27 22 34 10 50 7.5C63 5.5 75 10.5 76.5 21C77 27 75 32 72.5 34.5C69 30 62 27.5 54 28C46 28.5 37 30 30.5 35Z';
const AVIATOR = 'M30 44.5C33 42.3 42 42 47.2 43.2C48.3 44 48 47.5 47 50.5C45.3 55.3 40 57.5 35.5 56.5C31 55.5 28.6 50 30 44.5Z';

export const shades: Spec = {
  id: 'shades',
  skin: { hi: '#F2C9A0', base: '#D49F72', mid: '#B07750', lo: '#80502E', rim: '#D6E2FF', blush: '#D06A55', lip: '#A55A44' },
  face: { top: 19, cw: 22, cy: 47, jw: 18, jy: 67.5, by: 80, bw: 7.5 },
  eyes: false,
  brows: { y: 40.8, color: '#1E1816', th: 2.3, arch: 0.8, len: 10.5, drop: -0.2 },
  nose: { y: 59.8, w: 5 },
  mouth: { y: 69, w: 10, open: 4.4, curve: 2.6, smirk: 0.9, ul: 0.8, ll: 1.6 },
  head: { tilt: -3 },
  defs: (k) => [
    volume(k.id('hair'), '#7A5F55', '#231B19', '#0A0606'),
    volume2(k.id('cloth'), '#FF7A88', '#D0283E', '#7A0E1E'),
    linear(k.id('lens'), [
      [0, '#140C2A'],
      [0.45, '#3A2A70'],
      [1, '#E0905A'],
    ]),
  ],
  body: (k) => (
    <>
      <Path d="M0 100C1 92 10 87.5 28 86C35 85.4 38.5 84.6 40.5 83L50 99L59.5 83C61.5 84.6 65 85.4 72 86C90 87.5 99 92 100 100Z" fill={k.url('cloth')} />
      <Path d={both('M40.5 83L33 85L38.5 92.5L44.5 90Z')} fill="#E8455A" />
      <Path d="M41.5 84.5C43 90.5 47 94 50 94C53 94 57 90.5 58.5 84.5" stroke="#E9B949" strokeWidth={1.9} strokeDasharray="1.3 0.6" fill="none" />
      <Path d="M41.5 84.5C43 90.5 47 94 50 94C53 94 57 90.5 58.5 84.5" stroke="#FFF3B5" strokeWidth={0.6} strokeDasharray="0.7 1.2" fill="none" opacity={0.85} />
    </>
  ),
  inFace: (k) => <Path d={SHADES_QUIFF} fill={k.skin.lo} opacity={0.4} transform="translate(0.6 1.8)" />,
  front: (k) => (
    <>
      <Path d={both('M27.5 44C26.5 37 27.5 31 30.5 26.5L33 29C31 33 30 38 29.8 44Z')} fill="#3A2C26" opacity={0.7} />
      <Path d={SHADES_QUIFF} fill={k.url('hair')} />
      <Path d="M32 31C35 20 44 12.5 56 10.5M40 29C44 21 52 15.5 63 14M50 28C56 22 64 19 71 20.5M60 28.5C65 26 70 26.5 73 29" stroke="#8C6E62" strokeWidth={1} strokeLinecap="round" fill="none" opacity={0.7} />
      <Path d="M64.5 7.8C71.5 9.8 75.8 15 75.8 21C76.2 27 74.4 31.6 72 34" stroke="#C9B8FF" strokeWidth={1} fill="none" opacity={0.4} />
      <Path d={both(AVIATOR)} fill={k.url('lens')} stroke="#E8C060" strokeWidth={1} />
      <Path d={'M47.2 43.6Q50 42.4 52.8 43.6M47.6 46.2Q50 45.4 52.4 46.2' + both('M30 44.6L27.6 44.2')} stroke="#E8C060" strokeWidth={0.9} fill="none" />
      <Path d="M33 52.5L39 44.5M36.5 54L41.5 47.2M53 52.5L59 44.5M56.5 54L61.5 47.2" stroke="#FFFFFF" strokeWidth={1} strokeLinecap="round" opacity={0.45} />
    </>
  ),
};

// ---------------------------------------------------------------- cowboy
const COWBOY_MOUSTACHE = sym(64.6, [
  ['C', 46, 63.4, 40.5, 64, 37.5, 66.5],
  ['C', 35.5, 68.5, 34.5, 72, 35, 75.5],
  ['C', 36.5, 72.5, 38.5, 70.5, 41.5, 70],
  ['C', 44.5, 69.5, 47.5, 69, 50, 69],
]);

export const cowboy: Spec = {
  id: 'cowboy',
  skin: { hi: '#FFD8C0', base: '#E8A884', mid: '#C47A58', lo: '#955038', rim: '#DCD3FF', blush: '#E06A5A', lip: '#B5604E' },
  face: { top: 22, cw: 22.5, cy: 50, jw: 19, jy: 68.5, by: 80, bw: 8.5 },
  head: { dy: 2, s: 0.95 },
  eyes: { y: 51.5, dx: 9.5, rx: 4.2, ry: 2.5, iris: '#3E78B0', ir: 2.2, tilt: -0.2, squint: 0.5, lash: 1, crease: 0.3 },
  brows: { y: 45, color: '#5A341E', th: 2.4, arch: 0.8, len: 10.5, drop: 0.6 },
  nose: { y: 61.5, w: 5.4 },
  mouth: { y: 71.4, w: 9, open: 3.8, curve: 2.2, ul: 0, ll: 1.6 },
  smileLines: 0.45,
  defs: (k) => [volume(k.id('hat'), '#D69060', '#8E4A28', '#40180A'), volume2(k.id('cloth'), '#7AA6E0', '#3A6AAE', '#1A3A6E')],
  body: (k) => (
    <>
      <Path d={TORSO} fill={k.url('cloth')} />
      <Path d={both('M41 82.5L37 89L45 88.5L49.5 85Z')} fill="#5A8AD0" />
      <Path d="M38.5 82Q50 86.5 61.5 82L56.5 90Q50 97 43.5 90Z" fill="#D8302F" />
      <Path d={circ(44, 86, 0.6) + circ(48, 88.5, 0.6) + circ(52, 88.5, 0.6) + circ(56, 86, 0.6) + circ(50, 92.5, 0.6) + circ(46.5, 91, 0.5) + circ(53.5, 91, 0.5)} fill="#FFFFFF" opacity={0.85} />
    </>
  ),
  inFace: (k) => (
    <>
      <Ellipse cx={50} cy={39} rx={30} ry={6} fill={k.url('shade')} />
      <Path d={STUBBLE} fill={k.url('shade')} opacity={0.85} />
    </>
  ),
  over: (k) => (
    <>
      <Path d={COWBOY_MOUSTACHE} fill="#6B3F22" />
    </>
  ),
  front: (k) => (
    <>
      <Path d="M30.5 31.5C29.5 24 30.5 16 34 12C38 9 43 11 46 13.5C48 14.6 52 14.6 54 13.5C57 11 62 9 66 12C69.5 16 70.5 24 69.5 31.5Z" fill={k.url('hat')} />
      <Path d="M50 14.6C49.4 19 49.5 23.5 50 27M40 12.2C41.6 17 41.6 22.5 40.6 27.5M60 12.2C58.4 17 58.4 22.5 59.4 27.5" stroke="#40180A" strokeWidth={0.9} strokeLinecap="round" fill="none" opacity={0.4} />
      <Path d="M4 22C9.5 29.5 20 33.5 31 32.5C40 34.5 60 34.5 69 32.5C80 33.5 90.5 29.5 96 22C97.5 30 91 39.5 78 41C66 43 34 43 22 41C9 39.5 2.5 30 4 22Z" fill={k.url('hat')} />
      <Path d="M30.6 27.5C42 29 58 29 69.4 27.5L69.5 31.5C58 33 42 33 30.5 31.5Z" fill="#3A1A0E" />
      <Path d={star(50, 20.5, 5, 2.5, 6, 0.85)} fill="#F5C842" stroke="#9A6A10" strokeWidth={0.4} />
    </>
  ),
};

// ---------------------------------------------------------------- student
const STUDENT_HAIR =
  'M26 47C23.5 39 23 31 25.5 25Q21 20.5 20.5 16Q26 18.5 29 18Q27.5 12 30 7.5Q34 12.5 37.5 12.5Q38.5 7 43 4Q45.5 9.5 49 10Q52.5 5 58 4Q58.5 9 61 10.5Q66 7 71.5 8Q69.5 12.5 70.5 15Q76 15 80 18Q76.5 21 75.5 25Q78.5 31.5 76.5 38Q75 43 74 47Q72.5 40.5 69.5 35.5Q68 39 65.5 40Q66 34.5 63.5 31Q60 34.5 56 35Q57.5 30.5 55.5 28.5Q51.5 32 46.5 32Q48 28.5 47 26.5Q42 31 36.5 32Q38.5 29 38 26.5Q33 31 30 37Q28 41.5 26 47Z';

export const student: Spec = {
  id: 'student',
  skin: { hi: '#FFE8D6', base: '#F2C9A8', mid: '#D59F7E', lo: '#AC7358', rim: '#D9E2FF', blush: '#F08A8A', lip: '#C76D62' },
  face: { top: 19, cw: 21.5, cy: 48, jw: 16, jy: 66, by: 78, bw: 6 },
  eyes: { y: 50, dx: 9.2, rx: 4.8, ry: 3.3, iris: '#3A2618', ir: 2.9, tilt: 0.3, squint: 0.2, lash: 1.05, look: -0.5 },
  brows: { y: 42.6, color: '#2A2224', th: 1.9, arch: 1.6, len: 9.8, raiseL: 0.6 },
  nose: { y: 60, w: 4.3 },
  mouth: { y: 68.2, w: 8.8, open: 4.6, curve: 2.5, smirk: 0.6, ul: 0.9, ll: 1.7 },
  head: { tilt: 3 },
  defs: (k) => [volume(k.id('hair'), '#6E5E70', '#2A2226', '#0C080A'), volume2(k.id('cloth'), '#FFD86A', '#F0A818', '#A86A06')],
  back: (k) => (
    <>
      <Path d="M27 89C28 80 37 76 50 76C63 76 72 80 73 89C67 85.5 58 84.5 50 84.5C42 84.5 33 85.5 27 89Z" fill={k.url('cloth')} />
      <Path d="M33 87C33 79 40 75.5 50 75.5C60 75.5 67 79 67 87" stroke="#1E1E28" strokeWidth={2.4} fill="none" />
    </>
  ),
  body: (k) => (
    <>
      <Path d="M0 100C1 92 10 87.5 28 86C35 85.4 39 84.6 41 83L50 92L59 83C61 84.6 65 85.4 72 86C90 87.5 99 92 100 100Z" fill={k.url('cloth')} />
      <Path d="M46.5 89V98.5M53.5 89V97" stroke="#FFFFFF" strokeWidth={1} strokeLinecap="round" />
      <Path d={both(ell(33.2, 88.2, 5, 6))} fill="#22222E" />
      <Path d={both(ell(33.2, 88.2, 3, 4))} fill="#E8423A" />
    </>
  ),
  inFace: (k) => <Path d={STUDENT_HAIR} fill={k.skin.lo} opacity={0.4} transform="translate(0.6 1.8)" />,
  front: (k) => (
    <>
      <Path d={STUDENT_HAIR} fill={k.url('hair')} />
      <Path d="M30 30Q36 18 47 14M42 26Q50 17 62 14M55 27Q63 21 71 22M27 38Q28 32 31 27" stroke="#8E7E92" strokeWidth={1} strokeLinecap="round" fill="none" opacity={0.65} />
      <Path d="M71.5 8Q69.5 12.5 70.5 15Q76 15 80 18Q76.5 21 75.5 25Q78.5 31.5 76.5 38Q75 43 74 47" stroke="#C9B8FF" strokeWidth={1} fill="none" opacity={0.45} />
    </>
  ),
};

// ---------------------------------------------------------------- chef
export const chef: Spec = {
  id: 'chef',
  skin: { hi: '#EBBB92', base: '#C78A5E', mid: '#A0663E', lo: '#744425', rim: '#E2D0FF', blush: '#D85A50', lip: '#9C4F3E' },
  face: { top: 22, cw: 25, cy: 52, jw: 21, jy: 68, by: 80, bw: 10 },
  head: { dy: 3, s: 0.93 },
  eyes: { y: 52.5, dx: 9.8, rx: 4, ry: 2.6, iris: '#2E1A10', ir: 2.3, tilt: 0.2, squint: 0.65, lash: 0.95 },
  brows: { y: 45.6, color: '#1E1410', th: 2, arch: 2.4, len: 9.6 },
  nose: { y: 62.2, w: 6 },
  mouth: { y: 70.8, w: 10.6, open: 5.2, curve: 2.8, ul: 0.8, ll: 1.9 },
  smileLines: 0.55,
  defs: (k) => [volume(k.id('hat'), '#FFFFFF', '#EEF0F7', '#A9B0C6'), volume2(k.id('cloth'), '#FFFFFF', '#E9ECF4', '#9EA6BE')],
  body: (k) => (
    <>
      <Path d={TORSO} fill={k.url('cloth')} />
      <Path d="M60 88C56 91 52 95 50.5 100" stroke="#B8BFD2" strokeWidth={0.8} fill="none" />
      <Path d={circ(42.5, 92.5, 1.1) + circ(43.5, 98.5, 1.1) + circ(57.5, 92.5, 1.1) + circ(56.5, 98.5, 1.1)} fill="#2A2F45" />
      <Path d="M39.5 81.5C44 84 56 84 60.5 81.5L61 86C56 88.5 44 88.5 39 86Z" fill="#F6F8FC" stroke="#B8BFD2" strokeWidth={0.5} />
      <Path d="M45 84.5L55 84.5L53 90L50 88L47 90Z" fill="#E0313A" />
    </>
  ),
  inFace: (k) => <Ellipse cx={50} cy={39} rx={30} ry={5} fill={k.url('shade')} />,
  front: (k) => (
    <>
      <Path d={both('M25.8 36C25 41 25.3 46 26.3 50L28.8 49C28.3 45 28.4 40.5 29.5 36Z')} fill="#1E1410" />
      <Path d="M28.5 28C19.5 25.5 17.5 13 25.5 7.5C29 0.5 39.5 -1 45 3C48.5 -1.5 56 -1.5 59.5 3C64.5 -1 74.5 1 75.5 8C83 13 81 25 71.5 28Z" fill={k.url('hat')} />
      <Path d="M36 27.5C35 20 36 12 38 6.5M44 28C43.5 20 44.5 10 45.5 3.5M52 28C52 20 52.5 10 52 3.5M60 27.5C61 20 61.5 12 61 5.5M67 27C68.5 20 70 14 70 8.5" stroke="#B9C0D4" strokeWidth={0.8} strokeLinecap="round" fill="none" opacity={0.8} />
      <Path d="M27.5 35C27 31 28 28 29 26.5C40 28 60 28 71 26.5C72 28 73 31 72.5 35C60 36.5 40 36.5 27.5 35Z" fill={k.url('hat')} />
    </>
  ),
};

// ---------------------------------------------------------------- gent
const GENT_HAIR =
  'M27 45C25 33 28 21 37.5 15.5Q43 8.5 52 9.5Q61 7.5 68 13.5C74.5 18 77 27 75.5 36.5C75 40 74 42.5 73 45C72 38 70 32.5 66 29C60 25.5 53 26 46.5 24.5C40.5 24 34.5 27 31 32C29 35.5 27.5 40 27 45Z';
const GENT_MOUSTACHE = sym(66.2, [
  ['C', 46, 66.8, 42, 67, 38.5, 66.6],
  ['C', 35.5, 66.2, 33, 65, 32.2, 62.8],
  ['C', 31.6, 61, 33, 59.5, 34.6, 60.3],
  ['C', 33.6, 61, 33.6, 62.6, 35.2, 63.2],
  ['C', 38, 64, 42, 62.4, 45, 62.2],
  ['C', 47.5, 62, 49, 62.3, 50, 62.6],
]);

export const gent: Spec = {
  id: 'gent',
  skin: { hi: '#FFE3D4', base: '#EEBDA5', mid: '#CB8F77', lo: '#9E6450', rim: '#E3DAFF', blush: '#E67C80', lip: '#B5605A' },
  face: { top: 19, cw: 21, cy: 47.5, jw: 17, jy: 68.5, by: 81.5, bw: 7.5 },
  eyes: { y: 49.6, dx: 9.3, rx: 4, ry: 2.4, iris: '#4C7194', ir: 2.1, tilt: -0.5, squint: 0.5, lash: 0.9, crease: 0.6 },
  brows: { y: 43, color: '#B9BDCA', th: 2.5, arch: 1.6, len: 10.4, drop: 1 },
  nose: { y: 61, w: 4.9 },
  mouth: { y: 69.6, w: 8.6, open: 3.4, curve: 2.2, ul: 0.6, ll: 1.6 },
  ageLines: true,
  smileLines: 0.45,
  defs: (k) => [volume(k.id('hair'), '#FFFFFF', '#C9CDD8', '#80869A'), volume2(k.id('cloth'), '#DDB07E', '#A8794A', '#5E3E20')],
  body: (k) => (
    <>
      <Path d={JACKET} fill={k.url('cloth')} />
      <Path d={SHIRT_COLLAR} fill="#F6F8FC" stroke="#B9C2D6" strokeWidth={0.5} strokeLinejoin="round" />
      <Path d={LAPELS} fill="#8E6238" />
      <Path d={both('M48.6 84.8L42.5 81.2C41.2 82.5 41 86.8 42.4 88.4L48.6 85.6Z')} fill="#C2223C" />
      <Path d={ell(50, 85.2, 1.9, 2.1)} fill="#9A1630" />
    </>
  ),
  inFace: (k) => <Path d={GENT_HAIR} fill={k.skin.lo} opacity={0.35} transform="translate(0.6 1.6)" />,
  over: (k) => <Path d={GENT_MOUSTACHE} fill={k.url('hair')} stroke="#9AA0B2" strokeWidth={0.4} />,
  front: (k) => (
    <>
      <Path d={GENT_HAIR} fill={k.url('hair')} />
      <Path d="M30 36C32 25 40 17 50 14.5M36 29C42 22 50 18.5 60 18M47 24C54 21 62 21.5 69 25M54 12C60 11.5 66 14 70 18" stroke="#FFFFFF" strokeWidth={1} strokeLinecap="round" fill="none" opacity={0.75} />
    </>
  ),
};
