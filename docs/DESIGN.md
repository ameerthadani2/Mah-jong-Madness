# Visual design: "low-poly cartoon world, Flat 2.0 UI"

Direction: the approachable, chunky, saturated look of Codigames' idle tycoon games (Idle Supermarket Tycoon, Idle Theme Park Tycoon, Idle Airport Tycoon, Hotel Empire Tycoon). Note that no public Codigames style guide exists; the tokens below are derived from the genre and from the company's brand anchors, and should be validated against store screenshots.

## One-sentence brief
Flat-colour, big-silhouette 3D rendered as pre-baked sprites, framed by a 2D UI of rounded chunky shapes with two-tone top/bottom shading, 3–4px darker outlines, a hard bottom "shelf" shadow, and white display type with a dark stroke. Avoid Codigames' failure modes: dense HUDs, same-looking rewarded-ad buttons, booster buttons heavier than their explanation. Keep ≤ 5 primary targets per screen.

## Tokens (implemented in `apps/mobile/src/theme.ts`)
| Token | Value | Use |
| --- | --- | --- |
| ink / outline | `#10142F` | outlines, strokes, body text on cream |
| sky top / bottom | `#5BC8F5` → `#9BEBFC` | lobby backgrounds |
| felt | `#2F9E6A`, rim `#1E7A4F`, rail `#B5722F` / `#6E3F12` | table |
| primary CTA | `#52C41A` fill, `#3FA011` shelf, `#2B6E0C` outline | Start, Buy, Hu |
| info | `#2F8CFF` fill, `#1C5FCC` shelf | secondary actions, Chi |
| gold | `#FFC53D` fill, `#E09A00` shelf, `#8A5A00` outline | chips, Kong, highlights |
| premium | `#B35CFF` fill, `#7E3AE0` shelf, `#4E2390` outline | Diamonds, shop |
| danger | `#FF5A5F` fill, `#C73A40` shelf | timeouts, errors |
| cream panel | `#FFF6E5` fill, `#E6C9A0` outline | cards, keypad, result panels |
| white | `#FFFFFF` with `#10142F` stroke | display text |

Rule: every fill gets a shelf ≈ 18% darker and an outline ≈ 35% darker; fills stay saturated (S 70–90%) and bright (V 75–95%).

## Shapes
* Buttons 52–64pt tall, radius 18–22 (pill 999 for action chips), 3px outline, 4–6px hard shelf (no blur) plus a soft ambient shadow. Pressed: translateY 4, shelf 0, spring scale 0.96 → 1.
* Panels radius 24–28, 4px outline, 2px 35%-white top highlight, subtle two-stop vertical gradient.
* Tiles are the hero: ivory `#FFF9EE` face, 2px `#D9C7A6` edge, saturated glyphs, soft inner shadow; 44×62pt in hand on phones where room allows.

## Type
Display and numerals: **Lilita One** (or Luckiest Guy for louder headlines), white with a 3–4px ink stroke. UI labels: **Fredoka** 600/700. Body: **Nunito** 600/700. CJK (tile names, 台 names): **Noto Sans TC** 700/900. All available as `@expo-google-fonts/*` packages under OFL/MIT. Until the native stroked-text dependency lands, use a 2px dark text shadow.

## Motion and feedback
Tile pick-up scale 1.0 → 1.12 with shadow lift; discard arc 250ms + Medium haptic; Pong/Kong banner slam (1.3 → 1.0 spring) + Rigid haptic; Hu: Success haptic, radial gold burst, confetti 1.5s, score count-up; low time: pulsing red ring + Warning haptic at 5s. Respect reduced-motion.

## Avatars
Low-poly busts (~4k tris, 512² flat texture, big heads, dot eyes, bold silhouettes) rendered to 64/128/256 PNGs with a 4px outline and rarity frames (cream/blue/purple/gold). Until 3D art exists, 2D vector in the same language reads the same at phone size. Emotes as Lottie or sprite sheets.

## Accessibility
White on `#52C41A` fails 4.5:1 without the stroke — keep the stroke. 44pt minimum targets. Colour-blind safe suit cues: glyph shapes already differ; dragons distinct by shape. Test boxShadow fallbacks on Android 9.
