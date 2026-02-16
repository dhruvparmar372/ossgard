/**
 * E2E Test: openclaw/openclaw
 *
 * Runs the full ossgard pipeline against the real openclaw/openclaw GitHub repo
 * using the standalone binaries (ossgard-api and ossgard CLI).
 *
 * Prerequisites:
 *   1. Local AI stack running:
 *        docker compose -f local-ai/vector-store.yml up -d
 *        docker compose -f local-ai/llm-provider.yml up -d
 *        ollama pull nomic-embed-text
 *        ollama pull llama3
 *
 *   2. Standalone binaries built:
 *        bun run build && bun run build:api && bun run build:cli
 *
 *   3. GitHub token available via GITHUB_TOKEN env var or ~/.ossgard/config.toml
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { startTestEnv, assertReachable, assertModel, type TestEnv } from "./setup.js";

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MAX_PRS = 100;

let env: TestEnv;

beforeAll(async () => {
  // Verify local AI stack is running — fail immediately if not
  await assertReachable(`${QDRANT_URL}/collections`, "Qdrant");
  await assertReachable(`${OLLAMA_URL}/api/tags`, "Ollama");
  await assertModel(OLLAMA_URL, "nomic-embed-text");
  await assertModel(OLLAMA_URL, "llama3");

  env = await startTestEnv({ apiPort: 13401 });
}, 60_000);

afterAll(() => {
  env?.cleanup();
});

describe("E2E: openclaw/openclaw", () => {
  it(
    "scans openclaw/openclaw through the full pipeline using CLI",
    async () => {
      // 1. Track the repo
      const track = await env.cli(["track", "openclaw/openclaw"]);
      expect(track.exitCode).toBe(0);
      expect(track.stdout).toContain("Tracking openclaw/openclaw");

      // 2. Trigger scan and wait for completion
      //    The CLI's scan command polls until done/failed by default
      console.log(`Starting scan with maxPrs=${MAX_PRS}...`);
      const scan = await env.cli(
        ["scan", "openclaw/openclaw", "--json"],
        35 * 60 * 1000
      );

      // Parse the last JSON line (the terminal state)
      const jsonLines = scan.stdout
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("{"));

      expect(jsonLines.length).toBeGreaterThan(0);

      for (const line of jsonLines) {
        const state = JSON.parse(line);
        console.log(`  [${state.status}] prCount=${state.prCount ?? 0}`);
      }

      const lastState = JSON.parse(jsonLines[jsonLines.length - 1]) as {
        status: string;
        prCount: number;
        dupeGroupCount: number;
        error?: string;
      };

      if (lastState.status === "failed") {
        throw new Error(`Scan failed: ${lastState.error}`);
      }

      expect(lastState.status).toBe("done");
      expect(lastState.prCount).toBeGreaterThan(0);

      // 3. Check dupes via CLI --json
      const dupes = await env.cli(["dupes", "openclaw/openclaw", "--json"]);
      expect(dupes.exitCode).toBe(0);

      const dupesData = JSON.parse(dupes.stdout) as {
        repo: string;
        scanId: number;
        groupCount: number;
        groups: Array<{
          groupId: number;
          label: string;
          prCount: number;
          members: Array<{
            prNumber: number;
            title: string;
            author: string;
            rank: number;
            score: number;
            rationale: string;
          }>;
        }>;
      };

      expect(dupesData.repo).toBe("openclaw/openclaw");
      expect(typeof dupesData.groupCount).toBe("number");

      // Validate structure of each group
      for (const group of dupesData.groups) {
        expect(group.groupId).toBeGreaterThan(0);
        expect(typeof group.label).toBe("string");
        expect(group.prCount).toBeGreaterThanOrEqual(2);

        for (const member of group.members) {
          expect(member.prNumber).toBeGreaterThan(0);
          expect(typeof member.title).toBe("string");
          expect(typeof member.author).toBe("string");
          expect(typeof member.score).toBe("number");
          expect(typeof member.rationale).toBe("string");
        }
      }

      // 4. Save results
      const dataDir = join(import.meta.dirname, "..", ".data");
      mkdirSync(dataDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const resultFile = join(
        dataDir,
        `openclaw-${MAX_PRS}prs-${timestamp}.json`
      );

      writeFileSync(resultFile, JSON.stringify(dupesData, null, 2));

      console.log(`Results saved to ${resultFile}`);
      console.log(`  PRs scanned: ${lastState.prCount}`);
      console.log(`  Dupe groups: ${dupesData.groupCount}`);
    },
    35 * 60 * 1000
  );
});
