# Architecture

## Goals

1. **Play anywhere with friends** — private tables by code, like PokerBros, without a game company in the middle.
2. **Provably fair enough to bet a dinner on** — nobody can rig the shuffle; every hand is auditable by every player.
3. **Teach while you play** — the same analysis that drives the bots drives the coach.
4. **One rules engine everywhere** — phone host, neutral server host, bots, drills and audits all run identical code.

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
* **Transports** implement a 5-method interface: `LoopbackHub` (tests, offline), `RelayTransport` (WebSocket relay via the signaling server), `WebRTCTransport` (data channels with automatic fallback to relay per peer). The host's own player uses an in-process `Link`.
* **Hidden information**: clients only ever receive `TableView`s. The state hash in each update refers to the host's full state and is checked at audit time.

### Trust model

| Threat | Mitigation |
| --- | --- |
| Host rigs the shuffle | Seed is a hash of every seat's secret; commitments are published before any secret is revealed. |
| Host fakes actions or results | Action log + seed are published; each client replays and compares the hash and its own final hand. |
| Client sends illegal actions | Host validates against `legalActions`; errors are returned, state is re-sent. |
| Client acts for another seat | Peer id → seat binding; rejected. |
| Host peeks at the wall (modified app) | Not prevented in pure P2P mode. Options: neutral server host (same code, run by the club), or rotate who hosts each hand. Mental-mahjong shuffle planned. |
| Player stalls | Turn timers; bot auto-plays on timeout or disconnect; seat is reclaimable by name. |

### Signaling server (`apps/signal`)

Stateless-ish WebSocket server: `hello`, `create`, `join`, `to` (relay), `leave`. Rooms die when empty. With `HOST_TABLES` enabled, `create {hosted:true}` instantiates a `TableHost` inside the server bound to a `ServerTransport`, so the room's host peer is the server. `/health` returns counts.

### Mobile app (`apps/mobile`)

Expo SDK 58, React Native 0.88, TypeScript. No navigation library: a small screen stack in `app-state.tsx`. `game/session.ts` builds a `Session` (local bots, host for friends, guest, or server-hosted). `useSession` subscribes to client state and drives host timers when this device hosts. The table renders relative seats (下家 right, 對家 top, 上家 left), melds, discard pools, flowers, a contextual action bar (胡/槓/碰/吃/過/打), and the coach panel (status, waits with remaining counts, recommended discard highlighted, claim advice). Result overlay shows the 台 breakdown, payments and the audit verdict.

## Determinism rules

* Never read `Date.now()` or `Math.random()` inside the engine. Randomness enters only through the seed.
* `applyAction` must not mutate its input (we clone via JSON; states are small).
* Any new rule must be covered by `scoring.test.ts` or `game.test.ts` and must keep `replay` byte-identical.
