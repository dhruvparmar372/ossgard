import { Command } from "commander";
import { createInterface, Interface as RLInterface } from "node:readline";
import { Config, OssgardConfig } from "../config.js";
import { ApiClient, ApiError } from "../client.js";

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
    .addHelpText("after", `
Examples:
  $ ossgard setup
  $ ossgard setup --force`)
    .action(async (opts: { force?: boolean }) => {
      const config = new Config();

      if (config.isComplete() && !opts.force) {
        console.log("ossgard is already configured.");
        console.log('Run "ossgard setup --force" to reconfigure.');
        return;
      }

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
          `Could not reach ossgard API at ${apiUrl}. Is it running?\n`
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
        githubToken = await ask(rl, "GitHub Personal Access Token: ");
        if (!githubToken) {
          console.error("Token is required.");
          continue;
        }
        break;
      }

      // --- LLM Provider ---
      console.log("\n=== LLM Provider ===\n");
      const llmProvider = await choose(
        rl,
        "Select LLM provider:",
        ["ollama", "anthropic"],
        "ollama"
      );

      let llmUrl = "";
      let llmModel = "";
      let llmApiKey = "";

      if (llmProvider === "ollama") {
        llmUrl = await askWithDefault(rl, "Ollama URL", "http://localhost:11434");
        llmModel = await askWithDefault(rl, "Model", "llama3");
      } else {
        llmApiKey = await ask(rl, "Anthropic API key: ");
        llmModel = await askWithDefault(rl, "Model", "claude-sonnet-4-20250514");
        llmUrl = "";
      }

      // --- Embedding Provider ---
      console.log("\n=== Embedding Provider ===\n");
      const embeddingProvider = await choose(
        rl,
        "Select embedding provider:",
        ["ollama", "openai"],
        "ollama"
      );

      let embeddingUrl = "";
      let embeddingModel = "";
      let embeddingApiKey = "";

      if (embeddingProvider === "ollama") {
        embeddingUrl = await askWithDefault(rl, "Ollama URL", "http://localhost:11434");
        embeddingModel = await askWithDefault(rl, "Model", "nomic-embed-text");
      } else {
        embeddingApiKey = await ask(rl, "OpenAI API key: ");
        embeddingModel = await askWithDefault(rl, "Model", "text-embedding-3-small");
        embeddingUrl = "";
      }

      // --- Vector Store (Qdrant) ---
      console.log("\n=== Vector Store (Qdrant) ===\n");
      const vectorUrl = await askWithDefault(rl, "Qdrant URL", "http://localhost:6333");
      const vectorApiKey = await askWithDefault(
        rl,
        "Qdrant API key (optional, press Enter to skip)",
        ""
      );

      rl.close();

      // Build the account config to send to the API
      const accountConfig = {
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
      };

      // Register or update account
      const unauthClient = new ApiClient(apiUrl);
      let apiKey: string;

      if (opts.force && existing?.api?.key) {
        // Reconfigure: update existing account
        console.log("\nUpdating account configuration...");
        try {
          const authClient = new ApiClient(apiUrl, existing.api.key);
          const result = await authClient.updateAccountConfig(accountConfig);
          apiKey = existing.api.key;
          if (result.warnings.length > 0) {
            for (const w of result.warnings) {
              console.log(`  Warning: ${w}`);
            }
          }
          console.log("Account configuration updated.");
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            console.log("Existing API key invalid. Registering new account...");
            const result = await unauthClient.register(accountConfig);
            apiKey = result.apiKey;
            if (result.warnings.length > 0) {
              for (const w of result.warnings) {
                console.log(`  Warning: ${w}`);
              }
            }
          } else {
            throw err;
          }
        }
      } else {
        // First-time setup: register new account
        console.log("\nRegistering account...");
        try {
          const result = await unauthClient.register(accountConfig);
          apiKey = result.apiKey;
          if (result.warnings.length > 0) {
            for (const w of result.warnings) {
              console.log(`  Warning: ${w}`);
            }
          }
          console.log("Account registered successfully.");
        } catch (err) {
          if (err instanceof ApiError) {
            console.error(`Registration failed: ${err.body}`);
            process.exitCode = 1;
            return;
          }
          throw err;
        }
      }

      // Save only api.url + api.key locally
      const newConfig: OssgardConfig = {
        api: { url: apiUrl, key: apiKey },
      };
      config.save(newConfig);

      console.log("\nConfig written to ~/.ossgard/config.toml");
      console.log(`API key: ${apiKey.slice(0, 8)}...`);
      console.log("You can now use ossgard commands (track, scan, dupes, etc.).");
    });
}
