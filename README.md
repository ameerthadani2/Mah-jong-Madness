# Mahjong Madness 🀄

**Peer-to-peer Taiwanese 16-tile Mahjong (台灣麻將) for iOS and Android, with a coach that teaches you while you play.**

Think PokerBros for Mahjong: create a private table, share a six-letter code, and play with friends anywhere.
The game runs on the players' own phones. No company server deals the tiles, every player can audit every hand,
and bots fill empty seats so a table always runs.

![Table screen with coach panel](docs/screenshot-table.png)

## What is in this repository

| Path | What it is |
| --- | --- |
| `packages/engine` | Pure TypeScript rules engine: 144 tiles, 16-tile hands, chi/pong/kong (incl. 加槓 robbing), flowers and instant flower wins, dead wall, dealer rotation, full 台 scoring with an itemised breakdown, deterministic replay, bots, and the coaching/learning layer. No dependencies. |
| `packages/net` | Table protocol: commit–reveal shuffle seed with a five-share ceremony, host-authoritative lock-step, hidden-information views, per-hand audit that every client verifies, timers/auto-play, rejoin tokens. Transports: WebSocket relay to the game server, in-memory loopback. |
| `apps/mobile` | Expo / React Native app (iOS, Android, web): home, club (create/join by code), lobby, landscape table with coach panel, result and audit screens, Learn (6 lessons + 2 drills), house-rule settings. |
| `apps/signal` | The game server: hosts every online table, relays the players' sockets, and runs the clubs API. Rate-limited and input-validated. |
| `docs/` | Architecture, rules/scoring reference, Fair Play Charter, product definition, monetisation plan, store compliance checklist, design system, roadmap. |

## Try it from a phone

* **Play in Safari:** enable GitHub Pages (Settings → Pages → Source: GitHub Actions), then open https://ameerthadani2.github.io/Mah-jong-Madness/
* **Host clubs for friends:** [Deploy the club server to Render](https://render.com/deploy?repo=https://github.com/ameerthadani2/Mah-jong-Madness) and set the `SIGNAL_URL` repo variable to its `wss://` address.
* Step-by-step: `docs/RUN_FROM_PHONE.md`. Native builds: `docs/RUN_ON_IOS.md`.

## Quick start

```bash
npm install            # Node ≥ 20
npm test               # engine + net tests
npm run typecheck      # every workspace
npm run sim -- 50      # 50 bot-vs-bot matches, prints win/draw stats
npm run signal         # signaling server on :8787
npm run mobile         # Expo dev server; press i / a / w
```

Playing against bots needs nothing else. Online tables always run on the game server: builds read its
address from the `SIGNAL_URL` repository variable, and development builds can override it under
Settings → Network — on a laptop on the same Wi-Fi, `ws://<laptop-ip>:8787`.

## Features at a glance

* **Play anywhere**: offline vs bots (3 skill levels), quick tables by code, or clubs with your own house rules, standings and server-hosted tables.
* **Poker-style clocks**: Relaxed / Normal / Fast / Turbo / Hyper speeds with a per-hand time bank; the bot steps in when you run out.
* **Never lose a game**: crash, reload or switch networks and resume the same hand with a rejoin token (guests) or a saved host snapshot (offline).
* **Learn like chess.com**: coach panel at the table, daily puzzle with streaks, Puzzle Rush, drills, 6 lessons, and a hand review that grades every decision.
* **Provably not rigged**: commit-reveal shuffles audited by every phone, with a Fair-play screen showing the seeds and hashes.
* **Make it yours**: avatars, table looks, emotes and quick chat; a shop that sells only cosmetics, coaching and club capacity.
* **Looks like a game, not a spreadsheet**: bright sky lobby, chunky cream panels and shelf buttons in the spirit of Codigames' idle games (see `docs/DESIGN.md`).

## How a hand is kept honest

1. Every seat (humans and bots) picks a random secret and publishes its SHA-256 commitment.
2. Secrets go to the host; the seed is `sha256(matchId:hand:secret0|…|secret3)`. Nobody can bias the deal.
3. The host deals and referees with the deterministic engine, sending each player only their own view.
4. When the hand ends the host publishes all secrets and the action log. Each phone checks the commitments,
   re-derives the seed, replays the log and compares the state hash. The result screen shows the verdict.

The host also contributes a committed share, the wall comes from a SHA-256 counter generator keyed by the whole
256-bit seed, and every audit records the construction version plus any ceremony restarts. The host device does
learn the seed at deal time, so a host running a modified app could peek; clubs tick **Neutral server hosts the
table** and the signaling server runs the identical `TableHost` code. See `docs/FAIRNESS.md`.

## Rules implemented

Standard Taiwanese 16-tile play with 底/台 scoring: self-draw pays from all three, discard pays from the discarder,
dealer 台 and 連莊拉莊, flowers with replacement, 16-tile dead wall with 流局連莊, chi from the left only,
hu > pong/kong > chi priority, nearest-winner tiebreak (一炮多響 optional), 過水 optional.
Scored 台 include 自摸, 門清, 門清自摸, 平胡, 碰碰胡, 混一色, 清一色, 字一色, 小/大三元, 小/大四喜, 三/四/五暗刻,
正花, 花槓, 八仙過海, 圈風/門風, 中發白, 獨聽, 全求人/半求人, 槓上開花, 搶槓, 海底撈月/河底撈魚, 天胡/地胡/人胡.
Full table in `docs/RULES.md`; every value is configurable in Settings.

## License

MIT
