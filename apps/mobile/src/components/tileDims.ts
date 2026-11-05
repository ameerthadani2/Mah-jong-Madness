/** Tile sizes, free of React Native so layout maths can be unit-tested. */
export type TileSize = 'xs' | 'sm' | 'md' | 'lg';

export const TILE_DIMS: Record<TileSize, { w: number; h: number }> = {
  xs: { w: 20, h: 28 },
  sm: { w: 28, h: 39 },
  md: { w: 40, h: 56 },
  lg: { w: 50, h: 70 },
};

/** Named size, or an explicit width in pixels (height scales with it). */
export function tileDims(size: TileSize | number): { w: number; h: number } {
  return typeof size === 'number' ? { w: size, h: Math.round(size * 1.4) } : TILE_DIMS[size];
}

/** A tile size grown by a display scale (Settings → Display), as an explicit width; scale 1 keeps the size as given. */
export function scaledTile(size: TileSize | number, scale: number): TileSize | number {
  if (!Number.isFinite(scale) || scale <= 0 || scale === 1) return size;
  return Math.round(tileDims(size).w * scale);
}
