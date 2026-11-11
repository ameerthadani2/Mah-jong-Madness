# Game server API (accounts, sessions, tables)

The contract between the app and `apps/signal`. The server side is implemented by `apps/signal/src/auth/*` and `src/repos/*` (Phase 3 foundations) and wired into `server.ts` / `api.ts` / `rooms.ts`; the app side lives in `apps/mobile/src/auth/*`. Everything here works with the in-memory repositories when no database is configured, so the contract holds in development and in tests.

## Conventions

- JSON bodies and responses; `Content-Type: application/json`.
- Errors: `{ "error": "<code>", "message": "<English sentence>" }` with the HTTP status below. `message` is for logs; the app maps `error` codes to translated copy (`errors.*`).
- Authentication: `Authorization: Bearer mjs_<64 hex>` on every `/api/*` route except `/health`, `/api/config` and the `/api/auth/guest*` bootstrap routes. A WebSocket connection authenticates with its first frame `{ "t": "hello", "auth": "<token>" }`.
- Rate limits: per IP (HTTP 10/s burst 30; auth routes 5/min) and per user (auth routes 5/min; a failed guest sign-in counts against the calling IP and the named user id together, never against the user's own bucket, so a stranger who knows a user id cannot lock that user out). Reports: 10 a day per user and 30 a day per IP. Exceeding one returns `429 { "error": "rate_limited" }` (auth routes add `retry-after: 12`).

| `error` code | Status | Meaning |
| --- | --- | --- |
| `invalid` | 400 | Malformed body or unknown provider |
| `invalid_credentials` | 401 | Guest id or secret does not match |
| `invalid_session` / `session_expired` / `session_revoked` / `session_rotated` | 401 | The bearer token is not usable; the app should refresh or bootstrap again |
| `invalid_token` | 401 | The provider token failed verification |
| `unauthorised` | 401 | The RevenueCat webhook secret is missing or wrong |
| `forbidden` | 403 | The caller may not do this: not a member, not an owner or admin, not the user whose data is asked for |
| `provider_disabled` | 404 | That sign-in method is not configured on this server (`GET /api/config.authProviders` lists the enabled ones) |
| `not_linked` | 404 | `login` for a provider identity that has no account; offer "attach to this guest" |
| `not_found` | 404 | No such user, identity, club or route |
| `identity_in_use` | 409 | The identity already belongs to another account that also has a provider |
| `last_identity` | 409 | Cannot unlink the only sign-in method |
| `limit` | 409 | A club cap was hit |
| `rate_limited` | 429 | Too many requests |
| `unavailable` | 503 | The server is at capacity (tables) or a dependency is down |
| `internal` | 500 | An unexpected error; nothing was applied, retry later |

## Configuration

`GET /api/config` → `{ "authProviders": ["apple","google"], "storeEnabled": false, "pushEnabled": false, "minBuild": 0, "maintenance": null | "<message>", "serverNow": "<ISO>" }`. No auth. The app reads it at launch and on foreground; absent features are hidden.

## Guest accounts

`POST /api/auth/guest` body `{ "device": { "id": "<uuid>", "platform": "ios"|"android"|"web", "appBuild": "<string>", "locale": "en"|"zh-TW" }, "displayName"?: string, "avatar"?: string }`
→ `201 { "userId": "<uuid>", "guestSecret": "<64 hex>", "session": { "token": "mjs_…", "expiresAt": "<ISO>" }, "user": User }`.
The app stores `userId` and `guestSecret` in secure storage; they are the only way back into a guest account on a new install.

`POST /api/auth/guest/login` body `{ "userId", "guestSecret", "device" }` → `200 { "session", "user" }` or `401 invalid_credentials`. Five failed attempts a minute from one IP for one user id answer `429`; the user's own auth bucket is spent only once the secret has been proven. Linking a provider replaces the guest secret (see the `guestSecret` field of `POST /api/auth/link`); the old one then stops working.

## Sessions

- Tokens are opaque; the server stores a peppered hash. Sliding expiry of 30 days.
- `POST /api/auth/refresh` (bearer) → `200 { "session": { "token", "expiresAt" } }`. The old token stays valid for 5 minutes. The app refreshes once a day and on `session_expired`.
- `POST /api/auth/logout` (bearer) → `204`. Revokes this session only, removes the push token from this session's device (the phone is no longer this account's) and closes the table socket this session opened with `4401`.
- `GET /api/me` (bearer) → `{ "user": User, "wallet": { "diamonds", "bonusDiamonds" }, "entitlements": [{ "entitlement", "expiresAt" }], "identities": [{ "provider", "email"? }], "serverNow" }`.
- `PATCH /api/me` (bearer) body `{ "displayName"?, "avatar"?, "locale"?, "birthYear"?, "analyticsConsent"?: true|false|null }` → `{ "user": User }`. `analyticsConsent` is the player's product-analytics choice; server-side events (`purchase_credited`, `report_filed`) are sent only for players who chose `true`.
- `DELETE /api/me` (bearer) → `204`. Soft-deletes the account: the profile is scrubbed at once, every session is revoked and every table socket of the account is closed with `4401`, identities and devices (with their push tokens) go, club rows become "Deleted player" (a club the user owned passes to its senior admin, else its earliest member, and is dissolved when nobody else is in it), and an hourly job hard-deletes the row 30 days later. Purchase records, the wallet ledger and reports are kept.

`User` = `{ "id", "kind": "guest"|"account", "displayName", "avatar", "locale", "birthYear": number|null, "createdAt" }`.

## Provider sign-in (Sign in with Apple, Google, optional Facebook)

The app obtains an identity token from the provider SDK with a fresh `nonce` (the raw nonce is sent to the server; the SHA-256 of it was given to the provider), then:

- `POST /api/auth/link` (bearer) body `{ "provider": "apple"|"google"|"facebook", "token": "<id token>", "nonce": "<raw nonce>", "email"?: string }` — attaches the identity to the current account (merge rules below) → `200 { "session", "user", "merged": boolean, "guestSecret"?: "<64 hex>" }`. When `merged` is true the device has been moved onto the existing account and must replace its stored session. When `guestSecret` is present (rule 1, for a user who had one) the guest secret has been rotated: the device must store this one in place of the old, which no longer signs in; no other device receives it.
- `POST /api/auth/login` body `{ "provider", "token", "nonce", "device" }` (no bearer, or a guest bearer) → `200 { "session", "user" }` or `404 not_linked`.
- `nonce` is required on both: a request without one is `400 invalid`, and a token whose nonce claim is missing or differs is `401 invalid_token`.
- `DELETE /api/auth/identities/:provider` (bearer) → `204` or `409 last_identity`.

Merge rules: (1) identity unlinked → linked to the current user, who becomes `kind: "account"`; the user's other sessions (and their table sockets) end and the guest secret is rotated; (2) identity belongs to V and the current user is a guest → the guest is merged into V (progress, wallet, purchases, club memberships, devices and reports move; the guest's sessions are revoked and its sockets closed with `4401`) and the device receives a V session; (3) identity belongs to V and the current user already has a provider → `409 identity_in_use`; (4) unlink only while another provider remains.

## WebSocket (tables)

1. First frame: `{ "t": "hello", "auth": "<token>" }`. The server verifies it before assigning a peer id and replies `{ "t": "hello", "id": "<peer id>", "userId": "<uuid>" }`. A missing or bad token closes the socket with `4401`.
2. `{ "t": "create", "hosted": true, "rules"?, "botSkill"?, "club"?: "<club code>" }` → `{ "t": "room", "room", "host", "peers" }` or `{ "t": "error", "code"?, "message" }`. Club tables require membership (`403`-style error frame `Join the club first`).
3. `{ "t": "join", "room" }` → `room` or `error`. `{ "t": "error", "code": "room_unavailable", "message": "Room not found or full" }` is definitive (the table is over, was reaped, or is full): stop reconnecting to it. The table host binds the verified `userId` to the seat; the client's `join` frame to the table carries its name, avatar and rejoin token as before.
4. Reconnect: on socket close the app retries with backoff 1, 2, 4, 8 … 60 s, re-sends `hello` + `join` with the same rejoin token, and shows "Reconnecting". The server keeps a seat for 15 minutes of inactivity.
5. The session is checked again before every `create`, `join` and `queue`, and a session that ends while the socket is open (logout, `DELETE /api/me`, a merge, a link ending the account's other sessions, a revocation or expiry) closes the socket with `4401`. The seat stays reclaimable: obtain the current session (refresh, or sign in again), then reconnect with `hello` + `join` and the rejoin token. A token that was refreshed more than 5 minutes ago is treated the same way at the next `create` or `join`.

6. A banned account is refused at `hello` and at each recheck with close code `4403` (not `4401`: signing in again will not help), and a moderator's ban closes its open sockets with `4403` at once.

### Quick match (WebSocket)

Plan decision 3: instant seating with strangers. Any signed-in account may queue, guests included, provided it is not banned and the server holds a birth year that makes it 17 or older (the app sends it with `PATCH /api/me` after the age gate; the age counts as `currentYear - birthYear - 1`).

- `{ "t": "queue", "preset"?: "normal" }` → at once and every 2 s while waiting: `{ "t": "queue_status", "position": 1, "waitedMs": 4000, "humans": 2, "fillMs": 20000 }` (`humans`: players in the group this one would be seated with now, itself included), then `{ "t": "matched", "room": "QM2345", "humans": 2, "bots": 2 }`. Join the room with `{t:"join", room}` and the table `join` as usual; reconnects use the rejoin token like any table.
- `{ "t": "leave_queue" }` → `{ "t": "queue_left" }`. Closing the socket, or a `create`/`join`, also leaves.
- Refusals: `{ "t": "queue_error", "code", "message" }` with `code` `banned`, `age_required` (no birth year on the server, or under 17), `rate_limited` (the same per-account and per-address allowance as `join`), `sign_in` (a socket without an account), `unavailable` (try again), or `replaced` (the same account queued from another socket, which keeps this one's place in line).

Grouping: arrival order, four to a table; two accounts where either blocked the other are never in one group. A group of four is seated at once; a group of one to three is seated with Club bots in the empty seats once its first player has waited `QUICK_MATCH_FILL_MS` (default 20,000 ms). The table uses the default rules at Normal speed with Club bots, only the matched accounts may enter it (anyone else gets `room_unavailable`, onlookers included), no player may `start` it or `add_bot`, it counts against nobody's `MAX_TABLES_PER_USER`, it is never a club table and never counts toward club standings. It starts by itself once every matched player holds a seat, or 15 s after it opened with bots in the seats of anyone who did not come (with nobody there it closes).

## Blocks

Bearer. A blocked player's chat lines and emotes are hidden by the app at a table, and quick match never seats the two together (in either direction). Blocks move to the surviving account on a merge and go with an account deletion.

- `GET /api/blocks` → `{ "blocks": [{ "userId", "displayName", "avatar", "createdAt" }] }`, newest first.
- `POST /api/blocks { "userId" }` → `201` (or `200` when already blocked) with the same fields. `400 invalid` (missing, malformed, yourself), `404 not_found` (no such player), `409 limit` (500 blocks).
- `DELETE /api/blocks/:userId` → `204`.

## Moderation (`Authorization: Bearer <ADMIN_TOKEN>`)

Compared in constant time. Without `ADMIN_TOKEN` every route here answers `503 unavailable`; a wrong token `401 unauthorised`.

- `GET /api/admin/reports?status=open&limit=100` → `{ "reports": [{ "id", "status", "reason", "details", "room", "createdAt", "reporter": Account, "reported": Account }] }`, oldest first. `status` is `open` (default), `actioned` or `dismissed`. `Account` is `{ "id", "kind", "displayName", "deleted", "bannedAt", "banReason", "mutedUntil" }`.
- `POST /api/admin/reports/:id/resolve { "action": "dismiss" | "warn" | "ban" | "mute", "days"?, "reason"? }` → `{ "ok": true, "id", "status", "action", "mutedUntil"? }`. `dismiss` leaves the report `dismissed`; the others `actioned`. `ban` bans the reported account (as below), `mute` mutes it for `days` (1 to 365, required), `warn` only records the decision. `409 resolved` for a report already closed, `404 not_found`.
- `POST /api/admin/users/:id/ban { "reason"? }` → `{ "ok": true, "account": Account }`. Every session of the account is revoked, its sockets close with `4403`, it leaves the quick-match queue, and from then on sign-in (`/api/auth/guest/login`, `/api/auth/login`), `/api/auth/refresh` and every bearer route answer `403 banned`. `DELETE` on the same path lifts the ban (the old sessions stay ended; the player signs in again).
- `POST /api/admin/users/:id/mute { "days" }` → `{ "ok": true, "account": Account }`. `days` 1 to 365; `0` lifts the mute. A muted account's chat lines and emotes are dropped at every table until it ends.

## Names

Display names (`POST /api/auth/guest`, `PATCH /api/me`) and club names (`POST /api/clubs`, `PATCH /api/clubs/:code`) are cleaned (`cleanText`) and then checked against a small English and Chinese blocklist: slurs and profanity, and names that pose as staff (admin, moderator, official, staff, support, GM, 官方, 管理員, 客服 and the like, also with digits or symbols for letters). A refused name answers `400 { "error": "name_not_allowed" }`. Words that only contain a blocked one (Badminton, Stafford, Scunthorpe) pass.

## Clubs

All `/api/clubs*` routes take the bearer session (the caller's user id is the member id; name and avatar come from the user record); member lists and standings are members-only; non-members get the public view `{ code, name, description, memberCount, joinRequiresApproval }`. `Club` (members' view) is `{ code, name, description, ownerId, createdAt, rules, settings: { membersCanOpenTables, joinRequiresApproval, botSkill: "beginner"|"club"|"pro" }, members: [{ userId, name, avatar?, role: "owner"|"admin"|"member", joinedAt, points, seasonPoints, matchesPlayed, matchesWon, handsWon }], pending: [{ userId, name, avatar?, requestedAt }], tables: [{ code, label, rules, createdBy, createdAt, status: "open"|"playing"|"finished", players: [{ seat, name, userId?, isBot, connected }], handNumber, scores, variant, startedWith? }], season, seasonStartedAt, seasons, ownerLapsedAt, bans? }`. `rules` is a rule set as in `@mjm/engine` (`sanitizeRules` applies); `settings` and `rules` are partial on input. `bans` (`[{ userId, name, bannedAt, by }]`) is in the owner's and admins' view only. `ownerLapsedAt` (ms or null) is when the server saw the owner's Four Winds Club plan lapse (or stop covering this club). A table's `startedWith` (`[{ seat, userId }]`) lists the club members seated when its match began. The server's own records (standings kept for members who left, the file of owner lapses) are never part of any view.

**House rules.** A table a plain member opens always plays the club's `rules` with the club's `settings.botSkill` (default `club`); any `rules` or `botSkill` in the request is ignored, on the API and on the WebSocket `create`. The owner and admins may send other `rules`: the table is then a **variant** (`variant: true` in the listing) and never counts toward the standings. Every club table uses the club's bot skill.

**Standings** move only for a finished match at a non-variant table that started with at least two different human club members seated and no account in two seats. A member alone against bots, or with a non-member, scores nothing. A match counts by the members seated when it started (`startedWith`, written when play begins): each of them is charged or credited their seat's result at the end, even if they have left the club, been removed or banned, or been taken off the table since (a bot finishes for them), so leaving before the end neither voids the others' result nor spares the leaver theirs.

**Leaving and rejoining.** A member who leaves, or is removed or banned, keeps their standings on file: they disappear from the standings and from every view, and are added back to the member's row if the account rejoins (through `join` or an approval). Season points return only while the season they were scored in is still running; all-time points and match counts always return. The file follows the account through an account merge and goes when the account is purged (30 days after it is deleted) or the club is deleted. Nothing is filed for an account with no results.

**Join requests.** A new member or join request made through `POST /api/clubs/:code/join` is charged to the client address (10 an hour across all clubs) and to the club (60 an hour): `429 rate_limited` when either has run out. Asking again while already a member, or already waiting, costs nothing. A request nobody answers is dropped 30 days after `requestedAt` (hourly, and whenever someone asks to join that club); the account may ask again. The owner and admins can turn down the whole queue with `POST /api/clubs/:code/pending/reject-all`, which also gives the club its hourly allowance back.

**Who controls a table.** At a club table only its opener and the club's owner and admins (as the club says at that moment) may add bots or start the match; at a private hosted table only its creator. Anyone else seated gets `{t:"error", code:"not_controller"}` from the table, unless no controller is connected at the table.

**The Four Winds Club (decision 5).** While the store is live (`storeEnabled` in `/api/config`), `POST /api/clubs` needs The Four Winds Club: `403 { "error": "fourwinds_required" }` otherwise. Nobody may create a fourth club or be handed one: `POST /api/clubs` and a transfer of ownership to a member who already owns 3 answer `409 limit`, and a deleted owner's club passes to the senior admin, else the earliest member, who owns fewer than 3 and has not deleted their own account. Two paths can still leave an account with more than 3: an account merge (a guest's clubs pass to the account it is merged into), and a deleted owner's club where everyone left already owns 3 (the senior one takes it; a club where only deleted accounts are left is dissolved). A plan covers its owner's first 3 clubs, oldest first; a club beyond them is treated as lapsed until it is passed on or one of the 3 goes. When the owner's plan lapses, or does not cover the club, the server records `ownerLapsedAt` (on a table open, on a transfer and hourly); 7 days later the club may have only one open table (`409 limit`) until the owner renews or passes the club to a subscriber with room. A lapse belongs to the account that had it: passing the club to a subscriber clears it at once, but if the club comes back to the lapsed account, or goes on within 30 days to another account without a plan, the original lapse continues and no new 7 days start. It is cleared for good when that account holds the plan again. Members keep playing and the owner keeps every admin tool. Before the store is live anyone may create clubs (the cap of 3 still applies).

| Route | Auth | Body | Answer |
| --- | --- | --- | --- |
| `POST /api/clubs` | bearer | `{ "name", "rules"?, "settings"? }` | `200 Club`; the caller is its owner. `400 invalid` (name), `403 fourwinds_required` (store live, no plan), `409 limit` (clubs per user, or 3 owned) |
| `DELETE /api/clubs/:code` | bearer (owner) | `{ "confirm": "<the club's name or code>" }` | `204`; the club, its standings and bans go, and each live table closes (players are told the club was deleted). `400 invalid` (confirmation), `403 forbidden` |
| `GET /api/clubs/:code` | bearer | | members: `Club`; anyone else: the public view. `404 not_found` |
| `PATCH /api/clubs/:code` | bearer (owner or admin) | `{ "name"?, "description"?, "rules"?, "settings"? }` | `200 Club`; `403 forbidden` |
| `POST /api/clubs/:code/join` | bearer | | `200 { "club", "status": "joined"\|"pending"\|"already" }` (`club` is the public view until membership); standings the account left on file here come back with it. `403 forbidden` (banned), `409 limit` (members, pending requests, or clubs per user), `429 rate_limited` (10 an hour per address, 60 an hour per club; see Join requests) |
| `POST /api/clubs/:code/members/:userId/approve` | bearer (owner or admin) | | `200 Club`; `403 forbidden`, `404 not_found` (no such request) |
| `POST /api/clubs/:code/members/:userId/reject` | bearer (owner or admin) | | `200 Club`; the request is dropped (the player may ask again). `404 not_found` (no such request) |
| `POST /api/clubs/:code/pending/reject-all` | bearer (owner or admin) | `{ "userIds"?: ["<user id>", …] }` | `200 { "club": Club, "rejected": n }`; every pending request is dropped, or only those named in `userIds` (the app sends the requests it was showing, so one that arrived meanwhile stays). `400 invalid` (`userIds` not a list of at most 200 ids), `403 forbidden` |
| `POST /api/clubs/:code/members/:userId/role` | bearer (owner) | `{ "role": "owner"\|"admin"\|"member" }` | `200 Club`; `owner` transfers ownership (the previous owner becomes an admin). `400 invalid` (role), `403 forbidden` (not the owner, or the owner's own role), `404 not_found` (not a member), `409 limit` (`owner` for a member who already owns 3 clubs) |
| `DELETE /api/clubs/:code/members/:userId` | bearer (the member, owner or admin) | | `200` the club (the public view once the caller has left). The member's standings go on file (see Leaving and rejoining). Removed by the owner or an admin, the player also leaves the club's live tables as on `evict`; a member who leaves on their own keeps their seat, and either way a match they started still counts. `403 forbidden` (the owner cannot leave or be removed; only the owner removes an admin) |
| `POST /api/clubs/:code/bans` | bearer (owner or admin) | `{ "userId" }` | `200 Club`; the account's membership or request goes, it leaves the club's live tables, and it cannot join, ask to join or join the club's tables until unbanned. Works for accounts outside the club too. `403 forbidden` (the owner; an admin by an admin), `404 not_found` (no such account) |
| `DELETE /api/clubs/:code/bans/:userId` | bearer (owner or admin) | | `200 Club`; `404 not_found` (not banned) |
| `POST /api/clubs/:code/tables/:table/close` | bearer (owner or admin) | | `200 Club`; the table ends at once and nothing counts. Everyone at it gets `{t:"error", code:"table_closed", message:"The club closed this table."}` from the table and `{t:"error", code:"closed", message}` from the server. `404 not_found` (not this club's table) |
| `POST /api/clubs/:code/tables/:table/evict` | bearer (owner or admin) | `{ "userId" }` | `200 { "seats": n }`; the player's seat is played by the table's bot to the end of the match (freed in the lobby), their sockets in the room get `{t:"error", code:"evicted"}` and `{t:"error", code:"closed", message:"The club removed you from this table."}` and leave, and they cannot come back to that table. `403 forbidden` (the owner; an admin by an admin), `404 not_found` (no such open table) |
| `GET /api/clubs/:code/standings` | bearer (member) | | rows by season points: `{ userId, name, avatar?, role, seasonPoints, lifetimePoints, points, season, … }`; `403 forbidden` |
| `POST /api/clubs/:code/season` | bearer (owner) | | see Club seasons below; `403 forbidden` |
| `POST /api/clubs/:code/tables` | bearer (member; owner and admins only when `settings.membersCanOpenTables` is false) | `{ "label"?, "rules"?, "botSkill"? }` | `200` the listed table `{ code, label, rules, variant, createdBy, createdAt, … }`; its room is a hosted club table and members with push tokens (not the opener) are notified. `rules` count only from the owner and admins (see House rules); `botSkill` is checked but the club's is used. `403 forbidden`, `400 invalid`, `409 limit` (open tables, or one table while the owner's plan has lapsed), `503 unavailable` (table capacity) |
| `GET /api/users/:userId/clubs` | bearer (self; `me` works) | | `200 [Club, …]`: the caller's clubs (members' view) and pending requests (public view); `403 forbidden` for anyone else |

Every club route answers `404 not_found` for an unknown code and `429 rate_limited` under the per-IP HTTP limit.

When an account is purged (30 days after `DELETE /api/me`), its member rows, join requests and standings on file leave every club; bans it made, and bans of it, stay. The Postgres club write only stores rows whose account still exists, so a club can always be saved.

## Store, wallet, reports and seasons: what the app relies on

The app side lives in `apps/mobile/src/monetisation/` (store and wallet), `apps/mobile/src/api/wallet.ts`, `apps/mobile/src/api/clubs.ts` and `apps/mobile/src/legal/`. The server's own section of this file is authoritative for status codes and limits; these are the parts the app depends on.

- **The wallet is the server's.** The app's copy mirrors `GET /api/me` and is cached for offline display only. It reads `wallet.diamonds`, `wallet.bonusDiamonds`, `entitlements[]` (one per subscription plan: `coach.gold.month`, `coach.gold.year`, `fourwinds.month`, `fourwinds.year`; a cosmetic entitlement is its product id, e.g. `theme.jade`) and the optional `cosmetics[]` (product ids). `serverNow` sets the clock that subscription expiry and the free-tier meters are judged by.
- **Purchases.** The app configures RevenueCat with the server user id as the app user id (`Purchases.logIn(userId)` after sign-in), buys with the store, then polls `GET /api/me` for about 8 seconds until the purchase shows; if it has not arrived yet the Shop says so and the next sync picks it up. Nothing is granted on the device. Store ids are the `catalog.ts` ids; a Google Play subscription arrives as `coach.gold:month`.
- **`POST /api/wallet/spend`** body `{ "productId": "theme.jade" }` (bearer) → `{ spent, entitlement, wallet, cosmetics }` (a `bundle.*` id also returns `granted: [...]`, the items the set unlocked). The app maps `409 insufficient` to "you need N more diamonds" and `409 owned` to success, then re-reads `/api/me`.
- **`PATCH /api/me` `{ "birthYear" }`** is sent once the device has a session, after the age gate (the app keeps the answer on the device until then).
- **`POST /api/reports`** body `{ "reportedUserId", "reason", "details"?, "roomCode"? }` with `reason` one of `cheating`, `collusion`, `abusive_chat`, `offensive_name`, `stalling`, `other`; the app trims `details` to 500 characters.
- **`POST /api/clubs/:code/season`** (owner) starts the next season; the app then re-reads the club. Standings rows carry `points` (all time) and `seasonPoints`; the club carries `season`. An older server without seasons is shown with `points` in both views.

## Implementation notes (where the server differs from the text above)

- `createSignalServer` is async (it loads clubs, restores tables, then listens).
- The hello reply is `{ "t": "hello", "id", "userId", "peerId" }`; `peerId` duplicates `id` for older clients.
- `GET /api/clubs/:code/standings` answers `403 forbidden` ("Join the club first") to non-members rather than the public view; `GET /api/clubs/:code` gives the public view.
- `/api/me.identities` lists provider identities only (never `guest`); `User.avatar` and `User.locale` are `null` when unset.
- The `email` field in `POST /api/auth/link` is ignored; only a provider-verified email is stored.
- Auth `429` responses carry `retry-after: 12`.
- `/health` also reports `storage` (`memory` | `pg`) and, on Postgres, `db: ok | down`.
- `GET /api/users/:userId/clubs` only serves the caller's own id (or `me`); others get `403`.

## Push notifications

`POST /api/push/token` (bearer) body `{ "token": "ExponentPushToken[…]" | null, "platform": "ios" | "android", "locale"?: "en" | "zh-TW" }` → `204`; `null` stops notifications. Notification `data` carries `kind` (`club_table_opened` | `join_approved` | `table_waiting`), `type` (`club` | `table`) and the `club` / `room` codes for the deep link.

## Environment (server)

`DATABASE_URL` (absent → in-memory repos, guest-only), `DATABASE_URL_DIRECT`, `MIGRATE_ON_BOOT`, `AUTH_PEPPER` (+ `AUTH_PEPPER_PREVIOUS`), `APPLE_CLIENT_ID`, `GOOGLE_CLIENT_IDS` (comma-separated), `FACEBOOK_APP_ID`, `CORS_ORIGINS`, `TRUST_PROXY`, `MAX_HOSTED_TABLES`, `PORT`. See `apps/signal/README.md` and `docs/DEPLOY.md`.

## Store, wallet and entitlements (Phase 4)

Entitlements are decided by the server from store notifications; the app never grants anything itself and only reads `GET /api/me`. The app configures RevenueCat with the server user id as the RevenueCat **app user id** (call `Purchases.logIn(userId)` after the guest bootstrap or a sign-in), and must re-read `/api/me` after a purchase or a Restore (the webhook usually lands within a few seconds; poll `/api/me` for up to ~10 s).

`GET /api/config.storeEnabled` is `true` only when the server has `REVENUECAT_WEBHOOK_SECRET`. When it is `false` the app shows "Store unavailable" and offers no purchase.

`GET /api/me` also returns:

```json
{
  "entitlements": [{ "entitlement": "coach.gold.month", "expiresAt": "<ISO>" | null, "active": true }],
  "cosmetics": ["theme.jade"],
  "coachTier": "free" | "gold" | "fourwinds",
  "storeEnabled": true
}
```

`active` is computed on the server clock (`serverNow`), so a device clock rolled back changes nothing. `cosmetics` lists the table looks the user owns (product ids; the app maps them to `unlocks` through its catalogue).

### Catalogue (server side: `apps/signal/src/catalog.ts`)

| Product id | Kind | Grants |
| --- | --- | --- |
| `diamonds.60`, `diamonds.300`, `diamonds.600` | consumable | 60 / 300 / 600 diamonds |
| `diamonds.1300`, `diamonds.3450`, `diamonds.7500` | consumable | 1,200 + 100 bonus / 3,000 + 450 bonus (15 %) / 6,000 + 1,500 bonus (25 %) |
| `coach.gold.month`, `coach.gold.year` | auto-renewing | Coach Gold: an entitlement named after the plan until the store's expiry |
| `fourwinds.month`, `fourwinds.year` | auto-renewing | The Four Winds Club (everything in Coach Gold, unlimited hand reviews, creating and running clubs): an entitlement named after the plan until the store's expiry |
| `theme.nightmarket`, `theme.bamboo`, `theme.imperial` (300 💎), `theme.jade` (400 💎) | diamonds only | permanent entitlement with the product id |

App Store product ids are these ids. A Google Play subscription arrives as `<subscription>:<base plan>`, so create the Play subscriptions `coach.gold` and `fourwinds` with base plans `month` and `year`. The tier is the best active plan; refunding or ending one plan never cuts another. Sandbox events (TestFlight, Play testing) grant only to accounts in `TESTER_USER_IDS` and are otherwise recorded as `ignored_sandbox`. A refunded diamond pack takes back its diamonds even if that leaves a negative balance, which blocks spending until it is paid back. Anything else (avatar and emote packs, VIP cards, club tiers, Coach Diamond, Table Pass) is not sold: events and spends for it grant nothing.

### `POST /api/wallet/sync` (bearer)

Asks the server to fetch this account's purchases from RevenueCat and apply any the webhook missed (the app calls it after Restore). → `{ synced, applied, wallet, cosmetics, coachTier }`. `synced:false` when the server has no `REVENUECAT_SECRET_KEY`. Errors: `429 rate_limited` (4 a minute), `502 store_unreachable`. A nightly job does the same for accounts with store activity in the last 7 days.

### `POST /api/admin/grant` (`Authorization: Bearer <ADMIN_TOKEN>`)

Support grant. Body `{ userId, diamonds?, bonus?, entitlement?, days?, note }`; writes a `support` ledger entry or an entitlement. `401` wrong token, `404` unknown user, `503` when `ADMIN_TOKEN` is unset.

### `POST /api/wallet/spend` (bearer)

Body `{ "productId": "theme.jade" }` → `200 { "spent": 400, "entitlement": "theme.jade", "wallet": { "diamonds", "bonusDiamonds" }, "cosmetics": [...] }`. The debit and the grant are one transaction; bonus diamonds are spent first.

| `error` | Status | Meaning |
| --- | --- | --- |
| `insufficient` | 409 | Not enough diamonds; nothing changed |
| `owned` | 409 | The user already owns it; nothing charged |
| `not_for_sale` | 404 | Not a product sold for diamonds |

### `POST /api/webhooks/revenuecat` (RevenueCat only)

Header `Authorization: Bearer <REVENUECAT_WEBHOOK_SECRET>` (set exactly that as the Authorization value in the RevenueCat dashboard). Body: a RevenueCat v1 webhook (`{ "api_version": "1.0", "event": { "id", "type", "app_user_id", "product_id", "transaction_id", "expiration_at_ms", "store", "environment", … } }`).

- `503 unavailable` when the secret is unset; `401 unauthorised` for a missing or wrong secret; `400 invalid` for a body without `event.id` and `event.type`.
- Otherwise `200 { "ok": true, "outcome": "<what happened>", "duplicate": boolean }`. The raw body is stored in `store_events`; a redelivered event id answers `duplicate: true` and changes nothing. Unknown users (for example RevenueCat anonymous ids) and unknown products are stored and acknowledged with 200 so RevenueCat stops retrying. A 500 means nothing was applied and RevenueCat will retry.
- `app_user_id` (then `original_app_user_id`, then `aliases`) names the account; a merged guest's events go to the account it was merged into.

| Event type | Effect |
| --- | --- |
| `INITIAL_PURCHASE`, `RENEWAL` | Subscription: entitlement until `expiration_at_ms` (never shortened by a late, older event); purchase row recorded. A consumable sent as `INITIAL_PURCHASE` is credited like `NON_RENEWING_PURCHASE` |
| `NON_RENEWING_PURCHASE` | Diamond pack credited (diamonds + bonus), once per `transaction_id` |
| `CANCELLATION` | Auto-renew off: nothing changes until expiry. `cancel_reason: CUSTOMER_SUPPORT` (a refund): subscription ends now; for a diamond pack what is left of it is taken back (never below zero). The refund is remembered by `transaction_id`, so a purchase or renewal event for that transaction delivered later (a retry) grants nothing and answers `refunded` |
| `UNCANCELLATION`, `SUBSCRIPTION_EXTENDED` | Entitlement carried to `expiration_at_ms` if that is later |
| `EXPIRATION` | Entitlement ends (ignored when a later renewal already extended it) |
| `BILLING_ISSUE`, `PRODUCT_CHANGE`, `SUBSCRIPTION_PAUSED` | Recorded only (the store retries billing; the new product arrives with its `RENEWAL`; a pause ends with an `EXPIRATION`) |
| `TRANSFER` | Store-granted entitlements move from `transferred_from` to the first known `transferred_to` account (later expiry wins); diamonds stay |
| `TEST` | Recorded only |

`outcome` is one of `credited`, `entitled`, `extended`, `expired`, `refunded`, `transferred`, `recorded`, `test`, `duplicate`, `ignored_unknown_user`, `ignored_unknown_product`, `ignored_stale`, `ignored_type`.

## Reports (Phase 4)

`POST /api/reports` (bearer) body `{ "reportedUserId": "<uuid>", "roomCode"?: "AB12CD", "reason": "cheating" | "collusion" | "abusive_chat" | "offensive_name" | "stalling" | "other", "details"?: "<up to 1,000 characters>" }` → `201 { "id", "status": "open", "createdAt" }`.

`400 invalid` (missing or unknown field values, reporting yourself), `404 not_found` (no such player), `429 rate_limited` after 10 reports by the same user in 24 hours, or after 30 reports from the same IP address in 24 hours whatever the accounts (guest accounts are free to make). Reports are kept when either account is deleted, and follow a guest into the account it merges into. Moderators read and resolve them with the routes under "Moderation" above.

## Club seasons (Phase 4)

- `POST /api/clubs/:code/season` (bearer, owner only) → `200 { "club": Club, "archived": { "season", "startedAt", "endedAt", "standings": [{ "userId", "name", "points" }] } }`. Archives the season's standings in `club.seasons` (the latest 24 are kept), resets every member's season points to 0 and starts the next season. Lifetime points and match counts stay. `403 forbidden` for anyone but the owner.
- `Club` (members' view) gains `season` (from 1), `seasonStartedAt` (ms) and `seasons` (finished seasons, oldest first); each member gains `seasonPoints`.
- `GET /api/clubs/:code/standings` rows are members ranked by season points, each with `seasonPoints`, `lifetimePoints` (the same as `points`) and `season`.
- Points have no monetary value; standings are points only.

## Push notifications (Phase 6)

`POST /api/push/token` (bearer) body `{ "token": "ExponentPushToken[…]", "platform": "ios" | "android" }` → `204`. The token is stored on this session's device (a device row is created for sessions without one) and removed from every other device that had it, so an account switch on one phone moves it. `{ "token": null }` stops notifications for this device, and so does `POST /api/auth/logout` (the token is removed from the session's device; the next account to sign in on the phone registers it again). `400 invalid` for anything that is not an Expo push token or a known platform.

`GET /api/config.pushEnabled` is `true` only when the server has `EXPO_ACCESS_TOKEN`; without it no push is sent. Notifications (each at most once a minute per user and kind; `data.kind` tells the app where to go):

| `data.kind` | When | `data` |
| --- | --- | --- |
| `club_table_opened` | A member opens a club table (everyone else in the club with a token) | `{ club, room }` |
| `join_approved` | An owner or admin approves your join request | `{ club }` |
| `table_waiting` | You have been disconnected for 30 s while a hand is in play at a server table (a bot is playing your seat) | `{ room, club? }` |

Copy is English, or Traditional Chinese when the device locale starts with `zh`. Tokens Expo reports as `DeviceNotRegistered` are cleared.

## Health (Phase 6)

`GET /health` → `{ "ok": true, "peers", "rooms", "hostedTables", "tables", "actionLatency": { "samples", "p50Ms", "p95Ms", "maxMs", "windowSeconds": 300 } | null, "pushEnabled", "storeEnabled", "storage": "memory" | "pg", "db"?: "ok" | "down" }`. `actionLatency` is the time from a player's action frame reaching a hosted table to the resulting state having been sent, over the last five minutes. See `docs/OBSERVABILITY.md`.

## Environment (server, Phases 4 and 6)

`REVENUECAT_WEBHOOK_SECRET` (absent → webhook 503, `storeEnabled: false`), `EXPO_ACCESS_TOKEN` (absent → no push, `pushEnabled: false`), `SENTRY_DSN` (+ optional `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`; absent → errors only logged), `POSTHOG_KEY` (+ optional `POSTHOG_HOST`; absent → no server events).
