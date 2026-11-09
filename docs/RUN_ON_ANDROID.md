# Running Mahjong Mania on Android

Two routes: the **Play internal testing track** for you and your testers (the normal route, built and submitted from GitHub), and an installable APK or a development build for quick checks. Expo Go cannot open this app (it uses native modules for push, crash reports and purchases).

## 1. Play internal testing, from GitHub

Internal testing reaches up to 100 testers by e-mail, needs no Google review, and installs from the Play Store like any app, so store purchases work (with a licence tester account, they are free test purchases).

### One-time setup

1. **Server and `SIGNAL_URL`**: deploy the server ([`DEPLOY.md`](DEPLOY.md)) and set the repository variable `SIGNAL_URL` to its `wss://` address. The workflow refuses to build without it, or with anything that is not `wss://` on a public host: a release build must never point at localhost.
2. **Expo**: create a free account at expo.dev and save an access token as the repository secret `EXPO_TOKEN`.
3. **Play Console**: pay the one-time developer fee, create the app ("Mahjong Mania: Taiwan 16", default language, app or game: game, free), and fill in enough of App content (privacy policy URL, ads: none, content rating, target audience, data safety) for internal testing.
4. **Service account**: Google Cloud console → IAM → Service accounts → create one, then Keys → Add key → JSON, and download it. In Play Console → Users and permissions → Invite new users → the service account's e-mail, with the app's **Release** permissions (release to testing tracks). Save the whole JSON file as the repository secret `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.
5. Optional repository variables, copied into the build by the workflow: the same list as the iOS workflow (`APP_*`, `EXPO_PUBLIC_*`, `SENTRY_ORG`, `SENTRY_PROJECT`; [`OWNER_TODO.md`](OWNER_TODO.md)). For Android push, add `google-services.json` as an EAS file variable named `GOOGLE_SERVICES_JSON`.

### Each build

GitHub → Actions → **Android Play build** → Run workflow → pick the branch, profile `production`, *submit* ticked → Run. It:

1. checks `SIGNAL_URL`, installs, and creates and links the EAS project on the first run (committing its id to `apps/mobile/app.json` on that branch);
2. builds a signed app bundle (`.aab`) on EAS. The first build creates the Android upload keystore on EAS and keeps it there (`eas credentials -p android` shows or downloads it; never lose it). The version code goes up by one on every production build (`autoIncrement`, kept on the EAS servers); the version players see is `APP_VERSION`, or `app.json`'s `version`;
3. submits it to the **internal testing** track as a **draft** release (`eas.json` → `submit.production.android`), with the service account key written to the runner only for that step and deleted afterwards.

Without `EXPO_TOKEN`, or without the service account key while submitting, the run skips itself and its summary lists what to set up. Untick *submit* to build without submitting (the run summary links the bundle).

**The very first upload is by hand.** Google's API refuses uploads for an app that has never had a bundle uploaded, so the first run's submit step fails with an error to that effect. Download the `.aab` from the link in the run summary (or expo.dev → project → Builds) and upload it once in Play Console → Testing → Internal testing → Create new release. Let Google manage the app signing key when asked (Play App Signing). Every later run submits by itself.

### Roll the draft out to testers

1. Play Console → Testing → **Internal testing** → Testers: create an e-mail list with your testers' Google accounts (up to 100) and save.
2. Releases: open the draft the workflow created → Review release → **Start rollout to Internal testing**. Processing takes a few minutes the first time, then seconds.
3. Copy the **opt-in link** from the Testers tab and send it to your testers.

### How testers join

1. Open the opt-in link on the phone (or a computer), signed in with the Google account that is on the list, and tap **Accept invitation** / **Become a tester**.
2. Follow **Download it on Google Play**, and install Mahjong Mania like any app. Updates arrive through the Play Store as you roll out new drafts.
3. To make test purchases free, add the tester's Google account in Play Console → Settings → **License testing** too, and put the tester's Player id (Settings → Account in the app) in the server's `TESTER_USER_IDS` ([`OWNER_TODO.md`](OWNER_TODO.md), step 8). Purchases on any other account are recorded and grant nothing.

Then work through [`QA.md`](QA.md) on a low-end Android phone.

### Google sign-in and app links need the signing certificate

With Play App Signing, Google re-signs the bundle, so the certificate on testers' phones is Google's, not the EAS upload key. Copy its SHA-1 and SHA-256 from Play Console → Setup → **App integrity**: the SHA-1 goes on the Android OAuth client in Google Cloud (add the EAS upload key's SHA-1 too, from `eas credentials -p android`, for builds installed outside Play), and the SHA-256 goes in `/.well-known/assetlinks.json` on your link domain.

## 2. Quick checks without Play

From `apps/mobile`, with `eas-cli` installed (`npm install -g eas-cli`, `eas login`):

```bash
eas build --platform android --profile preview        # an installable APK (internal distribution)
eas build --platform android --profile development    # a development build for npx expo start --dev-client
```

EAS prints a link and a QR code; open it on the phone and allow installing from that source. A build started from a laptop does not see GitHub variables: set `SIGNAL_URL` and the others as EAS environment variables (expo.dev → project → Environment variables, `preview` and `production`). The GitHub workflow can also build the preview APK (profile `preview`; it is never submitted). Store purchases do not work in an APK installed outside Play.

A local build with Android Studio: `npx expo run:android` (emulator or a phone with USB debugging); it generates the git-ignored `android/` folder.

## Troubleshooting

* **"SIGNAL_URL is not set" / "must start with wss://"**: set the repository variable to the deployed server, e.g. `wss://mahjong-signal.fly.dev`.
* **"APP_BUNDLE_ID … cannot be the Android package"**: Android packages allow letters, digits, `_` and dots only, each part starting with a letter; choose an id both stores accept before the first upload.
* **Submit fails with "Package not found" or "only releases with status draft may be created on draft app"**: the first upload must be by hand (above); the draft release status is already set.
* **Submit fails with a permission error**: the service account needs Release permissions on this app in Play Console → Users and permissions (it can take a few minutes to apply).
* **Version code already used**: a bundle was uploaded by hand with a higher version code; run `eas build:version:set -p android` once to raise the EAS counter above it.
* **Table says "Could not connect"**: the server is down or `SIGNAL_URL` was wrong when the build was made; check `https://<app>.fly.dev/health`, or run `npm run smoke -w @mjm/signal -- <server>`.
