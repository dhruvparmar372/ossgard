import { Command } from "commander";
import { Config } from "../config.js";
import { ApiClient, ApiError } from "../client.js";

interface CheckResult {
  ok: boolean;
  [key: string]: unknown;
}

interface DoctorReport {
  config: CheckResult;
  api: CheckResult;
  account: CheckResult;
  github: CheckResult;
  llm: CheckResult;
  embedding: CheckResult;
  vectorStore: CheckResult;
}

export function doctorCommand(client: ApiClient): Command {
  return new Command("doctor")
    .description("Check prerequisites and service health")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  $ ossgard doctor
  $ ossgard doctor --json`)
    .action(async (opts: { json?: boolean }) => {
      const report: DoctorReport = {
        config: { ok: false },
        api: { ok: false },
        account: { ok: false },
        github: { ok: false },
        llm: { ok: false },
        embedding: { ok: false },
        vectorStore: { ok: false },
      };

      let allOk = true;
      const config = new Config();

      // 1. Check local config
      if (config.isComplete()) {
        const cfg = config.load();
        report.config = { ok: true, path: "~/.ossgard/config.toml" };
        if (!opts.json) console.log("  Config       ~/.ossgard/config.toml found");

        // 2. Check API reachability
        try {
          await client.get("/health");
          report.api = { ok: true, url: cfg.api.url };
          if (!opts.json) console.log(`  API          ${cfg.api.url} reachable`);
        } catch {
          report.api = { ok: false, url: cfg.api.url, error: "unreachable" };
          allOk = false;
          if (!opts.json) console.log(`  API          ${cfg.api.url} unreachable`);
        }

        // 3. Check account + services (only if API is reachable)
        if (report.api.ok) {
          try {
            const me = await client.get<{
              id: number;
              config: {
                github: { token: string };
                llm: { provider: string; model: string };
                embedding: { provider: string; model: string };
                vector_store: { url: string };
              };
            }>("/accounts/me");

            report.account = { ok: true, id: me.id };
            if (!opts.json) console.log(`  Account      authenticated (account #${me.id})`);

            // 4. Services
            const svcConfig = me.config;

            report.github = { ok: !!svcConfig.github.token };
            if (!opts.json) {
              console.log(`  GitHub       ${report.github.ok ? "token configured" : "token missing"}`);
            }

            report.llm = {
              ok: !!svcConfig.llm.provider && !!svcConfig.llm.model,
              provider: svcConfig.llm.provider,
              model: svcConfig.llm.model,
            };
            if (!opts.json) {
              if (report.llm.ok) {
                console.log(`  LLM          ${svcConfig.llm.provider} / ${svcConfig.llm.model}`);
              } else {
                console.log("  LLM          not configured");
              }
            }

            report.embedding = {
              ok: !!svcConfig.embedding.provider && !!svcConfig.embedding.model,
              provider: svcConfig.embedding.provider,
              model: svcConfig.embedding.model,
            };
            if (!opts.json) {
              if (report.embedding.ok) {
                console.log(`  Embedding    ${svcConfig.embedding.provider} / ${svcConfig.embedding.model}`);
              } else {
                console.log("  Embedding    not configured");
              }
            }

            report.vectorStore = {
              ok: !!svcConfig.vector_store.url,
              url: svcConfig.vector_store.url,
            };
            if (!opts.json) {
              if (report.vectorStore.ok) {
                console.log(`  Vector Store ${svcConfig.vector_store.url}`);
              } else {
                console.log("  Vector Store not configured");
              }
            }

            if (!report.github.ok || !report.llm.ok || !report.embedding.ok || !report.vectorStore.ok) {
              allOk = false;
            }
          } catch (err) {
            if (err instanceof ApiError && err.status === 401) {
              report.account = { ok: false, error: "invalid API key" };
              allOk = false;
              if (!opts.json) console.log("  Account      invalid API key");
            } else {
              report.account = { ok: false, error: "failed to fetch account" };
              allOk = false;
              if (!opts.json) console.log("  Account      failed to fetch account");
            }
          }
        } else {
          allOk = false;
        }
      } else {
        report.config = { ok: false, error: "not found or incomplete" };
        allOk = false;
        if (!opts.json) console.log("  Config       ~/.ossgard/config.toml not found or incomplete");
      }

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log();
        if (allOk) {
          console.log("All checks passed.");
        } else {
          console.log("Some checks failed.");
        }
      }

      process.exitCode = allOk ? 0 : 1;
    });
}
