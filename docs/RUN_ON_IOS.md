# Running Mahjong Mania on iOS

Four routes. Route 2 (TestFlight from GitHub) is the one for testers and needs no computer set-up; the others start with:

```bash
git clone https://github.com/ameerthadani2/Mah-jong-Madness.git
cd Mah-jong-Madness
git checkout <branch>   # the branch you work on
npm install          # Node 22.13 or newer (what Expo, React Native and Metro require)
npm test             # optional sanity check
```

## 1. A development build on your iPhone — about 20 minutes the first time

**Expo Go no longer runs this app.** It now uses native modules that Expo Go does not contain (push notifications, Sentry crash reports, in-app purchases), so the phone needs a *development build*: your own copy of the app's native shell, which then loads the JavaScript from your computer exactly as Expo Go used to. You build it once; after that, code changes reload instantly as before.

1. One-time setup on your computer (Mac, Windows or Linux):
   ```bash
   npm install -g eas-cli
   cd apps/mobile
   eas login                 # free Expo account
   eas init                  # first time only: creates the EAS project
   eas device:create         # sends a link; open it on the iPhone to register it
   eas build --platform ios --profile development
   ```
   The cloud build takes 10–20 minutes. EAS prints a QR code when it finishes; scan it with the iPhone camera to install the development build. (No iPhone? `--profile simulator` builds one for the iOS Simulator on a Mac.)
2. Each session, from `apps/mobile`:
   ```bash
   npx expo start --dev-client
   ```
   Metro starts and prints a QR code. Keep the phone and the computer on the same Wi-Fi, scan the QR code with the camera, and the development build opens the app. It works upright or sideways; sideways gives the roomiest table.
3. If the QR code does not connect (corporate Wi-Fi, hotel, phone on cellular), use a tunnel instead:
   ```bash
   npx expo start --dev-client --tunnel
   ```

Rebuild the development build (step 1's last command) only when a native module or `app.config.js` changes; JavaScript changes never need one.

Everything offline works in a development build: play vs bots, coach, daily puzzle, Puzzle Rush, drills, lessons, hand review, settings.

**To play online from a development build** you also need the signalling server running somewhere the phone can reach:
```bash
npm run signal            # on your laptop, port 8787
```
Find the laptop's LAN address (macOS: System Settings → Wi-Fi → Details; or `ipconfig getifaddr en0`) and in the app go to **Settings → Network** and set the URL to `ws://<laptop-ip>:8787`. Create a table on one phone, join by code on another. For friends outside your Wi-Fi, deploy `apps/signal` as described in `docs/DEPLOY.md` (Fly.io + Neon) and use its `wss://…` address.

(The Settings → Network card only exists in development builds; release builds read the server address from the `SIGNAL_URL` repository variable.) Push notifications need a physical device and the push credentials in [`OWNER_TODO.md`](OWNER_TODO.md) (step 11); without them the app simply never asks.

## 2. TestFlight from GitHub — the normal route

The **iOS TestFlight build** workflow (`.github/workflows/ios-testflight.yml`) builds on EAS and submits to TestFlight with no Mac and no terminal.

One-time setup:

1. **Server and `SIGNAL_URL`**: deploy the server ([`DEPLOY.md`](DEPLOY.md)) and set the repository variable `SIGNAL_URL` to its `wss://` address. The workflow refuses to build without it, or with anything that is not `wss://` on a public host name (an IP address, `localhost`, a `.local`/`.lan`/`.internal` name or an address with a user name in it are all refused): a release build must never point at localhost.
2. **Repository secrets** (Settings → Secrets and variables → Actions): `EXPO_TOKEN` (expo.dev → Access tokens); from App Store Connect → Users and Access → Integrations → Team Keys, a key with the App Manager role: `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_KEY_P8` (the whole downloaded `.p8` file); and `APPLE_TEAM_ID` (developer.apple.com → Membership). Without any of them the run skips itself and its summary lists what to set up.
3. **The App Store Connect app record and `APP_STORE_ID`**: App Store Connect → Apps → + → New App, with the bundle id `com.mahjongmania.app` (or your `APP_BUNDLE_ID`), name "Mahjong Mania: Taiwan 16" and any SKU. (An API key cannot create the record, so this is the one manual step; the bundle id appears in the list once EAS has registered it, which the first build does. If it is not listed yet, run the workflow once with *submit* unticked, then create the record.) Then open the app → App Information, copy its **Apple ID** (digits only) and save it as the repository variable `APP_STORE_ID`. The workflow writes it into the submit profile (`ascAppId`); with *submit* ticked and no `APP_STORE_ID` the run stops before anything is built and its summary repeats this step.
4. Optional repository variables copied into the build: `APP_NAME`, `APP_SLUG`, `APP_SCHEME`, `APP_BUNDLE_ID`, `APP_VERSION`, `EXPO_PUBLIC_LINK_DOMAIN`, the `EXPO_PUBLIC_GOOGLE_*`, `EXPO_PUBLIC_REVENUECAT_*`, `EXPO_PUBLIC_TERMS_URL`, `EXPO_PUBLIC_PRIVACY_URL`, `EXPO_PUBLIC_SUPPORT_EMAIL` (or `EXPO_PUBLIC_SUPPORT_URL`), Sentry and PostHog values ([`OWNER_TODO.md`](OWNER_TODO.md)). With `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` set, `APPLE_CLIENT_ID` (the bundle id, as given to the server) is required too: an iOS build may not offer Google sign-in without Sign in with Apple, and the run stops before building if it would.

Each build: GitHub → Actions → **iOS TestFlight build** → Run workflow → pick the branch, profile `production`, *submit* ticked → Run. It checks the secrets, `APP_STORE_ID` and `SIGNAL_URL`, creates and links the EAS project on the first run (committing its id to `apps/mobile/app.json` on that branch), copies the variables into the EAS profile, builds, and submits the build to TestFlight (`--auto-submit`, with the API key written to the runner's temporary folder and the team id read from `APPLE_TEAM_ID`). The build number goes up by one on every production build (`autoIncrement`, kept on the EAS servers); the version string is `APP_VERSION`, or `app.json`'s `version`.

If the first run stops on signing credentials (EAS cannot always create a distribution certificate without a person), run `eas build --platform ios --profile production` once from a laptop (below), answer **yes** to letting EAS manage credentials, and run the workflow again: it reuses them from then on.

Then, once processing finishes (5–30 minutes): **App Store Connect → Apps → Mahjong Mania → TestFlight**, answer "No" to the encryption question if asked (the plist already declares non-exempt encryption = false), and under **Internal Testing** create a group and add yourself and your testers (up to 100 people with App Store Connect access; no review). Each tester installs **TestFlight** from the App Store, accepts the e-mail invitation and taps Install. External testers (up to 10,000, by e-mail or a public link) need a short Beta App Review first. For free test purchases, sign in to a **sandbox** account on the phone (Settings → App Store → Sandbox Account; created in App Store Connect → Users and Access → Sandbox) and put the tester's Player id in the server's `TESTER_USER_IDS`. Then work through [`QA.md`](QA.md).

## 3. TestFlight from a laptop

One-time setup (10 minutes):

```bash
npm install -g eas-cli
cd apps/mobile
eas login                 # free Expo account; create one at expo.dev if needed
eas init                  # creates the EAS project and writes its id into app.json
```

A laptop build does not see GitHub variables: set `SIGNAL_URL` (and any other value you use) as an EAS environment variable first (expo.dev → project → Environment variables, `preview` and `production`). The workflow's check does not run here, but `app.config.js` makes the same one inside the EAS build: a `production` or `preview` build without a public `wss://` address stops with "SIGNAL_URL cannot be used" instead of shipping an app that talks to `ws://localhost:8787`.

First build and TestFlight upload (EAS does the Apple paperwork for you):

```bash
eas build --platform ios --profile production
```
* EAS asks for your Apple ID (the one on the Developer Program). It registers the bundle id `com.mahjongmania.app`, creates the distribution certificate and provisioning profile, and stores them in your Expo account. Answer **yes** to letting EAS manage credentials.
* The cloud build takes 10–20 minutes. You can close the terminal; `eas build:list` shows status.

```bash
eas submit --platform ios --latest --profile manual
```
* `--profile manual` makes EAS ask for what it needs. (The `production` submit profile reads the App Store Connect API key that the GitHub workflow writes.) On first run EAS asks for an App Store Connect API key or your Apple ID, and creates the App Store Connect app record if it does not exist yet (it will ask for the app name and the SKU).
* Then TestFlight as in route 2.

Each later release:
```bash
eas build --platform ios --profile production && eas submit --platform ios --latest --profile manual
```
The build number auto-increments; set `APP_VERSION` (EAS environment variable or repository variable) or bump `version` in `app.json` for a new version string.

Faster iteration without TestFlight — **internal distribution**:
```bash
eas device:create                                     # sends a link; open it on each iPhone once
eas build --platform ios --profile preview
```
EAS prints a QR code; scan it on a registered iPhone to install directly (ad-hoc provisioning, up to 100 devices). Store purchases do not work in these builds; use TestFlight for those.

Artwork: `assets/icon.png` (1024×1024), `assets/splash.png` and `assets/adaptive-icon.png` are generated placeholders in the house style; replace them with final art any time.

## 4. Local build with Xcode (Mac only)

```bash
cd apps/mobile
npx expo run:ios            # simulator
npx expo run:ios --device   # a plugged-in iPhone (needs a free Apple ID signing team in Xcode)
```
This generates the `ios/` folder (git-ignored), installs CocoaPods and launches. Use this route when adding native modules.

## Over-the-air updates
The app carries `expo-updates` (`updates.enabled` in `app.json`; the `preview` and `production` build profiles name the channels). No update has been published and no workflow publishes one: the manual route is `eas update --channel production` from `apps/mobile`, and it has not been tried from this repository.

The runtime version is a fingerprint of the native project and the resolved app config (`runtimeVersion.policy: fingerprint`), so a JavaScript update only reaches binaries built from the same native inputs. Publish an update with the same build environment as the binary it is for: the same `SIGNAL_URL`, bundle id, Google client ids, link domain and Sentry variables (the Sentry plugin is added only when they are set). With a different environment the update gets another runtime version and is simply not delivered. `APP_VERSION` does not change the fingerprint. The same holds for Android.

## Troubleshooting
* **"Unable to resolve @mjm/engine"** — run `npm install` from the repo root (workspaces), not inside `apps/mobile`.
* **Blank screen or stale code** — shake the phone → Reload, or restart Metro with `npx expo start --dev-client --clear` (from `apps/mobile`).
* **QR code opens Camera but nothing happens** — the development build must be installed first (step 1); the QR encodes a link only it can open.
* **"Cannot find native module" or a red screen naming RNSentry, ExpoNotifications or RNPurchases** — the app was opened in Expo Go or in a development build older than the native change; rebuild the development build.
* **Table says "Could not connect"** — the phone cannot reach the server. In a development build, check the laptop firewall allows port 8787 and that you used the LAN IP, not `localhost`; in a TestFlight build, check `https://<app>.fly.dev/health` or run `npm run smoke -w @mjm/signal -- <server>`.
* **The workflow fails at "Check SIGNAL_URL"** — set the repository variable `SIGNAL_URL` to the deployed server's `wss://` address.
* **The workflow is skipped** — a secret is missing; the run summary names it.
* **The workflow stops with "APP_STORE_ID is needed to submit"** — create the app record and set the variable (route 2, step 3), or untick *submit* to build only.
