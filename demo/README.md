A [Next.js](https://nextjs.org) app that visualizes ossgard duplicate-detection results.

Part of the ossgard workspace — dependencies are managed from the project root with [Bun](https://bun.sh).

## Getting Started

```bash
# From the project root
bun install

# Pull scan data from a running ossgard-api server
bun run --cwd demo pull-data

# Start the dev server
bun run --cwd demo dev
```

Open [http://localhost:3000](http://localhost:3000) to view the results.
