FROM node:22-slim AS base

RUN npm install -g pnpm@10

WORKDIR /app

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./

# Copy package manifests for install
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/shared/ packages/shared/
COPY packages/api/ packages/api/

# Build shared first, then api
RUN pnpm --filter @ossgard/shared build && \
    pnpm --filter @ossgard/api build

EXPOSE 3400

CMD ["node", "packages/api/dist/index.js"]
