# syntax=docker/dockerfile:1.7
FROM node:24.14.1-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && bash scripts/fetch-litestream.sh

FROM node:24.14.1-bookworm-slim AS runtime

# Coolify / CI pass the git SHA as SOURCE_COMMIT (or COOLIFY_CONTAINER_NAME alone).
# Bake it into the image so /api/health revision is correct even when a stale
# runtime GIT_COMMIT_SHA is absent or Coolify omits the runtime inject.
ARG SOURCE_COMMIT=""
ARG GIT_COMMIT_SHA=""
ENV SOURCE_COMMIT=${SOURCE_COMMIT}     GIT_COMMIT_SHA=${GIT_COMMIT_SHA}

ARG INFISICAL_CLI_VERSION=0.43.114

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && arch="$(uname -m)" \
  && case "${arch}" in \
       aarch64|arm64) cli_arch=arm64 ;; \
       x86_64|amd64) cli_arch=amd64 ;; \
       *) echo "unsupported arch: ${arch}" >&2; exit 1 ;; \
     esac \
  # --retry + --http1.1: this exact download killed two production deploys on
  # 2026-08-12 with `curl: (16) Error in the HTTP2 framing layer` — a transient
  # GitHub-CDN/HTTP2 flake with no retry to absorb it, which then stalled the
  # whole serialized build queue behind the failed deploy. HTTP/1.1 sidesteps
  # the framing bug class; --retry-all-errors covers the rest.
  && curl -fsSL --http1.1 --retry 5 --retry-delay 2 --retry-all-errors -o /tmp/infisical.tgz \
       "https://github.com/Infisical/cli/releases/download/v${INFISICAL_CLI_VERSION}/cli_${INFISICAL_CLI_VERSION}_linux_${cli_arch}.tar.gz" \
  && tar -xzf /tmp/infisical.tgz -C /tmp \
  && install -m 0755 /tmp/infisical /usr/local/bin/infisical \
  && rm -rf /tmp/infisical /tmp/infisical.tgz /tmp/completions /tmp/manpages /tmp/LICENSE /tmp/README.md \
  && infisical --version

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    INFISICAL_ENV=prod \
    INFISICAL_UM_PROJECT_ID=86e35e51-91bc-4dfd-a045-4484726b9c40

# Startup migrations intentionally use the pinned Prisma CLI from devDependencies,
# so retain the verified build dependency tree instead of pruning it here.
COPY --from=build --chown=node:node /app /app

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health >/dev/null || exit 1

# Prefer Infisical inject when bootstrap client credentials are present; otherwise
# fall through to the existing start wrapper (host-materialized env_file path).
CMD ["bash", "scripts/start-with-infisical.sh"]
