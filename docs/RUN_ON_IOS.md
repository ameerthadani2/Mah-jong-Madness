# Running Mahjong Madness on iOS

Three routes, from fastest to most permanent. All of them start with:

```bash
git clone https://github.com/ameerthadani2/Mah-jong-Madness.git
cd Mah-jong-Madness
git checkout claude/p2p-taiwanese-mahjong-app-9lzdls
npm install          # Node 20 or newer
npm test             # optional sanity check: 90 tests
```

## 1. Expo Go on your iPhone — 2 minutes, no Mac needed for the phone side

1. Install **Expo Go** from the App Store on the iPhone or iPad.
2. On your computer (Mac, Windows or Linux), in the repo root:
   ```bash
   npm run mobile
   ```
   Metro starts and prints a QR code.
3. Make sure the phone and the computer are on the same Wi-Fi, then scan the QR code with the iPhone camera. Expo Go opens the app. It works upright or sideways; sideways gives the roomiest table.
4. If the QR code does not connect (corporate Wi-Fi, hotel, phone on cellular), use a tunnel instead:
   ```bash
   npm run mobile:tunnel
   ```
   This needs an Expo account the first time (`npx expo login`, free).

Everything offline works in Expo Go: play vs bots, coach, daily puzzle, Puzzle Rush, drills, lessons, hand review, shop (mock purchases), settings.

**To play online from Expo Go** you also need the signaling server running somewhere the phone can reach:
```bash
npm run signal            # on your laptop, port 8787
```
Find the laptop's LAN address (macOS: System Settings → Wi-Fi → Details; or `ipconfig getifaddr en0`) and in the app go to **Settings → Network** and set the URL to `ws://<laptop-ip>:8787`. Create a table on one phone, join by code on another. For friends outside your Wi-Fi, deploy `apps/signal` to any Node host (Fly.io, Render, a small VPS) with TLS and use `wss://…`.

Limitation in Expo Go: haptics work only on a physical device. (The Settings → Network card only exists in development builds; release builds read the server address from the `SIGNAL_URL` repository variable.)

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
* EAS asks for your Apple ID (the one on the Developer Program). It registers the bundle id `com.mahjongmadness.app`, creates the distribution certificate and provisioning profile, and stores them in your Expo account. Answer **yes** to letting EAS manage credentials.
* The cloud build takes 10–20 minutes. You can close the terminal; `eas build:list` shows status.

```bash
eas submit --platform ios --latest --profile manual
```
* `--profile manual` makes EAS ask for what it needs. (The `production` submit profile reads App Store Connect API key secrets that only the GitHub TestFlight workflow has.) On first run EAS asks for an App Store Connect API key or your Apple ID, and creates the App Store Connect app record if it does not exist yet (it will ask for the app name "Mahjong Madness" and the SKU).
* Processing in App Store Connect takes 5–30 minutes. Then open **App Store Connect → Apps → Mahjong Madness → TestFlight**, click the build, answer "No" to the encryption question if asked (the plist already declares non-exempt encryption = false), and add yourself under **Internal Testing**. Install TestFlight on the iPhone, accept the invite, tap Install.
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
* **Blank screen or stale code in Expo Go** — shake the phone → Reload, or restart Metro with `npm run mobile -- --clear`.
* **QR code opens Camera but nothing happens** — Expo Go must be installed first; the QR encodes an `exp://` link.
* **Table says "Could not connect"** — the phone cannot reach the signaling URL; check the laptop firewall allows port 8787 and that you used the LAN IP, not `localhost`.
