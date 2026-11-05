# Running it from your phone only

No computer needed. GitHub builds everything; you tap buttons in Safari.

## Step 0 — play in Safari right now (1 minute, any iOS 14+)

1. github.com/ameerthadani2/Mah-jong-Madness → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Actions → Web preview (GitHub Pages) → Run workflow** (branch `claude/p2p-taiwanese-mahjong-app-9lzdls`).
3. Open **https://ameerthadani2.github.io/Mah-jong-Madness/** in Safari. Share → *Add to Home Screen* makes it feel like an app.

Every push to the branch republishes it. Offline play, the coach, puzzles, lessons, review and the shop work immediately; clubs and online tables need step 1.

## Step 1 — host the club server (5 minutes, free)

1. Follow `docs/DEPLOY.md` from a laptop once (Fly.io app + Neon database; about 20 minutes). The deploy workflow then redeploys on every push.
2. The server address is `https://<your-fly-app>.fly.dev`.
4. GitHub → **Settings → Secrets and variables → Actions → Variables → New repository variable**: name `SIGNAL_URL`, value the same address with `wss://` instead of `https://`.
5. Re-run **Web preview (GitHub Pages)**. The website now creates and joins clubs on your server; send friends the Safari link and a club code.

Free-plan caveats: the server sleeps after 15 minutes idle (the first connection then takes about 50 seconds), and its disk is wiped on redeploy, so clubs reset. A paid instance with a persistent disk fixes both.

## Step 2 — the native app in Expo Go (free Expo account, ~15 minutes the first time)

1. **Expo account**: in Safari open expo.dev → Sign up. Then go to *Account settings → Access tokens → Create token*, name it `github`, copy the token.
2. **GitHub secret**: open github.com/ameerthadani2/Mah-jong-Madness → *Settings → Secrets and variables → Actions → New repository secret*. Name `EXPO_TOKEN`, paste the token. Add a second secret `EXPO_OWNER` with your Expo username (the part after `@` on your expo.dev profile).
3. **Run the workflow**: *Actions → Publish to Expo Go → Run workflow* (choose the branch `claude/p2p-taiwanese-mahjong-app-9lzdls`). It takes 3–5 minutes. The first run also creates the EAS project and commits its id back to the branch.
4. **On the phone**: install **Expo Go** from the App Store, sign in with the same Expo account, open *Projects → Mahjong Madness → preview*. Turn the phone sideways.

Every later push to the branch republishes automatically; in Expo Go just reopen the project.

What works in Expo Go: everything offline — bots, coach, daily puzzle, Puzzle Rush, drills, lessons, hand review, the shop with mock purchases. Online tables need a signaling server reachable from the phone (see step 3).

## Step 3 — TestFlight (uses your Apple Developer membership, ~20 minutes of setup once)

You need four more secrets. All can be created in Safari on the phone:

| Secret | Where to get it |
| --- | --- |
| `APPLE_TEAM_ID` | developer.apple.com → Account → Membership details → Team ID (10 characters) |
| `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` | appstoreconnect.apple.com → Users and Access → Integrations → App Store Connect API → Team Keys → **Generate API Key**, name `eas`, access **App Manager**. Copy the Key ID and Issuer ID. Download the `.p8` file (Safari saves it to Files); open it in Files, select all the text and paste it as the `ASC_KEY_P8` secret. The `.p8` can be downloaded only once. |

Then *Actions → iOS TestFlight build → Run workflow* with profile `production` and submit `true`. EAS registers the bundle id, generates the signing certificate and provisioning profile using the API key, builds (10–20 minutes) and uploads to App Store Connect. When processing finishes, open App Store Connect → *Apps → Mahjong Madness → TestFlight → Internal Testing*, add yourself, and install via the TestFlight app. Internal testers need no review.

If the build step stops asking for credentials it cannot create non-interactively, open expo.dev → the project → *Credentials* in Safari: EAS lets you upload or generate iOS credentials from the web dashboard, after which the workflow runs unattended.

## If something fails
The workflow log (tap the run in Actions) shows the step and the EAS error. The two common ones: `EXPO_TOKEN` missing or expired, and the TestFlight run before the Expo Go run (the project must be linked first).
