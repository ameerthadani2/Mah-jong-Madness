# Architecture

## Goals

1. **Play anywhere with friends** — private tables by code, like PokerBros, hosted by our game server and checked by every player.
2. **Provably fair enough to bet a dinner on** — nobody can rig the shuffle; every hand is auditable by every player.
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
* `hand.ts` — decomposition into 5 sets + pair, waits, shanten. Shanten splits the hand into the three suits plus the honor block, reduces each to a Pareto front of (melds, partials, pair) and combines them; fronts are memoised by count signature. Fast enough for bot search on mobile (~45 ms per full hand of 4 bots).
* `scoring.ts` — `scoreWin(WinContext)` tries every decomposition and returns the max-台 breakdown. `computePayments` applies dealer 台 per transaction.
* `game.ts` — the JSON `GameState` and a pure `applyAction(state, seat, action)`. Phases: `discard` (player to act), `claim` (others respond to a discard or 加槓), `ended`. Drawing, flower replacement, kong replacement, dead-wall exhaustion and dealer rotation are internal transitions, so the only external inputs are player actions. `hashState`, `replayHand`, `matchSnapshot` support auditing.
* `view.ts` — `viewFor(state, seat)` strips other hands and the wall; `viewToState(view)` rebuilds an engine-shaped object so clients can run hints and legality checks on visible information only.
* `bot.ts` — shanten + acceptance ranking, simple danger model, claim policy. Also used for timeouts and disconnected seats.
* `hints.ts`, `lessons.ts` — coach text and curriculum data.

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
| Player stalls | Turn timers; bot auto-plays on timeout or disconnect; the seat is reclaimable with its rejoin token. |

### Clocks, time banks and game speeds

Each seat that owes an action gets its own clock (`TableHost.clocks`): a base turn timer (`rules.turnSeconds`) and, once that expires, a per-hand time bank (`rules.timeBankSeconds`) that drains while they think. When the bank is empty the bot plays for them with the table's bot skill. Speeds are presets over those two numbers: Relaxed 30+60, Normal 15+30, Fast 10+20, Turbo 7+10, Hyper 4+0. The client receives its own deadline, remaining bank and an `inTimeBank` flag with every state update.

### Resume after a crash or disconnect

The app has two modes (`Session.mode`): `local` (offline bot tables, hosted on the phone) and `online` (every table with other people, hosted by the game server).

* **Online tables**: `welcome` carries a random rejoin token. The app persists `{signalUrl, roomCode, token}`, where `signalUrl` is the server that hosts that table; on relaunch Home offers *Resume*, which rejoins the room and presents the token. The server's table hands the seat back even if a bot has been standing in and the name changed. A player who rejoins mid-hand still verifies the log, but that hand's audit reads *partial* because their share was not used.
* **Offline bot tables**: `TableHost.serialize()` is written to storage after every change (debounced). On relaunch the host is rebuilt with `restore` and the local client rejoins with its token, landing in the same hand with the same wall.
* **Everyone dropping at once**: the room stays alive for 15 minutes with no peers and the table pauses at the next `hand_over` when no human is connected. Tables live in the server's memory, so a server restart still ends them; persisted tables are on the roadmap.

### Clubs (`apps/signal/src/clubs.ts`, `api.ts`)

A club is a 6-letter code with an owner, admins and members, house rules (any `RuleSet`), settings (approval required, members may open tables) and standings. `POST /api/clubs/:code/tables` creates a server-hosted room with the club's rules and registers it; host events keep the table list live and fold `match_over` scores into member standings. Identity is a client-generated `userId` today; Sign in with Apple/Google replaces it before launch (see roadmap).

### Single-player and learning

`puzzles.ts` generates seeded best-discard and read-the-wait puzzles (daily = date seed, Puzzle Rush = run seed + index, difficulty ramps). `review.ts` replays a finished hand from its audit (snapshot + seed + log) and grades every decision against the pro bot. Bots come in three skills with distinct policies so a learner can climb.

### Signaling server (`apps/signal`)

WebSocket server: `hello`, `create`, `join`, `to` (relay), `leave`. `create {hosted:true}` instantiates a `TableHost` inside the server bound to a `ServerTransport`, so the room's host peer is the server; this is how every online table runs. Rooms close 15 minutes after the last peer leaves. `/health` returns counts.

### Mobile app (`apps/mobile`)

Expo SDK 58, React Native 0.88, TypeScript. No navigation library: a small screen stack in `app-state.tsx`. `game/session.ts` builds a `Session`: `local` (an in-process `TableHost` with bots) or `online` (a `TableClient` on a server-hosted room over `RelayTransport`). `useSession` subscribes to client state and drives the host's timers for local tables. The coach panel is shown only at local tables. The table renders relative seats (下家 right, 對家 top, 上家 left), melds, discard pools, flowers, a contextual action bar (胡/槓/碰/吃/過/打), and the coach panel (status, waits with remaining counts, recommended discard highlighted, claim advice). Result overlay shows the 台 breakdown, payments and the audit verdict.

## Determinism rules

* Never read `Date.now()` or `Math.random()` inside the engine. Randomness enters only through the seed.
* `applyAction` must not mutate its input (we clone via JSON; states are small).
* Any new rule must be covered by `scoring.test.ts` or `game.test.ts` and must keep `replay` byte-identical.
