export function parseSlug(slug: string): { owner: string; name: string } {
  const parts = slug.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid repo format: "${slug}". Expected "owner/repo" (e.g. facebook/react).`
    );
  }
  return { owner: parts[0], name: parts[1] };
}
