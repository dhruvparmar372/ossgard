import type {
  VectorStore,
  VectorPoint,
  SearchResult,
  SearchOptions,
} from "./vector-store.js";

/** Minimal Qdrant client interface. The real @qdrant/js-client-rest is injected at runtime. */
export interface QdrantClient {
  getCollections(): Promise<{ collections: Array<{ name: string }> }>;
  createCollection(
    name: string,
    opts: {
      vectors: { size: number; distance: string };
    }
  ): Promise<void>;
  upsert(
    collection: string,
    opts: {
      wait: boolean;
      points: Array<{
        id: string;
        vector: number[];
        payload: Record<string, unknown>;
      }>;
    }
  ): Promise<void>;
  search(
    collection: string,
    opts: {
      vector: number[];
      limit: number;
      filter?: Record<string, unknown>;
      with_payload: boolean;
    }
  ): Promise<
    Array<{
      id: string | number;
      score: number;
      payload?: Record<string, unknown>;
    }>
  >;
  delete(
    collection: string,
    opts: {
      wait: boolean;
      filter: Record<string, unknown>;
    }
  ): Promise<void>;
}

export class QdrantStore implements VectorStore {
  private client: QdrantClient;

  constructor(client: QdrantClient) {
    this.client = client;
  }

  async ensureCollection(name: string, dimensions: number): Promise<void> {
    const { collections } = await this.client.getCollections();
    const exists = collections.some((c) => c.name === name);

    if (!exists) {
      await this.client.createCollection(name, {
        vectors: { size: dimensions, distance: "Cosine" },
      });
    }
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    await this.client.upsert(collection, {
      wait: true,
      points: points.map((p) => ({
        id: p.id,
        vector: p.vector,
        payload: p.payload,
      })),
    });
  }

  async search(
    collection: string,
    vector: number[],
    opts: SearchOptions
  ): Promise<SearchResult[]> {
    const results = await this.client.search(collection, {
      vector,
      limit: opts.limit,
      filter: opts.filter,
      with_payload: true,
    });

    return results.map((r) => ({
      id: String(r.id),
      score: r.score,
      payload: r.payload ?? {},
    }));
  }

  async deleteByFilter(
    collection: string,
    filter: Record<string, unknown>
  ): Promise<void> {
    await this.client.delete(collection, {
      wait: true,
      filter,
    });
  }
}
