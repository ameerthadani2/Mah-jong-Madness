# Roadmap

The programme that takes the app from the audited 3.7/10 (`docs/ASSESSMENT.md`) to an 8-band product. Each phase lists what the owner must supply in `docs/OWNER_TODO.md`; engineering never blocks on it.

## Phase 1 — honest build (done)
- Engine rule fidelity: begging hands, 獨聽, 平胡, configurable 天/地/人胡 with absorption, 河底 claims, kong-replacement flowers, instant 八仙過海 / 七搶一, maxTai before dealer 台.
- Fairness: per-seat views leak nothing hidden; five-share ceremony with structured restarts and an attempt cap; clients verify the ceremony they took part in (`ok` / `partial` / `failed`); secure randomness fails closed.
- Server: typed config, token-bucket limits on sockets, HTTP and joins, unbiased codes, every rule set and club field validated; online tables are server-hosted only.
- Bots: Pro beats Club by about 5 points a hand on the ladder, Beginner wins about 12%; coach and review share one policy; lessons corrected.
- App: pure-logic module with tests, server-only online flow, coach only at bot tables, honest diamond packs, env-driven app identity, ESLint and CI gates.

## Phase 2 — i18n scaffold
- Locale resolution (en default, zh-TW for zh-Hant devices), `t()` everywhere, first-pass zh-TW marked for native review.

## Phase 3 — accounts and durable backend
- In-house guest accounts upgraded to Sign in with Apple / Google; opaque sessions; Postgres with plain SQL migrations; tables persisted across restarts; client auto-reconnect; club membership enforced on join; Fly.io deployment.

## Phase 4 — store and legal
- Server-side wallet and entitlements fed by store webhooks; honest launch catalogue (Diamonds, table looks, Coach Gold / Platinum); terms, privacy, age gate, account deletion, seasonal standings, report flow.

## Phase 5 — audio and feel
- Tile sounds and voiced calls, win celebration, tile motion, landscape and portrait layout fixes, accessibility labels and 44 pt targets, `TableScreen` split into parts.

## Phase 6 — observability and push
- Crash reporting, product analytics, push notifications for club tables and waiting seats, minimum-build gate, health metrics.

## Phase 7 — device QA and listings
- Real iPhone and low-end Android runs, profiling, zh-TW review, store listings and screenshots in both languages, TestFlight external beta.

## Phase 8 — content and validation
- 25–40 lessons in tracks, defence/claim/value puzzle themes, a puzzle rating and Rush leaderboard, the golden scoring table checked against a reference app, beta clubs and interviews.

## Later
- Optional rule variants (七對子, 一條龍, 三色同順, 一炮多響 payment splits); Pinyin/Bopomofo tile labels; spectator seats; colour-blind tile marks; a public engine and verifier release.
