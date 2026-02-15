import { Command } from "commander";
import { createInterface } from "node:readline";
import { Config } from "../config.js";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize ossgard configuration")
    .action(async () => {
      const config = new Config();

      if (config.exists()) {
        console.log("Config already exists at ~/.ossgard/config.toml");
        console.log('Use "ossgard config set <key> <value>" to update settings.');
        return;
      }

      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const token = await new Promise<string>((resolve) => {
        rl.question("GitHub Personal Access Token: ", (answer) => {
          resolve(answer.trim());
        });
      });

      rl.close();

      if (!token) {
        console.error("Token is required. Run `ossgard init` again.");
        process.exitCode = 1;
        return;
      }

      config.init(token);
      console.log("Config written to ~/.ossgard/config.toml");
      console.log("Run `ossgard up` to start the stack.");
    });
}
