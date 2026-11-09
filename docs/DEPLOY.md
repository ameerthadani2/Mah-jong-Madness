# Deploying the signal server

The signal server (`apps/signal`) hosts tables, relays WebSocket traffic, runs the club API and
owns accounts and sessions. It runs on **Fly.io** in Singapore (`sin`) as one always-on machine,
with **Neon** Postgres in `ap-southeast-1` (also Singapore) for durable state.

Nothing here is required for local development: with no environment set, `npm run signal` uses
in-memory storage, guest-only sign-in and a random per-process session pepper (each with a
warning). `apps/signal/README.md` lists every variable and route.

## What is in the repository

| File | Purpose |
| --- | --- |
| `apps/signal/Dockerfile` | Two stages on `node:22-slim`: install the server's workspaces, bundle `src/main.ts` with esbuild into `dist/server.cjs`; the runtime stage holds only that file and `migrations/`, and runs as the unprivileged `node` user with a `HEALTHCHECK` on `/health`. Build context is the repository root. |
| `apps/signal/.dockerignore` | Keeps `node_modules`, the mobile app and secrets out of the build upload (used through `ignorefile` in `fly.toml`). |
| `apps/signal/.env.example` | Every environment variable the server reads, with notes. |
| `apps/signal/migrations/*.sql` | Schema migrations, applied in filename order by `src/migrate.ts`. |
| `fly.toml` | Fly app config: region `sin`, port 8787, HTTPS forced, one machine always running (`min_machines_running = 1`, `auto_stop_machines = false`), `MAX_HOSTED_TABLES=200` sized for that machine, `/health` checks, and a release command that runs migrations. |
| `.github/workflows/deploy-signal.yml` | Deploys after CI has passed on `main` for a commit that touches the server, and on manual dispatch (which can be run on any branch). Re-runs the server tests with Postgres first, then deploys one machine (`--ha=false`). |

## One-time setup (owner)

### 1. Fly.io

1. Create an account at fly.io and add a payment method (a `shared-cpu-1x` machine with 512 MB is
   about US$5–15 a month).
2. Install flyctl (`brew install flyctl`, or `curl -L https://fly.io/install.sh | sh`) and run
   `fly auth login`.
3. Choose an app name (it becomes `<name>.fly.dev`) and create the app:
   ```bash
   fly apps create <name>
   ```
4. Put that name in `fly.toml` (`app = "<name>"`, replacing the placeholder `mahjong-signal`) and
   commit it.
5. Create a deploy token for CI and add it to GitHub (Settings → Secrets and variables → Actions):
   ```bash
   fly tokens create deploy -a <name>     # copy the whole output, including "FlyV1 "
   ```
   Secret name: `FLY_API_TOKEN`.
6. Optional: add the repository **variable** `SIGNAL_URL` = `wss://<name>.fly.dev`. The mobile
   build points at it, and the workflow checks `https://<name>.fly.dev/health` after each deploy.

The server **fails closed**: with `NODE_ENV=production` (set in `fly.toml`) it refuses to start
without `DATABASE_URL` and `AUTH_PEPPER` (exit 1, with the reason in `fly logs`). To deploy before
the database exists, say so explicitly:

```bash
fly secrets set -a <name> ALLOW_EPHEMERAL=1     # in-memory storage, a random pepper: everything is lost at each restart
```

and remove it (`fly secrets unset -a <name> ALLOW_EPHEMERAL`) once the secrets below are set.

**One machine.** The server keeps every table in memory and holds a Postgres advisory lock while
it hosts them, so it runs as exactly one machine. The workflow deploys with `--ha=false`; if a
second machine was ever created (an older `fly deploy` without the flag), remove it:

```bash
fly scale count 1 -a <name>
```

A second process on the same database waits up to 30 s for the lock and then exits 1 without
restoring or hosting anything (it never listens).

### 2. Neon Postgres

1. Create an account at neon.tech and a project in **AWS Asia Pacific (Singapore)**
   (`ap-southeast-1`), Postgres 16 or newer.
2. From the project dashboard copy two connection strings for the default database:
   - **Pooled** (the host contains `-pooler`): the running server uses this.
   - **Direct** (no `-pooler`): migrations use this, because they hold a transaction open across
     many statements, and so does the single-host lock, because a session advisory lock does not
     survive a transaction pooler. Without it the server takes the lock over `DATABASE_URL` and
     warns; through the pooler that lock is not reliable, so set both.
   Both must end in `?sslmode=require`.
3. Before launch, move to a paid plan so the database never suspends (the free tier sleeps when
   idle and the first query after that takes a few seconds). Neon keeps backups with
   point-in-time restore; a branch of the database makes a cheap staging copy.

### 3. Secrets

```bash
fly secrets set -a <name> \
  DATABASE_URL='postgres://…-pooler….neon.tech/neondb?sslmode=require' \
  DATABASE_URL_DIRECT='postgres://….neon.tech/neondb?sslmode=require' \
  AUTH_PEPPER="$(openssl rand -hex 32)"
```

Later, as the features arrive (each one is optional; when absent, that sign-in option is hidden):

```bash
fly secrets set -a <name> APPLE_CLIENT_ID=com.yourcompany.mahjong
fly secrets set -a <name> GOOGLE_CLIENT_IDS=ios-id.apps.googleusercontent.com,android-id…,web-id…
fly secrets set -a <name> FACEBOOK_APP_ID=1234567890
fly secrets set -a <name> CORS_ORIGINS=https://your-web-preview.example
```

Setting a secret restarts the machine with the new value. Keep a copy of `AUTH_PEPPER` in your
password manager: losing it signs every player out. If `ALLOW_EPHEMERAL` was set for the first
deploys, unset it now.

**Rotating the pepper.** Set `AUTH_PEPPER_PREVIOUS` to the old value and `AUTH_PEPPER` to a new one
in a single `fly secrets set`. Sessions and guest secrets hashed with the old pepper keep working
and are re-hashed with the new one on first use. Remove `AUTH_PEPPER_PREVIOUS` after 30 days
(the session lifetime).

`fly.toml` already sets `PORT=8787`, `HOST_TABLES=1`, `TRUST_PROXY=1` (Fly's proxy supplies
`x-forwarded-for`), `NODE_ENV=production`, `MAX_HOSTED_TABLES=200` and `MAX_TABLES_PER_USER=3`;
`apps/signal/.env.example` lists the rest (`MIN_BUILD`, `MAINTENANCE_MESSAGE`,
`MIGRATE_ON_BOOT`). In production a missing `AUTH_PEPPER` or `DATABASE_URL` stops the boot unless
`ALLOW_EPHEMERAL=1` is set.

**Capacity.** `MAX_HOSTED_TABLES=200` fits one `shared-cpu-1x` machine with 512 MB: 200 tables of
four players are 800 WebSockets, under the `[http_service.concurrency]` `hard_limit` of 1000 with
room for onlookers and reconnects. Raise both together (and the machine size) when the tables run
out: the hard limit must stay above 4 x `MAX_HOSTED_TABLES` plus onlookers.

## What a deploy does

The workflow runs when the **CI** workflow has finished successfully for a push to `main`
(`workflow_run`), for that same commit, if the commit touches `apps/signal`, the engine or net
packages, the lockfile, `fly.toml` or the workflow itself; and on **Run workflow** in the Actions
tab (any branch, always deploys). A failed or cancelled CI run, or one for a pull request, never
deploys.

1. **check**: picks the commit (the one CI tested, or the dispatched one) and whether it changes
   the server. If `FLY_API_TOKEN` is not set, the run stops here and the job summary lists the
   setup steps above. Nothing fails.
2. **deploy**: checks out that commit, installs the server's workspaces, typechecks and runs the
   net and server tests against a `postgres:16` service (so the repository, migration, timeout
   and host-lock cases run), then `flyctl deploy --remote-only --ha=false` with flyctl from
   `superfly/flyctl-actions/setup-flyctl` pinned to release 1.6. Fly's builder builds
   `apps/signal/Dockerfile`, then:
   - the **release command** (`node dist/server.cjs migrate`) runs in a temporary machine with the
     app's secrets and applies any new migrations (it prints a note and succeeds when there is no
     database yet). If a migration fails, the release stops and the old version keeps running;
   - the machine is replaced (rolling), and Fly waits for `/health` to pass. The new process takes
     the host lock as soon as the old one has written its tables and let go of it.
3. If `SIGNAL_URL` is set, the workflow polls `${SIGNAL_URL}/health` for up to a minute.

**Tables survive a deploy.** On SIGTERM (Fly sends it, then waits `kill_timeout = 30s`) the
server stops accepting requests and socket upgrades (`/health` answers 503 `draining`), writes
every hosted table to `table_snapshots`, closes the sockets without finishing any table and gives
up the host lock; it never takes longer than 20 s, even with a hung database. The new machine restores every unfinished table at boot under its own code; the apps
reconnect with backoff and reclaim their seats with their rejoin tokens, and bots play for anyone
not back yet. A restored table waits 15 minutes for its players. (With in-memory storage there is
nothing to restore from, so a deploy ends every table.)

## Health and a slow database

`/health` answers 200 `{ok:true, db:"ok", ...}` normally, and 503 `{ok:false, db:"down"}` when
the database does not answer within 2 s, so Fly's check and proxy notice a frozen or unreachable
database. Every query gives up after 5 s (and on the direct connection Postgres cancels the
statement), so a hung database slows requests down without hanging the process. If the host
lock's connection fails or stops answering, the server freezes its tables, writes what it can and
exits 1, and Fly starts it again.

## By hand

```bash
fly deploy --ha=false                            # same as CI, from your machine (repository root)
fly scale count 1 -a <name>                      # exactly one machine (see "One machine" above)
fly logs -a <name>                               # live logs
fly status -a <name>                             # machines and checks
fly ssh console -a <name> -C "node dist/server.cjs migrate"   # run migrations manually
fly releases -a <name>; fly deploy --image <previous image>   # roll back
```

Migrations can also be run from a laptop against Neon's direct string:

```bash
DATABASE_URL='postgres://…direct…?sslmode=require' npm run migrate -w @mjm/signal
```

A local image build, for checking the Dockerfile:

```bash
docker build -f apps/signal/Dockerfile -t mahjong-signal .
docker run --rm -p 8787:8787 mahjong-signal && curl localhost:8787/health
```

(With the root as context, a plain `docker build` does not read `apps/signal/.dockerignore`, so
the upload includes `node_modules`; the image is the same, only slower to build.)

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
`node dist/server.cjs migrate` before each release.
