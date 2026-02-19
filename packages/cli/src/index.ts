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
import { setJsonMode } from "./json-mode.js";
import { setNonInteractive } from "./interactive.js";

const config = new Config();
const apiUrl = process.env.OSSGARD_API_URL ?? config.get("api.url") as string | undefined;
const apiKey = process.env.OSSGARD_API_KEY ?? config.get("api.key") as string | undefined;
const client = new ApiClient(apiUrl, apiKey ?? undefined);

const program = new Command();

program
  .name("ossgard")
  .description("Scan GitHub repos for duplicate PRs and rank them")
  .version("0.1.0");

// Global flags
program.option("--no-interactive", "Disable interactive prompts");

program.hook("preAction", (thisCommand, actionCommand) => {
  if (actionCommand.opts().json) setJsonMode(true);
  if (thisCommand.opts().interactive === false) setNonInteractive(true);
});

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

// Machine-readable command discovery for agents
if (process.argv.includes("--commands")) {
  const commands = program.commands.map((cmd) => ({
    name: cmd.name(),
    description: cmd.description(),
    arguments: cmd.registeredArguments.map((a) => ({
      name: a.name(),
      description: a.description,
      required: a.required,
    })),
    options: cmd.options
      .filter((o) => !o.hidden)
      .map((o) => ({
        flags: o.flags,
        description: o.description,
        required: o.required,
        defaultValue: o.defaultValue,
      })),
  }));
  console.log(JSON.stringify(commands, null, 2));
  process.exit(0);
}

program.parse();
