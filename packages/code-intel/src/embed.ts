/**
 * @gitgecko/code-intel/embed — the embed capability contract.
 *
 * Salvaged from continue's LanceDbIndex (research manifest P-codeintel-10,
 * .refs/02-repo-qa/continue-main/core/indexing/LanceDbIndex.ts). Embeds chunks
 * via a pluggable EmbeddingProvider (BYO model — G5), stores vectors + content
 * in a dual store (LanceDB vectors + SQLite content, joined by UUID in prod;
 * in-memory for tests), retrieves by nearest-neighbor cosine similarity.
 *
 * This is the fourth step of Greptile's pipeline — produces the vector index
 * the retrieve-fuse plug (P-codeintel-9) queries. The embeddings pillar.
 *
 * Split (mirrors continue + the GraphStore pattern):
 *  - EmbeddingProvider: the model plug (OpenAI/nomic/transformers.js — BYO).
 *  - EmbedStore: storage backend (LanceDB+SQLite prod, in-memory tests).
 *  - embed(): batch chunks → vectors → store; retrieve() → nearest-neighbor.
 */
import type { Chunk } from "./chunk.js";

/** A pluggable embedding model (BYO — G5). OpenAI/nomic/transformers.js impls. */
export interface EmbeddingProvider {
  readonly id: string;
  /** Embedding dimensionality (all vectors from this provider share it). */
  readonly dimensions: number;
  /** Embed a batch of texts → vectors. Order preserved. */
  readonly embed: (texts: readonly string[]) => Promise<readonly number[][]>;
}

/** A row in the vector store (mirrors continue's LanceDbRow, P-codeintel-10). */
export interface EmbedRow {
  readonly uuid: string;
  readonly path: string;
  readonly cacheKey: string;
  readonly vector: readonly number[];
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** A retrieval result: a chunk + its distance score (lower = nearer). */
export interface EmbedSearchResult {
  readonly chunk: Chunk;
  readonly path: string;
  readonly score: number; // cosine distance (0 = identical)
}

/** Index tag = the (repo, branch, embeddingId) isolation key (continue's IndexTag). */
export interface EmbedTag {
  readonly repo: string;
  readonly branch: string;
  readonly embeddingId: string;
}

/** Input: chunks to embed + store, under a tag. */
export interface EmbedInput {
  readonly tag: EmbedTag;
  readonly chunks: ReadonlyArray<Chunk & { readonly filepath: string }>;
  readonly provider: EmbeddingProvider;
  readonly store: EmbedStore;
}

/** Output: how many embedded + stored. */
export interface EmbedOutput {
  readonly embedded: number;
  readonly stored: number;
}

/** Input for single-source embeddings retrieval: a query → nearest chunks. */
export interface EmbedRetrieveInput {
  readonly tag: EmbedTag;
  readonly query: string;
  readonly provider: EmbeddingProvider;
  readonly store: EmbedStore;
  readonly limit?: number;
  /** Optional path-prefix filter (continue's `where("path LIKE 'dir%'")`). */
  readonly pathPrefix?: string;
}

/**
 * Storage backend interface. LanceDB+SQLite in prod (P-codeintel-10);
 * in-memory for tests. Tag-isolated (one table per repo/branch/embeddingId).
 */
export interface EmbedStore {
  /** Upsert rows (idempotent by uuid — re-indexing is safe). */
  upsert(tag: EmbedTag, rows: readonly EmbedRow[]): Promise<void>;
  /** Retrieve nearest neighbors to a vector. */
  retrieve(tag: EmbedTag, vector: readonly number[], opts: { limit: number; pathPrefix?: string }): Promise<readonly EmbedSearchResult[]>;
  /** Clear a tag's rows (full re-index path). */
  clear(tag: EmbedTag): Promise<void>;
  /** Row count for a tag (for assertions). */
  count(tag: EmbedTag): Promise<number>;
}

/** The contribution shape the embed plug registers (embed capability). */
export interface EmbedContribution {
  readonly kind: "embedder";
  readonly id: string;
  readonly embed: (input: EmbedInput) => Promise<EmbedOutput>;
  readonly retrieve: (input: EmbedRetrieveInput) => Promise<readonly EmbedSearchResult[]>;
  readonly mutates?: boolean;
}
