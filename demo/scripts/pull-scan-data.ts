#!/usr/bin/env npx tsx

/**
 * Pulls scan data for all tracked repos from a running ossgard-api server
 * and writes JSON files into demo/src/data/ for the static demo site.
 *
 * Usage:
 *   npm run pull-data
 *   npm run pull-data -- --api-url http://localhost:3400 --api-key <key>
 *
 * By default reads API URL and key from ~/.ossgard/config.toml.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import type { RepoScanData } from "../src/lib/types";

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

interface ApiScanResponse {
  id: number;
  repoId: number;
  status: string;
  strategy: string;
  prCount: number;
  dupeGroupCount: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
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

  // 2. Pull data for each repo
  const pulled: string[] = [];

  for (const repo of repos) {
    const { owner, name } = repo;
    console.log(`--- ${owner}/${name} ---`);

    // Fetch dupes
    const dupesRes = await fetch(
      `${apiUrl}/repos/${owner}/${name}/dupes`,
      { headers }
    );
    if (!dupesRes.ok) {
      const err = await dupesRes.text();
      console.error(`  Skipping — failed to fetch dupes: ${dupesRes.status} ${err}\n`);
      continue;
    }
    const dupesData: ApiDupesResponse = await dupesRes.json();

    // Fetch scan metadata
    const scanRes = await fetch(`${apiUrl}/scans/${dupesData.scanId}`, {
      headers,
    });
    if (!scanRes.ok) {
      console.error(`  Skipping — failed to fetch scan: ${scanRes.status}\n`);
      continue;
    }
    const scanData: ApiScanResponse = await scanRes.json();

    // Transform
    const repoScanData: RepoScanData = {
      repo: {
        owner,
        name,
        url: `https://github.com/${owner}/${name}`,
      },
      scan: {
        id: dupesData.scanId,
        completedAt: dupesData.completedAt,
        prCount: scanData.prCount,
        dupeGroupCount: dupesData.groupCount,
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

    // Write JSON
    const filename = `${owner}-${name}.json`;
    const filepath = join(DATA_DIR, filename);
    writeFileSync(filepath, JSON.stringify(repoScanData, null, 2) + "\n");
    pulled.push(filename);

    const totalMembers = repoScanData.groups.reduce(
      (s, g) => s + g.members.length,
      0
    );
    const dupes = repoScanData.groups.reduce(
      (s, g) => s + g.members.filter((m) => m.rank > 1).length,
      0
    );
    console.log(`  ${repoScanData.groups.length} groups, ${totalMembers} members, ${dupes} duplicates`);

    // Auto-update barrel
    const barrelPath = join(DATA_DIR, "index.ts");
    const barrelContent = readFileSync(barrelPath, "utf-8");

    if (!barrelContent.includes(filename)) {
      const importName = `${owner}${name.charAt(0).toUpperCase() + name.slice(1)}Data`;
      const importLine = `import ${importName} from "./${filename}";`;
      const castEntry = `  ${importName} as RepoScanData,`;

      const updated = barrelContent
        .replace(
          /(import type \{ RepoScanData \} from "[^"]+";)/,
          `$1\n${importLine}`
        )
        .replace(
          /(export const repos: RepoScanData\[\] = \[)/,
          `$1\n${castEntry}`
        );

      writeFileSync(barrelPath, updated);
      console.log(`  Added to barrel.`);
    }

    console.log();
  }

  console.log(`Pulled ${pulled.length} repo(s). Run \`npm run build\` in demo/ to rebuild.`);
}

main();
