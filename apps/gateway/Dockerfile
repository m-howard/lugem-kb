# Build context is the REPO ROOT, not this directory:
#   docker build -f apps/gateway/Dockerfile .
# The Docusaurus content root is the repo-root `docs/` tree, so a narrower context cannot build.

# syntax=docker/dockerfile:1

FROM oven/bun:1.3-alpine AS deps
WORKDIR /repo
COPY package.json bun.lock ./
COPY apps/docs/package.json ./apps/docs/
COPY apps/gateway/package.json ./apps/gateway/
COPY infra/pulumi/package.json ./infra/pulumi/
RUN bun install --frozen-lockfile

# The site is built, not served from source: Docusaurus emits a static tree the gateway can hand
# out without a Node process of its own.
#
# Node is installed here because the `docusaurus` bin declares `#!/usr/bin/env node`, so `bun run`
# hands it to Node rather than executing it itself. This is a build-stage dependency only — the
# runtime image below is pure Bun and never sees it.
FROM deps AS site
WORKDIR /repo
RUN apk add --no-cache nodejs
COPY docs ./docs
COPY apps/docs ./apps/docs
RUN bun run --filter '@lugem/docs' build

FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app

# `bun` is the image's own unprivileged user; nothing here needs root.
ENV NODE_ENV=production \
    SITE_ROOT=/app/site \
    PORT=3000

COPY --from=deps --chown=bun:bun /repo/node_modules ./node_modules
COPY --from=deps --chown=bun:bun /repo/apps/gateway/node_modules ./apps/gateway/node_modules
COPY --chown=bun:bun apps/gateway/package.json ./apps/gateway/
COPY --chown=bun:bun apps/gateway/src ./apps/gateway/src
COPY --from=site --chown=bun:bun /repo/apps/docs/build ./site

USER bun
EXPOSE 3000

# Liveness only — deliberately not /readyz. A container that cannot reach S3 should leave the
# target group, not be killed and restarted into the same outage.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD bun --eval "fetch('http://127.0.0.1:'+(process.env.PORT??3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "apps/gateway/src/index.ts"]
