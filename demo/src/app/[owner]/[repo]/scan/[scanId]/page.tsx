import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { repos, getRepoData, getScanData } from "@/data";
import { StatsBar } from "@/components/stats-bar";
import { ReviewCarousel } from "@/components/review-carousel";
import { DownloadButton } from "@/components/download-button";

export function generateStaticParams() {
  const params: { owner: string; repo: string; scanId: string }[] = [];
  for (const r of repos) {
    // Skip the first scan (shown on the main repo page)
    for (const scan of r.scans.slice(1)) {
      params.push({
        owner: r.repo.owner,
        repo: r.repo.name,
        scanId: String(scan.id),
      });
    }
  }
  return params;
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

export default async function ScanDetailPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string; scanId: string }>;
}) {
  const { owner, repo, scanId: scanIdStr } = await params;
  const scanId = Number(scanIdStr);

  const repoIndex = getRepoData(owner, repo);
  if (!repoIndex) notFound();

  const data = getScanData(owner, repo, scanId);
  if (!data) notFound();

  return (
    <main className="min-h-svh px-6 py-12 sm:px-8">
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link
              href={`/${owner}/${repo}`}
              className="inline-flex items-center justify-center rounded-sm border border-border p-2 text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Back to ${owner}/${repo}`}
            >
              <ArrowLeft className="size-4" />
            </Link>
            <div>
              <h1 className="font-mono text-xl font-bold tracking-tight text-foreground sm:text-2xl">
                {owner}/{repo}
              </h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Scan from {formatDate(data.scan.completedAt)}
              </p>
            </div>
          </div>
          <DownloadButton data={data} />
        </div>

        {/* Stats Bar */}
        <div className="mt-8">
          <StatsBar data={data} />
        </div>

        {/* Review Carousel */}
        <ReviewCarousel groups={data.groups} />
      </div>
    </main>
  );
}
