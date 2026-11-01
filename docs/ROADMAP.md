# Roadmap

## v0.1 — done
- Engine, scoring, bots (3 skills), hints, lessons, drills, daily puzzle, Puzzle Rush, hand review, P2P protocol with time banks and crash resume, signaling/relay server with clubs API and neutral hosting, Expo app with clubs, shop scaffold, fair-play screen.

## v0.2 — "play with friends every night"
- [ ] Sign in with Apple / Google replacing device-generated identities; account recovery.
- [ ] Real store integration (RevenueCat or expo-iap) behind the existing StoreProvider; purchased/free currency ledgers; Restore Purchases.
- [ ] Free-tier meters and Coach tiers as specified in docs/MONETISATION.md; VIP cards; club capacity enforcement.
- [ ] Codigames-style restyle pass 2: display fonts (Lilita One / Fredoka / Noto Sans TC), stroked text, pre-rendered low-poly avatars, confetti and banner animations.
- [ ] Push notifications when a table you are seated at starts (Expo Notifications).
- [ ] Clubs: persistent club codes, member list, standings across matches (store on the club's host node or a lightweight sync service).
- [ ] Spectator seats, emotes and voice chat (WebRTC audio track on the same peer connection).
- [ ] Reconnect UX: resume a table from a cold app start (persist session + room code).
- [ ] Host migration when the hosting phone disappears (elect next peer, resume from last audited snapshot).
- [ ] TURN server config for symmetric NATs.

## v0.3 — "the best coach"
- [ ] Post-hand review: replay every decision with the coach's alternative and 台 impact.
- [ ] Opponent modelling: discard-safety heuristics from discard history, suit avoidance reads.
- [ ] Adaptive bots (beginner / club / pro) and a ranked ladder vs bots.
- [ ] Lesson tracks for 台 memorisation with spaced repetition.
- [ ] Hand-shape recognition quizzes with Taiwanese terminology (邊張 / 嵌張 / 單騎 / 雙碰).

## v0.4 — "trust-minimised"
- [ ] Mental-mahjong shuffle: SRA commutative encryption of the wall so no device, host included, learns a tile before it is drawn.
- [ ] Signed audits so hands can be exported and disputes settled offline.
- [ ] Optional rule variants: 七對子, 一條龍, 三色同順, 過水 strictness levels, 一炮多響 payment splits.

## Platform
- [ ] EAS build profiles, App Store / Play Store metadata, screenshots.
- [ ] Localisation: zh-TW first-class alongside English; Pinyin/Bopomofo tile labels toggle.
- [ ] Accessibility: colour-blind safe suits, larger tile mode, screen-reader labels.
