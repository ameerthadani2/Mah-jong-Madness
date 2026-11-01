/**
 * Design tokens — "low-poly cartoon world, Flat 2.0 UI" (see docs/DESIGN.md).
 * Every fill has a shelf (~18% darker) and an outline (~35% darker).
 */
export const colors = {
  // Lobby world
  ink: '#10142F',
  sky: '#5BC8F5',
  skyLight: '#9BEBFC',
  cream: '#FFF6E5',
  creamEdge: '#E6C9A0',
  creamDeep: '#F3E3C6',
  // Table world (defaults; themes override felt colours)
  felt: '#2F9E6A',
  feltDark: '#1E7A4F',
  feltLight: '#3DB57D',
  rail: '#B5722F',
  railEdge: '#6E3F12',
  // Action colours
  cta: '#52C41A',
  ctaShelf: '#3FA011',
  ctaOutline: '#2B6E0C',
  info: '#2F8CFF',
  infoShelf: '#1C5FCC',
  gold: '#FFC53D',
  goldShelf: '#E09A00',
  goldDim: '#8A5A00',
  premium: '#B35CFF',
  premiumShelf: '#7E3AE0',
  danger: '#FF5A5F',
  dangerShelf: '#C73A40',
  ok: '#52C41A',
  // Tiles
  ivory: '#FFF9EE',
  ivoryDark: '#D9C7A6',
  red: '#D7263D',
  blue: '#1F5FA8',
  green: '#1E8449',
  pink: '#C2185B',
  // Text on dark surfaces (table) and translucent panels
  text: '#FFFFFF',
  textDim: '#CFE7DA',
  panel: 'rgba(0,0,0,0.28)',
  panelStrong: 'rgba(16,20,47,0.72)',
};

export const radius = { sm: 8, md: 16, lg: 24 };
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };

/** White display text with the dark stroke the style calls for (approximated with a shadow until a stroke lib lands). */
export const displayText = {
  color: '#FFFFFF',
  textShadowColor: colors.ink,
  textShadowOffset: { width: 0, height: 2 },
  textShadowRadius: 1,
} as const;
