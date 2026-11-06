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
- `PATCH /api/me` (bearer) body `{ "displayName"?, "avatar"?, "locale"?, "birthYear"? }` → `{ "user": User }`.
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
5. The session is checked again before every `create` and `join`, and a session that ends while the socket is open (logout, `DELETE /api/me`, a merge, a link ending the account's other sessions, a revocation or expiry) closes the socket with `4401`. The seat stays reclaimable: obtain the current session (refresh, or sign in again), then reconnect with `hello` + `join` and the rejoin token. A token that was refreshed more than 5 minutes ago is treated the same way at the next `create` or `join`.

## Clubs

All `/api/clubs*` routes take the bearer session (the caller's user id is the member id; name and avatar come from the user record); member lists and standings are members-only; non-members get the public view `{ code, name, description, memberCount, joinRequiresApproval }`. `Club` (members' view) is `{ code, name, description, ownerId, createdAt, rules, settings: { membersCanOpenTables, joinRequiresApproval }, members: [{ userId, name, avatar?, role: "owner"|"admin"|"member", joinedAt, points, seasonPoints, matchesPlayed, matchesWon, handsWon }], pending: [{ userId, name, avatar? }], tables: [{ code, label, rules, createdBy, createdAt, status: "open"|"playing"|"finished", players: [{ seat, name, userId?, isBot, connected }], handNumber, scores }], season, seasonStartedAt, seasons }`. `rules` is a rule set as in `@mjm/engine` (`sanitizeRules` applies); `settings` and `rules` are partial on input.

| Route | Auth | Body | Answer |
| --- | --- | --- | --- |
| `POST /api/clubs` | bearer | `{ "name", "rules"?, "settings"? }` | `200 Club`; the caller is its owner. `400 invalid` (name), `409 limit` (clubs per user) |
| `GET /api/clubs/:code` | bearer | | members: `Club`; anyone else: the public view. `404 not_found` |
| `PATCH /api/clubs/:code` | bearer (owner or admin) | `{ "name"?, "description"?, "rules"?, "settings"? }` | `200 Club`; `403 forbidden` |
| `POST /api/clubs/:code/join` | bearer | | `200 { "club", "status": "joined"\|"pending"\|"already" }` (`club` is the public view until membership); `409 limit` (members, or clubs per user) |
| `POST /api/clubs/:code/members/:userId/approve` | bearer (owner or admin) | | `200 Club`; `403 forbidden`, `404 not_found` (no such request) |
| `POST /api/clubs/:code/members/:userId/role` | bearer (owner) | `{ "role": "owner"\|"admin"\|"member" }` | `200 Club`; `owner` transfers ownership (the previous owner becomes an admin). `400 invalid` (role), `403 forbidden` (not the owner, or the owner's own role), `404 not_found` (not a member) |
| `DELETE /api/clubs/:code/members/:userId` | bearer (the member, owner or admin) | | `200` the club (the public view once the caller has left); `403 forbidden` (the owner cannot leave; an admin cannot remove the owner) |
| `GET /api/clubs/:code/standings` | bearer (member) | | rows by season points: `{ userId, name, avatar?, role, seasonPoints, lifetimePoints, points, season, … }`; `403 forbidden` |
| `POST /api/clubs/:code/season` | bearer (owner) | | see Club seasons below; `403 forbidden` |
| `POST /api/clubs/:code/tables` | bearer (member; owner and admins only when `settings.membersCanOpenTables` is false) | `{ "label"?, "rules"?, "botSkill"? }` | `200` the listed table `{ code, label, createdBy, createdAt, … }`; its room is a hosted club table and members with push tokens (not the opener) are notified. `403 forbidden`, `400 invalid`, `503 unavailable` (table capacity) |
| `GET /api/users/:userId/clubs` | bearer (self; `me` works) | | `200 [Club, …]`: the caller's clubs (members' view) and pending requests (public view); `403 forbidden` for anyone else |

Every club route answers `404 not_found` for an unknown code and `429 rate_limited` under the per-IP HTTP limit.

## Store, wallet, reports and seasons: what the app relies on

The app side lives in `apps/mobile/src/monetisation/` (store and wallet), `apps/mobile/src/api/wallet.ts`, `apps/mobile/src/api/clubs.ts` and `apps/mobile/src/legal/`. The server's own section of this file is authoritative for status codes and limits; these are the parts the app depends on.

- **The wallet is the server's.** The app's copy mirrors `GET /api/me` and is cached for offline display only. It reads `wallet.diamonds`, `wallet.bonusDiamonds`, `entitlements[]` (`coach.gold`, `coach.platinum`; a cosmetic entitlement is its product id, e.g. `theme.jade`) and the optional `cosmetics[]` (product ids). `serverNow` sets the clock that subscription expiry and the free-tier meters are judged by.
- **Purchases.** The app configures RevenueCat with the server user id as the app user id (`Purchases.logIn(userId)` after sign-in), buys with the store, then polls `GET /api/me` for about 8 seconds until the purchase shows; if it has not arrived yet the Shop says so and the next sync picks it up. Nothing is granted on the device. Store ids are the `catalog.ts` ids; a Google Play subscription arrives as `coach.gold:month`.
- **`POST /api/wallet/spend`** body `{ "productId": "theme.jade" }` (bearer) → `{ spent, entitlement, wallet, cosmetics }`. The app maps `409 insufficient` to "you need N more diamonds" and `409 owned` to success, then re-reads `/api/me`.
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
  "entitlements": [{ "entitlement": "coach.gold", "expiresAt": "<ISO>" | null, "active": true }],
  "cosmetics": ["theme.jade"],
  "coachTier": "free" | "gold" | "platinum",
  "storeEnabled": true
}
```

`active` is computed on the server clock (`serverNow`), so a device clock rolled back changes nothing. `cosmetics` lists the table looks the user owns (product ids; the app maps them to `unlocks` through its catalogue).

### Catalogue (server side: `apps/signal/src/catalog.ts`)

| Product id | Kind | Grants |
| --- | --- | --- |
| `diamonds.60`, `diamonds.300`, `diamonds.600` | consumable | 60 / 300 / 600 diamonds |
| `diamonds.1300`, `diamonds.3450`, `diamonds.7500` | consumable | 1,200 + 100 bonus / 3,000 + 450 bonus (15 %) / 6,000 + 1,500 bonus (25 %) |
| `coach.gold.month`, `coach.gold.year` | auto-renewing | entitlement `coach.gold` until the store's expiry |
| `coach.platinum.month`, `coach.platinum.year` | auto-renewing | entitlement `coach.platinum` until the store's expiry |
| `theme.nightmarket`, `theme.bamboo`, `theme.imperial` (300 💎), `theme.jade` (400 💎) | diamonds only | permanent entitlement with the product id |

App Store product ids are these ids. A Google Play subscription arrives as `<subscription>:<base plan>`, so create the Play subscriptions `coach.gold` and `coach.platinum` with base plans `month` and `year`. Anything else (avatar and emote packs, VIP cards, club tiers, Coach Diamond, Table Pass) is not sold: events and spends for it grant nothing.

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

`400 invalid` (missing or unknown field values, reporting yourself), `404 not_found` (no such player), `429 rate_limited` after 10 reports by the same user in 24 hours, or after 30 reports from the same IP address in 24 hours whatever the accounts (guest accounts are free to make). Reports are kept when either account is deleted, and follow a guest into the account it merges into. There is no moderation UI yet: reports are read from the `reports` table (`status` open / actioned / dismissed).

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
