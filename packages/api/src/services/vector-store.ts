export interface VectorPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface SearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export interface SearchOptions {
  limit: number;
  filter?: Record<string, unknown>;
}

export interface VectorStore {
  ensureCollection(name: string, dimensions: number): Promise<void>;
  upsert(collection: string, points: VectorPoint[]): Promise<void>;
  search(
    collection: string,
    vector: number[],
    opts: SearchOptions
  ): Promise<SearchResult[]>;
  deleteByFilter(
    collection: string,
    filter: Record<string, unknown>
  ): Promise<void>;
  getVector(collection: string, id: string): Promise<number[] | null>;
}
