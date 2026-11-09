# Deploying the signal server

The signal server (`apps/signal`) hosts tables, relays WebSocket traffic, runs the club API and
owns accounts and sessions. It runs on **Fly.io** in Singapore (`sin`) as one always-on machine,
with **Neon** Postgres in `ap-southeast-1` (also Singapore) for durable state.

Nothing here is required for local development: with no environment set, `npm run signal` uses
in-memory storage, guest-only sign-in and a random per-process session pepper (each with a
warning). `apps/signal/README.md` lists every variable and route.

## First deploy, in order

About an hour the first time. You need a Fly.io account with a payment method (a `shared-cpu-1x`
machine with 512 MB is about US$5–15 a month), a Neon account, and admin rights on the GitHub
repository. Every command runs from the repository root.

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
   when idle, and the first query after that takes a few seconds). Neon keeps point-in-time
   backups; a branch of the database makes a cheap staging copy.

### 3. Set the server's secrets

```bash
fly secrets set -a <name> \
  DATABASE_URL='postgres://…-pooler….neon.tech/neondb?sslmode=require' \
  DATABASE_URL_DIRECT='postgres://….neon.tech/neondb?sslmode=require' \
  AUTH_PEPPER="$(openssl rand -hex 32)" \
  ADMIN_TOKEN="$(openssl rand -hex 32)" \
  REVENUECAT_WEBHOOK_SECRET="$(openssl rand -hex 32)" \
  REVENUECAT_SECRET_KEY='sk_…' \
  TESTER_USER_IDS='<player id>,<player id>'
```

Only the first three are needed to start: the server **fails closed** and, with
`NODE_ENV=production` (set in `fly.toml`), refuses to boot without `DATABASE_URL` and
`AUTH_PEPPER`. The others switch features on as they arrive, so leave out any you do not have yet
and set them later the same way (each `fly secrets set` restarts the machine):

| Secret | What it unblocks | Absent |
| --- | --- | --- |
| `DATABASE_URL` | Accounts, clubs, wallets and tables survive restarts and deploys | boot refused in production |
| `DATABASE_URL_DIRECT` | Migrations and the single-host lock over a direct connection | both use `DATABASE_URL`, with a warning; through the pooler the lock is not reliable |
| `AUTH_PEPPER` | Sessions and guest secrets that survive restarts. Keep a copy in your password manager: losing it signs every player out | boot refused in production |
| `ADMIN_TOKEN` | Support grants (`POST /api/admin/grant`) and the moderation endpoints | those routes answer 503 |
| `REVENUECAT_WEBHOOK_SECRET` | Real purchases: the store webhook, and `storeEnabled` in `/api/config`. Put the same value in RevenueCat → Integrations → Webhooks as `Bearer <value>`, URL `https://<name>.fly.dev/api/webhooks/revenuecat` | the app shows "Store unavailable" |
| `REVENUECAT_SECRET_KEY` | Reconciliation after Restore and nightly (RevenueCat → API keys → a secret v1 key) | a purchase whose webhook was lost stays missing until support grants it |
| `TESTER_USER_IDS` | Sandbox purchases (TestFlight, Play testing) are granted to these accounts only. Ids come from Settings → Account → "Player id" on each tester's phone, so this one is usually set after the first builds | every sandbox purchase is recorded and ignored |

Sign-in providers, push, Sentry and PostHog have their own secrets (`APPLE_CLIENT_ID`,
`GOOGLE_CLIENT_IDS`, `EXPO_ACCESS_TOKEN`, `SENTRY_DSN`, `POSTHOG_KEY`, …): see
[`OWNER_TODO.md`](OWNER_TODO.md) and `apps/signal/README.md`.

To deploy before the database exists, say so explicitly with
`fly secrets set -a <name> ALLOW_EPHEMERAL=1` (in-memory storage and a random pepper: everything
is lost at each restart), and `fly secrets unset -a <name> ALLOW_EPHEMERAL` once the secrets
above are set.

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

1. typechecks and runs the net and server tests, the Postgres cases included, on the exact commit;
2. builds `apps/signal/Dockerfile` on Fly's remote builder and deploys one machine; Fly's release
   command (`node dist/server.cjs migrate`) applies new migrations first, through
   `DATABASE_URL_DIRECT`, and a failed migration stops the release with the old version still
   running;
3. waits up to two minutes for `/health`;
4. runs the smoke test (step 6) and fails the job if it fails, with its output in the run summary.

After this first time, every push to `main` that touches the server deploys by itself once CI
has passed (see "What a deploy does").

### 6. Smoke test

The workflow runs it after each deploy; run it by hand any time:

```bash
npm run smoke -w @mjm/signal -- https://<name>.fly.dev      # or wss://<name>.fly.dev
```

It checks `/health` (and that the database is `ok`), reads `/api/config`, creates a guest named
"Smoke test" (device id and platform marked `smoke`), opens a socket, opens a hosted table, adds
three bots, plays one whole hand for its own seat, checks that the hand's audit verifies, leaves,
and deletes the account with `DELETE /api/me` (also when a step fails). It prints each step's
time and exits non-zero naming the failing step:

```text
ok    health         43 ms  storage pg, db ok, 0 tables
ok    config          4 ms  providers [], store off, minBuild 0
ok    guest          26 ms  user 735447e3-…
ok    socket         14 ms  peer p-d640baef44729767
ok    table          25 ms  room WEV8M3, seat 0
ok    bots           21 ms  Smoke test, bot 小美 (Bot), bot 老王 (Bot), bot 阿花 (Bot)
ok    hand        27924 ms  12 own moves, 58 logged actions, won by seat 2
ok    audit           0 ms  hand 0 verified, 1 ceremony attempt(s)
ok    leave           0 ms
ok    delete         14 ms
PASSED in 28071 ms
```

The hand takes 15–60 s because server bots wait 0.6 s per move (`--hand-timeout <seconds>`
raises the 300 s limit). The table it opened stays listed with its bots for up to 15 minutes
after the smoke account has gone, then closes. In the deploy workflow the run can be skipped by
unticking "smoke" on a manual dispatch.

### 7. Point `SIGNAL_URL` at it

GitHub → Settings → Secrets and variables → Actions → Variables → New repository variable:
**`SIGNAL_URL`** = `wss://<name>.fly.dev` (or your own domain if you add a certificate with
`fly certs add`). The deploy workflow then health-checks and smoke-tests that address instead of
`https://<name>.fly.dev`, and the iOS and Android build workflows bake it into the apps; they
refuse to build without it, or with anything other than a `wss://` address on a public host. For
builds started from a laptop with `eas build`, also set it as an EAS environment variable
(expo.dev → project → Environment variables, `preview` and `production`).

### 8. Rollback

If a deploy misbehaves (the smoke test fails, `/health` flaps, players report errors):

```bash
fly releases -a <name> --image              # the image of every release, newest first
fly deploy -a <name> --image registry.fly.io/<name>:deployment-<id> --ha=false   # the last good one
npm run smoke -w @mjm/signal -- https://<name>.fly.dev
```

Tables survive a rollback the same way they survive a deploy (below). Migrations so far only add
tables and columns or relax a constraint, and are never undone: an older image runs against the newer schema, and its release
command finds nothing to apply. If a migration itself is the problem, restore the database from
Neon's point-in-time history (Branches → Restore) to a moment before the deploy, then deploy the
last good image. Fix forward on the branch and dispatch again when ready.

## What a deploy does

The workflow (`.github/workflows/deploy-signal.yml`) runs when the **CI** workflow has finished
successfully for a push to `main` (`workflow_run`), for that same commit, if the commit touches
`apps/signal`, the engine or net packages, the lockfile, `fly.toml` or the workflow itself; and on
**Run workflow** in the Actions tab (any branch, always deploys). A failed or cancelled CI run, or
one for a pull request, never deploys.

1. **check**: picks the commit (the one CI tested, or the head of the dispatched branch) and
   whether it changes the server. If `FLY_API_TOKEN` is not set, the run stops here and the job
   summary lists the setup steps. Nothing fails.
2. **deploy**: checks out that commit, installs the server's workspaces, typechecks and runs the
   net and server tests against a `postgres:16` service (so the repository, migration, timeout
   and host-lock cases run), then `flyctl deploy --remote-only --ha=false` with flyctl from
   `superfly/flyctl-actions/setup-flyctl` pinned to release 1.6. Fly's builder builds
   `apps/signal/Dockerfile`, then:
   - the **release command** applies new migrations in a temporary machine with the app's
     secrets (it prints a note and succeeds when there is no database yet);
   - the machine is replaced (rolling), and Fly waits for `/health` to pass. The new process takes
     the host lock as soon as the old one has written its tables and let go of it.
3. It polls `/health` at `SIGNAL_URL` (turned into `https://`), or at
   `https://<app in fly.toml>.fly.dev` without the variable, for up to two minutes.
4. It runs the smoke test against the same address and fails the job if it fails.

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
exits 1, and Fly starts it again.

**Rotating the pepper.** Set `AUTH_PEPPER_PREVIOUS` to the old value and `AUTH_PEPPER` to a new one
in a single `fly secrets set`. Sessions and guest secrets hashed with the old pepper keep working
and are re-hashed with the new one on first use. Remove `AUTH_PEPPER_PREVIOUS` after 30 days
(the session lifetime).

`fly.toml` already sets `PORT=8787`, `HOST_TABLES=1`, `TRUST_PROXY=1` (Fly's proxy supplies
`x-forwarded-for`), `NODE_ENV=production`, `MAX_HOSTED_TABLES=200` and `MAX_TABLES_PER_USER=3`;
`apps/signal/.env.example` lists the rest (`MIN_BUILD`, `MAINTENANCE_MESSAGE`,
`MIGRATE_ON_BOOT`).

**Capacity.** `MAX_HOSTED_TABLES=200` fits one `shared-cpu-1x` machine with 512 MB: 200 tables of
four players are 800 WebSockets, under the `[http_service.concurrency]` `hard_limit` of 1000 with
room for onlookers and reconnects. Raise both together (and the machine size) when the tables run
out: the hard limit must stay above 4 x `MAX_HOSTED_TABLES` plus onlookers.

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
| `.github/workflows/deploy-signal.yml` | Deploys after CI has passed on `main` for a commit that touches the server, and on manual dispatch from any branch; re-runs the server tests with Postgres first, deploys one machine (`--ha=false`), then health-checks and smoke-tests it. |

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
