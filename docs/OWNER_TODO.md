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
- [ ] Licence: none has been chosen, so all rights are reserved and the documents say so (README, FAIRNESS). Decide: keep the repository private, or choose a licence and add a `LICENSE` file (a public repository with no licence is still "all rights reserved", but readable by anyone). The fairness page lists publishing the engine and the verifier under an open licence as planned work, which needs this decision.

### 2. Game server (Fly + Neon), then `SIGNAL_URL`

Step by step in [`DEPLOY.md`](DEPLOY.md) ("First deploy, in order").

- [ ] Fly app created and its name put in `fly.toml`; **GitHub secret** `FLY_API_TOKEN` (`fly tokens create deploy -a <app>`). Unblocks: the deploy workflow.
- [ ] Neon project in Singapore; **fly secrets** `DATABASE_URL` (pooled, `-pooler` host) and `DATABASE_URL_DIRECT` (direct). Unblocks: durable accounts, clubs, wallets and tables; migrations; the single-host lock.
- [ ] **fly secret** `AUTH_PEPPER` (`openssl rand -hex 32`; keep a copy in your password manager: without the value every guest account is locked out for good). Unblocks: sessions and guest accounts that survive restarts. Without it and the database the production server refuses to start.
- [ ] **fly secret** `ADMIN_TOKEN` (`openssl rand -hex 32`; keep a copy: it is the `Bearer` value of every admin call, and Fly never shows a secret again). Unblocks: support grants (`POST /api/admin/grant`) and the moderation endpoints (reports, bans, mutes). [`DEPLOY.md`](DEPLOY.md) step 3 generates this one and the pepper, shows them to you once and then sets them.
- [ ] Not yet: `REVENUECAT_WEBHOOK_SECRET`. It switches the store on, and with the store on creating a club needs The Four Winds Club; it belongs to step 7, when the products can be bought.
- [ ] Deploy: Actions → **Deploy signal server** → Run workflow on the working branch. It runs the tests, deploys, checks `/health` and plays one hand with the smoke test. Then `fly scale count 1 -a <app>`.
- [ ] **GitHub variable** `SIGNAL_URL` = `wss://<app>.fly.dev` (also as **EAS env** if you build from a laptop). Unblocks: both mobile build workflows, which refuse to build without a public `wss://` address, and the deploy workflow checks this address from then on.
- [ ] **fly secret** `CORS_ORIGINS` = `https://<your GitHub user or organisation>.github.io` (scheme and host only, no path; several origins separated by commas). Unblocks: online play in the web preview. Without it the browser blocks every call the website makes to the server, so it cannot sign in, open a table or join a club; the Web preview run's summary tells you whether the server accepts the site. The native apps do not need it.

### 3. Expo

- [ ] Free account at expo.dev; **GitHub secret** `EXPO_TOKEN` (Account settings → Access tokens). Unblocks: both mobile build workflows. The first run creates the EAS project and commits its id to `app.json` on the branch it ran on.

### 4. Apple: TestFlight

- [ ] Apple Developer Program (company account, D-U-N-S), agreements, bank and tax forms signed (paid apps and in-app purchases need them).
- [ ] App Store Connect → Users and Access → Integrations → Team Keys → a key with the App Manager role: **GitHub secrets** `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (the whole `.p8` file), and `APPLE_TEAM_ID` (developer.apple.com → Membership). Unblocks: the iOS TestFlight workflow.
- [ ] Create the app record by hand: App Store Connect → Apps → + → New App, with your bundle id, a name and any SKU. An API key cannot create it, so the workflow cannot either. If the bundle id is not offered yet, run Actions → **iOS TestFlight build** once with *submit* unticked: the first build registers it.
- [ ] **GitHub variable** `APP_STORE_ID` (the new app → App Information → Apple ID, digits only). Unblocks: the workflow's submission to TestFlight (with *submit* ticked and no `APP_STORE_ID` the run stops before building and its summary lists these steps) and the "Update required" link.
- [ ] Run Actions → **iOS TestFlight build** with *submit* ticked; then add testers ([`RUN_ON_IOS.md`](RUN_ON_IOS.md)).
- [ ] Sign in with Apple: enable the capability for the bundle id, then **fly secret** `APPLE_CLIENT_ID` = the bundle id, and the **GitHub variable** `APPLE_CLIENT_ID` = the same value. Unblocks: the Apple button (hidden without the secret). Do this before Google sign-in (step 5): Apple refuses an iOS app that offers Google sign-in without Sign in with Apple beside it (App Review guideline 4.8), so an iOS build that carries `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` stops before building until the variable says the server offers Apple sign-in for the bundle id.

### 5. Google: Play internal testing

- [ ] Google Play Console developer account; create the app (package = `APP_BUNDLE_ID`), fill in the app content forms enough for internal testing.
- [ ] Google Cloud → a service account with a JSON key; Play Console → Users and permissions → invite its e-mail with release rights for the app. **GitHub secret** `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` = the whole JSON file. Unblocks: the Android workflow's submission.
- [ ] Run Actions → **Android Play build**. Google accepts API uploads only after one bundle has been uploaded by hand, so the first time download the `.aab` linked in the run summary and upload it in Play Console → Testing → Internal testing; after that the workflow submits each build as a draft release ([`RUN_ON_ANDROID.md`](RUN_ON_ANDROID.md)).
- [ ] Google sign-in: Google Cloud → OAuth client ids for iOS (bundle id), Android (package plus the SHA-1 of the Play app signing key from Play Console → App integrity, and of the EAS upload key from `eas credentials`) and web. **GitHub variables** `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, and **fly secret** `GOOGLE_CLIENT_IDS` = all three, comma-separated. Unblocks: the Google button (hidden without them). On iOS it comes only together with Sign in with Apple: set `APPLE_CLIENT_ID` (step 4, the fly secret and the GitHub variable) first, or leave `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` unset until you have; the iOS build workflow and `app.config.js` refuse a build that would offer Google alone, and never unset the server's `APPLE_CLIENT_ID` while an iOS build with Google sign-in is in players' hands.

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
- [ ] **fly secret** `REVENUECAT_WEBHOOK_SECRET`, last in this step, when the products above can be bought in a build: generate it and look at it first (`S="$(openssl rand -hex 32)"; echo "$S"`), because RevenueCat needs the same value and Fly never shows it again. RevenueCat → Integrations → Webhooks: URL `https://<app>.fly.dev/api/webhooks/revenuecat`, Authorization `Bearer <the same value>`; send the test event (the server answers `{"outcome":"test"}`). Unblocks: the server granting purchases, and `storeEnabled` in `/api/config`. Setting it is what makes the store live (next line).
- [ ] **fly secret** `REVENUECAT_SECRET_KEY` (RevenueCat → API keys → a secret v1 key; never in the app). Unblocks: reconciliation after Restore and nightly, for purchases whose webhook was lost.
- [ ] Once the store is live (the webhook secret is set), club ownership needs The Four Winds Club: creating a club without the plan answers `fourwinds_required`. Before that, anyone may create clubs. If you set the secret too early, `fly secrets unset -a <app> REVENUECAT_WEBHOOK_SECRET` opens club creation again.

### 8. Testers and the sandbox

- [ ] Apple: App Store Connect → Users and Access → Sandbox → testers. Google: Play Console → Settings → License testing → add the testers' Google accounts.
- [ ] Each tester opens the app once online and reads Settings → Account → "Player id". **fly secret** `TESTER_USER_IDS` = those ids, comma-separated. Unblocks: sandbox purchases granting anything; everyone else's are recorded as `ignored_sandbox`, so free test purchases never become real balances.
- [ ] Before each store submission: a demo account for the reviewer that is already on that list. App Review buys in the sandbox, and a reviewer's own fresh guest account can never be on the list in advance, so without this every purchase the reviewer makes grants nothing and "create a club" keeps asking for the plan. On a test device make an account, link it to an Apple or Google identity created for the purpose (Settings → Account), add its Player id to `TESTER_USER_IDS`, check on a TestFlight build that a sandbox subscription arrives and a club can be created, and put that identity's e-mail and password in the review notes ([`STORE_COMPLIANCE.md`](STORE_COMPLIANCE.md), "App Review notes"; `docs/store/listing/*.md`, "Review notes"). If a reviewer writes back with the Player id of another account, add that id and ask them to buy again.

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
- [ ] **fly secret** `POSTHOG_KEY` (optional `POSTHOG_HOST`) and **GitHub variables** `EXPO_PUBLIC_POSTHOG_KEY`, `EXPO_PUBLIC_POSTHOG_HOST` (`https://eu.i.posthog.com` for an EU project). Unblocks: server events and the app funnel. Both are opt-in: the app asks once after the age question and sends nothing until the player agrees; whether that is enough in each launch market is a question for counsel.
- [ ] An uptime alert on `https://<app>.fly.dev/health` (Fly dashboard or any monitor), and Sentry alerts on new issues.
- [ ] Backups: on Neon's paid plan set the history retention to at least 7 days, take a weekly `pg_dump` to storage outside Neon, and do one restore drill before launch ([`DEPLOY.md`](DEPLOY.md), "Backups and recovery"). Unblocks: getting accounts and purchases back after a bad migration, a mistake or a lost Neon project.
- [ ] Logs: Fly keeps only recent lines. If you want history (for support or a dispute), ship the logs to a log store ([`OBSERVABILITY.md`](OBSERVABILITY.md), "Logs").

### 13. Device QA

- [ ] Install both builds (TestFlight on an iPhone, Play internal testing on a low-end Android phone) and work through [`QA.md`](QA.md), including the sandbox purchase, restore and refund with a tester account. Report what fails with the build number.

### Later, when needed

| Name | Where | What it does |
| --- | --- | --- |
| `MIN_BUILD` | fly secret | Turns away builds older than this build number ("Update required"). Default 0. |
| `MAINTENANCE_MESSAGE` | fly secret | Shows a message instead of online play while you work on the server; unset to reopen. |
| `AUTH_PEPPER_PREVIOUS` | fly secret | From the day you rotate `AUTH_PEPPER`: the old value (several, newest first, separated by commas). Keep it for at least 30 days and in practice for good: guest accounts that have not signed in again since the rotation are locked out the moment it is removed ([`DEPLOY.md`](DEPLOY.md), "Rotating the pepper"). |
| `FACEBOOK_APP_ID` | fly secret | Leave unset. It only makes the server accept Facebook Limited Login tokens; the app has no Facebook button yet, so a Facebook app would be created for nothing. |
| `TRUST_PROXY` | `fly.toml` (already `1`) | Proxies in front of the server, for per-IP limits. |
| `EXPO_PUBLIC_STORE_MODE=mock` | a local `apps/mobile/.env`, or the EAS `development` environment | Development builds only: a local mock store. The build workflows do not read it and release builds ignore it, so it does nothing as a GitHub variable. |
| Audio | files in `apps/mobile/assets/audio/` | Recorded calls and effects under the manifest names, with licence records. |
| zh-TW review | a native reviewer | `apps/mobile/src/i18n/locales/zh-TW/*.json` and the store listings in both languages. |
| Validation | your time | 20–30 player interviews, 3–5 beta clubs, a small acquisition test; recorded hands for the golden scoring check. |

Read by the code but never needed from you: `SENTRY_URL` (self-hosted Sentry only), `EXPO_BASE_URL` (set by the web-preview workflow), and the server's tuning and local-run switches in `apps/signal/README.md`, each also named in `apps/signal/.env.example`: `PORT`, `HOST_TABLES`, `MAX_HOSTED_TABLES` and `MAX_TABLES_PER_USER` (both already set in `fly.toml`), `QUICK_MATCH_FILL_MS`, `P2P_ROOMS`, `MIGRATE_ON_BOOT`, `MIGRATIONS_DIR`, `DATA_DIR`, `DATABASE_URL_TEST`, `ALLOW_EPHEMERAL` (first deploy without a database only, with the repository variable `SMOKE_EXPECT_STORAGE=memory`; [`DEPLOY.md`](DEPLOY.md) step 3), `SENTRY_ENVIRONMENT` and `SENTRY_RELEASE` (the defaults, `production` and Fly's image reference, are right), and the smoke test's `SMOKE_URL` and `SMOKE_EXPECT_STORAGE`.

## What it costs a month

Rough figures in US dollars for a small launch, to plan with, not to budget from: they are from the providers' published prices as remembered when this was written and were **not checked against the current price pages** (no access from here). Check each link in the provider's dashboard before you rely on a number.

| What | Rough cost | Assumption |
| --- | --- | --- |
| Fly.io machine | 5–15 a month | One always-on `shared-cpu-1x` with 512 MB in Singapore, modest traffic. A dedicated IPv4 address, if you add one, is about 2 a month more; a larger machine for more than 200 tables costs more |
| Neon Postgres | 5–25 a month | The paid plan (needed so the database never sleeps and keeps days of history), a small database, one region |
| Apple Developer Program | 99 a year (about 8 a month) | Company membership |
| Google Play developer account | 25 once | |
| Expo EAS builds | 0, or from about 19 a month | The free plan's monthly allowance of low-priority builds covers a few builds a week; a paid plan when the queue wait matters |
| RevenueCat | 0, then about 1% of tracked revenue | Free below a monthly revenue threshold (about 2,500) |
| Store commission | 15–30% of every purchase | Taken by Apple and Google before you are paid (15% in their small-business programmes) |
| Sentry, PostHog | 0 | Free tiers, at this size |
| GitHub Actions | 0, or a few dollars | Free for a public repository; a private one has a monthly allowance of minutes, and one push runs three CI jobs (roughly 15–25 minutes in total) |
| A domain for table links and the legal pages | 10–20 a year | Static pages hosted free |

Before any revenue that is roughly 20 to 50 a month, plus Apple's yearly fee and Play's one-time fee. The first deploy can start on Neon's free plan and Fly's smallest machine; move Neon to the paid plan before real players arrive.
