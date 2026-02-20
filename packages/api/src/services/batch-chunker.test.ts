import { estimateRequestTokens, chunkBatchRequests } from "./batch-chunker.js";
import type { BatchChatRequest } from "./llm-provider.js";

/** Simple token counter: 1 token per character (for predictable test math). */
const charCounter = (text: string) => text.length;

function makeRequest(id: string, contentLength: number): BatchChatRequest {
  return {
    id,
    messages: [{ role: "user", content: "x".repeat(contentLength) }],
  };
}

describe("estimateRequestTokens", () => {
  it("adds overhead to message token count", () => {
    const req: BatchChatRequest = {
      id: "r1",
      messages: [{ role: "user", content: "hello" }],
    };
    // 50 overhead + 5 chars = 55
    expect(estimateRequestTokens(req, charCounter)).toBe(55);
  });

  it("sums tokens across multiple messages", () => {
    const req: BatchChatRequest = {
      id: "r1",
      messages: [
        { role: "system", content: "abc" },
        { role: "user", content: "de" },
      ],
    };
    // 50 overhead + 3 + 2 = 55
    expect(estimateRequestTokens(req, charCounter)).toBe(55);
  });
});

describe("chunkBatchRequests", () => {
  it("returns empty array for empty input", () => {
    const chunks = chunkBatchRequests([], charCounter, 1000);
    expect(chunks).toEqual([]);
  });

  it("returns single chunk when total tokens < budget", () => {
    const requests = [makeRequest("r1", 100), makeRequest("r2", 100)];
    // Each: 50 + 100 = 150, total = 300
    const chunks = chunkBatchRequests(requests, charCounter, 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(2);
  });

  it("splits into multiple chunks when total tokens > budget", () => {
    const requests = [
      makeRequest("r1", 100), // 150 tokens
      makeRequest("r2", 100), // 150 tokens
      makeRequest("r3", 100), // 150 tokens
    ];
    // Budget = 300, so r1+r2 fit (300), r3 starts new chunk
    const chunks = chunkBatchRequests(requests, charCounter, 300);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(chunks[1].map((r) => r.id)).toEqual(["r3"]);
  });

  it("always includes at least 1 request per chunk even if it exceeds budget", () => {
    const requests = [makeRequest("r1", 500)]; // 550 tokens
    const chunks = chunkBatchRequests(requests, charCounter, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1);
    expect(chunks[0][0].id).toBe("r1");
  });

  it("preserves original order within chunks", () => {
    const requests = [
      makeRequest("r1", 100),
      makeRequest("r2", 100),
      makeRequest("r3", 100),
      makeRequest("r4", 100),
    ];
    // Budget = 310 -> r1+r2 fit (300), r3+r4 fit (300)
    const chunks = chunkBatchRequests(requests, charCounter, 310);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(chunks[1].map((r) => r.id)).toEqual(["r3", "r4"]);
  });

  it("puts request exactly at budget into current chunk", () => {
    const requests = [
      makeRequest("r1", 100), // 150 tokens
      makeRequest("r2", 100), // 150 tokens — total exactly 300
    ];
    const chunks = chunkBatchRequests(requests, charCounter, 300);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(2);
  });

  it("starts new chunk when adding request would exceed budget by 1", () => {
    const requests = [
      makeRequest("r1", 100), // 150 tokens
      makeRequest("r2", 101), // 151 tokens — total 301, exceeds 300
    ];
    const chunks = chunkBatchRequests(requests, charCounter, 300);
    expect(chunks).toHaveLength(2);
  });

  it("handles oversized requests between normal ones", () => {
    const requests = [
      makeRequest("r1", 50),  // 100 tokens
      makeRequest("r2", 500), // 550 tokens (oversized)
      makeRequest("r3", 50),  // 100 tokens
    ];
    // Budget = 200: r1 fits (100), r2 alone in chunk (550), r3 alone (100)
    const chunks = chunkBatchRequests(requests, charCounter, 200);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].map((r) => r.id)).toEqual(["r1"]);
    expect(chunks[1].map((r) => r.id)).toEqual(["r2"]);
    expect(chunks[2].map((r) => r.id)).toEqual(["r3"]);
  });
});
