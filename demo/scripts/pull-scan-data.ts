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
import type { RepoScanData, PhaseTokenUsage } from "../src/lib/types";

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
  inputTokens: number;
  outputTokens: number;
  tokenUsage: PhaseTokenUsage | null;
  llmProvider: string | null;
  llmModel: string | null;
  embeddingProvider: string | null;
  embeddingModel: string | null;
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

const refresh = args.includes("--refresh");

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
  let repoCount = 0;

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
    let newScans = 0;

    for (const scanMeta of apiScans) {
      const filename = scanFilename(scanMeta.id);
      const filepath = join(dir, filename);

      if (existsSync(filepath) && !refresh) {
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
          inputTokens: scanMeta.inputTokens,
          outputTokens: scanMeta.outputTokens,
          tokenUsage: scanMeta.tokenUsage,
          llmProvider: scanMeta.llmProvider,
          llmModel: scanMeta.llmModel,
          embeddingProvider: scanMeta.embeddingProvider,
          embeddingModel: scanMeta.embeddingModel,
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

    repoCount++;
    console.log(`  ${apiScans.length} scan(s) (${newScans} new)\n`);
  }

  console.log(`Done. ${repoCount} repo(s) processed. Run \`npm run build\` in demo/ to rebuild.`);
}

main();
