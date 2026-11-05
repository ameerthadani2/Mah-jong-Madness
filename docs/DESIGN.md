# Visual design: Tycoon Parlour

Mahjong Madness looks like a Codigames idle-tycoon game (Idle Supermarket Tycoon, Idle Theme Park Tycoon): bright, chunky, illustrated and friendly, and unmistakably a commercial game. Three complete directions were built and compared side by side. Tycoon Parlour won; Jade & Lacquer (deep jade felt, walnut rail, gold leaf) and Neo Arcade (navy glass cards, geometric tiles) were runners-up and are good sources for premium table themes.

Player avatars are the exception to the cartoon style: shaded caricature portraits in the PokerBros vein (see `docs/screenshot-avatars.png`).

Nothing in the UI is an emoji or a system icon. Every icon, avatar, illustration and tile face is drawn with `react-native-svg` or composed Views, so it renders the same on iOS, Android and web.

## Where things live (`apps/mobile/src`)

| File | What it draws |
| --- | --- |
| `theme.ts` | Colour, radius, spacing and font tokens; text helpers that keep Chinese on the system CJK font |
| `components/Ui.tsx` | Panels, two-tone pressable buttons, chips, toggles, steppers, `StrokeText` display type, screen header |
| `components/Tile.tsx` | SVG tiles: ivory gradient face, bevel, thickness layer, suit art per kind, patterned backs, highlights |
| `components/Avatars.tsx`, `components/portraits/` | Twelve PokerBros-style caricature portraits (auntie, uncle, grandma, boss, lady, shades, hoops, cowboy, student, chef, sporty, gent) on dark violet spotlight discs, and the seat plate with a thin gold ring, turn timer, dealer badge and seat wind. Open the web build with `#avatars` for a gallery |
| `components/Scenes.tsx` | Mode-card illustrations: mahjong table, clubhouse, scroll, treasure chest, gem piles, VIP cards, coach medals |
| `components/Icons.tsx` | About 30 drawn icons |
| `components/Emotes.tsx` | Eight drawn emotes and the quick-chat picker |
| `components/Backdrop.tsx`, `Logo.tsx` | Sky gradient with sunburst and clouds; the wordmark |
| `components/TableParts.tsx` | Felt, wood rail, compass, live wall, melds, discard pools, seat badges |
| `components/table/` | The table screen's parts: `TableHud`, `Felt`, `HandRail`, `ActionBar`, `CoachPanel`, `CallBanner` (call-outs and the winner reveal), `ResultSheet`, `Motion` (slide, flip, roll-up). `layout.ts` holds the geometry and `feel.ts` the timings, both pure and unit-tested |
| `components/SoundSettings.tsx` | Settings → Sound: master switch and the voice for calls |
| `audio/` | Sound: which table events make which sound (`cues.ts`), the player (`engine.ts`), the voice choice, and the hooks. Files and names: `assets/audio/manifest.json`, see `docs/CREDITS.md` |

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

### Layout rules (checked at 390×844, 844×390, 667×375, 360×740 and 1024×768)

Run `npm run e2e:screens` in `apps/mobile` to capture every main screen at those five sizes into `e2e-shots/`.

* **Short landscape phones** (under 420 px tall): the compass sits to the left of the coach bubble and my pond, so my pond clears the hand rail; the "X discarded Y" line moves into the HUD; call-outs ride high over the across seat.
* **Claim and discard buttons** dock over the bottom of the centre column in landscape (over my own pond, which no claim decision needs), never over a side opponent's pond. In portrait they get a strip of their own between the felt and the hand.
* **Coach bubble** wraps (status two lines, advice up to four) instead of cutting words off.
* **Result sheet**: two columns on short landscape with a 2×2 score grid and a scrolling right column; on phones under 480 px wide the buttons stack, Next hand full width and the other two sharing a row at equal widths.
* **Portrait**: the across seat's melds get their own line so they never run over the side name plates.
* **Lessons**: tiles shrink until the longest group fits the card.

## Motion and sound

All motion is React Native `Animated` (no extra library); on web it runs without the native driver.

* **Discard**: the new tile slides into its pond from its owner's side (190 ms) and is ringed gold.
* **Call-out**: 吃 碰 槓 胡 自摸 pops up large in the middle of the felt with the caller's name, coloured by call (吃 blue, 碰 green, 槓 purple, 胡 gold, 自摸 red), for about a second; 胡 and 自摸 hold for the 2.2 s before the result sheet. The voice line plays at the same moment; with voice off, or a voice not yet recorded, the banner carries the call alone.
* **Winner reveal**: during that hold the winner's melds and hand are laid out face up under the banner, the concealed tiles flipping over one after another.
* **Result**: the 台 total and every score change count up from zero.
* **Sounds**: draw (my own), discard clack, the clock ticking each of the last five seconds of my move, a tap on selecting a tile or pressing a claim, a fanfare when I win, a falling sigh for 流局. Settings → Sound turns everything off; the voice choice (Mandarin, Taiwanese, off) is separate.

## Accessibility

* Every pressable has a role and a label: shared controls take theirs from their title (or, for icon buttons, `table.a11y.icon.*`); tiles read their name and whether they are selected; claim buttons read the verb and the tiles.
* Touch targets are at least 44 pt, using `hitSlop` where the drawn control is smaller (`slopFor` in `components/table/layout.ts`). Hand tiles get their extra area above and below, since neighbours sit 2 px apart.
* No text below 11 px (a unit test scans the table, learning and shared components).
* Suits carry a small ink mark in the top-right corner (萬 square, 筒 ring, 條 bar) so they never depend on colour alone. It is drawn on tiles 26 px and wider.

## Known gaps

* Only verified in the web build; native SVG text, gradients and PingFang weights still need a device check.
* Every tile is an SVG; profile on a low-end Android phone before launch.
* The wall around the compass is decorative and does not track the dead wall.
* Hand tiles in portrait are about 36 px wide (17 tiles across two rows on a 360 px phone); their touch area reaches 44 pt only vertically.
* A large-tiles / large-text setting is still to come.
