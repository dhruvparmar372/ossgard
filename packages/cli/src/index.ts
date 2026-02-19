#!/usr/bin/env node
import { Command } from "commander";
import { ApiClient } from "./client.js";
import { Config } from "./config.js";
import { statusCommand } from "./commands/status.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerConfigCommand } from "./commands/config.js";
import { scanCommand } from "./commands/scan.js";
import { duplicatesCommand } from "./commands/duplicates.js";
import { reviewCommand } from "./commands/review.js";
import { cleanCommand } from "./commands/clean.js";
import { doctorCommand } from "./commands/doctor.js";

const config = new Config();
const apiUrl = process.env.OSSGARD_API_URL ?? config.get("api.url") as string | undefined;
const apiKey = process.env.OSSGARD_API_KEY ?? config.get("api.key") as string | undefined;
const client = new ApiClient(apiUrl, apiKey ?? undefined);

const program = new Command();

program
  .name("ossgard")
  .description("Scan GitHub repos for duplicate PRs and rank them")
  .version("0.1.0");

// Setup & diagnostics
registerSetupCommand(program);
program.addCommand(doctorCommand(client));

// Primary workflow
program.addCommand(scanCommand(client));
program.addCommand(duplicatesCommand(client));
program.addCommand(reviewCommand(client));

// Informational
program.addCommand(statusCommand(client));
registerConfigCommand(program, client);

// Destructive
program.addCommand(cleanCommand(client));

program.parse();
