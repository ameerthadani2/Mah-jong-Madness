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
| `fly.toml` | Fly app config: region `sin`, port 8787, HTTPS forced, one machine always running (`min_machines_running = 1`, `auto_stop_machines = false`), `/health` checks, and a release command that runs migrations. |
| `.github/workflows/deploy-signal.yml` | Deploys on pushes to `main` that touch the server, and on manual dispatch (which can be run on any branch). |

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

The first deploy works at this point, before any database exists: the server falls back to
in-memory storage and logs a warning (accounts, clubs and tables then last only until the next
restart).

### 2. Neon Postgres

1. Create an account at neon.tech and a project in **AWS Asia Pacific (Singapore)**
   (`ap-southeast-1`), Postgres 16 or newer.
2. From the project dashboard copy two connection strings for the default database:
   - **Pooled** (the host contains `-pooler`): the running server uses this.
   - **Direct** (no `-pooler`): migrations use this, because they hold a transaction open across
     many statements.
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
password manager: losing it signs every player out.

**Rotating the pepper.** Set `AUTH_PEPPER_PREVIOUS` to the old value and `AUTH_PEPPER` to a new one
in a single `fly secrets set`. Sessions and guest secrets hashed with the old pepper keep working
and are re-hashed with the new one on first use. Remove `AUTH_PEPPER_PREVIOUS` after 30 days
(the session lifetime).

`fly.toml` already sets `PORT=8787`, `HOST_TABLES=1`, `TRUST_PROXY=1` (Fly's proxy supplies
`x-forwarded-for`) and `NODE_ENV=production`; `apps/signal/.env.example` lists the rest
(`MAX_HOSTED_TABLES`, `MIN_BUILD`, `MAINTENANCE_MESSAGE`, `MIGRATE_ON_BOOT`). Without
`AUTH_PEPPER` the server picks a random pepper at every start, so every player is signed out by
each deploy: set it before inviting anyone.

## What a deploy does

The workflow runs on a push to `main` or the development branch that touches `apps/signal`, the
engine or net packages, the lockfile, `fly.toml` or the workflow itself, and on **Run workflow**
in the Actions tab.

1. **check**: if `FLY_API_TOKEN` is not set, the run stops here and the job summary lists the
   setup steps above. Nothing fails.
2. **deploy**: installs the server's workspaces, typechecks and runs the server tests, then
   `flyctl deploy --remote-only`. Fly's builder builds `apps/signal/Dockerfile`, then:
   - the **release command** (`node dist/server.cjs migrate`) runs in a temporary machine with the
     app's secrets and applies any new migrations (it prints a note and succeeds when there is no
     database yet). If a migration fails, the release stops and the old version keeps running;
   - the machine is replaced (rolling), and Fly waits for `/health` to pass.
3. If `SIGNAL_URL` is set, the workflow polls `${SIGNAL_URL}/health` for up to a minute.

**Tables survive a deploy.** On SIGTERM (Fly sends it, then waits `kill_timeout = 30s`) the
server writes every hosted table to `table_snapshots` and closes the sockets without finishing
any table. The new machine restores every unfinished table at boot under its own code; the apps
reconnect with backoff and reclaim their seats with their rejoin tokens, and bots play for anyone
not back yet. A restored table waits 15 minutes for its players. (With in-memory storage there is
nothing to restore from, so a deploy ends every table.)

## By hand

```bash
fly deploy                                       # same as CI, from your machine (repository root)
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

`apps/signal/test/repos.test.ts` and `migrate.test.ts` run their Postgres cases only when
`DATABASE_URL_TEST` is set; each run creates and drops its own schema, so a Neon branch or a local
Postgres works:

```bash
DATABASE_URL_TEST=postgres://user:pass@localhost:5432/mjm_test npm test -w @mjm/signal
```

CI (`.github/workflows/ci.yml`) runs them against a `postgres:16` service container
(`DATABASE_URL_TEST=postgres://postgres:postgres@localhost:5432/postgres`, health-checked), and a
`docker` job builds `apps/signal/Dockerfile` and checks that the image answers `/health` with no
environment.

## Other hosts

The image keeps nothing on disk, so any container host works the same way: build
`apps/signal/Dockerfile` from the repository root, set the environment variables above (and
`TRUST_PROXY` to the number of proxies in front of it), expose port 8787, point the health check
at `/health`, keep one instance always running (WebSockets must not sleep), and give it time to
save tables on SIGTERM. Run `node dist/server.cjs migrate` before each release.
