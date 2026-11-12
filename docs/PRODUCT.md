# Product definition

**Mahjong Mania (麻將狂熱; store title "Mahjong Mania: Taiwan 16") is the Taiwanese 16-tile Mahjong app you would trust with your friends' game night and your own improvement.** Three pillars: play with anyone anywhere (clubs), get better every day (structured learning), and see for yourself how each deal was made (every hand logged and checked on your phone).

## Who it is for
1. **Club organisers** (the PokerBros persona): someone who runs a weekly game for a group across Taipei, Vancouver and Sydney and wants their rules, their standings, no cheating and no arguments.
2. **Improvers**: players who know the rules but lose to their uncle, want to understand 台 and efficiency, and like streaks and puzzles.
3. **Returning diaspora players**: grew up watching, never learned properly, want a friendly on-ramp with bots and a coach.

## Modes

### Play
* **Clubs**: create by code, roles (owner/admin/member), approval queue, house rules (底/台, speed, 連莊, 一炮多響, 過水, flowers), server-hosted tables, standings by season, invite links through the phone's share sheet (so LINE, WhatsApp or any other app), owner tools (close a table, remove or ban a player, pass the club on), inter-club matches (roadmap). Joining and playing is free; creating and running a club needs The Four Winds Club.
* **Quick table**: a six-character code; every online table is hosted by the game server and verified by every player.
* **Quick match**: seated with strangers in arrival order, bots in the empty seats after a short wait, default rules at Normal speed. Adults only (a birth year of 18 or over on the server), no free chat, and report and block from any seat; two players who blocked each other are never seated together.
* **Vs bots**: three skill levels with distinct policies; a rated ladder (roadmap).
* **Speeds**: Relaxed / Normal / Fast / Turbo / Hyper with per-hand time banks; the bot plays for you when you run out; disconnect protection is free.

### Learn (chess.com layer — no 16-tile incumbent has one)
* **Coach at the table**: shanten, waits with remaining counts, recommended discard, claim advice, win preview with 台 breakdown.
* **Daily puzzle**: same puzzle worldwide, weekends harder, streak with a grace day (roadmap: freeze item).
* **Puzzle Rush**: 3 minutes, 3 strikes; rotates all five themes (best discard, defence, read the wait, claim or pass, keep the 台) with difficulty ramping by puzzle number (1 for the first five, 2 to the 15th, then 3). A run scores 100 points per solved puzzle plus a pace bonus of up to 50 each (`rushScore`); best score and most puzzles solved are kept.
* **Puzzle themes**: best discard and read the wait (tile efficiency); defence (the safest discard against a visibly close opponent, with their exposed sets and every discard row shown); claim or pass (the tile just thrown by 上家, 對家 or 下家 and a button per legal response: pass, each 吃 shape, 碰, 槓, 胡); keep the 台 (two discards both leave you ready, one keeps a pattern; both 台 projections show after answering). Every answer is checked by the engine and followed by its reason and explanation in the player's language.
* **Puzzle rating (drills count too)**: Elo-style (K = 32), starting at 1000. Each answered puzzle (the daily puzzle's first attempt and every Rush puzzle) is a game against the puzzle's own rating (by difficulty, plus an offset per theme), so a solve raises it and a miss lowers it, never below 100. The last 30 answers are kept for the trend; the rating shows on the puzzle screens and the Home learn card.
* **Drills**: best discard, read the wait, three difficulties.
* **Lessons**: tiles → winning → calls → 台 counting → efficiency → defence, with quizzes.
* **Hand review**: every decision graded best/good/inaccuracy/mistake/blunder with an accuracy score; free 1/day.
* **Roadmap**: a seasonal Rush leaderboard and server-side puzzle results, ratings per speed (Glicko), weekly league (8 tiers, divisions of 50, no demotion), achievements, luck dashboard (自摸 rate, deal-in rate, starting shanten vs expectation), coach personas.

### Fair play
* Commit–reveal shuffle with a host share, SHA-256 counter DRBG keyed by the full seed, per-hand audit verified on every phone, Fair-play screen, neutral-server hosting for clubs. See `docs/FAIRNESS.md`.

## Platforms
Expo / React Native: iOS (iPhone, iPad), Android (phones, tablets), web. Landscape table that fits 17 tiles on an iPhone SE; lobby screens responsive. Online play goes through the game server over WebSocket.

## Free vs paid (summary — details in `docs/MONETISATION.md`)
Everything needed to play with friends is free: joining and playing in clubs, tables, all speeds, resume, coach at the table, daily puzzle, drills, every lesson, two bot levels, one review and one Puzzle Rush per day. Paid: Coach Gold (Pro bots, unlimited Puzzle Rush), The Four Winds Club (everything in Gold, unlimited reviews, creating and running clubs) and cosmetics bought with diamonds (`docs/MONETISATION.md`).

## Metrics that matter
D1/D7 retention of players who finished a hand; % of tables that are club tables; hands per club per week; review open rate; daily-puzzle streak length; audit-verified rate (should be 100%); crash-resume success rate; time-to-first-table for a new user.

## What we deliberately leave out
Casino mini-games (slots, fishing, baccarat): they drag the app into 類博弈 regulation and 18+ labelling and attract the wrong players. Loot boxes. Agent/settlement tooling. Anything purchasable that touches the tiles or the clock.
