#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
  .name("ossgard")
  .description("Scan GitHub repos for duplicate PRs and rank them")
  .version("0.1.0");

program.parse();
