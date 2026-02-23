#!/usr/bin/env npx tsx

/**
 * Pulls scan data for all tracked repos from a running ossgard-api server
 * and writes JSON files into demo/src/data/ for the static demo site.
 *
 * Each scan gets its own file: data/{owner}-{name}/scan-{id}.json
 *
 * Usage:
 *   npm run pull-data
 *   npm run pull-data -- --api-url http://localhost:3400 --api-key <key>
 *
 * By default reads API URL and key from ~/.ossgard/config.toml.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import type { RepoScanData, RepoScanIndex, ScanSummary } from "../src/lib/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "src", "data");

// --- API response types ---

interface ApiDupesMember {
  prId: number;
  prNumber: number;
  title: string;
  author: string;
  state: "open" | "closed" | "merged";
  rank: number;
  score: number;
  rationale: string | null;
}

interface ApiDupesGroup {
  groupId: number;
  label: string | null;
  prCount: number;
  members: ApiDupesMember[];
}

interface ApiDupesResponse {
  repo: string;
  scanId: number;
  completedAt: string;
  groupCount: number;
  groups: ApiDupesGroup[];
}

interface ApiScanSummary {
  id: number;
  status: string;
  prCount: number;
  dupeGroupCount: number;
  completedAt: string;
}

interface ApiRepo {
  id: number;
  owner: string;
  name: string;
  prCount: number;
  lastScanAt: string | null;
}

// --- Helpers ---

function readConfig(): { url: string | null; key: string | null } {
  const configPath = join(homedir(), ".ossgard", "config.toml");
  if (!existsSync(configPath)) return { url: null, key: null };

  const config = readFileSync(configPath, "utf-8");
  const urlMatch = config.match(/url\s*=\s*"([^"]+)"/);
  const keyMatch = config.match(/key\s*=\s*"([^"]+)"/);
  return { url: urlMatch?.[1] ?? null, key: keyMatch?.[1] ?? null };
}

function truncateLabel(label: string | null, maxLen = 80): string {
  if (!label || label.length <= maxLen) return label || "";
  const truncated = label.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated) + "...";
}

function repoDirName(owner: string, name: string): string {
  return `${owner}-${name}`;
}

function scanFilename(scanId: number): string {
  return `scan-${scanId}.json`;
}

// --- Parse args ---

const args = process.argv.slice(2);

function getFlag(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

// --- Main ---

async function main() {
  const config = readConfig();
  const apiUrl = getFlag("--api-url") ?? config.url;
  const apiKey = getFlag("--api-key") ?? config.key;

  if (!apiUrl || !apiKey) {
    console.error(
      "Could not determine API URL/key. Provide --api-url and --api-key or ensure ~/.ossgard/config.toml exists."
    );
    process.exit(1);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };

  // 1. Fetch all tracked repos
  console.log(`Fetching tracked repos from ${apiUrl}...`);
  const reposRes = await fetch(`${apiUrl}/repos`, { headers });
  if (!reposRes.ok) {
    console.error(`Failed to fetch repos: ${reposRes.status}`);
    process.exit(1);
  }

  const allRepos: ApiRepo[] = await reposRes.json();
  const repos = allRepos.filter((r) => r.lastScanAt !== null);

  if (repos.length === 0) {
    console.error("No repos with completed scans found.");
    process.exit(1);
  }

  console.log(`Found ${repos.length} repo(s) with scan data.\n`);

  // 2. Pull scan data for each repo
  const repoIndexes: RepoScanIndex[] = [];

  for (const repo of repos) {
    const { owner, name } = repo;
    console.log(`--- ${owner}/${name} ---`);

    // Fetch scan list
    const scansRes = await fetch(`${apiUrl}/repos/${owner}/${name}/scans`, { headers });
    if (!scansRes.ok) {
      console.error(`  Skipping — failed to fetch scans: ${scansRes.status}`);
      continue;
    }
    const { scans: apiScans }: { scans: ApiScanSummary[] } = await scansRes.json();

    if (apiScans.length === 0) {
      console.log("  No completed scans.\n");
      continue;
    }

    // Ensure repo directory exists
    const dir = join(DATA_DIR, repoDirName(owner, name));
    mkdirSync(dir, { recursive: true });

    // Track which scan IDs are current (for cleanup)
    const currentScanIds = new Set(apiScans.map((s) => s.id));

    // Download each scan (skip if already exists)
    const scanSummaries: ScanSummary[] = [];
    let newScans = 0;

    for (const scanMeta of apiScans) {
      const filename = scanFilename(scanMeta.id);
      const filepath = join(dir, filename);

      scanSummaries.push({
        id: scanMeta.id,
        completedAt: scanMeta.completedAt,
        prCount: scanMeta.prCount,
        dupeGroupCount: scanMeta.dupeGroupCount,
      });

      if (existsSync(filepath)) {
        continue; // already downloaded
      }

      // Fetch full dupes for this scan
      const dupesRes = await fetch(
        `${apiUrl}/repos/${owner}/${name}/dupes?scanId=${scanMeta.id}`,
        { headers }
      );
      if (!dupesRes.ok) {
        console.error(`  Skipping scan ${scanMeta.id} — failed to fetch dupes: ${dupesRes.status}`);
        continue;
      }
      const dupesData: ApiDupesResponse = await dupesRes.json();

      const repoScanData: RepoScanData = {
        repo: { owner, name, url: `https://github.com/${owner}/${name}` },
        scan: {
          id: scanMeta.id,
          completedAt: scanMeta.completedAt,
          prCount: scanMeta.prCount,
          dupeGroupCount: scanMeta.dupeGroupCount,
        },
        groups: dupesData.groups.map((g) => ({
          id: g.groupId,
          label: truncateLabel(g.label),
          members: g.members.map((m) => ({
            prNumber: m.prNumber,
            title: m.title,
            author: m.author,
            state: m.state,
            rank: m.rank,
            score: m.score,
            rationale: m.rationale || "",
            url: `https://github.com/${owner}/${name}/pull/${m.prNumber}`,
          })),
        })),
      };

      writeFileSync(filepath, JSON.stringify(repoScanData, null, 2) + "\n");
      newScans++;
    }

    // Cleanup: remove scan files that are no longer on the server (TTL'd)
    const existing = readdirSync(dir).filter((f) => f.startsWith("scan-") && f.endsWith(".json"));
    for (const file of existing) {
      const match = file.match(/^scan-(\d+)\.json$/);
      if (match && !currentScanIds.has(Number(match[1]))) {
        rmSync(join(dir, file));
        console.log(`  Removed expired: ${file}`);
      }
    }

    repoIndexes.push({
      repo: { owner, name, url: `https://github.com/${owner}/${name}` },
      scans: scanSummaries,
    });

    console.log(`  ${apiScans.length} scan(s) (${newScans} new)\n`);
  }

  // 3. Generate barrel file
  generateBarrel(repoIndexes);

  console.log(`Done. ${repoIndexes.length} repo(s) processed. Run \`npm run build\` in demo/ to rebuild.`);
}

function generateBarrel(indexes: RepoScanIndex[]) {
  const lines: string[] = [
    `import type { RepoScanData, RepoScanIndex } from "@/lib/types";`,
    ``,
  ];

  // Static imports for all scan files
  const scanImports = new Map<string, string[]>();
  for (const idx of indexes) {
    const { owner, name } = idx.repo;
    const dirName = repoDirName(owner, name);
    const importNames: string[] = [];

    for (const scan of idx.scans) {
      const safeName = name.replace(/[^a-zA-Z0-9]/g, "");
      const importName = `${owner}${safeName.charAt(0).toUpperCase() + safeName.slice(1)}Scan${scan.id}`;
      lines.push(`import ${importName} from "./${dirName}/${scanFilename(scan.id)}";`);
      importNames.push(importName);
    }

    scanImports.set(`${owner}/${name}`, importNames);
  }

  lines.push(``);

  // Scan lookup map
  lines.push(`const scanMap: Record<string, Record<number, RepoScanData>> = {`);
  for (const idx of indexes) {
    const { owner, name } = idx.repo;
    const key = `${owner}/${name}`;
    const importNames = scanImports.get(key) ?? [];
    lines.push(`  "${key}": {`);
    for (let i = 0; i < idx.scans.length; i++) {
      lines.push(`    ${idx.scans[i].id}: ${importNames[i]} as RepoScanData,`);
    }
    lines.push(`  },`);
  }
  lines.push(`};`);
  lines.push(``);

  // Repo indexes
  lines.push(`export const repos: RepoScanIndex[] = ${JSON.stringify(indexes, null, 2)};`);
  lines.push(``);

  // Helpers
  lines.push(`export function getRepoData(owner: string, name: string): RepoScanIndex | undefined {`);
  lines.push("  return repos.find((r) => r.repo.owner === owner && r.repo.name === name);");
  lines.push(`}`);
  lines.push(``);
  lines.push(`export function getScanData(owner: string, name: string, scanId: number): RepoScanData | undefined {`);
  lines.push("  return scanMap[`${owner}/${name}`]?.[scanId];");
  lines.push(`}`);
  lines.push(``);
  lines.push(`export function getLatestScan(owner: string, name: string): RepoScanData | undefined {`);
  lines.push(`  const repo = getRepoData(owner, name);`);
  lines.push(`  if (!repo || repo.scans.length === 0) return undefined;`);
  lines.push(`  return getScanData(owner, name, repo.scans[0].id);`);
  lines.push(`}`);
  lines.push(``);

  writeFileSync(join(DATA_DIR, "index.ts"), lines.join("\n"));
  console.log("  Regenerated barrel: src/data/index.ts");
}

main();
