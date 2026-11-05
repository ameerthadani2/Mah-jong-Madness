# Owner to-do

Everything engineering needs from you, by phase. Nothing here blocks the code: each item has a default or a stub, and the app and tests run with every value absent. When you fill one in, the matching feature switches on by itself.

Where to put things:
- **Repository variables and secrets**: GitHub → Settings → Secrets and variables → Actions. Variables are visible in build logs; secrets are not.
- **Server environment**: set on the game server host (Fly.io `fly secrets set NAME=value`) once Phase 3 is deployed.
- **Mobile build-time values**: repository variables prefixed `EXPO_PUBLIC_`, read by `apps/mobile/app.config.js` and the EAS workflows.

## Phase 1 — honest build

| Item | Type | Default while absent | Why |
| --- | --- | --- | --- |
| `APP_NAME` | repo variable | `Mahjong Madness` | "Mahjong Madness" is already a live App Store title; choose a name that clears App Store and Play search and has a domain. |
| `APP_SLUG` | repo variable | `mahjong-madness` | Expo project slug (lower-case, hyphens). |
| `APP_SCHEME` | repo variable | `mahjongmadness` | Deep-link scheme (letters only). |
| `APP_BUNDLE_ID` | repo variable | `com.mahjongmadness.app` | iOS bundle id and Android package; reserve it in App Store Connect early, it cannot change after release. |
| `SIGNAL_URL` | repo variable | `ws://localhost:8787` | The game server address (`wss://…`) once Phase 3 is deployed; baked into builds. |
| Repository visibility / LICENSE | decision | public, no licence | A public repo without a licence is "all rights reserved" but anyone can read it. Make it private now, or add a licence. The plan publishes the engine under Apache-2.0 after the rebrand. |

## Phase 3 — accounts and durable backend

Step-by-step setup (Fly app, Neon project, `fly secrets set`) is in [`DEPLOY.md`](DEPLOY.md); every server variable is described in [`apps/signal/README.md`](../apps/signal/README.md).

| Item | Type | Default while absent | Why |
| --- | --- | --- | --- |
| `FLY_API_TOKEN` | repo secret | the deploy workflow is skipped, with the setup steps in its summary | Lets `.github/workflows/deploy-signal.yml` deploy the server to Fly.io (`fly tokens create deploy -a <app>`). Also put your Fly app name in `fly.toml`. |
| `DATABASE_URL` | server secret | in-memory storage: accounts, clubs and tables are lost on every restart or deploy | Neon Postgres (Singapore), the **pooled** connection string ending `?sslmode=require`. Move Neon to a paid plan before launch so it never suspends. |
| `DATABASE_URL_DIRECT` | server secret | migrations use `DATABASE_URL` | Neon's **direct** (unpooled) string; the release command runs migrations through it. |
| `AUTH_PEPPER` | server secret | a random pepper per process: every player is signed out by each restart | 32+ random bytes (`openssl rand -hex 32`) mixed into every stored session and guest-secret hash. Keep a copy in your password manager. |
| `APPLE_CLIENT_ID` | server secret | Sign in with Apple is hidden | The app's bundle id (plus the Services ID if web sign-in is added), after enabling the Sign in with Apple capability in App Store Connect. |
| `GOOGLE_CLIENT_IDS` | server secret | Google sign-in is hidden | The iOS, Android and web OAuth client ids from Google Cloud Console, comma-separated. |
| `CORS_ORIGINS` | server secret | browsers on other origins cannot call the API (native apps are unaffected) | The web preview's origin(s), comma-separated. |
| `TRUST_PROXY` | server variable | `1`, already set in `fly.toml` | The number of proxies in front of the server, so per-IP limits see the real client address. Change it only if you add or remove a proxy. |
| `SIGNAL_URL` | repo variable | `ws://localhost:8787`; the deploy health check is skipped | The server address (`wss://<app>.fly.dev`); builds use it, and the deploy workflow checks `/health` there after each deploy. |

## Phase 4 — store and legal

Apple Developer (company account), Google Play Console, D-U-N-S, bank and tax forms; IAP vendor account, products and webhook secret; counsel-approved terms and privacy policy (`TERMS_URL`, `PRIVACY_URL`); support email.

## Phase 5 — audio

Sound effects and Mandarin (ideally also Taiwanese) voice calls dropped into `apps/mobile/assets/audio/` using the manifest names; licence records.

## Phase 6 — observability and push

Sentry and PostHog accounts (`SENTRY_DSN`, `EXPO_PUBLIC_SENTRY_DSN`, `POSTHOG_KEY`, `EXPO_PUBLIC_POSTHOG_KEY`); APNs key and FCM credentials uploaded to EAS; `EXPO_ACCESS_TOKEN`.

## Phase 7 — device QA and listings

A native zh-TW reviewer for `apps/mobile/src/i18n/zh-TW.json`; store listing copy in both languages; a low-end Android phone; EAS credentials (`EXPO_TOKEN`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`, `APPLE_TEAM_ID`).

## Phase 8 — content and validation

20–30 player interviews, 3–5 beta clubs, a small user-acquisition test budget; recorded hands from 明星三缺一 for the golden scoring check.
