export async function validateGitHubToken(token: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return { valid: true };
    return { valid: false, error: `GitHub API returned ${res.status}` };
  } catch (err) {
    return { valid: false, error: `GitHub API unreachable: ${(err as Error).message}` };
  }
}

export async function checkOllamaHealth(url: string): Promise<{ reachable: boolean }> {
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    return { reachable: res.ok };
  } catch {
    return { reachable: false };
  }
}

export async function checkQdrantHealth(url: string): Promise<{ reachable: boolean }> {
  try {
    const res = await fetch(`${url}/collections`, { signal: AbortSignal.timeout(5000) });
    return { reachable: res.ok };
  } catch {
    return { reachable: false };
  }
}
