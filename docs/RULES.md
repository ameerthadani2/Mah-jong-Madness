# Taiwanese 16-tile Mahjong — rules as implemented

## Flow

* 144 tiles; each player holds 16, the dealer draws a 17th to start. Winning hand = 5 sets + 1 pair.
* Bonus tiles (梅蘭竹菊春夏秋冬) are set aside on draw and replaced from the back of the wall.
* The last 16 tiles are never drawn (configurable). If nobody wins by then: 流局, dealer keeps the deal (configurable).
* On a discard: 胡 > 碰/槓 > 吃. Chi only by the next player (and only when 吃 is allowed: see Rule options). If two can win, the nearest in turn order wins (or all, if 一炮多響 is on). With 過水 on, a player who passes a discard they could have won on cannot win on a discard until their own next draw.
* Kongs: 暗槓 (4 in hand), 明槓 (3 in hand + discard), 加槓 (add to your pong). Each draws a replacement from the back. 加槓 can be robbed (搶槓).
* A 暗槓 or 加槓 is declared only on a turn in which you drew a tile: from the wall, from the deal (the dealer's first turn) or as a kong replacement. A turn that began with a 吃 or 碰 ends with a discard and offers no kong; the kong can be declared on a later turn, after a draw. A kong also needs a replacement tile left to draw.
* Dealer keeps the deal after winning or a drawn hand; otherwise the deal passes. After 4 passes the prevailing wind advances. A match defaults to 16 dealer rotations (一將, 4 winds).

## Payment

`points = 底 + 台 × 台值` (default 底100 / 台20).
* 自摸: each of the three others pays.
* 放槍: only the discarder pays.
* Dealer 台 (1) and streak 台 (2 per 連莊) apply to any payment the dealer is part of.
* `maxTai` (封頂) caps the hand's own 台; dealer and streak 台 are added after the cap, so a capped hand still pays the dealer bonus.

## 台 table

| 台 | Key | Name | Condition |
| --- | --- | --- | --- |
| 1 | `self_draw` | 自摸 | Win on own draw |
| 1 | `concealed` | 門清 | No exposed sets (concealed kongs allowed), won by discard |
| 3 | `concealed_self_draw` | 門清自摸 | Concealed and self-drawn (replaces the two above) |
| 1 | `single_wait` | 獨聽 | Exactly one live kind completes the hand (a kind is dead when your own concealed tiles and melds hold all four copies); not with 全求人/半求人 or a limit deal |
| 2 | `all_chows` | 平胡 | 5 chows, non-honour pair, no flowers, not self-drawn, and the winning tile completes a two-sided (兩面) chow: no 單騎/嵌張/邊張 |
| 4 | `all_pongs` | 碰碰胡 | 5 pongs/kongs; absorbed by 字一色 |
| 4 | `half_flush` | 混一色 | One suit + honors |
| 8 | `full_flush` | 清一色 | One suit only |
| 16 | `all_honors` | 字一色 | Honors only |
| 4 | `small_three_dragons` | 小三元 | 2 dragon pongs + dragon pair (dragon pongs still score) |
| 8 | `big_three_dragons` | 大三元 | 3 dragon pongs (individual dragon 台 not added) |
| 8 | `small_four_winds` | 小四喜 | 3 wind pongs + wind pair |
| 16 | `big_four_winds` | 大四喜 | 4 wind pongs |
| 2/5/8 | `three/four/five_concealed` | 三/四/五暗刻 | Concealed pongs (a pong completed by the winning discard is not concealed) |
| 1 | `dragon_*` | 中 / 發 / 白 | Each dragon pong |
| 1 | `seat_wind` | 門風 | Pong of your seat wind |
| 1 | `round_wind` | 圈風 | Pong of the prevailing wind |
| 1 | `seat_flower` / `seat_season` | 正花 | Bonus tile matching your seat (東1 南2 西3 北4) |
| 2 | `four_flowers` / `four_seasons` | 花槓 | All four of a bonus set |
| 8 | `eight_flowers` | 八仙過海 | Instant win the moment you bank all eight bonus tiles (at the deal or mid-hand); paid as 自摸 |
| 8 | `seven_rob` | 七搶一 | Holding seven bonus tiles, you take the eighth when another seat banks it; only that seat pays |
| 2 | `full_begging` | 全求人 | Five exposed sets (a concealed kong does not count), won on a discard for the pair; absorbs 獨聽 |
| 1 | `half_begging` | 半求人 | Five exposed sets, self-drawn pair; absorbs 獨聽, stacks with 自摸 |
| 1 | `after_kong` | 槓上開花 | Win on a kong replacement tile (a flower drawn as the replacement still counts as 槓上開花) |
| 1 | `after_flower` | 花上自摸 | Win on a flower replacement tile |
| 1 | `rob_kong` | 搶槓 | Win on a tile added to a pong |
| 1 | `last_tile_draw` / `last_tile_discard` | 海底撈月 / 河底撈魚 | Last drawable tile / its discard (the 河底 discard can only be won on, not called) |
| 24 / 16 / 16 | `tianhu` / `dihu` / `renhu` | 天胡 / 地胡 / 人胡 | 天胡: the dealer wins on the deal itself (the 17 tiles dealt, before any call). 地胡: a non-dealer wins by self-draw on their first draw. 人胡: a non-dealer who has not yet drawn wins on the dealer's first discard. Any call made by anyone earlier in the hand voids 地胡 and 人胡: a 吃, a 碰 or a kong of any kind, a 暗槓 included (so a dealer who declares a 暗槓 before the first discard ends both, and a win on the replacement tile is 槓上開花, not 天胡). Values come from `heavenlyTai` / `earthlyTai` / `humanlyTai` (0 turns one off). A limit deal absorbs 門清/自摸/門清自摸, 獨聽, 平胡, 槓上開花/花上自摸 and 海底/河底; pattern hands, value pongs, flowers and dealer 台 still add |
| 1 | `dealer` | 莊家 | Dealer involved in the payment |
| 2×n | `dealer_streak` | 連n拉n | Dealer streak |
| 1 | `no_flowers` | 無花 | Optional, off by default |

Not implemented (by design, uncommon in 16-tile): 七對子, 十三么, 一條龍, 三色同順 — see the roadmap for optional variants. 嚦咕嚦咕 (the seven-pairs-and-a-triplet hand some tables play) is not supported either: a hand must be five sets and a pair.

## Rule options

Every table plays one `RuleSet` (`packages/engine/src/rules.ts`). The defaults below are `DEFAULT_RULES`; the ranges are `RULE_LIMITS`. Rules that arrive from outside (a club's saved rules, a create-table request) pass through `sanitizeRules`: unknown keys are dropped, numbers are truncated and clamped to the range, and anything else keeps the default. The house-rule editor in the app (Settings, and a club's rules) offers the options players argue about (底 and 台, the cap, the dead wall, the match length, speed and the on/off rules); the 台 of each pattern in the table above is fixed in `scoring.ts`.

| Key | Default | Range | Meaning |
| --- | --- | --- | --- |
| `basePoints` | 100 | 0 to 5,000 | 底: points per payment before 台 |
| `taiPoints` | 20 | 0 to 2,000 | Points per 台 |
| `maxTai` | 0 | 0 to 64 | 封頂: cap on the hand's own 台; 0 means no cap (dealer and streak 台 are added after it) |
| `deadWallSize` | 16 | 0 to 32 | Tiles left undrawn at the end of the wall; the hand is a 流局 when only these remain |
| `dealerTai` | 1 | 0 to 8 | 莊家 台 on any payment the dealer is part of |
| `dealerStreakTai` | 2 | 0 to 8 | Extra 台 per consecutive dealer hand (連N拉N) |
| `drawKeepsDealer` | on | on / off | A 流局 keeps the dealer and adds to the streak |
| `allowChi` | on | on / off | 吃 from the player on your left; off means no chi at all |
| `multipleWinners` | off | on / off | 一炮多響: everyone who can win on a discard wins; off, the nearest in turn order does |
| `passRule` | off | on / off | 過水: after passing a discard you could have won on, no win on a discard until you draw again |
| `noFlowerTai` | off | on / off | Score 無花 as 1 台 |
| `handsPerMatch` | 16 | 1 to 64 | Dealer rotations in a match (16 is one 將: four winds of four dealers; 連莊 hands do not count) |
| `speed` | `normal` | `relaxed`, `normal`, `fast`, `turbo`, `hyper` | A named clock preset: 30 s + 60 s bank, 15 + 30, 10 + 20, 7 + 10, 4 + 0 |
| `turnSeconds` | 15 | 3 to 120 | Seconds for each action before the time bank starts |
| `timeBankSeconds` | 30 | 0 to 300 | Extra seconds a player may spend across a hand once the turn clock has run out |
| `startingPoints` | 0 | 0 to 1,000,000 | Points each player starts a match with (display and club standings only) |
| `heavenlyTai` | 24 | 0 to 64 | 台 for 天胡; 0 switches it off (the win is then scored on its own items) |
| `earthlyTai` | 16 | 0 to 64 | 台 for 地胡; 0 switches it off |
| `humanlyTai` | 16 | 0 to 64 | 台 for 人胡; 0 switches it off |
