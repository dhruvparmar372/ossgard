---
name: ossgard-sync-demo
description: Pull latest scan data, rebuild demo site, and deploy to gh-pages
---

# ossgard-sync-demo — Pull data, rebuild, and deploy the demo site

You are deploying the static demo site to GitHub Pages. Follow each step
sequentially. Abort and report if any step fails.

## Communication Style

Print terse status lines:

| Situation | Format |
|---|---|
| Starting a step | `[Step N] <description>` |
| Step done | `[Step N] Done — <summary>` |
| Error | `[Error] <what failed>` |

---

## Step 1 — Pull latest scan data

The API server must be running. Pull fresh data:

```bash
cd /Users/dhruv/Code/ossgard/demo
bun install   # ensure deps are present
bun run pull-data
```

This fetches scan data from the running ossgard-api and regenerates
`demo/src/data/index.ts` and the per-scan JSON files.

**Success criteria:** Exit 0, output shows repos processed.

---

## Step 2 — Build the demo

```bash
cd /Users/dhruv/Code/ossgard/demo
bun run build
```

This produces a static export in `demo/out/` (configured via
`next.config.ts` with `output: "export"` and `basePath: "/ossgard"`).

**Success criteria:** Exit 0, `demo/out/index.html` exists.

---

## Step 3 — Stash and copy build to tmp

```bash
cd /Users/dhruv/Code/ossgard
rm -rf /tmp/ossgard-demo-build
cp -r demo/out /tmp/ossgard-demo-build
git stash -u
```

---

## Step 4 — Switch to gh-pages and replace content

```bash
cd /Users/dhruv/Code/ossgard
git checkout gh-pages
git rm -rf .
rm -rf demo node_modules packages plans   # leftover untracked dirs
cp -r /tmp/ossgard-demo-build/* .
touch .nojekyll
git add -A
```

The `.nojekyll` file is required so GitHub Pages serves the `_next/` directory.

---

## Step 5 — Commit and push

```bash
git commit -m "deploy: update static demo build

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
git push origin gh-pages
```

---

## Step 6 — Return to main

```bash
git checkout main
git stash pop
```

Print final summary:

```
[Done] Demo deployed to gh-pages — <commit hash>
```
