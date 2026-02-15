import { describe, it, expect, vi, beforeEach } from "vitest";
import { QdrantStore, type QdrantClient } from "./qdrant-store.js";

function createMockClient(): QdrantClient {
  return {
    getCollections: vi.fn().mockResolvedValue({ collections: [] }),
    createCollection: vi.fn().mockResolvedValue(undefined),
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
      vi.mocked(mockClient.getCollections).mockResolvedValue({
        collections: [],
      });

      await store.ensureCollection("test-collection", 768);

      expect(mockClient.createCollection).toHaveBeenCalledWith(
        "test-collection",
        { vectors: { size: 768, distance: "Cosine" } }
      );
    });

    it("skips creation if collection already exists", async () => {
      vi.mocked(mockClient.getCollections).mockResolvedValue({
        collections: [{ name: "test-collection" }],
      });

      await store.ensureCollection("test-collection", 768);

      expect(mockClient.createCollection).not.toHaveBeenCalled();
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
          { id: "point-1", vector: [0.1, 0.2, 0.3], payload: { repoId: 1 } },
          { id: "point-2", vector: [0.4, 0.5, 0.6], payload: { repoId: 2 } },
        ],
      });
    });
  });

  describe("search", () => {
    it("returns search results with id, score, and payload", async () => {
      vi.mocked(mockClient.search).mockResolvedValue([
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
      vi.mocked(mockClient.search).mockResolvedValue([]);
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
      vi.mocked(mockClient.search).mockResolvedValue([
        { id: "point-1", score: 0.9 },
      ]);

      const results = await store.search("my-collection", [0.1], {
        limit: 10,
      });

      expect(results[0].payload).toEqual({});
    });

    it("converts numeric IDs to strings", async () => {
      vi.mocked(mockClient.search).mockResolvedValue([
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
      vi.mocked(mockClient.retrieve).mockResolvedValue([
        { id: "point-1", vector: [0.1, 0.2, 0.3] },
      ]);

      const vector = await store.getVector("my-collection", "point-1");

      expect(vector).toEqual([0.1, 0.2, 0.3]);
      expect(mockClient.retrieve).toHaveBeenCalledWith("my-collection", {
        ids: ["point-1"],
        with_vector: true,
      });
    });

    it("returns null when point does not exist", async () => {
      vi.mocked(mockClient.retrieve).mockResolvedValue([]);

      const vector = await store.getVector("my-collection", "nonexistent");

      expect(vector).toBeNull();
    });
  });
});
