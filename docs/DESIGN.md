# Visual design: Tycoon Parlour

Mahjong Madness looks like a Codigames idle-tycoon game (Idle Supermarket Tycoon, Idle Theme Park Tycoon): bright, chunky, illustrated and friendly, and unmistakably a commercial game. Three complete directions were built and compared side by side. Tycoon Parlour won; Jade & Lacquer (deep jade felt, walnut rail, gold leaf) and Neo Arcade (navy glass cards, geometric tiles) were runners-up and are good sources for premium table themes.

Nothing in the UI is an emoji or a system icon. Every icon, avatar, illustration and tile face is drawn with `react-native-svg` or composed Views, so it renders the same on iOS, Android and web.

## Where things live (`apps/mobile/src`)

| File | What it draws |
| --- | --- |
| `theme.ts` | Colour, radius, spacing and font tokens; text helpers that keep Chinese on the system CJK font |
| `components/Ui.tsx` | Panels, two-tone pressable buttons, chips, toggles, steppers, `StrokeText` display type, screen header |
| `components/Tile.tsx` | SVG tiles: ivory gradient face, bevel, thickness layer, suit art per kind, patterned backs, highlights |
| `components/Avatars.tsx` | Twelve animal busts (panda, tiger, fox, frog, owl, cat, bunny, bear, monkey, penguin, pig, koala) and the seat plate with timer ring, dealer badge and seat wind |
| `components/Scenes.tsx` | Mode-card illustrations: mahjong table, clubhouse, scroll, treasure chest, gem piles, VIP cards, coach medals |
| `components/Icons.tsx` | About 30 drawn icons |
| `components/Emotes.tsx` | Eight drawn emotes and the quick-chat picker |
| `components/Backdrop.tsx`, `Logo.tsx` | Sky gradient with sunburst and clouds; the wordmark |
| `components/TableParts.tsx` | Felt, wood rail, compass, live wall, melds, discard pools, seat badges |

## Palette

| Token | Value | Use |
| --- | --- | --- |
| Sky | `#2FA8F0` → `#3DB9F5` → `#8FE3FA` → `#A8F2E6` | Lobby background gradient |
| Ink | `#10142F` | Every outline and text stroke |
| Cream panel | `#FFF6E5`, shelf `#E2B878` | Cards and dialogs |
| Primary green | `#52C41A` | Main actions (Play, Buy) |
| Blue | `#2F8CFF` | Clubs and secondary actions |
| Gold | `#FFC53D` | Coins, highlights, the active seat |
| Purple | `#B35CFF` | Learn |
| Red | `#FF5A5F` | Leave, danger, low time |
| Gem | `#38D6FF` | Premium currency |
| Felt | radial green inside a wood rail | Table |
| Parlour floor | `#173B5C` with faint diamond tiling | Behind the table |

Every filled shape has the same build: a lighter top tone, the fill, a darker hard "shelf" under it, and a 3px ink outline. Buttons drop onto their shelf when pressed.

## Type

* **Lilita One**: display text and numerals, white with an ink stroke (`StrokeText` layers offset copies behind the fill).
* **Luckiest Guy**: the logo wordmark only.
* **Fredoka** 500–700: UI labels and buttons.
* **Nunito** 600–800: body text.
* **Chinese**: never given a font family, so iOS uses PingFang TC and Android uses Noto Sans CJK at a heavy weight. CJK fonts are not bundled (they would add megabytes).

Fonts load in `App.tsx` behind a branded loading screen; after three seconds the app falls back to system fonts so it never shows a blank screen.

## Tiles

Characters are heavy numerals over a red 萬. Dots are concentric rings in blue, red and green, in the traditional layouts, with an ornate one-dot. Bamboo is stick clusters with node bands; the one-bamboo is a bird on a perch. Winds are navy, 中 red, 發 green, and 白 a blue double frame. Flowers show a blossom, their number and character. Backs are a green gradient with a lattice diamond. Each kind's art is computed once and cached.

## Table

The felt sits inside a chunky wood rail with brass corner studs. A compass in the centre shows the round wind, the tiles left in the wall and each seat's wind, with the active seat lit gold. On tablets and in portrait the wall is drawn around the compass and empties as tiles are drawn. Your hand sits on a wooden rack: one row of 17 in landscape, two rows in portrait. Claims are large pill buttons labelled with the Chinese verb (過 吃 碰 槓 打 胡) and the tiles involved. The coach is an owl in a speech bubble.

## Known gaps

* Only verified in the web build; native SVG text, gradients and PingFang weights still need a device check.
* Every tile is an SVG; profile on a low-end Android phone before launch.
* The wall around the compass is decorative and does not track the dead wall.
