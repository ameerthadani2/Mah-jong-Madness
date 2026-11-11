# @mjm/signal

The game server for Mahjong Mania. Every online table runs on the server, which acts as a neutral host; players connect to it over one WebSocket each. The same process serves the accounts, sessions, configuration and clubs HTTP API. The contract with the app is [`docs/API.md`](../../docs/API.md); deployment is in [`docs/DEPLOY.md`](../../docs/DEPLOY.md).

```bash
npm run signal                 # from the repository root (tsx src/main.ts), port 8787
npm run build -w @mjm/signal   # esbuild bundle: dist/server.cjs
node dist/server.cjs migrate   # apply pending migrations and exit
```

With no environment at all the server runs: accounts, clubs and tables are kept in memory, sign-in is guest-only and a random session pepper is used (each logs a warning). The store webhook answers 503, no push is sent, and errors and events go nowhere but the log. Tests run that way.

## Layout

| File | Purpose |
| --- | --- |
| `src/main.ts` | Entry point: reads the environment, builds the repositories, the session service and the providers, calls `createSignalServer`, saves tables on SIGTERM |
| `src/server.ts` | `createSignalServer({ port, repos, sessions, providers, config })` → `{ http, wss, rooms, clubs, persister, api, address(), close() }`. Nothing runs at import time |
| `src/api.ts` | The HTTP routes below |
| `src/sockets.ts` | WebSocket limits, the `hello` session handshake, heartbeat, routing into the room registry |
| `src/rooms.ts` | Rooms, hosted tables, the club table gate, keep-alive |
| `src/clubs.ts` | Clubs, members, standings and seasons, table listings; writes each changed club through `repos.clubs`; emits `table_opened` / `member_approved` for push |
| `src/catalog.ts` | The server's product table (diamond packs, Coach Gold and The Four Winds Club, cosmetics and sets); ids match `apps/mobile/src/monetisation/catalog.ts` |
| `src/matchmaking.ts` | The quick-match queue: arrival-order groups of four, Club bots after `QUICK_MATCH_FILL_MS`, blocked pairs apart, banned and under-17 accounts refused, one quick-match table per account, each table charged to its players' create allowance |
| `src/moderation.ts` | The name check (look-alike letters, accents, digits and symbols for letters, Traditional and Simplified), `/api/blocks`, and the moderators' routes behind `ADMIN_TOKEN` (report queue, ban with the account's devices, mute, birth-year correction) with the in-memory mute list the tables ask |
| `src/admin.ts` | `POST /api/wallet/sync` (store reconciliation after Restore) and `POST /api/admin/grant` (support grants behind `ADMIN_TOKEN`) |
| `src/reconcile.ts` | RevenueCat REST client and the nightly reconciliation of missed store events |
| `src/wallet.ts` | `WalletService`: credits, diamond spends, store events applied once (idempotent on the event id) |
| `src/revenuecat.ts` | RevenueCat webhook authentication and payload mapping to a vendor-neutral `StoreEvent` |
| `src/push.ts` | `PushService` over `expo-server-sdk` (rate limits, receipts) and `SeatWatcher` ("your table is waiting") |
| `src/metrics.ts` | The action-latency window behind `/health` |
| `src/observability.ts` | Optional Sentry (`reportError`) and PostHog (`purchase_credited`, `report_filed`) |
| `src/persist.ts` | Table snapshots: debounced writes, restore at boot, pruning |
| `src/auth/*` | Guest accounts, session tokens, provider token verification, link/merge/deletion |
| `src/repos/*` | Storage: memory, or Postgres when `DATABASE_URL` is set |
| `migrations/*.sql` | The Postgres schema, applied in order by `src/migrate.ts` |

## Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | TCP port for both HTTP and WebSocket traffic |
| `DATABASE_URL` | none | Pooled Postgres connection string (Neon: the `-pooler` host, `?sslmode=require`). Absent: in-memory storage, lost on restart |
| `DATABASE_URL_DIRECT` | `DATABASE_URL` | Direct (unpooled) string, used by migrations and by the single-host advisory lock |
| `ALLOW_EPHEMERAL` | off | `1` lets `NODE_ENV=production` start without `DATABASE_URL`/`AUTH_PEPPER` (in-memory storage, random pepper). Without it a production boot missing either refuses to start |
| `MIGRATE_ON_BOOT` | off | `1` applies pending migrations before the server starts (`fly.toml` also runs them as the release command) |
| `AUTH_PEPPER` | random per process | Secret mixed into every stored session and guest-secret hash. Without it every session ends when the process stops. Keep a copy: losing it signs every player out |
| `AUTH_PEPPER_PREVIOUS` | none | The old pepper during a rotation; tokens hashed with it keep working and are re-hashed on first use |
| `APPLE_CLIENT_ID` | none | Sign in with Apple: the bundle id (and Services ID), comma-separated. Absent: Apple sign-in is off and hidden in the app |
| `GOOGLE_CLIENT_IDS` | none | Google OAuth client ids (iOS, Android, web), comma-separated. Absent: Google sign-in is off |
| `FACEBOOK_APP_ID` | none | Facebook Limited Login. Absent: off |
| `HOST_TABLES` | on | Set to `0` to stop the server hosting tables. A hosted `create` is then refused with `Hosted tables are disabled` (never turned into a relay-only room) |
| `MAX_HOSTED_TABLES` | `500` | Maximum number of tables the server hosts at once |
| `MAX_TABLES_PER_USER` | `3` | Unfinished tables one account may have opened (socket or API); restored tables count |
| `TRUST_PROXY` | `0` (off) | The number of reverse proxies you run in front of the server. The client IP is then the `x-forwarded-for` entry that many places from the right: `1` takes the rightmost entry (the address your proxy appended), `2` the one before it, and so on. Entries further left are written by the client and are never used. Set it to exactly the number of proxies; with `0` the header is ignored and the TCP peer address is used. `true`/`on` still mean `1`. Fly: `1` |
| `CORS_ORIGINS` | none | Comma-separated list of browser origins allowed to call the HTTP API. With no list, CORS headers are never sent, so only same-origin pages (and native apps, which are not subject to CORS) can call it. For the Expo web preview use `CORS_ORIGINS=http://localhost:8081`. `*` allows any origin |
| `MIN_BUILD` | `0` | Oldest app build allowed online, reported as `GET /api/config.minBuild` |
| `MAINTENANCE_MESSAGE` | none | Reported as `GET /api/config.maintenance`; the app shows it instead of online play |
| `P2P_ROOMS` | off | Set to `1` to allow relay-only rooms in which a player's device is the host. For development only |
| `REVENUECAT_WEBHOOK_SECRET` | none | The value RevenueCat sends as `Authorization: Bearer <secret>` on its webhook (set the header to `Bearer <secret>` in the RevenueCat dashboard). Absent: `POST /api/webhooks/revenuecat` answers 503 and `/api/config.storeEnabled` is false |
| `REVENUECAT_SECRET_KEY` | none | RevenueCat secret API key for reconciliation (`GET /v1/subscribers/{id}`). Absent: `POST /api/wallet/sync` answers `synced:false` and the nightly job does nothing |
| `TESTER_USER_IDS` | none | Comma-separated account ids whose sandbox (TestFlight / Play test) purchases are granted. Everyone else's sandbox events are recorded as `ignored_sandbox` |
| `ADMIN_TOKEN` | none | Bearer token for `/api/admin/*` (support grants, the report queue, bans and mutes). Absent: those routes answer 503 |
| `QUICK_MATCH_FILL_MS` | `20000` | How long a quick-match group of one to three humans waits before Club bots fill its empty seats (1 to 600,000 ms) |
| `EXPO_ACCESS_TOKEN` | none | Expo access token for push (`expo-server-sdk`). Absent: no push is sent and `/api/config.pushEnabled` is false |
| `SENTRY_DSN` | none | Sentry project DSN for server errors. Absent: errors are only logged. `SENTRY_ENVIRONMENT` (default `production`) and `SENTRY_RELEASE` (default `FLY_IMAGE_REF`) are optional |
| `POSTHOG_KEY` | none | PostHog project key for the server events `purchase_credited` and `report_filed`. Absent: none are sent. `POSTHOG_HOST` is optional (PostHog's US cloud by default; `https://eu.i.posthog.com` for the EU) |
| `DATABASE_URL_TEST` | none | Tests only: a database the Postgres repository and migration tests may create and drop schemas in. Absent: those tests are skipped |
| `DATA_DIR` | — | No longer read (clubs used to live in `clubs.json`); the server warns if it is still set |

## Persistence

- **Clubs** live in memory for fast reads and membership checks; each change writes that one club behind it through `repos.clubs` (writes for a club run in order, and a burst of changes becomes one write). Every club is loaded at boot.
- **Tables**: every hosted table is written to `table_snapshots` (`host.serialize()`) 500 ms after it changes and at most every 2 s while a hand is played, and at once at the end of each hand and of the match. At boot every snapshot that has not finished is restored under its own code; players reclaim their seats with their rejoin tokens (bots play for them meanwhile). SIGTERM and `close()` write every table one last time without finishing it. Finished snapshots are pruned after 24 hours.
- **Club listings** of restored tables stay open; listings whose table did not come back (ghosts) are removed at boot so they no longer count against the open-table cap; finished listings are dropped after 24 hours.
- **Keep-alive**: a table with nobody connected is kept for 15 minutes after its last activity while a human holds a seat. A table opened over the socket closes as soon as its lobby empties; one opened through the API or restored waits 15 minutes for its first player.
- **Results**: `match_results` gets a row at every `match_over`; club standings are updated from the same event when the match counts (a house-rules table that started with at least two human club members, no account in two seats). The members seated at the start are recorded on the table listing, and each is charged their seat's result even if they have left the club or the table since; a member who leaves keeps their standings on file (`club_former_members`), hidden, and gets them back on rejoining.
- **Purged accounts**: the hourly purge returns the ids it removed and the club registry drops those members, join requests and standings on file from its clubs in memory (`ClubRegistry.dropPurged`); the Postgres club write also skips rows whose user no longer exists, so a club never stops saving because an account has gone.

## Limits

"Per IP" and "per address" mean per IPv4 address or per IPv6 /64 prefix everywhere below: one IPv6 customer holds a whole /64, so its addresses share one allowance (`addressKey` in `src/limits.ts`; an IPv4 address written as IPv6, `::ffff:a.b.c.d`, is that IPv4 address).

| Limit | Value | When exceeded |
| --- | --- | --- |
| WebSockets per IP | 20 at once | The extra socket is closed with 1008 `Too many connections` |
| Messages per socket | 30/s, burst 60 | The socket is closed with 1008 `Rate limit exceeded` |
| Message size | 64 KiB | The socket is closed with 1009 (message too big). A malformed frame closes it with 1002 (or 1007 for text that is not UTF-8). Other sockets are unaffected |
| Session handshake | first frame, within 10 s | Closed with 4401 `Unauthorised` for a missing or refused token only; with 1013 (try again later) when the database could not check the token, or was still checking it when the 10 s ran out (the app keeps its session and reconnects) |
| Session re-check | before a `create`, `join` or `queue`, at most once every 5 s per socket (`LIMITS.sessionRecheckMs`) | A session that ended quietly (it expired) closes the socket with 4401 at the first such frame after the 5 s; logout, ban, deletion and revocation through the API close it at once. A frame whose create or join allowance is spent is refused before any database work |
| Client heartbeat | the app sends `{t:"ping"}` every 15 s | The server answers `{t:"pong"}`; an app with no answer for 10 s closes the link and reconnects |
| HTTP requests per IP | 10/s, burst 30 | `429 {error:"rate_limited"}` with `retry-after: 1` |
| `/api/auth/*` requests | 5 a minute per IP and 5 a minute per user | `429 {error:"rate_limited"}` with `retry-after: 12` |
| HTTP body | 64 KiB (bytes) | `413 {error:"too_large"}` (a body over 1 MiB is not read to the end: the connection closes after the answer) |
| Room creation | 1 per 10 s per account (per socket without one), and 6 a minute per IP, however often the client reconnects. One allowance for a socket `create`, a club table opened with `POST /api/clubs/:code/tables` and a quick-match table; a table refused for another reason (the club's answer, the table cap, a full server) costs nothing | Socket: `{t:"error", message:"Please wait a few seconds before creating another room"}`. API: `429 {error:"rate_limited"}` with `retry-after: 12`. Quick match: the player waits in the queue until it has one |
| Join attempts | 5 per 10 s per account (refills at one every 2 s), and 20 per 10 s per IP | `{t:"error", message:"Too many join attempts; please wait a few seconds"}` |
| Open tables per account | `MAX_TABLES_PER_USER` (default 3) unfinished tables the account opened, over the socket or the API; restored tables count, finished ones do not | Socket: `{t:"error", code:"table_cap", message:"You already have the most tables open; …"}`. API: `503 {error:"unavailable"}` |
| Hosted tables | `MAX_HOSTED_TABLES` | Socket: `The server is full right now; …`. API: `503 {error:"unavailable"}` |
| Peers per room | 12; at a hosted table, 4 of them for peers without a seat (watchers), and one watcher place per account however many sockets it opens. A player whose account holds a seat always gets back in. While the table is in its lobby with a seat open, a would-be player is always admitted: at 12 peers the watcher that has been there longest without sitting down makes way | `Room not found or full` (the same reply as for an unknown code, so codes cannot be probed). The watcher that made way gets `{t:"error", code:"closed", message:"A player needed your place at this table; join again to sit down."}` |
| Free text | display and seat names 24, club and table names 40, club descriptions 280, report details 1,000 characters; table chat is not free text (a quick-phrase id or an emote id, anything else is dropped) | Cleaned (`cleanField`: controls including NUL, bidi overrides and invisible characters removed) and cut, never split inside an emoji; a club name that cleans to nothing is `400` |
| Database queries | 5 s each (and `statement_timeout` on a direct connection) | The request fails; `/health` answers 503 `db:"down"` after 2 s without an answer |
| Clubs per user | 10 (owned, joined or pending) | `409 {error:"limit"}` |
| Members per club | 200 (pending requests have the same cap) | `409 {error:"limit"}` |
| Joining clubs over the API | 10 new memberships or requests an hour per address (all clubs), 60 an hour per club | `429 {error:"rate_limited"}`; a bulk reject gives the club its allowance back |
| Pending join requests | kept 30 days | Dropped at the hourly prune or when the next person asks to join; the account may ask again |
| Open tables per club | 5 (finished tables do not count); 1 once the owner's Four Winds Club plan has lapsed for 7 days while the store is live | `409 {error:"limit"}` |
| Clubs owned per user | 3: creating, being handed one, or inheriting one from a deleted owner. A merge, or a hand-over with nobody under the cap, can exceed it | `409 {error:"limit"}`; a club beyond the 3 a plan covers runs on the lapsed cap |
| Standings kept for members who left | 1,000 per club | The longest gone are dropped |
| Banned accounts per club | 500 | `409 {error:"limit"}` |
| Player reports | 10 per reporter in any 24 hours | `429 {error:"rate_limited"}` |
| Push notifications | 1 a minute per user for each kind | Skipped (not queued) |
| Archived club seasons | the latest 24 | The oldest is dropped |

## Boot and shutdown

- **Fail closed.** With `NODE_ENV=production`, a missing `DATABASE_URL` or `AUTH_PEPPER` stops the boot (exit 1, with the reason) unless `ALLOW_EPHEMERAL=1` is set, which keeps the in-memory server on purpose (the CI image check sets it).
- **One host per database.** With Postgres, `main.ts` first takes a session advisory lock (`pg_try_advisory_lock`) on its own connection from `DATABASE_URL_DIRECT` (falling back to `DATABASE_URL` with a warning; a transaction pooler cannot hold it), retrying every second for 30 s, then exiting 1. Nothing is loaded or restored before the lock is held. The lock is watched from the moment it is taken: if its connection fails while the clubs load, the tables are restored or the port is bound, the boot stops (`HostLockLostError`, exit 1) without listening and without writing any table, because another process may already own them. If it fails or stops answering once the server is up, the server freezes its tables, writes them and exits 1 so the platform restarts it. Memory storage needs no lock.
- **Shutdown** (SIGTERM, `close()`): new HTTP requests get 503 and socket upgrades are refused, `/health` answers 503 `{ok:false, draining:true}`, game input stops, every table is written, every socket closed, and only then is the host lock released. A 20 s deadline bounds it, even with a hung database.
- **Health.** `/health` is 503 `{ok:false, db:"down"}` when the database does not answer within 2 s.

Room codes, club codes and peer ids come from the platform's secure random source. Each random byte is masked with `& 31` to index a 32-character alphabet, which avoids modulo bias.

Every rule set received from a client (WebSocket `create`, club create/update, table create) goes through `sanitizeRules`. Unknown keys are dropped, numbers are clamped to `RULE_LIMITS`, and booleans must be real booleans. Club settings keep only the two known booleans and a known bot skill. A field that has the wrong type returns `400`, never `500`.

## HTTP API

JSON in and out. Errors are `{ "error": "<code>", "message": "<English sentence>" }`; the codes and statuses are listed in `docs/API.md`. "Bearer" means `Authorization: Bearer mjs_<64 hex>` is required (`401 invalid_session` / `session_expired` / `session_revoked` otherwise).

| Route | Auth | Body | Answer |
| --- | --- | --- | --- |
| `GET /health` | none | | `{ ok, peers, rooms, hostedTables, tables, actionLatency: { samples, p50Ms, p95Ms, maxMs, windowSeconds } \| null, pushEnabled, storeEnabled, storage: "memory"\|"pg", db?: "ok"\|"down" }` (see `docs/OBSERVABILITY.md`) |
| `GET /api/config` | none | | `{ authProviders, storeEnabled, pushEnabled, minBuild, maintenance, serverNow }` |
| `POST /api/auth/guest` | none | `{ device: { id, platform, appBuild, locale }, displayName?, avatar? }` | `201 { userId, guestSecret, session: { token, expiresAt }, user }` |
| `POST /api/auth/guest/login` | none | `{ userId, guestSecret, device }` | `{ session, user }` or `401 invalid_credentials`; five failures a minute per IP and user id → `429` (the user's own auth bucket is spent only by a correct secret) |
| `POST /api/auth/refresh` | bearer | | `{ session }`; the old token works for 5 more minutes and cannot be refreshed again (`401 session_rotated`) |
| `POST /api/auth/logout` | bearer | | `204`; this session only. The device's push token is removed and the table socket this session opened is closed with 4401 |
| `POST /api/auth/link` | bearer | `{ provider, token, nonce, email? }` | `{ session, user, merged, guestSecret? }`; `guestSecret` is the rotated guest secret the device must store (the old one stops working). `400 invalid` without a nonce, `409 identity_in_use`, `401 invalid_token`, `404 provider_disabled`. A merge closes the guest's sockets with 4401 |
| `POST /api/auth/login` | none (or a guest bearer) | `{ provider, token, nonce, device }` | `{ session, user }` or `404 not_linked`; `400 invalid` without a nonce |
| `DELETE /api/auth/identities/:provider` | bearer | | `204`, `409 last_identity` or `404 not_found` |
| `GET /api/me` | bearer | | `{ user, wallet: { diamonds, bonusDiamonds }, entitlements: [{ entitlement, expiresAt, active }], cosmetics: ["theme.jade", …], coachTier: "free"\|"gold"\|"fourwinds", storeEnabled, identities: [{ provider, email? }], serverNow }` |
| `PATCH /api/me` | bearer | `{ displayName?, avatar?, locale?, birthYear? }` | `{ user }`; the new name and avatar are written into every club the user is in. A name the name check refuses (slurs, profanity, staff titles; also club names) answers `400 name_not_allowed`; a guest signing up with one is created without it (`nameRefused: true`). `birthYear` is write-once: another year, or `null`, once one is on file answers `409 birth_year_locked` |
| `DELETE /api/me` | bearer | | `204`; soft delete, every session ends (sockets closed with 4401), club rows become "Deleted player", a club the user owned passes to its senior admin or earliest member who owns fewer than 3 clubs (or is dissolved when nobody live is left), the row is purged after 30 days and its club rows with it |
| `POST /api/clubs` | bearer | `{ name, rules?, settings? }` | the club; the caller is its owner. With the store live, `403 fourwinds_required` without The Four Winds Club; at most 3 owned |
| `DELETE /api/clubs/:code` | bearer (owner) | `{ confirm }` (the club's name or code) | `204`; its live tables close |
| `GET /api/clubs/:code` | bearer | | members: the club; anyone else: `{ code, name, description, memberCount, joinRequiresApproval }` |
| `PATCH /api/clubs/:code` | bearer (owner/admin) | `{ name?, description?, rules?, settings? }` | the club |
| `POST /api/clubs/:code/join` | bearer | | `{ club, status: "joined"\|"pending"\|"already" }` (`club` is the public view until membership); standings left on file come back; `429` past 10 an hour per address or 60 an hour per club |
| `POST /api/clubs/:code/members/:userId/approve` | bearer (owner/admin) | | the club |
| `POST /api/clubs/:code/members/:userId/reject` | bearer (owner/admin) | | the club |
| `POST /api/clubs/:code/pending/reject-all` | bearer (owner/admin) | `{ userIds? }` | `{ club, rejected }`; every pending request, or only those named |
| `POST /api/clubs/:code/bans` / `DELETE /api/clubs/:code/bans/:userId` | bearer (owner/admin) | `{ userId }` | the club; a banned account cannot rejoin, reapply or join the club's tables, and leaves its live tables |
| `POST /api/clubs/:code/tables/:table/close` | bearer (owner/admin) | | the club; the table ends at once, nothing counts |
| `POST /api/clubs/:code/tables/:table/evict` | bearer (owner/admin) | `{ userId }` | `{ seats }`; a bot plays the seat, the player is told and cannot come back to that table |
| `POST /api/clubs/:code/members/:userId/role` | bearer (owner) | `{ role }` | the club; `409 limit` when `owner` would give a member a fourth club |
| `DELETE /api/clubs/:code/members/:userId` | bearer (self, owner or admin) | | the club (public view after leaving); a removed member also leaves the club's live tables; the member's standings stay on file and a match they started still counts |
| `GET /api/clubs/:code/standings` | bearer (member) | | members by season points, each with `seasonPoints`, `lifetimePoints` (also `points`) and `season`; `403` for non-members |
| `POST /api/clubs/:code/season` | bearer (owner) | | `{ club, archived: { season, startedAt, endedAt, standings } }`; season points reset to 0, lifetime points kept |
| `GET /api/users/:userId/clubs` | bearer (self; `me` works) | | the caller's clubs and pending requests |
| `POST /api/clubs/:code/tables` | bearer (member; admins only if the club says so) | `{ label?, rules?, botSkill? }` | the listed table; a member's table uses the house rules, an owner's or admin's with other rules is a variant (never ranked); bots are the club's. Members with push tokens (not the opener) are notified |
| `POST /api/wallet/spend` | bearer | `{ productId }` | `{ spent, entitlement, wallet, cosmetics }`; `409 insufficient`, `409 owned`, `404 not_for_sale` |
| `POST /api/webhooks/revenuecat` | `Bearer <REVENUECAT_WEBHOOK_SECRET>` | RevenueCat v1 event | `{ ok, outcome, duplicate }`; `401` bad secret, `503` secret unset, `400` not an event |
| `POST /api/reports` | bearer | `{ reportedUserId, roomCode?, reason, details? }` | `201 { id, status, createdAt }`; `404` unknown player; `429` after 10 a day per user or 30 a day per IP |
| `GET /api/blocks` / `POST /api/blocks` / `DELETE /api/blocks/:userId` | bearer | `{ userId }` (POST) | `{ blocks: [{ userId, displayName, avatar, createdAt }] }`, `201` the block, `204`; `400` yourself, `404` unknown player |
| `GET /api/admin/reports?status=open` | `Bearer <ADMIN_TOKEN>` | | `{ reports: [{ id, status, reason, details, room, createdAt, reporter, reported }] }`, oldest first |
| `POST /api/admin/reports/:id/resolve` | `Bearer <ADMIN_TOKEN>` | `{ action: "dismiss"\|"warn"\|"ban"\|"mute", days?, reason? }` | `{ ok, id, status, action }`; `ban` and `mute` act on the reported account; `409 resolved`. The report is claimed before its action is applied (one transaction), so of two moderators deciding at once one action is applied and the other gets `409` |
| `POST /api/admin/users/:id/ban` / `DELETE` | `Bearer <ADMIN_TOKEN>` | `{ reason? }` | `{ ok, account }`; sessions revoked, sockets closed with 4403, sign-in and refresh `403 banned` until lifted. The ban covers the account's devices: a new guest from one of them (`POST /api/auth/guest`) is `403 banned` until the ban is lifted |
| `POST /api/admin/users/:id/mute` | `Bearer <ADMIN_TOKEN>` | `{ days }` (0 lifts it) | `{ ok, account }`; chat and emotes dropped at every table until it ends |
| `POST /api/admin/users/:id/birth-year` | `Bearer <ADMIN_TOKEN>` | `{ birthYear }` (a year, or `null` to clear it) | `{ ok, account }`; the only way to change a birth year once it is on file |
| `POST /api/push/token` | bearer | `{ token: "ExponentPushToken[…]", platform: "ios"\|"android" }` or `{ token: null }` | `204`; stored on this session's device (and removed from any other device that had it) |

Club members are identified by the session's user id; their name and avatar come from the user record (a guest without a name shows as `Player XXXX`).

## Store, wallet and entitlements

Entitlements are decided here, never on the phone. The app buys through RevenueCat with our user id as the RevenueCat app user id; RevenueCat calls `POST /api/webhooks/revenuecat`; `WalletService` writes the event to `store_events` (raw, keyed by event id) in the same transaction as its effects, so a redelivered event changes nothing. Diamond packs credit purchased diamonds plus the pack's bonus once per store transaction; each subscription plan sets its own entitlement (`coach.gold.month`, `coach.gold.year`, `fourwinds.month`, `fourwinds.year`) until the store's expiry, and the tier is the best active one, so refunding or ending one plan never cuts another (late or out-of-order events never shorten it); a refund remembered before its purchase arrives stays a refund; sandbox events grant only to `TESTER_USER_IDS`; a refunded pack can leave a negative balance, which blocks spending until it is paid back; a refund (`CANCELLATION` with `cancel_reason: CUSTOMER_SUPPORT`) ends a subscription or takes back what is left of a pack; `EXPIRATION` ends it; `TRANSFER` moves store entitlements to the new account. `BILLING_ISSUE`, `PRODUCT_CHANGE`, `SUBSCRIPTION_PAUSED` and `TEST` are recorded only. Events for an unknown user or a product the catalogue does not sell are recorded and acknowledged (200) so RevenueCat stops retrying. Table looks are bought with diamonds through `POST /api/wallet/spend` (bonus diamonds are spent first) and never expire. Diamonds have no monetary value and cannot be redeemed or transferred.

## Push

`PushService` sends through Expo when `EXPO_ACCESS_TOKEN` is set: *club table opened* (to members with tokens, not the opener), *join request approved*, and *your table is waiting* (a seated human disconnected for 30 s of play while a hand is in progress, noticed by `SeatWatcher` on the server tick; a player who left the table on purpose is not chased). Each kind reaches a user at most once a minute. Signing out removes the device's token. Copy is English, or Traditional Chinese for a device whose locale starts with `zh`. Tickets and, 15 minutes later, receipts reporting `DeviceNotRegistered` clear that token.

## WebSocket protocol (JSON frames)

Client → server
| Message | Purpose |
| --- | --- |
| `{t:"hello", auth}` | Must be the first frame. `auth` is the session token. The server replies `{t:"hello", id, userId}` (`peerId`, the same as `id`, is kept for older clients); the id is assigned by the server and never changes. A missing or rejected token closes the socket with 4401 (4403 for a banned account, also when a moderator bans it later), and so does a session that ends later (logout, deletion, merge, revocation): at once from the API, or at the next `create` or `join`, before which the token is checked again |
| `{t:"create", hosted:true, rules?, botSkill?, club?}` | Create a room whose table the server hosts. `botSkill` is `beginner`, `club` or `pro`. With `club` it is a club table: only full members may open one (`Join the club first` otherwise) and it is listed in the club. Without `hosted:true` (and no `club`) the request is refused unless `P2P_ROOMS=1`; with `HOST_TABLES=0` it is refused with `Hosted tables are disabled` |
| `{t:"join", room}` | Join by code (case-insensitive). A club table admits full members only |
| `{t:"to", to, data}` | Relay `data` to a peer in the same room. A game `join` sent to the hosted table always carries the verified `userId`, whatever the client put there |
| `{t:"leave"}` | Leave the room |
| `{t:"ping"}` | Heartbeat; answered with `{t:"pong"}`. The app sends one every 15 s and reconnects after 10 s without an answer |
| `{t:"queue", preset?:"normal"}` | Quick match: wait to be seated with strangers (see docs/API.md, "Quick match"). Needs an account that is not banned, a birth year making it 17 or older, and no seat at an unfinished quick-match table (one it left on purpose does not count); spends the `join` allowance, and the table it is seated at spends its `create` allowance |
| `{t:"leave_queue"}` | Leave the quick-match queue (answered `{t:"queue_left"}`) |

Server → client
| Message | Purpose |
| --- | --- |
| `{t:"room", room, peers, host}` | Sent once in reply to each successful `create` or `join`. `host` is the peer to send game messages to |
| `{t:"peer", peerId, event}` | A peer joined or left |
| `{t:"from", from, data}` | Relayed data |
| `{t:"error", code?, message}` | Sent once in reply to a refused `create` or `join`. `code:"room_unavailable"` (`Room not found or full`) is definitive, so a client stops reconnecting to that room |
| `{t:"queue_status", position, waitedMs, humans, fillMs}` | While queued: at once and every 2 s |
| `{t:"matched", room, humans, bots}` | A quick-match table is ready: join it by code. Only the matched accounts may; it starts by itself once all of them sit, or after 15 s with bots in the empty seats, and closes 2 minutes after its last player disconnected (at once when every player left it on purpose) |
| `{t:"queue_error", code, message, room?}` | Queue refusal: `banned`, `age_missing` (no birth year on the server), `age_under` (under 17), `seated` (still holding a seat at an unfinished quick-match table, or expected at one just opened: `room` is its code), `rate_limited`, `sign_in`, `unavailable`, or `replaced` (the account queued from another socket) |
| `{t:"error", code:"closed", message}` | The host of a relay-only room left, so the room has closed. Sent unprompted to every peer still in it; they are no longer in a room |

The host role never moves: a relay-only room closes when its host leaves, because a guest promoted to host would hold none of the table's state.

Game traffic is wrapped as `{ch:"game", msg}`, so other channels can share the same socket. On a dropped socket the app reconnects with backoff, sends `hello` and `join` again and rejoins its seat with the rejoin token from `welcome`.

## Tests

`npm test -w @mjm/signal`. `catalog.test.ts` checks the product table against the app's catalogue; `wallet.test.ts`, `webhook.test.ts` (recorded-style RevenueCat payloads, replays, bad and unset secrets), `reports-seasons.test.ts`, `push.test.ts` (a fake Expo client) and `health.test.ts` cover Phases 4 and 6. `matchmaking.test.ts` covers quick match (fill timing on a fake clock, blocked pairs, refusals, one entry per account, the restricted self-starting table, mutes, and a real-socket run with three clients), `matchmaking-limits.test.ts` its limits (one table per account, the create charge, the two-minute close, one address against a small server) and `moderation.test.ts` the name check, blocks, bans and the moderators' routes; `moderation-names.test.ts` is the name check name by name, `moderation-accounts.test.ts` (memory, and Postgres when `DATABASE_URL_TEST` is set) the refused sign-up name, the write-once birth year, device bans, concurrent sign-ups with one device id and two moderators on one report, and `table-emotes.test.ts` the paid-emote ownership check. `test/e2e.test.ts` runs the real server on port 0 with memory repositories and two `ws` clients through `SignalingClient`: full hands with verified audits, a dropped socket rejoining, the club gate, the flood limit, and a restart over the same repositories that restores a table mid-hand. The Postgres cases in `repos.test.ts` and `migrate.test.ts` run when `DATABASE_URL_TEST` is set (CI sets it).
