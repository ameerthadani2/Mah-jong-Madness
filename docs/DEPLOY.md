# Deploying the signal server

The signal server (`apps/signal`) hosts tables, relays WebSocket traffic, runs the club API and
owns accounts and sessions. It runs on **Fly.io** in Singapore (`sin`) as one always-on machine,
with **Neon** Postgres in `ap-southeast-1` (also Singapore) for durable state.

Nothing here is required for local development: with no environment set, `npm run signal` uses
in-memory storage, guest-only sign-in and a random per-process session pepper (each with a
warning). `apps/signal/README.md` lists every variable and route.

## First deploy, in order

About an hour the first time. You need a Fly.io account with a payment method (a `shared-cpu-1x`
machine with 512 MB is about US$5–15 a month; the whole stack's rough monthly cost is in
[`OWNER_TODO.md`](OWNER_TODO.md)), a Neon account, and admin rights on the GitHub repository. Every command runs from the repository root.

### 1. Create the Fly app and name it in `fly.toml`

```bash
brew install flyctl            # or: curl -L https://fly.io/install.sh | sh
fly auth login
fly apps create <name>         # the name becomes https://<name>.fly.dev
```

Open `fly.toml`, replace the placeholder on the `app = "mahjong-signal"` line with `<name>`, and
commit it on the branch you will deploy. Then create a deploy token and store it in GitHub
(Settings → Secrets and variables → Actions → New repository secret):

```bash
fly tokens create deploy -a <name>     # copy the whole output, including "FlyV1 "
```

Secret name: **`FLY_API_TOKEN`**. Until it exists the deploy workflow skips itself (green, with
these steps in its summary).

### 2. Create the Neon project: a pooled and a direct URL

1. neon.tech → New project → region **AWS Asia Pacific (Singapore)** (`ap-southeast-1`),
   Postgres 16 or newer.
2. Dashboard → Connect: copy two connection strings for the default database, each ending in
   `?sslmode=require`:
   - **Pooled** (the host contains `-pooler`): the running server's queries use it. This is
     `DATABASE_URL`.
   - **Direct** (no `-pooler`): migrations hold a transaction open across many statements, and the
     single-host lock is a session advisory lock that does not survive a transaction pooler, so
     both use this one. This is `DATABASE_URL_DIRECT`.
3. Before launch, move Neon to a paid plan so the database never suspends (the free tier sleeps
   when idle, and the first query after that takes a few seconds), and set how far back its
   point-in-time history reaches ("Backups and recovery" below: the free plan keeps very little).
   A branch of the database makes a cheap staging copy.

### 3. Set the server's secrets

Generate the two secrets the server needs from you, **look at them, and save both in your
password manager before going on**. Fly stores secrets write-only: once set, a value can never
be read back, and you will need both again (the pepper to restore or move the server, the admin
token for every support and moderation call).

```bash
PEPPER="$(openssl rand -hex 32)"; ADMIN="$(openssl rand -hex 32)"
echo "AUTH_PEPPER=$PEPPER"      # save it now: without it every guest account is locked out for good
echo "ADMIN_TOKEN=$ADMIN"       # save it now: the Bearer value for /api/admin/*

fly secrets set -a <name> \
  DATABASE_URL='postgres://…-pooler….neon.tech/neondb?sslmode=require' \
  DATABASE_URL_DIRECT='postgres://….neon.tech/neondb?sslmode=require' \
  AUTH_PEPPER="$PEPPER" \
  ADMIN_TOKEN="$ADMIN"
```

That is everything for the first deploy. The server **fails closed**: with `NODE_ENV=production`
(set in `fly.toml`) it refuses to boot without `DATABASE_URL` and `AUTH_PEPPER`. The other
secrets switch features on as they arrive; set each later the same way (each `fly secrets set`
restarts the machine, and tables survive it), and show and save any value you generate before
you set it.

**Do not set `REVENUECAT_WEBHOOK_SECRET` yet.** Setting it makes the store live: from that
moment creating a club needs The Four Winds Club, and until the products exist in the stores and
in RevenueCat and a build carries the purchase keys, nobody can buy that plan, so nobody could
create a club. Set it, with `REVENUECAT_SECRET_KEY` and `TESTER_USER_IDS`, when
[`OWNER_TODO.md`](OWNER_TODO.md) steps 6 to 8 are done.

| Secret | What it unblocks | Absent |
| --- | --- | --- |
| `DATABASE_URL` | Accounts, clubs, wallets and tables survive restarts and deploys | boot refused in production |
| `DATABASE_URL_DIRECT` | Migrations and the single-host lock over a direct connection | both use `DATABASE_URL`, with a warning; through the pooler the lock is not reliable |
| `AUTH_PEPPER` | Sessions and guest secrets that survive restarts. Keep a copy in your password manager: losing it signs every player out and locks every guest account out for good, because the secret on the phone is a guest's only credential (see "Rotating the pepper") | boot refused in production |
| `ADMIN_TOKEN` | Support grants (`POST /api/admin/grant`) and the moderation endpoints | those routes answer 503 |
| `REVENUECAT_WEBHOOK_SECRET` | Real purchases: the store webhook, and `storeEnabled` in `/api/config`. Generate it, show it and save it (`S="$(openssl rand -hex 32)"; echo "$S"`), set it, and put the same value in RevenueCat → Integrations → Webhooks as `Bearer <value>`, URL `https://<name>.fly.dev/api/webhooks/revenuecat`. **Setting it makes the store live: from then on creating a club needs The Four Winds Club**, so set it only when the products can be bought (OWNER_TODO steps 6 and 7) | the app shows "Store unavailable", and anyone may create a club |
| `REVENUECAT_SECRET_KEY` | Reconciliation after Restore and nightly (RevenueCat → API keys → a secret v1 key) | a purchase whose webhook was lost stays missing until support grants it |
| `TESTER_USER_IDS` | Sandbox purchases (TestFlight, Play testing) are granted to these accounts only. Ids come from Settings → Account → "Player id" on each tester's phone, so this one is usually set after the first builds | every sandbox purchase is recorded and ignored |
| `CORS_ORIGINS` | The web preview (and any other web page) may call the API: the origins allowed, comma-separated, e.g. `https://<owner>.github.io` (scheme and host only, no path). The native apps need nothing | a browser blocks every API call from the web build ("Failed to fetch"), so it cannot sign in, open a table or join a club; the server's boot line says `CORS same origin only` |

Sign-in providers, push, Sentry and PostHog have their own secrets (`APPLE_CLIENT_ID`,
`GOOGLE_CLIENT_IDS`, `EXPO_ACCESS_TOKEN`, `SENTRY_DSN`, `POSTHOG_KEY`, …): see
[`OWNER_TODO.md`](OWNER_TODO.md) and `apps/signal/README.md`.

To deploy before the database exists, say so explicitly, to the server and to the deploy
workflow: `fly secrets set -a <name> ALLOW_EPHEMERAL=1` (in-memory storage and a random pepper:
everything is lost at each restart) and the repository variable `SMOKE_EXPECT_STORAGE` =
`memory` (GitHub → Settings → Secrets and variables → Actions → Variables). Without the variable
the workflow's health check and smoke test fail, because a deployed server is expected to be on
Postgres. Once the secrets above are set, undo both: `fly secrets unset -a <name>
ALLOW_EPHEMERAL` and delete the variable. From then on a deploy that finds the server on memory
(the database secret was removed, or `ALLOW_EPHEMERAL` was left on) goes red instead of green.

### 4. Keep exactly one machine

The server keeps every table in memory and holds a Postgres advisory lock while it hosts them, so
it runs as exactly one machine. The workflow deploys with `--ha=false`, which creates one; after
the first deploy (and whenever `fly status` shows two), run:

```bash
fly scale count 1 -a <name>
```

A second process on the same database would wait up to 30 s for the lock and then exit 1 without
restoring or hosting anything (it never listens).

### 5. Deploy by dispatch

GitHub → Actions → **Deploy signal server** → Run workflow → pick the branch (the working branch
first; `main` once it is merged) → Run. The run:

1. typechecks and runs the engine, net and server tests, the Postgres cases included, on the
   exact commit (a manual run does not wait for CI, so the deploy job tests what it ships);
2. works out the address it will check (`SIGNAL_URL`, or the app in `fly.toml`) and stops here,
   with nothing deployed, if `SIGNAL_URL` is malformed;
3. builds `apps/signal/Dockerfile` on Fly's remote builder and deploys one machine; Fly's release
   command (`node dist/server.cjs migrate`) applies new migrations first, through
   `DATABASE_URL_DIRECT`, and a failed migration stops the release with the old version still
   running;
4. waits up to two minutes for `/health` to answer `{"ok":true}` with `storage: pg` (a redirect,
   another site's page or a server on memory does not count);
5. runs the smoke test (step 6) with `--expect-storage pg` and fails the job if it fails, with its
   output in the run summary. When the new version is live but a check failed, the summary shows
   the rollback commands (step 8).

A manual run always deploys the head of the branch you picked. Re-running an older run from the
Actions list is refused when its commit is no longer the head of that branch: start a new run
instead.

After this first time, a push to `main` deploys by itself once CI has passed whenever the head of
`main` differs, in anything the server is built from, from the commit that is deployed (see
"What a deploy does").

### 6. Smoke test

The workflow runs it after each deploy; run it by hand any time:

```bash
npm run smoke -w @mjm/signal -- https://<name>.fly.dev      # or wss://<name>.fly.dev
```

It checks `/health` (and that the database is `ok`), reads `/api/config`, creates a guest named
"Smoke test" (device id and platform marked `smoke`), opens a socket, opens a hosted table, adds
three bots, plays one whole hand for its own seat, checks that the hand's audit verifies, reads
`/health` again and fails if the table was not written to storage during the hand or any snapshot
write failed, leaves, deletes the account with `DELETE /api/me` (also when a step fails) and
checks that the deleted account's session now answers 401. It prints each step's time and exits
non-zero naming the failing step:

```text
ok    health         49 ms  storage pg, db ok, 0 tables, image registry.fly.io/<name>:deployment-01JC…
ok    config          4 ms  providers [], store off, minBuild 0
ok    guest          42 ms  user 7d657622-…
ok    socket         14 ms  peer p-5621d169b14f64dc
ok    table          27 ms  room YEF649, seat 0
ok    bots           24 ms  Smoke test, bot 小美 (Bot), bot 老王 (Bot), bot 阿花 (Bot)
ok    hand        29502 ms  18 own moves, 66 logged actions, won by seat 0
ok    audit           0 ms  hand 0 verified, 1 ceremony attempt(s)
ok    snapshot        8 ms  16 written during the hand, none failed, last at 2026-11-12T17:33:01.264Z
ok    leave           0 ms
ok    delete         18 ms  the session no longer works
PASSED in 29689 ms
```

Add `--expect-storage pg` for a deployed server (the workflow does): the run then fails at the
first step unless `/health` reports Postgres storage with the database answering. Without it a
server on memory passes, which is right for a local run and wrong for production, where memory
means every account and table is lost at the next restart. The `image` on the first line is the
build that answered (`FLY_IMAGE_REF`): compare it with `fly releases -a <name> --image` when you
doubt that the address points at the machine you just deployed.

The hand takes 15–60 s because server bots wait 0.6 s per move (`--hand-timeout <seconds>`
raises the 300 s limit). The table it opened stays listed with its bots for up to 15 minutes
after the smoke account has gone, then closes. In the deploy workflow the run can be skipped by
unticking "smoke" on a manual dispatch.

### 7. Point `SIGNAL_URL` at it

GitHub → Settings → Secrets and variables → Actions → Variables → New repository variable:
**`SIGNAL_URL`** = `wss://<name>.fly.dev` (or your own domain if you add a certificate with
`fly certs add`). The deploy workflow then health-checks and smoke-tests that address instead of
`https://<name>.fly.dev`, and the iOS and Android build workflows bake it into the apps; they
refuse to build without it, or with anything other than a `wss://` address on a public host name
(no IP address, no `localhost` or private name, no credentials in the address). For builds
started from a laptop with `eas build`, also set it as an EAS environment variable (expo.dev →
project → Environment variables, `preview` and `production`); `app.config.js` applies the same
rule there, so a `production` or `preview` build without it fails instead of pointing at
localhost.

### 8. Rollback

If a deploy misbehaves (the smoke test fails, `/health` flaps, players report errors):

```bash
fly releases -a <name> --image              # the image of every release, newest first
fly deploy -a <name> --image registry.fly.io/<name>:deployment-<id> --ha=false   # the last good one
npm run smoke -w @mjm/signal -- https://<name>.fly.dev
```

Tables survive a rollback the same way they survive a deploy (below). Migrations are never
undone. They add tables and columns, backfill them or relax a constraint, so an older image runs
against the newer schema and its release command finds nothing to apply (the one exception is
`0004`, which renamed stored entitlement values: never roll back to an image from before it). If a migration itself is the problem, restore the database from
Neon's point-in-time history to a moment before the deploy ("Backups and recovery" → Restoring:
stop the server first), then deploy the last good image. Fix forward on the branch and dispatch
again when ready. "A deploy that fails half-way" lists what is running after each kind of failure.

## What a deploy does

The workflow (`.github/workflows/deploy-signal.yml`) runs when the **CI** workflow has finished
successfully for a push to `main` (`workflow_run`), and on **Run workflow** in the Actions tab
(any branch, always deploys the head of that branch). A failed or cancelled CI run, or one for a
pull request, never deploys.

1. **check** decides whether the commit CI tested is deployed:
   - Only the head of `main` is. If CI finished (or was re-run) for a commit that is no longer
     the head, the run ends green with "not the head of main" in its summary: an older commit is
     never deployed over a newer one, and the run for the head decides.
   - The head is compared with **the commit that is deployed**: the commit of the newest run of
     this workflow whose `deploy` job succeeded (read with `gh run list` and `gh run view`). It
     deploys when anything the image is built from differs between the two (`apps/signal`, the
     engine and net packages, `package.json`, the lockfile, `tsconfig.base.json`, `fly.toml` or
     the workflow itself), so a server change is shipped even when the last commit of the push
     touched only documents or the app. It also deploys when no earlier deploy is found, when
     the list of runs cannot be read, or when the deployed commit is not an ancestor of the head
     (it was deployed by hand from another branch).
   - If `FLY_API_TOKEN` is not set, the run stops here and the job summary lists the setup
     steps. Nothing fails.

   What the check cannot know: a rollback or a `fly deploy` done by hand is not a workflow run,
   so afterwards "the deployed commit" is still the last one the workflow shipped. After a manual
   rollback, deploy the fix with **Run workflow** (or any server change on `main`).
2. **deploy**: checks out that commit, installs the server's workspaces, typechecks and runs the
   engine, net and server tests against a `postgres:16` service (so the repository, migration,
   timeout and host-lock cases run), settles the address to check (a malformed `SIGNAL_URL` stops
   the run before anything is deployed), then `flyctl deploy --remote-only --ha=false` with flyctl from
   `superfly/flyctl-actions/setup-flyctl` pinned to release 1.6. Fly's builder builds
   `apps/signal/Dockerfile`, then:
   - the **release command** applies new migrations in a temporary machine with the app's
     secrets (it prints a note and succeeds when there is no database yet);
   - the machine is replaced (rolling), and Fly waits for `/health` to pass. The new process takes
     the host lock as soon as the old one has written its tables and let go of it. If the lock's
     connection is lost while the new process is still starting (a database restart in the middle
     of the deploy), that process exits 1 without listening or writing any table, and Fly starts
     it again.
3. It polls `/health` at `SIGNAL_URL` (turned into `https://`), or at
   `https://<app in fly.toml>.fly.dev` without the variable, for up to two minutes, until the
   answer is the server's own report with `"ok":true` and `storage: pg` (or `memory`, when the
   repository variable `SMOKE_EXPECT_STORAGE` says the deployment has no database on purpose).
4. It runs the smoke test against the same address, with the same expected storage, and fails
   the job if it fails.

The jobs have time limits (10 minutes for the check, 40 for the deploy), so a hung build or
rollout cannot hold the next deploy back for hours.

**Tables survive a deploy.** On SIGTERM (Fly sends it, then waits `kill_timeout = 30s`) the
server stops accepting requests and socket upgrades (`/health` answers 503 `draining`), writes
every hosted table to `table_snapshots`, closes the sockets without finishing any table and gives
up the host lock; it never takes longer than 20 s, even with a hung database. The new machine
restores every unfinished table at boot under its own code; the apps reconnect with backoff and
reclaim their seats with their rejoin tokens, and bots play for anyone not back yet. A restored
table waits 15 minutes for its players. (With in-memory storage there is nothing to restore from,
so a deploy ends every table.)

## Health and a slow database

`/health` answers 200 `{ok:true, db:"ok", ...}` normally, and 503 `{ok:false, db:"down"}` when
the database does not answer within 2 s, so Fly's check and proxy notice a frozen or unreachable
database. Every query gives up after 5 s (and on the direct connection Postgres cancels the
statement), so a hung database slows requests down without hanging the process. If the host
lock's connection fails or stops answering, the server freezes its tables, writes what it can and
exits 1, and Fly starts it again (a lock lost before the server was listening stops the boot the
same way, with nothing written). A table socket whose session could not be checked in time is
closed with 1013 (try again later), never 4401, so the app keeps its session and reconnects.

Per-address limits count an IPv4 address or an IPv6 /64 prefix (Fly passes IPv6 client addresses
in `x-forwarded-for`), so the addresses of one IPv6 customer share one allowance.

`fly.toml` already sets `PORT=8787`, `HOST_TABLES=1`, `TRUST_PROXY=1` (Fly's proxy supplies
`x-forwarded-for`), `NODE_ENV=production`, `MAX_HOSTED_TABLES=200` and `MAX_TABLES_PER_USER=3`;
`apps/signal/.env.example` names every variable the server reads, with notes (`MIN_BUILD`,
`MAINTENANCE_MESSAGE`, `MIGRATE_ON_BOOT`, …); a test keeps that file and the README's table
complete.

**Capacity.** `MAX_HOSTED_TABLES=200` fits one `shared-cpu-1x` machine with 512 MB: 200 tables of
four players are 800 WebSockets, under the `[http_service.concurrency]` `hard_limit` of 1000 with
room for onlookers and reconnects. Raise both together (and the machine size) when the tables run
out: the hard limit must stay above 4 x `MAX_HOSTED_TABLES` plus onlookers.

## Backups and recovery

The database holds everything players own: accounts and their only credential hashes, wallets,
purchases, entitlements, clubs, standings and the tables in play. The machine holds nothing that
outlives it. So recovery is about two things: getting the database back, and getting a machine
running against it.

Steps marked **(not tried here)** need your Fly or Neon account and could not be run while this
runbook was written; the rest was run against the production bundle and a local Postgres 16.

### Backups

1. **Neon's history (not tried here).** Neon keeps a point-in-time history of every branch and
   can restore to any moment inside it. How far back it reaches is a setting of the project
   (Settings → Storage → history retention) and is capped by the plan: the free plan keeps very
   little, a paid plan can keep days. Before launch, on the paid plan, set it to at least 7 days
   and note the value here. This is the backup for "a bad migration" or "we deleted the wrong
   rows an hour ago".
2. **A weekly dump kept outside Neon.** History inside Neon does not help when the Neon project
   itself is lost, suspended or deleted. Once a week (and before every risky change) dump the
   database from a laptop through the **direct** URL, and keep the file somewhere that is not
   Neon and not the laptop (an encrypted bucket or drive). The server can stay up while it runs:

   ```bash
   pg_dump --no-owner --no-acl -Fc -f mahjong-$(date +%F).dump "$DATABASE_URL_DIRECT"
   ```

   Use a `pg_dump` at least as new as the server's Postgres. The file holds personal data
   (display names, linked e-mail addresses, purchase records) and the credential hashes, so treat
   it like the database itself and delete copies older than you need. Keeping `AUTH_PEPPER` in
   your password manager is part of the backup: without it a restored database signs nobody in.
3. **A restore drill before launch.** Restore the latest dump into a scratch database and run the
   server and the smoke test against it once (the commands of "Restoring" and "By hand"), so the
   first restore is not the one that matters.

### Restoring

The order matters: a running server keeps writing table snapshots and holds the host lock.

1. **Stop the server (not tried here):** `fly scale count 0 -a <name>`. Players see "Could not
   connect" until step 4. Put up a `MAINTENANCE_MESSAGE` first if you have a minute.
2. **Restore the data**, one of:
   - **Neon, to a moment in its history (not tried here):** Neon console → Branches → the main
     branch → Restore, to a time just before the damage. The connection strings stay the same.
   - **From a dump, into an empty database** (a new Neon database or project when the old one is
     gone; then set both URLs again with `fly secrets set`):

     ```bash
     pg_restore --no-owner --no-acl --exit-on-error -d "$DATABASE_URL_DIRECT" mahjong-2026-11-12.dump
     ```
3. **Bring the schema up to the code** if the backup is older than the last migration:
   `DATABASE_URL="$DATABASE_URL_DIRECT" npm run migrate -w @mjm/signal` from a laptop (it prints
   "database is up to date" when there is nothing to do), or let the next deploy's release
   command do it.
4. **Start the server (not tried here)** with `fly scale count 1 -a <name>`, or start the
   **Deploy signal server** workflow, which also runs migrations, the health check and the smoke
   test. Then `npm run smoke -w @mjm/signal -- https://<name>.fly.dev --expect-storage pg`.

What a restore costs players is everything after the restore point:

- **Accounts created after it are gone.** Such a phone still holds a guest id and secret the
  server no longer knows; signing in answers 401 and the app starts again as a new guest. (Tried
  here: an account from before the dump signed in after the restore, one created after it got
  401.) Apple and Google accounts sign in again and get a new, empty account.
- **Purchases made after it are missing from the server but not from the stores.** With
  `REVENUECAT_SECRET_KEY` set, the server re-applies them for accounts that still exist: when the
  player taps Restore purchases (`POST /api/wallet/sync`) and in the nightly reconciliation.
  Purchases of accounts that no longer exist need a support grant (`POST /api/admin/grant`).
- **Diamonds spent or earned, cosmetics bought, club changes, results and standings** go back to
  what they were.
- **Tables** come back as they were at the restore point: each waits 15 minutes for its players
  and then closes.

Tell players what happened and from when; the store listing's support address will hear about it.

### The machine is gone

What happens by itself: when the process crashes or the host restarts it, the next process takes
the host lock, restores every unfinished table from `table_snapshots` and listens again; the apps
reconnect and reclaim their seats. Tried here by killing the server with SIGKILL in the middle of
a hand: the next process was listening and had restored the tables in under a second, and a
record of a hand interrupted that way reads "partial" with the note that the server restarted
(Logged instead of Verified). A crash costs a few replayed turns, not the table.

When it does not come back (**not tried here**, these need the Fly account):

```bash
fly status -a <name>                    # is there a machine, and what state is it in?
fly logs -a <name>                      # why it stopped (a refused boot names the missing secret)
fly machine list -a <name>
fly machine start <machine id> -a <name>          # a stopped machine
fly scale count 0 -a <name> && fly scale count 1 -a <name>   # no machine, or a broken one: a new one from the last release
fly scale count 1 --region nrt -a <name>          # the region itself is down: start it elsewhere
```

A machine in another region still talks to the database in Singapore (slower queries, same
data); if Neon's region is down too, nothing serves until it returns, unless you restore a dump
into a database elsewhere and point both URLs at it. If an old machine is half alive and still
holds the host lock, the new one waits 30 s and exits: `fly machine destroy <old id> --force`,
then start again. Afterwards `fly scale count 1` must show exactly one machine.

### A deploy that fails half-way

| Where it stops | What is running afterwards | What to do |
| --- | --- | --- |
| The deploy job's tests, or the address check | The old version; nothing was built | Fix and run again |
| The image build on Fly's builder | The old version | Read the build log; run again |
| The release command (a migration fails) | The old version. Each migration runs in its own transaction, so the failing one leaves nothing behind; migrations before it in the same release stay applied, which the old version tolerates (they only add) | Fix the migration and deploy again. Do not edit the database by hand |
| The new machine never passes `/health` (**not tried here**) | The new version, failing: with one machine a rolling deploy replaces it in place, and Fly does not go back by itself | Roll back (below), then read `fly logs` |
| `/health` passes, the smoke test fails | The new version, live | Roll back or fix forward; the run summary shows the commands |

The rollback is always the same two commands (step 8 above):

```bash
fly releases -a <name> --image
fly deploy -a <name> --image registry.fly.io/<name>:deployment-<id> --ha=false
```

It restarts the one machine on the older image; tables survive as in any deploy. The deploy
workflow does not know about it: its "deployed commit" is still the last one it shipped, so ship
the fix with **Run workflow** or with a server change on `main`.

## Rotating secrets

Every `fly secrets set` restarts the machine once. Players at a table see a reconnect of a few
seconds and keep their seats; nobody is signed out. Generate each new value, **show it and save
it before setting it** (Fly never shows a secret again). What each rotation costs beyond that
restart:

| Secret | How to rotate it | What players notice |
| --- | --- | --- |
| `AUTH_PEPPER` | See below: the old value moves to `AUTH_PEPPER_PREVIOUS` and stays there | Nothing, as long as the old value stays listed |
| `ADMIN_TOKEN` | Set a new value; update wherever you call `/api/admin/*` from | Nothing |
| `DATABASE_URL`, `DATABASE_URL_DIRECT` | Reset the role's password in Neon, then set both URLs in one `fly secrets set`, back to back | Requests fail for the minute between the reset and the restart (`/health` answers 503 `db: down`), and a table that could not be saved in that minute comes back as of its last snapshot. Do it at a quiet hour |
| `REVENUECAT_WEBHOOK_SECRET` | Change it in RevenueCat → Integrations → Webhooks and in Fly in the same minute | Nothing. An event sent in between gets 401 and RevenueCat sends it again; the nightly reconciliation catches anything it gave up on |
| `REVENUECAT_SECRET_KEY` | Create a new secret key in RevenueCat, set it, delete the old one | Nothing, unless a webhook was lost meanwhile: Restore purchases and the nightly reconciliation cannot ask the store while the key is invalid |
| `EXPO_ACCESS_TOKEN` | Create a new token on expo.dev, set it, revoke the old one | No push notifications between the revoke and the set |
| `SENTRY_DSN`, `POSTHOG_KEY` | Replace the value (they are write-only keys, not credentials to your data) | Nothing |
| GitHub secret `FLY_API_TOKEN` | `fly tokens create deploy -a <name>`, replace the GitHub secret, revoke the old token (`fly tokens list`, `fly tokens revoke`) | Nothing; deploys fail while it is wrong |
| GitHub secret `EXPO_TOKEN` | expo.dev → Access tokens: create, replace the secret, revoke the old one | Nothing; builds are skipped or fail while it is wrong |
| GitHub secrets `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` | App Store Connect → Users and Access → Integrations → Team Keys: generate a new key, replace the three secrets, revoke the old key | Nothing; the iOS workflow cannot sign or submit while they are wrong |
| GitHub secret `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Google Cloud → the service account → Keys: add a key, replace the secret, delete the old key | Nothing; the Android workflow cannot submit while it is wrong |
| EAS secret `SENTRY_AUTH_TOKEN` | Sentry → Auth tokens: create, replace it in EAS, revoke the old one | Nothing; builds upload no source maps while it is wrong |

`APPLE_CLIENT_ID`, `GOOGLE_CLIENT_IDS` and the `EXPO_PUBLIC_*` values are identifiers that ship
inside the app, not secrets; they change only when the app's identity does. The rotations in the
table were not tried against the real services here (they need the owner's accounts); the two
that involve server behaviour were: a webhook with the wrong secret answers 401, and the pepper
rotation below.

**Rotating the pepper.** In a single `fly secrets set`, put the old value in
`AUTH_PEPPER_PREVIOUS` and a new one in `AUTH_PEPPER` (generate it, show it and save it first, as
in step 3). Nobody notices: a session or a guest secret stored under the old pepper is still
accepted, and is stored again under the new one when it is next presented. Then **leave
`AUTH_PEPPER_PREVIOUS` set**:

- Keep it for at least 30 days, the session lifetime. A session is presented on every request,
  so by then every session still in use has moved to the new pepper.
- Keep it for as long as guest accounts from before the rotation should be able to sign in, which
  in practice means for good. A guest account's only credential is the secret on the phone; the
  server stores its hash and never the secret, so it can move the hash only when the app signs in
  with the secret again, and the app does that only when its session has lapsed. A guest who
  plays every week may not present the secret for months; one who stayed away has not presented
  it at all. Keeping the old value costs one extra hash when a lookup misses.
- For a second rotation list every earlier value, newest first, separated by commas:
  `AUTH_PEPPER_PREVIOUS='<previous>,<the one before>'`.

What breaks when an earlier pepper is taken off the list, or when `AUTH_PEPPER` is replaced
without it, or lost: every session stored under it ends, so those players sign in again (an
Apple or Google account signs in and has lost nothing); and every guest account whose secret has
not been stored again since the rotation can no longer be reached by its owner
(`POST /api/auth/guest/login` answers 401 and the app shows a fresh, signed-out state), with its
diamonds, cosmetics, clubs and progress. Nothing is deleted: putting the old value back in
`AUTH_PEPPER_PREVIOUS` lets those accounts in again. The server cannot tell you how many guest
accounts still depend on an earlier pepper, which is why the rule is not to remove it.

## By hand

```bash
fly deploy --ha=false                            # same as CI, from your machine (repository root)
fly scale count 1 -a <name>                      # exactly one machine
fly logs -a <name>                               # live logs
fly status -a <name>                             # machines and checks
fly ssh console -a <name> -C "node dist/server.cjs migrate"   # run migrations manually
npm run smoke -w @mjm/signal -- https://<name>.fly.dev        # play one hand against it
```

Migrations can also be run from a laptop against Neon's direct string:

```bash
DATABASE_URL='postgres://…direct…?sslmode=require' npm run migrate -w @mjm/signal
```

The production bundle, locally (in memory, then against a local Postgres), with the smoke test:

```bash
npm run build -w @mjm/signal
NODE_ENV=production ALLOW_EPHEMERAL=1 PORT=8787 node apps/signal/dist/server.cjs &
npm run smoke -w @mjm/signal -- http://127.0.0.1:8787
NODE_ENV=production DATABASE_URL=postgres://… DATABASE_URL_DIRECT=postgres://… AUTH_PEPPER=… \
  MIGRATE_ON_BOOT=1 PORT=8788 node apps/signal/dist/server.cjs &
npm run smoke -w @mjm/signal -- http://127.0.0.1:8788
```

A local image build, for checking the Dockerfile:

```bash
docker build -f apps/signal/Dockerfile -t mahjong-signal .
docker run --rm -p 8787:8787 -e ALLOW_EPHEMERAL=1 mahjong-signal &
npm run smoke -w @mjm/signal -- http://127.0.0.1:8787
```

(With the root as context, a plain `docker build` does not read `apps/signal/.dockerignore`, so
the upload includes `node_modules`; the image is the same, only slower to build.)

## What is in the repository

| File | Purpose |
| --- | --- |
| `apps/signal/Dockerfile` | Two stages on `node:22-slim`: install the server's workspaces, bundle `src/main.ts` with esbuild into `dist/server.cjs`; the runtime stage holds only that file and `migrations/`, and runs as the unprivileged `node` user with a `HEALTHCHECK` on `/health`. Build context is the repository root. |
| `apps/signal/.dockerignore` | Keeps `node_modules`, the mobile app and secrets out of the build upload (used through `ignorefile` in `fly.toml`). |
| `apps/signal/.env.example` | Every environment variable the server reads, with notes. |
| `apps/signal/migrations/*.sql` | Schema migrations, applied in filename order by `src/migrate.ts`. |
| `apps/signal/scripts/smoke.ts` | The smoke test (`npm run smoke -w @mjm/signal -- <url>`); `test/smoke.test.ts` runs it against the real server on port 0. |
| `fly.toml` | Fly app config: region `sin`, port 8787, HTTPS forced, one machine always running (`min_machines_running = 1`, `auto_stop_machines = false`), `MAX_HOSTED_TABLES=200` sized for that machine, `/health` checks, and a release command that runs migrations. |
| `.github/workflows/deploy-signal.yml` | Deploys the head of `main` after CI has passed when it differs from the deployed commit in anything the server is built from, and on manual dispatch from the head of any branch; re-runs the engine, net and server tests with Postgres first, deploys one machine (`--ha=false`), then health-checks and smoke-tests it on Postgres storage. `apps/signal/test/deploy-workflow.test.ts` runs its decision steps against scratch repositories. |

## Database tests

`apps/signal/test/repos.test.ts`, `migrate.test.ts`, `free-text.test.ts`, `db-timeouts.test.ts`
and `host-lock.test.ts` run their Postgres cases only when `DATABASE_URL_TEST` is set; each run
creates and drops its own schema (the host-lock cases use their own lock keys), so a Neon branch
or a local Postgres works:

```bash
DATABASE_URL_TEST=postgres://user:pass@localhost:5432/mjm_test npm test -w @mjm/signal
```

CI (`.github/workflows/ci.yml`) runs them against a `postgres:16` service container
(`DATABASE_URL_TEST=postgres://postgres:postgres@localhost:5432/postgres`, health-checked), and a
`docker` job builds `apps/signal/Dockerfile` and checks that the image answers `/health` with no
secrets (`ALLOW_EPHEMERAL=1`, since the image sets `NODE_ENV=production`).

## Other hosts

The image keeps nothing on disk, so any container host works the same way: build
`apps/signal/Dockerfile` from the repository root, set the environment variables above (and
`TRUST_PROXY` to the number of proxies in front of it), expose port 8787, point the health check
at `/health`, keep exactly one instance always running (WebSockets must not sleep, and a second
instance would wait for the host lock and exit), give it 25 s to save tables on SIGTERM, and set
`DATABASE_URL_DIRECT` to a direct (unpooled) connection for the host lock. Run
`node dist/server.cjs migrate` before each release, and the smoke test after it.
