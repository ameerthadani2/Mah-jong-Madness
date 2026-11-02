/**
 * Portrait kit: shared anatomy for the caricature busts.
 *
 * Every portrait is drawn in a 100 x 100 box: a dark blue-violet backdrop, a
 * big head (about 60% of the frame) on small shoulders, lit by a warm key light
 * from the upper left and a cool rim light from the right. Form comes from
 * gradients and soft glints rather than outlines.
 *
 * SVG ids are global on web and the first definition wins, so every id is
 * prefixed with the portrait id (pt-<id>-<name>) and the art for a given
 * portrait never varies between instances.
 */
import React from 'react';
import { Circle, ClipPath, Defs, Ellipse, G, LinearGradient, Path, RadialGradient, Stop } from 'react-native-svg';

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Path data tagged template: interpolated numbers are rounded to 2 decimals. */
export function d(strings: TemplateStringsArray, ...vals: number[]): string {
  let s = strings[0];
  for (let i = 0; i < vals.length; i++) s += r2(vals[i]) + strings[i + 1];
  return s;
}

/** Ellipse as path data (clockwise). */
export const ell = (cx: number, cy: number, rx: number, ry: number) => d`M${cx - rx} ${cy}A${rx} ${ry} 0 1 1 ${cx + rx} ${cy}A${rx} ${ry} 0 1 1 ${cx - rx} ${cy}Z`;
export const circ = (cx: number, cy: number, r: number) => ell(cx, cy, r, r);

const ARGS: Record<string, number> = { M: 2, L: 2, T: 2, C: 6, S: 4, Q: 4, A: 7, H: 1, V: 1, Z: 0 };

/** Mirror path data across the vertical centre line x = 50. */
export function mirror(path: string): string {
  const tokens = path.match(/[a-zA-Z]|-?\d*\.?\d+/g) ?? [];
  const out: string[] = [];
  let cmd = 'M';
  let i = 0;
  for (const t of tokens) {
    if (/[a-zA-Z]/.test(t)) {
      cmd = t;
      i = 0;
      out.push(t);
      continue;
    }
    const C = cmd.toUpperCase();
    const rel = cmd !== C;
    const n = ARGS[C] || 1;
    const k = i % n;
    let v = parseFloat(t);
    const flipX = () => (rel ? -v : 100 - v);
    if (C === 'A') {
      if (k === 2) v = -v;
      else if (k === 4) v = v ? 0 : 1;
      else if (k === 5) v = flipX();
    } else if (C === 'H') v = flipX();
    else if (C !== 'V' && k % 2 === 0) v = flipX();
    out.push(String(r2(v)));
    i++;
  }
  return out.join(' ').replace(/ ?([a-zA-Z]) ?/g, '$1');
}

/** A shape and its mirror image (two subpaths; keep them from overlapping). */
export const both = (p: string) => p + mirror(p);

type Seg = ['L', number, number] | ['Q', number, number, number, number] | ['C', number, number, number, number, number, number];

/**
 * One closed, symmetric shape from its left half: `segs` run from `top` (on the
 * centre line) down the left side to a point on the centre line; the right
 * half is mirrored and traced back up, so the result has a single winding.
 */
export function sym(top: number, segs: Seg[]): string {
  let s = d`M50 ${top}`;
  const pts: [number, number][] = [[50, top]];
  for (const g of segs) {
    if (g[0] === 'L') s += d`L${g[1]} ${g[2]}`;
    else if (g[0] === 'Q') s += d`Q${g[1]} ${g[2]} ${g[3]} ${g[4]}`;
    else s += d`C${g[1]} ${g[2]} ${g[3]} ${g[4]} ${g[5]} ${g[6]}`;
    pts.push([g[g.length - 2] as number, g[g.length - 1] as number]);
  }
  const m = (x: number) => 100 - x;
  for (let i = segs.length - 1; i >= 0; i--) {
    const g = segs[i];
    const [px, py] = pts[i];
    if (g[0] === 'L') s += d`L${m(px)} ${py}`;
    else if (g[0] === 'Q') s += d`Q${m(g[1])} ${g[2]} ${m(px)} ${py}`;
    else s += d`C${m(g[3])} ${g[4]} ${m(g[1])} ${g[2]} ${m(px)} ${py}`;
  }
  return s + 'Z';
}

type StopDef = [number, string, number?];

const stops = (s: StopDef[]) => s.map(([o, c, a], i) => <Stop key={i} offset={o} stopColor={c} stopOpacity={a ?? 1} />);

/** Radial gradient in bounding-box units (percent strings, as both web and native expect). */
export function radial(id: string, s: StopDef[], cx = 50, cy = 50, r = 50, fx?: number, fy?: number) {
  return (
    <RadialGradient key={id} id={id} cx={`${cx}%`} cy={`${cy}%`} r={`${r}%`} fx={`${fx ?? cx}%`} fy={`${fy ?? cy}%`}>
      {stops(s)}
    </RadialGradient>
  );
}

/** Linear gradient in bounding-box units, from (x1,y1) to (x2,y2) in percent. */
export function linear(id: string, s: StopDef[], x1 = 0, y1 = 0, x2 = 0, y2 = 100) {
  return (
    <LinearGradient key={id} id={id} x1={`${x1}%`} y1={`${y1}%`} x2={`${x2}%`} y2={`${y2}%`}>
      {stops(s)}
    </LinearGradient>
  );
}

/** Mix two #RRGGBB colours (t = 0 gives a, 1 gives b). */
export function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

/** Cloth / cap volume lit from the upper left: like `volume` but with two stops (one element fewer). */
export const volume2 = (id: string, hi: string, base: string, lo: string) =>
  radial(
    id,
    [
      [0, mix(hi, base, 0.3)],
      [1, mix(base, lo, 0.75)],
    ],
    32,
    18,
    95,
  );

/** Three-tone hair / hat volume lit from the upper left. */
export const volume = (id: string, hi: string, base: string, lo: string) =>
  radial(
    id,
    [
      [0, hi],
      [0.5, base],
      [1, lo],
    ],
    32,
    18,
    95,
  );

export interface Skin {
  hi: string;
  base: string;
  mid: string;
  lo: string;
  /** Cool rim light on the right edge of the face. */
  rim: string;
  blush: string;
  lip: string;
}
export interface FaceGeo {
  top: number;
  /** Half width at the cheekbones, and the height they sit at. */
  cw: number;
  cy: number;
  /** Half width and height of the jaw corner. */
  jw: number;
  jy: number;
  /** Chin bottom and half width. */
  by: number;
  bw: number;
}
export interface EyeGeo {
  y: number;
  dx: number;
  rx: number;
  ry: number;
  iris: string;
  ir: number;
  /** Outer corner lift (+ up, - droopy). */
  tilt: number;
  /** 0..1: cheeks push the lower lid up in a laugh. */
  squint: number;
  lash: number;
  wing: number;
  look: number;
  crease: number;
}
export interface BrowGeo {
  y: number;
  gap: number;
  len: number;
  th: number;
  arch: number;
  /** Outer end drop (+ down). */
  drop: number;
  color: string;
  raiseL: number;
  raiseR: number;
}
export interface NoseGeo {
  y: number;
  w: number;
}
export interface MouthGeo {
  y: number;
  w: number;
  open: number;
  curve: number;
  smirk: number;
  ul: number;
  ll: number;
  lip: string;
  teeth: boolean;
}

export interface Kit {
  id: (name: string) => string;
  url: (name: string) => string;
  skin: Skin;
  f: FaceGeo;
  e: EyeGeo;
  b: BrowGeo;
  n: NoseGeo;
  m: MouthGeo;
  neck: number;
}

type Layer = (k: Kit) => React.ReactNode;

export interface Spec {
  id: string;
  skin: Skin;
  face?: Partial<FaceGeo>;
  /** false: eyes hidden (sunglasses). */
  eyes?: Partial<EyeGeo> | false;
  brows?: Partial<BrowGeo>;
  nose?: Partial<NoseGeo>;
  mouth?: Partial<MouthGeo>;
  neck?: number;
  head?: { tilt?: number; dx?: number; dy?: number; s?: number };
  ears?: boolean;
  /** Opacity of laugh lines (nose to mouth); `ageLines` adds wrinkles drawn with them. */
  smileLines?: number;
  ageLines?: boolean;
  defs?: Layer;
  /** Behind everything, moves with the head (long hair, ponytails, hair volume). */
  back?: Layer;
  /** Clothes; static. */
  body: Layer;
  /** Inside the face clip: hair and brim shadows, stubble. */
  inFace?: Layer;
  /** Over the features: moustaches. */
  over?: Layer;
  /** Hair, hats, glasses, jewellery. */
  front?: Layer;
}

const FACE: FaceGeo = { top: 19, cw: 22.5, cy: 47, jw: 17.5, jy: 67, by: 79, bw: 6.5 };
const EYES: EyeGeo = { y: 49, dx: 9.5, rx: 4.6, ry: 3.1, iris: '#3A2418', ir: 2.6, tilt: 0.4, squint: 0.3, lash: 1, wing: 0, look: 0, crease: 0.4 };
const BROWS: BrowGeo = { y: 42.5, gap: 4.6, len: 10, th: 2, arch: 1.6, drop: 0.6, color: '#2A2020', raiseL: 0, raiseR: 0 };
const NOSE: NoseGeo = { y: 59.5, w: 4.8 };
const MOUTH: MouthGeo = { y: 68, w: 9, open: 4.4, curve: 2.2, smirk: 0, ul: 1, ll: 1.7, lip: '#C06A5A', teeth: true };

export const facePath = (f: FaceGeo) => {
  const { top, cw, cy, jw, jy, by, bw } = f;
  return sym(top, [
    ['C', 50 - cw * 0.6, top, 50 - cw, top + (cy - top) * 0.38, 50 - cw, cy],
    ['C', 50 - cw, cy + (jy - cy) * 0.5, 50 - jw - (cw - jw) * 0.35, jy - (jy - cy) * 0.12, 50 - jw, jy],
    ['C', 50 - jw + (jw - bw) * 0.35, jy + (by - jy) * 0.6, 50 - bw - (jw - bw) * 0.2, by, 50, by],
  ]);
};

/** Default bust: shoulders under a short neck. */
export const TORSO = 'M0 100C1 92 10 87.5 28 86C35 85.4 39 84.6 41 83L59 83C61 84.6 65 85.4 72 86C90 87.5 99 92 100 100Z';

const SCLERA = '#F7F2EE';
const PUPIL = '#120A08';
const CAVITY = '#4A1216';
const TEETH = '#FFFDF8';
const TONGUE = '#D2525E';
const WHITE = '#FFFFFF';

export interface PortraitArt {
  /** The dark blue-violet disc; left out when a caller paints its own backdrop. */
  backdrop: React.ReactElement;
  /** Everything else, clipped to the 100 x 100 circle. */
  art: React.ReactElement;
}

/** Builds a portrait from its spec. The result is static: build it once and reuse it. */
export function buildPortrait(s: Spec): PortraitArt {
  const p = `pt-${s.id}`;
  const f = { ...FACE, ...s.face };
  const showEyes = s.eyes !== false;
  const e = { ...EYES, ...(s.eyes || {}) };
  const b = { ...BROWS, ...s.brows };
  const n = { ...NOSE, ...s.nose };
  const m = { ...MOUTH, lip: s.skin.lip, ...s.mouth };
  const neck = s.neck ?? 8;
  const k: Kit = { id: (x) => `${p}-${x}`, url: (x) => `url(#${p}-${x})`, skin: s.skin, f, e, b, n, m, neck };
  const sk = s.skin;
  const h = s.head ?? {};
  const headT = `translate(${50 + (h.dx ?? 0)} ${70 + (h.dy ?? 0)}) rotate(${h.tilt ?? 0}) scale(${h.s ?? 1}) translate(-50 -70)`;

  const face = facePath(f);

  // Eyes: left eye drawn explicitly, right eye mirrored. Iris and catchlights are
  // placed per eye so both look the same way and catch the same light.
  const ex = 50 - e.dx;
  const ey = e.y;
  const { rx, ry, tilt: t, lash, wing } = e;
  const almond = d`M${ex - rx} ${ey - t}C${ex - rx * 0.45} ${ey - ry * 1.3 - t * 0.5} ${ex + rx * 0.5} ${ey - ry * 1.3} ${ex + rx} ${ey + 0.3}C${ex + rx * 0.45} ${ey + ry * 1.05} ${ex - rx * 0.5} ${ey + ry * 1.05 - t * 0.4} ${ex - rx} ${ey - t}Z`;
  const lashL = d`M${ex - rx - wing} ${ey - t - wing * 0.55}C${ex - rx * 0.45} ${ey - ry * 1.3 - t * 0.5 - lash * 0.8} ${ex + rx * 0.5} ${ey - ry * 1.3 - lash * 0.55} ${ex + rx + 0.25} ${ey + 0.15}C${ex + rx * 0.5} ${ey - ry * 1.3 + lash * 0.75} ${ex - rx * 0.45} ${ey - ry * 1.3 - t * 0.5 + lash * 0.85} ${ex - rx + 0.2} ${ey - t + 0.35}Z`;
  const sRy = ry * 1.6;
  const sTop = ey + ry * (1 - 1.15 * e.squint);
  const sCy = sTop + sRy;
  const cr = e.crease;
  const lidLines =
    d`M${ex - rx * 0.85} ${ey - ry * 1.05 - t * 0.7}C${ex - rx * 0.35} ${ey - ry * 1.9 - cr} ${ex + rx * 0.45} ${ey - ry * 1.85 - cr} ${ex + rx * 0.9} ${ey - ry * 0.75}` +
    d`M${ex - rx * 0.85} ${sCy - sRy * 0.72}Q${ex} ${sCy - sRy * 1.27} ${ex + rx * 0.8} ${sCy - sRy * 0.75}`;
  const irisAt = (cx: number) => circ(cx + e.look, ey + 0.25, e.ir);
  const pupilAt = (cx: number) => circ(cx + e.look, ey + 0.25, e.ir * 0.48);
  const catchAt = (cx: number) => circ(cx + e.look - e.ir * 0.36, ey + 0.25 - e.ir * 0.38, e.ir * 0.3) + circ(cx + e.look + e.ir * 0.4, ey + 0.25 + e.ir * 0.34, e.ir * 0.13);

  // Brows
  const brow = (raise: number) => {
    const xi = 50 - b.gap;
    const xo = xi - b.len;
    const yi = b.y - raise;
    return d`M${xi} ${yi + b.th * 0.5}L${xi - 0.4} ${yi - b.th * 0.5}Q${xi - b.len * 0.5} ${yi - b.arch - b.th * 0.85} ${xo} ${yi + b.drop}Q${xi - b.len * 0.45} ${yi - b.arch + b.th * 0.45} ${xi} ${yi + b.th * 0.5}Z`;
  };
  const brows = brow(b.raiseL) + mirror(brow(b.raiseR));

  // Nose
  const ny = n.y;
  const nw = n.w;
  const noseSide = d`M51.2 ${ey + 3}C52.4 ${ny - 7} ${50 + nw * 0.8} ${ny - 4.5} ${50 + nw * 0.9} ${ny - 1.2}C${50 + nw * 0.6} ${ny - 0.2} 51.6 ${ny - 0.6} 51.1 ${ny - 2.6}C50.7 ${ny - 6} 50.6 ${ey + 5.5} 51.2 ${ey + 3}Z`;
  const nostrils = both(
    d`M${50 - nw * 0.62} ${ny + 0.9}C${50 - nw * 0.62} ${ny - 0.4} ${50 - nw * 0.12} ${ny + 0.2} ${50 - nw * 0.12} ${ny + 1}C${50 - nw * 0.12} ${ny + 1.5} ${50 - nw * 0.62} ${ny + 1.5} ${50 - nw * 0.62} ${ny + 0.9}Z` +
      d`M${50 - nw * 0.55} ${ny - 2.6}C${50 - nw - 1.2} ${ny - 2.4} ${50 - nw - 1.1} ${ny + 1} ${50 - nw * 0.62} ${ny + 1.2}C${50 - nw - 0.3} ${ny + 0.4} ${50 - nw - 0.2} ${ny - 2} ${50 - nw * 0.55} ${ny - 2.6}Z`,
  );

  // Mouth
  const { y: my, w: mw, open: mo, curve: c, smirk: sm, ul, ll } = m;
  const Lx = 50 - mw;
  const Ly = my - c;
  const Rx = 50 + mw;
  const Ry = my - c - sm;
  const topEdge = d`C${50 - mw * 0.5} ${my + 0.3 - c * 0.1} ${50 + mw * 0.5} ${my + 0.3 - c * 0.1 - sm * 0.5} ${Rx} ${Ry}`;
  const topBack = d`C${50 + mw * 0.5} ${my + 0.3 - c * 0.1 - sm * 0.5} ${50 - mw * 0.5} ${my + 0.3 - c * 0.1} ${Lx} ${Ly}`;
  const botEdge = d`C${50 + mw * 0.55} ${my + mo * 1.3 - sm * 0.3} ${50 - mw * 0.55} ${my + mo * 1.3} ${Lx} ${Ly}`;
  const mouth = d`M${Lx} ${Ly}` + topEdge + botEdge + 'Z';
  const teeth = d`M${Lx - 1} ${Ly - 3}L${Rx + 1} ${Ry - 3}L${Rx + 1} ${Ry + 0.4}C${50 + mw * 0.5} ${my + mo * 0.6 - sm * 0.3} ${50 - mw * 0.5} ${my + mo * 0.6} ${Lx - 1} ${Ly + 0.4}Z`;
  const ut = my - ul - c * 0.25;
  const upperLip =
    ul > 0
      ? d`M${Lx} ${Ly}C${50 - mw * 0.55} ${Ly - ul * 0.5} 46.8 ${ut - 0.3} 48.7 ${ut - 0.2}Q50 ${ut + 0.5} 51.3 ${ut - 0.2 - sm * 0.3}C53.2 ${ut - 0.3 - sm * 0.3} ${50 + mw * 0.55} ${Ry - ul * 0.5} ${Rx} ${Ry}` + topBack + 'Z'
      : '';
  const lowerLip = d`M${Rx} ${Ry}` + botEdge + d`C${50 - mw * 0.5} ${my + mo * 1.3 + ll * 1.5} ${50 + mw * 0.5} ${my + mo * 1.3 + ll * 1.5 - sm * 0.3} ${Rx} ${Ry}Z`;
  const lipBottom = my - c * 0.25 + mo * 0.98 + ll * 1.1;

  const sl = s.smileLines ?? 0.35;
  // Laugh lines: from the nose wing, curving round towards (not into) the mouth corner.
  const lines =
    both(d`M${50 - nw - 1.4} ${ny - 1.4}C${50 - nw - 4.4} ${ny + 1.2} ${Lx - 3} ${Ly - 2.2} ${Lx - 1.6} ${Ly + 1.4}`) +
    (s.ageLines
      ? both(d`M${ex - rx - 0.9} ${ey - 0.3}q-0.9 -0.3 -1.7 -1.2M${ex - rx - 0.6} ${ey + 1.3}q-0.9 0.3 -1.6 1.1M${ex - rx * 0.6} ${ey + ry * 2.1}Q${ex} ${ey + ry * 2.8} ${ex + rx * 0.5} ${ey + ry * 2}`) +
        d`M36 ${f.top + 8}Q50 ${f.top + 5.5} 64 ${f.top + 8}M39 ${f.top + 11.5}Q50 ${f.top + 9.5} 61 ${f.top + 11.5}`
      : '');
  // Crisp speculars: nose tip and lower-lip gloss.
  const speculars = ell(49.2, ny - 2.2, nw * 0.3, 0.95) + ell(48.4, my - c * 0.25 + mo * 0.98 + ll * 0.55, mw * (ul > 1.2 ? 0.24 : 0.16), ll > 1.9 ? 0.55 : 0.4);

  const cw = f.cw;
  const ears = both(d`M${50 - cw + 1.5} ${ey - 2.5}C${50 - cw - 3} ${ey - 5.5} ${50 - cw - 5} ${ey + 2} ${50 - cw - 3} ${ey + 6.5}C${50 - cw - 2} ${ey + 9.5} ${50 - cw} ${ey + 10.5} ${50 - cw + 1.8} ${ey + 9.5}Z`);
  // Inner ear fold as a thin closed sliver so it can share the ear's fill and stroke.
  const earIn = both(d`M${50 - cw - 0.5} ${ey - 1.5}C${50 - cw - 3} ${ey} ${50 - cw - 2.8} ${ey + 5} ${50 - cw - 0.8} ${ey + 7}C${50 - cw - 2.2} ${ey + 5} ${50 - cw - 2.4} ${ey + 0.5} ${50 - cw - 0.5} ${ey - 1.5}Z`);

  const nk = neck;
  const neckD = d`M${50 - nk} ${f.jy - 6}L${50 - nk} ${f.by + 1}C${50 - nk} ${f.by + 5} ${50 - nk - 3} ${f.by + 7.5} ${50 - nk - 10} ${f.by + 9.5}L${50 - nk - 18} 100L${50 + nk + 18} 100L${50 + nk + 10} ${f.by + 9.5}C${50 + nk + 3} ${f.by + 7.5} ${50 + nk} ${f.by + 5} ${50 + nk} ${f.by + 1}L${50 + nk} ${f.jy - 6}Z`;

  const featClip = (showEyes ? both(almond) : '') + mouth;

  const backdrop = (
    <G>
      <Defs>
        {radial(k.id('bg'), [
          [0, '#5E52C8'],
          [0.5, '#2D2878'],
          [1, '#13123A'],
        ], 50, 40, 62)}
      </Defs>
      <Circle cx={50} cy={50} r={50} fill={k.url('bg')} />
    </G>
  );

  const art = (
    <G>
      <Defs>
        <ClipPath id={k.id('clip')}>
          <Circle cx={50} cy={50} r={50} />
        </ClipPath>
        <RadialGradient id={k.id('skin')} gradientUnits="userSpaceOnUse" cx={45} cy={42} r={44} fx={40} fy={34}>
          <Stop offset={0} stopColor={sk.hi} />
          <Stop offset={0.42} stopColor={sk.base} />
          <Stop offset={0.8} stopColor={sk.mid} />
          <Stop offset={1} stopColor={sk.lo} />
        </RadialGradient>
        <ClipPath id={k.id('face')}>
          <Path d={face} />
        </ClipPath>
        <ClipPath id={k.id('feat')}>
          <Path d={featClip} />
        </ClipPath>
        {radial(k.id('glint'), [
          [0, WHITE, 0.9],
          [1, WHITE, 0],
        ])}
        {radial(k.id('blush'), [
          [0, sk.blush, 0.55],
          [1, sk.blush, 0],
        ])}
        {radial(k.id('shade'), [
          [0, sk.lo, 0.6],
          [1, sk.lo, 0],
        ])}
        {s.defs?.(k)}
      </Defs>
      <G clipPath={k.url('clip')}>
        <G transform={headT}>
          {s.back?.(k)}
          <Path d={neckD} fill={k.url('skin')} />
          <Ellipse cx={51} cy={f.by + 1.5} rx={nk + 3.5} ry={6} fill={k.url('shade')} />
        </G>
        {s.body(k)}
        <G transform={headT}>
          {s.ears !== false && <Path d={ears + earIn} fill={k.url('skin')} stroke={sk.mid} strokeWidth={0.5} />}
          <Path d={face} fill={mix(sk.base, sk.rim, 0.5)} />
          <G clipPath={k.url('face')}>
            <Path d={face} fill={k.url('skin')} transform="translate(-1.5 0.6)" />
            <Ellipse cx={50 + f.cw * 0.95} cy={(f.cy + f.jy) / 2 + 3} rx={f.cw * 0.5} ry={(f.jy - f.top) * 0.42} fill={k.url('shade')} opacity={0.75} />
            <Ellipse cx={50 - e.dx - 4.5} cy={ey + 8.5} rx={6.5} ry={4.2} fill={k.url('blush')} />
            <Ellipse cx={50 + e.dx + 4.5} cy={ey + 8.5} rx={6.5} ry={4.2} fill={k.url('blush')} />
            <Ellipse cx={50 - e.dx - 2.5} cy={ey + 7} rx={4.2} ry={2.6} fill={k.url('glint')} opacity={0.55} />
            {showEyes && <Ellipse cx={50.4} cy={ey - 1.2} rx={e.dx + e.rx + 2.5} ry={e.ry + 3.2} fill={k.url('shade')} opacity={0.45} />}
            {s.inFace?.(k)}
          </G>
          <Path d={noseSide} fill={sk.lo} opacity={0.2} />
          <Ellipse cx={50.6} cy={ny + 1.9} rx={nw * 0.9} ry={1.7} fill={k.url('shade')} />
          <Path d={nostrils} fill={sk.lo} opacity={0.8} />
          {sl ? <Path d={lines} stroke={sk.lo} strokeWidth={0.7} strokeLinecap="round" fill="none" opacity={sl} /> : null}
          <Ellipse cx={50.5} cy={lipBottom + 0.8} rx={mw * 0.42} ry={1} fill={k.url('shade')} opacity={0.6} />
          <Path d={mouth} fill={CAVITY} />
          {showEyes && <Path d={both(almond)} fill={SCLERA} />}
          <G clipPath={k.url('feat')}>
            {showEyes && (
              <>
                <Path d={irisAt(ex) + irisAt(100 - ex)} fill={e.iris} />
                <Path d={pupilAt(ex) + pupilAt(100 - ex)} fill={PUPIL} />
                <Path d={catchAt(ex) + catchAt(100 - ex)} fill={WHITE} />
                {e.squint > 0 && <Path d={both(ell(ex, sCy, rx * 1.25, sRy))} fill={k.url('skin')} />}
              </>
            )}
            {m.teeth && <Path d={teeth} fill={TEETH} />}
            <Ellipse cx={50 + sm * 0.3} cy={my + mo * 1.0} rx={mw * 0.5} ry={mo * 0.42} fill={TONGUE} />
          </G>
          {upperLip ? <Path d={upperLip} fill={m.lip} /> : null}
          <Path d={lowerLip} fill={m.lip} />
          <Path d={speculars} fill={WHITE} opacity={0.7} />
          {showEyes && (
            <>
              <Path d={both(lidLines)} stroke={sk.lo} strokeWidth={0.6} strokeLinecap="round" fill="none" opacity={0.55} />
              <Path d={both(lashL)} fill="#1A1010" />
            </>
          )}
          <Path d={brows} fill={b.color} />
          {s.over?.(k)}
          {s.front?.(k)}
        </G>
      </G>
    </G>
  );
  return { backdrop, art };
}

/** Rounded rectangle as path data. */
export const rr = (x0: number, y0: number, x1: number, y1: number, r: number) =>
  d`M${x0 + r} ${y0}H${x1 - r}Q${x1} ${y0} ${x1} ${y0 + r}V${y1 - r}Q${x1} ${y1} ${x1 - r} ${y1}H${x0 + r}Q${x0} ${y1} ${x0} ${y1 - r}V${y0 + r}Q${x0} ${y0} ${x0 + r} ${y0}Z`;

/** Five-petal flowers: [petals, centres] path data. */
export function flowers(list: [number, number, number][]): [string, string] {
  let petals = '';
  let centres = '';
  for (const [x, y, r] of list) {
    for (let i = 0; i < 5; i++) {
      const a = ((-90 + i * 72) * Math.PI) / 180;
      petals += circ(x + Math.cos(a) * r * 0.62, y + Math.sin(a) * r * 0.62, r * 0.5);
    }
    centres += circ(x, y, r * 0.32);
  }
  return [petals, centres];
}

/** Star with `n` points; `balls` adds round tips (a sheriff's star). */
export function star(cx: number, cy: number, R: number, r: number, n: number, balls = 0): string {
  let s = '';
  for (let i = 0; i < n * 2; i++) {
    const a = ((-90 + (i * 180) / n) * Math.PI) / 180;
    const rad = i % 2 ? r : R;
    s += (i ? 'L' : 'M') + d`${cx + Math.cos(a) * rad} ${cy + Math.sin(a) * rad}`;
  }
  s += 'Z';
  if (balls) {
    for (let i = 0; i < n; i++) {
      const a = ((-90 + (i * 360) / n) * Math.PI) / 180;
      s += circ(cx + Math.cos(a) * R, cy + Math.sin(a) * R, balls);
    }
  }
  return s;
}

/** Deterministic speckle (stubble, freckles): `n` dots of radius `r` inside an ellipse, below `minY`. */
export function speckle(seed: number, n: number, cx: number, cy: number, rx: number, ry: number, r: number, minY = -1e9): string {
  let s = '';
  let x = seed;
  const rnd = () => {
    x = (x * 16807) % 2147483647;
    return x / 2147483647;
  };
  let placed = 0;
  for (let i = 0; i < n * 6 && placed < n; i++) {
    const a = rnd() * Math.PI * 2;
    const t = Math.sqrt(rnd());
    const px = cx + Math.cos(a) * rx * t;
    const py = cy + Math.sin(a) * ry * t;
    if (py < minY) continue;
    s += circ(px, py, r);
    placed++;
  }
  return s;
}
