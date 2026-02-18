#!/usr/bin/env node
import { Command } from "commander";
import { ApiClient } from "./client.js";
import { Config } from "./config.js";
import { statusCommand } from "./commands/status.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerConfigCommand } from "./commands/config.js";
import { scanCommand } from "./commands/scan.js";
import { dupesCommand } from "./commands/dupes.js";
import { reviewCommand } from "./commands/review.js";
import { clearScansCommand, clearReposCommand, resetCommand } from "./commands/reset.js";

const config = new Config();
const apiUrl = process.env.OSSGARD_API_URL ?? config.get("api.url") as string | undefined;
const apiKey = process.env.OSSGARD_API_KEY ?? config.get("api.key") as string | undefined;
const client = new ApiClient(apiUrl, apiKey ?? undefined);

const program = new Command();

program
  .name("ossgard")
  .description("Scan GitHub repos for duplicate PRs and rank them")
  .version("0.1.0");

registerSetupCommand(program);
registerConfigCommand(program, client);

program.addCommand(statusCommand(client));
program.addCommand(scanCommand(client));
program.addCommand(dupesCommand(client));
program.addCommand(reviewCommand(client));
program.addCommand(clearScansCommand(client));
program.addCommand(clearReposCommand(client));
program.addCommand(resetCommand(client));

program.parse();
