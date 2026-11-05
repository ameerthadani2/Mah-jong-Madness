# Signal server image. Build from the repository root (the server depends on the engine and
# net workspaces):
#
#   docker build -f apps/signal/Dockerfile -t mahjong-signal .
#   docker run --rm -p 8787:8787 mahjong-signal
#
# The container keeps nothing on disk: with DATABASE_URL every account, club and table snapshot
# lives in Postgres; without it the server runs on in-memory storage (lost on restart).
#
# Stage 1 installs only the workspaces the server needs and bundles src/main.ts with esbuild
# into one CommonJS file. Stage 2 is a plain node:22-slim with that file and the SQL
# migrations: no node_modules, no tsx, no source.

FROM node:22-slim AS build
WORKDIR /repo
ENV CI=1 NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
# Every workspace manifest is needed for `npm ci` to accept the lockfile, even the ones not installed.
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/net/package.json packages/net/
COPY apps/signal/package.json apps/signal/
COPY apps/mobile/package.json apps/mobile/
RUN npm ci --workspace @mjm/signal --workspace @mjm/engine --workspace @mjm/net
COPY tsconfig.base.json ./
COPY packages/engine/src packages/engine/src
COPY packages/net/src packages/net/src
COPY apps/signal/src apps/signal/src
COPY apps/signal/migrations apps/signal/migrations
RUN npm run build --workspace @mjm/signal

FROM node:22-slim AS runtime
ENV NODE_ENV=production PORT=8787
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/signal/dist ./dist
COPY --from=build --chown=node:node /repo/apps/signal/migrations ./migrations
# The image's built-in unprivileged user.
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/server.cjs"]
