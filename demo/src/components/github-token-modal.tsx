"use client";

import { useState } from "react";
import { KeyRound, ExternalLink } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface GitHubTokenModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (token: string) => void;
  hasExistingToken: boolean;
  onClear: () => void;
}

export function GitHubTokenModal({
  open,
  onOpenChange,
  onSave,
  hasExistingToken,
  onClear,
}: GitHubTokenModalProps) {
  const [value, setValue] = useState("");

  function handleSave() {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSave(trimmed);
    setValue("");
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-sm border-border bg-background sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono text-base">
            <KeyRound className="size-4 text-primary" />
            GitHub Personal Access Token
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed text-muted-foreground">
            A token is required to close PRs on your behalf. You need the{" "}
            <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
              public_repo
            </code>{" "}
            scope for public repos, or{" "}
            <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
              repo
            </code>{" "}
            for private repos.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <a
            href="https://github.com/settings/tokens/new"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-sm text-sm text-primary transition-colors hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Create a token on GitHub
            <ExternalLink className="size-3" />
          </a>

          <input
            type="password"
            aria-label="GitHub personal access token"
            placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
            }}
            className="w-full rounded-sm border border-border bg-card px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />

          <p className="text-xs leading-relaxed text-muted-foreground">
            Your token is stored locally in your browser and never sent to our
            servers.
          </p>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          {hasExistingToken && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onClear();
                onOpenChange(false);
              }}
              className="text-destructive hover:text-destructive"
            >
              Clear saved token
            </Button>
          )}
          <Button
            onClick={handleSave}
            disabled={!value.trim()}
            size="sm"
            className="rounded-sm"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
