import { QdrantStore, toUUID, type QdrantClient } from "./qdrant-store.js";

function createMockClient(): QdrantClient {
  return {
    getCollections: vi.fn().mockResolvedValue({ collections: [] }),
    createCollection: vi.fn().mockResolvedValue(undefined),
    getCollection: vi.fn().mockResolvedValue({
      config: { params: { vectors: { size: 768, distance: "Cosine" } } },
    }),
    deleteCollection: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    retrieve: vi.fn().mockResolvedValue([]),
  };
}

describe("QdrantStore", () => {
  let mockClient: QdrantClient;
  let store: QdrantStore;

  beforeEach(() => {
    mockClient = createMockClient();
    store = new QdrantStore(mockClient);
  });

  describe("ensureCollection", () => {
    it("creates collection if it does not exist", async () => {
      (mockClient.getCollections as any).mockResolvedValue({
        collections: [],
      });

      await store.ensureCollection("test-collection", 768);

      expect(mockClient.createCollection).toHaveBeenCalledWith(
        "test-collection",
        { vectors: { size: 768, distance: "Cosine" } }
      );
    });

    it("skips creation if collection already exists with matching dimensions", async () => {
      (mockClient.getCollections as any).mockResolvedValue({
        collections: [{ name: "test-collection" }],
      });
      (mockClient.getCollection as any).mockResolvedValue({
        config: { params: { vectors: { size: 768, distance: "Cosine" } } },
      });

      await store.ensureCollection("test-collection", 768);

      expect(mockClient.createCollection).not.toHaveBeenCalled();
      expect(mockClient.deleteCollection).not.toHaveBeenCalled();
    });

    it("recreates collection if dimensions mismatch", async () => {
      (mockClient.getCollections as any).mockResolvedValue({
        collections: [{ name: "test-collection" }],
      });
      (mockClient.getCollection as any).mockResolvedValue({
        config: { params: { vectors: { size: 768, distance: "Cosine" } } },
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await store.ensureCollection("test-collection", 3072);

      expect(mockClient.deleteCollection).toHaveBeenCalledWith("test-collection");
      expect(mockClient.createCollection).toHaveBeenCalledWith(
        "test-collection",
        { vectors: { size: 3072, distance: "Cosine" } }
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("existing=768 expected=3072")
      );

      warnSpy.mockRestore();
    });
  });

  describe("upsert", () => {
    it("upserts points with wait=true", async () => {
      const points = [
        {
          id: "point-1",
          vector: [0.1, 0.2, 0.3],
          payload: { repoId: 1 },
        },
        {
          id: "point-2",
          vector: [0.4, 0.5, 0.6],
          payload: { repoId: 2 },
        },
      ];

      await store.upsert("my-collection", points);

      expect(mockClient.upsert).toHaveBeenCalledWith("my-collection", {
        wait: true,
        points: [
          { id: toUUID("point-1"), vector: [0.1, 0.2, 0.3], payload: { repoId: 1 } },
          { id: toUUID("point-2"), vector: [0.4, 0.5, 0.6], payload: { repoId: 2 } },
        ],
      });
    });

    it("chunks large upserts into batches of UPSERT_BATCH_SIZE", async () => {
      // Create 600 points (exceeds UPSERT_BATCH_SIZE of 256)
      const points = Array.from({ length: 600 }, (_, i) => ({
        id: `point-${i}`,
        vector: [i * 0.1],
        payload: { repoId: 1 },
      }));

      await store.upsert("my-collection", points);

      // Should split into 3 batches: 256 + 256 + 88
      expect(mockClient.upsert).toHaveBeenCalledTimes(3);

      const calls = (mockClient.upsert as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][1].points).toHaveLength(256);
      expect(calls[1][1].points).toHaveLength(256);
      expect(calls[2][1].points).toHaveLength(88);

      // All calls should use the same collection and wait=true
      for (const call of calls) {
        expect(call[0]).toBe("my-collection");
        expect(call[1].wait).toBe(true);
      }
    });

    it("sends all points in a single call when under UPSERT_BATCH_SIZE", async () => {
      const points = Array.from({ length: 100 }, (_, i) => ({
        id: `point-${i}`,
        vector: [i * 0.1],
        payload: { repoId: 1 },
      }));

      await store.upsert("my-collection", points);

      expect(mockClient.upsert).toHaveBeenCalledTimes(1);
      expect((mockClient.upsert as ReturnType<typeof vi.fn>).mock.calls[0][1].points).toHaveLength(100);
    });

    it("handles empty points array without calling client", async () => {
      await store.upsert("my-collection", []);

      expect(mockClient.upsert).not.toHaveBeenCalled();
    });
  });

  describe("search", () => {
    it("returns search results with id, score, and payload", async () => {
      (mockClient.search as any).mockResolvedValue([
        { id: "point-1", score: 0.95, payload: { repoId: 1 } },
        { id: "point-2", score: 0.87, payload: { repoId: 2 } },
      ]);

      const results = await store.search(
        "my-collection",
        [0.1, 0.2, 0.3],
        { limit: 10 }
      );

      expect(results).toEqual([
        { id: "point-1", score: 0.95, payload: { repoId: 1 } },
        { id: "point-2", score: 0.87, payload: { repoId: 2 } },
      ]);

      expect(mockClient.search).toHaveBeenCalledWith("my-collection", {
        vector: [0.1, 0.2, 0.3],
        limit: 10,
        filter: undefined,
        with_payload: true,
      });
    });

    it("passes filter to the client", async () => {
      (mockClient.search as any).mockResolvedValue([]);
      const filter = { must: [{ key: "repoId", match: { value: 1 } }] };

      await store.search("my-collection", [0.1], { limit: 5, filter });

      expect(mockClient.search).toHaveBeenCalledWith("my-collection", {
        vector: [0.1],
        limit: 5,
        filter,
        with_payload: true,
      });
    });

    it("handles results with missing payload", async () => {
      (mockClient.search as any).mockResolvedValue([
        { id: "point-1", score: 0.9 },
      ]);

      const results = await store.search("my-collection", [0.1], {
        limit: 10,
      });

      expect(results[0].payload).toEqual({});
    });

    it("converts numeric IDs to strings", async () => {
      (mockClient.search as any).mockResolvedValue([
        { id: 42, score: 0.8, payload: {} },
      ]);

      const results = await store.search("my-collection", [0.1], {
        limit: 10,
      });

      expect(results[0].id).toBe("42");
    });
  });

  describe("deleteByFilter", () => {
    it("deletes with wait=true and provided filter", async () => {
      const filter = { must: [{ key: "repoId", match: { value: 1 } }] };

      await store.deleteByFilter("my-collection", filter);

      expect(mockClient.delete).toHaveBeenCalledWith("my-collection", {
        wait: true,
        filter,
      });
    });
  });

  describe("getVector", () => {
    it("returns vector when point exists", async () => {
      (mockClient.retrieve as any).mockResolvedValue([
        { id: "point-1", vector: [0.1, 0.2, 0.3] },
      ]);

      const vector = await store.getVector("my-collection", "point-1");

      expect(vector).toEqual([0.1, 0.2, 0.3]);
      expect(mockClient.retrieve).toHaveBeenCalledWith("my-collection", {
        ids: [toUUID("point-1")],
        with_vector: true,
      });
    });

    it("returns null when point does not exist", async () => {
      (mockClient.retrieve as any).mockResolvedValue([]);

      const vector = await store.getVector("my-collection", "nonexistent");

      expect(vector).toBeNull();
    });
  });
});
