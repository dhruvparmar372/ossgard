import { createHash } from "node:crypto";
import type {
  VectorStore,
  VectorPoint,
  SearchResult,
  SearchOptions,
} from "./vector-store.js";
import { log } from "../logger.js";

/** Convert an arbitrary string ID to a deterministic UUID (v4-format from MD5 hash). */
export function toUUID(id: string): string {
  const hex = createHash("md5").update(id).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** Minimal Qdrant client interface. The real @qdrant/js-client-rest is injected at runtime. */
export interface QdrantClient {
  getCollections(): Promise<{ collections: Array<{ name: string }> }>;
  createCollection(
    name: string,
    opts: {
      vectors: { size: number; distance: string };
    }
  ): Promise<void>;
  getCollection(
    name: string
  ): Promise<{
    config: { params: { vectors: { size: number; distance: string } } };
  }>;
  deleteCollection(name: string): Promise<void>;
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
  retrieve(
    collection: string,
    opts: { ids: (string | number)[]; with_vector: boolean }
  ): Promise<Array<{ id: string | number; vector?: number[] }>>;
}

const qdrantLog = log.child("qdrant");

/** Max points per Qdrant upsert call to stay under REST payload size limits. */
const UPSERT_BATCH_SIZE = 256;

export class QdrantStore implements VectorStore {
  private client: QdrantClient;

  constructor(client: QdrantClient) {
    this.client = client;
  }

  async ensureCollection(name: string, dimensions: number): Promise<void> {
    const { collections } = await this.client.getCollections();
    const exists = collections.some((c) => c.name === name);

    if (exists) {
      const info = await this.client.getCollection(name);
      const existingSize = info.config.params.vectors.size;
      if (existingSize !== dimensions) {
        qdrantLog.warn("Collection dimension mismatch, recreating", { collection: name, existing: existingSize, expected: dimensions });
        await this.client.deleteCollection(name);
        await this.client.createCollection(name, {
          vectors: { size: dimensions, distance: "Cosine" },
        });
      }
    } else {
      await this.client.createCollection(name, {
        vectors: { size: dimensions, distance: "Cosine" },
      });
    }
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    if (points.length === 0) return;

    qdrantLog.debug("Upsert", { collection, points: points.length });

    for (let i = 0; i < points.length; i += UPSERT_BATCH_SIZE) {
      const batch = points.slice(i, i + UPSERT_BATCH_SIZE);
      await this.client.upsert(collection, {
        wait: true,
        points: batch.map((p) => ({
          id: toUUID(p.id),
          vector: p.vector,
          payload: p.payload,
        })),
      });
    }
  }

  async search(
    collection: string,
    vector: number[],
    opts: SearchOptions
  ): Promise<SearchResult[]> {
    qdrantLog.debug("Search", { collection, limit: opts.limit });
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

  async getVector(collection: string, id: string): Promise<number[] | null> {
    const results = await this.client.retrieve(collection, {
      ids: [toUUID(id)],
      with_vector: true,
    });
    if (results.length === 0) return null;
    return results[0].vector ?? null;
  }
}
