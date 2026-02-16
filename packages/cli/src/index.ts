#!/usr/bin/env node
import { Command } from "commander";
import { ApiClient } from "./client.js";
import { Config } from "./config.js";
import { trackCommand, untrackCommand } from "./commands/track.js";
import { statusCommand } from "./commands/status.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerConfigCommand } from "./commands/config.js";
import { scanCommand } from "./commands/scan.js";
import { dupesCommand } from "./commands/dupes.js";

const config = new Config();
const apiUrl = process.env.OSSGARD_API_URL ?? config.get("api.url") as string | undefined;
const client = new ApiClient(apiUrl);

const program = new Command();

program
  .name("ossgard")
  .description("Scan GitHub repos for duplicate PRs and rank them")
  .version("0.1.0");

registerSetupCommand(program);
registerConfigCommand(program);

program.addCommand(trackCommand(client));
program.addCommand(untrackCommand(client));
program.addCommand(statusCommand(client));
program.addCommand(scanCommand(client));
program.addCommand(dupesCommand(client));

program.parse();
