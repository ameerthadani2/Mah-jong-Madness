# Owner to-do

Everything engineering needs from you, by phase. Nothing here blocks the code: each item has a default or a stub, and the app and tests run with every value absent. When you fill one in, the matching feature switches on by itself.

Where to put things:
- **Repository variables and secrets**: GitHub → Settings → Secrets and variables → Actions. Variables are visible in build logs; secrets are not.
- **Server environment**: set on the game server host (Fly.io `fly secrets set NAME=value`) once Phase 3 is deployed.
- **Mobile build-time values**: repository variables (most prefixed `EXPO_PUBLIC_`). The TestFlight workflow copies them into the EAS build profile; a build started from a laptop with `eas build` sees only **EAS environment variables** (expo.dev → project → Environment variables), so set each one in both places ("repo variable + EAS variable" below).

## Phase 1 — honest build

| Item | Type | Default while absent | Why |
| --- | --- | --- | --- |
| `APP_NAME` | repo variable | `Mahjong Mania` | The new name (owner decision, 9 Nov). Store title "Mahjong Mania: Taiwan 16", Chinese name 麻將狂熱 (瘋麻將 is taken). Run the trademark search (US, UK, TW) before reserving the bundle id. |
| `APP_SLUG` | repo variable | `mahjongmania` | Expo project slug (lower-case, hyphens). |
| `APP_SCHEME` | repo variable | `mahjongmania` | Deep-link scheme (letters only). |
| `APP_BUNDLE_ID` | repo variable | `com.mahjongmania.app` | iOS bundle id and Android package (a placeholder until the trademark check clears the name); reserve it in App Store Connect early, it cannot change after release. |
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
| `FACEBOOK_APP_ID` | server secret | Facebook sign-in is hidden | Optional: the Facebook app id, for Facebook Limited Login. |
| `AUTH_PEPPER_PREVIOUS` | server secret | no pepper rotation in progress | Only while rotating the pepper: the old `AUTH_PEPPER` value, so existing sessions keep working and are re-hashed on first use (`DEPLOY.md`). Remove it after 30 days. |
| `CORS_ORIGINS` | server secret | browsers on other origins cannot call the API (native apps are unaffected) | The web preview's origin(s), comma-separated. |
| `MAINTENANCE_MESSAGE` | server variable | none: online play is open | Optional: a short message the app shows instead of online play while you work on the server (`/api/config.maintenance`). Unset it to reopen. |
| `TRUST_PROXY` | server variable | `1`, already set in `fly.toml` | The number of proxies in front of the server, so per-IP limits see the real client address. Change it only if you add or remove a proxy. |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | repo variables + EAS variables | the Google button is hidden | The same OAuth client ids, for the app's sign-in flow; the iOS/Android ids also register `<bundle id>:/oauthredirect` as the redirect in `app.config.js`. |
| `SIGNAL_URL` | repo variable | `ws://localhost:8787`; the deploy health check is skipped | The server address (`wss://<app>.fly.dev`); builds use it, and the deploy workflow checks `/health` there after each deploy. |

## Phase 4 — store and legal

The server decides every entitlement from RevenueCat's webhook (`docs/API.md` → Store); the product ids are in `apps/signal/src/catalog.ts`.

| Item | Type | Default while absent | Why |
| --- | --- | --- | --- |
| Apple Developer (company account), Google Play Console, D-U-N-S, bank and tax forms | accounts | no store builds | Paid apps and in-app purchases need the agreements signed and a legal entity (`STORE_COMPLIANCE.md` 5.1.1(ix)). |
| In-app products | App Store Connect / Play Console | nothing to buy | Create exactly these ids. App Store: consumables `diamonds.60`, `diamonds.300`, `diamonds.600`, `diamonds.1300`, `diamonds.3450`, `diamonds.7500`; auto-renewing subscriptions `coach.gold.month`, `coach.gold.year`, `fourwinds.month`, `fourwinds.year` in one subscription group, The Four Winds Club ranked above Coach Gold. Play: the same consumables; subscriptions `coach.gold` and `fourwinds`, each with base plans `month` and `year`. Price tiers (USD): packs 0.99 … 99.99; Coach Gold 6.99 a month or 49.99 a year; The Four Winds Club (四風俱樂部) 10.99 a month or 79.99 a year. Cosmetics are bought with diamonds and need no store product. Names and descriptions for each product: `apps/mobile/src/i18n/locales/{en,zh-TW}/shop.json` (`products`). |
| RevenueCat project | account | store off | Add the App Store and Play apps, import the products above, make one offering with them, and create two entitlements: `gold` (attach `coach.gold.month`, `coach.gold.year`) and `fourwinds` (attach `fourwinds.month`, `fourwinds.year`). The server keeps one entitlement per plan itself, so a refund of one plan never ends another. RevenueCat's public SDK keys go to the app (mobile rows below). |
| `REVENUECAT_WEBHOOK_SECRET` | server secret | `POST /api/webhooks/revenuecat` answers 503 and `/api/config.storeEnabled` is false, so the app shows "Store unavailable" and sells nothing for money | Generate one (`openssl rand -hex 32`), `fly secrets set REVENUECAT_WEBHOOK_SECRET=…`, then in RevenueCat → Integrations → Webhooks set the URL to `https://<app>.fly.dev/api/webhooks/revenuecat` and the Authorization header to `Bearer <the same value>`. Send RevenueCat's test event: the server answers `{"outcome":"test"}`. |
| `REVENUECAT_SECRET_KEY` | server secret | no reconciliation: a purchase whose webhook never arrived stays missing until support grants it | RevenueCat → Project → API keys → a **secret** (v1) key. The server reads each player's purchases with it after Restore (`POST /api/wallet/sync`) and nightly for accounts with store activity in the last 7 days, and applies anything the webhook missed. Never put it in the app. |
| `TESTER_USER_IDS` | server secret | every sandbox purchase (TestFlight, Play testing) is recorded as `ignored_sandbox` and grants nothing | Comma-separated server user ids (Settings → Account shows "Player id") of the people who test purchases. Only their sandbox purchases are granted, so free test purchases never become real balances. Add App Review's demo account here too. |
| `ADMIN_TOKEN` | server secret | `POST /api/admin/grant` answers 503 | A long random token (`openssl rand -hex 32`) for support: `curl -X POST https://<app>.fly.dev/api/admin/grant -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"userId":"…","diamonds":300,"note":"Ticket 42"}'` credits diamonds as a `support` ledger entry; `{"userId":"…","entitlement":"fourwinds.month","days":30,"note":"…"}` grants a plan. Moderation tools use the same token later. |
| RevenueCat public SDK keys (iOS and Android) | repo variables + EAS variables (`EXPO_PUBLIC_REVENUECAT_IOS_KEY`, `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY`; the app table below) | the app cannot start a purchase | RevenueCat → Project → API keys; the public keys are meant to ship in the app. |
| `EXPO_PUBLIC_STORE_MODE=mock` | repo variable (development builds only) | real store | Lets development builds use the mock store; release builds ignore it. |
| `EXPO_PUBLIC_TERMS_URL`, `EXPO_PUBLIC_PRIVACY_URL` | repo variables + EAS variables | bundled screens marked DRAFT | Counsel-approved terms of service and privacy policy, hosted on your domain (https only; the app table below). |
| Support email | decision | none shown | Shown in Settings and on the store listings. |
| Moderation | process | reports pile up unread | Player reports land in the `reports` table (`status = 'open'`); decide who reads them and how often. |

| Item (app) | Type | Default while absent | Why |
| --- | --- | --- | --- |
| `EXPO_PUBLIC_REVENUECAT_IOS_KEY`, `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY` | repo variables + EAS variables | the Shop shows "Store unavailable on this build" and sells nothing | RevenueCat public SDK keys; products in App Store Connect / Play must use the ids in `apps/mobile/src/monetisation/catalog.ts`. |
| `EXPO_PUBLIC_STORE_MODE` | repo variable (development builds only) | the real store | `mock` lets a development build grant purchases locally; release builds ignore it. |
| `EXPO_PUBLIC_TERMS_URL`, `EXPO_PUBLIC_PRIVACY_URL` | repo variables + EAS variables | the bundled DRAFT texts open in-app | Hosted, counsel-approved documents. Also replace `[Company name]`, `[support email]` and `[jurisdiction]` in `apps/mobile/src/legal/documents.ts`. |
| `EXPO_PUBLIC_LINK_DOMAIN` | repo variable + EAS variable | shared table links use the app scheme (`mahjongmania://table/<code>`), which only works where the app is installed | Your web domain (e.g. `play.example.com`). Shared links become `https://<domain>/t/<code>`; the build registers the domain as an iOS universal link and Android app link. The domain must serve `/.well-known/apple-app-site-association` (app id `<APPLE_TEAM_ID>.<APP_BUNDLE_ID>`, paths `/t/*` and `/c/*`) and `/.well-known/assetlinks.json` (package `APP_BUNDLE_ID` and the Play signing certificate's SHA-256), and a simple page at `/t/<code>` that links to the stores for people without the app. |

## Phase 5 — audio

Sound effects and Mandarin (ideally also Taiwanese) voice calls dropped into `apps/mobile/assets/audio/` using the manifest names; licence records.

## Phase 6 — observability and push

What each signal means and where to look is in [`OBSERVABILITY.md`](OBSERVABILITY.md).

| Item | Type | Default while absent | Why |
| --- | --- | --- | --- |
| `EXPO_ACCESS_TOKEN` | server secret | no push is sent; `/api/config.pushEnabled` is false | Expo → Account settings → Access tokens. The server sends "club table opened", "join request approved" and "your table is waiting" through Expo. |
| APNs key and FCM credentials | EAS credentials | push cannot reach phones even with the token | Upload an APNs auth key (Apple Developer → Keys) and the FCM v1 service-account JSON (Firebase console) with `eas credentials`. |
| `SENTRY_DSN` | server secret | server errors are only logged | Sentry project for the server (Node). Optional `SENTRY_ENVIRONMENT` (default `production`) and `SENTRY_RELEASE` (default: Fly's image reference, so each deploy is already a release). |
| `EXPO_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | repo variable / secrets | app crashes are not reported; no source maps | A second Sentry project for the app; the auth token uploads source maps from the EAS build. |
| `POSTHOG_KEY` | server secret | no server events (`purchase_credited`, `report_filed`) | PostHog project key. Optional `POSTHOG_HOST` (`https://eu.i.posthog.com` for an EU project). |
| `EXPO_PUBLIC_POSTHOG_KEY`, `EXPO_PUBLIC_POSTHOG_HOST` | repo variables + EAS variables | no app funnel events | The same PostHog project. App events are anonymous (no person profiles, no identify call) and are not joined to the server's user id; the privacy manifest's "not linked" product-interaction entry relies on that. |
| Uptime alert | Fly dashboard or an uptime monitor | you learn about outages from players | Alert on `https://<app>.fly.dev/health` failing, and in Sentry on new issues. |
| `MIN_BUILD` | server variable | `0`: every build may play online | Raise it to turn away builds older than a given release (reported as `/api/config.minBuild`, which the app reads to ask for an update). |

### Phase 6 — app

The app reads these at build time. EAS cloud builds do not see your shell or GitHub environment, so set them as **EAS environment variables** (expo.dev → project → Environment variables, for the `preview` and `production` environments); the TestFlight workflow also copies the non-secret ones from repository variables into the build profile.

| Item | Type | Default while absent | Why |
| --- | --- | --- | --- |
| `EXPO_PUBLIC_SENTRY_DSN` | repo variable + EAS variable | no crash reports; the "Send crash reports" toggle is hidden | Sentry → Project settings → Client keys (DSN). Public by design. |
| `SENTRY_AUTH_TOKEN` | EAS secret | the Sentry build plugin is left out, so builds succeed but crashes show minified stacks | Sentry → Settings → Auth tokens (scope `project:releases`). Uploads source maps and iOS/Android debug symbols during the EAS build. Never put it in a repository variable. |
| `SENTRY_ORG`, `SENTRY_PROJECT` | repo variables + EAS variables | as above (all three are needed for upload) | The organisation and project slugs from the Sentry URL. For an over-the-air update, upload its maps with `npx sentry-expo-upload-sourcemaps dist` after `eas update`. |
| `EXPO_PUBLIC_POSTHOG_KEY` | repo variable + EAS variable | no analytics; the "Share usage statistics" toggle is hidden | PostHog → Project settings → Project API key (public). Analytics stay off until the first-run age gate records consent, and off by default for minors. |
| `EXPO_PUBLIC_POSTHOG_HOST` | repo variable + EAS variable | `https://us.i.posthog.com` | Use `https://eu.i.posthog.com` for an EU project. |
| EAS project id | `eas init` (the TestFlight workflow runs it once) | no push token, so push stays off | Expo push tokens are issued per EAS project (`extra.eas.projectId` in `app.json`). |
| APNs key | EAS credentials | iOS push not delivered | `eas credentials` → iOS → Push Notifications: let EAS create the key, or upload your `.p8`. |
| `GOOGLE_SERVICES_JSON` | EAS file variable | Android push not delivered | Firebase project → Android app (package = `APP_BUNDLE_ID`) → download `google-services.json`; add it as a file variable named `GOOGLE_SERVICES_JSON`, and upload the FCM V1 service-account key with `eas credentials` → Android. |
| `APP_STORE_ID` | repo variable + EAS variable | the "Update required" screen links to a placeholder App Store page | The numeric id from App Store Connect (App information → Apple ID) once the app record exists. The Google Play link is derived from `APP_BUNDLE_ID`. |

## Phase 7 — device QA and listings

A native zh-TW reviewer for `apps/mobile/src/i18n/zh-TW.json`; store listing copy in both languages; a low-end Android phone; the TestFlight workflow's secrets (`EXPO_TOKEN`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`, `APPLE_TEAM_ID`, and `EXPO_OWNER`, your Expo account name, which the run summary uses to link to the build list; `docs/RUN_FROM_PHONE.md` walks through them).

## Developer-only

Read by the code but never needed from you: `SENTRY_URL` (`app.config.js`, only for a self-hosted Sentry; defaults to sentry.io), `EXPO_BASE_URL` (set by the web-preview workflow to the GitHub Pages sub-path), `EXPO_PUBLIC_STORE_MODE` (development builds only, above), and the server's local-run switches in `apps/signal/README.md` (`PORT`, `HOST_TABLES`, `MAX_HOSTED_TABLES`, `P2P_ROOMS`, `MIGRATE_ON_BOOT`, `DATA_DIR`, `MIGRATIONS_DIR`, `DATABASE_URL_TEST`).

## Phase 8 — content and validation

20–30 player interviews, 3–5 beta clubs, a small user-acquisition test budget; recorded hands from 明星三缺一 for the golden scoring check.
