import { ChevronDown } from "lucide-react";

function TerminalLine({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={className}>{children}</div>;
}

function Terminal() {
  return (
    <div className="w-full max-w-xl overflow-hidden rounded-sm border border-border bg-[oklch(0.13_0_0)]">
      {/* Title bar */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <div className="flex gap-1.5">
          <span className="block size-2.5 rounded-full bg-zinc-600" />
          <span className="block size-2.5 rounded-full bg-zinc-600" />
          <span className="block size-2.5 rounded-full bg-zinc-600" />
        </div>
        <span className="ml-2 font-mono text-xs text-muted-foreground">
          terminal
        </span>
      </div>

      {/* Terminal body */}
      <div className="p-4 font-mono text-[13px] leading-relaxed sm:p-5 sm:text-sm">
        <TerminalLine className="text-muted-foreground">
          <span className="text-primary">$</span> ossgard scan
          openclaw/openclaw
        </TerminalLine>

        <TerminalLine className="mt-1 text-zinc-500">
          Scanning 1,000 open PRs...
        </TerminalLine>

        <div className="mt-3 space-y-0.5">
          <TerminalLine className="text-foreground">
            <span className="text-primary">&#10003;</span> 77 duplicate groups
            found
          </TerminalLine>
          <TerminalLine className="text-foreground">
            <span className="text-primary">&#10003;</span> 175 duplicate PRs
            detected (17%)
          </TerminalLine>
        </div>

        <TerminalLine className="mt-3 text-zinc-500">
          Run{" "}
          <span className="text-muted-foreground">
            `ossgard dupes openclaw/openclaw`
          </span>{" "}
          to review
        </TerminalLine>
      </div>
    </div>
  );
}

export function Hero() {
  return (
    <section className="relative flex min-h-svh flex-col items-center justify-center px-6 py-24 sm:px-8">
      {/* Faint grid background */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,oklch(1_0_0/0.03)_1px,transparent_1px),linear-gradient(to_bottom,oklch(1_0_0/0.03)_1px,transparent_1px)] bg-[size:64px_64px]"
      />

      <div className="relative z-10 flex w-full max-w-3xl flex-col items-center gap-10 text-center">
        {/* Headline */}
        <div className="space-y-4">
          <h1 className="font-mono text-4xl font-bold tracking-tight text-foreground sm:text-5xl md:text-6xl">
            Stop reviewing
            <br />
            <span className="text-primary">duplicate PRs</span>
          </h1>
          <p className="mx-auto max-w-xl text-lg leading-relaxed text-muted-foreground">
            ossgard detects duplicate pull requests in open-source repos using
            AI-powered code and intent analysis
          </p>
        </div>

        {/* Terminal mockup */}
        <Terminal />

        {/* CTA */}
        <a
          href="#repos"
          className="group inline-flex items-center gap-2 rounded-sm border border-primary/30 bg-primary/10 px-6 py-2.5 font-mono text-sm text-primary transition-colors hover:border-primary/60 hover:bg-primary/20"
        >
          See it in action
          <ChevronDown className="size-4 transition-transform group-hover:translate-y-0.5" />
        </a>
      </div>
    </section>
  );
}
