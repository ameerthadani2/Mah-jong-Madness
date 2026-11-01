# Mahjong Madness 🀄

**Peer-to-peer Taiwanese 16-tile Mahjong (台灣麻將) for iOS and Android, with a coach that teaches you while you play.**

Think PokerBros for Mahjong: create a private table, share a six-letter code, and play with friends anywhere.
The game runs on the players' own phones. No company server deals the tiles, every player can audit every hand,
and bots fill empty seats so a table always runs.

## What is in this repository

| Path | What it is |
| --- | --- |
| `packages/engine` | Pure TypeScript rules engine: 144 tiles, 16-tile hands, chi/pong/kong (incl. 加槓 robbing), flowers, dead wall, dealer rotation, full 台 scoring with an itemised breakdown, deterministic replay, bots, and the coaching/learning layer. No dependencies. 42 tests. |
| `packages/net` | P2P table protocol: commit–reveal shuffle seed, host-authoritative lock-step, hidden-information views, per-hand audit, timers/auto-play, reconnection. Transports: WebRTC data channels, WebSocket relay, in-memory loopback. 8 tests. |
| `apps/mobile` | Expo / React Native app (iOS, Android, web): home, club (create/join by code), lobby, landscape table with coach panel, result and audit screens, Learn (6 lessons + 2 drills), house-rule settings. |
| `apps/signal` | Tiny WebSocket signaling + relay server. Can also act as a neutral table host for clubs that want nobody's phone dealing. |
| `docs/` | Architecture, rules/scoring reference, roadmap. |

## Quick start

```bash
npm install            # Node ≥ 20
npm test               # engine + net tests
npm run typecheck      # every workspace
npm run sim -- 50      # 50 bot-vs-bot matches, prints win/draw stats
npm run signal         # signaling server on :8787
npm run mobile         # Expo dev server; press i / a / w
```

Playing against bots needs nothing else. For online tables point the app at your signaling server
(Settings → Network) — on a laptop on the same Wi-Fi, `ws://<laptop-ip>:8787`.

### Direct peer-to-peer (WebRTC) on device

Expo Go has no WebRTC, so the app uses the relay transport there. For true device-to-device data channels build a dev client:

```bash
cd apps/mobile
npx expo install react-native-webrtc
# in index.js, before registerRootComponent:
#   import { RTCPeerConnection } from 'react-native-webrtc';
#   import { registerPeerConnectionFactory } from './src/game/session';
#   registerPeerConnectionFactory((cfg) => new RTCPeerConnection(cfg));
npx expo run:ios   # or run:android
```

## How a hand is kept honest

1. Every seat (humans and bots) picks a random secret and publishes its SHA-256 commitment.
2. Secrets go to the host; the seed is `sha256(matchId:hand:secret0|…|secret3)`. Nobody can bias the deal.
3. The host deals and referees with the deterministic engine, sending each player only their own view.
4. When the hand ends the host publishes all secrets and the action log. Each phone checks the commitments,
   re-derives the seed, replays the log and compares the state hash. The result screen shows the verdict.

The host device does learn the seed at deal time, so a host running a modified app could peek. Clubs that
care can tick **Neutral server hosts the table** — the signaling server runs the identical `TableHost` code.
Cryptographic (mental-poker style) shuffling is on the roadmap. See `docs/ARCHITECTURE.md`.

## Rules implemented

Standard Taiwanese 16-tile play with 底/台 scoring: self-draw pays from all three, discard pays from the discarder,
dealer 台 and 連莊拉莊, flowers with replacement, 16-tile dead wall with 流局連莊, chi from the left only,
hu > pong/kong > chi priority, nearest-winner tiebreak (一炮多響 optional), 過水 optional.
Scored 台 include 自摸, 門清, 門清自摸, 平胡, 碰碰胡, 混一色, 清一色, 字一色, 小/大三元, 小/大四喜, 三/四/五暗刻,
正花, 花槓, 八仙過海, 圈風/門風, 中發白, 獨聽, 全求人/半求人, 槓上開花, 搶槓, 海底撈月/河底撈魚, 天胡/地胡/人胡.
Full table in `docs/RULES.md`; every value is configurable in Settings.

## License

MIT
