"use client";

import { useState } from "react";
import { XCircle, Check, Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GitHubTokenModal } from "@/components/github-token-modal";
import { useGithubToken } from "@/hooks/use-github-token";
import { closePrWithComment, type CloseResult } from "@/lib/github";
import type { DupeGroupMember } from "@/lib/types";

interface CloseDupesButtonProps {
  owner: string;
  repoName: string;
  duplicateMembers: DupeGroupMember[];
  recommendedPrNumber: number;
}

type Status = "idle" | "confirming" | "closing" | "done";

export function CloseDupesButton({
  owner,
  repoName,
  duplicateMembers,
  recommendedPrNumber,
}: CloseDupesButtonProps) {
  const { token, setToken, clearToken } = useGithubToken();
  const [showModal, setShowModal] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [results, setResults] = useState<CloseResult[]>([]);

  if (duplicateMembers.length === 0) return null;

  async function handleClose() {
    if (!token) return;
    setStatus("closing");

    const closeResults: CloseResult[] = [];
    for (const member of duplicateMembers) {
      const result = await closePrWithComment(
        owner,
        repoName,
        member.prNumber,
        recommendedPrNumber,
        token
      );
      closeResults.push(result);
      setResults([...closeResults]);
    }

    setStatus("done");
  }

  function handleClick() {
    if (!token) {
      setShowModal(true);
      return;
    }
    setStatus("confirming");
  }

  // After saving a token from the modal, move to confirming state
  function handleTokenSave(newToken: string) {
    setToken(newToken);
    setStatus("confirming");
  }

  if (status === "done") {
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    return (
      <div className="mt-4 space-y-2 rounded-sm border border-border bg-card p-3">
        <p className="text-xs font-medium text-muted-foreground">
          {successCount > 0 && (
            <span className="text-primary">
              {successCount} PR{successCount !== 1 ? "s" : ""} closed.
            </span>
          )}
          {failCount > 0 && (
            <span className="ml-2 text-destructive">
              {failCount} failed.
            </span>
          )}
        </p>
        <ul className="space-y-1">
          {results.map((r) => (
            <li key={r.prNumber} className="flex items-center gap-2 text-xs">
              {r.success ? (
                <Check className="size-3 text-primary" />
              ) : (
                <AlertTriangle className="size-3 text-destructive" />
              )}
              <span className="font-mono text-foreground">#{r.prNumber}</span>
              {r.error && (
                <span className="text-destructive">{r.error}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (status === "confirming") {
    return (
      <div className="mt-4 flex items-center gap-2">
        <span className="text-sm text-muted-foreground">
          Close {duplicateMembers.length} duplicate PR
          {duplicateMembers.length !== 1 ? "s" : ""} and leave comments?
        </span>
        <Button
          size="xs"
          className="rounded-sm bg-amber-600 text-white hover:bg-amber-700"
          onClick={handleClose}
        >
          Yes
        </Button>
        <Button
          variant="ghost"
          size="xs"
          className="rounded-sm"
          onClick={() => setStatus("idle")}
        >
          Cancel
        </Button>
      </div>
    );
  }

  if (status === "closing") {
    return (
      <div className="mt-4 space-y-2">
        <Button
          size="sm"
          disabled
          className="rounded-sm bg-amber-600 text-white"
        >
          <Loader2 className="size-3 animate-spin" />
          Closing...
        </Button>
        {results.length > 0 && (
          <ul className="space-y-1">
            {results.map((r) => (
              <li key={r.prNumber} className="flex items-center gap-2 text-xs">
                {r.success ? (
                  <Check className="size-3 text-primary" />
                ) : (
                  <AlertTriangle className="size-3 text-destructive" />
                )}
                <span className="font-mono text-foreground">#{r.prNumber}</span>
                {r.error && (
                  <span className="text-destructive">{r.error}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // idle
  return (
    <>
      <Button
        size="sm"
        className="mt-4 rounded-sm bg-amber-600 text-white hover:bg-amber-700"
        onClick={handleClick}
      >
        <XCircle className="size-3.5" />
        Close Duplicates
      </Button>

      <GitHubTokenModal
        open={showModal}
        onOpenChange={setShowModal}
        onSave={handleTokenSave}
        hasExistingToken={!!token}
        onClear={clearToken}
      />
    </>
  );
}
