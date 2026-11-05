# Monetisation

**Principle:** we sell convenience, cosmetics, coaching and club capacity. We never sell luck, information or time that other players at the table do not have. Everything below was designed against two reference businesses: PokerBros (club economy) and chess.com (learning subscriptions). Figures for those companies come from a research sweep that could only read search-engine extracts of the primary pages (the session's network policy blocked direct reads), so they are marked *reported* and must be re-verified from the live pricing pages before launch. Store-policy constraints come from Apple's own guidelines and are verified.

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

| PokerBros mechanic | Mahjong Madness |
| --- | --- |
| Premium currency ladder | **Yes.** Diamonds at ~60/USD anchor with bonus on big packs. |
| Club renewals by capacity | **Yes.** Free Starter club; paid capacity tiers, payable in Diamonds or as a subscription. |
| Owner-minted club chips | **Yes, as in-game allocation only.** Chips are per-club, non-transferable between players, never redeemable, never expire if purchased. No agent ledgers, settlement tabs or cash-equivalent naming. |
| Time banks for sale | **No.** Time bank is a table rule, identical for all seats. Selling time changes outcomes. |
| Insurance / run-it-twice analogues | **No.** Nothing that alters payouts. |
| Rabbit hunt (reveal what you would have drawn) | **Yes, post-hand only**, as a cosmetic/curiosity item — the full wall is already in the audit. |
| VIP cards | **Yes**, prepaid non-renewing bundles of cosmetics, emotes, extra club slot, review credits. |
| Offline protection behind VIP | **No — free for everyone.** Crash/disconnect resume is a core promise. |

| chess.com mechanic | Mahjong Madness |
| --- | --- |
| Metered free taster | **Yes.** 1 full hand review/day, 1 Puzzle Rush/day, daily puzzle free, drills free, first two bot levels free. |
| Three coaching tiers | **Yes** (below). |
| Family bundle | **Yes**: Table Pass, 6 seats of the top tier for a club at a steep discount. |
| Free clubs and club matches | **Yes.** Members never pay to play in a club. |
| Celebrity coach personas | Later: coach voice/persona packs as cosmetics. |

## Catalogue (implemented in `apps/mobile/src/monetisation/catalog.ts`)

**Diamonds** (consumable, never expire): 60 / $0.99 · 300 / $4.99 · 600 / $9.99 · 1,300 / $19.99 · 3,450 (+15%) / $49.99 · 7,500 (+25%) / $99.99.

**Coach subscriptions** (auto-renewing, 7-day trial, cross-device):

| Tier | Monthly | Yearly | Adds |
| --- | --- | --- | --- |
| Free | — | — | Coach at the table, daily puzzle, drills, lessons 1–3, 1 hand review/day, 1 Puzzle Rush/day, Beginner and Club bots |
| Coach Gold | $6.99 | $49.99 | No ads (if ever added), all lessons, unlimited Puzzle Rush, Pro bots, review history |
| Coach Platinum | $10.99 | $79.99 | Unlimited hand reviews, puzzle battles vs friends, luck statistics dashboard |
| Coach Diamond | $16.99 | $119.99 | Move-by-move coach explanations in review, insights, club-table discounts |
| Table Pass | — | $199.99 | Coach Diamond for 6 named club members |

**Club capacity** (30-day, Diamonds or subscription): Starter free (30 members, 2 managers, 1 live table) · Club 100: 1,300💎 or $19.99 · Club 300: 3,000💎 or $49.99 · Club 1,000: 8,000💎 or $129.99. Clubs that lapse get a 14-day grace period, then tables close but data is kept.

**Cosmetics** (direct purchase, no loot boxes): table looks 300💎 / $2.99, avatar packs 500💎 / $4.99, emote packs 200💎 / $1.99, seasonal drops (農曆新年, 中秋) as limited direct-purchase sets.

**VIP cards** (prepaid, non-renewing): Bronze 30d 300💎, Silver 90d 800💎, Gold 365d 2,500💎 — all table looks for the period, emote allowance, +1 club creation slot, 1 extra review/day.

**Club chips**: owner mints from Diamonds at 2.5💎 per 100 chips (configurable server-side). Chips are an allocation to the club's bankroll; standings are kept in points regardless.

## Compliance guardrails (see `docs/STORE_COMPLIANCE.md`)
* Chips and Diamonds have no monetary value, are non-redeemable and are never transferable between players. Purchased currency never expires; free daily grants live on a separate expiring ledger.
* No loot boxes. If a randomised item is ever added, odds are disclosed before purchase.
* Club-run events award only in-game items. Any real-prize event is run solely by the company with official rules in-app.
* Age rating answers: Simulated Gambling = Frequent → expect 17+/18+. Metadata stays 4+-appropriate.
* Restore Purchases for every non-consumable; identical SKUs on every platform where they are usable.

## Revenue model sketch (for planning only)
Assume 10,000 monthly actives after a Taiwan + diaspora launch. If 3% subscribe at a blended $9/month (≈ $2.7k), 1% of actives own or admin a paid club at a blended $35/month (≈ $3.5k), and cosmetics/Diamonds average $0.40 per active (≈ $4k), monthly gross is ≈ $10k before store fees (30%, 15% under the Small Business Program, 26% on the Taiwan storefront from 31 Oct 2026). The club layer is the lever: every paid club brings 30–300 players who are also prospects for coaching and cosmetics.

## Open decisions
1. Whether to allow owner-minted club chips at all at launch, or ship points-only standings first and add chips once legal review per launch market is done.
2. Regional price tiers (Taiwan, Hong Kong, Singapore, Malaysia, US, Australia, UK/EU) — use store tiering, not flat USD.
3. Ads: none planned. Revisit only if free-tier costs demand it, and then rewarded-only with a permanent No-Ads SKU.
