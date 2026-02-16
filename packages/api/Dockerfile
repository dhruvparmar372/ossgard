FROM oven/bun:latest AS base

WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/

RUN bun install --frozen-lockfile

COPY packages/shared/ packages/shared/
COPY packages/api/ packages/api/

RUN cd packages/shared && bun run build && cd ../api && bun run build

EXPOSE 3400

CMD ["bun", "packages/api/dist/index.js"]
