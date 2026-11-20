# Showcase screenshots

`docs/screenshots/` holds the app's showcase set: store-style images (a screenshot in a device frame under a headline)
in English (`en-*`) and Traditional Chinese (`zh-*`), and one collage per language for sharing in a single picture.

| File | Size | Use |
| --- | --- | --- |
| `*-00-collage.jpg` | 3200 × 1800 | One image to share: five phones under the logo |
| `*-01-hero.jpg` to `*-09-fair.jpg` | 1290 × 2796 | Phone frames in store order; the App Store's 6.7" iPhone size |
| `*-10-tablet-table.jpg` to `*-12-tablet-fair.jpg` | 2732 × 2048 | Tablet frames; the App Store's 12.9"/13" iPad size, landscape |

The order follows a review of the first set by an art director, a visual QA pass and a native Taiwanese copywriter: the
win first, then what it is worth, the coach, learning, the hand review, clubs, looks, leaderboards and the verified
shuffle. The club frame says that creating a club takes The Four Winds Club (App Store guideline 2.3.2: a screenshot of
something that needs a purchase says so).

Google Play takes phone screenshots no more than twice as long as they are wide, so the 1290 × 2796 frames do not fit
there; for Play, change the phone size in `apps/mobile/e2e/showcase/capture.cjs` (`DEVICES`) to a 9:16 screen (for
example 412 × 732 at 2.625, which gives 1082 × 1922) and frame those.

## What is staged, and what is real

- **The app is real**: every frame is a screenshot of the current app (a web build) in a phone- or tablet-sized browser.
- **The hand is real**: a script plays a fixed deal (seed 3) against Beginner bots, taking every discard the in-game
  coach rings, passing every claim and taking the win. That deal ends in a concealed self-drawn win for 5 台 (門清自摸 3,
  獨聽 1, 莊家 1). The opponents are bots, and the table says so. The looks frame is the same hand at the Night Market
  table, a set the sample player is given in the sample data.
- **The verified shuffle is real**: the fairness frames show a hand played at an online table the sample player opened
  in their club, on the local game server, with bots in the other seats. The deal there is the seats' and the server's
  and differs every time; the Verified badge, the seed, the commitments and the hand's hash are the app's own check of
  that hand.
- **The people are fictional**: "Mei-Ling" (English) and "美玲" (Chinese) are a sample player, and the sixteen other
  names on the leaderboards and in the clubs are made up (each language's run gives them names in that language, and
  keeps the other language's sample player off its boards). Their scores, the two clubs and the standings are sample
  data written into a local test database (`seed.cjs`); the 128 hands, the 12-day streak and the lessons done are
  written into the sample device's storage (`capture.cjs`).
- **Prices are the catalogue's US prices**, shown by the development build's test store. That build shows a "test
  store" notice in the Shop; the capture hides it, because release builds sell through the App Store and Google Play and
  have no such notice.

## Making them again

After a change to the screens, run the whole thing again (about 20 minutes):

```sh
npm ci
PGURL=postgres://postgres@localhost:5432 apps/mobile/e2e/showcase/showcase.sh /tmp/mjm-showcase
```

- `PGURL`: a Postgres server the script may create and drop the database `mjm_showcase` on. Never a real one: the
  sample data is written straight into the tables.
- Port 8787 must be free: the development build talks to the game server there.
- `NOTO_CSS` (optional): the stylesheet of Noto Sans TC for the Chinese headlines (`npm pack @fontsource/noto-sans-tc`,
  then `package/900.css`). Without it the Chinese headlines use the system's Chinese font.
- `DEAL` (optional): another deal seed. `node apps/mobile/e2e/showcase/find-deal.cjs <webdir> 1 60` plays sixty deals
  and lists the player's best wins.

It writes every capture to `<outdir>/shots` and the framed set to `<outdir>/framed` (PNG). The headlines and
sub-captions are in `apps/mobile/e2e/showcase/frames.json`. The repository keeps the framed set as JPEG at quality 90.

| Script | What it does |
| --- | --- |
| `showcase.sh` | All of it, in order |
| `boot.cjs` | The sample player's first launch: the app signs up its own account; the page's storage is saved |
| `seed.cjs` | The two clubs (over the API), then players, boards, standings, diamonds and the Night Market set (in SQL); then each language's names |
| `capture.cjs` | The screens, in six stories: the seeded hand, the same hand at the Night Market table, a hand at an online club table and its check, learning and leaderboards, clubs, the Shop |
| `frame.cjs` | The device frames, headlines and collages |
| `find-deal.cjs` | Plays many deals and lists the player's best wins |
