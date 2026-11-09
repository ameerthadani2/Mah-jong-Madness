# Owner to-do

Everything engineering needs from you, as one ordered checklist. Nothing here blocks the code: every value has a default, the tests and workflows pass with all of them absent (each workflow skips itself with setup steps in its summary while its secret is missing), and each feature switches on by itself once its value is in place. Work top to bottom: later steps assume the earlier ones.

## Where things go

| Short name | Where | Who reads it |
| --- | --- | --- |
| **GitHub secret** | GitHub → Settings → Secrets and variables → Actions → *Secrets* | The workflows; never shown in logs. |
| **GitHub variable** | the same page → *Variables* | The workflows; visible in logs. The iOS and Android build workflows copy every app variable below into the EAS build, so you set it once here. |
| **EAS env** | expo.dev → your project → Environment variables (tick `preview` and `production`) | EAS cloud builds. Needed for secrets the app build uses (`SENTRY_AUTH_TOKEN`, the `GOOGLE_SERVICES_JSON` file), and for any build you start from a laptop with `eas build`, which does not see GitHub variables. |
| **fly secret** | `fly secrets set -a <app> NAME=value` (each set restarts the server) | The game server. |

## The checklist

### 1. Name and identity (before the first native build)

- [ ] Trademark search for "Mahjong Mania" and 麻將狂熱 (US, UK, TW) by counsel. Store title "Mahjong Mania: Taiwan 16"; 瘋麻將 is taken.
- [ ] **GitHub variables** `APP_NAME` (default `Mahjong Mania`), `APP_SLUG` (`mahjongmania`, the EAS project slug), `APP_SCHEME` (`mahjongmania`, letters only), `APP_BUNDLE_ID` (`com.mahjongmania.app`; also the Android package, so letters, digits, `_` and dots only, no `-`). Set them only if you change a default, and **before** the first build: the bundle id and package can never change after the first store upload, and changing the slug later creates a second EAS project. Unblocks: the store records and every build.
- [ ] Optional **GitHub variable** `APP_VERSION` (e.g. `1.0.0`): the version players see. Default `0.1.0` from `app.json`. Build numbers need nothing: EAS raises the iOS build number and the Android version code on every production build.
- [ ] Repository: make it private, or add a licence (public with no licence is "all rights reserved" but readable by anyone).

### 2. Game server (Fly + Neon), then `SIGNAL_URL`

Step by step in [`DEPLOY.md`](DEPLOY.md) ("First deploy, in order").

- [ ] Fly app created and its name put in `fly.toml`; **GitHub secret** `FLY_API_TOKEN` (`fly tokens create deploy -a <app>`). Unblocks: the deploy workflow.
- [ ] Neon project in Singapore; **fly secrets** `DATABASE_URL` (pooled, `-pooler` host) and `DATABASE_URL_DIRECT` (direct). Unblocks: durable accounts, clubs, wallets and tables; migrations; the single-host lock.
- [ ] **fly secret** `AUTH_PEPPER` (`openssl rand -hex 32`; keep a copy). Unblocks: sessions that survive restarts. Without it and the database the production server refuses to start.
- [ ] **fly secret** `ADMIN_TOKEN` (`openssl rand -hex 32`). Unblocks: support grants (`POST /api/admin/grant`) and the moderation endpoints (reports, bans, mutes).
- [ ] Deploy: Actions → **Deploy signal server** → Run workflow on the working branch. It runs the tests, deploys, checks `/health` and plays one hand with the smoke test. Then `fly scale count 1 -a <app>`.
- [ ] **GitHub variable** `SIGNAL_URL` = `wss://<app>.fly.dev` (also as **EAS env** if you build from a laptop). Unblocks: both mobile build workflows, which refuse to build without a public `wss://` address, and the deploy workflow checks this address from then on.

### 3. Expo

- [ ] Free account at expo.dev; **GitHub secret** `EXPO_TOKEN` (Account settings → Access tokens). Unblocks: both mobile build workflows. The first run creates the EAS project and commits its id to `app.json` on the branch it ran on.

### 4. Apple: TestFlight

- [ ] Apple Developer Program (company account, D-U-N-S), agreements, bank and tax forms signed (paid apps and in-app purchases need them).
- [ ] App Store Connect → Users and Access → Integrations → Team Keys → a key with the App Manager role: **GitHub secrets** `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (the whole `.p8` file), and `APPLE_TEAM_ID` (developer.apple.com → Membership). Unblocks: the iOS TestFlight workflow.
- [ ] Run Actions → **iOS TestFlight build**. EAS registers the bundle id and creates the App Store Connect record on the first submission; then add testers ([`RUN_ON_IOS.md`](RUN_ON_IOS.md)).
- [ ] **GitHub variable** `APP_STORE_ID` (App Store Connect → App information → Apple ID, numeric). Unblocks: the "Update required" link.
- [ ] Sign in with Apple: enable the capability for the bundle id, then **fly secret** `APPLE_CLIENT_ID` = the bundle id. Unblocks: the Apple button (hidden without it).

### 5. Google: Play internal testing

- [ ] Google Play Console developer account; create the app (package = `APP_BUNDLE_ID`), fill in the app content forms enough for internal testing.
- [ ] Google Cloud → a service account with a JSON key; Play Console → Users and permissions → invite its e-mail with release rights for the app. **GitHub secret** `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` = the whole JSON file. Unblocks: the Android workflow's submission.
- [ ] Run Actions → **Android Play build**. Google accepts API uploads only after one bundle has been uploaded by hand, so the first time download the `.aab` linked in the run summary and upload it in Play Console → Testing → Internal testing; after that the workflow submits each build as a draft release ([`RUN_ON_ANDROID.md`](RUN_ON_ANDROID.md)).
- [ ] Google sign-in: Google Cloud → OAuth client ids for iOS (bundle id), Android (package plus the SHA-1 of the Play app signing key from Play Console → App integrity, and of the EAS upload key from `eas credentials`) and web. **GitHub variables** `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, and **fly secret** `GOOGLE_CLIENT_IDS` = all three, comma-separated. Unblocks: the Google button (hidden without them).

### 6. Store products

Create exactly these ids (the server's catalogue, `apps/signal/src/catalog.ts`, and the app's must match). Names and descriptions in both languages: `apps/mobile/src/i18n/locales/{en,zh-TW}/shop.json` (`products`). Cosmetics are bought with diamonds and need no store product.

| Product | App Store Connect | Google Play | Price (USD tier) |
| --- | --- | --- | --- |
| 60 diamonds | consumable `diamonds.60` | in-app product `diamonds.60` | 0.99 |
| 300 diamonds | consumable `diamonds.300` | `diamonds.300` | 4.99 |
| 600 diamonds | consumable `diamonds.600` | `diamonds.600` | 9.99 |
| 1,200 + 100 bonus | consumable `diamonds.1300` | `diamonds.1300` | 19.99 |
| 3,000 + 450 bonus | consumable `diamonds.3450` | `diamonds.3450` | 49.99 |
| 6,000 + 1,500 bonus | consumable `diamonds.7500` | `diamonds.7500` | 99.99 |
| Coach Gold, monthly | auto-renewing `coach.gold.month` | subscription `coach.gold`, base plan `month` | 6.99 |
| Coach Gold, yearly | auto-renewing `coach.gold.year` | subscription `coach.gold`, base plan `year` | 49.99 |
| The Four Winds Club (四風俱樂部), monthly | auto-renewing `fourwinds.month` | subscription `fourwinds`, base plan `month` | 10.99 |
| The Four Winds Club, yearly | auto-renewing `fourwinds.year` | subscription `fourwinds`, base plan `year` | 79.99 |

- [ ] App Store: the four subscriptions in **one subscription group**, The Four Winds Club ranked above Coach Gold.
- [ ] Play: two subscriptions (`coach.gold`, `fourwinds`), each with base plans `month` and `year` (auto-renewing).

### 7. RevenueCat

- [ ] Project with the App Store app and the Play app; import the products above; one offering with all of them; entitlements `gold` (attach `coach.gold.month`, `coach.gold.year`) and `fourwinds` (attach `fourwinds.month`, `fourwinds.year`).
- [ ] **GitHub variables** `EXPO_PUBLIC_REVENUECAT_IOS_KEY`, `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY` (RevenueCat → API keys → the public app keys). Unblocks: purchases in the app (the Shop shows "Store unavailable" without them).
- [ ] **fly secret** `REVENUECAT_WEBHOOK_SECRET` (`openssl rand -hex 32`); RevenueCat → Integrations → Webhooks: URL `https://<app>.fly.dev/api/webhooks/revenuecat`, Authorization `Bearer <the same value>`; send the test event (the server answers `{"outcome":"test"}`). Unblocks: the server granting purchases, and `storeEnabled` in `/api/config`.
- [ ] **fly secret** `REVENUECAT_SECRET_KEY` (RevenueCat → API keys → a secret v1 key; never in the app). Unblocks: reconciliation after Restore and nightly, for purchases whose webhook was lost.
- [ ] Once the store is live, club ownership needs The Four Winds Club (before that, anyone may create clubs).

### 8. Testers and the sandbox

- [ ] Apple: App Store Connect → Users and Access → Sandbox → testers. Google: Play Console → Settings → License testing → add the testers' Google accounts.
- [ ] Each tester opens the app once online and reads Settings → Account → "Player id". **fly secret** `TESTER_USER_IDS` = those ids, comma-separated (add App Review's demo account later). Unblocks: sandbox purchases granting anything; everyone else's are recorded as `ignored_sandbox`, so free test purchases never become real balances.

### 9. Legal and support

- [ ] Counsel-approved terms of service and privacy policy hosted on your domain (https). **GitHub variables** `EXPO_PUBLIC_TERMS_URL`, `EXPO_PUBLIC_PRIVACY_URL`. Unblocks: submission (without them the app opens bundled texts marked DRAFT). Also replace `[Company name]`, `[support email]` and `[jurisdiction]` in `apps/mobile/src/legal/documents.ts`.
- [ ] A support e-mail for Settings and the store listings.
- [ ] Who reads player reports and how often (they land in the `reports` table, `status = 'open'`; the admin endpoints use `ADMIN_TOKEN`).

### 10. Shared table links

- [ ] **GitHub variable** `EXPO_PUBLIC_LINK_DOMAIN` (e.g. `play.example.com`). Unblocks: `https://<domain>/t/<code>` links that open the app (iOS universal links, Android app links); without it links use `mahjongmania://table/<code>`, which only works where the app is installed. The domain must serve `/.well-known/apple-app-site-association` (app id `<APPLE_TEAM_ID>.<APP_BUNDLE_ID>`, paths `/t/*` and `/c/*`), `/.well-known/assetlinks.json` (package `APP_BUNDLE_ID`, the SHA-256 of the Play app signing certificate) and a simple page at `/t/<code>` linking to the stores.

### 11. Push notifications

- [ ] **fly secret** `EXPO_ACCESS_TOKEN` (expo.dev → Access tokens). Unblocks: "club table opened", "join request approved", "your table is waiting".
- [ ] APNs key: `eas credentials` → iOS → Push Notifications (let EAS create it, or upload your `.p8`).
- [ ] Firebase project → Android app (package = `APP_BUNDLE_ID`) → `google-services.json` as an **EAS env** *file* variable named `GOOGLE_SERVICES_JSON`; upload the FCM V1 service-account key with `eas credentials` → Android.

### 12. Crash reports, analytics, uptime

- [ ] **fly secret** `SENTRY_DSN` (a Sentry project for the server). Unblocks: server error reports.
- [ ] **GitHub variables** `EXPO_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT` (a second Sentry project for the app) and **EAS env** secret `SENTRY_AUTH_TOKEN` (scope `project:releases`; never a GitHub variable). Unblocks: app crash reports with readable stacks (all three plus the token are needed for the upload).
- [ ] **fly secret** `POSTHOG_KEY` (optional `POSTHOG_HOST`) and **GitHub variables** `EXPO_PUBLIC_POSTHOG_KEY`, `EXPO_PUBLIC_POSTHOG_HOST` (`https://eu.i.posthog.com` for an EU project). Unblocks: server events and the app funnel (consent-gated, off by default for minors).
- [ ] An uptime alert on `https://<app>.fly.dev/health` (Fly dashboard or any monitor), and Sentry alerts on new issues.

### 13. Device QA

- [ ] Install both builds (TestFlight on an iPhone, Play internal testing on a low-end Android phone) and work through [`QA.md`](QA.md), including the sandbox purchase, restore and refund with a tester account. Report what fails with the build number.

### Later, when needed

| Name | Where | What it does |
| --- | --- | --- |
| `MIN_BUILD` | fly secret | Turns away builds older than this build number ("Update required"). Default 0. |
| `MAINTENANCE_MESSAGE` | fly secret | Shows a message instead of online play while you work on the server; unset to reopen. |
| `CORS_ORIGINS` | fly secret | Web origins allowed to call the API (the web preview); native apps need nothing. |
| `AUTH_PEPPER_PREVIOUS` | fly secret | Only while rotating the pepper ([`DEPLOY.md`](DEPLOY.md)); remove after 30 days. |
| `FACEBOOK_APP_ID` | fly secret | Optional Facebook Limited Login. |
| `TRUST_PROXY` | `fly.toml` (already `1`) | Proxies in front of the server, for per-IP limits. |
| `EXPO_PUBLIC_STORE_MODE=mock` | GitHub variable | Development builds only: a local mock store. Release builds ignore it. |
| Audio | files in `apps/mobile/assets/audio/` | Recorded calls and effects under the manifest names, with licence records. |
| zh-TW review | a native reviewer | `apps/mobile/src/i18n/locales/zh-TW/*.json` and the store listings in both languages. |
| Validation | your time | 20–30 player interviews, 3–5 beta clubs, a small acquisition test; recorded hands for the golden scoring check. |

Read by the code but never needed from you: `SENTRY_URL` (self-hosted Sentry only), `EXPO_BASE_URL` (set by the web-preview workflow), and the server's local-run switches in `apps/signal/README.md` (`PORT`, `HOST_TABLES`, `MAX_HOSTED_TABLES`, `P2P_ROOMS`, `MIGRATE_ON_BOOT`, `DATA_DIR`, `MIGRATIONS_DIR`, `DATABASE_URL_TEST`, `ALLOW_EPHEMERAL`).
