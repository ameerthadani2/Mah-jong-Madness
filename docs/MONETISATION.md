# Monetisation

**Principle:** we sell cosmetics and coaching (clubs are free at launch). We never sell luck, information or time that other players at the table do not have. Everything below was designed against two reference businesses: PokerBros (club economy) and chess.com (learning subscriptions). Figures for those companies come from a research sweep that could only read search-engine extracts of the primary pages (the session's network policy blocked direct reads), so they are marked *reported* and must be re-verified from the live pricing pages before launch. Store-policy constraints come from Apple's own guidelines and are verified.

## How the references make money

### PokerBros (publisher of record: Thinklean Limited)
*Reported.* One premium currency, **Diamonds**, bought via IAP at roughly 60–65 per USD ($0.99 → 60, $4.99 → 300, $9.99 → 600, $20.99 → 1,300, $46.99 → 2,988, $99.99 → 6,468), also sold as gift cards outside the stores. Diamonds buy:

1. **Club chips** that only a club owner can mint (≈2.5 Diamonds per chip, i.e. a 4–5% take on all chips entering play). Chips never leave their club and have no cash value in the terms; the real-money settlement that clubs run through agents happens off-platform, with all the legal and counterparty risk that implies.
2. **Club level renewals** every 30 days that scale member and manager capacity (free Starter: 2 managers / 30 players; entry paid tiers ≈ $20–26/month; very large clubs ≈ $800/month).
3. **VIP cards** (Bronze/Silver/Gold × 30/90/365 days; Gold 30-day ≈ 1,299 Diamonds) bundling time banks, rabbit hunting, themes, emojis, avatars, extra club slots and "offline protection".
4. **Consumables**: time banks, rabbit cams, emoji throws, sold to players and as bundles clubs send to members.
5. **Per-table features**: Insurance and Run-It-Twice cost the club Diamonds to enable.

PokerBros takes no rake; clubs set and keep it. Public estimates put it at a few hundred thousand USD per month in store revenue, with the real money flowing off-platform.

### chess.com
*Verified from chess.com support pages.* Free "Basic" is a full-quality taster with daily meters (3 rated puzzles, 1 Puzzle Rush, 1 Puzzle Battle, 1 full Game Review per day, first bot per strength band). Three tiers (*reported* US prices): Gold ≈ $6.99/mo or $49.99/yr (no ads, unlimited puzzles/lessons/bots), Platinum ≈ $10.99/mo or $79.99/yr (+ unlimited Game Review and Puzzle Battle), Diamond ≈ $16.99/mo or $119.99/yr (+ coach explanations on every move, insights). Friends & Family ≈ $199.99/yr for 6 Diamond seats. 7-day trials, 30-day money-back, regional pricing. Clubs, friends and club matches are free at every tier.

### Taiwanese 16-tile incumbents
*Reported.* 明星3缺1 (≈ US$2M/month on Taiwan iOS alone by one estimate), 神來也, 老子有錢 monetise with virtual chips, VIP by top-up tier, NT$90–330/month subscriptions, rake on premium tables and casino mini-games. Fairness complaints ("付費玩家牌比較好") are endemic even with iTech Labs badges. Club/room-card apps with agents have produced listing refusals and money-laundering prosecutions. No incumbent offers verifiable shuffles, lessons, puzzles, ratings or review.

## What we will and will not copy

Decided for launch (plan Phase 4): we ship the coaching subscriptions, diamonds and cosmetics only. The club economy stays free and points-only until it has been reviewed by counsel in each launch market.

| PokerBros mechanic | Mahjong Madness at launch |
| --- | --- |
| Premium currency ladder | **Yes.** Diamonds at 60 per dollar tier, with the bonus on bigger packs stated exactly. |
| Club renewals by capacity | **No.** Clubs are free, with the server's fair-use caps. Revisit only once clubs show demand. |
| Owner-minted club chips | **No.** Standings are points only (open decision 1 settled: points-only). Points have no monetary value and cannot be redeemed or transferred. |
| Time banks for sale | **No.** The time bank is a table rule, identical for all seats. Selling time changes outcomes. |
| Insurance / run-it-twice analogues | **No.** Nothing that alters payouts. |
| Rabbit hunt | **Not at launch.** |
| VIP cards | **Not at launch.** Nothing a VIP card would bundle exists yet. |
| Offline protection behind VIP | **No: free for everyone.** Crash and disconnect resume is a core promise. |

| chess.com mechanic | Mahjong Madness at launch |
| --- | --- |
| Metered free taster | **Yes.** 1 full hand review a day, 1 Puzzle Rush a day; daily puzzle, drills, every lesson, Beginner and Club bots free. Meters reset at local midnight by the server's clock once the app has seen it. |
| Coaching tiers | **Two** (below). A third tier waits until move-by-move explanations exist. |
| Family / club bundle | **Not at launch** (the old "Table Pass" granted one seat, not six). |
| Free clubs and club matches | **Yes.** |
| Celebrity coach personas | Later: coach voice or persona packs as cosmetics. |

## Catalogue (implemented in `apps/mobile/src/monetisation/catalog.ts` and `apps/signal/src/catalog.ts`)

The two files list the same products (the server's `test/catalog.test.ts` reads the app's file). The server decides every grant from store webhooks and diamond spends; the app only reads `GET /api/me`. Prices below are US dollar planning tiers: the Shop only ever shows the localised price string the store returns, and regional pricing uses the stores' tiers.

**Diamonds** (consumable; purchased diamonds never expire; bonus diamonds are kept on a separate ledger and spent first). The badge is the bonus as a share of the 60-per-dollar base, rounded.

| Store id | Price tier | Diamonds | Of which bonus | Badge |
| --- | --- | --- | --- | --- |
| `diamonds.60` | $0.99 | 60 | 0 | |
| `diamonds.300` | $4.99 | 300 | 0 | |
| `diamonds.600` | $9.99 | 600 | 0 | |
| `diamonds.1300` | $19.99 | 1,300 | 100 | +8% |
| `diamonds.3450` | $49.99 | 3,450 | 450 | +15% |
| `diamonds.7500` | $99.99 | 7,500 | 1,500 | +25% |

**Table looks** (cosmetic, owned for good; bought with diamonds only through `POST /api/wallet/spend`, so there is no cash price to undercut): Night Market 300, Bamboo Garden 300, Jade Parlour 400, Imperial Red 300. The three free felts (Classic, Deep Green, Midnight Blue) stay free.

**Coaching** (auto-renewing subscriptions, cross-device through the account; Google Play: subscription `coach.gold` / `coach.platinum` with base plans `month` and `year`):

| Plan | Store ids | Monthly | Yearly | What it unlocks today |
| --- | --- | --- | --- | --- |
| Free | | | | Coach at bot tables, daily puzzle, drills, every lesson, 1 hand review and 1 Puzzle Rush a day, Beginner and Club bots |
| Coach Gold | `coach.gold.month`, `coach.gold.year` | $6.99 | $49.99 | Pro bots, unlimited Puzzle Rush |
| Coach Platinum | `coach.platinum.month`, `coach.platinum.year` | $10.99 | $79.99 | Everything in Gold plus unlimited hand reviews |

The Shop copy lists only these unlocks. Removed until built: Coach Diamond, Table Pass, zodiac avatars, Taiwan emotes, VIP cards and club capacity tiers. Trials and introductory offers are set in the stores, not in the app.

**Builds without keys.** With no `EXPO_PUBLIC_REVENUECAT_IOS_KEY` / `_ANDROID_KEY` the Shop says "Store unavailable on this build", shows no prices and grants nothing; table looks can still be bought with diamonds the server already holds. `EXPO_PUBLIC_STORE_MODE=mock` gives a development build an instant, free test store whose grants live only on the device until the next sync; a release build cannot select it.

## Compliance guardrails (see `docs/STORE_COMPLIANCE.md`)
* "Diamonds and points have no monetary value and cannot be redeemed or transferred": shown on the Shop, Clubs, standings and Settings, and in the Terms.
* Purchased diamonds never expire; nothing moves between players; no cash-out, prizes or settlement features.
* No loot boxes. If a randomised item is ever added, odds are disclosed before purchase.
* Nothing sold changes the tiles, what a player sees at the table, or the clock.
* Age gate at 17 (birth year); age rating answers in `docs/STORE_COMPLIANCE.md`.
* Restore Purchases in the Shop; the same store ids on every platform.

## Revenue model sketch (for planning only)
Assume 10,000 monthly actives after a Taiwan + diaspora launch. If 3% subscribe at a blended $8/month (≈ $2.4k) and diamonds average $0.25 per active (≈ $2.5k), monthly gross is ≈ $5k before store fees (30%, 15% under the Small Business Program, 26% on the Taiwan storefront from 31 Oct 2026). Clubs earn nothing directly at launch; they are the acquisition and retention layer (every active club brings players who are prospects for coaching). Rebuild this from observed conversion after the beta (plan Phase 8).

## Open decisions
1. ~~Club chips at launch~~: settled, points-only standings at launch; chips only after per-market legal review, if ever.
2. Regional price tiers (Taiwan, Hong Kong, Singapore, Malaysia, US, Australia, UK/EU): set in the stores, not flat USD.
3. Ads: none planned. Revisit only if free-tier costs demand it, and then rewarded-only with a permanent No-Ads purchase.
4. Paid club capacity: only if clubs outgrow the free caps and counsel is comfortable with it.
