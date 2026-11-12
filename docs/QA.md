# Device QA checklist

Run on a real iPhone (TestFlight, [`RUN_ON_IOS.md`](RUN_ON_IOS.md)) and a low-end Android phone (Play internal testing, [`RUN_ON_ANDROID.md`](RUN_ON_ANDROID.md)) before each beta goes wider. Tick what passes; report the rest with the build number (TestFlight shows it under the app; on Android, the Play Store page → About this app → Version), the phone, and the table code or Player id where it applies. Two phones (or a phone and a second test account) make the online sections quicker.

Before you start: the server is deployed and its last deploy run passed the smoke test ([`DEPLOY.md`](DEPLOY.md)); both builds point at it (the build workflows refuse anything else); your account's Player id is in `TESTER_USER_IDS` for the store section.

## 1. Install and first run
- [ ] Both builds install from TestFlight / the Play internal testing link; the name, icon and splash are right; the version and build number match the run summary.
- [ ] First run: the age gate appears once; a birth year that makes the player younger than 18 is turned away with the year they may return; terms and privacy open (hosted pages once `EXPO_PUBLIC_TERMS_URL` / `EXPO_PUBLIC_PRIVACY_URL` are set, otherwise the DRAFT texts).
- [ ] Right after the age gate the app asks once about usage statistics and crash reports. Answer no: Settings → Privacy shows both switches off, and nothing reaches the analytics or crash dashboards from this phone. Answer yes on the other phone: both are on and can be switched off again.
- [ ] Boot with airplane mode on: Home, lessons and a game against bots work; no error screen.
- [ ] Settings → Account shows a Player id once the phone has been online.

## 2. Both languages
- [ ] A phone set to Traditional Chinese starts in 中文 (Taiwan wording); others start in English; Settings → Language switches at once, without a restart.
- [ ] In 中文, walk Home, the table, the result and fairness sheets, Clubs, the Shop and Settings: no English left over, no text cut off or overlapping. The table chrome keeps its English gloss in English ("Pong 碰") and has none in 中文.
- [ ] Repeat the online and store steps below at least once in each language.

## 3. Playing against bots
- [ ] 20 hands on each phone without a crash or a frozen table; every result reads **Verified**.
- [ ] Portrait and landscape, and rotating mid-hand; on a tablet all four orientations. Your own pond is never covered; safe areas and the keyboard never hide controls.
- [ ] Coach panel, hand review, daily puzzle, Puzzle Rush, drills each opened once; progress survives a force-quit.
- [ ] The table stays smooth while bots play on the Android phone.

## 4. Large tiles and text
- [ ] Settings → Display → Tile size **Extra large**: in portrait the hand wraps into rows and every tile can be tapped; in landscape the hand scrolls sideways; melds, ponds and the result sheet stay readable and nothing overlaps on the small phone.
- [ ] Text size Large: lessons and puzzles reflow without clipping.
- [ ] With the phone's own font size at its largest, Home, the table and Settings stay usable.

## 5. Screen readers
- [ ] iPhone with **VoiceOver**: every button on Home and the table has a spoken name; tiles are read by name in the current language (e.g. "三萬"); call-outs (碰, 槓, 胡) and banners are announced; you can discard a tile and claim a pong without sight.
- [ ] Android with **TalkBack**: the same.
- [ ] With Reduce Motion on (iOS Accessibility → Motion; Android Remove animations), tiles and celebrations do not animate.

## 6. Accounts
- [ ] The first online action creates a guest silently.
- [ ] Sign in with Apple (iPhone) and Google (both phones) work once their ids are set; signing in keeps the guest's clubs, diamonds and progress.
- [ ] Sign out, then sign back in: everything is still there.
- [ ] Delete account (Settings): with a live subscription the app shows it with a "Manage subscription" link and asks for an explicit confirmation; after deletion the account is gone and a fresh guest starts; in a club the deleted account was in, the member list and any finished season show "Deleted player" with the points unchanged.

## 7. Quick match
- [ ] Home → **Quick match** (behind the online guard: the age gate and terms first): the queue screen shows how many players have been found ("1 player found (you)"), the seconds waited, "Bots fill empty seats after 20 seconds" (then a countdown, "Bots join in … s") and a Cancel button. It shows no position in a queue.
- [ ] Alone: after about 20 s the table starts with you and clearly labelled bots, at default rules and Normal speed.
- [ ] Two phones queueing together land at the same table in arrival order, each in its own seat.
- [ ] Cancel leaves the queue at once; queueing again works.
- [ ] Block the other test account from its seat's report sheet (Block): the two accounts are never matched again, and the blocked player's emotes are hidden.
- [ ] An account whose birth year makes it under 18 cannot queue.
- [ ] The finished match does not show up in any club's standings.

## 8. Clubs and owner tools
- [ ] Without The Four Winds Club (store live): **New club** (Clubs screen) opens The Four Winds Club paywall. With it (or before the store is live): create a club; the house rules editor shows every rule, grouped; a preset sets a baseline without silently wiping your edits.
- [ ] The second phone joins by code (or a request the owner accepts or rejects). Member-opened tables always use the house rules; the owner can open a **variant** table, labelled "Variant · not ranked".
- [ ] At a club table only the opener or an admin can add bots or start.
- [ ] Owner tools: **Close table** (the match ends and counts for nothing); **Remove** a player from a table (a bot takes the seat and they cannot return to it); remove a member (they leave its live tables too); **Ban** and **Unban** (a banned player cannot join or rejoin); **Make owner** (you become an admin); leave; delete the club after typing its name.
- [ ] Standings count only non-variant matches with at least two human members.
- [ ] Share a club and a table link: on the other phone the link opens the app at that club or table (an `https://` link once `EXPO_PUBLIC_LINK_DOMAIN` is set).
- [ ] Lapsed plan (a sandbox subscription you let expire): a week later the club still works for members and you keep the admin tools, but the club can have only one open table and you cannot create another club.

## 9. Online tables: reconnect, restart and the fairness record
- [ ] Two phones at one table: clocks and time banks run; a bot plays when a clock runs out, with a note on your phone; both phones show **Verified**.
- [ ] Airplane mode for 30 s mid-hand: Reconnecting, then the same seat and the same hand; the hand ends **Verified** or, if the link dropped while the deal was being agreed, **Logged — the server could have picked this deal**, never failed.
- [ ] Force-quit the app mid-hand and relaunch: Resume returns to the same seat and hand. Open the fairness screen afterwards: the earlier hands keep their records and statuses (the app restart did not reset them), and the resumed hand verifies or shows Logged with its reason.
- [ ] Have the owner dispatch a deploy while a hand is in play: the table continues after the restart and its record is intact.
- [ ] The same account cannot take a second seat at one table from the other phone (a clear refusal, in both languages).

## 10. Leaving a table
- [ ] Leave table mid-hand: the confirmation sheet offers **Keep playing**, **Back to Home** and **Abandon table**. Keep playing returns to the hand; Back to Home keeps the Resume card on Home (online: a bot plays your seat meanwhile); Abandon gives up the seat for good (online) or ends the match (offline), and the Resume card goes.
- [ ] The Android back button at the table never abandons the seat: afterwards the Resume card is on Home and Resume returns to the same hand.

## 11. Store (sandbox, with a tester account)
- [ ] The Shop lists prices from your store region; subscription terms are shown before buying.
- [ ] Buy the smallest diamond pack: diamonds arrive within a minute; buy a cosmetic with them and equip it in Settings.
- [ ] Subscribe to Coach Gold monthly: Pro bots and unlimited Puzzle Rush unlock. Upgrade to The Four Winds Club: unlimited hand reviews and creating a club (**New club**) unlock.
- [ ] Fresh install (or the second phone) with the same store account and game account: **Restore purchases** brings the subscriptions back.
- [ ] Refund: iOS — App Store Connect sandbox or a StoreKit refund request; Android — Play Console → Order management → refund the test order. Within a few minutes the time the refunded charge paid for ends: refund the only charge and the plan ends (another plan you hold stays); refund an older charge after a renewal and the running period stays. A refunded pack takes its diamonds back (a negative balance blocks spending until it is topped up).
- [ ] A purchase on an account **not** in `TESTER_USER_IDS` grants nothing (sandbox purchases are recorded and ignored).

## 12. Audio
- [ ] Every call is audible, without overlap; the sound toggle works; the iPhone silent switch is respected.
