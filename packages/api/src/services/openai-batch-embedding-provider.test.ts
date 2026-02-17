import { OpenAIBatchEmbeddingProvider } from "./openai-batch-embedding-provider.js";

describe("OpenAIBatchEmbeddingProvider", () => {
  it("has batch property set to true", () => {
    const provider = new OpenAIBatchEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-large",
    });
    expect(provider.batch).toBe(true);
  });

  it("has correct dimensions for known models", () => {
    const large = new OpenAIBatchEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-large",
    });
    expect(large.dimensions).toBe(3072);

    const small = new OpenAIBatchEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-small",
    });
    expect(small.dimensions).toBe(1536);
  });

  it("has maxInputTokens of 8191", () => {
    const provider = new OpenAIBatchEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-large",
    });
    expect(provider.maxInputTokens).toBe(8191);
  });

  it("counts tokens via tiktoken", () => {
    const provider = new OpenAIBatchEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-large",
    });
    expect(provider.countTokens("hello world")).toBe(2);
  });

  describe("embed (sync fallback)", () => {
    it("returns embeddings sorted by index", async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              { index: 1, embedding: [0.4, 0.5] },
              { index: 0, embedding: [0.1, 0.2] },
            ],
          }),
      }) as unknown as typeof fetch;

      const provider = new OpenAIBatchEmbeddingProvider({
        apiKey: "sk-test",
        model: "text-embedding-3-large",
        fetchFn,
      });

      const result = await provider.embed(["text1", "text2"]);

      expect(result).toEqual([
        [0.1, 0.2],
        [0.4, 0.5],
      ]);
    });

    it("throws on non-OK response", async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        text: () => Promise.resolve(""),
      }) as unknown as typeof fetch;

      const provider = new OpenAIBatchEmbeddingProvider({
        apiKey: "sk-test",
        model: "text-embedding-3-large",
        fetchFn,
      });

      await expect(provider.embed(["text"])).rejects.toThrow(
        "OpenAI embedding error: 429 Too Many Requests"
      );
    });
  });

  describe("embedBatch", () => {
    it("returns empty array for empty input", async () => {
      const provider = new OpenAIBatchEmbeddingProvider({
        apiKey: "sk-test",
        model: "text-embedding-3-large",
      });

      const results = await provider.embedBatch([]);
      expect(results).toEqual([]);
    });

    it("uses sync path for single request", async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ index: 0, embedding: [0.1, 0.2] }],
          }),
      }) as unknown as typeof fetch;

      const provider = new OpenAIBatchEmbeddingProvider({
        apiKey: "sk-test",
        model: "text-embedding-3-large",
        fetchFn,
      });

      const results = await provider.embedBatch([
        { id: "req-1", texts: ["hello"] },
      ]);

      expect(results).toEqual([
        { id: "req-1", embeddings: [[0.1, 0.2]] },
      ]);
      // Only 1 fetch (sync embed), not multi-step batch
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn).toHaveBeenCalledWith(
        "https://api.openai.com/v1/embeddings",
        expect.anything()
      );
    });

    it("uploads file, creates batch, polls, and downloads results", async () => {
      const fetchFn = vi
        .fn()
        // 1. Upload file
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "file-abc" }),
        })
        // 2. Create batch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "batch-xyz" }),
        })
        // 3. Poll -> completed
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              status: "completed",
              output_file_id: "file-out",
            }),
        })
        // 4. Download results
        .mockResolvedValueOnce({
          ok: true,
          text: () =>
            Promise.resolve(
              [
                JSON.stringify({
                  custom_id: "req-2",
                  response: {
                    status_code: 200,
                    body: {
                      data: [{ index: 0, embedding: [0.4, 0.5] }],
                    },
                  },
                }),
                JSON.stringify({
                  custom_id: "req-1",
                  response: {
                    status_code: 200,
                    body: {
                      data: [{ index: 0, embedding: [0.1, 0.2] }],
                    },
                  },
                }),
              ].join("\n")
            ),
        }) as unknown as typeof fetch;

      const provider = new OpenAIBatchEmbeddingProvider({
        apiKey: "sk-test",
        model: "text-embedding-3-large",
        fetchFn,
        pollIntervalMs: 0,
      });

      const results = await provider.embedBatch([
        { id: "req-1", texts: ["first"] },
        { id: "req-2", texts: ["second"] },
      ]);

      // Results in input order
      expect(results).toEqual([
        { id: "req-1", embeddings: [[0.1, 0.2]] },
        { id: "req-2", embeddings: [[0.4, 0.5]] },
      ]);

      // 4 fetch calls: upload, create, poll, download
      expect(fetchFn).toHaveBeenCalledTimes(4);

      // Upload call
      expect(fetchFn).toHaveBeenNthCalledWith(
        1,
        "https://api.openai.com/v1/files",
        expect.objectContaining({ method: "POST" })
      );

      // Create batch call
      expect(fetchFn).toHaveBeenNthCalledWith(
        2,
        "https://api.openai.com/v1/batches",
        expect.objectContaining({ method: "POST" })
      );

      // Poll call
      expect(fetchFn).toHaveBeenNthCalledWith(
        3,
        "https://api.openai.com/v1/batches/batch-xyz",
        expect.objectContaining({ method: "GET" })
      );

      // Download call
      expect(fetchFn).toHaveBeenNthCalledWith(
        4,
        "https://api.openai.com/v1/files/file-out/content",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("throws on failed batch status", async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "file-abc" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "batch-xyz" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ status: "failed" }),
        }) as unknown as typeof fetch;

      const provider = new OpenAIBatchEmbeddingProvider({
        apiKey: "sk-test",
        model: "text-embedding-3-large",
        fetchFn,
        pollIntervalMs: 0,
      });

      await expect(
        provider.embedBatch([
          { id: "req-1", texts: ["a"] },
          { id: "req-2", texts: ["b"] },
        ])
      ).rejects.toThrow("OpenAI batch failed");
    });

    it("throws on non-200 batch item", async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "file-abc" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "batch-xyz" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              status: "completed",
              output_file_id: "file-out",
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                custom_id: "req-1",
                response: {
                  status_code: 429,
                  body: { error: "rate limited" },
                },
              })
            ),
        }) as unknown as typeof fetch;

      const provider = new OpenAIBatchEmbeddingProvider({
        apiKey: "sk-test",
        model: "text-embedding-3-large",
        fetchFn,
        pollIntervalMs: 0,
      });

      await expect(
        provider.embedBatch([
          { id: "req-1", texts: ["a"] },
          { id: "req-2", texts: ["b"] },
        ])
      ).rejects.toThrow("OpenAI batch item req-1 returned status 429");
    });

    it("throws on file upload failure", async () => {
      const fetchFn = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 413,
        statusText: "Payload Too Large",
      }) as unknown as typeof fetch;

      const provider = new OpenAIBatchEmbeddingProvider({
        apiKey: "sk-test",
        model: "text-embedding-3-large",
        fetchFn,
      });

      await expect(
        provider.embedBatch([
          { id: "req-1", texts: ["a"] },
          { id: "req-2", texts: ["b"] },
        ])
      ).rejects.toThrow("OpenAI file upload error: 413 Payload Too Large");
    });

    it("tolerates transient 5xx poll errors", async () => {
      const fetchFn = vi
        .fn()
        // Upload
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "file-abc" }),
        })
        // Create batch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "batch-xyz" }),
        })
        // Poll 1 -> 500 (transient)
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
        })
        // Poll 2 -> completed
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              status: "completed",
              output_file_id: "file-out",
            }),
        })
        // Download results
        .mockResolvedValueOnce({
          ok: true,
          text: () =>
            Promise.resolve(
              [
                JSON.stringify({
                  custom_id: "req-1",
                  response: {
                    status_code: 200,
                    body: { data: [{ index: 0, embedding: [0.1] }] },
                  },
                }),
                JSON.stringify({
                  custom_id: "req-2",
                  response: {
                    status_code: 200,
                    body: { data: [{ index: 0, embedding: [0.2] }] },
                  },
                }),
              ].join("\n")
            ),
        }) as unknown as typeof fetch;

      const provider = new OpenAIBatchEmbeddingProvider({
        apiKey: "sk-test",
        model: "text-embedding-3-large",
        fetchFn,
        pollIntervalMs: 0,
      });

      const results = await provider.embedBatch([
        { id: "req-1", texts: ["a"] },
        { id: "req-2", texts: ["b"] },
      ]);

      expect(results).toHaveLength(2);
      // 5 calls: upload, create, 500-poll, ok-poll, download
      expect(fetchFn).toHaveBeenCalledTimes(5);
    });

    it("resumes from existing batch ID (skips upload + create)", async () => {
      const fetchFn = vi
        .fn()
        // Poll -> completed
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              status: "completed",
              output_file_id: "file-out",
            }),
        })
        // Download results
        .mockResolvedValueOnce({
          ok: true,
          text: () =>
            Promise.resolve(
              [
                JSON.stringify({
                  custom_id: "req-1",
                  response: {
                    status_code: 200,
                    body: { data: [{ index: 0, embedding: [0.1] }] },
                  },
                }),
                JSON.stringify({
                  custom_id: "req-2",
                  response: {
                    status_code: 200,
                    body: { data: [{ index: 0, embedding: [0.2] }] },
                  },
                }),
              ].join("\n")
            ),
        }) as unknown as typeof fetch;

      const provider = new OpenAIBatchEmbeddingProvider({
        apiKey: "sk-test",
        model: "text-embedding-3-large",
        fetchFn,
        pollIntervalMs: 0,
      });

      const results = await provider.embedBatch(
        [
          { id: "req-1", texts: ["a"] },
          { id: "req-2", texts: ["b"] },
        ],
        { existingBatchId: "batch-existing-123" }
      );

      expect(results).toHaveLength(2);
      // Only 2 calls: poll + download (no upload or create)
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(fetchFn).toHaveBeenNthCalledWith(
        1,
        "https://api.openai.com/v1/batches/batch-existing-123",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("calls onBatchCreated callback after creating a batch", async () => {
      const onBatchCreated = vi.fn();
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "file-abc" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "batch-callback-test" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              status: "completed",
              output_file_id: "file-out",
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: () =>
            Promise.resolve(
              [
                JSON.stringify({
                  custom_id: "req-1",
                  response: {
                    status_code: 200,
                    body: { data: [{ index: 0, embedding: [0.1] }] },
                  },
                }),
                JSON.stringify({
                  custom_id: "req-2",
                  response: {
                    status_code: 200,
                    body: { data: [{ index: 0, embedding: [0.2] }] },
                  },
                }),
              ].join("\n")
            ),
        }) as unknown as typeof fetch;

      const provider = new OpenAIBatchEmbeddingProvider({
        apiKey: "sk-test",
        model: "text-embedding-3-large",
        fetchFn,
        pollIntervalMs: 0,
      });

      await provider.embedBatch(
        [
          { id: "req-1", texts: ["a"] },
          { id: "req-2", texts: ["b"] },
        ],
        { onBatchCreated }
      );

      expect(onBatchCreated).toHaveBeenCalledTimes(1);
      expect(onBatchCreated).toHaveBeenCalledWith("batch-callback-test");
    });

    it("defaults to 24h timeout", () => {
      const provider = new OpenAIBatchEmbeddingProvider({
        apiKey: "sk-test",
        model: "text-embedding-3-large",
      });
      // Access private field via any for testing
      expect((provider as any).timeoutMs).toBe(24 * 60 * 60 * 1000);
    });
  });
});
