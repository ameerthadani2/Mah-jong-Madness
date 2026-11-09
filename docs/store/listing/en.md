# Store listing — English

The product name is **Mahjong Mania** (`APP_NAME`); the store title adds what the game is, which also helps search. Character limits: App Store name 30, subtitle 30, promotional text 170, keywords 100 (comma-separated, no spaces after commas); Google Play title 30, short description 80, full description 4,000. `apps/mobile/src/monetisation/listing.test.ts` checks the limits and the wording rules below.

Wording rules: no third-party trademarks (no other apps or sites by name); the fairness line says what the app does ("every hand is logged and checked on your phone"), never that a hand "cannot be rigged" or that "not even the server" could change it; every paid feature is named with the plan that unlocks it (App Store guideline 2.3.2).

## Name
Mahjong Mania: Taiwan 16

## Subtitle (App Store)
Taiwanese 16-tile mahjong

## Short description (Play)
Taiwanese 16-tile mahjong with friends, clubs, lessons and puzzles.

## Promotional text
Play Taiwanese 16-tile mahjong with friends anywhere. Every hand is logged and checked on your phone, and the result sheet says how each shuffle was verified.

## Description
Mahjong Mania is Taiwanese 16-tile mahjong (台灣麻將) the way it is played at the table: five sets and a pair, flowers, 連莊, 台 counting, and the house rules your club argues about.

PLAY WITH FRIENDS, ANYWHERE
Join a club or a friend's table with a six-letter code or a shared link, set the house rules (底/台, speed, 連莊, 一炮多響, 過水) and sit down. Tables run on the game server with per-seat clocks and time banks, so a dropped connection never ends your night: rejoin from the home screen and your seat is waiting.

EVERY HAND CHECKED
Before any tile is dealt, every seat and the server commit to a secret, and the wall is derived from all of them. Every hand is logged and checked on your phone: after the hand it re-derives the shuffle, replays the hand and checks the result. The result sheet shows Verified when this device saw the whole deal, or says plainly what it could not check.

LEARN AND IMPROVE
Lessons in six tracks (basics, efficiency, calling, 台 value, defence, scoring) written for 16-tile play, with quizzes checked by the engine. A daily puzzle, Puzzle Rush, discard and wait drills, and a coach that explains every suggestion. After a hand, the review grades each decision and shows the better move.

PLAY OFFLINE
Bots from a beginner who grabs every pong to a pro that folds against a ready hand. No connection needed.

MAKE THE TABLE YOURS
Table felts, tile backs, avatar frames, emote packs and win celebrations, bought with diamonds. They change only how the game looks.

FREE TO PLAY, WITH OPTIONAL PURCHASES
Free: every lesson, the daily puzzle, drills, the coach at bot tables, 1 hand review and 1 Puzzle Rush a day, Beginner and Club bots, online tables, and joining and playing in any club.
- Coach Gold (subscription, monthly or yearly): Pro bots and unlimited Puzzle Rush.
- The Four Winds Club (subscription, monthly or yearly): everything in Coach Gold, unlimited hand reviews, and creating and running your own clubs.
- Diamonds (one-time purchases): buy cosmetic looks only.
Prices are shown in the store in your currency. Subscriptions renew automatically until you cancel them in your App Store or Google Play account settings at least 24 hours before the renewal date. Nothing you can buy changes the tiles you draw, what you see at the table, or the clock.

Scores and diamonds have no monetary value and cannot be redeemed or transferred.

## Keywords (App Store)
mahjong,taiwanese,16 tile,台灣麻將,麻將,club,friends,puzzle,lessons,coach

## What's new (first release)
First release: clubs with house rules, checked shuffles, lessons and puzzles, bots at three strengths, and table looks to collect.

## In-app purchases to list in App Store Connect and Play Console
Coach Gold monthly and yearly (`coach.gold.month`, `coach.gold.year`); The Four Winds Club monthly and yearly (`fourwinds.month`, `fourwinds.year`); diamond packs `diamonds.60`, `diamonds.300`, `diamonds.600`, `diamonds.1300`, `diamonds.3450`, `diamonds.7500`. Display names and descriptions: `apps/mobile/src/i18n/locales/en/shop.json` (`products`).

## Category
Games › Board (secondary: Card)

## Age rating notes
Simulated gambling: frequent (mahjong with scores). No real-money play, no prizes, nothing with cash value. 17+ on the App Store; Taiwan rating 輔15 (counsel to confirm).

## Privacy nutrition labels (what the app collects)
- Contact info: email (only if you sign in with Apple/Google and share it) — account management, linked to you.
- Identifiers: user ID, device ID — app functionality, linked to you.
- Purchases: purchase history — app functionality, linked to you.
- User content: the note on a player report and display names — app functionality (moderation, standings), linked to you.
- Gameplay content: hands, results, club standings and puzzle answers — app functionality, linked to you.
- Other data: birth year (age gate) — app functionality and legal compliance, linked to you.
- Usage data: product interaction, only while "Share usage statistics" is on — analytics, not linked to you.
- Diagnostics: crash data, only while "Send crash reports" is on (the switch also stops native crash reports) — app functionality, not linked to you.
No tracking across apps. Data is not sold.

## Review notes
No sign-in is needed to review: the app plays offline, and a guest account is created the first time you open Online, Clubs or a purchase. Online play: Online → open a table, or Clubs → join a club; bots fill empty seats. Creating a club needs The Four Winds Club (a sandbox subscription works for reviewer accounts on the tester list). Purchases are server-verified; Restore Purchases is in the Shop.
