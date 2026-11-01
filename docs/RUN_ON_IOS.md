# Running Mahjong Madness on iOS

Three routes, from fastest to most permanent. All of them start with:

```bash
git clone https://github.com/ameerthadani2/Mah-jong-Madness.git
cd Mah-jong-Madness
git checkout claude/p2p-taiwanese-mahjong-app-9lzdls
npm install          # Node 20 or newer
npm test             # optional sanity check: 79 tests
```

## 1. Expo Go on your iPhone — 2 minutes, no Mac needed for the phone side

1. Install **Expo Go** from the App Store on the iPhone or iPad.
2. On your computer (Mac, Windows or Linux), in the repo root:
   ```bash
   npm run mobile
   ```
   Metro starts and prints a QR code.
3. Make sure the phone and the computer are on the same Wi-Fi, then scan the QR code with the iPhone camera. Expo Go opens the app. Turn the phone sideways: the app is landscape-only.
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

Limitations in Expo Go: no WebRTC (tables relay through the signaling server, which is fine), and haptics work only on a physical device.

## 2. TestFlight build with EAS — share with friends without cables

Requirements: an Apple Developer Program membership ($99/year) and a free Expo account.

```bash
npm install -g eas-cli
cd apps/mobile
eas login
eas init                  # creates the project; copies its id into app.json automatically
```
`eas init` replaces the `REPLACE_WITH_EAS_PROJECT_ID` placeholders in `app.json`. Then:

```bash
eas build --platform ios --profile preview
```
EAS asks to log in to your Apple account, creates the signing certificate and provisioning profile for `com.mahjongmadness.app`, and builds in the cloud (10–20 minutes). The result is an **internal distribution** `.ipa`: register your devices once with `eas device:create` (it sends a link to install a profile on each iPhone), and after that every build gives you a QR code you can open on the phone to install.

For TestFlight instead of internal distribution:
```bash
eas build --platform ios --profile production
eas submit --platform ios --latest
```
Then add testers in App Store Connect → TestFlight. Store review notes live in `docs/STORE_COMPLIANCE.md`.

Before a production build, change `extra.signalUrl` in `app.json` to your deployed `wss://` server so the Club features work out of the box.

## 3. Local build with Xcode (Mac only)

```bash
cd apps/mobile
npx expo run:ios            # simulator
npx expo run:ios --device   # a plugged-in iPhone (needs a free Apple ID signing team in Xcode)
```
This generates the `ios/` folder (git-ignored), installs CocoaPods and launches. Use this route when adding native modules.

### Optional: true device-to-device WebRTC
Expo Go cannot load `react-native-webrtc`; a dev-client build can:
```bash
cd apps/mobile
npx expo install react-native-webrtc
# index.js, before registerRootComponent:
#   import { RTCPeerConnection } from 'react-native-webrtc';
#   import { registerPeerConnectionFactory } from './src/game/session';
#   registerPeerConnectionFactory((cfg) => new RTCPeerConnection(cfg));
eas build --platform ios --profile development      # or npx expo run:ios --device
```
With it, phones talk directly to the host phone and fall back to the relay only when NAT blocks them.

## Troubleshooting
* **"Unable to resolve @mjm/engine"** — run `npm install` from the repo root (workspaces), not inside `apps/mobile`.
* **Blank screen or stale code in Expo Go** — shake the phone → Reload, or restart Metro with `npm run mobile -- --clear`.
* **QR code opens Camera but nothing happens** — Expo Go must be installed first; the QR encodes an `exp://` link.
* **App is portrait in Expo Go** — Expo Go honours the `orientation` setting after the first load; rotate the phone.
* **Table says "Could not connect"** — the phone cannot reach the signaling URL; check the laptop firewall allows port 8787 and that you used the LAN IP, not `localhost`.
