# Monetisation

**Principle:** we sell cosmetics, coaching and club ownership (joining and playing in clubs is free; creating and running one comes with The Four Winds Club). We never sell luck, information or time that other players at the table do not have. Everything below was designed against two reference businesses: PokerBros (club economy) and chess.com (learning subscriptions). Figures for those companies come from a research sweep that could only read search-engine extracts of the primary pages (the session's network policy blocked direct reads), so they are marked *reported* and must be re-verified from the live pricing pages before launch. Store-policy constraints come from Apple's own guidelines and are verified.

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

Decided for launch (plan Phase 4, updated by the owner on 9 Nov): we ship the subscriptions (Coach Gold and The Four Winds Club), diamonds and cosmetics. Joining and playing in clubs stays free and points-only; running a club is part of The Four Winds Club. No club chips or club economy until counsel has reviewed it in each launch market.

| PokerBros mechanic | Mahjong Mania at launch |
| --- | --- |
| Premium currency ladder | **Yes.** Diamonds at 60 per dollar tier, with the bonus on bigger packs stated exactly. |
| Club renewals by capacity | **No renewals by capacity.** Creating and running clubs (up to 3 owned clubs, 200 members each) comes with The Four Winds Club; members join and play free. If the plan lapses, after a 7-day grace the clubs keep working for members, the owner keeps the admin tools, no new club can be created and each club's open-table cap drops to 1 until the owner renews or hands the club over. |
| Owner-minted club chips | **No.** Standings are points only (open decision 1 settled: points-only). Points have no monetary value and cannot be redeemed or transferred. |
| Time banks for sale | **No.** The time bank is a table rule, identical for all seats. Selling time changes outcomes. |
| Insurance / run-it-twice analogues | **No.** Nothing that alters payouts. |
| Rabbit hunt | **Not at launch.** |
| VIP cards | **Not at launch.** Nothing a VIP card would bundle exists yet. |
| Offline protection behind VIP | **No: free for everyone.** Crash and disconnect resume is a core promise. |

| chess.com mechanic | Mahjong Mania at launch |
| --- | --- |
| Metered free taster | **Yes.** 1 full hand review a day, 1 Puzzle Rush a day; daily puzzle, drills, every lesson, Beginner and Club bots free. Meters reset at local midnight by the server's clock once the app has seen it. |
| Coaching tiers | **Two** (below): Coach Gold, and The Four Winds Club on top of it. A further tier waits until move-by-move explanations exist. |
| Family / club bundle | **Not at launch** (the old "Table Pass" granted one seat, not six). |
| Free clubs and club matches | **Yes, to join and play.** Running a club is The Four Winds Club. |
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

**Cosmetics** (owned for good; bought with diamonds only through `POST /api/wallet/spend`, so there is no cash price to undercut). Everything is drawn in code (`apps/mobile/src/monetisation/cosmetics.ts` and the components that draw it), with no coins, chips or money imagery anywhere. Players equip what they own in Settings → Looks. The three free felts (Classic, Deep Green, Midnight Blue) and the eight free emotes stay free.

The items add up to 13,900 diamonds, so even the 7,500 pack can be spent in full. A set costs about a fifth less than its items; a player who already owns some of a set pays only for the share still missing (`bundlePrice`, the same on the app and the server), and a complete set cannot be bought again.

| Product id | Title | Diamonds | Shelf | Contains |
| --- | --- | --- | --- | --- |
| `theme.nightmarket` | Night Market table | 300 | Table look |  |
| `theme.bamboo` | Bamboo Garden table | 300 | Table look |  |
| `theme.jade` | Jade Parlour table | 400 | Table look |  |
| `theme.imperial` | Imperial Red table | 300 | Table look |  |
| `theme.lantern` | Lantern Festival table | 450 | Table look |  |
| `theme.teahouse` | Teahouse table | 400 | Table look |  |
| `theme.oceanwave` | Ocean Wave table | 450 | Table look |  |
| `theme.plumblossom` | Plum Blossom table | 500 | Table look |  |
| `theme.cloud` | Lucky Clouds table | 450 | Table look |  |
| `theme.starlight` | Starlit Night table | 500 | Table look |  |
| `theme.porcelain` | Blue Porcelain table | 550 | Table look |  |
| `theme.dragonscale` | Dragon Scale table | 600 | Table look |  |
| `back.jade` | Polished Jade tile back | 250 | Tile back |  |
| `back.crimson` | Crimson Knot tile back | 250 | Tile back |  |
| `back.midnight` | Midnight Star tile back | 250 | Tile back |  |
| `back.lotus` | Lotus Pond tile back | 300 | Tile back |  |
| `back.bamboo` | Bamboo Grove tile back | 250 | Tile back |  |
| `back.wave` | Ocean Wave tile back | 300 | Tile back |  |
| `back.cloud` | Lucky Cloud tile back | 300 | Tile back |  |
| `back.lattice` | Teahouse Lattice tile back | 300 | Tile back |  |
| `back.sunset` | Sunset Rays tile back | 250 | Tile back |  |
| `back.dragon` | Dragon Scale tile back | 400 | Tile back |  |
| `frame.bamboo` | Bamboo Ring frame | 150 | Avatar frame |  |
| `frame.jade` | Jade Bangle frame | 200 | Avatar frame |  |
| `frame.gilded` | Gilded Ring frame | 250 | Avatar frame |  |
| `frame.blossom` | Plum Blossom frame | 200 | Avatar frame |  |
| `frame.wave` | Rolling Waves frame | 200 | Avatar frame |  |
| `frame.cloud` | Lucky Clouds frame | 200 | Avatar frame |  |
| `frame.flame` | Hot Streak frame | 250 | Avatar frame |  |
| `frame.star` | Starlight frame | 250 | Avatar frame |  |
| `frame.lantern` | Lantern Glow frame | 250 | Avatar frame |  |
| `frame.dragon` | Jade Dragon frame | 350 | Avatar frame |  |
| `frame.phoenix` | Phoenix Feather frame | 350 | Avatar frame |  |
| `frame.rainbow` | Rainbow Ribbon frame | 300 | Avatar frame |  |
| `emotes.teahouse` | Tea House emotes | 250 | Emote pack (6) |  |
| `emotes.nightmarket` | Night Market emotes | 250 | Emote pack (6) |  |
| `emotes.festival` | Festival emotes | 250 | Emote pack (6) |  |
| `emotes.zodiac` | Zodiac emotes | 300 | Emote pack (6) |  |
| `win.fireworks` | Fireworks win | 400 | Win celebration |  |
| `win.lanterns` | Sky Lanterns win | 450 | Win celebration |  |
| `win.dragon` | Dragon Dance win | 600 | Win celebration |  |
| `win.petals` | Blossom Shower win | 400 | Win celebration |  |
| `bundle.nightmarket` | Night Market set | 850 | Set | `theme.nightmarket`, `back.midnight`, `frame.lantern`, `emotes.nightmarket` |
| `bundle.festival` | Lantern Festival set | 1,300 | Set | `theme.lantern`, `back.crimson`, `frame.flame`, `emotes.festival`, `win.lanterns` |
| `bundle.dragon` | Dragon set | 1,750 | Set | `theme.dragonscale`, `back.dragon`, `frame.dragon`, `emotes.zodiac`, `win.dragon` |
| `bundle.garden` | Blossom Garden set | 1,100 | Set | `theme.plumblossom`, `back.lotus`, `frame.blossom`, `win.petals` |

**Subscriptions** (auto-renewing, cross-device through the account; Google Play: subscriptions `coach.gold` and `fourwinds`, each with base plans `month` and `year`; RevenueCat entitlements `gold` and `fourwinds`):

| Plan | Store ids | Monthly | Yearly | What it unlocks today |
| --- | --- | --- | --- | --- |
| Free | | | | Coach at bot tables, daily puzzle, drills, every lesson, 1 hand review and 1 Puzzle Rush a day, Beginner and Club bots, joining and playing in any club |
| Coach Gold | `coach.gold.month`, `coach.gold.year` | $6.99 | $49.99 | Pro bots, unlimited Puzzle Rush |
| The Four Winds Club (四風俱樂部) | `fourwinds.month`, `fourwinds.year` | $10.99 | $79.99 | Everything in Coach Gold, unlimited hand reviews, and creating and running clubs (up to 3 owned clubs) |

Each plan is its own entitlement on the server (`coach.gold.month`, `fourwinds.year`, …): refunding or expiring one plan never ends another, and the player's tier is the best plan still live. Joining and playing in clubs stays free; only creating and running a club needs The Four Winds Club (the server checks it through `WalletService.hasFourWinds`). If it lapses, after a 7-day grace the clubs keep working for their members and the owner keeps the admin tools, but no new club can be created and each club's open-table cap drops to 1 until the owner renews or hands the club over.

The Shop copy lists only these unlocks. Removed until built: Coach Diamond, Table Pass, zodiac avatars, VIP cards and club capacity tiers. Trials and introductory offers are set in the stores, not in the app.

**Builds without keys.** With no `EXPO_PUBLIC_REVENUECAT_IOS_KEY` / `_ANDROID_KEY` the Shop says "Store unavailable on this build", shows no prices and grants nothing; looks can still be bought with diamonds the server already holds. A build with keys does the same ("Store unavailable") when the server reports `storeEnabled: false`.

**Server rules.** Sandbox purchases grant only to accounts in `TESTER_USER_IDS`. A refunded diamond pack takes back everything it credited, even when that leaves purchased diamonds below zero; no spend goes through until a purchase covers it. Restore asks the server to reconcile with RevenueCat (`REVENUECAT_SECRET_KEY`), which also runs nightly for accounts with recent store activity; support can grant diamonds or a plan with `POST /api/admin/grant` (`ADMIN_TOKEN`). Server analytics only for players whose analytics choice is yes. `EXPO_PUBLIC_STORE_MODE=mock` gives a development build an instant, free test store whose grants live only on the device until the next sync; a release build cannot select it.

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
