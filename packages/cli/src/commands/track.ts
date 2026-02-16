import { Command } from "commander";
import { ApiClient, ApiError } from "../client.js";
import { requireSetup } from "../guard.js";
import type { Repo } from "@ossgard/shared";

function parseSlug(slug: string): { owner: string; name: string } {
  const parts = slug.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid repo format: "${slug}". Expected "owner/repo" (e.g. facebook/react).`
    );
  }
  return { owner: parts[0], name: parts[1] };
}

export function trackCommand(client: ApiClient): Command {
  return new Command("track")
    .description("Track a GitHub repository")
    .argument("<owner/repo>", "Repository slug (e.g. facebook/react)")
    .action(async (slug: string) => {
      if (!requireSetup()) return;
      const { owner, name } = parseSlug(slug);
      try {
        const repo = await client.post<Repo>("/repos", { owner, name });
        console.log(`Tracking ${repo.owner}/${repo.name}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          console.error(`${owner}/${name} is already tracked.`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });
}

export function untrackCommand(client: ApiClient): Command {
  return new Command("untrack")
    .description("Stop tracking a GitHub repository")
    .argument("<owner/repo>", "Repository slug (e.g. facebook/react)")
    .action(async (slug: string) => {
      if (!requireSetup()) return;
      const { owner, name } = parseSlug(slug);
      try {
        await client.delete(`/repos/${owner}/${name}`);
        console.log(`Untracked ${owner}/${name}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          console.error(`${owner}/${name} is not tracked.`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });
}

export { parseSlug };
