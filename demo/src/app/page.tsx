import { Hero } from "@/components/hero";
import { RepoCard } from "@/components/repo-card";
import { repos } from "@/data";

export default function Home() {
  return (
    <>
      <Hero />
      <section id="repos" className="min-h-svh px-6 py-24 sm:px-8">
        <div className="mx-auto max-w-6xl">
          <h2 className="font-mono text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            Repositories Analyzed
          </h2>
          <p className="mt-2 text-muted-foreground">
            Real scan results from open-source projects
          </p>

          <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {repos.map((repo) => (
              <RepoCard
                key={`${repo.repo.owner}/${repo.repo.name}`}
                data={repo}
              />
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
