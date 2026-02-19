"use client";

import { Download } from "lucide-react";
import type { RepoScanData } from "@/lib/types";

interface DownloadButtonProps {
  data: RepoScanData;
}

export function DownloadButton({ data }: DownloadButtonProps) {
  function handleDownload() {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${data.repo.owner}-${data.repo.name}-scan.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <button
      onClick={handleDownload}
      className="inline-flex items-center gap-2 rounded-sm border border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Download className="size-4" />
      <span className="hidden sm:inline">Download JSON</span>
    </button>
  );
}
