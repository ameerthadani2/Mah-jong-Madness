# Mahjong Mania — objective assessment, seventh pass (date: 2026-11-17, evening)

This re-scores the product on the same ten dimensions, weights and rubric as the assessments of 2026-11-04 (3.7/10), 2026-11-06 (5.4/10), 2026-11-13 (6.2/10), 2026-11-16 (6.5/10) and the fifth and sixth passes earlier today (6.6/10 and 6.7/10). Code assessed: commit `c6e11f1`, 572 commits, about 99,600 lines of TypeScript, 2,670 passing tests (engine 373, net 288, server 928 on Postgres, app 856, render 225), every gate green locally and on GitHub CI (run 108).

**Method.** Stronger than the third to sixth passes:
- **Assessors.** The same four group assessors as passes 3 to 6, so their scores compare like for like with those passes.
- **Challengers.** Beside each assessor, a blind challenger scored the same dimensions on its own ports, databases and scratch folders, aiming at the claims most likely to move a score. Neither saw the other's report. Both read the same evidence and the earlier passes, the sixth pass's scores included, so they were not blind to those.
- **Skeptics.** Each new serious defect either side reported went to two skeptics, each told to refute it: one tried to reproduce it, the other read the code.
- **Judges and regression checks, none needed.** A dimension where the two scores differed by half a point or more would have gone to a judge; the largest gap was 0.2 (UX). A sixth-pass serious defect called fixed would have gone to a regression skeptic, but none was judged more than partly fixed.
- **Final scores.** Each dimension's final score is the mean of the two.
- **Size.** 20 agents, about 2.5 million tokens, 73 minutes.
- **My own checks.** I re-ran the probes of every serious defect that survived and of the one the skeptics split on, and read the code of each. I also re-ran the dependency audit (see "What this pass found").

## Scorecard (seventh pass)

| Dimension (weight) | 4 Nov | 6 Nov | 13 Nov | 16 Nov | 17 Nov am | 17 Nov pm | **17 Nov eve**: assessor / challenger → final | Why, in one line | Top gap |
|---|---|---|---|---|---|---|---|---|---|
| Rules fidelity and engine (12%) | 5.8 | 6.9 | 7.5 | 7.7 | 7.7 | 7.7 | 7.8 / 7.8 → **7.8** | The scoring oracle imports nothing from the engine and failed every mutant tried (the team's 6, the challenger's 3). On fresh seeds an independent scorer agreed on 40,000 of 40,000 hands for each side, 1,500 self-play hands passed and 30,000 嚦咕嚦咕 hands matched; three hands scored by hand matched both the engine and the oracle. All of it follows the team's own reading of RULES.md: nothing is checked against a shipped Taiwanese product, and 七對子, 十三么 and the kong-timing choice are not options. | Recorded hands from a shipped Taiwanese product (owner); the variants as options |
| Fairness, anti-rigging (10%) | 3.0 | 4.7 | 6.2 | 6.6 | 7.0 | 7.1 | 7.0 / 6.9 → **7.0** | The sixth pass's attack is closed: a welcome without `clockMs` now fails a 40 s hold 8 of 8, a silent link is dropped and `clockMs=10000` is ignored. Every earlier attack still fails, and 6,000 hostile frames threw nothing. But a server that keeps the link alive with clock frames and pongs whose stamps crawl forward 1 ms at a time can hold a turn frame for 44 s of a 45 s turn with the hand green (6 of 6; I reproduced it). FAIRNESS.md's "the server cannot lengthen these 13 seconds" is therefore false. | Tie the server's stamps to the time the phone sees pass: a frame stamped far behind it must not count as hearing from the table |
| Online multiplayer, clubs (14%) | 3.5 | 5.3 | 6.3 | 6.7 | 6.9 | 7.0 | 7.1 / 7.1 → **7.1** | Over real sockets on Postgres, a restart restored a live table in 37 to 42 ms with both players back in 49 to 57 ms and both audits ok. A restart with the cap lowered restored every live table. A pair behind one IPv4 address is kept apart after three shared tables, across a restart, and linked seats no longer move each other's rating. A linked second account can still feed the first against a stranger (+8 to +20 a match), the hourly join buckets live in memory, and nothing is deployed. | Deploy and play on phones (owner); leave a table with a linked pair unrated against its strangers |
| Visual design, UX, feel (14%) | 5.0 | 6.0 | 6.6 | 6.9 | 7.0 | 7.1 | 7.2 / 7.0 → **7.1** | The coach's advice now stays in view at Extra-large text, the Shop preview is one labelled modal with a focus trap, and wrong puzzle answers are explained in both languages. With Large or Extra-large tiles at 667x375, though, the coach bubble vanishes on most of the player's own turns while its button still shows it as on (both skeptics confirmed it, and so does the code). 11 of 16 sound cues are placeholders, the Taiwanese voice has no files, and nothing has run on a phone. | Commissioned audio and a device run (owner); a coach that never vanishes |
| Learning, single-player (8%) | 3.5 | 5.3 | 5.9 | 6.1 | 6.3 | 6.4 | 6.5 / 6.5 → **6.5** | The isolated-tile rule now answers 114 of 365 dailies (the lone honour answered 303). 965 explanations each name a true decision, and 0 of 900 value and 0 of 900 defence puzzles disagree with exact recounts. A slightly broader rule, "throw the tile with the fewest neighbours", still answers 227 of 365 dailies and 169 of 300 hard puzzles (random guessing gets about 65 and 42). A Rush script that slows on hard puzzles and stops at the 35 ceiling ranks unflagged with about twice an honest score. | Puzzles no simple rule answers well beyond chance; Rush checks calibrated on real players (owner) |
| Monetisation, compliance, legal (10%) | 2.5 | 5.2 | 6.3 | 6.4 | 6.5 | 6.6 | 6.7 / 6.6 → **6.7** | The store-check script passed 7 of 7 for both sides. On memory and Postgres, concurrent deliveries credit once, concurrent spends never overspend, a purchase racing its refund nets to zero, and the webhook refuses every bad secret. No purchase has gone through a real store, and the legal texts carry [Company name] placeholders. | Store products and a sandbox run with `npm run store-check`; counsel (owner) |
| Production, backend, platform (12%) | 2.3 | 5.0 | 6.0 | 6.1 | 6.2 | 6.3 | 6.4 / 6.4 → **6.4** | All three server defects of the sixth pass are fixed on the production bundle. SIGTERM on a hung database exits 1, every live snapshot is restored whatever the cap (198 of 200; 200 of 200), and CI boots the image on Postgres and plays a hand; 200 tables held p95 0.42 to 0.46 ms. Nothing is deployed: android-play has never run, and the only runs of ios-testflight (1 Nov) failed. | First deploy and builds (owner) |
| Engineering quality (8%) | 5.0 | 6.3 | 6.9 | 7.0 | 7.2 | 7.3 | 7.4 / 7.4 → **7.4** | All 13 source mutations the two sides made were caught. The frame fuzzer escaped 0 of 6,000 frames (1 before), the API fuzzer gave 0 server errors on memory and Postgres, and `pg.ts` is split into modules of at most 436 lines. `puzzles.ts` grew to 1,951 lines and `client.ts` to 2,029, 25 of 92 app test files still read `.tsx` source, and npm audit now reports 20 high advisories where the docs say none. | Split `puzzles.ts` and `client.ts`; replace the last source-text tests; patch the advisory |
| Bot strength (6%) | 3.5 | 4.5 | 4.7 | 4.8 | 4.8 | 4.8 | 4.8 / 4.8 → **4.8** | 0 illegal moves in about 695,000 decisions. Far from ready, Pro deals in 2.0 to 2.1% against Club's 3.9 to 4.4%, as its description says. On fresh seeds Pro is not shown stronger than Club (+4.28 a hand, se 6.01, over 1,000 hands; +0.45, se 3.13, over 4,000). Once it is itself ready it deals in as often as Club, and its strength code has not changed since the fifth pass. | A Pro that beats Club at 95% on held-out seeds |
| Market position (6%) | 2.3 | 3.4 | 4.2 | 4.3 | 4.4 | 4.4 | 4.5 / 4.4 → **4.5** | Close to listing-ready on the product side: one name throughout, both listings fit every field, and a first discard takes 5 taps in Chinese. 麻將狂熱 is now set under the icon for zh-Hant phones (checked by Expo's own resolver, but never built). Nothing has shipped: 47 of 47 owner items are open, there is no recorded voice, and a Simplified-Chinese phone gets English. | Trademark, licence, deployment, builds (owner) |

**Overall weighted score: 6.7 / 10.**
- **Final (mean per dimension): 6.72**, unweighted mean 6.5.
- **Assessors alone: 6.75**, comparable with the earlier passes (was 6.67, 6.60, 6.45, 6.2, 5.4 and 3.7).
- **Challengers alone: 6.69.**
- **Agreement.** The challengers came within 0.1 of the assessors overall and within 0.2 on every dimension. They had read the sixth pass's scores, though, so their agreement is not an unanchored second reading. Like for like with the first two passes, the score is probably between 6.5 and 6.7.

## What this pass found (seventh pass)

Serious defects that survived the skeptics, each re-checked by me:
1. **A server that forges crawling stamps can hold a turn frame for 44 s of a 45 s turn and leave the hand green** (fairness, major; both skeptics confirmed it).
   - **The attack.** While it holds the victim's turn state, the server sends pongs and clock frames whose stamps move on 1 ms at a time, with the clock frames' turn number rewritten to the last turn the phone was shown.
   - **Why the watch misses it.** Each such frame moves the link's clock on, so the phone counts it as hearing from the table (`noteOrder` in `packages/net/src/client.ts`) and the silent-link watch never fires. On release the held frame keeps its true stamp. That stamp is within the 1 s order slack of the crawled ones, so the frame is not seen as held, and the table then times the seat out on schedule. Nothing compares how far the stamps moved with the time the phone saw pass.
   - **My check.** I re-ran the assessor's probes: a 40 s and a 44 s hold each stayed green 2 of 2, and the same hold with honest stamps failed `heldFrame` 2 of 2.
   - **Docs.** The sentence in `docs/FAIRNESS.md` that the server cannot lengthen the 13 s limit is false until this is fixed.
   - **Correction, later the same evening: the defect is real and wider than reported.** The assessor's probe mostly measured something else. In most of its runs the bots moved inside the victim's own move, before the probe armed its hold. So the phone had already been shown its turn, and the frame actually held was the one that moves the turn into the time bank. A probe that arms the hold before the victim's move (written by unit 17's first designer, re-run by me) shows the defect on this code:
     - a turn held 25, 40 or 44 s with crawled stamps stays green;
     - so does a server that simply delays every stamped frame by 10, 20 or 30 s from the start of the match (stamps honest, order kept), which costs the player that much of every turn;
     - so does a delay ramped up to 40 s after the deal.

     The root cause: the phone takes a frame's stamp as the start of the seat's clock however late the frame arrives, and a delay present from the first frame of the match never looks late.
2. **With Large or Extra-large tiles in small landscape, the coach bubble vanishes on most of the player's own turns while the coach button still shows it as on** (UX, major; both skeptics confirmed it; it also happens at Normal tiles on some turns).
   - **Why it happens.** When the ponds take the centre column, `coachBudget` returns no line (`apps/mobile/src/components/table/layout.ts`) and `CoachPanel` renders nothing (`CoachPanel.tsx`), while the HUD's cap button stays selected (`TableHud.tsx`).
   - **Why no gate caught it.** A unit test asserts the hiding as intended, and the screens check looks only at bubbles that are shown.

Rated major by its finder, minor by all four skeptics:

3. **"Throw the tile with the fewest neighbours" answers 227 of 365 dailies and 169 of 300 hard discard puzzles**; random guessing gets about 65 and 42.
   - **Cause.** The generator redraws only hands that the narrower isolated-tile rule answers. I re-ran the count and got the same figures.
   - **Why minor.** The rule is a rough tile-efficiency count, which is the skill the puzzles teach, and every answer is still judged exactly. The claim that these puzzles need comparing shapes is overstated, though.

Refuted: the challenger's two other fairness attacks.
- **Re-stamping the held frames on release**, with pongs answered or stale clock frames. Once the hold really starts before the turn, this is caught as an early table move. The challenger's probe started its hold after the turn state had already arrived. I re-ran the skeptic's corrected probe, and every case failed with `playedEarly`.
- **Hiding every claim chance for a hand** was the same probe mistake: the victim had been shown each chance.

Major but not new (the sixth pass's, partly fixed): a Rush script that slows on hard puzzles and stops at the 35 ceiling ranks unflagged with about twice an honest score (35 against 17). The challenger's variant ranked in 200 of 200 runs. The thresholds were set without real players, and the limit is stated in `docs/API.md`.

New minor findings, each reported by one side (the next unit reproduces each before fixing it):
- **Dependency advisories.** `npm audit --omit=dev` now reports 20 high advisories and 9 moderate (I ran it). The high ones are one new picomatch ReDoS advisory (GHSA-fc5q-39xc-vjpf), reached through Metro, Jest's workers, the Expo CLI and React Native's codegen, all of it build tooling. `docs/ARCHITECTURE.md` still says 12 moderate and none high.
- **Rating feeding.** A linked second account can still feed the first against a stranger at a shared table. The pair does not move each other, but each moves against the stranger (+8 to +20 a match, at most three such tables a day per pair).
- **Scoring oracle.** It checks how win situations score, not how the game detects them: the flags are handed in. Self-play produced only one 搶槓 and two 槓上開花 in 1,500 hands.
- **Flower as the last tile.** A flower drawn as the last live tile ends the hand with no replacement, and RULES.md does not say so.
- **Pro's description.** It says Pro scores a little more than Club overall. Neither fresh run supports that at 95%, though the team's own 35,000 hands do.
- **Puzzle explanations.** Each is built from one accepted answer, so it can contradict a different accepted answer the player chose. About half of the break-a-pair and isolated-tile puzzles accept such a second answer.
- **English puzzle texts** say "1 Characters" and leave 搭子 untranslated.
- **Shop preview on the web.** Focus lands on the hidden scrim on every third Tab, and the buttons behind the dialog stay exposed to screen readers that ignore `aria-modal`.
- **Coach at Extra-large tiles.** At 667x375 the advice box is 15 px tall for 45 px of advice, so the advice is cut mid-list with no sign that it scrolls.
- **Restore.** It accepts a snapshot whose game or rules are garbage as a live table.
- **Store edge cases.** A purchase price of 10^10 or more makes the webhook throw on Postgres (`numeric(14,4)`). A subscription refund or renewal that names the old account after a `TRANSFER` reaches that account, not the one the plan moved to.
- **CI.** The docker job writes the container log on failure but never uploads it. One Web preview run failed on a transient `npm ci` with no retry.
- **Server tests.** Three server test files read files outside `apps/signal`, so the server suite cannot run on its own workspace.
- **Web title.** The page title stays "Mahjong Mania" in zh-TW.
- **Quick match.** A requeue after leaving a quick-match table waits about 9 s; the challenger's probe was refused as still seated.

Checked and not a defect: a same-address pair, once kept apart, stays apart for good. That is what `docs/API.md` says it does; the challenger read it as lasting only for the day.

Bots: Pro was +4.28 a hand over Club on the assessor's 1,000 fresh paired hands (se 6.01) and +0.45 on the challenger's 4,000 (se 3.13). The team's 35,000 hands gave +3.3 (se 1.0). Pro is not shown stronger on fresh seeds.

Owner-blocked, as before:
- deployment;
- native builds (android-play has never run, and the ios-testflight runs of 1 Nov failed);
- store products and a sandbox purchase;
- counsel, trademark and licence;
- commissioned audio and the Taiwanese voice;
- recorded hands from a shipped Taiwanese app;
- a native zh-TW review;
- devices and players.

---

# Sixth pass (2026-11-17, afternoon), kept for its detail

This re-scores the product on the same ten dimensions, weights and rubric as the assessments of 2026-11-04 (3.7/10), 2026-11-06 (5.4/10), 2026-11-13 (6.2/10), 2026-11-16 (6.5/10) and the fifth pass this morning (6.6/10). Code assessed: commit `aa1c215`, 535 commits, about 96,600 lines of TypeScript, 2,585 passing tests (engine 350, net 276, server 902 on Postgres, app 857, render 200), every gate green locally and on GitHub CI.

**Method.** As in the third to fifth passes: four independent assessors, one per group of dimensions, who started from the evidence on disk (the full gate log, units 12 to 14's records, the fifth pass's probes) and ran their own checks (an independent scorer on 40,000 fresh hands, 1,500 self-play hands, fresh bot ladders, attacks on the clock frames and the question-only puzzles, real servers over real sockets on memory and Postgres, 200 live tables on the production bundle, source mutations in the new code, API and frame fuzzers, Playwright on the exported app). No blind challengers, so these are assessor scores, probably about 0.2 high compared like for like with the first two passes. I checked every new engineering finding in the code myself (listed under "What this pass found"). The earlier passes follow below.

## Scorecard (sixth pass)

| Dimension (weight) | 4 Nov | 6 Nov | 13 Nov | 16 Nov | 17 Nov am | **17 Nov pm** | Why, in one line | Top gap |
|---|---|---|---|---|---|---|---|---|
| Rules fidelity and engine (12%) | 5.8 | 6.9 | 7.5 | 7.7 | 7.7 | **7.7** | On fresh seeds an independent scorer agreed on 40,000 of 40,000 hands, 1,500 self-play hands passed every claim-window check, 30,000 random 嚦咕嚦咕 hands matched, the dealer-streak and cap cases settle correctly, and a damaged saved table resumes on its intact rules. Nothing is checked against 明星三缺一, and 七對子, 十三么 and the kong-timing choice are not options. | Recorded hands from a shipped Taiwanese product (owner); the variants as options |
| Fairness, anti-rigging (10%) | 3.0 | 4.7 | 6.2 | 6.6 | 7.0 | **7.1** | A missing bot strength is red on 20 of 20 hands, a held frame announced by clock frames is red on 8 of 8, every replayed attack still fails, and claims passed while the link was down are named. The held-frame proof and the silent-link watch depend on the server announcing its clock frames: without `clockMs`, 40 s of a 45 s turn can be held back and the hand stays green. | Make the clock frames compulsory, as the bot strength now is |
| Online multiplayer, clubs (14%) | 3.5 | 5.3 | 6.3 | 6.7 | 6.9 | **7.0** | Over real sockets a Postgres restart restored a live table in 42 ms with both players back in 54 ms and both audits ok; rated matching, persisted pair counts and the club members rule are in, with tests. Nothing is deployed, the hourly join buckets are in memory, and the rating can be farmed with a second account behind one home address. | Deploy and play on phones (owner); keep one address from moving its own rating |
| Visual design, UX, feel (14%) | 5.0 | 6.0 | 6.6 | 6.9 | 7.0 | **7.1** | The Shop's try-on preview works for every kind of look as a proper modal (focus in, Escape closes, focus back to the card). 11 of 16 sound cues are placeholders, the Taiwanese voice has no files, nothing has run on a phone, and at Extra-large text in small landscape the coach's advice is hidden. | Commissioned audio and a device run (owner) |
| Learning, single-player (8%) | 3.5 | 5.3 | 5.9 | 6.1 | 6.3 | **6.4** | Ranked Rush and the daily are served as questions, each answer stamped by the server; the fifth pass's paced script is flagged while an honest pace ranks; 0 of 900 value and 0 of 900 defence puzzles disagree with exact recounts. "Throw an isolated honour if you have one" answers 303 of the next 365 daily puzzles, and a script with jitter and two deliberate mistakes passes every per-answer check. | Daily and discard puzzles a one-line rule cannot solve |
| Monetisation, compliance, legal (10%) | 2.5 | 5.2 | 6.3 | 6.4 | 6.5 | **6.6** | The store-check script passed 7 of 7 steps against the assessor's own server; four new refund and delivery orders held on memory and Postgres; the Rush meter counts the same UTC day in app and server. No purchase has gone through a real store, and the legal texts carry [Company name] placeholders. | Store products and a sandbox run with `npm run store-check`; counsel (owner) |
| Production, backend, platform (12%) | 2.3 | 5.0 | 6.0 | 6.1 | 6.2 | **6.3** | The production bundle on Postgres held 200 live tables for 45 s at p95 0.47 ms and 171 MB, refused every unsafe boot, restored live tables after a SIGKILL and answered 503 within 2 s on a hung database; a skipped deploy marks the commit. Nothing is deployed, and the Android and iOS release workflows have never run a real job. | First deploy and builds (owner) |
| Engineering quality (8%) | 5.0 | 6.3 | 6.9 | 7.0 | 7.2 | **7.3** | All 6 source mutations the assessor made in the new code were caught, API and frame fuzzers gave 0 server errors in 21,600 requests, and 2,585 tests pass with .tsx coverage at 78% under floors. 29 of 92 app test files still read source text, the net client is still 2,012 lines, and CI went red once more on a timing flake. | Replace the remaining source-text tests |
| Bot strength (6%) | 3.5 | 4.5 | 4.7 | 4.8 | 4.8 | **4.8** | 0 illegal moves in about 680,000 decisions, and the bot gate now fails any change that alters a reference hand. Pro is still not shown stronger than Club: the assessor's fresh 3,000 paired hands gave +4.75 a hand (se 3.42), and its in-play deal-in is 17.2% against 17.9%. | A Pro that beats Club at 95% on held-out seeds |
| Market position (6%) | 2.3 | 3.4 | 4.2 | 4.3 | 4.4 | **4.4** | Close to listing-ready on the product side: one name throughout, both listings fit every field, a first discard in 5 taps in Chinese, a try-on preview in the Shop. Nothing has shipped: 47 of 47 owner items are open, there is no recorded voice, and the phone's home screen would say "Mahjong Mania" under the icon on a zh-TW phone. | Trademark, licence, deployment, builds (owner) |

**Overall weighted score: 6.7 / 10** (6.67; was 6.6, 6.5, 6.2, 5.4 and 3.7). Unweighted mean: 6.5. Like for like with the first two passes, about 6.5.

## What this pass found (sixth pass)

New engineering defects, each confirmed in the code or by my own count:
1. **"Throw an isolated honour if you have one" answers 83% of daily puzzles.** I counted the next 365: 303 hands hold an isolated honour, and in every one of them throwing it is an accepted answer (`packages/engine/src/puzzles.ts`, the discard generator: answers within 10% of the best acceptance count as right, and an isolated honour always is). The daily teaches little.
2. **The clock frames are optional for the server.** A welcome without `clockMs` turns the silent-link watch off (`packages/net/src/client.ts`, `checkLink` returns "ok" when `clockMs` is null), so a held turn frame goes unseen; and the client accepts any `clockMs` up to 10 s (`clientclock.ts`, `MAX_CLOCK_FRAME_MS`), which stretches the documented 13 s limit to about 27 s.
3. **A paced script with jitter and two deliberate mistakes passes every per-answer check** and outscores an honest player about 3 to 1 in Rush (56 solved against 17). The thresholds were set without real players; the limit is stated in docs/API.md.
4. **The table rating can be farmed by a second account behind the same home IPv4 address**, which quick match may now seat at the same table when the queue is quiet (`apps/signal/src/tableRating.ts`, `matchmaking.ts`).
5. **The client throws on a frame whose body is the text "undefined"** (the assessor's frame fuzzer; `JSON.parse` in the link layer), where it should drop the frame.
6. **Live snapshots beyond the hosted-table cap are marked finished at boot** (`apps/signal/src/rooms.ts`), ending live matches for good if the cap is ever lowered; and **SIGTERM while the database hangs exits 0** after "snapshot not saved", so the platform sees a clean stop although moves were lost.

Smaller ones: the coach's advice hidden at Extra-large text in small landscape; the Shop preview exposes an unlabelled outer dialog and a second close button on the web; the phone's home-screen name is not localised; Pro's description quotes one sample's deal-in figures; the CI image is never booted against Postgres; `wallet.test.ts` does not cover the negative-balance spend guard; a purchase event with a negative price is recorded as given; the independent scorer does not yet cover win-situation items; 29 of 92 app test files still read source text.

Bots: Pro was +4.75 a hand over Club on the assessor's fresh 3,000 paired hands (se 3.42), pooled with the earlier fresh runs about +1 (se about 1.8): still not shown to be stronger.

Owner-blocked, as before: deployment, native builds (the Android and iOS release workflows have not run a real job), store products and a sandbox purchase, counsel, trademark and licence, commissioned audio and the Taiwanese voice, recorded hands from a shipped Taiwanese app, a native zh-TW review, devices and players.

---

# Fifth pass (2026-11-17, morning), kept for its detail

This re-scores the product on the same ten dimensions, weights and rubric as the assessments of 2026-11-04 (3.7/10), 2026-11-06 (5.4/10), 2026-11-13 (6.2/10) and 2026-11-16 (6.5/10). Code assessed: commit `75bbc7e`, 498 commits, about 91,000 lines of TypeScript, 2,424 passing tests (engine 342, net 258, server 848 on Postgres, app 837, render 139), every gate green locally and on GitHub CI.

**Method.** As in the third and fourth passes: four independent assessors, one per group of dimensions, who started from the evidence on disk (the full gate log, every fix unit's records, the fourth pass's probes) and ran their own checks (an independent scorer on 40,000 fresh hands, 1,500 self-play hands, fresh bot ladders, the fourth pass's attacks re-run and new ones, real servers over real sockets on memory and Postgres, the production bundle, source mutations, Playwright on the exported app). No blind challengers, so these are assessor scores; compared like for like with the first two passes they are probably about 0.2 high. I checked every new engineering finding in the code myself (listed under "What this pass found"). The fourth pass follows below, then the third pass for its detail.

## Scorecard (fifth pass)

| Dimension (weight) | 4 Nov | 6 Nov | 13 Nov | 16 Nov | **17 Nov** | Why, in one line | Top gap |
|---|---|---|---|---|---|---|---|
| Rules fidelity and engine (12%) | 5.8 | 6.9 | 7.5 | 7.7 | **7.7** | On fresh seeds an independent scorer agreed on 40,000 of 40,000 hands, 1,500 self-play hands passed every claim-window check and 30,000 random 嚦咕嚦咕 hands matched an independent checker. Nothing is checked against 明星三缺一; 七對子, 十三么 and the kong-timing choice are not options. | Recorded hands from a shipped Taiwanese product (owner); the variants as options |
| Fairness, anti-rigging (10%) | 3.0 | 4.7 | 6.2 | 6.6 | **7.0** | The fourth pass's top gap is closed: forced claims for an idle seat are red (18 of 20; the other 2 played the rule's own moves), bots that dodged the victim's win are red (6 of 6), the rest of a match played inside a drop is red with no verified match end (10 of 10), and a wall-clock step either way leaves an early move red. A server that leaves its bot strength out of the welcome frame turns all of that amber, and one that calls its bots human seats is not checked. | Make a missing bot strength red; say plainly that the server decides which seats are human |
| Online multiplayer, clubs (14%) | 3.5 | 5.3 | 6.3 | 6.7 | **6.9** | Over real sockets a Postgres restart restores a table in 65 ms with both audits ok, a second process is refused in 2.5 s, a dropped player keeps the turn, quick match keeps one address or device apart and seats four strangers in 1 ms, a closed club match leaves a record. Nothing is deployed, and matching is by arrival order with no rating. | Deploy and play on phones (owner); rated matchmaking |
| Visual design, UX, feel (14%) | 5.0 | 6.0 | 6.6 | 6.9 | **7.0** | All five UX defects of the fourth pass are fixed and measured: Extra-large tiles grow the landscape hand (45x63 at 844x390, 34x48 at 667x375), screen readers hear the wall and compass as sentences, exit and resume bring back the same 17 tiles. 11 of 16 sound cues are placeholders, the Taiwanese voice has no files, nothing has run on a phone. | Commissioned audio and a device run (owner) |
| Learning, single-player (8%) | 3.5 | 5.3 | 5.9 | 6.1 | **6.3** | The server enforces the free Rush (4 parallel starts: one 201, three 403), Rush no longer moves the rating, a naive script is recorded but not ranked, 0 of 900 value and 0 of 900 defence puzzles disagree with exact recounts. A script that waits (6 s on the daily, 89 Rush answers in 180 s with one deliberate mistake) still ranks first on both boards, unflagged. | Per-answer timing on the server; plausibility checks calibrated on real players |
| Monetisation, compliance, legal (10%) | 2.5 | 5.2 | 6.3 | 6.4 | **6.5** | The server's Rush meter holds under 8 concurrent starts on Postgres; every earlier store probe and four new refund and redelivery orders hold; the store-check script has its own negative tests. No purchase has gone through a real store, and the legal texts still carry [Company name] placeholders. | Store products and a sandbox run with `npm run store-check`; counsel (owner) |
| Production, backend, platform (12%) | 2.3 | 5.0 | 6.0 | 6.1 | **6.2** | GitHub CI is green on the last seven pushes; the production bundle on Postgres refuses every unsafe boot, survives a hung database and restores live tables after a SIGKILL mid-hand. Nothing is deployed, no build exists, and the release workflows have never run a real job. | First deploy and builds (owner); a skipped deploy that does not report success |
| Engineering quality (8%) | 5.0 | 6.3 | 6.9 | 7.0 | **7.2** | All 6 source mutations the assessor made were caught (4 on the server, 2 in render tests); 139 render tests measure the .tsx screens at 70% of lines with floors in CI. 29 of 91 app test files still read .tsx source text, and a flaky test turned CI red once after the fourth pass. | Replace the remaining source-text tests; render tests for the last screens |
| Bot strength (6%) | 3.5 | 4.5 | 4.7 | 4.8 | **4.8** | 0 illegal moves in about 474,000 decisions; at a 嚦咕嚦咕 table every tier now plays for it. Pro is not shown to be stronger than Club: the assessor's fresh 3,000 paired hands gave -3.6 a hand (se 3.6), and the bot gate passes a Pro with its defence switched off. | A clearly stronger Pro, on held-out hands an assessor can reproduce |
| Market position (6%) | 2.3 | 3.4 | 4.2 | 4.3 | **4.4** | The product side is close to listing-ready: one name throughout, 麻將狂熱 on a zh-TW Home, both listings fit every field and name the leaderboards, a first discard in 5 taps in Chinese. Nothing has shipped: 47 of 47 owner checklist items are open, and quick match on the exported web app cannot reach a server. | Trademark, licence, deployment, builds (owner) |

**Overall weighted score: 6.6 / 10** (6.60; was 6.5, 6.2, 5.4 and 3.7). Unweighted mean: 6.4. Like for like with the first two passes, about 6.4.

## What this pass found (fifth pass)

New engineering defects, each confirmed in the code:
1. **A paced script still tops the puzzle boards.** Rush answers reach the server in one batch at the end of the run (`apps/signal/src/puzzles.ts`, the finish route), so the server sees only the total time; the automation flag needs an average under 2 s an answer or a perfect run, and a script that answers every 2.02 s with one deliberate mistake slips under both.
2. **A server that leaves the bot strength out of its welcome frame gets amber instead of red** for every bot and timeout cheat (`packages/net/src/client.ts`, the `skillUnknown` caveat). It was meant for older hosts, but none was ever deployed.
3. **The bot gate passes a bot with its defence switched off.** 968 of 2,000 reference hands change, but the gate checks only the strength margin, which stays inside its tolerance (`packages/engine/scripts/simulate.ts`, `runGate`).
4. **The app counts the free Puzzle Rush by the phone's local day, the server by the UTC day** (`apps/mobile/src/monetisation/wallet.ts`, `localDayKey`), so in Taiwan the app offers a run from midnight that the server refuses until 08:00.
5. **Quick match never seats two accounts behind one IPv4 address together** (`apps/signal/src/matchmaking.ts`, `clash`), so strangers behind one mobile carrier's shared address can never meet at a table.
6. **Club standings count a match between two members and two bots** (`apps/signal/src/clubs.ts`), so two accounts can trade points.
7. **A deploy run that skipped because the Fly token is missing reports success** (`.github/workflows/deploy-signal.yml`).
8. **The consent question judges "under 18" by a different rule from the age gate** (`apps/mobile/src/legal/useAgeGate.ts`: current year minus birth year, where the gate uses the youngest age the birth year allows).

Smaller ones: CI's screenshot upload still uses an action that runs on Node 20; side-seat name tags take three lines in small landscape; the locked Pro chip is announced as disabled although it opens the Shop; a damaged saved rules object falls back to the defaults without a word; 8 of 37 discard quizzes are answered by the only isolated honour; the claim, defence and value puzzle views have no render tests; 12 moderate advisories remain in production dependencies; a refunded diamond pack leaves the looks it bought (the balance goes negative and blocks spending); the free hand-review allowance is counted only on the device (reviews are computed offline).

Pro: the team's figure is +3.3 a hand over Club on 35,000 paired hands (se 1.0); the assessors' own runs on fresh seeds gave +1.2 (5,000 hands, fourth pass) and -3.6 (3,000 hands, this pass), about -0.5 (se 2.1) pooled. Pro is described in the app as only a little stronger, which is the honest reading.

Owner-blocked, as before: deployment, native builds, store products and a sandbox purchase (now with `npm run store-check`), counsel, trademark and licence, commissioned audio and the Taiwanese voice, recorded hands from a shipped Taiwanese app, a native zh-TW review (including the new wording for 向聽), devices and players.

---

# Fourth pass (2026-11-16), kept for its detail

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
