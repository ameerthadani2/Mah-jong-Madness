# Game server API (accounts, sessions, tables)

The contract between the app and `apps/signal`. The server side is implemented by `apps/signal/src/auth/*` and `src/repos/*` (Phase 3 foundations) and wired into `server.ts` / `api.ts` / `rooms.ts`; the app side lives in `apps/mobile/src/auth/*`. Everything here works with the in-memory repositories when no database is configured, so the contract holds in development and in tests.

## Conventions

- JSON bodies and responses; `Content-Type: application/json`.
- Errors: `{ "error": "<code>", "message": "<English sentence>" }` with the HTTP status below. `message` is for logs; the app maps `error` codes to translated copy (`errors.*`).
- Authentication: `Authorization: Bearer mjs_<64 hex>` on every `/api/*` route except `/health`, `/api/config` and the `/api/auth/guest*` bootstrap routes. A WebSocket connection authenticates with its first frame `{ "t": "hello", "auth": "<token>" }`.
- Rate limits: per IP (an IPv4 address, or the /64 prefix of an IPv6 address; HTTP 10/s burst 30; auth routes 5/min) and per user (auth routes 5/min; a failed guest sign-in counts against the calling IP and the named user id together, never against the user's own bucket, so a stranger who knows a user id cannot lock that user out). Reports: 10 a day per user and 30 a day per IP. Exceeding one returns `429 { "error": "rate_limited" }` (auth routes add `retry-after: 12`).

| `error` code | Status | Meaning |
| --- | --- | --- |
| `invalid` | 400 | Malformed body or unknown provider |
| `name_not_allowed` | 400 | A display name, club name or club description the name check refuses (see Names) |
| `invalid_credentials` | 401 | Guest id or secret does not match |
| `invalid_session` / `session_expired` / `session_revoked` / `session_rotated` | 401 | The bearer token is not usable; the app should refresh or bootstrap again |
| `invalid_token` | 401 | The provider token failed verification |
| `unauthorised` | 401 | The RevenueCat webhook secret is missing or wrong |
| `forbidden` | 403 | The caller may not do this: not a member, not an owner or admin, not the user whose data is asked for |
| `banned` | 403 | The account is banned, or the device belongs to a banned account (see Moderation). Signing in again does not help |
| `fourwinds_required` | 403 | Creating a club needs The Four Winds Club (while the store is live) |
| `provider_disabled` | 404 | That sign-in method is not configured on this server (`GET /api/config.authProviders` lists the enabled ones) |
| `not_linked` | 404 | `login` for a provider identity that has no account; offer "attach to this guest" |
| `not_found` | 404 | No such user, identity, club or route |
| `identity_in_use` | 409 | The identity already belongs to another account that also has a provider |
| `last_identity` | 409 | Cannot unlink the only sign-in method |
| `limit` | 409 | A club cap was hit |
| `birth_year_locked` | 409 | The account already has a different birth year on file (it is write-once) |
| `resolved` | 409 | The report was already closed by a moderator |
| `insufficient` / `owned` | 409 | `POST /api/wallet/spend`: not enough diamonds, or already owned |
| `too_large` | 413 | The request body is over 64 KiB |
| `rate_limited` | 429 | Too many requests |
| `store_unreachable` | 502 | `POST /api/wallet/sync`: the store's records could not be read; try again |
| `unavailable` | 503 | The server is at capacity (tables) or a dependency is down |
| `internal` | 500 | An unexpected error; nothing was applied, retry later |

## Configuration

`GET /api/config` → `{ "authProviders": ["apple","google"], "storeEnabled": false, "pushEnabled": false, "minBuild": 0, "maintenance": null | "<message>", "serverNow": "<ISO>" }`. No auth. The app reads it at launch and on foreground; absent features are hidden.

## Guest accounts

`POST /api/auth/guest` body `{ "device": { "id": "<uuid>", "platform": "ios"|"android"|"web", "appBuild": "<string>", "locale": "en"|"zh-TW" }, "displayName"?: string, "avatar"?: string }`
→ `201 { "userId": "<uuid>", "guestSecret": "<64 hex>", "session": { "token": "mjs_…", "expiresAt": "<ISO>" }, "user": User, "nameRefused"?: true }`.
The app stores `userId` and `guestSecret` in secure storage; they are the only way back into a guest account on a new install.

- A `displayName` the name check refuses (see Names) never blocks sign-in: the guest is created with no display name and the reply carries `"nameRefused": true`, so the app can ask for another name. Until one is set, the player sits at tables as `Player XXXX`.
- `device.id` becomes the device's id when no device holds it yet. When one does (an earlier account on the same install, or the same sign-up sent twice at once), the request still succeeds: the new device gets an id of its own and remembers the one sent as its install id.
- `403 banned` when `device.id` belongs to a banned account (see Moderation): a ban covers the banned account's devices until it is lifted.

`POST /api/auth/guest/login` body `{ "userId", "guestSecret", "device" }` → `200 { "session", "user" }` or `401 invalid_credentials`. Five failed attempts a minute from one IP for one user id answer `429`; the user's own auth bucket is spent only once the secret has been proven. Linking a provider replaces the guest secret (see the `guestSecret` field of `POST /api/auth/link`); the old one then stops working.

## Sessions

- Tokens are opaque; the server stores a peppered hash. Sliding expiry of 30 days.
- `POST /api/auth/refresh` (bearer) → `200 { "session": { "token", "expiresAt" } }`. The old token stays valid for 5 minutes. The app refreshes once a day and on `session_expired`.
- `POST /api/auth/logout` (bearer) → `204`. Revokes this session only, removes the push token from this session's device (the phone is no longer this account's) and closes the table socket this session opened with `4401`.
- `GET /api/me` (bearer) → `{ "user": User, "wallet": { "diamonds", "bonusDiamonds" }, "entitlements": [{ "entitlement", "expiresAt" }], "identities": [{ "provider", "email"? }], "serverNow" }`.
- `PATCH /api/me` (bearer) body `{ "displayName"?, "avatar"?, "locale"?, "birthYear"?, "analyticsConsent"?: true|false|null }` → `{ "user": User }`. `analyticsConsent` is the player's product-analytics choice; server-side events (`purchase_credited`, `report_filed`) are sent only for players who chose `true`. A refused `displayName` answers `400 name_not_allowed`.
- **The birth year is write-once.** `birthYear` is accepted while the account has none. After that, sending the year on file again changes nothing and succeeds; any other year, or `null`, answers `409 { "error": "birth_year_locked" }` and nothing in the request is applied. Only a moderator can correct it (`POST /api/admin/users/:id/birth-year`). The year decides who may use quick match, so an account that declared itself under 18 cannot declare itself older a moment later. The app therefore sends the year only when the server has none: it reads `user.birthYear` from `GET /api/me` first, sends the year the player gave at the age gate when that is `null` (or after quick match answered `age_missing`), and treats `409 birth_year_locked` as "already on file".
- `DELETE /api/me` (bearer) → `204`. Soft-deletes the account: the profile is scrubbed at once (name, avatar, email, birth year, language), every session is revoked and every table socket of the account is closed with `4401`, identities, devices (with their push tokens) and blocks go, club rows become "Deleted player" (a club the user owned passes to its senior admin, else its earliest member, and is dissolved when nobody else is in it), and an hourly job hard-deletes the row 30 days later. The records that outlive the account lose its name in the same transaction: its seats in finished matches (`match_results.players`) and its rows in finished club seasons (`seasons[].standings`, also in clubs it had left) read "Deleted player" and keep their scores, and the notes of reports filed by or about it have the name replaced (any letter case; whole words only when the name starts or ends with a Latin letter or digit; a one-character name is left alone). The purge repeats this for matches recorded in between and clears the account id from them. What stays for good: purchase records and the wallet ledger (financial records), match results and season rows without the name, and reports (reason, note, table code, outcome, under the account ids) as moderation records.

`User` = `{ "id", "kind": "guest"|"account", "displayName", "avatar", "locale", "birthYear": number|null, "createdAt" }`.

## Provider sign-in (Sign in with Apple, Google, optional Facebook)

The app obtains an identity token from the provider SDK with a fresh `nonce` (the raw nonce is sent to the server; the SHA-256 of it was given to the provider), then:

- `POST /api/auth/link` (bearer) body `{ "provider": "apple"|"google"|"facebook", "token": "<id token>", "nonce": "<raw nonce>", "email"?: string }` — attaches the identity to the current account (merge rules below) → `200 { "session", "user", "merged": boolean, "guestSecret"?: "<64 hex>" }`. When `merged` is true the device has been moved onto the existing account and must replace its stored session. When `guestSecret` is present (rule 1, for a user who had one) the guest secret has been rotated: the device must store this one in place of the old, which no longer signs in; no other device receives it.
- `POST /api/auth/login` body `{ "provider", "token", "nonce", "device" }` (no bearer, or a guest bearer) → `200 { "session", "user" }` or `404 not_linked`.
- `nonce` is required on both: a request without one is `400 invalid`, and a token whose nonce claim is missing or differs is `401 invalid_token`.
- `DELETE /api/auth/identities/:provider` (bearer) → `204` or `409 last_identity`.

Merge rules: (1) identity unlinked → linked to the current user, who becomes `kind: "account"`; the user's other sessions (and their table sockets) end and the guest secret is rotated; (2) identity belongs to V and the current user is a guest → the guest is merged into V (progress, wallet, purchases, club memberships, devices, reports, blocks, the guest's seats in finished matches and its rows in finished club seasons move, the season points being added where both accounts have a row; the guest's sessions are revoked and its sockets closed with `4401`) and the device receives a V session; (3) identity belongs to V and the current user already has a provider → `409 identity_in_use`; (4) unlink only while another provider remains.

## WebSocket (tables)

1. First frame: `{ "t": "hello", "auth": "<token>" }`. The server verifies it before assigning a peer id and replies `{ "t": "hello", "id": "<peer id>", "userId": "<uuid>" }`. A missing or bad token closes the socket with `4401`; a token still being checked when the 10 s hello timer fires closes it with `1013` (try again later), so a slow database never looks like a refused session.
2. `{ "t": "create", "hosted": true, "rules"?, "botSkill"?, "club"?: "<club code>" }` → `{ "t": "room", "room", "host", "peers" }` or `{ "t": "error", "code"?, "message" }`. Club tables require membership (`403`-style error frame `Join the club first`).
3. `{ "t": "join", "room" }` → `room` or `error`. `{ "t": "error", "code": "room_unavailable", "message": "Room not found or full" }` is definitive (the table is over, was reaped, or is full): stop reconnecting to it. The table host binds the verified `userId` to the seat; the client's `join` frame to the table carries its avatar and rejoin token as before. The seat name is never the client's: an account sits down under its display name, or under `Player XXXX` (the first four hex digits of its id) when it has none or the name check refuses it.
4. Reconnect: on socket close the app retries with backoff 1, 2, 4, 8 … 60 s, re-sends `hello` + `join` with the same rejoin token, and shows "Reconnecting". The server keeps a seat for 15 minutes of inactivity. At a server-hosted table the token is not the only way back: a join from the seat's own account takes the seat back without one (the older connection is told and dropped, and a new token is issued), so a player on a new phone can return. Another account can never take the seat.
5. The session is checked again before a `create`, `join` or `queue` once the last check on that socket is 5 s old; a frame whose create or join allowance is spent is refused without a check; a session that ended quietly is noticed at the first such frame after those 5 s. A session that ends while the socket is open (logout, `DELETE /api/me`, a merge, a link ending the account's other sessions, a revocation or expiry) closes the socket with `4401`. The seat stays reclaimable: obtain the current session (refresh, or sign in again), then reconnect with `hello` + `join` and the rejoin token. A token that was refreshed more than 5 minutes ago is treated the same way at the next `create` or `join`.

6. A banned account is refused at `hello` and at each recheck with close code `4403` (not `4401`: signing in again will not help), and a moderator's ban closes its open sockets with `4403` at once.

### Signalling frames (the socket itself)

Besides `hello`, `create`, `join`, `queue` and `leave_queue` (above and under Quick match):

| Frame | Direction | Purpose |
| --- | --- | --- |
| `{ "t": "to", "to": "<peer id>", "data": … }` | client → server | Relay `data` to a peer in the same room; at a hosted table the peer is the room's `host` |
| `{ "t": "from", "from": "<peer id>", "data": … }` | server → client | Relayed data |
| `{ "t": "peer", "peerId", "event": "join" \| "leave" }` | server → client | A peer entered or left the room |
| `{ "t": "leave" }` | client → server | Leave the room (the seat stays reclaimable; the table's own `leave` frame, below, gives it up) |
| `{ "t": "ping" }` → `{ "t": "pong" }` | both | Heartbeat. The app sends one every 15 s and reconnects after 10 s without an answer |
| `{ "t": "error", "code": "table_cap", "message" }` | server → client | The account already has `MAX_TABLES_PER_USER` (default 3) unfinished tables open; `create` is refused |
| `{ "t": "error", "code": "closed", "message" }` | server → client | The room has closed (a relay-only room whose host left, a club table closed by the club, an eviction); the socket is no longer in a room |

Game traffic travels inside `to` / `from` as `{ "ch": "game", "msg": <table frame> }`, so other channels can share the socket.

### Table frames (`packages/net/src/messages.ts`)

The table host (the server, for every online table) and each seat exchange these inside the `game` channel. `Commitment` is `{ seat, hash }`, `Audit` the hand's record (seed, commitments, reveals, action log, final hash, ceremony attempts and restarts; see `docs/FAIRNESS.md`), `TableView` what one seat may see.

Client → host:

| Frame | Purpose |
| --- | --- |
| `{ "t": "join", "name", "avatar"?, "wantSeat"?, "token"?, "userId"?, "have"? }` | Sit down, or come back to a seat. `token` is the rejoin token from `welcome`. The server overwrites `userId` with the account the socket proved and `name` with that account's display name. `wantSeat` asks for a seat number in the lobby. `have`, on a rejoin, is the last hand of this match whose end the client holds (-1: none); the host answers with a `hand_missed` for each later hand |
| `{ "t": "leave" }` | Give up the seat on purpose (a bot plays it mid-match; a dropped connection is not a leave) |
| `{ "t": "ready" }` | After `hand_over`: the seat is ready for the next hand, which is dealt once every connected human is |
| `{ "t": "start" }`, `{ "t": "add_bot" }` | Start the match, or put a bot in an empty seat. Only the table's controller (see "Who controls a table"). After a failed seed ceremony any seated player's `start` deals the hand again |
| `{ "t": "commit", "hash": "<64 hex>" }` | Answer to `commit_request`: the SHA-256 of this seat's secret for the coming hand |
| `{ "t": "reveal", "secret": "<hex>" }` | Answer to `reveal_request`: the secret behind the commitment |
| `{ "t": "action", "seat", "action", "expectHash"?, "turnCounter"? }` | A move (discard, chi, pong, kong, win, pass …) for the sender's own seat. `expectHash` is the state hash the player acted on; `turnCounter` the turn of that view, echoed if the move is refused |
| `{ "t": "chat", "text" }`, `{ "t": "emote", "emote" }` | A quick phrase or an emote, by id (next section) |
| `{ "t": "ping", "at" }` | Clock probe; answered `{ "t": "pong", "at", "now" }` with the host's clock, which the countdowns use |

Host → client:

| Frame | Purpose |
| --- | --- |
| `{ "t": "welcome", "seat", "roomCode", "rules", "seats", "matchId", "token" }` | The seat is yours. `token` is the rejoin token (a new one each time the seat is taken back) |
| `{ "t": "lobby", "seats" }` | Who sits where; sent whenever a seat changes. A seat is `{ seat, name, peerId, isBot, connected, avatar?, userId?, timeBank?, left? }` |
| `{ "t": "commit_request", "handNumber", "attempt"? }` | Start of the seed ceremony for a hand: send `commit`. `attempt` is above 1 when the ceremony was run again |
| `{ "t": "commits", "handNumber", "commits" }` | Every seat's commitment and the host's own (seat 4), before anything is revealed |
| `{ "t": "reveal_request", "handNumber" }` | Send `reveal` |
| `{ "t": "stand_in", "handNumber", "attempt"? }` | This seat did not commit in time, so the host used a stand-in secret for it; the app marks the hand as not verified by this seat's own share |
| `{ "t": "state", "view", "hash", "deadline", "timeBank", "inTimeBank", "now"? }` | The table as this seat may see it, after every action. `deadline` and `now` are on the host's clock |
| `{ "t": "hand_over", "result", "audit", "view", "now"? }` | A hand ended: its result and the audit the app verifies |
| `{ "t": "match_over", "scores", "view" }` | The match ended |
| `{ "t": "hand_missed", "audit" }` | To a returning seat: the audit of a hand that ended while it was away, one frame per hand, in order |
| `{ "t": "restored", "handNumber", "turnCounter" }` | To a returning seat: the table was restored from a saved snapshot after a server restart, at this hand and turn (-1: before the deal); anything shown beyond that point is void |
| `{ "t": "disconnected" }` | This connection no longer holds the seat (the account took it back from another device) |
| `{ "t": "chat", … }`, `{ "t": "emote", … }` | A seat's phrase or emote (next section) |
| `{ "t": "pong", "at", "now" }` | Answer to `ping` |
| `{ "t": "error", "code", "message", "turnCounter"? }` | A refusal; the codes are below |

Table error codes, and what the app does:

| `code` | When | The app |
| --- | --- | --- |
| `full` | The table has no free seat, or the match has started and this account has no seat in it | Tells the player; does not retry |
| `already_seated` | The account already holds another seat at this table | Tells the player |
| `not_seated` | A frame other than `join` from a connection without a seat | Joins again |
| `not_controller` | `start` or `add_bot` from a seat that does not control the table | Tells the player who can |
| `cannot_start` | `start` refused: the table is not full (`add_bot` fills empty seats) | Shows the message |
| `bad_commit`, `bad_reveal` | A commitment that is not a SHA-256 digest; a secret that is not hex or does not match the commitment | Never sent by a correct app; logged |
| `ceremony_failed` | The seed ceremony for a hand could not be completed after its retries; sent to every seat. The table returns to its lobby and tries the hand again after a short pause, on a seated player's `start`, or when a player rejoins | Shows the message and waits |
| `not_playing` | An `action` when no hand is in progress | Drops the move and waits for the next `state` |
| `wrong_seat` | An `action` for a seat that is not the sender's | Never sent by a correct app |
| `illegal` | The engine refused the move (out of turn, a tile not held, a call that is not allowed). `turnCounter` says which view the move was made on | Puts the tile back and shows the current state |
| `evicted` | A club owner or admin removed the player from the table | Leaves the table and says so |
| `table_closed` | The club closed the table | Leaves the table and says so |

### Chat and emotes (table frames)

There is no free text at a table. Players say things with a fixed set of quick phrases and emotes, sent as ids (`packages/net/src/tabletext.ts`), and each app shows the phrase in its reader's language.

- `{ "t": "chat", "text": "<phrase id>" }` → to every seat `{ "t": "chat", "seat", "name", "text": "<phrase id>" }`. The ids are `nice`, `sorry`, `gg`, `hurry`, `goodHand`, `dealtIn`, `oneMore`, `faster` (the app's strings are `table.quickChat.<id>`). The field is still called `text`, but anything that is not one of these ids is dropped by the server and by the table host; an app shows nothing for an id it does not know.
- `{ "t": "emote", "emote": "<emote id>" }` → to every seat `{ "t": "emote", "seat", "emote" }`. The free emotes are `thumbs`, `lol`, `wow`, `cry`, `fire`, `love`, `zzz`, `hu`. The paid packs are `emotes.teahouse` (`th.*`), `emotes.nightmarket` (`nm.*`), `emotes.festival` (`fs.*`) and `emotes.zodiac` (`zd.*`), six emotes each. Any other id is dropped, and at a server-hosted table an emote from a pack is relayed only when the sender's account owns that pack (the server reads the account's cosmetics and remembers them for a minute; a pack bought during a match works within about ten seconds).
- Limits per seat: five phrases in a burst and one a second, one emote every two seconds. A muted account's phrases and emotes are dropped.

### Quick match (WebSocket)

Plan decision 3: instant seating with strangers. Any signed-in account may queue, guests included, provided it is not banned and the server holds a birth year that makes it 18 or older (`QUICK_MATCH_MIN_AGE`; the app sends the year with `PATCH /api/me` after the age gate, and only when the server has none: the year is write-once; the age counts as `currentYear - birthYear - 1`, so a player is let in from 1 January of the year they turn 19).

- `{ "t": "queue", "preset"?: "normal" }` → at once and every 2 s while waiting: `{ "t": "queue_status", "position": 1, "waitedMs": 4000, "humans": 2, "fillMs": 20000 }` (`humans`: players in the group this one would be seated with now, itself included), then `{ "t": "matched", "room": "QM2345", "humans": 2, "bots": 2 }`. Join the room with `{t:"join", room}` and the table `join` as usual; reconnects use the rejoin token like any table.
- `{ "t": "leave_queue" }` → `{ "t": "queue_left" }`. Closing the socket, or a `create`/`join`, also leaves.
- Refusals: `{ "t": "queue_error", "code", "message" }` with `code`:
  - `banned`;
  - `age_missing`: the server has no birth year for the account. The app sends the year it holds with `PATCH /api/me` and queues again;
  - `age_under`: the year on file makes the account younger than 18. Nothing the app sends changes that (see the write-once rule); it shows the message and does not retry. (`age_required`, which older servers sent for both cases, is no longer sent);
  - `seated`, with `"room": "<code>"`: the account is still at an unfinished quick-match table (it holds a seat there, connected or not, or the table has just been opened for it and is waiting for it to sit down). It is not queued again; the app goes back to that table by joining that room, with the saved rejoin token or without one (a server-hosted table gives an account its own seat back and issues a new token). A seat the player left on purpose does not count (the table's `{"t":"leave"}`, which the app sends when the player walks away from a table; a dropped connection or a closed app is not a leave): that player may queue again, and the next table is charged like any other;
  - `rate_limited` (the same per-account and per-address allowance as `join`);
  - `sign_in` (a socket without an account);
  - `unavailable` (try again);
  - `replaced` (the same account queued from another socket, which keeps this one's place in line).

Grouping: arrival order, four to a table; two accounts where either blocked the other are never in one group. A group of four is seated at once; a group of one to three is seated with Club bots in the empty seats once its first player has waited `QUICK_MATCH_FILL_MS` (default 20,000 ms). The table uses the default rules at Normal speed with Club bots, only the matched accounts may enter it (anyone else gets `room_unavailable`, onlookers included), no player may `start` it or `add_bot`, it is never a club table and never counts toward club standings. It starts by itself once every matched player holds a seat, or 15 s after it opened with bots in the seats of anyone who did not come (with nobody there it closes).

Limits: a quick-match table does not count against `MAX_TABLES_PER_USER`, but it is not free either. Opening one spends one create from each matched account's allowance (one table every 10 s) and one from each distinct address the group came from (6 a minute), the same allowances a `create` spends; a player with none left keeps its place in the queue until it has some, and the rest of its group is seated without it. An account holds a seat at only one unfinished quick-match table (`seated` above); walking away from one frees the account to queue again, at the price of the next table's create. And a started quick-match table closes 2 minutes after its last player disconnected (any other table waits 15 minutes): nobody else could enter it, so it would only be bots playing each other. The 2 minutes are for a player whose connection dropped; when every player of the table left on purpose it closes at once.

## Blocks

Bearer. A blocked player's chat lines and emotes are hidden by the app at a table, and quick match never seats the two together (in either direction). Blocks move to the surviving account on a merge and go with an account deletion.

- `GET /api/blocks` → `{ "blocks": [{ "userId", "displayName", "avatar", "createdAt" }] }`, newest first.
- `POST /api/blocks { "userId" }` → `201` (or `200` when already blocked) with the same fields. `400 invalid` (missing, malformed, yourself), `404 not_found` (no such player), `409 limit` (500 blocks).
- `DELETE /api/blocks/:userId` → `204`.

## Moderation (`Authorization: Bearer <ADMIN_TOKEN>`)

Compared in constant time. Without `ADMIN_TOKEN` every route here answers `503 unavailable`; a wrong token `401 unauthorised`.

- `GET /api/admin/reports?status=open&limit=100` → `{ "reports": [{ "id", "status", "reason", "details", "room", "createdAt", "reporter": Account, "reported": Account }] }`, oldest first. `status` is `open` (default), `actioned` or `dismissed`. `Account` is `{ "id", "kind", "displayName", "deleted", "birthYear", "bannedAt", "banReason", "mutedUntil" }`.
- `POST /api/admin/reports/:id/resolve { "action": "dismiss" | "warn" | "ban" | "mute", "days"?, "reason"? }` → `{ "ok": true, "id", "status", "action", "mutedUntil"? }`. `dismiss` leaves the report `dismissed`; the others `actioned`. `ban` bans the reported account (as below), `mute` mutes it for `days` (1 to 365, required), `warn` only records the decision. `409 resolved` for a report already closed, `404 not_found`. The report is claimed and its action applied in one transaction: when two moderators decide the same report at once, exactly one decision is applied and recorded (`resolution`, `resolved_at`) and the other gets `409 resolved` with nothing of it applied.
- `POST /api/admin/users/:id/ban { "reason"? }` → `{ "ok": true, "account": Account }`. Every session of the account is revoked, its sockets close with `4403`, it leaves the quick-match queue, and from then on sign-in (`/api/auth/guest/login`, `/api/auth/login`), `/api/auth/refresh` and every bearer route answer `403 banned`. A ban also covers the account's devices: each device's id (and install id) is recorded, and `POST /api/auth/guest` from one of them answers `403 banned`, so "start fresh" on the same phone does not get round it. Accounts that already exist on that phone are not affected. `DELETE` on the same path lifts the ban and frees those devices (the old sessions stay ended; the player signs in again); a device that another banned account also used stays covered until that ban is lifted too.
- `POST /api/admin/users/:id/mute { "days" }` → `{ "ok": true, "account": Account }`. `days` 1 to 365; `0` lifts the mute. A muted account's chat lines and emotes are dropped at every table until it ends.
- `POST /api/admin/users/:id/birth-year { "birthYear": 1991 | null }` → `{ "ok": true, "account": Account }`. Sets or clears the account's birth year: the only way to change one once it is on file (support uses it for a mistyped year). `400 invalid` for anything that is not a year from 1900 to this year or `null`; `404 not_found`.

## Names

Display names (`POST /api/auth/guest`, `PATCH /api/me`), club names (`POST /api/clubs`, `PATCH /api/clubs/:code`), club descriptions (`PATCH /api/clubs/:code`; no build of the app shows or edits one yet, but anyone holding the club code is sent it) and seat names are cleaned (`cleanText`) and then checked against a small English and Chinese blocklist: slurs and profanity, and names that pose as staff (admin, moderator, official, staff, support, GM, 官方, 管理員, 管理者, 客服 and the like). The check reads through the usual disguises: accents and combining marks are removed, Cyrillic, Greek and small-capital look-alikes are read as the Latin letters they resemble, digits and symbols stand for letters (`4dm1n`, `$hit`), an asterisk stands for any letter (`f*ck`), and Chinese entries are listed in Traditional and Simplified. It is also written not to refuse real names: staff words are matched within one word (never across a space, so "Brad Min" passes), single letters are joined only when three or more spell a word ("G. M. Lee" passes), stretched spellings are refused only for a listed set of words ("Rappe" and "Nazzi" pass), and words that only contain a blocked one (Badminton, Stafford, Scunthorpe, Dickens) pass.

What a refused name does depends on where it arrives: `PATCH /api/me` and the club routes answer `400 { "error": "name_not_allowed" }`; `POST /api/auth/guest` creates the guest without the name and says `"nameRefused": true`; and at a table a refused name is never shown (the seat reads `Player XXXX`).

On the device: a name the server refused is remembered as refused and masked (the app shows and sends no name, so the player reads as `Player XXXX` everywhere and is asked to choose another) until the player changes it; typing a different name clears the mark.

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
| `POST /api/clubs` | bearer | `{ "name", "rules"?, "settings"? }` | `200 Club`; the caller is its owner. `400 invalid` (name), `400 name_not_allowed`, `403 fourwinds_required` (store live, no plan), `409 limit` (clubs per user, or 3 owned) |
| `DELETE /api/clubs/:code` | bearer (owner) | `{ "confirm": "<the club's name or code>" }` | `204`; the club, its standings and bans go, and each live table closes (players are told the club was deleted). `400 invalid` (confirmation), `403 forbidden` |
| `GET /api/clubs/:code` | bearer | | members: `Club`; anyone else: the public view. `404 not_found` |
| `PATCH /api/clubs/:code` | bearer (owner or admin) | `{ "name"?, "description"?, "rules"?, "settings"? }` | `200 Club`; `400 name_not_allowed` (a name or a description the name check refuses), `403 forbidden` |
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
| `POST /api/clubs/:code/tables` | bearer (member; owner and admins only when `settings.membersCanOpenTables` is false) | `{ "label"?, "rules"?, "botSkill"? }` | `200` the listed table `{ code, label, rules, variant, createdBy, createdAt, … }`; its room is a hosted club table and members with push tokens (not the opener) are notified. `rules` count only from the owner and admins (see House rules); `botSkill` is checked but the club's is used. `403 forbidden`, `400 invalid`, `409 limit` (open tables, or one table while the owner's plan has lapsed), `503 unavailable` (table capacity) `429 rate_limited` when the account's or the address's create allowance is spent (one table per 10 s per account, six a minute per address, shared with socket creates and quick match). |
| `GET /api/users/:userId/clubs` | bearer (self; `me` works) | | `200 [Club, …]`: the caller's clubs (members' view) and pending requests (public view); `403 forbidden` for anyone else |

Every club route answers `404 not_found` for an unknown code and `429 rate_limited` under the per-IP HTTP limit.

When an account is purged (30 days after `DELETE /api/me`), its member rows, join requests and standings on file leave every club; bans it made, and bans of it, stay, and so do its rows in finished seasons (the points, under "Deleted player"). The Postgres club write only stores rows whose account still exists, so a club can always be saved.

## Store, wallet, reports and seasons: what the app relies on

The app side lives in `apps/mobile/src/monetisation/` (store and wallet), `apps/mobile/src/api/wallet.ts`, `apps/mobile/src/api/clubs.ts` and `apps/mobile/src/legal/`. The server's own section of this file is authoritative for status codes and limits; these are the parts the app depends on.

- **The wallet is the server's.** The app's copy mirrors `GET /api/me` and is cached for offline display only. It reads `wallet.diamonds`, `wallet.bonusDiamonds`, `entitlements[]` (one per subscription plan: `coach.gold.month`, `coach.gold.year`, `fourwinds.month`, `fourwinds.year`; a cosmetic entitlement is its product id, e.g. `theme.jade`) and the optional `cosmetics[]` (product ids). `serverNow` sets the clock that subscription expiry and the free-tier meters are judged by.
- **Purchases.** The app configures RevenueCat with the server user id as the app user id (`Purchases.logIn(userId)` after sign-in), buys with the store, then polls `GET /api/me` for 8 seconds (five reads, `CREDIT_POLL_MS`) until the purchase shows; if it has not arrived yet the Shop says so and the next sync picks it up. Nothing is granted on the device. Store ids are the `catalog.ts` ids; a Google Play subscription arrives as `coach.gold:month`.
- **`POST /api/wallet/spend`** body `{ "productId": "theme.jade" }` (bearer) → `{ spent, entitlement, wallet, cosmetics }` (for a `bundle.*` id, `cosmetics` then lists the items the set unlocked; there is no separate `granted` field). The app maps `409 insufficient` to "you need N more diamonds" and `409 owned` to success, then re-reads `/api/me`.
- **`PATCH /api/me` `{ "birthYear" }`** is sent once the device has a session, after the age gate (the app keeps the answer on the device until then). The server takes it once: the app sends it only while `user.birthYear` is null (or after `age_missing`), and treats `409 birth_year_locked` as "already on file".
- **A ban is remembered on the device for 24 hours.** After `403 banned` (or socket close `4403`) the app stops calling the server for that identity and does not offer "Start fresh": the ban covers the device, so a new guest would be refused too. Only a moderator lifts a ban and nothing tells the device when, so after 24 hours the app asks the server once more.
- **Start fresh asks first.** When a signed-out device chooses to continue as a new guest, the app requests the new guest (`POST /api/auth/guest`) before it touches the identity it holds; only when the server has answered is the old identity set aside (kept under a side key, never overwritten) and the new one stored. A refusal (`403 banned`) or an unreachable server leaves the old identity exactly where it was.
- **A refused name is masked.** When `POST /api/auth/guest` answers `nameRefused: true`, or `PATCH /api/me` answers `400 name_not_allowed`, the app keeps the name on the device marked as refused and neither shows nor sends it until the player changes it (see Names).
- **`POST /api/reports`** body `{ "reportedUserId", "reason", "details"?, "roomCode"? }` with `reason` one of `cheating`, `collusion`, `abusive_chat`, `offensive_name`, `stalling`, `other`; the app trims `details` to 500 characters.
- **`POST /api/clubs/:code/season`** (owner) starts the next season; the app then re-reads the club. Standings rows carry `points` (all time) and `seasonPoints`; the club carries `season`. An older server without seasons is shown with `points` in both views.

## Implementation notes (where the server differs from the text above)

- `createSignalServer` is async (it loads clubs, restores tables, then listens).
- The hello reply is `{ "t": "hello", "id", "userId", "peerId" }`; `peerId` duplicates `id` for older clients.
- `GET /api/clubs/:code/standings` answers `403 forbidden` ("Join the club first") to non-members rather than the public view; `GET /api/clubs/:code` gives the public view.
- `/api/me.identities` lists provider identities only (never `guest`); `User.avatar` and `User.locale` are `null` when unset.
- The `email` field in `POST /api/auth/link` is ignored; only a provider-verified email is stored.
- Auth `429` responses carry `retry-after: 12`.
- `/health` also reports `storage` (`memory` | `pg`), `snapshots` and `image` (see Health) and, on Postgres, `db: ok | down`.
- `GET /api/users/:userId/clubs` only serves the caller's own id (or `me`); others get `403`.

## Push notifications

`POST /api/push/token` (bearer) body `{ "token": "ExponentPushToken[…]" | null, "platform": "ios" | "android", "locale"?: "en" | "zh-TW" }` → `204`; `null` stops notifications. Notification `data` carries `kind` (`club_table_opened` | `join_approved` | `table_waiting`), `type` (`club` | `table`) and the `club` / `room` codes for the deep link.

## Environment (server)

`DATABASE_URL` (absent → in-memory repositories: nothing survives a restart; sign-in methods do not depend on it: a server is guest-only when neither `APPLE_CLIENT_ID` nor `GOOGLE_CLIENT_IDS` is set), `DATABASE_URL_DIRECT`, `MIGRATE_ON_BOOT`, `AUTH_PEPPER` (+ `AUTH_PEPPER_PREVIOUS`: the earlier pepper, or several comma-separated, newest first; keep it set), `APPLE_CLIENT_ID`, `GOOGLE_CLIENT_IDS` (comma-separated), `FACEBOOK_APP_ID`, `CORS_ORIGINS`, `TRUST_PROXY`, `MAX_HOSTED_TABLES`, `PORT`. See `apps/signal/README.md` and `docs/DEPLOY.md`.

## Store, wallet and entitlements (Phase 4)

Entitlements are decided by the server from store notifications; the app never grants anything itself and only reads `GET /api/me`. The app configures RevenueCat with the server user id as the RevenueCat **app user id** (call `Purchases.logIn(userId)` after the guest bootstrap or a sign-in), and must re-read `/api/me` after a purchase or a Restore (the webhook usually lands within a few seconds; the app polls `/api/me` for 8 s).

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

`active` is computed on the server clock (`serverNow`), so a device clock rolled back changes nothing. `cosmetics` lists every cosmetic the user owns (table looks, tile backs, avatar frames, emote packs and win celebrations, as product ids; the app maps them to `unlocks` through its catalogue).

### Catalogue (server side: `apps/signal/src/catalog.ts`)

| Product id | Kind | Grants |
| --- | --- | --- |
| `diamonds.60`, `diamonds.300`, `diamonds.600` | consumable | 60 / 300 / 600 diamonds |
| `diamonds.1300`, `diamonds.3450`, `diamonds.7500` | consumable | 1,200 + 100 bonus / 3,000 + 450 bonus (15 %) / 6,000 + 1,500 bonus (25 %) |
| `coach.gold.month`, `coach.gold.year` | auto-renewing | Coach Gold: an entitlement named after the plan until the store's expiry |
| `fourwinds.month`, `fourwinds.year` | auto-renewing | The Four Winds Club (everything in Coach Gold, unlimited hand reviews, creating and running clubs): an entitlement named after the plan until the store's expiry |
| Cosmetics: 12 table looks (`theme.*`), 10 tile backs (`back.*`), 12 avatar frames (`frame.*`), 4 emote packs (`emotes.*`), 4 win celebrations (`win.*`), 150 to 600 💎 each | diamonds only | permanent entitlement with the product id |
| 4 sets (`bundle.nightmarket`, `bundle.festival`, `bundle.dragon`, `bundle.garden`), 850 to 1,750 💎 | diamonds only | a permanent entitlement for each item of the set the player does not own yet, at the set's price scaled to the share still missing (`bundlePrice`); `409 owned` when nothing is missing. A set is never an entitlement itself |

App Store product ids are these ids. A Google Play subscription arrives as `<subscription>:<base plan>`, so create the Play subscriptions `coach.gold` and `fourwinds` with base plans `month` and `year`. The tier is the best active plan; refunding or ending one plan never cuts another. Sandbox events (TestFlight, Play testing) grant only when the account that would receive the grant is in `TESTER_USER_IDS` (for a `TRANSFER`, the account the purchases move to; a tester id among the event's aliases does not count) and are otherwise recorded as `ignored_sandbox`. A refunded diamond pack takes back its diamonds even if that leaves a negative balance, which blocks spending until it is paid back; `GET /api/me` then reports a negative `wallet.diamonds`, and the app shows the balance owed. Anything else (VIP cards, club tiers, Coach Diamond, Table Pass) is not sold: events and spends for it grant nothing.

### `POST /api/wallet/sync` (bearer)

Asks the server to fetch this account's purchases from RevenueCat and apply any the webhook missed (the app calls it after Restore). → `{ synced, applied, failed, wallet, cosmetics, coachTier }`. `synced:false` when the server has no `REVENUECAT_SECRET_KEY`. Each purchase is applied on its own: `applied` counts those that were missing, `failed` those that could not be applied this time (the others still were; the app then tells the player the check was incomplete instead of "restored"). A diamond pack already recorded under any account is a duplicate, never a second credit: after a Restore the store lists the old account's packs under the new one, and they stay where they were credited. Errors: `429 rate_limited` (4 a minute), `502 store_unreachable` (RevenueCat could not be read; the app shows the same warning). A nightly job does the same for accounts with store activity in the last 7 days; deleted accounts are skipped. The events a sync writes to `store_events` have ids `sync:<account id>:…`, so the same subscription seen for an old account never blocks its grant to the account it was restored to.

### `POST /api/admin/grant` (`Authorization: Bearer <ADMIN_TOKEN>`)

Support grant. Body `{ userId, diamonds?, bonus?, entitlement?, days?, note }`; writes a `support` ledger entry or an entitlement. A plan from support is kept apart from the same plan bought in the store (its own row, `support:<plan>`; `GET /api/me` shows one line per plan with the later expiry), so a store refund, expiry or `TRANSFER` never takes time that support granted. `401` wrong token, `404` unknown user, `503` when `ADMIN_TOKEN` is unset.

### `POST /api/wallet/spend` (bearer)

Body `{ "productId": "theme.jade" }` → `200 { "spent": 400, "entitlement": "theme.jade", "wallet": { "diamonds", "bonusDiamonds" }, "cosmetics": [...] }`. Any cosmetic or set of the catalogue may be bought this way. The debit and the grant are one transaction; bonus diamonds are spent first. For a set, `entitlement` is the set's id, `spent` the scaled price, and `cosmetics` (everything the account now owns) includes the items it unlocked.

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
| `INITIAL_PURCHASE`, `RENEWAL` | Subscription: entitlement until `expiration_at_ms` (never shortened by a late, older event); purchase row recorded with the end of the period it paid for (`period_ends_at`, which a later refund reads). A consumable sent as `INITIAL_PURCHASE` is credited like `NON_RENEWING_PURCHASE` |
| `NON_RENEWING_PURCHASE` | Diamond pack credited (diamonds + bonus), once per `transaction_id` across all accounts: a transaction already recorded under another account answers `duplicate` |
| `CANCELLATION` | Auto-renew off: nothing changes until expiry. `cancel_reason: CUSTOMER_SUPPORT` (a refund): the time the refunded transaction paid for ends now, and no more than that. Each first purchase and renewal is recorded with the end of the period it paid for (`purchases.period_ends_at`, migration `0009_purchase_periods.sql`), and another period of the same plan that was paid for and not itself refunded stands: a refund of last month's charge leaves the running month, and a renewal the store charged early and then refunded leaves the rest of the month already paid for. A refund that names no transaction ends the plan at once. Only purchases on record count: a period granted by reconciliation alone (`POST /api/wallet/sync`, the nightly job) has no purchase row and does not hold up a refunded one, and rows older than the migration have no period end and are treated the same way. Time granted by support always stays. For a diamond pack the whole pack is taken back, bonus first, from the account that holds the purchase (found by `transaction_id`, which after a Restore or a merge may not be the account the event names), and purchased diamonds may go below zero, which blocks every spend until a purchase covers the debt. The refund is remembered by `transaction_id`, so a purchase or renewal event for that transaction delivered later (a retry) grants nothing and answers `refunded` |
| `UNCANCELLATION`, `SUBSCRIPTION_EXTENDED` | Entitlement carried to `expiration_at_ms` if that is later |
| `EXPIRATION` | Entitlement ends (ignored when a later renewal already extended it) |
| `BILLING_ISSUE`, `PRODUCT_CHANGE`, `SUBSCRIPTION_PAUSED` | Recorded only (the store retries billing; the new product arrives with its `RENEWAL`; a pause ends with an `EXPIRATION`) |
| `TRANSFER` | Store-granted plans bought on the event's `store` move from `transferred_from` to the first known `transferred_to` account (later expiry wins). A plan the old account bought on another store stays, as do support grants and diamonds; a plan with no purchase on record moves |
| `TEST` | Recorded only |

`outcome` is one of `credited`, `entitled`, `extended`, `expired`, `refunded`, `transferred`, `recorded`, `test`, `duplicate`, `ignored_unknown_user`, `ignored_unknown_product`, `ignored_sandbox`, `ignored_stale`, `ignored_type`.

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

`GET /health` → `{ "ok": true, "peers", "rooms", "hostedTables", "tables", "actionLatency": { "samples", "p50Ms", "p95Ms", "maxMs", "windowSeconds": 300 } | null, "pushEnabled", "storeEnabled", "storage": "memory" | "pg", "snapshots": { "saved", "failed", "lastSavedAt", "lastFailedAt" }, "image": string | null, "db"?: "ok" | "down" }`. `snapshots` counts table snapshot writes since boot (a growing `failed` means tables are not reaching storage); `image` is `FLY_IMAGE_REF`, so a check can tell which build answered. `actionLatency` is the time from a player's action frame reaching a hosted table to the resulting state having been sent, over the last five minutes. See `docs/OBSERVABILITY.md`.

## Environment (server, Phases 4 and 6)

`REVENUECAT_WEBHOOK_SECRET` (absent → webhook 503, `storeEnabled: false`), `EXPO_ACCESS_TOKEN` (absent → no push, `pushEnabled: false`), `SENTRY_DSN` (+ optional `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`; absent → errors only logged), `POSTHOG_KEY` (+ optional `POSTHOG_HOST`; absent → no server events).
