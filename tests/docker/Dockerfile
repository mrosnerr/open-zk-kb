FROM oven/bun:1 AS base
ENV OPEN_ZK_KB_EPHEMERAL_SMOKE=1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM base AS smoke
RUN bash tests/docker/smoke-test.sh

FROM base AS model-smoke
RUN timeout 300 bun run tests/docker/model-smoke-test.ts
