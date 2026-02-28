import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Github, Clock } from "lucide-react";
import { repos, getRepoData } from "@/data";
import { DupeTrendChart } from "@/components/dupe-trend-chart";
import { CumulativeStats } from "@/components/cumulative-stats";

export function generateStaticParams() {
  if (repos.length === 0) return [{ owner: "_", repo: "_" }];
  return repos.map((r) => ({
    owner: r.repo.owner,
    repo: r.repo.name,
  }));
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function RepoPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { owner, repo } = await params;
  const repoIndex = getRepoData(owner, repo);
  if (!repoIndex || repoIndex.scans.length === 0) notFound();

  return (
    <main className="min-h-svh px-6 py-12 sm:px-8">
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="inline-flex items-center justify-center rounded-sm border border-border p-2 text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Back to home"
            >
              <ArrowLeft className="size-4" />
            </Link>
            <h1 className="font-mono text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              {owner}/{repo}
            </h1>
          </div>
          <a
            href={repoIndex.repo.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-sm border border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`View ${owner}/${repo} on GitHub`}
          >
            <Github className="size-4" />
            <span className="hidden sm:inline">GitHub</span>
          </a>
        </div>

        {/* Duplicate Trend Chart */}
        <div className="mt-8">
          <DupeTrendChart scans={repoIndex.scans} owner={owner} repo={repo} />
        </div>

        {/* Cumulative Stats */}
        <div className="mt-4">
          <CumulativeStats scans={repoIndex.scans} />
        </div>

        {/* Scan History */}
        <div className="mt-8">
          <h2 className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            <Clock className="size-3.5" />
            Scan History
          </h2>
          <div className="mt-3 space-y-1">
            {repoIndex.scans.map((scan, i) => {
              const pct = scan.prCount > 0
                ? Math.round((scan.dupePrCount / scan.prCount) * 100)
                : 0;
              return (
                <Link
                  key={scan.id}
                  href={`/${owner}/${repo}/scan/${scan.id}`}
                  className={`flex items-center justify-between rounded-sm border px-4 py-2.5 text-sm transition-colors ${
                    i === 0
                      ? "border-primary/30 bg-primary/5 text-foreground"
                      : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono">{formatDate(scan.completedAt)}</span>
                    {i === 0 && (
                      <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                        Latest
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-4 font-mono text-xs">
                    <span>{scan.prCount} PRs</span>
                    <span>{scan.dupeGroupCount} groups</span>
                    <span className="text-primary">{pct}%</span>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </main>
  );
}
