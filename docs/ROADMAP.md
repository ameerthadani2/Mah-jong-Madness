# Roadmap

## v0.1 — this commit
- Engine, scoring, bots, hints, lessons, drills, P2P protocol, signaling/relay server, Expo app skeleton with full offline play.

## v0.2 — "play with friends every night"
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
