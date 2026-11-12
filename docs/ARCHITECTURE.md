# Architecture

## Goals

1. **Play anywhere with friends** — private tables by code, like PokerBros, hosted by our game server and checked by every player.
2. **Checkable fairness** — every player's phone contributes to the shuffle and checks every hand it watched; the app says plainly what a phone could not check.
3. **Teach while you play** — the same analysis that drives the bots drives the coach.
4. **One rules engine everywhere** — the server's tables, offline bot tables on the phone, bots, drills and audits all run identical code.

## Layers

```
apps/mobile  ──┐
apps/signal  ──┼──▶ @mjm/net  (TableHost / TableClient / transports / fairness)
tests, sim   ──┘         │
                         ▼
                   @mjm/engine (GameState, applyAction, scoring, bots, hints)
```

### Engine (`packages/engine`)

* `tiles.ts` — 144 physical tiles (`TileId` 0..143) over 42 kinds (34 playable + 8 bonus).
* `hand.ts` — decomposition into 5 sets + pair, waits, shanten. Shanten is the distance to the nearest complete target (sets + pair) that holds at most four copies of any kind, so an un-konged quad is never read as a pong waiting on a fifth copy. It splits the hand into the three suits plus the honor block, computes each block's best overlap per (sets, pair) share with a small dynamic programme, and combines the four tables; tables are memoised by count signature. Fast enough for bot search on mobile (~40 ms per full hand of 4 bots).
* `scoring.ts` — `scoreWin(WinContext)` tries every decomposition and returns the max-台 breakdown. `computePayments` applies dealer 台 per transaction.
* `game.ts` — the JSON `GameState` and a pure `applyAction(state, seat, action)`. Phases: `discard` (player to act), `claim` (others respond to a discard or 加槓), `ended`. Drawing, flower replacement, kong replacement, dead-wall exhaustion and dealer rotation are internal transitions, so the only external inputs are player actions. `hashState`, `replayHand`, `matchSnapshot` support auditing.
* `view.ts` — `viewFor(state, seat)` strips other hands and the wall; `viewToState(view)` rebuilds an engine-shaped object so clients can run hints and legality checks on visible information only.
* `bot.ts` — shanten + acceptance ranking, simple danger model, claim policy. Also used for timeouts and disconnected seats.
* `rules.ts` — the `RuleSet` every table plays, its defaults, ranges and speed presets, and `sanitizeRules` for rules that arrive from outside (docs/RULES.md, "Rule options").
* `hints.ts` — coach text. `lessons.ts` and `lessons/` — the curriculum: 36 lessons in six tracks, with quizzes the engine checks.
* `puzzles.ts` — seeded puzzles in five themes (best discard, read the wait, defence, calling, value). `rating.ts` — the puzzle rating. `review.ts` — replays a finished hand from its audit and grades each decision.

### Net (`packages/net`)

* **TableHost** owns the authoritative `GameState`, seats, timers and bots. It validates each action with the engine, broadcasts per-seat views, and publishes an `Audit` after every hand.
* **TableClient** joins, takes part in the ceremony, sends actions, keeps the latest view and verifies audits.
* **Fairness**: commit–reveal seed per hand (`fairness.ts`). The seed is derived only after all commitments are in; a seat that fails to reveal is replaced by a bot stand-in and the ceremony restarts, so a griefer cannot stall a table.
* **Transports** implement a 5-method interface: `LoopbackHub` (tests, offline bot tables) and `RelayTransport` (WebSocket relay via the game server, used by every online player). The server's table and the offline host each reach their players through a `Link`.
* **Hidden information**: clients only ever receive `TableView`s. The state hash in each update refers to the host's full state and is checked at audit time.

### Trust model

| Threat | Mitigation |
| --- | --- |
| Host rigs the shuffle | Seed is a hash of every seat's secret; commitments are published before any secret is revealed. |
| Host fakes actions or results | Action log + seed are published; each client replays and compares the hash and its own final hand. |
| Client sends illegal actions | Host validates against `legalActions`; errors are returned, state is re-sent. |
| Client acts for another seat | Peer id → seat binding; rejected. |
| Host peeks at the wall | Online tables are hosted only by the game server, never by a player's phone, so no player holds the wall. The server itself could still peek; the audit cannot detect that, and a mental-mahjong shuffle remains on the roadmap. |
| Player stalls | Turn timers. When a seat's time runs out (a dropped player's included) the table plays its own turn as a bot would, and answers an offer on another seat's discard with a pass unless the offer is a win: it never opens a player's hand for them. The seat is reclaimable with its rejoin token. |

### Clocks, time banks and game speeds

Each seat that owes an action gets its own clock (`TableHost.clocks`): a base turn timer (`rules.turnSeconds`) and, once that expires, a per-hand time bank (`rules.timeBankSeconds`) that drains while they think. When the bank is empty the bot plays for them with the table's bot skill. Speeds are presets over those two numbers: Relaxed 30+60, Normal 15+30, Fast 10+20, Turbo 7+10, Hyper 4+0. The client receives its own deadline, remaining bank and an `inTimeBank` flag with every state update.

### Resume after a crash or disconnect

The app has two modes (`Session.mode`): `local` (offline bot tables, hosted on the phone) and `online` (every table with other people, hosted by the game server).

* **Online tables**: `welcome` carries a random rejoin token. The app persists `{signalUrl, roomCode, token}`, where `signalUrl` is the server that hosts that table; on relaunch Home offers *Resume*, which rejoins the room and presents the token. The server's table hands the seat back even if a bot has been standing in and the name changed. A player who rejoins mid-hand still verifies the log, but that hand's audit reads *partial* because their share was not used.
* **Offline bot tables**: `TableHost.serialize()` is written to storage after every change (debounced). On relaunch the host is rebuilt with `restore` and the local client rejoins with its token, landing in the same hand with the same wall.
* **Everyone dropping at once**: the room stays alive for 15 minutes with no peers and the table pauses at the next `hand_over` when no human is connected. A server restart does not end a table either: every hosted table is written to `table_snapshots` as it changes and restored at boot under its own code, and players take their seats back with their rejoin tokens (see "Signaling server" below, and `apps/signal/README.md`, "Persistence").

### Clubs (`apps/signal/src/clubs.ts`, `api.ts`)

A club is a six-character code with an owner, admins and members, house rules (any `RuleSet`), settings (approval required, members may open tables, the bot skill) and standings. `POST /api/clubs/:code/tables` creates a server-hosted room with the club's rules and registers it; host events keep the table list live and fold `match_over` scores into member standings (only for a match that started with at least two human members). Standings are points only, kept per season and all-time; the owner closes a season and its final standings are archived. Owners and admins approve or turn down join requests, remove and ban members, close a table and take a player off one. Every club route takes the caller's bearer session, and the member id is the account the session proves, never an id the client sends. Joining and playing is free; once the store is live, creating a club needs The Four Winds Club, an account owns at most three, and a lapsed plan drops each club's open-table cap to one after a grace period (docs/API.md, "Clubs").

### Single-player and learning

`puzzles.ts` generates seeded best-discard and read-the-wait puzzles (daily = date seed, Puzzle Rush = run seed + index, difficulty ramps). `review.ts` replays a finished hand from its audit (snapshot + seed + log) and grades every decision against the pro bot. Bots come in three skills with distinct policies.

**Bot tiers and the strength gate.** Beginner plays for tile efficiency with mistakes and never measures danger. Club is efficient, claims when a claim helps, and leans a little away from a seat it reads as ready. Pro adds three things to that: a per-tile deal-in estimate (`readOpponents`, `waitChance` in `bot.ts`), a fold when it is two or more tiles from ready and a seat is probably ready, and 台 terms (value-honour pairs and pongs, a flush once it is in reach). CI runs `npm run sim -- --gate` (`packages/engine/scripts/simulate.ts`, rules in `packages/engine/test/helpers/gate.ts`): 2,000 fixed seeds, each played three times with three Club bots around a rotating test seat (Pro in the seat, Club in the seat, and Pro with its deal-in and 台 terms switched off in the seat), compared hand by hand with `packages/engine/test/fixtures/bot-gate.json`. The seeds are fixed, so a run differs from the reference only where the bots changed; the gate fails when Pro minus Club, or Pro minus Pro-without-the-terms, drops more than 1 point a hand below the reference, when Pro is behind Club at 95%, or when the terms cost points at 95% or change no hand. After an intended change to Pro or Club, record a new reference with `npm run sim -- --gate --record` and read its diff. Tried against five altered Pros (`--weights`): the gate fails one with the deal-in terms off (1.18 points a hand below the reference), one that folds far too readily (4.69 below) and the old claim threshold that lost to Club (11.21 below, behind Club at 95%); it fails one with every term off only because the terms then change no hand, although that Pro scores 2.23 higher on these hands; and it passes one with the 台 terms off, which scores 0.52 higher.

What the gate shows today, and what it does not: Pro minus Club is +1.04 points a hand (standard error 4.36, 95% interval -7.51 to +9.59), so Pro is not clearly ahead of Club on these hands. Pro minus Pro without the terms is -2.23 points a hand (standard error 3.47, interval -9.03 to +4.57): no measurable gain from the deal-in and 台 terms. The terms change the test seat's score in 798 of the 2,000 hands; with them Pro deals in on 351 hands against 395 without (Club: 384), but it wins 514 against 530, and on 3,000 other seeds the deal-in counts went the other way (545 against 520). So Pro does fold in the constructed positions the engine tests pin (`packages/engine/test/bots.test.ts`), but that has not been shown to earn points, or reliably to cut deal-ins, over whole hands. The gate reports this on every run and does not fail on it; until a Pro puts the second comparison ahead at 95%, product copy should not promise more than "Pro reads danger and may fold".

A retune was tried on 12 November 2026 and changed nothing. A sweep of 33 weight settings over 3,000 paired hands found none ahead of today's Pro at 95%; the one candidate named in advance (a gentler flush chase) was then played on 8,000 held-out hands and was not ahead (+0.44 points a hand, standard error 0.47), and the best exploratory setting failed its own confirmation on a third set of 8,000 (+0.33, standard error 0.60). The weights therefore stay as they are. Over those 19,000 fresh paired hands against three Club bots, Pro scored 1.9 points a hand more than Club in the same seat (standard error 1.4): a small edge that is not clear of zero. Folding more trades deal-ins for wins at about break-even, which says the danger estimate does not yet separate dangerous tiles from safe ones well enough for a fold to pay. A clearly stronger Pro needs a better model rather than other weights: a sharper read of which waits are still possible, look-ahead at one step from ready, and a faster hand simulator so that discards can be compared by playing them out.

### Signaling server (`apps/signal`)

One Node process: a WebSocket server for tables and an HTTP API, over Postgres or, with no database configured, in-memory repositories (`src/repos`). `docs/API.md` is the reference for every route and frame; `apps/signal/README.md` for configuration and limits.

* **Sockets.** Frames: `hello` (the first frame, carrying the session token), `create`, `join`, `to` (relay), `leave`, `ping`, and `queue` / `leave_queue` for quick match. `create {hosted:true}` instantiates a `TableHost` inside the server bound to a `ServerTransport`, so the room's host peer is the server; this is how every online table runs. The server binds the account that `hello` proved to the seat: a table `join` always carries the verified user id and the account's display name, whatever the client sent.
* **Accounts and sessions** (`src/auth`). A device starts as a guest account (a random id and a secret kept in the phone's secure storage) and can link Sign in with Apple or Google; a guest that signs in to an existing account is merged into it. Sessions are opaque tokens stored as peppered hashes, sliding 30 days. Deleting an account scrubs it at once and purges the row after 30 days; what outlives it (scores without the name, purchase records, reports) is listed in docs/STORE_COMPLIANCE.md. On the device: the birth year is sent only when the server has none; a name the server refused is masked until the player changes it; a ban is remembered for 24 hours before the app asks the server again; and "Start fresh" on a signed-out device asks the server for the new guest before it sets the old identity aside (docs/API.md, "what the app relies on").
* **Persistence** (`src/persist.ts`, `migrations/`). Clubs are held in memory and written behind each change; every hosted table is snapshotted as it changes and restored at boot. Room lifetimes: a table with a seated human and nobody connected is kept for 15 minutes; a lobby opened over the socket closes as soon as it empties; a started quick-match table closes 2 minutes after its last player dropped.
* **Quick match and moderation** (`src/matchmaking.ts`, `src/moderation.ts`). The queue seats strangers four to a table in arrival order, fills with Club bots after 20 seconds, never seats two accounts where either blocked the other, and refuses banned accounts and accounts without a birth year of 18 or over. Players report and block each other; moderators (an admin token) dismiss, warn, mute or ban, and a ban covers the account's devices. There is no free text at a table: phrases and emotes are ids. Display names, club names and descriptions pass a blocklist.
* **Wallet and store** (`src/wallet.ts`, `src/catalog.ts`, `src/reconcile.ts`). Entitlements are decided on the server from RevenueCat webhooks, stored raw and applied once; diamonds buy cosmetics only. A refund takes back only the period its transaction paid for (docs/MONETISATION.md).
* **Push** (`src/push.ts`). Expo push for "club table opened", "join request approved" and "your table is waiting", to devices whose owner allowed notifications.
* `/health` returns counts, the storage in use, snapshot write counters and the action-to-state latency (docs/OBSERVABILITY.md).

### Mobile app (`apps/mobile`)

Expo SDK 58, React Native 0.88, TypeScript. No navigation library: a small screen stack in `app-state.tsx`. `game/session.ts` builds a `Session`: `local` (an in-process `TableHost` with bots) or `online` (a `TableClient` on a server-hosted room over `RelayTransport`). `useSession` subscribes to client state and drives the host's timers for local tables. The coach panel is shown only at local tables. The table renders relative seats (下家 right, 對家 top, 上家 left), melds, discard pools, flowers, a contextual action bar (胡/槓/碰/吃/過/打), and the coach panel (status, waits with remaining counts, recommended discard highlighted, claim advice). Result overlay shows the 台 breakdown, payments and the audit verdict.

## Determinism rules

* Never read `Date.now()` or `Math.random()` inside the engine. Randomness enters only through the seed.
* `applyAction` must not mutate its input (we clone via JSON; states are small).
* Any new rule must be covered by `scoring.test.ts` or `game.test.ts` and must keep `replay` byte-identical.
