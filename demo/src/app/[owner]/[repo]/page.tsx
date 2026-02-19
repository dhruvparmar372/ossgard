import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Github } from "lucide-react";
import { repos, getRepoData } from "@/data";
import { StatsBar } from "@/components/stats-bar";
import { ReviewCarousel } from "@/components/review-carousel";

export function generateStaticParams() {
  return repos.map((r) => ({
    owner: r.repo.owner,
    repo: r.repo.name,
  }));
}

export default async function RepoPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { owner, repo } = await params;
  const data = getRepoData(owner, repo);
  if (!data) notFound();

  return (
    <main className="min-h-svh px-6 py-12 sm:px-8">
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="inline-flex items-center justify-center rounded-sm border border-border p-2 text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              aria-label="Back to home"
            >
              <ArrowLeft className="size-4" />
            </Link>
            <h1 className="font-mono text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              {owner}/{repo}
            </h1>
          </div>
          <a
            href={data.repo.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-sm border border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            aria-label={`View ${owner}/${repo} on GitHub`}
          >
            <Github className="size-4" />
            <span className="hidden sm:inline">GitHub</span>
          </a>
        </div>

        {/* Stats Bar */}
        <div className="mt-8">
          <StatsBar data={data} />
        </div>

        {/* Review Carousel */}
        <ReviewCarousel
          groups={data.groups}
          repoOwner={data.repo.owner}
          repoName={data.repo.name}
        />
      </div>
    </main>
  );
}
