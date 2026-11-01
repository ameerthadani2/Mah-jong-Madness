# Running it from your phone only

No computer needed. GitHub Actions does the building; you tap buttons in Safari.

## Step 1 — see it in Expo Go (free Expo account, ~15 minutes the first time)

1. **Expo account**: in Safari open expo.dev → Sign up. Then go to *Account settings → Access tokens → Create token*, name it `github`, copy the token.
2. **GitHub secret**: open github.com/ameerthadani2/Mah-jong-Madness → *Settings → Secrets and variables → Actions → New repository secret*. Name `EXPO_TOKEN`, paste the token. Add a second secret `EXPO_OWNER` with your Expo username (the part after `@` on your expo.dev profile).
3. **Run the workflow**: *Actions → Publish to Expo Go → Run workflow* (choose the branch `claude/p2p-taiwanese-mahjong-app-9lzdls`). It takes 3–5 minutes. The first run also creates the EAS project and commits its id back to the branch.
4. **On the phone**: install **Expo Go** from the App Store, sign in with the same Expo account, open *Projects → Mahjong Madness → preview*. Turn the phone sideways.

Every later push to the branch republishes automatically; in Expo Go just reopen the project.

What works in Expo Go: everything offline — bots, coach, daily puzzle, Puzzle Rush, drills, lessons, hand review, the shop with mock purchases. Online tables need a signaling server reachable from the phone (see step 3).

## Step 2 — TestFlight (uses your Apple Developer membership, ~20 minutes of setup once)

You need four more secrets. All can be created in Safari on the phone:

| Secret | Where to get it |
| --- | --- |
| `APPLE_TEAM_ID` | developer.apple.com → Account → Membership details → Team ID (10 characters) |
| `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` | appstoreconnect.apple.com → Users and Access → Integrations → App Store Connect API → Team Keys → **Generate API Key**, name `eas`, access **App Manager**. Copy the Key ID and Issuer ID. Download the `.p8` file (Safari saves it to Files); open it in Files, select all the text and paste it as the `ASC_KEY_P8` secret. The `.p8` can be downloaded only once. |

Then *Actions → iOS TestFlight build → Run workflow* with profile `production` and submit `true`. EAS registers the bundle id, generates the signing certificate and provisioning profile using the API key, builds (10–20 minutes) and uploads to App Store Connect. When processing finishes, open App Store Connect → *Apps → Mahjong Madness → TestFlight → Internal Testing*, add yourself, and install via the TestFlight app. Internal testers need no review.

If the build step stops asking for credentials it cannot create non-interactively, open expo.dev → the project → *Credentials* in Safari: EAS lets you upload or generate iOS credentials from the web dashboard, after which the workflow runs unattended.

## Step 3 — playing online with friends

The Clubs and Quick-table features need the small signaling server in `apps/signal` running somewhere public. From the phone you can deploy it on a free Node host that builds straight from GitHub (Render, Railway, Fly.io):
* Repo: this repository; root directory `apps/signal` is not required — use build command `npm ci` and start command `npm run signal` from the repo root; port from the `PORT` env (set `HOST_TABLES=1`).
* Once it has an address like `https://mahjong-signal.onrender.com`, put `wss://mahjong-signal.onrender.com` in the app under *Settings → Network*, or change `extra.signalUrl` in `apps/mobile/app.json` (GitHub's web editor works from the phone) so the next publish bakes it in.

## If something fails
The workflow log (tap the run in Actions) shows the step and the EAS error. The two common ones: `EXPO_TOKEN` missing or expired, and the TestFlight run before the Expo Go run (the project must be linked first).
