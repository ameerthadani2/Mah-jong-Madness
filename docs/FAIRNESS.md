# Fair Play Charter

Mahjong Madness exists because players are tired of card and tile apps where the deal feels scripted. This document is the promise, the mechanism and the proof.

## The promise

1. **Real luck only.** The tiles you draw are determined by a shuffle seed that no single party — player, host phone, club owner or us — can choose, predict or influence. There is no "luck balancing", no engagement tuning, no rubber-banding, no hidden player tiers, no streak engine. The engine has exactly one source of randomness and it is auditable.
2. **Same rules for everyone.** The rules engine is deterministic and the same code runs on every device. The host validates every action with the same function your phone uses to show you your legal moves.
3. **Every hand can be checked.** After every hand, every player's device re-derives the shuffle and replays the hand from the published log. If anything does not match, the app says so on the result screen, in red.
4. **Nothing in the shop touches the table.** Purchases are cosmetic, coaching or club capacity. No item reveals information, changes odds or buys time that other players do not get.

## The mechanism

```
before the hand          host collects                 after the hand
───────────────          ────────────                  ──────────────
seat 0 picks s0  ──▶  H(s0) published to all  ──▶  s0 revealed
seat 1 picks s1  ──▶  H(s1) published to all  ──▶  s1 revealed
seat 2 picks s2  ──▶  H(s2) published to all  ──▶  s2 revealed
seat 3 picks s3  ──▶  H(s3) published to all  ──▶  s3 revealed
                      seed = H(match:hand:s0|s1|s2|s3)
                      wall = shuffle(144 tiles, seed)
```

* `H` is SHA-256. Commitments are broadcast before any secret is revealed, so nobody can pick their secret after seeing the others.
* The host contributes a fifth committed share, so even a fully colluding table of four cannot steer the seed, and a griefer cannot force re-rolls without it being recorded: every audit carries the ceremony attempt count and the reason for any restart.
* The wall is produced by a SHA-256 counter-mode generator keyed by the whole 256-bit seed (`mjm-sha256ctr-v1`, stamped on every audit so old hands stay verifiable after upgrades) driving a Fisher–Yates shuffle with rejection sampling. Bots use a separate, non-security PRNG for tie-breaks.
* Bots and stand-ins for disconnected players contribute secrets too, so a table of one human is still unpredictable to the host.
* A seat that fails to reveal is replaced by a stand-in and the ceremony restarts; a griefer cannot bias the deal by refusing.
* The audit (`seed`, all commitments, all secrets, the full action log, the final state hash) is sent to every player. The client checks its own commitment and secret were recorded unchanged, verifies every reveal against its commitment, re-derives the seed, replays the log through the engine and compares the final hash and its own final hand.

## What this does and does not prove

| Claim | Status |
| --- | --- |
| Nobody chose or biased the shuffle | Proven to every player after each hand. |
| The host applied the rules correctly | Proven: the replay would diverge otherwise. |
| The host did not look at the wall during the hand | **Not proven** in phone-hosted tables. The hosting phone necessarily knows the seed. Mitigations: *Neutral server host* for club tables (the club's server runs the identical code and nobody at the table sees the seed), and the planned cryptographic shuffle (below). |
| Another player did not see your hand | Proven: the host sends each seat only its own view; a malicious client gains nothing from the protocol. |

## Publishing and testing the generator

In priority order: a plain-language and technical spec page (this document plus `packages/engine/src/rng.ts`); a downloadable per-hand audit from the result screen; a standalone open-source verifier (CLI and browser) that rebuilds the wall from an audit, in the spirit of Tenhou's public wall reproducers; the engine and protocol under an OSI licence; and a monthly tile-statistics report (per-tile draw frequencies, dealer win rate, win-type distribution with chi-square p-values across public hands). Before buying a certificate, run and publish the open batteries on the DRBG output (Dieharder, NIST SP 800-22, TestU01 Crush/BigCrush) plus a GLI-style "range 1–144, 144 selections" draw file; then budget a GLI-19-track RNG certificate (4–8 weeks, covers the RNG/shuffle only) once revenue or any prize context justifies it.

## Roadmap to zero-trust dealing

* **Mental mahjong shuffle** (later, opt-in "paranoid mode"): elliptic-curve SRA so every draw is decrypted cooperatively and no device, host included, learns a tile before its owner. Cost is roughly 430 point multiplications and ~55 KB per player per hand plus a round trip per draw, and no known protocol tolerates a player dropping mid-hand — which conflicts with crash-resume. Ship only once key escrow for disconnected players is solved. Until then the neutral server host is the default for club and stakes tables; phone-hosted play is labelled "friends mode: the host device is trusted".
* **Third-party RNG and engine audit**: publish the engine, the seed derivation and a statistical report on millions of simulated hands (`npm run sim`) so an independent lab can certify the distribution. Simulation today: win rates by seat within noise of 25% each, draw rate ~4%, no seat bias.
* **Signed audits**: hosts sign each audit so disputes can be settled offline by anyone with the public key.

## What players see

* A green **✓ Shuffle & log verified** badge on every result screen; red **⚠ Audit failed** with the reason if anything is off.
* A **Fair play** screen listing each hand's seed, commitments, secrets, action count and hash.
* Open source engine and protocol in this repository.
