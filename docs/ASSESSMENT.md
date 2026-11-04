# Mahjong Madness — objective assessment (date: 2026-11-04)

Repo `/home/user/Mah-jong-Madness`, branch `claude/p2p-taiwanese-mahjong-app-9lzdls`, 45 commits (all one AI-authored identity, 1-3 Nov 2026), about 14.7k lines of TypeScript. Scores are 0-10 against the best shipped product in each dimension (明星三缺一 / 神來也麻將 for rules and feel, PokerBros for clubs, chess.com for learning, Codigames/PokerBros for polish). 10 = equal to those, 7 = shippable with minor gaps, 5 = a prototype a studio would greenlight for production, 3 = a demo, 1 = absent.

## 1. Scorecard

| Dimension (weight) | Score /10 | One-line why | Top gap |
|---|---|---|---|
| Rules fidelity and engine (12%) | **5.8** | Deal, 補花, claim priority, 截胡/一炮多響, 搶槓, 過水, 連莊 payments and hand recognition all verified correct (30,000-hand brute-force check, 0 mismatches). Edge fidelity breaks: no instant 八仙過海 or 七搶一, 河底 discard can be ponged and play runs past the wall. | Instant 八仙過海/七搶一, absorption rules for stacked 台, 河底 fix, a real club rule editor |
| Fairness, anti-rigging (10%) | **3.0** (my decision; assessor 4, challenger 3) | SHA-256 commit-reveal and a correct DRBG, but a modified host rigs the deal four separate ways while the client shows "Verified", and `view.ts:24` leaks every opponent's drawn tile to every client in every mode. Nothing against collusion or multi-accounting. | Close the four client-side holes and the `lastDrawn` leak before any public build |
| Online multiplayer, clubs (14%) | **3.5** | Authoritative host, token rejoin (54 ms, audits verify) and clocks work on localhost. Nothing deployed, placeholder URL, phone-hosted tables die with the host app, clients never detect their own disconnect, all tables lost on restart. | Deploy on paid infra with persisted tables; make server-hosted the only online mode; client reconnect |
| Visual design, UX, feel (14%) | **5.0** | Coherent cartoon UI across 13 screens, 60 fps, 0.4 s to interactive. No audio at all, call-outs are small pills, own discards hidden in landscape, claim buttons cover the claimed tile, zero accessibility labels, raw developer errors shown to players. | Audio layer, win celebration and tile motion, landscape table layout fixes |
| Learning, single-player (8%) | **3.5** | The chess.com skeleton exists (lessons, daily puzzle, Rush, drills, coach, review) and the puzzle maths is correct (900 wait puzzles, 0 solver mismatches). Content is about 30 minutes, one quiz is an invalid 18-tile hand, and the coach (club logic) contradicts the review (pro logic). | 25-40 validated lessons, defence/claim/value puzzle themes, a rating |
| Monetisation, compliance, legal (10%) | **2.5** | Mock store exported unconditionally, client-side tamperable wallet, no restore, false "+15%/+25%" bonus badges, five SKUs that deliver nothing, no ToS/privacy/age gate/account deletion, "Stakes" presets and a cumulative points ledger that recreate off-platform settlement. | Real IAP with server ledger; honest catalogue; legal surface |
| Production, backend, platform (12%) | **2.3** | Typecheck, 90 tests and the Playwright e2e are green in CI. Nothing deployed, Render free tier on `/tmp`, TOFU identity, no crash reporting/analytics/push, never run on a device, no crypto RNG polyfill on native. | Paid hosting with a database, real accounts, device QA |
| Engineering quality (8%) | **5.0** | Pure deterministic engine that rejected all 14 adversarial action shapes; strict typing; CI covers typecheck/tests/sim/e2e. Untrusted rules merged verbatim (duplicate tiles, string scores), no rate limits, 7.8k-line mobile app with zero unit tests and no linter. | Validated RuleSet schema, rate limits, authenticated identity, mobile tests |
| Bot strength (6%) | **3.5** | Shanten-plus-acceptance play, 0 illegal moves in 450k decisions, 1 ms per decision. Paid "Pro (1900)" loses to free "Club" (20-22% win, -5 to -10 pts/hand); Beginner wins 1% and draws 88-90%; never folds; throws 東 as dealer in the East round. | One-line Pro fix, then a real defence and 台-value model |
| Market position (6%) | **2.3** | Real differentiation (verifiable 16-tile shuffle plus a coach) and sober compliance docs. $0 revenue, 0 users, English-only UI, name collides with an existing App Store title, public repo with no LICENSE, no acquisition channel, no team. | Validate demand, rebrand, zh-TW, a narrow first launch |

**Overall weighted score: 3.7 / 10.** Unweighted mean: 3.6 / 10.
**Commercial readiness today: 1.5 / 10** (cannot take money; not submittable; nothing running).
**Foundation quality: 5.5 / 10** (engine, net protocol, tests and docs are a real base; backend, identity, store, content and audio must be built).

Score method: assessor and challenger agreed within 1 point on every dimension, so the mean is used, except fairness, where I verified the challenger's refutation myself (`view.ts:24` spreads `...rest`, which carries `lastDrawn` set at `game.ts:258`; `client.ts:198-200` reveals with no commitment set and `client.ts:250` skips the cross-check) and set 3.0: a strength the assessor credited is false and the two extra attacks defeat the assessor's proposed fix.

## 2. The honest headline

This is a strong three-day prototype of a Taiwanese 16-tile mahjong app with an unusually clean engine and an auditable dealing protocol, a good-looking cartoon UI and the skeleton of a chess.com-style learning layer. It is not a product: no server runs, purchases are mocked, there are no accounts, no sound, no Chinese UI, and the "cannot be rigged" promise is false against a modified host and leaks hidden tiles to a modified client. Against 明星三缺一 it has none of the voice, audio, celebration or single-player content that Taiwanese players treat as table stakes; against PokerBros it has a working rejoin token but no economy, no durable clubs and spoofable standings; against chess.com it has about 30 minutes of content and no rating. The engine core (rules 5.8, engineering 5.0) is at greenlight level; everything that touches money, identity or a live server is at demo level (2.3-2.5). Potential is real and the gaps are mostly known, documented and costed by the owner's own ROADMAP, but today the app is roughly 6-9 engineer-months from a shippable Taiwan launch.

## 3. What is genuinely good (verified)

- **Rules core is correct.** Claim priority 胡 > 碰/槓 > 吃 with chi only from the next seat, 截胡 default with optional 一炮多響 (also in the 搶槓 window), 搶槓 limited to 加槓, 過水 resetting on draw/pong/chi, 底 + 台×值 payments with dealer 1+2N on any dealer payment, 流局 keeping the dealer, dead wall and 補花 from the back (`game.ts:324-326,537,560,584`; `scoring.ts:248-285`; probes `assess/rules/probe1.out`, `probe3.out`; `assess/rules-challenge/pB.out`). Hand recognition matched an independent brute-force checker on 12,063 complete hands out of 30,000 with 0 mismatches (`assess/rules-challenge/pC.out`). Base 台 values match the common Taiwanese table item for item.
- **Deterministic, pure engine.** The only `Math.random` in `packages/engine/src` is the crypto fallback at `sha256.ts:92`; `applyAction` clones and never mutates; a tile-conservation invariant holds every step (`game.test.ts:21-45`); `applyAction` rejected all 14 adversarial action shapes (`assess/engineering/adv.out`).
- **Cryptographic construction is right in principle.** Correct Fisher-Yates with rejection sampling, SHA-256 counter-mode DRBG keyed by 256 bits and versioned (`rng.ts:77-125`), chi-square on 72,000 shuffles within bounds (`assess/fairness/drbg-probe.out`), hand-rolled SHA-256 tested against NIST vectors (`net/test/fairness.test.ts:6-10`). Naive after-the-fact tampering is detected and listed in red on the result pill (`TableScreen.tsx:736`).
- **Netcode works end to end on a real socket.** Four relay clients on a server-hosted table, median action-to-state 7-22 ms, token rejoin to the same seat mid-hand in 10-54 ms with a bot stand-in meanwhile and all four audits OK (`assess/multiplayer/probeA.log`, `assess/multiplayer-challenge/probeA.log`). A host serialised mid-hand restores in a new process with the audit still verifying (`net/test/resilience`). Club roles are enforced server-side (owner cannot be demoted or removed, wrong secret 403: `assess/multiplayer/clubs.log`).
- **Quality gates are real and green on GitHub.** Typecheck, 63+23+4 tests, a 450-hand sim with invariants, and a Playwright e2e that plays a full hand all pass; CI run on commit `0c7679d` succeeded (`assess/production/*.log`, `gh run list`).
- **UI chrome and performance.** Consistent art direction across all screens and three viewports (`assess/ux/m_ph1.png`, `m_ls.png`, `m_tab.png`); 182 frames in 3 s with p95 16.8 ms during active bot play and 2,731 DOM nodes (`assess/ux-challenge/an.log`); no JS errors on any screen; no horizontal overflow at 390 or 844 px.
- **Learning plumbing is correct where it exists.** 900 wait puzzles matched an independent solver with 0 mismatches (`assess/learning/waitcheck.out`); discard puzzle difficulty scales by shanten; daily puzzle and streak work end to end; free-tier meters (1 Rush/day, 1 review/day) and the Pro lock on Home are enforced (`store.ts:129-138`, `HomeScreen.tsx:87`).
- **Bots are honest and fast.** They read only their own hand plus public information (`bot.ts:11-27`), 0 illegal actions over 8,000+ hands, about 1 ms per decision (`assess/bots-challenge/r_*.txt`).
- **Docs are candid.** FAIRNESS.md admits host peeking is not prevented, MONETISATION.md marks incumbent figures unverified, STORE_COMPLIANCE.md cites the right Apple rules and Taiwan Art. 266, and the Taiwan 26% commission from 31 Oct 2026 is correct.

## 4. What would stop it making money (ordered by severity)

1. **No way to take payment.** `store.ts:157` exports `MockStoreProvider` unconditionally; no IAP SDK; `restore()` is a no-op; wallet lives in editable local storage (999,999 diamonds via devtools: `assess/monetisation/shop-tampered-wallet.png`). A release build gives everything away and fails App Review 2.1/3.1.1. Effort: 1.5-2 weeks with RevenueCat, 3-5 weeks hand-rolled, plus the accounts below.
2. **No accounts, no server, no durable storage.** TOFU device secret (`clubs.ts:118-131`), placeholder `wss://signal.mahjongmadness.example/ws` (`app.json:48`), Render free tier with `DATA_DIR=/tmp` (`render.yaml`), tables lost on restart with ghost listings (`assess/production-challenge/restart.log`). Effort: 4-6 weeks (Sign in with Apple/Google, Postgres/Redis, paid instance, TLS, persisted `host.serialize()`).
3. **Fairness promise is defeatable and hidden tiles leak.** Attacks A-D in `assess/fairness/tamper-probe.out` and `assess/fairness-challenge/abort-probe*.out` all end with `auditStatus=ok`; `lastDrawn` leak gives a spy about 30% of each opponent's concealed hand (`leak-probe2.out`). Shipping the "cannot be rigged" claim as is invites a public takedown. Effort: 1-2 weeks for the client/host fixes and the view fix; months for anti-collusion.
4. **Catalogue dishonesty and undelivered SKUs.** False +15%/+25% badges (`catalog.ts:40-41`), zodiac avatars and Taiwan emotes that unlock nothing (`catalog.ts:49-50`), club tiers that sell nothing over an already unlimited free tier (`clubs.ts:158-199`, `catalog.ts:82` unused), Table Pass that grants one single-user sub (`store.ts:68-71`), hollow VIP perks, Shop copy advertising puzzle battles and a luck dashboard that do not exist (`ShopScreen.tsx:116`). Consumer-law and refund exposure. Effort: 1 hour to fix badges; 3-6 weeks to build or remove the rest.
5. **No legal surface.** No ToS, privacy policy, privacy manifest, age gate, account deletion or "no monetary value" disclaimer; "Small/Big Stakes" presets and a cumulative points ledger plus source comments that chips get their value off-platform (`rules.ts:87`, `clubs.ts:31`) recreate the settlement pattern behind Taiwan room-card prosecutions. Effort: 1-2 weeks engineering plus counsel ($3-10k).
6. **Brand cannot be submitted.** "Mahjong Madness" is a live App Store solitaire title (id6444284216); no domain is registered; the public repo has no LICENSE. Effort: owner decision, days.
7. **English-only in a Mandarin-first market.** No i18n layer (`grep` finds only a comment in `catalog.ts:6`; `assess/market/home-phone-zhTW-locale.png`). Effort: 3-5 weeks plus a native reviewer.
8. **No audio, no device run.** No audio dependency at all; the app has never run on a phone; no crypto RNG polyfill on native so secrets fall back to `Math.random` (`sha256.ts:91-92`). Effort: 2-3 weeks audio; 2-3 weeks device QA.
9. **Paid Pro bot is weaker than the free one.** `bot.ts:178` threshold; "fake difficulty" refund risk. Effort: one-line fix for parity; 1-2 weeks for a genuinely stronger tier.
10. **No analytics, crash reporting or push.** Blind soft launch; clubs cannot pull members back. Effort: 1.5 weeks plus 1.5-2 weeks for push.

## 5. Bugs and defects found (deduplicated; file:line and reproduction)

**Rules engine**
- `scoring.ts:170` 全求人/半求人 awarded with an 暗槓 among the five sets (ignores `m.concealed`). Repro: `assess/rules/probe2.out`, `assess/rules-challenge/pA.out` A1.
- `game.ts:328,330` pong/chi offered on the 河底 discard (only kong is guarded by `canDraw` at :329); after the pong, play continues past the wall and a second 河底撈魚 is paid (`game.ts:627`). Repro: `pB.out` B1.
- `scoring.ts:132` 八仙過海 is only +8 台 on a complete hand; no instant win; 七搶一 absent everywhere. Repro: `probe2.out`, `pB.out` B5b.
- `scoring.ts:128-130,206-207` 天/地/人胡 flat 16 and stack with 門清自摸, 獨聽, 正花, 花上自摸 (dealer 天胡 on a flower replacement = 23 台). Repro: `pA.out` A9.
- `scoring.ts:167-178` 半求人/全求人 double-count 獨聽. Repro: `pA.out` A3.
- `scoring.ts:277` maxTai cap applied after dealer and 連莊 台, so in the Beginner preset a streak can vanish. Repro: `pA.out` A11.
- `hand.ts:146` 獨聽 ignores the player's own melds (dead waits counted). Repro: `pA.out` A13.
- `game.ts:253` kong replacement that is a flower scores 花上自摸 instead of 槓上開花.
- `scoring.ts:177-190` 平胡 on a 嵌張 win with 2+ waits (variant choice; assessor called it a bug, challenger a variant).
- `rules.ts:94` Purist preset says "no flower 台 bonus" but that is already the default; it differs only by 過水 on.
- `rules.ts:69-71` + `rooms.ts:121-123` + `api.ts:42,54` untrusted rules merged verbatim: `basePoints:'x'` gives score deltas `[0,null,'0x20',0]`; `deadWallSize:-30` duplicated a physical tile; `deadWallSize:200` ends the hand at deal. Repro: `assess/engineering/adv.out`, `negwall.ts`, `assess/engineering-challenge/ctl.ts`, `wire.cjs`.

**Fairness and client/host protocol**
- `client.ts:198-200` reveals its secret without having received the commitment set; `client.ts:250` skips the cross-check when none arrived. Host grinds its share: victim dealt shanten 7-8, audit OK. Repro: `assess/fairness/tamper-probe.out` attack A.
- `client.ts:187-191` accepts `stand_in` in any phase and nulls the secret, so `client.ts:244` skips the own-share check. Repro: attack B.
- `host.ts:573-585` restart count uncapped; a host that corrupts a bot's reveal gets the stock host to blame the bot and restart; 387 silent restarts, audit OK, client never checks `ceremonyAttempts`. Repro: `assess/fairness-challenge/abort-probe7.out`.
- `client.ts:181-185` accepts `commit_request` mid-hand; `host.ts:584-586` resets `ceremonyAttempts` to 1 and clears reasons. Repro: `abort-probe.out`.
- `view.ts:24` does not strip `GameState.lastDrawn`; 722 of 1,542 state messages carried an opponent's concealed tile. Repro: `leak-probe.out`, `leak-probe2.out`.
- `sha256.ts:91-92` silent `Math.random` fallback; no `expo-crypto`/`react-native-get-random-values` in `apps/mobile/package.json`.
- `FairnessScreen.tsx:22`, `docs/FAIRNESS.md:7,26`, `fairness.ts:10` claim "four secrets" and "not even the host"; code uses five shares and the host can steer.
- `client.ts:202-203` a malformed `{t:'state'}` frame throws inside `onMessage` (a phone host can crash peers). Repro: `assess/engineering-challenge/ceremony.out`.
- `e2e/play-hand.cjs:91` `fairOk` only checks the text "seed" is visible, not that the audit is OK.

**Networking and server**
- `client.ts:54-60` `transportLink()` has no `onClose`; `signaling.ts:113-115` silently drops sends after a socket drop. A player's taps do nothing with no banner. Repro: `assess/multiplayer/probeA.log`, screenshot `p2p-6-guest-after-host-gone.png`.
- `rooms.ts:183-186` when a phone host leaves, `room.host` is reassigned to a guest running no `TableHost`; guests freeze; resume hangs (no join timeout in `signaling.ts:105-110`). Repro: `probeB.log`, `p2p-8-guest-after-resume.png`.
- `rooms.ts:178-182` hosted quick table closed when the last peer drops; a page refresh destroys the match. Repro: `probeC.log`, `hosted-8-guest-after-resume.png`.
- `rooms.ts:61,183-185` club keep-alive is 15 min from creation and only extended if not yet lapsed; any club match longer than 15 min dies when the last human drops. Repro: `assess/multiplayer-challenge/keepalive.log`.
- `server.ts:42-61` no persistence of hosted tables; after restart clubs list ghost "open" tables that answer "Room not found" and never clear. Repro: `assess/production-challenge/restart.log`.
- `server.ts:33-38` + `clubs.ts:283` synchronous full-store rewrite on every in-hand state event of a club table (50 per hand); 375 ms per save at 2k clubs. Repro: `assess/multiplayer-challenge/persist.log`.
- `rooms.ts:120-128`, `api.ts`: no rate limits or quotas; 2,000 clubs, 2,000 anonymous hosted tables in 39 ms, 10,000 chat frames relayed in 38 ms (`host.ts:460-464`). Repro: `assess/engineering/net.out`, `assess/production/probe.cjs`.
- `host.ts:408,497` + `server.ts:49-52` self-asserted `userId` bound to seat and credited to club standings; no membership check on club tables. Repro: `assess/multiplayer/probeD.log`, `assess/production-challenge/probe.log`.
- `server.ts:52` `handsWon: 0` hardcoded; the stat never moves.
- `host.ts:432-443` any seated guest can `add_bot`/`start` (deliberate for server tables per `LobbyScreen.tsx:32`; a gap for phone-hosted tables).
- `clubs.ts:168,170` rules and settings persisted unvalidated (60 KB junk accepted). `api.ts:47` `setRole` accepts any string; an owner can self-demote.
- `api.ts:43,49,50` unauthenticated GETs expose member lists and any user's clubs. `api.ts:70` CORS `*`.
- `rooms.ts:84,93,110`, `clubs.ts:104` peer ids, room codes and club codes from `Math.random`; join attempts unthrottled.
- `clubs.ts:62,169` `neutralHost` setting never read.
- `app-state.tsx:94-97` host mode saves only `{roomCode, token}`, never `host.serialize()`, so a host app kill loses the match by design.
- `storage.ts:100-103` saved Settings freeze `signalUrl` forever; `host.ts:221` `restore()` ignores `SerializedHost.version`.
- `session.ts:117-119` reaches into a private method via cast. `apps/mobile/src/api/clubs.ts:57` no fetch timeout (hangs on Render cold start).
- `render.yaml` free plan, `DATA_DIR=/tmp/mjm-data`; `app.json:48` placeholder URL.

**Monetisation**
- `store.ts:143-157` mock store, unconditional export, `restore()` no-op. `store.ts:37-54` wallet in local storage, editable.
- `catalog.ts:40-41` "+15%" pack is 0% bonus, "+25%" pack is +8% (`assess/monetisation/probe.out`). `catalog.ts:36` "60 diamonds: enough for an emote pack" (pack costs 200). `catalog.ts:45-50` diamond prices 54-67% above cash.
- `catalog.ts:49-50` `avatars.zodiac` and `emotes.taiwan` unlock ids nothing reads. `catalog.ts:60` Table Pass ($199.99) grants one single-user Diamond sub. VIP "50 emotes", "+1 club slot", "yearly exclusive look" all hollow (`themes.ts:56`, `clubs.ts:158-177`, `store.ts:112`).
- `store.ts:68-82` Gold yearly + Diamond monthly = 395 days of Diamond; Club 100 on top of Club 1,000 drops capacity to 100. `store.ts:119-135` meters keyed to device clock; rolling the clock back revives an expired sub.
- `catalog.ts:82` `FREE_CLUB_LIMITS` never imported; `clubs.ts:187,198` no capacity cap; free clubs already unlimited with `neutralHost` true (`clubs.ts:169`); paid club tiers sell nothing.
- `SettingsScreen.tsx:66-67` Pro bot selectable with an empty wallet (bypasses `HomeScreen.tsx:87`). Repro: `assess/monetisation-challenge/settings-pro-selected.png`.
- `LearnScreen.tsx` lessons ungated while `ShopScreen.tsx:116` sells "all lessons"; Shop lists puzzle battles, luck dashboard, insights, leaderboards that do not exist.
- `rules.ts:87`, `clubs.ts:31` source comments: chips valued off-platform. `docs/STORE_COMPLIANCE.md:32` draft review notes claim enforced anti-settlement terms that do not exist.
- No ToS, privacy policy, age gate, account deletion or "no monetary value" text anywhere in `apps/` or `packages/`.

**Learning and bots**
- `lessons.ts:95-98` Practice 2 hand is 18 tiles; `shanten()` throws. Repro: `assess/learning/lesson-eff-practice2.png`.
- `lessons.ts:107,110` defence lesson uses riichi logic (own discards safe; no furiten in TW); "4 visible copies = safe" wrong for suited tiles. `lessons.ts:109` and `bot.ts:66,75` "4 exposed sets = one tile needed" is false in 16-tile (needs 5). `lessons.ts:45` misuses 放槍.
- `bot.ts:136-140` ratings 800/1400/1900 are labels; `bot.ts:178` Pro loses to Club (20-22% win, -5 to -10 pts/hand over 4,500 hands; with threshold 1 Pro is at parity). Repro: `assess/bots/r_pro_vs_club*.txt`, `assess/bots-challenge/ab_vc1.txt`.
- `bot.ts:166,180-183` Beginner wins 0.4-1.3%, four Beginners draw 88-90%; with `drawKeepsDealer` a Beginner match runs 86-167 hands with dealer streaks up to 52 (`r_b4.txt`, `r_cbbb2.txt`). `host.ts:347` timeout stand-in inherits that skill.
- `bot.ts:46-57` danger weight at most 120 vs 1,000 per shanten: the bot never folds; danger model fires on about 4-5% of real 聽牌 cases. `bot.ts:58-62` honour nudge is not value-aware; dealer throws 東 first; the coach recommends discarding 東 (`assess/bots/coach.ts`).
- `hints.ts` (club) vs `review.ts:64,71` (pro) disagree: following the coach's claim advice is graded "inaccuracy" 29 times in 150 hands (`assess/learning-challenge/coachfollow.out`). `review.ts:116` any call equals any other call.
- `PuzzleScreens.tsx:121-126,155` "New personal best!" can never show. Daily wrong answer resets streak to 0; rollover at UTC. `LearnScreen.tsx:139-147` lesson completes on a wrong answer. `PuzzleView.tsx:40` "The hand is ready" on a 17-tile hand. `ReviewScreen.tsx:53` rolling accuracy stored, never shown.
- `TableScreen.tsx:31,46,333` coach available at online and club tables.

**UX**
- Landscape 844x390: own discard pond hidden under the hand rail (`assess/ux/ls_claim1.png`, `assess/ux-challenge/ls_mid12.png`); coach bubble truncated (`TableScreen.tsx:578,582`; `ls_selected.png`, worse at 667x375 `se_mid.png`); 碰/打 buttons cover the right opponent's pond including the claimed tile (`ls_claim.png`); result sheet clipped at 667x375 (`se_end.png`).
- Portrait: opponent melds overlap name plates (`ph_table_mid.png`); Lesson 1 clips 九萬 (`ph_lesson1_crop.png`); result buttons inconsistent at 360x740 (`an_end.png`); "progres s" wrap on Home resume card (`p2p-8-guest-after-resume.png`).
- Winner's hand never revealed during the 1.8 s hold (`lw_win_1.png`). `Animated` used in one component only; no tile motion.
- `OnlineScreen.tsx:79` shows "run `npm run signal` on a laptop"; `ClubsScreen.tsx:247` shows raw `e.message` ("Failed to fetch"); no empty states.
- Zero `accessibilityLabel`/`role`; 38x38 header buttons; `TableScreen.tsx:873` 9 px text. `SettingsScreen.tsx:44` locked theme silently redirects to Shop. `storage.ts:21,55` dead `sound` setting; default bot skill is Club not Beginner for first-run users.
- `TableScreen.tsx:34-39` forced whole-screen re-render every second (681 ms main-thread per 5 s idle on desktop). `LobbyScreen.tsx:56` share is plain text with no deep link.

**Engineering hygiene**
- Zero mobile unit tests; lint script is a no-op with no ESLint config; `webrtc.ts` and `signaling.ts` untested. `security.test.ts:30,53`, `coach.test.ts:37` pass vacuously. CI sim runs only 5 hands.
- `docs/ARCHITECTURE.md:47` "reclaimable by name" contradicts token-only `host.ts:475`; `docs/FAIRNESS.md:47` says neutral host is the default, but `storage.ts:55` defaults to phone-hosted.
- 9 moderate `npm audit` advisories; production server runs via `tsx`.
- `app.json:3` name collides with an existing App Store title; no LICENSE in a public repo.

## 6. Commercial view

**Market.** Taiwan mobile mahjong is large and concentrated. IGS's self-run app segment (明星三缺一 and siblings) was 29% of NT$22.03B 2025 revenue, about NT$6.4B (roughly US$200M) a year, down 10% YoY (ctee.com.tw, fugle.tw earnings call 2026-03-25); 明星三缺一 reported about 500k DAU in a 2019 Business Weekly piece. 神來也麻將 is modelled at about 17M installs, 1.4M MAU and $100k+/month, 75% from ads (appgoblin.info/apps/455902495). Mahjong Soul made about $150M lifetime by May 2023 with 7% from Taiwan, about $10M for a non-casino, cosmetic-funded mahjong game (Sensor Tower), which is evidence Taiwanese players pay for non-gambling mahjong. chess.com has about 8.7M DAU and 1.5-2M paying (board report Q4 2025), so the docs' 3% of MAU subscription assumption is defensible on that reference, though aggressive for an unproven niche; the assessor's "optimistic" critique used the wrong denominator and the challenger was right to refute it.

**Differentiation.** No 16-tile app found with a multi-party verifiable shuffle; Tenhou and Mahjong Soul publish seed or hash data in riichi, so the novelty is narrower than "first provably fair mahjong". 神來也 already ships a 胡牌提示 hint; a new Taiwan app sells 算台 practice and i.Game 16張 markets an AI sparring partner, so learning is contested at small scale. A dedicated 16-tile 牌效/向聽 trainer appears to be a gap. The compliance-first stance (no transferable currency, no loot boxes, no sold time banks) is a real advantage for store review against PokerBros clones.

**Regulatory exposure.** Taiwan criminalised online gambling for players from 14 Jan 2022 (Art. 266, up to NT$50,000). Mahjong where virtual coins rise and fall with results is rated 輔15 under 遊戲軟體分級管理辦法 (Control Yuan doc 76285); the docs already expect Apple 17+ simulated gambling. Owner-minted chips, "Stakes" presets, a cumulative points ledger and source comments about off-platform value are the fact pattern behind TW room-card prosecutions. Apple's Taiwan commission is 26% from 31 Oct 2026.

**Plausible revenue path.** Narrow first launch (offline bots and learning, real IAP, zh-TW, audio, rebrand) in about 3 months; club layer on durable infrastructure in another 3-4; total about $40-150k if contractors are paid. Realistic niche: diaspora friend groups and home-game clubs wanting a no-casino private room with house rules (Taiwanese-American population 230-630k by source), plus English-speaking learners. The docs' own model gives about $10k/month gross at 10k MAU.

**Probability-weighted outcome (estimate, not sourced).** P(in stores within 12 months) about 50%. Given launch with organic plus small paid UA: median 2-10k MAU, $1-5k/month gross. P(over $10k/month within 18 months) about 10%. P(over $100k/month, 神來也 scale) under 2%. The likeliest good outcome is a $5-30k/month lifestyle business if clubs become sticky; the likeliest outcome overall is a well-made app that never finds distribution.

## 7. The path to 8/10 (sequenced; effort in engineer-weeks; scores moved)

Owner = things only you can do (accounts, secrets, legal, art, money, decisions). Eng = engineering work.

1. **Rebrand, domain, licence, IP (Owner, 1 week elapsed).** Pick a name that clears the App Store, register the domain, add a LICENSE or make the repo private, record IP ownership. Moves: market 2.3→3.
2. **Close the fairness holes and the tile leak (Eng, 1.5 wk).** Client refuses to reveal without a full 5-share commitment set; rejects `stand_in` after committing and shows "partially verified"; rejects restarts that blame a bot or host share; refuses mid-hand `commit_request`; checks `ceremonyAttempts`; strip `lastDrawn` from `viewFor`; fail closed instead of `Math.random` and add `expo-crypto`; rewrite the Fair play copy; gate the coach off at online tables. Moves: fairness 3→5.5, engineering 5→5.5.
3. **Validate every untrusted input and add limits (Eng, 1.5 wk).** One clamped RuleSet schema shared by engine, host and server; rate limits per IP/user; caps on clubs and tables; chat throttle; role enum; join timeouts; fuzz test for tile conservation. Moves: engineering 5→6.5, production 2.3→3.
4. **Fix the engine edge cases (Eng, 2 wk).** Instant 八仙過海 and 七搶一; 河底 claimable only by win; 全求人 暗槓 check; absorption rules (碰碰胡 in 字一色, 獨聽 in 求人, 天/地/人胡 as configurable totals); maxTai before streak; 槓上開花 on flower replacement; flow tests for 搶槓/一炮多響/過水/海底/河底/天地人胡; a 100-hand golden table checked against 明星三缺一. Moves: rules 5.8→7.5.
5. **Bots and learning correctness (Eng, 2.5 wk).** Set `bot.ts:178` to 1, add a 台-value term and a per-tile deal-in model with push/fold, fix Beginner noise, add a CI tier-ordering test, calibrate displayed ratings; make coach and review use one evaluation; fix the 18-tile quiz and the four lesson errors; fix Rush best, lesson gating, streak reset. Moves: bots 3.5→6, learning 3.5→4.5.
6. **Real store and honest catalogue (Owner: Apple/Google developer accounts, bank, tax, RevenueCat account; Eng, 2 wk).** RevenueCat on iOS/Android, server receipt validation, Restore button, a dev-only mock behind a build flag; fix badges and copy; remove or build every undelivered SKU; enforce club capacity server-side or drop club tiers for now. Moves: monetisation 2.5→5.5.
7. **Accounts and durable backend (Owner: pick and pay for hosting, Apple Sign-in config; Eng, 5 wk).** Sign in with Apple/Google with guest upgrade, server session tokens on WS join, membership checks on club tables, Postgres for clubs and ledgers, Redis-persisted `host.serialize()` per action with restore on boot, grace periods refreshed during play, client `onClose` plus auto-rejoin with backoff, server-hosted as the only online mode, deploy on a paid instance with TLS and set `SIGNAL_URL`. Moves: multiplayer 3.5→6.5, production 2.3→5.5, monetisation +0.5.
8. **Legal surface (Owner: counsel $3-10k, policy text; Eng, 1 wk).** ToS with anti-settlement clauses, privacy policy, privacy manifest and labels, Data Safety, in-app account deletion, age gate with Declared Age Range, "no monetary value" text on clubs and standings, rename the "Stakes" presets, seasonal or resettable leaderboards, report flows. Moves: monetisation 5.5→6.5, market +0.5.
9. **Audio and game feel (Owner: commission or license SFX and Mandarin/Taiwanese voice calls, $5-20k; Eng, 3 wk).** Tile clacks, voiced 吃/碰/槓/胡/自摸, win fanfare, centre-table call-out banners, 胡牌 reveal and 台 roll-up, tile slide/flip, fix landscape pond/coach/claim-button layout, 44 pt targets and accessibility labels, friendly error and empty states. Moves: ux 5→7.
10. **zh-TW localisation and device QA (Owner: native reviewer; Eng, 4 wk).** i18n framework, translate UI and lessons, Chinese store listing and ASO; build and run on real iPhone and low-end Android, profile the SVG table, split `TableScreen` and remove the 1 s re-render. Moves: market +1, ux +0.5, production +1.
11. **Observability, push, remote config (Owner: Sentry/analytics accounts; Eng, 3 wk).** Crash reporting, product analytics with funnel events, server metrics, push for invites/turns/approvals, min-version gate, versioned migrations. Moves: production +1, multiplayer +0.5.
12. **Content and demand validation (Owner: 20-30 player interviews, 3-5 beta clubs, UA test budget $5-20k; content designer 4-6 wk).** 25-40 validated lessons in tracks, defence/claim/value puzzle themes, a puzzle rating, Rush leaderboards; closed TestFlight beta; rebuild the revenue model on observed conversion. Moves: learning 4.5→7, market →5-6.

Steps 1-6 and 9-10 give a submittable offline-first app in about 14 engineer-weeks. Steps 7, 8, 11 add the club product in about 9 more. Total to an 8-band product: roughly 30 engineer-weeks plus owner tasks and about 6 weeks of content design.

## 8. Method

Ten dimensions were each scored by an assessor who had to cite file:line, command output or a screenshot for every claim, then independently re-scored by a blind adversarial challenger who re-ran probes, re-read code and recorded each claim as confirmed, refuted, overstated or understated. The synthesiser used the mean where the pair agreed within one point and personally re-verified the refuted claims in fairness (`view.ts:24`, `client.ts:198-200,250`), the bot inversion (`bot.ts:178`), the mock store (`store.ts:157`), the diamond badges (`catalog.ts:40-41`), the club keep-alive (`rooms.ts:183-185`) and the 全求人 check (`scoring.ts:170`) before fixing scores. Commands run: `npm run typecheck`, `npm test`, `npm run sim`, `npm run e2e`, TypeScript probes via `npx tsx`, a local signal server driven by raw WebSocket and Playwright clients, and Playwright screenshots at 390x844, 844x390, 1024x768, 667x375 and 360x740.

Scratch artifacts (all under `/tmp/claude-0/-home-user-Mah-jong-Madness/39759e81-03bd-5dd6-a8d6-ea0f44708dd8/scratchpad/assess/`, 20 directories, 207 screenshots):
- `rules/` probe1-3 `.ts`/`.out`; `rules-challenge/` pA (scoring), pB (flow), pC (brute-force hand check) `.out`
- `fairness/` `tamper-probe.out`, `drbg-probe.out`, `shots/fairness.png`, `shots/result.png`; `fairness-challenge/` `leak-probe.out`, `leak-probe2.out`, `abort-probe.out`, `abort-probe7.out`
- `multiplayer/` `probeA-D.log`, `clubs.log`, `flood.log`, `p2p-*.png`, `hosted-*.png`; `multiplayer-challenge/` `probeA-C.log`, `keepalive.log`, `persist.log`, `restart.log`
- `ux/` montages `m_ph1-3.png`, `m_ls.png`, `m_tab.png`, `m_an.png`, plus `ls_claim1.png`, `ls_selected.png`, `ph_table_mid.png`, `ph_result.png`, `ph_review_full.png`, `ph_lesson1_crop.png`, `ph_online_create.png`, `ph_clubs.png`, `ph_avatars.png`, `j2_table.png`, logs; `ux-challenge/` `ls_claim.png`, `ls_mid12.png`, `lw_win_1.png`, `lw_win_3.png`, `se_mid.png`, `se_end.png`, `an_end.png`, `mont_a-d.png`, logs
- `learning/` `puzzles.out`, `lessons.out`, `ladder.out`, `ladder2.out`, `waitcheck.out`, `learn-home.png`, `lesson-eff-practice2.png`, `daily-after.png`, `drill-discard.png`; `learning-challenge/` `puz.out`, `coachfollow.out`, `ladder.out`
- `monetisation/` `probe.out`, `shop-*-phone.png`, `shop-tampered-wallet.png`; `monetisation-challenge/` `probe.out`, `settings-pro-selected.png`, `home-before.png`
- `production/` `typecheck.log`, `test.log`, `e2e.log`, `probe.cjs`, `server1-2.log`, `result.png`, `review.png`, `fairness.png`; `production-challenge/` same logs plus `probe.log`, `restart.log`
- `engineering/` `adv.out`, `net.out`, `perf.out`, `negwall.ts`, `table-390.png`; `engineering-challenge/` `ceremony.out`, `ctl.ts`, `wire.cjs`, `server.log`
- `bots/` `league.ts`, `r_*.txt`, `defense_pro.txt`, `defense_club.txt`, `trace7.txt`, `coach.ts`; `bots-challenge/` `r_*.txt`, `ab_*.txt`, `defense.txt`, `botx.ts`
- `market/` `home-phone-zhTW-locale.png`, `clubs-phone.png`, `shop-phone.png`
