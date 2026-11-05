# Game server API (accounts, sessions, tables)

The contract between the app and `apps/signal`. The server side is implemented by `apps/signal/src/auth/*` and `src/repos/*` (Phase 3 foundations) and wired into `server.ts` / `api.ts` / `rooms.ts`; the app side lives in `apps/mobile/src/auth/*`. Everything here works with the in-memory repositories when no database is configured, so the contract holds in development and in tests.

## Conventions

- JSON bodies and responses; `Content-Type: application/json`.
- Errors: `{ "error": "<code>", "message": "<English sentence>" }` with the HTTP status below. `message` is for logs; the app maps `error` codes to translated copy (`errors.*`).
- Authentication: `Authorization: Bearer mjs_<64 hex>` on every `/api/*` route except `/health`, `/api/config` and the `/api/auth/guest*` bootstrap routes. A WebSocket connection authenticates with its first frame `{ "t": "hello", "auth": "<token>" }`.
- Rate limits: per IP (HTTP 10/s burst 30; auth routes 5/min) and per user (auth routes 5/min). Exceeding one returns `429 { "error": "rate_limited" }`.

| `error` code | Status | Meaning |
| --- | --- | --- |
| `invalid` | 400 | Malformed body or unknown provider |
| `invalid_credentials` | 401 | Guest id or secret does not match |
| `invalid_session` / `session_expired` / `session_revoked` / `session_rotated` | 401 | The bearer token is not usable; the app should refresh or bootstrap again |
| `invalid_token` | 401 | The provider token failed verification |
| `provider_disabled` | 404 | That sign-in method is not configured on this server (`GET /api/config.authProviders` lists the enabled ones) |
| `not_linked` | 404 | `login` for a provider identity that has no account; offer "attach to this guest" |
| `not_found` | 404 | No such user / identity |
| `identity_in_use` | 409 | The identity already belongs to another account that also has a provider |
| `last_identity` | 409 | Cannot unlink the only sign-in method |
| `limit` | 409 | A club cap was hit |
| `rate_limited` | 429 | Too many requests |
| `unavailable` | 503 | The server is at capacity (tables) or a dependency is down |

## Configuration

`GET /api/config` → `{ "authProviders": ["apple","google"], "storeEnabled": false, "pushEnabled": false, "minBuild": 0, "maintenance": null | "<message>", "serverNow": "<ISO>" }`. No auth. The app reads it at launch and on foreground; absent features are hidden.

## Guest accounts

`POST /api/auth/guest` body `{ "device": { "id": "<uuid>", "platform": "ios"|"android"|"web", "appBuild": "<string>", "locale": "en"|"zh-TW" }, "displayName"?: string, "avatar"?: string }`
→ `201 { "userId": "<uuid>", "guestSecret": "<64 hex>", "session": { "token": "mjs_…", "expiresAt": "<ISO>" }, "user": User }`.
The app stores `userId` and `guestSecret` in secure storage; they are the only way back into a guest account on a new install.

`POST /api/auth/guest/login` body `{ "userId", "guestSecret", "device" }` → `200 { "session", "user" }`.

## Sessions

- Tokens are opaque; the server stores a peppered hash. Sliding expiry of 30 days.
- `POST /api/auth/refresh` (bearer) → `200 { "session": { "token", "expiresAt" } }`. The old token stays valid for 5 minutes. The app refreshes once a day and on `session_expired`.
- `POST /api/auth/logout` (bearer) → `204`. Revokes this session only.
- `GET /api/me` (bearer) → `{ "user": User, "wallet": { "diamonds", "bonusDiamonds" }, "entitlements": [{ "entitlement", "expiresAt" }], "identities": [{ "provider", "email"? }], "serverNow" }`.
- `PATCH /api/me` (bearer) body `{ "displayName"?, "avatar"?, "locale"?, "birthYear"? }` → `{ "user": User }`.
- `DELETE /api/me` (bearer) → `204`. Soft-deletes the account (scrubbed after 30 days); every session is revoked; club rows are anonymised; purchase records are kept.

`User` = `{ "id", "kind": "guest"|"account", "displayName", "avatar", "locale", "birthYear": number|null, "createdAt" }`.

## Provider sign-in (Sign in with Apple, Google, optional Facebook)

The app obtains an identity token from the provider SDK with a fresh `nonce` (the raw nonce is sent to the server; the SHA-256 of it was given to the provider), then:

- `POST /api/auth/link` (bearer) body `{ "provider": "apple"|"google"|"facebook", "token": "<id token>", "nonce": "<raw nonce>", "email"?: string }` — attaches the identity to the current account (merge rules below) → `200 { "session", "user", "merged": boolean }`. When `merged` is true the device has been moved onto the existing account and must replace its stored session.
- `POST /api/auth/login` body `{ "provider", "token", "nonce", "device" }` (no bearer, or a guest bearer) → `200 { "session", "user" }` or `404 not_linked`.
- `DELETE /api/auth/identities/:provider` (bearer) → `204` or `409 last_identity`.

Merge rules: (1) identity unlinked → linked to the current user, who becomes `kind: "account"`; (2) identity belongs to V and the current user is a guest → the guest is merged into V (progress, wallet, purchases, club memberships, devices move; the guest's sessions are revoked) and the device receives a V session; (3) identity belongs to V and the current user already has a provider → `409 identity_in_use`; (4) unlink only while another provider remains.

## WebSocket (tables)

1. First frame: `{ "t": "hello", "auth": "<token>" }`. The server verifies it before assigning a peer id and replies `{ "t": "hello", "id": "<peer id>", "userId": "<uuid>" }`. A missing or bad token closes the socket with `4401`.
2. `{ "t": "create", "hosted": true, "rules"?, "botSkill"?, "club"?: "<club code>" }` → `{ "t": "room", "room", "host", "peers" }` or `{ "t": "error", "message" }`. Club tables require membership (`403`-style error frame `Join the club first`).
3. `{ "t": "join", "room" }` → `room` or `error`. The table host binds the verified `userId` to the seat; the client's `join` frame to the table carries its name, avatar and rejoin token as before.
4. Reconnect: on socket close the app retries with backoff 1, 2, 4, 8 … 60 s, re-sends `hello` + `join` with the same rejoin token, and shows "Reconnecting". The server keeps a seat for 15 minutes of inactivity.

## Clubs (unchanged routes, now authenticated)

All `/api/clubs*` routes take the bearer session instead of the trust-on-first-use `user` field; member lists and standings are members-only; non-members get the public view `{ code, name, description, memberCount, joinRequiresApproval }`.

## Environment (server)

`DATABASE_URL` (absent → in-memory repos, guest-only), `DATABASE_URL_DIRECT`, `MIGRATE_ON_BOOT`, `AUTH_PEPPER` (+ `AUTH_PEPPER_PREVIOUS`), `APPLE_CLIENT_ID`, `GOOGLE_CLIENT_IDS` (comma-separated), `FACEBOOK_APP_ID`, `CORS_ORIGINS`, `TRUST_PROXY`, `MAX_HOSTED_TABLES`, `PORT`. See `apps/signal/README.md` and `docs/DEPLOY.md`.
