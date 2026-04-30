# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS base
WORKDIR /app

FROM base AS builder
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="9router"

ENV NODE_ENV=production
ENV PORT=9999
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/open-sse ./open-sse
COPY --from=builder /app/src/mitm ./src/mitm
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge

RUN apk --no-cache add shadow && \
  (groupadd -g 1000 node || true) && \
  (useradd -u 1000 -g node node || true)

EXPOSE 9999

ENTRYPOINT ["node", "server.js"]