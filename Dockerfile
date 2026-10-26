# omnirushapi in a container.
#
# There is no build step to reproduce: the gateway runs its TypeScript through tsx. The image
# therefore needs Node, curl (the upstream transport shells out to it, which is what makes the
# gateway survive TLS-inspecting proxies) and a writable directory for SQLite.

FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so editing source does not re-download them. tsx is a dev dependency on
# purpose: the image runs TypeScript directly instead of shipping a compiled copy.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DB_PATH=/data/gateway.db

# The database holds upstream credentials: keep it in a volume owned by the unprivileged user.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/healthz || exit 1

CMD ["node", "--import", "tsx", "src/index.ts"]
