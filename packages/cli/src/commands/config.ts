import { Command } from "commander";
import { Config } from "../config.js";

export function registerConfigCommand(program: Command): void {
  const configCmd = program
    .command("config")
    .description("Manage ossgard configuration");

  configCmd
    .command("get <key>")
    .description("Get a config value (dot-notation, e.g. llm.provider)")
    .action((key: string) => {
      const config = new Config();
      const value = config.get(key);

      if (value === undefined) {
        console.error(`Key "${key}" not found.`);
        process.exitCode = 1;
        return;
      }

      if (typeof value === "object" && value !== null) {
        console.log(JSON.stringify(value, null, 2));
      } else {
        console.log(String(value));
      }
    });

  configCmd
    .command("set <key> <value>")
    .description("Set a config value (dot-notation, e.g. llm.provider anthropic)")
    .action((key: string, value: string) => {
      const config = new Config();
      config.set(key, value);
      console.log(`Set ${key} = ${config.get(key)}`);
    });
}
