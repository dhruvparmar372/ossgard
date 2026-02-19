export interface CloseResult {
  prNumber: number;
  success: boolean;
  error?: string;
}

export async function closePrWithComment(
  owner: string,
  repo: string,
  prNumber: number,
  recommendedPrNumber: number,
  token: string
): Promise<CloseResult> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };

  try {
    // Post comment
    await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          body: `This pull request appears to be a duplicate of #${recommendedPrNumber}.\n\nDetected by [ossgard](https://github.com/dhruv/ossgard).`,
        }),
      }
    );

    // Close PR
    const closeRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ state: "closed" }),
      }
    );

    if (!closeRes.ok) {
      const err = await closeRes.json();
      return { prNumber, success: false, error: err.message ?? "Failed to close PR" };
    }

    return { prNumber, success: true };
  } catch (err) {
    return {
      prNumber,
      success: false,
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}
