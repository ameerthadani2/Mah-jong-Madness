# Mahjong Mania — objective assessment, fourth pass (date: 2026-11-16)

This re-scores the product on the same ten dimensions, weights and rubric as the assessments of 2026-11-04 (3.7/10), 2026-11-06 (5.4/10) and 2026-11-13 (6.2/10). Code assessed: commit `c9137a8`, 439 commits, about 84,800 lines of TypeScript, 2,214 passing tests (engine 314, net 224, server 812 on Postgres, app 829 logic and 35 render). The earlier documents are in git history (`docs/ASSESSMENT.md` at `4cc4f30`, `a0c4e7a` and `a698bc5`).

**Method.** As in the third pass: four independent assessors, one per group of dimensions, who started from the evidence on disk (the full gate log, every fix unit's before-and-after records, the earlier probes) and ran 59 checks of their own (independent scorers, self-play, new attacks on the audit, real servers over real sockets, the production bundle on Postgres, source mutations, Playwright on the exported app). No blind challengers, so these are assessor scores; compared like for like with the first two passes they are probably about 0.2 high. I checked the new engineering findings in the code myself (listed under "What this pass found"). Sections 4 onwards below are the third pass, kept for its detail; the scorecard here supersedes its scores.

## Scorecard (fourth pass)

| Dimension (weight) | 4 Nov | 6 Nov | 13 Nov | **16 Nov** | Why, in one line | Top gap |
|---|---|---|---|---|---|---|
| Rules fidelity and engine (12%) | 5.8 | 6.9 | 7.5 | **7.7** | An independent scorer agreed on 40,000 fresh hands, 1,500 self-play hands passed every claim-window check, and the optional 嚦咕嚦咕 matched an independent checker on 30,000 hands. Nothing is checked against 明星三缺一; 七對子, 十三么 and the kong-timing choice are not options. | Recorded hands from a shipped Taiwanese product (owner) |
| Fairness, anti-rigging (10%) | 3.0 | 4.7 | 6.2 | **6.6** | The third pass's top gap is closed: 0 of 60 hands with a turn played behind a drop stayed green (was 60 of 60). The phone checks when the table played for a timed-out seat, not what it played: a server can force a Pong or a discard into an opponent's win and stay green. | Check the table's move as well as its timing |
| Online multiplayer, clubs (14%) | 3.5 | 5.3 | 6.3 | **6.7** | A dropped player keeps the turn on real sockets; a second process is refused in 2.7 s; a restart restores the table in 37 ms; the join flood and leaderboards are in. Nothing is deployed, and a script tops the daily board in 0 s. | Deploy and play on phones (owner); boards that resist scripts |
| Visual design, UX, feel (14%) | 5.0 | 6.0 | 6.6 | **6.9** | Both Home defects are fixed and confirmed live; header icons are 44 points; the page language follows the UI. 11 of 16 sound cues are placeholders, the Taiwanese voice has no files, nothing has run on a phone. | Commissioned audio and a device run (owner) |
| Learning, single-player (8%) | 3.5 | 5.3 | 5.9 | **6.1** | 0 of 600 value and 0 of 900 defence puzzles disagree with exact recounts; server ratings and boards exist. A scripted client using the shipped engine tops every board, and the server lets a free account start unlimited Rush runs. | Boards that resist automation; the free Rush meter on the server |
| Monetisation, compliance, legal (10%) | 2.5 | 5.2 | 6.3 | **6.4** | Every earlier store probe holds; production keeps the store off with one secret; expiries beyond 400 days are refused. No purchase has gone through a real store, and the legal texts are drafts. | Store setup and a sandbox purchase; counsel (owner) |
| Production, backend, platform (12%) | 2.3 | 5.0 | 6.0 | **6.1** | The production bundle refuses a weak pepper, a pooled lock address and a half-configured store; the automatic deploy now really fires. GitHub CI was red on the last four pushes (fixed since, see below), and nothing is deployed. | First deploy and builds (owner); keep CI green |
| Engineering quality (8%) | 5.0 | 6.3 | 6.9 | **7.0** | 4 of 4 source mutations were caught; coverage is measured with floors; 9 render-test files. App coverage leaves out the .tsx screens, 32 of 87 app test files still read source text, and a timing test kept CI red unnoticed. | CI that stays green; coverage of the screens |
| Bot strength (6%) | 3.5 | 4.5 | 4.7 | **4.8** | Disciplined, pre-registered measurement; 0 illegal moves in about 633,000 decisions. Pro's edge over Club is small (+3.3 a hand over 35,000 hands; the assessor's own 5,000 gave +1.2, se 2.7). | A clearly stronger Pro |
| Market position (6%) | 2.3 | 3.4 | 4.2 | **4.3** | The name is consistent, both listings fit every field, the first discard takes 5 taps in Chinese, leaderboards give a reason to return. Nothing has shipped: 47 of 47 owner checklist items are open. | Trademark, licence, deployment, builds (owner) |

**Overall weighted score: 6.5 / 10** (6.45; was 6.2, 5.4 and 3.7). Unweighted mean: 6.3. Like for like with the first two passes, about 6.3.

## What this pass found (fourth pass)

New engineering defects, each confirmed in the code:
1. **GitHub CI was red on the last four pushes.** The coverage step added on 16 November runs the tests several times slower, and three tests asserted wall-clock times written for a plain local run (value puzzles under 10 ms on average measured 15.9 ms on the runner). The local gate runs passed, and nobody looked at GitHub. **Fixed in `87b621a`**: time bounds in tests are multiplied under coverage and on CI. From now on every push is checked on GitHub, not only locally.
2. **The audit checks when the table played for a timed-out seat, not what it played** (`packages/net/src/client.ts`: only "passed up its win" is checked). The server's own rule is deterministic: a win is taken, any other claim is passed, and a turn is played by the bot policy from a fixed seed. The phone can recompute it, and today it does not.
3. **A scripted client tops every puzzle leaderboard.** Puzzles are generated from the date or the Rush seed by the engine the app ships, so a script can compute every answer: the daily puzzle in 0 s, Rush 40 of 40, a rating gain of 646 in one run. The only check is one answer a second.
4. **The free once-a-day Puzzle Rush allowance is enforced only by the app.** The server starts unlimited rated runs for a free account, although unlimited Rush is part of what Coach Gold sells.

Smaller ones: a club owner can close a table mid-match and the match leaves no record; the pooled-address check is a hostname heuristic that misses some poolers; the join-flood rule is keyed on account age, so pre-aged accounts bypass it; an emptied rules object in a saved table passes validation and shows NaN; screen readers hear the wall count and compass as bare text; every Rush answer is rated, so one run moves a rating by hundreds; app coverage leaves out the .tsx screens.

Owner-blocked, as before: deployment, native builds, store products and a sandbox purchase, counsel, trademark and licence, commissioned audio, recorded hands from a shipped Taiwanese app, a native zh-TW review, devices and players.

---

# Third pass (2026-11-13), kept for its detail

## 1. Scorecard

| Dimension (weight) | 4 Nov | 6 Nov | **13 Nov** | Why, in one line | Top gap |
|---|---|---|---|---|---|
| Rules fidelity and engine (12%) | 5.8 | 6.9 | **7.5** | Every open engine item is closed: an independent scorer agreed on 40,000 fresh hands with 0 mismatches, a kong is never offered after a chi or pong (37 of 37 refused), a dealer's concealed kong voids 地胡 and 人胡, club house rules are enforced. Nothing is checked against 明星三缺一, and 嚦咕嚦咕 and 七對子 are absent rather than optional. | A golden table of recorded hands from a shipped Taiwanese product (the owner supplies the recordings) |
| Fairness, anti-rigging (10%) | 3.0 | 4.7 | **6.2** | Every attack from the second and third reviews now ends red or amber (120 of 120 re-dealt hands failed, 58 of 58 rewritten wins failed; fake match end, skipped hands, forged clock and refused moves all failed) and honest runs stay green. A modified server can still play a player's turns behind a sub-second socket drop with a green "Verified" (40 of 40 hands), and can play out the rest of a match during a 2-second drop. | A move the table makes for a seat across a link drop must not stay green; a dropped player needs a grace period |
| Online multiplayer, clubs (14%) | 3.5 | 5.3 | **6.3** | On real sockets: a second process on the same database is refused in 2.8 s, a restart mid-hand restores the table at the same turn, one account opened 1 table in 10 tries, owner tools, quick match and seat recovery work. Nothing is deployed or has run on a phone, and a dropped player's turn is played by a bot 12 ms after the socket closes. | Deploy it and play it on phones; before that, a grace period for a dropped player |
| Visual design, UX, feel (14%) | 5.0 | 6.0 | **6.6** | The layout, exit and accessibility defects are fixed and measured: the exit icon asks first, the player's pond was never hidden in 78 samples at four sizes, all 48 tiles have spoken names in the reader's language. All 11 sound files are synthesised placeholders, nothing has run on a phone, and Home has two new defects. | Commissioned audio and a device run (owner); then the two Home defects |
| Learning, single-player (8%) | 3.5 | 5.3 | **5.9** | The two wrongly judged puzzle themes are fixed (value: the rival answer is better in 0 of 300, was 88 of 100; defence: 0 of 300 disagree with an exact count), all 63 quizzes validate, the coach's play is graded best in 339 of 339 moves. One-line rules still answer 91% of value and 96% of defence puzzles, and there are no server ratings or leaderboards. | Server-side ratings and leaderboards; puzzles a one-line rule cannot answer |
| Monetisation, compliance, legal (10%) | 2.5 | 5.2 | **6.3** | The four ways to take money and grant nothing are closed in code and probes: refunds, replays, out-of-order events, an upgrade followed by a refund and a late expiry all end in the right state, and a deleted account keeps only what the privacy text says. No purchase has gone through a real store, and the legal texts are drafts with placeholders. | Owner: store setup and one sandbox purchase, restore and refund per platform; counsel sign-off |
| Production, backend, platform (12%) | 2.3 | 5.0 | **6.0** | On the production bundle over Postgres: the boot refuses to start without its database or pepper, a hung database gives `/health` 503 in 2.0 s and a SIGTERM exit in 5.0 s (was no answer in 15 s and 40 s), a live table survives SIGTERM and SIGKILL. Nothing is deployed, no native binary exists, and the release workflows have never run a real job. | Owner: first deploy, first builds, device QA. Engineering: make the automatic deploy able to fire |
| Engineering quality (8%) | 5.0 | 6.3 | **6.9** | Both data-loss defects and the throttle reset are gone when re-run, 5 of 6 source mutations were caught by the named test file, CI is green with 1,988 tests. There are no UI render tests for about 22,000 lines of app source, 35 of 81 app test files read source text, and nothing measures coverage. | Component render tests and a coverage figure in CI |
| Bot strength (6%) | 3.5 | 4.5 | **4.7** | The gate is now a real regression gate (a Pro with defence off fails it), measurement is disciplined, and there were 0 illegal moves in 148,000 decisions at about 0.65 ms each. Strength did not improve: Pro is +1.9 points a hand over Club on 19,000 hands (standard error 1.4) and deals in as often. | A Pro that is clearly ahead of Club: a better model, not other weights |
| Market position (6%) | 2.3 | 3.4 | **4.2** | The product can be named and found: Mahjong Mania / 麻將狂熱 in the wordmark, share text and both listings (every store field within its limit), quick match with strangers, a first discard in 5 taps in Traditional Chinese. Shipped reality has not moved: no deployment, no build, no users, no licence, no trademark check. | Owner: trademark and licence, deployment, first builds, beta clubs |

**Overall weighted score: 6.2 / 10** (6.23 from the unrounded scores; was 5.4, and 3.7 before that). Unweighted mean: 6.1. With the discount a blind challenger applied in the earlier passes, the like-for-like figure is about **6.0**.

**Commercial readiness: 3.0 / 10** (was 2.5; my estimate, not an assessor's). The name is settled in the product, the deployment path was reviewed and repaired, and the money paths hold in probes. Nothing has run: no store account, no deployment, no native build, no device, draft legal texts.

**Foundation quality: 7.0 / 10** (was 6.5; my estimate). Engine, protocol, server and test suite are near production grade; the remaining engineering gaps are specific and listed in section 8.

## 2. The honest headline

Between the second pass and this one the programme ran a ninth phase (server hardening, fairness on the reconnect path, a store and cosmetics pass with the rebrand, new bots and puzzles, club owner tools, a UX and accessibility pass, quick match and moderation, deployment tooling) and a third adversarial review in three rounds. That review produced 128 findings; all were fixed with regression tests and none was refuted. Every dimension went up. The largest moves are fairness (+1.5), monetisation (+1.1), production (+1.0) and multiplayer (+1.0).

It is still not a product anyone can use. Nothing is deployed, no iOS or Android binary has been built, no purchase has gone through a store, every sound is a synthesised placeholder, and the legal texts are drafts. Almost all of that waits for the owner's accounts and decisions (`docs/OWNER_TODO.md`), not for engineering.

This pass also found new defects. The most important one is a single cause with two effects: **a player whose connection drops gets no grace**. The table plays the seat's move as soon as the socket closes (12 ms in the assessor's run; `packages/net/src/host.ts:1047`). On a mobile network a one-second blip costs the turn. And because the phone's audit accepts a table move made across a link change (`packages/net/src/client.ts:1776`), a modified server can drop a socket for under a second, play the worst discard, and the hand still shows a green "Verified". The other new defects are smaller: two ways to lose a match or lock the app from Home, and an automatic deploy that cannot fire because the repository has no `main` branch.

The paid tier's headline feature is still weak: the Pro bot is not measurably stronger than the free Club bot.

## 3. What is genuinely good (verified on `05db9c7`)

- **Rules engine.** An independent scorer agreed with the engine on 40,000 random hands from a new seed (0 mismatches); 1,500 self-play hands passed every claim-window check; in 400 hands a kong was held on 37 turns that began with a chi or pong, and was offered 0 times and refused 37 of 37; a dealer's 暗槓 turns a 16-台 地胡 into a 4-台 win (`packages/engine/src/game.ts:448-450, 582-585`). Club house rules reach the hosted table (`apps/signal/src/clubs.ts:1340-1346`).
- **Fairness against the known attacks.** Drop-and-re-deal: 120 of 120 re-dealt hands failed the audit. Rewritten wins: 58 of 58 failed. A fake match end, skipped hands, a forged clock and refused legal moves all end red. Honest play stays green, including a restart on Postgres. All 78 re-run probes show the fixed behaviour.
- **Durable online tables.** A second server process on the same Postgres database is refused in 2.8 s. An orderly restart mid-hand restores the table at the same turn with both players back and green audits. One account opened 1 table in 10 tries over fresh sockets (it was 500 in 10.7 s). Owner close, ban and role checks, quick match, seat recovery by account and the "already seated" refusal work on real sockets.
- **A server that fails safely.** The production bundle refuses to boot without `DATABASE_URL` or `AUTH_PEPPER`. A hung database gives `/health` 503 in 2.0 s and a SIGTERM exit in 5.0 s. A live table survives SIGTERM (exit in 1,044 ms) and SIGKILL. The smoke test plays a hand against the built bundle on memory and on Postgres and now fails on a server that stores nothing.
- **Money paths.** The server decides every grant. Refunds, replays, out-of-order events, an upgrade followed by a refund of the old plan, and a late expiry all ended in the right state in the assessor's own run. A deleted account keeps only the purchase rows the privacy text says are kept.
- **Engineering.** 1,988 tests; typecheck and lint clean (lint now covers the build scripts too); `npm audit` shows 0 critical and 0 high advisories; 5 of 6 deliberate source mutations were caught by the named test file.
- **The app.** The exit icon opens a three-choice question and the table survives a reload; the player's own pond was never covered in 78 own-turn samples at four viewports; all 48 tiles carry spoken names in the reader's language; Home fits every reference size in English and Traditional Chinese.
- **Learning.** 36 lessons with 63 quizzes that all validate; value and defence puzzles agree with an exact count on 300 fresh puzzles each; the coach's own play is graded best in 339 of 339 moves.
- **Honest measurement of the bots.** The gate fails a Pro with its defence off, and the documents state the measured gap (1.9 points a hand, standard error 1.4) instead of a claim.

## 4. What would stop it making money (ordered by severity)

1. **Nothing is shipped (owner).** No deployment, no build, no store products, no sandbox purchase, draft legal texts, no trademark check, no licence. Every box in `docs/OWNER_TODO.md` is unticked.
2. **A dropped player loses the turn at once, and a server can use that unseen.** This breaks the two things the product sells against incumbents: fair play and playable club tables on phones (`packages/net/src/host.ts:1047`, `packages/net/src/client.ts:1776`).
3. **The paid tier's bots are not stronger.** Coach Gold advertises Pro bots; Pro is level with Club within noise, and its deal-in and 台 terms add nothing (`packages/engine/src/bot.ts:257`).
4. **No real sound.** All 11 shipped files are placeholders and the Taiwanese voice has no files (`apps/mobile/assets/audio/manifest.json:20`), beside fully voiced incumbents.
5. **Two ways to lose a match or the app from Home.** The resume card's "Discard" abandons a saved table in one tap (`apps/mobile/src/screens/HomeScreen.tsx:361`); a malformed saved-table record locks the player on the error screen for good (`apps/mobile/src/storage.ts:123-133`).
6. **Thin retention features.** No server ratings or leaderboards; three puzzle themes exist only inside the once-a-day Rush.
7. **The release path has never run.** The automatic deploy listens for CI on `main`, which does not exist (`.github/workflows/deploy-signal.yml:32`); the iOS and Android workflows have never started a real job.

## 5. Defects found in this pass (59: 2 blockers, 19 major, 38 minor)

**Fairness**
- Major: the table can play any or all of a seat's turns behind a sub-second socket drop and the hand stays green with no caveat (`packages/net/src/client.ts:1776`: a table move is never judged early when the frames around it are on different links). Measured: 40 of 40 hands green; the victim won 0 of 60 hands against 12 of 60 honestly.
- Major: after one drop the server can state a time bank of 0 and take a later turn 200 ms after it began, link up, and stay green in 58 of 58 hands (`client.ts:1786`, the 30 s allowance before the first fixed point). A second theft on the same connection is caught.
- Major: the rest of a match can be played during a 2-second drop; the phone marks the missed hands amber and shows the end as verified (`client.ts:1495`). Nothing compares the number of missed hands with the time away.
- Minor: the server sees every wall and runs the bots (by design, `docs/FAIRNESS.md:58`); quick match seats two accounts from one address at one table with no collusion signal (`apps/signal/src/matchmaking.ts:9`); audits are unsigned and seats' views are not compared.

**Online multiplayer, clubs**
- Major: a dropped player gets no grace (`packages/net/src/host.ts:1047`: any seat that is not connected is played like a bot).
- Major: nothing is deployed and no build has run on a phone (owner).
- Minor: no ratings, leaderboards or skill matching; the host lock only warns on a pooled connection string (`apps/signal/src/main.ts:76`); standings count a match between two accounts and two bots (`apps/signal/src/clubs.ts:1549`); a join flood can still lock real players out of an open club until the owner clears it.

**Rules**
- Major: no rule set has been checked against a shipped Taiwanese product (`docs/OWNER_TODO.md:131`).
- Minor: the speed label is kept when the clock under it changes, so a table can read "Fast (99s + 30s bank)" (`packages/engine/src/rules.ts:87`); 嚦咕嚦咕, 七對子, 十三么 and the kong-timing choice are fixed in code, not table options.

**Bots**
- Major: the paid tier is not measurably stronger than the free one (assessor's 1,000 fresh hands: +7.6 points a hand, 95% interval -4.1 to +19.3); the deal-in and 台 terms add nothing, and the 台 terms alone cost 3.4 points a hand (95% interval -6.6 to -0.2); Pro deals in as often as Club (18.0% against 17.6%).
- Minor: flushes stay rare (2 in 255 wins); the gate protects a snapshot, not a strength claim.

**Learning**
- Major: no server-side ratings or leaderboards; the puzzle rating lives on the device (`apps/mobile/src/logic/rating.ts:39`).
- Minor: "keep the most winning tiles" answers 91% of value puzzles and a fixed safety order 96% of defence puzzles; defence, claim and value themes appear only in the metered Rush; 16 of 37 discard quizzes are answered by a lone honour; lesson minutes are declared at 211 for about 56 minutes of reading.

**Production**
- Major: the automatic deploy can never fire, because it listens for CI on `main` and the repository's only branch is the working branch (`.github/workflows/deploy-signal.yml:32`; `web-preview.yml:7` has the same filter). A first deploy by manual dispatch works as documented.
- Major: the release workflows have never run; their first execution will be the owner's first release.
- Minor: the Expo action and EAS CLI are unpinned in the two workflows that hold store keys; `AUTH_PEPPER` strength is not checked (`apps/signal/src/config.ts:150`); a refused database at boot gives no message for 20 s (`apps/signal/src/db.ts:203`).

**Engineering**
- Major: no component render tests; 35 of 81 app test files assert on source text.
- Minor: no coverage measurement; the debt guard in `spend()` has no test of its own (`apps/signal/src/wallet.ts:297`); several very large modules (`packages/net/src/client.ts`); `noUncheckedIndexedAccess` is off; 12 moderate advisories in the app's non-dev tree.

**Monetisation**
- Blocker (owner): no purchase has run through a real store and the store SDK has never run on a device.
- Major (owner): Terms and Privacy Policy are drafts with five `[Company name]` placeholders (`apps/mobile/src/legal/documents.ts:25`).
- Minor: a refunded diamond pack keeps the looks it bought (the player owes diamonds); the store can be switched on with the webhook secret alone; a webhook expiry date has no upper bound (`apps/signal/src/revenuecat.ts:50`).

**UX**
- Major: Home's resume card abandons the saved table in one tap, and its label "Discard" is the game's own verb (`HomeScreen.tsx:361`).
- Major: a malformed saved-table record crashes Home, and the error card's only button leads back to Home (`storage.ts:123-133`, `HomeScreen.tsx:352`).
- Major: every sound is a placeholder and the Taiwanese voice has no files.
- Minor: Extra-large tiles do not enlarge the landscape hand at 844x390 either; bot seat names are cut in Traditional Chinese at the table; hand tiles and three HUD icons are under 44 pt; English Shop descriptions are cut mid-sentence; the web export declares `lang="en"` while showing Chinese; no countdown to the next hand online.

**Market**
- Blocker (owner): nothing is deployed and no build is public: 0 installs, 0 users, no demand evidence.
- Major (owner): no licence on a public repository and no trademark check; no recorded voice beside voiced incumbents.
- Minor: every zh-TW namespace is still marked for native review, and the coach uses the riichi term 向聽; the wordmark stays English on a Traditional Chinese device; a stale screenshot and the repository name carry the old name; the zh-TW review notes say 快速配桌 where the app says 快速配對; a Simplified-Chinese device gets English (the owner's rule).

## 6. Status of the second assessment's defects

The assessors gave a status to 111 defects from the second pass.

| Dimension | Fixed | Partial | Open | Not checked |
|---|---|---|---|---|
| Rules | 4 | 2 | 1 | 0 |
| Fairness | 5 | 3 | 0 | 2 |
| Multiplayer | 8 | 1 | 1 | 1 |
| UX | 13 | 2 | 2 | 1 |
| Learning | 3 | 2 | 4 | 3 |
| Monetisation | 10 | 4 | 0 | 2 |
| Production | 6 | 2 | 0 | 3 |
| Engineering | 5 | 0 | 2 | 1 |
| Bots | 2 | 2 | 1 | 1 |
| Market | 4 | 2 | 5 | 1 |
| **Total** | **60** | **20** | **16** | **15** |

Still open: nothing checked against 明星三缺一; nothing deployed or run on a phone; placeholder audio; the 台 term that does not raise Pro's hand value; free hand reviews capped at one a day (now disclosed); the lone-honour quizzes, the Rush-only themes and the inflated lesson minutes; no coverage measurement and no render tests; no licence, no public build, no users, zh-TW text awaiting native review, and English on Simplified-Chinese devices (the owner's rule).

## 7. Commercial view

The market sizing of the first assessment stands; no new market research was done. What changed commercially is on the product side: the name can be submitted once the trademark check clears, play with strangers exists, the club-owner plan (The Four Winds Club) is built and gated on the server, and the money paths survive adversarial probes. What has not changed is everything that needs the owner: the accounts, the deployment, the builds, the store products, counsel, the trademark check, the licence, real audio and real players. Until a build exists that a Taiwanese player can install, there is no demand evidence of any kind.

## 8. The path to 8/10 (revised)

Engineering work, each item sized to fit one working session unless stated:

1. **A dropped player keeps their clock.** A disconnected seat is not a bot: the table moves for it only when its time runs out (then a pass on any claim that is not a win). The phone marks any table move made across a link change amber, or red when its own clock says the seat still had time, and bounds the hands it accepts as missed by the time it was away. Moves fairness and multiplayer (24% of the weight).
2. **The small confirmed defects.** A question before Home's "Discard" (and a clearer label); validation of the saved-table record with a way out of the error screen; deploy and preview triggers that follow the default branch; the speed label; the minor items in section 5 that take minutes.
3. **A better Pro model** (two to three sessions): a danger read that eliminates waits from every discard and call, look-ahead at one step from ready, measured against the gate on held-out hands.
4. **Server-side puzzle ratings and leaderboards** (two sessions), and free access to one puzzle theme a day.
5. **Component render tests and a coverage figure in CI** (one to two sessions).
6. **Optional rule variants** (嚦咕嚦咕, 七對子) as table options with scoring and tests.

Owner work, in the order of `docs/OWNER_TODO.md`: trademark check and licence; Fly and Neon accounts and the first deploy; Apple, Google and Expo accounts and the first builds; device QA on two phones; store products and one sandbox purchase, restore and refund per platform; counsel's review of the legal texts; recorded hands from 明星三缺一 for the golden scoring table; commissioned sound and voice; a native zh-TW review; beta clubs.

My estimate, not an assessor's: items 1 and 2 would put the overall score near 6.5. Reaching 7.5 to 8 needs the owner's items, because five dimensions are capped by the fact that nothing has run outside this repository.

## 9. Method

- **Assessors.** Four independent agents, one per group of dimensions: engine side (rules, bots, learning), table and server (fairness, multiplayer), backend and business (production, engineering, monetisation), app and market (UX, market). Each had the same rubric text as the earlier passes, the second pass's score and defects for its dimensions, the team's claims marked as claims to test, and read-only access to the repository. They made 196 tool calls and used about 745,000 tokens in 29 minutes.
- **Evidence they started from.** The full gate run on the assessed code (typecheck, lint, locale check, every suite, the server suite on Postgres, the simulator and the bot gate, the smoke test on the production bundle on memory and on Postgres, both end-to-end runs); 78 attack and regression probes re-run on the assessed code; the 128 findings of the third review with their final states; the fixers' reports; the bot measurement record.
- **Checks of their own.** Among them: the independent scorer on 40,000 hands from a new seed; a 1,000-hand ladder for Pro; three new attacks on the audit, written against the host and client in process; real servers driven over real sockets (restart mid-hand, a second process, quick match, club tools); the production bundle booted against Postgres with a hung database and signals; store probes on the wallet service; six source mutations; Playwright runs against the exported app at four viewports in both languages.
- **No blind challengers.** The earlier passes averaged each assessor with a challenger who tried to refute the report. Here the integrator checked the new findings that move a score in the code instead: the bot move for a disconnected seat (`host.ts:1047`), the link-change rule in the audit (`client.ts:1776`), Home's one-tap "Discard" (`HomeScreen.tsx:361`), the unchecked saved-table record (`storage.ts:123-133`) and the `main`-only deploy trigger (`deploy-signal.yml:32`, with one remote branch). All five are as reported. No score was changed.
- **What was not checked.** Each assessor stopped inside its budget and listed what it left out. The larger items: the second pass's own multiplayer probes were not re-run by the assessor (the integrator's re-pointed copies were); quick match with four humans and the moderation tools were taken from probe results; several club owner tools were not exercised; the fairness screens in the app were not opened; the rule editor and the capped result sheet were confirmed in code, not driven; nothing in this pass ran on a phone.
- **Artifacts.** Assessor reports and their probes are kept outside the repository with the session's working files; the scores, defects and numbers above are taken from them unchanged.
