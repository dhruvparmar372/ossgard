#!/usr/bin/env node
import { Command } from "commander";
import { ApiClient } from "./client.js";
import { trackCommand, untrackCommand } from "./commands/track.js";
import { statusCommand } from "./commands/status.js";
import { registerInitCommand } from "./commands/init.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerStackCommands } from "./commands/stack.js";
import { scanCommand } from "./commands/scan.js";
import { dupesCommand } from "./commands/dupes.js";

const client = new ApiClient(process.env.OSSGARD_API_URL);

const program = new Command();

program
  .name("ossgard")
  .description("Scan GitHub repos for duplicate PRs and rank them")
  .version("0.1.0");

registerInitCommand(program);
registerConfigCommand(program);
registerStackCommands(program);

program.addCommand(trackCommand(client));
program.addCommand(untrackCommand(client));
program.addCommand(statusCommand(client));
program.addCommand(scanCommand(client));
program.addCommand(dupesCommand(client));

program.parse();
