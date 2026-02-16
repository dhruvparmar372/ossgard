import { Command } from "commander";
import { createInterface, Interface as RLInterface } from "node:readline";
import { Config, OssgardConfig } from "../config.js";

function ask(rl: RLInterface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

async function askWithDefault(
  rl: RLInterface,
  prompt: string,
  defaultValue: string
): Promise<string> {
  const answer = await ask(rl, `${prompt} [${defaultValue}]: `);
  return answer || defaultValue;
}

async function choose(
  rl: RLInterface,
  prompt: string,
  options: string[],
  defaultOption: string
): Promise<string> {
  const defaultIndex = options.indexOf(defaultOption);
  console.log(prompt);
  for (let i = 0; i < options.length; i++) {
    const marker = i === defaultIndex ? " (default)" : "";
    console.log(`  ${i + 1}) ${options[i]}${marker}`);
  }
  const answer = await ask(rl, `Choice [${defaultIndex + 1}]: `);
  if (!answer) return defaultOption;
  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < options.length) return options[idx];
  return defaultOption;
}

export async function validateGitHubToken(token: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function healthCheck(url: string, path: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}${path}`);
    return res.ok;
  } catch {
    return false;
  }
}

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Interactive setup wizard for ossgard")
    .option("--force", "Re-run setup even if already configured")
    .action(async (opts: { force?: boolean }) => {
      const config = new Config();

      if (config.isComplete() && !opts.force) {
        console.log("ossgard is already configured.");
        console.log('Run "ossgard setup --force" to reconfigure.');
        return;
      }

      // Load existing config for defaults when using --force
      const existing = config.exists() ? config.load() : undefined;

      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      console.log("\nossgard setup\n");

      // --- API Server ---
      console.log("=== API Server ===\n");
      let apiUrl = "";
      while (true) {
        apiUrl = await askWithDefault(
          rl,
          "ossgard API URL",
          existing?.api?.url ?? "http://localhost:3400"
        );
        console.log("Checking API server connection...");
        const ok = await healthCheck(apiUrl, "/health");
        if (ok) {
          console.log("API server is reachable.\n");
          break;
        }
        console.error(
          `Could not reach ossgard API at ${apiUrl}. Is it running? (ossgard up)\n`
        );
        const retry = await ask(rl, "Try a different URL? (Y/n): ");
        if (retry.toLowerCase() === "n") {
          console.error("Setup cancelled. Start the API server and try again.");
          rl.close();
          process.exitCode = 1;
          return;
        }
      }

      // --- GitHub PAT ---
      console.log("=== GitHub ===\n");
      let githubToken = "";
      while (true) {
        const defaultHint = existing?.github.token ? " (leave blank to keep current)" : "";
        githubToken = await ask(rl, `GitHub Personal Access Token${defaultHint}: `);
        if (!githubToken && existing?.github.token) {
          githubToken = existing.github.token;
          console.log("Keeping existing token.");
          break;
        }
        if (!githubToken) {
          console.error("Token is required.");
          continue;
        }
        console.log("Validating token...");
        const valid = await validateGitHubToken(githubToken);
        if (valid) {
          console.log("Token is valid.\n");
          break;
        }
        console.error("Invalid token. Please try again.\n");
      }

      // --- LLM Provider ---
      console.log("=== LLM Provider ===\n");
      const llmProvider = await choose(
        rl,
        "Select LLM provider:",
        ["ollama", "anthropic"],
        existing?.llm.provider ?? "ollama"
      );

      let llmUrl = "";
      let llmModel = "";
      let llmApiKey = "";

      if (llmProvider === "ollama") {
        llmUrl = await askWithDefault(
          rl,
          "Ollama URL",
          existing?.llm.url ?? "http://localhost:11434"
        );
        llmModel = await askWithDefault(
          rl,
          "Model",
          existing?.llm.model ?? "llama3"
        );

        console.log("Checking Ollama connection...");
        const ok = await healthCheck(llmUrl, "/api/tags");
        if (ok) {
          console.log("Ollama is reachable.\n");
        } else {
          console.log(
            `Warning: Could not reach Ollama at ${llmUrl}. Make sure it's running before using ossgard.\n`
          );
        }
      } else {
        // anthropic
        llmApiKey = await askWithDefault(
          rl,
          "Anthropic API key",
          existing?.llm.api_key ?? ""
        );
        if (llmApiKey && !llmApiKey.startsWith("sk-ant-")) {
          console.log(
            "Warning: Anthropic API keys typically start with 'sk-ant-'.\n"
          );
        }
        llmModel = await askWithDefault(
          rl,
          "Model",
          existing?.llm.model ?? "claude-sonnet-4-20250514"
        );
        llmUrl = existing?.llm.url ?? "";
      }

      // --- Embedding Provider ---
      console.log("=== Embedding Provider ===\n");
      const embeddingProvider = await choose(
        rl,
        "Select embedding provider:",
        ["ollama", "openai"],
        existing?.embedding.provider ?? "ollama"
      );

      let embeddingUrl = "";
      let embeddingModel = "";
      let embeddingApiKey = "";

      if (embeddingProvider === "ollama") {
        embeddingUrl = await askWithDefault(
          rl,
          "Ollama URL",
          existing?.embedding.url ?? "http://localhost:11434"
        );
        embeddingModel = await askWithDefault(
          rl,
          "Model",
          existing?.embedding.model ?? "nomic-embed-text"
        );

        console.log("Checking Ollama connection...");
        const ok = await healthCheck(embeddingUrl, "/api/tags");
        if (ok) {
          console.log("Ollama is reachable.\n");
        } else {
          console.log(
            `Warning: Could not reach Ollama at ${embeddingUrl}. Make sure it's running before using ossgard.\n`
          );
        }
      } else {
        // openai
        embeddingApiKey = await askWithDefault(
          rl,
          "OpenAI API key",
          existing?.embedding.api_key ?? ""
        );
        if (embeddingApiKey && !embeddingApiKey.startsWith("sk-")) {
          console.log(
            "Warning: OpenAI API keys typically start with 'sk-'.\n"
          );
        }
        embeddingModel = await askWithDefault(
          rl,
          "Model",
          existing?.embedding.model ?? "text-embedding-3-small"
        );
        embeddingUrl = existing?.embedding.url ?? "";
      }

      // --- Vector Store (Qdrant) ---
      console.log("=== Vector Store (Qdrant) ===\n");
      const vectorUrl = await askWithDefault(
        rl,
        "Qdrant URL",
        existing?.vector_store.url ?? "http://localhost:6333"
      );
      const vectorApiKey = await askWithDefault(
        rl,
        "Qdrant API key (optional, press Enter to skip)",
        existing?.vector_store.api_key ?? ""
      );

      console.log("Checking Qdrant connection...");
      const qdrantOk = await healthCheck(vectorUrl, "/collections");
      if (qdrantOk) {
        console.log("Qdrant is reachable.\n");
      } else {
        console.log(
          `Warning: Could not reach Qdrant at ${vectorUrl}. Make sure it's running before using ossgard.\n`
        );
      }

      rl.close();

      // Build full config
      const newConfig: OssgardConfig = {
        api: { url: apiUrl },
        github: { token: githubToken },
        llm: {
          provider: llmProvider,
          url: llmUrl,
          model: llmModel,
          api_key: llmApiKey,
        },
        embedding: {
          provider: embeddingProvider,
          url: embeddingUrl,
          model: embeddingModel,
          api_key: embeddingApiKey,
        },
        vector_store: {
          url: vectorUrl,
          api_key: vectorApiKey,
        },
        scan: existing?.scan ?? {
          concurrency: 10,
          code_similarity_threshold: 0.85,
          intent_similarity_threshold: 0.80,
        },
      };

      config.save(newConfig);
      console.log("Config written to ~/.ossgard/config.toml");
      console.log('Run "ossgard up" to start the stack.');
    });
}
