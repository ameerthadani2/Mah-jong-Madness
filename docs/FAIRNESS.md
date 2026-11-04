# Fair Play Charter

Mahjong Madness exists because players are tired of card and tile apps where the deal feels scripted. This document is the promise, the mechanism and exactly what each player's phone can check.

## The promise

1. **Real luck only.** The tiles you draw are determined by a shuffle seed built from five secret shares: yours, the other players' and the table server's. Once your phone has revealed its share, nobody (another player, a club owner, the server or us) could have picked the seed after seeing it. There is no "luck balancing", no engagement tuning, no rubber-banding, no hidden player tiers, no streak engine. The engine has exactly one source of randomness and it is auditable.
2. **Same rules for everyone.** The rules engine is deterministic and the same code runs on every device. The host validates every action with the same function your phone uses to show you your legal moves.
3. **Every hand can be checked.** After every hand, every player's device re-derives the shuffle and replays the hand from the published log. If anything does not match, the app says so on the result screen, in red.
4. **Nothing in the shop touches the table.** Purchases are cosmetic, coaching or club capacity. No item reveals information, changes odds or buys time that other players do not get.

## The mechanism

```
before the hand              server publishes                  after the hand
───────────────              ────────────────                  ──────────────
seat 0 picks s0       ──▶  H(s0) ┐                         ──▶  s0 revealed
seat 1 picks s1       ──▶  H(s1) │                         ──▶  s1 revealed
seat 2 picks s2       ──▶  H(s2) ├─ all five to every seat ──▶  s2 revealed
seat 3 picks s3       ──▶  H(s3) │  before any reveal      ──▶  s3 revealed
server picks s4       ──▶  H(s4) ┘                         ──▶  s4 revealed
                           seed = H(match:hand:s0|s1|s2|s3|s4)
                           wall = shuffle(144 tiles, seed)
```

* `H` is SHA-256. Your phone reveals its secret only after it holds all five commitments for that hand, so nobody can pick a secret after seeing yours. A server that asks for your secret first is recorded and the hand fails its audit.
* Each human player's phone picks its own secret. The server picks its own share (s4), the shares of bot seats and any stand-in share, so those are only as unpredictable as the server is honest.
* The wall is produced by a SHA-256 counter-mode generator keyed by the whole 256-bit seed (`mjm-sha256ctr-v1`, stamped on every audit so old hands stay verifiable after upgrades) driving a Fisher–Yates shuffle with rejection sampling. Bots use a separate, non-security PRNG for tie-breaks. Secrets come from the platform's secure random generator; the app refuses to deal without one.
* A player who misses the commit window gets a stand-in share from the server. A player who commits but does not reveal makes the ceremony restart, with that seat stood in from then on. Every restart is published in the audit as `{attempt, seats, cause}`. Your phone counts the attempts it saw itself, and rejects an audit whose count differs, whose restarts blame a bot or anything but a player seat, or that needs more attempts than an honest table could (one plus the number of human seats). A server that restarts deals it dislikes is therefore caught once it goes beyond what the human seats could have caused, but a restart within that bound looks the same as a dropped connection.
* The audit (`seed`, all commitments, all secrets, the restarts, the full action log, the final state hash) is sent to every player. The client checks that it was asked to commit for this hand, that its own commitment and secret were recorded unchanged, that the commitments match the ones it was shown, every reveal against its commitment, the seed, a replay of the log through the engine (final hash, announced result and scores, its own final hand) and the ceremony accounting above.

## What your phone can and cannot check

| Claim | Status |
| --- | --- |
| Nobody picked the seed after seeing your share | Checked by your phone after each hand in which your share was used (**Verified**). When the server stood in for you or you joined mid-hand, your share was not used: the hand shows amber **Verified (log only)** and this claim rests on the server. |
| The server did not keep re-dealing until it liked the deal | Bounded, not excluded: restarts are published and checked against what the human seats could have caused (see above). |
| The server applied the rules correctly | Checked: replaying the published log must reproduce the final state, the announced result and the scores. |
| The server did not look at the wall during the hand | **Not checked.** The server knows the seed from the deal onwards. Mitigation: the planned cryptographic shuffle (below). |
| Another player did not see your hand | Enforced by the server: each seat receives only its own view (no other hand, no other seat's drawn tile, claim options or concealed kong). This relies on the server being honest; nothing in the audit shows it. |

## Publishing and testing the generator

In priority order: a plain-language and technical spec page (this document plus `packages/engine/src/rng.ts`); a downloadable per-hand audit from the result screen; a standalone open-source verifier (CLI and browser) that rebuilds the wall from an audit, in the spirit of Tenhou's public wall reproducers; the engine and protocol under an OSI licence; and a monthly tile-statistics report (per-tile draw frequencies, dealer win rate, win-type distribution with chi-square p-values across public hands). Before buying a certificate, run and publish the open batteries on the DRBG output (Dieharder, NIST SP 800-22, TestU01 Crush/BigCrush) plus a GLI-style "range 1–144, 144 selections" draw file; then budget a GLI-19-track RNG certificate (4–8 weeks, covers the RNG/shuffle only) once revenue or any prize context justifies it.

## Roadmap to zero-trust dealing

* **Mental mahjong shuffle** (later, opt-in "paranoid mode"): elliptic-curve SRA so every draw is decrypted cooperatively and no device, host included, learns a tile before its owner. Cost is roughly 430 point multiplications and ~55 KB per player per hand plus a round trip per draw, and no known protocol tolerates a player dropping mid-hand — which conflicts with crash-resume. Ship only once key escrow for disconnected players is solved. Until then online tables run on the game server, which is trusted not to look at the wall; offline games against bots run on your phone.
* **Third-party RNG and engine audit**: publish the engine, the seed derivation and a statistical report on millions of simulated hands (`npm run sim`) so an independent lab can certify the distribution. Simulation today: win rates by seat within noise of 25% each, draw rate ~4%, no seat bias.
* **Signed audits**: hosts sign each audit so disputes can be settled offline by anyone with the public key.

## What players see

* A green **✓ Shuffle & log verified** badge on every result screen when your own share protected the deal; amber **Verified (log only)** with the reason when everything checked out but your share was not used; red **⚠ Audit failed** with the reason if anything is off.
* A **Fair play** screen listing each hand's seed, commitments, secrets, action count and hash.
* Open source engine and protocol in this repository.
