# Observability (game server)

What the server measures, where to look when something goes wrong, and how to roll back. Everything here is optional: with no keys set the server logs to stdout only and every hook is a no-op. The app's own crash reporting and analytics are switched on by the build variables `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_POSTHOG_KEY` and `EXPO_PUBLIC_POSTHOG_HOST` (and `SENTRY_ORG`, `SENTRY_PROJECT` and the EAS secret `SENTRY_AUTH_TOKEN` for readable stacks): [`OWNER_TODO.md`](OWNER_TODO.md), step 12.

## What is measured

| Signal | Where it comes from | Where to see it |
| --- | --- | --- |
| Liveness | `GET /health` answers `200 { ok: true, … }` while the process serves HTTP | Fly health checks (`fly.toml`), the deploy workflow's post-deploy check, `curl https://<app>.fly.dev/health` |
| Tables and players | `/health`: `tables` (= `hostedTables`, tables the server is hosting), `rooms`, `peers` (open sockets that said hello) | `/health` |
| Action-to-state latency | `/health.actionLatency`: from a player's `action` frame reaching a hosted table to the resulting state having been sent to every seat (the host handles and broadcasts synchronously; measured in `src/rooms.ts` around the table's message handler). `p50Ms`, `p95Ms`, `maxMs` and `samples` over the last 5 minutes (at most 20,000 samples) | `/health`. Healthy: p95 well under 10 ms. Network time to the phone is not included |
| Storage | `/health.storage` (`memory` or `pg`) and, on Postgres, `db: ok \| down` (a `SELECT 1`) | `/health` |
| Table snapshots | `/health.snapshots`: `saved` and `failed` writes of hosted tables since this process started, with `lastSavedAt` and `lastFailedAt`. A `failed` count that grows means tables are not reaching storage and would be lost at the next restart, even while `db` says `ok` (the server log has a `snapshot not saved` line with the reason for each) | `/health`; the smoke test fails when a write failed during its hand |
| Which build answers | `/health.image`: the image reference this machine runs (`FLY_IMAGE_REF`, e.g. `registry.fly.io/<app>:deployment-<id>`; `null` off Fly) | `/health`, the first line of the smoke test, `fly releases -a <app> --image` |
| Store and push switches | `/health.storeEnabled` (`REVENUECAT_WEBHOOK_SECRET` set), `/health.pushEnabled` (`EXPO_ACCESS_TOKEN` set) | `/health`, `/api/config` |
| Server errors | `reportError` sends to Sentry when `SENTRY_DSN` is set: API handler 500s (with the route), WebSocket frame handler throws (with the frame type), tick errors, push failures, boot failures. Errors only (`tracesSampleRate: 0`), no request bodies, headers or personal data (`sendDefaultPii: false`); the release is `SENTRY_RELEASE` or Fly's `FLY_IMAGE_REF` | Sentry → Issues, filtered by `environment` (`SENTRY_ENVIRONMENT`, default `production`) |
| Product events | PostHog (`POSTHOG_KEY`): `purchase_credited` `{ productId, diamonds? , entitlement?, store, environment }` when a store event credits diamonds or starts or renews a subscription; `report_filed` `{ reason, hasRoom, hasDetails }`. The distinct id is the user's opaque id; no names, emails, chat or report text. Every event carries `source: "server"` | PostHog → Activity, or an insight on those event names. The app's funnel events (app_open, match_start, purchase_start/success, …) arrive from the app under PostHog's anonymous id: the app creates its client with `personProfiles: 'never'` and never calls `identify`, so they are not joined to the server's user id (the iOS privacy manifest's ProductInteraction entry is `linked: false` for that reason). Compare the two streams side by side, not per user |
| Store notifications | Every RevenueCat webhook is stored raw in `store_events` with its `outcome` (`credited`, `entitled`, `duplicate`, `ignored_unknown_user`, …) | `SELECT type, outcome, count(*) FROM store_events WHERE received_at > now() - interval '1 day' GROUP BY 1, 2;` and RevenueCat → Integrations → Webhooks (delivery log) |
| Player reports | `reports` table, `status = 'open'` | `SELECT reason, count(*) FROM reports WHERE status = 'open' GROUP BY 1;` |
| Logs | stdout: boot summary (which features are on), warnings for missing configuration, `[signal] … error` lines (see "Logs" below for what they hold and how long they last) | `fly logs -a <app>` |

The boot line lists every switch, for example `listening on :8787 (storage pg, sign-in guest apple google, …, store on, push on, Sentry on, PostHog on)`.

## Where to look

- **Players say a purchase did not arrive.** RevenueCat's webhook delivery log first (a non-200 is retried by RevenueCat). Then `store_events` for that user (`user_id`) or event id: `ignored_unknown_user` means the app did not log in to RevenueCat with the server user id; `ignored_unknown_product` means the store product id is not in `apps/signal/src/catalog.ts`. `/health.storeEnabled: false` means the secret is missing (the webhook answers 503).
- **No push notifications.** `/health.pushEnabled`; then whether the user's device has a token (`SELECT push_token FROM devices WHERE user_id = …`). Tokens Expo rejects as `DeviceNotRegistered` are cleared automatically; the app re-registers on its next launch. Each kind is sent at most once a minute per user.
- **Tables feel slow.** `/health.actionLatency.p95Ms`. If it is high, the server is CPU-bound (bots and hosting many tables): check `tables` against `MAX_HOSTED_TABLES` and the machine size. If it is low but players see lag, it is the network path (region, Fly edge).
- **Errors spike after a deploy.** Sentry → Issues for the new release; roll back (below).
- **Database.** `/health.db: down` means `SELECT 1` failed; Neon's console shows whether the project is suspended or over its limits.

## Logs

The server writes plain lines to stdout and nothing else: no log files, no request log.

- **What is in them.** The boot line (which features are on), warnings for missing configuration, one line per restart, shutdown and restored table, and one line per failure (`api error`, `snapshot not saved`, `match result … not saved`, a failed store sync, a lost host lock) with the error's message. They name room and club codes, store event, transaction and product ids, and opaque account ids (on refund and store-sync lines).
- **What is not.** No display names, e-mail addresses, client addresses, chat or report text, guest secrets, session tokens or other secrets. A probe in the review drove sign-up with a name, a rename with a birth year, a failed login, malformed JSON, store events carrying an e-mail attribute, a wrong admin token and an account deletion against the production bundle: no log line contained any of them.
- **How long they last.** `fly logs -a <app>` shows only what Fly still holds, which is recent lines, not an archive (the exact window is Fly's and was not measured here). For history, ship the logs to a log store with Fly's log shipper; nothing in the repository sets that up. Whatever store you choose, give it a retention period and list it in the privacy policy's table of processors, since account ids in the logs are personal data once they can be joined to the database.
- **What outlasts the logs anyway.** Every store notification is kept in `store_events`, every report in `reports`, every finished match in `match_results`, and Sentry keeps the errors: most questions that start in the logs are answered there.

## Alerts

- Fly checks `/health` (see `fly.toml`); a failing check restarts the machine and shows in `fly status`. Add an alert in Fly's dashboard (or an external uptime monitor) on the same URL.
- In Sentry, alert on "a new issue" and on "more than 20 events in 5 minutes" for `environment:production`.
- Optional: an uptime monitor that reads `/health` and alerts when `actionLatency.p95Ms > 50` or `db` is `down`.

## Rollback

The procedure, with the exact commands, is in [`DEPLOY.md`](DEPLOY.md) ("Rollback", and "A deploy that fails half-way" for what is running after each kind of failure): redeploy the last good image with `--ha=false`, then run the smoke test. There is one machine, so a rollback is one restart; players reconnect and reclaim their seats. Migrations are never undone. They add tables and columns, backfill them or relax a constraint, which an older image tolerates, so the previous image runs on the newer schema; the one exception is `0004`, which renamed stored entitlement values, so never roll back to an image from before it. If a schema change must be undone, ship a new numbered migration. Two things DEPLOY.md does not cover:

- **Snapshots after a rollback.** Tables are restored from `table_snapshots`, whose `SerializedHost.version` the host checks; a snapshot written by a newer build that an older build cannot read is skipped (the table is lost, not corrupted) and logged.
- **Turning a feature off** needs no deploy: `fly secrets unset REVENUECAT_WEBHOOK_SECRET` (store off; RevenueCat retries its webhooks for up to 72 hours, and the events apply once the secret is back), `EXPO_ACCESS_TOKEN` (push off), `SENTRY_DSN`, `POSTHOG_KEY`. Unsetting a secret restarts the machine; tables survive it.
