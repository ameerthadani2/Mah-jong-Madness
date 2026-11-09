/**
 * The printed pattern of a premium felt (themes.ts `pattern`), drawn as SVG elements so it can
 * sit inside any <Svg> that draws a felt: the table (components/TableParts.tsx FeltFrame) and
 * the Shop and Settings previews (components/Scenes.tsx ThemeScene). One small tile of the
 * motif repeats across the felt through an SVG <Pattern>, at low opacity so tiles and discards
 * stay easy to read.
 */
import React, { useId } from 'react';
import { Circle, Defs, G, Path, Pattern, Rect } from 'react-native-svg';
import type { FeltPatternId } from '../monetisation/cosmetics';

/** One repeat of each motif in a `size`×`size` cell, stroked or filled in `c`. */
function motif(pattern: FeltPatternId, size: number, c: string): React.ReactNode {
  const s = size;
  const sw = Math.max(1, s * 0.045);
  switch (pattern) {
    case 'lanterns':
      return (
        <G>
          <Path d={`M${s * 0.25} ${s * 0.08} V${s * 0.16}`} stroke={c} strokeWidth={sw} />
          <Rect x={s * 0.16} y={s * 0.16} width={s * 0.18} height={s * 0.04} rx={s * 0.01} fill={c} />
          <Path d={`M${s * 0.13} ${s * 0.32} C${s * 0.13} ${s * 0.18} ${s * 0.37} ${s * 0.18} ${s * 0.37} ${s * 0.32} C${s * 0.37} ${s * 0.46} ${s * 0.13} ${s * 0.46} ${s * 0.13} ${s * 0.32} Z`} fill={c} />
          <Path d={`M${s * 0.25} ${s * 0.44} V${s * 0.52}`} stroke={c} strokeWidth={sw} />
          <Path d={`M${s * 0.75} ${s * 0.58} V${s * 0.66}`} stroke={c} strokeWidth={sw} />
          <Path d={`M${s * 0.63} ${s * 0.82} C${s * 0.63} ${s * 0.68} ${s * 0.87} ${s * 0.68} ${s * 0.87} ${s * 0.82} C${s * 0.87} ${s * 0.96} ${s * 0.63} ${s * 0.96} ${s * 0.63} ${s * 0.82} Z`} fill={c} />
        </G>
      );
    case 'lattice':
      return (
        <G stroke={c} strokeWidth={sw} fill="none">
          <Rect x={sw} y={sw} width={s - sw * 2} height={s - sw * 2} />
          <Path d={`M${s / 2} 0 V${s} M0 ${s / 2} H${s}`} />
          <Rect x={s * 0.3} y={s * 0.3} width={s * 0.4} height={s * 0.4} transform={`rotate(45 ${s / 2} ${s / 2})`} />
        </G>
      );
    case 'waves': {
      // Seigaiha: rows of concentric half-rings.
      const arc = (cx: number, cy: number, r: number) => `M${cx - r} ${cy} A${r} ${r} 0 0 1 ${cx + r} ${cy}`;
      const rings = (cx: number, cy: number) => [0.5, 0.36, 0.22].map((k) => arc(cx, cy, s * k)).join(' ');
      return <Path d={`${rings(s / 2, s / 2)} ${rings(0, s)} ${rings(s, s)}`} stroke={c} strokeWidth={sw} fill="none" />;
    }
    case 'blossoms': {
      const flower = (cx: number, cy: number, r: number) => (
        <G key={`${cx}-${cy}`}>
          {[0, 72, 144, 216, 288].map((a) => (
            <Circle key={a} cx={cx + Math.sin((a * Math.PI) / 180) * r} cy={cy - Math.cos((a * Math.PI) / 180) * r} r={r * 0.75} fill={c} />
          ))}
          <Circle cx={cx} cy={cy} r={r * 0.45} fill="none" stroke={c} strokeWidth={sw} />
        </G>
      );
      return (
        <G>
          {flower(s * 0.28, s * 0.3, s * 0.08)}
          {flower(s * 0.76, s * 0.78, s * 0.06)}
        </G>
      );
    }
    case 'clouds': {
      const r = s * 0.1;
      const cloud = (x: number, y: number) =>
        `M${x} ${y} a${r} ${r} 0 0 1 ${r * 1.6} ${-r * 0.6} a${r} ${r} 0 0 1 ${r * 1.8} ${r * 0.2} a${r * 0.8} ${r * 0.8} 0 0 1 ${r * 0.2} ${r * 1.4} H${x} Z M${x + r * 1.4} ${y - r * 0.1} a${r * 0.45} ${r * 0.45} 0 1 1 ${r * 0.6} ${r * 0.5}`;
      return <Path d={`${cloud(s * 0.08, s * 0.32)} ${cloud(s * 0.56, s * 0.8)}`} stroke={c} strokeWidth={sw} fill="none" strokeLinejoin="round" />;
    }
    case 'stars': {
      const star = (x: number, y: number, r: number) => `M${x} ${y - r} Q${x + r * 0.18} ${y - r * 0.18} ${x + r} ${y} Q${x + r * 0.18} ${y + r * 0.18} ${x} ${y + r} Q${x - r * 0.18} ${y + r * 0.18} ${x - r} ${y} Q${x - r * 0.18} ${y - r * 0.18} ${x} ${y - r} Z`;
      return (
        <G>
          <Path d={`${star(s * 0.22, s * 0.24, s * 0.12)} ${star(s * 0.72, s * 0.66, s * 0.08)}`} fill={c} />
          <Circle cx={s * 0.7} cy={s * 0.18} r={s * 0.025} fill={c} />
          <Circle cx={s * 0.2} cy={s * 0.78} r={s * 0.03} fill={c} />
        </G>
      );
    }
    case 'fretwork': {
      // 回紋: a square spiral key, repeated corner to corner.
      const k = s / 8;
      return <Path d={`M${k} ${k * 7} V${k} H${k * 7} V${k * 7} H${k * 3} V${k * 3} H${k * 5} V${k * 5}`} stroke={c} strokeWidth={sw * 1.3} fill="none" strokeLinejoin="miter" />;
    }
    case 'scales': {
      const r = s / 4;
      const row = (y: number, x0: number) => [0, 1, 2].map((i) => `M${x0 + i * 2 * r - r} ${y} A${r} ${r} 0 0 0 ${x0 + i * 2 * r + r} ${y}`).join(' ');
      return <Path d={`${row(s * 0.25, 0)} ${row(s * 0.75, r)}`} stroke={c} strokeWidth={sw} fill="none" />;
    }
  }
}

/**
 * The pattern over a rounded felt area. Place it inside an <Svg>, right after the felt is drawn.
 * `cell` is the size of one repeat in the Svg's units.
 */
export function FeltPattern({ pattern, x, y, width, height, rx = 0, color = '#FFFFFF', opacity = 0.14, cell = 34 }: { pattern: FeltPatternId; x: number; y: number; width: number; height: number; rx?: number; color?: string; opacity?: number; cell?: number }) {
  const id = `felt-${pattern}-${useId().replace(/[^A-Za-z0-9]/g, '')}`;
  if (width <= 0 || height <= 0) return null;
  return (
    <G opacity={opacity} pointerEvents="none">
      <Defs>
        <Pattern id={id} patternUnits="userSpaceOnUse" x={x} y={y} width={cell} height={cell}>
          {motif(pattern, cell, color)}
        </Pattern>
      </Defs>
      <Rect x={x} y={y} width={width} height={height} rx={rx} fill={`url(#${id})`} />
    </G>
  );
}
