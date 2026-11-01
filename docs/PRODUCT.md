# Product definition

**Mahjong Madness is the Taiwanese 16-tile Mahjong app you would trust with your friends' money and your own improvement.** Three pillars: play with anyone anywhere (clubs), get better every day (chess.com-style learning), and never wonder whether the deal was rigged (verifiable luck).

## Who it is for
1. **Club organisers** (the PokerBros persona): someone who runs a weekly game for a group across Taipei, Vancouver and Sydney and wants their rules, their standings, no cheating and no arguments.
2. **Improvers**: players who know the rules but lose to their uncle, want to understand 台 and efficiency, and like streaks and puzzles.
3. **Returning diaspora players**: grew up watching, never learned properly, want a friendly on-ramp with bots and a coach.

## Modes

### Play
* **Clubs**: create by code, roles (owner/admin/member), approval queue, house rules (底/台, speed, 連莊, 一炮多響, 過水, flowers), server-hosted tables, standings, LINE/WhatsApp invite links (roadmap), inter-club matches (roadmap).
* **Quick table**: a 6-letter code, phone-hosted or neutral-server hosted.
* **Vs bots**: three skill levels with distinct policies; a rated ladder (roadmap).
* **Speeds**: Relaxed / Normal / Fast / Turbo / Hyper with per-hand time banks; the bot plays for you when you run out; disconnect protection is free.

### Learn (chess.com layer — no 16-tile incumbent has one)
* **Coach at the table**: shanten, waits with remaining counts, recommended discard, claim advice, win preview with 台 breakdown.
* **Daily puzzle**: same puzzle worldwide, weekends harder, streak with a grace day (roadmap: freeze item).
* **Puzzle Rush**: 3 minutes, 3 strikes, difficulty ramps; best score on profile.
* **Drills**: best discard, read the wait, three difficulties.
* **Lessons**: tiles → winning → calls → 台 counting → efficiency → defence, with quizzes.
* **Hand review**: every decision graded best/good/inaccuracy/mistake/blunder with an accuracy score; free 1/day.
* **Roadmap**: ratings per speed (Glicko), weekly league (8 tiers, divisions of 50, no demotion), achievements, luck dashboard (自摸 rate, deal-in rate, starting shanten vs expectation), coach personas.

### Fair play
* Commit–reveal shuffle with a host share, SHA-256 counter DRBG keyed by the full seed, per-hand audit verified on every phone, Fair-play screen, neutral-server hosting for clubs. See `docs/FAIRNESS.md`.

## Platforms
Expo / React Native: iOS (iPhone, iPad), Android (phones, tablets), web. Landscape table that fits 17 tiles on an iPhone SE; lobby screens responsive. True device-to-device WebRTC via a dev-client build; relay fallback everywhere.

## Free vs paid (summary — details in `docs/MONETISATION.md`)
Everything needed to play with friends is free: clubs, tables, all speeds, resume, coach at the table, daily puzzle, drills, lessons 1–3, two bot levels, one review and one Puzzle Rush per day. Paid: coaching tiers, club capacity, cosmetics, VIP cards.

## Metrics that matter
D1/D7 retention of players who finished a hand; % of tables that are club tables; hands per club per week; review open rate; daily-puzzle streak length; audit-verified rate (should be 100%); crash-resume success rate; time-to-first-table for a new user.

## What we deliberately leave out
Casino mini-games (slots, fishing, baccarat): they drag the app into 類博弈 regulation and 18+ labelling and attract the wrong players. Loot boxes. Agent/settlement tooling. Anything purchasable that touches the tiles or the clock.
