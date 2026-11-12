# Roadmap

The programme that takes the app from the audited 3.7/10 (`docs/ASSESSMENT.md`) to an 8-band product. Each phase lists what the owner must supply in `docs/OWNER_TODO.md`; engineering never blocks on it.

## Phase 1 — honest build (done)
- Engine rule fidelity: begging hands, 獨聽, 平胡, configurable 天/地/人胡 with absorption, 河底 claims, kong-replacement flowers, instant 八仙過海 / 七搶一, maxTai before dealer 台.
- Fairness: per-seat views leak nothing hidden; five-share ceremony with structured restarts and an attempt cap; clients verify the ceremony they took part in (`ok` / `partial` / `failed`); secure randomness fails closed.
- Server: typed config, token-bucket limits on sockets, HTTP and joins, unbiased codes, every rule set and club field validated; online tables are server-hosted only.
- Bots: three tiers with distinct policies (Beginner plays loosely and never defends; Club is efficient with basic defence; Pro adds a deal-in estimate, a fold and 台 terms); coach and review share one policy; lessons corrected. How the tiers compare is measured by the strength gate in CI, hand by hand on fixed seeds: `docs/ARCHITECTURE.md` ("Bot tiers and the strength gate") has the current figures and says what they do and do not show.
- App: pure-logic module with tests, server-only online flow, coach only at bot tables, honest diamond packs, env-driven app identity, ESLint and CI gates.

## Phase 2 — i18n scaffold (done; zh-TW still needs a native review)
- Locale resolution (en default, zh-TW for zh-Hant devices), `t()` everywhere, first-pass zh-TW marked for native review.

## Phase 3 — accounts and durable backend (done; the deployment itself is the owner's, `docs/DEPLOY.md`)
- In-house guest accounts upgraded to Sign in with Apple / Google; opaque sessions; Postgres with plain SQL migrations; tables persisted across restarts; client auto-reconnect; club membership enforced on join; Fly.io deployment.

## Phase 4 — store and legal (built; the legal texts are drafts pending counsel, and the store products are the owner's to create)
- Server-side wallet and entitlements fed by store webhooks; honest launch catalogue (Diamonds, table looks, Coach Gold / The Four Winds Club); terms, privacy, age gate, account deletion, seasonal standings, report flow.

## Phase 5 — audio and feel (done; recorded voice calls are still to be supplied)
- Tile sounds and voiced calls, win celebration, tile motion, landscape and portrait layout fixes, accessibility labels and 44 pt targets, `TableScreen` split into parts.

## Phase 6 — observability and push (done; each service switches on with its key)
- Crash reporting, product analytics, push notifications for club tables and waiting seats, minimum-build gate, health metrics.

## Phase 7 — device QA and listings (listings written in both languages; device QA, profiling, the zh-TW review and the beta are open)
- Real iPhone and low-end Android runs, profiling, zh-TW review, store listings and screenshots in both languages, TestFlight external beta.

## Phase 8 — content and validation (content done; validation open)
- Done: 36 lessons in six tracks, defence, claim and value puzzle themes beside best discard and read the wait, and a puzzle rating.
- Open: a Rush leaderboard, the golden scoring table checked against a reference app, beta clubs and interviews.

## Built outside the original phases
- Quick match: instant seating with strangers, bots in the empty seats, adults only.
- Safety: report and block from the table, a name blocklist, moderators' tools (dismiss, warn, mute, ban; a ban covers the account's devices), no free chat.
- Club owner tools: seasons, join requests, bans, closing a table, removing a player, passing a club on; club ownership tied to The Four Winds Club.
- Deployment: Fly and Neon runbook, deploy workflow with a smoke test, TestFlight and Play build workflows.

## Later
- Optional rule variants (七對子, 一條龍, 三色同順, 一炮多響 payment splits); Pinyin/Bopomofo tile labels; spectator seats; colour-blind tile marks; a public engine and verifier release.
