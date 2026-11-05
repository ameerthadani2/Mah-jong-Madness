/**
 * Display scale: how large the tiles and the reading text are drawn. Two independent settings, each with three
 * steps (Normal, Large, Extra large). Pure, so the clamping, the saved format and the OS floor are unit-tested;
 * the React provider lives in ./DisplayScale.tsx.
 */

export const TILE_SCALES = [1, 1.25, 1.5] as const;
export const TEXT_SCALES = [1, 1.15, 1.3] as const;
export type TileScale = (typeof TILE_SCALES)[number];
export type TextScale = (typeof TEXT_SCALES)[number];

/** The three steps, in order, as the settings card names them. */
export const SCALE_STEPS = ['normal', 'large', 'xl'] as const;
export type ScaleStep = (typeof SCALE_STEPS)[number];

export interface DisplayScale {
  tileScale: TileScale;
  textScale: TextScale;
}

export const DEFAULT_DISPLAY_SCALE: DisplayScale = { tileScale: 1, textScale: 1 };

/** Its own storage key, so the saved Settings shape is unchanged. */
export const DISPLAY_KEY = 'mjm.display';

/** The OS text size is honoured up to this much; past it the layout stops being usable. */
export const MAX_OS_FONT_SCALE = 2;

function nearest<T extends number>(steps: readonly T[], v: unknown): T {
  if (typeof v !== 'number' || !Number.isFinite(v)) return steps[0];
  let best = steps[0];
  for (const s of steps) if (Math.abs(s - v) < Math.abs(best - v)) best = s;
  return best;
}

/** Any number to the nearest allowed tile step; anything else reads as Normal. */
export function clampTileScale(v: unknown): TileScale {
  return nearest(TILE_SCALES, v);
}

/** Any number to the nearest allowed text step; anything else reads as Normal. */
export function clampTextScale(v: unknown): TextScale {
  return nearest(TEXT_SCALES, v);
}

/** Saved JSON (or nothing, or garbage) → a valid DisplayScale. */
export function parseDisplayScale(raw: string | null | undefined): DisplayScale {
  if (!raw) return DEFAULT_DISPLAY_SCALE;
  try {
    const obj: unknown = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return DEFAULT_DISPLAY_SCALE;
    const o = obj as Record<string, unknown>;
    return { tileScale: clampTileScale(o.tileScale ?? 1), textScale: clampTextScale(o.textScale ?? 1) };
  } catch {
    return DEFAULT_DISPLAY_SCALE;
  }
}

export function serialiseDisplayScale(d: DisplayScale): string {
  return JSON.stringify({ tileScale: clampTileScale(d.tileScale), textScale: clampTextScale(d.textScale) });
}

/** Which of the three steps a scale is (0 Normal, 1 Large, 2 Extra large). */
export function stepIndex(steps: readonly number[], v: number): number {
  const i = steps.indexOf(v);
  return i < 0 ? 0 : i;
}

/** A usable OS font scale: missing, broken or below-normal values read as 1, huge ones are capped. */
export function osFontScale(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 1;
  return Math.min(MAX_OS_FONT_SCALE, Math.max(1, v));
}

/**
 * The text size the player sees: their choice, but never smaller than the OS text size (the OS setting is the
 * floor, so picking Normal in the app never undoes a large system font).
 */
export function effectiveTextScale(textScale: TextScale, os: unknown): number {
  return Math.max(clampTextScale(textScale), osFontScale(os));
}

/**
 * The extra multiplier the app applies to a font size. React Native already multiplies every font by the OS
 * scale, so only the part of the player's choice above it is added: max(1, choice / os).
 */
export function textFactor(textScale: TextScale, os: unknown): number {
  const f = effectiveTextScale(textScale, os) / osFontScale(os);
  return Math.round(f * 1000) / 1000;
}

/** Scales a text style's fontSize and lineHeight (half-point steps); other keys pass through unchanged. */
export function scaleTextStyle<T extends object & { fontSize?: number | string; lineHeight?: number | string }>(style: T, factor: number): T {
  if (factor === 1) return style;
  const round = (n: number) => Math.round(n * factor * 2) / 2;
  return {
    ...style,
    ...(typeof style.fontSize === 'number' ? { fontSize: round(style.fontSize) } : null),
    ...(typeof style.lineHeight === 'number' ? { lineHeight: round(style.lineHeight) } : null),
  };
}
