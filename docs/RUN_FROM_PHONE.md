# Running it from your phone only

No computer needed. GitHub builds everything; you tap buttons in Safari.

## Step 0 — play in Safari right now (1 minute, any iOS 14+)

1. github.com/ameerthadani2/Mah-jong-Madness → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Actions → Web preview (GitHub Pages) → Run workflow** (pick the branch you work on).
3. Open **https://ameerthadani2.github.io/Mah-jong-Madness/** in Safari. Share → *Add to Home Screen* makes it feel like an app.

Every push to `main` republishes it; for any other branch, run the workflow by hand. Offline play, the coach, puzzles, lessons, review and the shop work immediately; clubs and online tables need step 1.

## Step 1 — host the game server (about 20 minutes once; Fly.io asks for a payment method)

1. Follow `docs/DEPLOY.md` from a laptop once (Fly.io app + Neon database). The deploy workflow then redeploys on every push to `main` that touches the server.
2. The server address is `https://<your-fly-app>.fly.dev`.
3. GitHub → **Settings → Secrets and variables → Actions → Variables → New repository variable**: name `SIGNAL_URL`, value the same address with `wss://` instead of `https://`.
4. Re-run **Web preview (GitHub Pages)**. The website now creates and joins clubs on your server; send friends the Safari link and a club code.

The machine stays on (`fly.toml` keeps one running) and accounts, clubs and tables live in Postgres, so nothing resets on a redeploy.

## Step 2 — the native app on your iPhone through TestFlight (~20 minutes of setup once)

The app uses native modules (push notifications, crash reports, in-app purchases), so Expo Go cannot open it: the phone needs a real build. From a phone that means TestFlight, built by the **iOS TestFlight build** workflow. (With a computer, `docs/RUN_ON_IOS.md` also describes a development build that reloads code as you edit.)

1. **Expo account**: in Safari open expo.dev → Sign up. Then go to *Account settings → Access tokens → Create token*, name it `github`, copy the token.
2. **GitHub secrets**: open github.com/ameerthadani2/Mah-jong-Madness → *Settings → Secrets and variables → Actions → New repository secret*. Name `EXPO_TOKEN`, paste the token. Add a second secret `EXPO_OWNER` with your Expo username (the part after `@` on your expo.dev profile); the workflow's summary uses it to link to your build list.
3. **Apple secrets** (this uses your Apple Developer membership). Four more, all creatable in Safari on the phone:

| Secret | Where to get it |
| --- | --- |
| `APPLE_TEAM_ID` | developer.apple.com → Account → Membership details → Team ID (10 characters) |
| `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` | appstoreconnect.apple.com → Users and Access → Integrations → App Store Connect API → Team Keys → **Generate API Key**, name `eas`, access **App Manager**. Copy the Key ID and Issuer ID. Download the `.p8` file (Safari saves it to Files); open it in Files, select all the text and paste it as the `ASC_KEY_P8` secret. The `.p8` can be downloaded only once. |

4. **Run the workflow**: *Actions → iOS TestFlight build → Run workflow* (pick the branch you work on) with profile `production` and submit `true`. The first run also creates the EAS project and commits its id back to the branch. EAS registers the bundle id, generates the signing certificate and provisioning profile using the API key, builds (10–20 minutes) and uploads to App Store Connect.
5. **On the phone**: when processing finishes, open App Store Connect → *Apps → Mahjong Madness → TestFlight → Internal Testing*, add yourself, and install via the TestFlight app. Internal testers need no review. Turn the phone sideways for the roomiest table.

Each later run of the workflow ships a new TestFlight build; the build number increments by itself. Everything offline works in it: bots, coach, daily puzzle, Puzzle Rush, drills, lessons, hand review, the shop. Online tables use the server from step 1 (set `SIGNAL_URL` before building: the address is baked into the app). The store, Google sign-in, crash reporting and analytics switch on as you add the repository variables listed in `docs/OWNER_TODO.md`; the workflow copies them into the build.

If the build step stops asking for credentials it cannot create non-interactively, open expo.dev → the project → *Credentials* in Safari: EAS lets you upload or generate iOS credentials from the web dashboard, after which the workflow runs unattended.

## If something fails
The workflow log (tap the run in Actions) shows the step and the EAS error. The common ones: `EXPO_TOKEN` missing or expired, and an Apple secret pasted incompletely (`ASC_KEY_P8` must be the whole file, including its BEGIN and END lines).
