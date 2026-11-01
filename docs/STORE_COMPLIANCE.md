# Store compliance checklist

Verified against Apple's App Review Guidelines and Developer Program License Agreement during research (November 2026). Google Play's "Real-Money Gambling, Games, and Contests" policy and the IARC "simulated gambling" descriptor could not be read in that session and must be checked before submission.

## Apple (verified)

| Rule | What it means for us | Status |
| --- | --- | --- |
| 5.3.3 — no IAP for real-money gaming currency | Chips must never be cashable or exchangeable; the moment they are, our Diamond shop itself violates policy. | Designed in: no cash-out, no transfers, no settlement features. |
| 5.3.4 — real-money gaming needs licences, geo-restriction, free listing | Stay firmly in "simulated gambling": chips have no value. | Designed in. |
| 3.1.1 — currency via IAP, purchased currency never expires, restore mechanism, loot-box odds | Diamonds/chips never expire; separate expiring ledger for free grants; Restore Purchases; no loot boxes. | Catalogue follows; implement ledgers before release. |
| 3.1.1 — gifting allowed, exchange/refund-to-recipient not | Club owners may allocate chips they bought; players cannot exchange them. | Designed in. |
| 3.1.2 — subscriptions may bundle consumables; ≥ 7 days; cross-device | Coach tiers and club tiers qualify. | OK. |
| 3.1.3(b) — items bought elsewhere usable on iOS only if also sold via IAP | Same SKUs on web/Android and iOS. | Plan. |
| 3.1.1(a) — no external purchase links outside the US storefront without entitlement | Do not link to a web shop from the app in non-US storefronts. | Plan. |
| 3.2.1(vii) — no in-app peer-to-peer money tied to digital content | No tipping/settlement tied to chips. | Designed in. |
| 5.3.1/5.3.2 and DPLA 3.3.4 — contests sponsored solely by the developer, rules in-app | Club events award only in-game items; any real-prize event is ours alone. | Policy in docs. |
| 5.1.1(ix) — regulated fields need a legal entity | Publish from a company account. | To do. |
| 2.3.6 / 2.3.8 — honest age rating; 4+ metadata | Answer Simulated Gambling = Frequent, Contests = Frequent, Chat = Yes. Expect 17+/18+. | To do at submission. |
| DPLA Attachment 2 — no transferable "Currency" | Chips are club-scoped allocations, not a balance that moves between users. | Designed in. |
| Age assurance (Texas 4 Jun 2026, Utah 6 May 2026, Louisiana 1 Jul 2026; adult download gating in Singapore/Australia/Brazil) | Implement Declared Age Range API and an in-app age gate before US launch. | To do. |
| Commission | 30% standard / 15% Small Business Program; 26% Taiwan storefront from 31 Oct 2026. | Modelled in docs/MONETISATION.md. |

## Google Play (to verify)
* Real-Money Gambling, Games, and Contests policy text and the simulated-gambling content descriptor.
* How PokerBros, PPPoker and ClubGG are listed and whether any have been removed.

## Jurisdictions (to verify with counsel before enabling club chips)
Taiwan Criminal Code art. 266 (2022 online-gambling amendment) and drop-rate disclosure rules; Hong Kong Gambling Ordinance Cap. 148; Singapore Gambling Control Act 2022 ("money or money's worth"); Malaysia Common Gaming Houses Act 1953; US *Kater v. Churchill Downs* (9th Cir. 2018) and Washington RCW 9.46.0285 ("thing of value" risk for play-chip apps — always keep a free-play path so chips are never required to keep playing); mainland China NPPA ISBN requirement (exclude until confirmed).

## App Review notes to include
Chips and Diamonds have no monetary value and cannot be redeemed; there is no cash-out; club owners purchase via IAP only; terms prohibit chip sales or agent settlement and are enforced; the shuffle is provably fair (commit–reveal, audited per hand); no tile-counting assistance is shown during live chip play.
