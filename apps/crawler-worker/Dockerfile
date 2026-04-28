FROM oven/bun:1.2

WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY infrastructure ./infrastructure

RUN bun install --frozen-lockfile

CMD ["bun", "run", "apps/crawler-worker/src/worker.ts"]
