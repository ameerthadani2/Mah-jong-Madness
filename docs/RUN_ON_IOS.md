# Running Mahjong Mania on iOS

Three routes, from quickest to most permanent. All of them start with:

```bash
git clone https://github.com/ameerthadani2/Mah-jong-Madness.git
cd Mah-jong-Madness
git checkout <branch>   # the branch you work on
npm install          # Node 20 or newer
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

(The Settings → Network card only exists in development builds; release builds read the server address from the `SIGNAL_URL` repository variable.) Push notifications need a physical device and the push credentials in `docs/OWNER_TODO.md` (Phase 6 — app); without them the app simply never asks.

## 2. TestFlight with EAS — you have an Apple Developer membership, so this is the route

One-time setup (10 minutes):

```bash
npm install -g eas-cli
cd apps/mobile
eas login                 # free Expo account; create one at expo.dev if needed
eas init                  # creates the EAS project and writes its id into app.json
```

First build and TestFlight upload (EAS does the Apple paperwork for you):

```bash
eas build --platform ios --profile production
```
* EAS asks for your Apple ID (the one on the Developer Program). It registers the bundle id `com.mahjongmania.app`, creates the distribution certificate and provisioning profile, and stores them in your Expo account. Answer **yes** to letting EAS manage credentials.
* The cloud build takes 10–20 minutes. You can close the terminal; `eas build:list` shows status.

```bash
eas submit --platform ios --latest --profile manual
```
* `--profile manual` makes EAS ask for what it needs. (The `production` submit profile reads App Store Connect API key secrets that only the GitHub TestFlight workflow has.) On first run EAS asks for an App Store Connect API key or your Apple ID, and creates the App Store Connect app record if it does not exist yet (it will ask for the app name "Mahjong Mania" and the SKU).
* Processing in App Store Connect takes 5–30 minutes. Then open **App Store Connect → Apps → Mahjong Mania → TestFlight**, click the build, answer "No" to the encryption question if asked (the plist already declares non-exempt encryption = false), and add yourself under **Internal Testing**. Install TestFlight on the iPhone, accept the invite, tap Install.
* External testers (up to 10,000) need a short Beta App Review; internal testers (up to 100 people on your team) do not.

Each later release:
```bash
eas build --platform ios --profile production && eas submit --platform ios --latest --profile manual
```
The build number auto-increments (`autoIncrement` in `eas.json`); bump `version` in `app.json` when you want a new TestFlight version string.

Faster iteration without TestFlight review cycles — **internal distribution**:
```bash
eas device:create                                     # sends a link; open it on each iPhone once
eas build --platform ios --profile preview
```
EAS prints a QR code; scan it on a registered iPhone to install directly (ad-hoc provisioning, up to 100 devices).

Before building for others, set `extra.signalUrl` in `app.json` to your deployed signaling server (`wss://…`) so Clubs work out of the box; `ws://localhost:8787` only works for a laptop on the same Wi-Fi with the address changed in Settings.

Artwork: `assets/icon.png` (1024×1024), `assets/splash.png` and `assets/adaptive-icon.png` are generated placeholders in the house style; replace them with final art any time.

## 3. Local build with Xcode (Mac only)

```bash
cd apps/mobile
npx expo run:ios            # simulator
npx expo run:ios --device   # a plugged-in iPhone (needs a free Apple ID signing team in Xcode)
```
This generates the `ios/` folder (git-ignored), installs CocoaPods and launches. Use this route when adding native modules.

## Troubleshooting
* **"Unable to resolve @mjm/engine"** — run `npm install` from the repo root (workspaces), not inside `apps/mobile`.
* **Blank screen or stale code** — shake the phone → Reload, or restart Metro with `npx expo start --dev-client --clear` (from `apps/mobile`).
* **QR code opens Camera but nothing happens** — the development build must be installed first (step 1); the QR encodes a link only it can open.
* **"Cannot find native module" or a red screen naming RNSentry, ExpoNotifications or RNPurchases** — the app was opened in Expo Go or in a development build older than the native change; rebuild the development build.
* **Table says "Could not connect"** — the phone cannot reach the signaling URL; check the laptop firewall allows port 8787 and that you used the LAN IP, not `localhost`.
