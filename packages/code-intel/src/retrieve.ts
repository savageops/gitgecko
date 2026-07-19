/**
 * @gitgecko/code-intel/retrieve — the hybrid retrieval fusion contract.
 *
 * Salvaged from continue's NoRerankerRetrievalPipeline (research manifest
 * P-codeintel-9, .refs/02-repo-qa/continue-main/core/context/retrieval/pipelines/).
 * Fuses three signal sources into one ranked, deduplicated result set:
 *   - embeddings (semantic, 50% weight) — via the embed plug's retrieve()
 *   - lexical/trigram (exact-match, 25% weight) — via a LexicalSearcher
 *     (the search-lexical capability plugs in: Zoekt or SQLite-FTS5)
 *   - graph expansion (gitgecko addition Greptile has, GP-§8b) — caller/callee
 *     traversal of the code graph (optional; deepens results)
 *
 * Fifth step of Greptile's pipeline — the point where gitgecko becomes a
 * USABLE Greptile competitor: query a codebase → ranked relevant chunks.
 */
import type { Chunk } from "./chunk.js";
import type { EmbeddingProvider, EmbedSearchResult, EmbedStore, EmbedTag } from "./embed.js";
import type { GraphStore } from "./graph-build.js";

/** A result from any retrieval source, carrying provenance for the fusion. */
export interface RetrieveResult {
  readonly chunk: Chunk;
  readonly filepath: string;
  /** Which source produced this result. */
  readonly source: "embeddings" | "lexical" | "graph";
  /** Source-specific score (lower = better for embeddings/graph; higher for lexical BM25). */
  readonly score: number;
}

/**
 * Lexical/trigram searcher interface. The search-lexical capability plugs in
 * (Zoekt prod, SQLite-FTS5 default, in-memory for tests). Returns BM25-ranked
 * chunks — the 25% weight contributor per continue's fusion.
 */
export interface LexicalSearcher {
  readonly search: (query: string, opts: { limit: number; pathPrefix?: string }) => Promise<readonly LexicalResult[]>;
}

export interface LexicalResult {
  readonly chunk: Chunk;
  readonly filepath: string;
  readonly score: number; // BM25 (higher = better)
}

/** Input to the retrieve (fusion) capability. */
export interface RetrieveInput {
  readonly query: string;
  /** Total results desired (default 10). Allocated across sources by weight. */
  readonly limit?: number;
  /** Optional directory filter (continue's filterDirectory). */
  readonly pathPrefix?: string;
  /** The embeddings pillar (50% weight). Omit to skip embeddings source. */
  readonly embeddings?: {
    readonly tag: EmbedTag;
    readonly provider: EmbeddingProvider;
    readonly store: EmbedStore;
  };
  /** The lexical pillar (25% weight). Omit to skip lexical source. */
  readonly lexical?: LexicalSearcher;
  /** The graph pillar (expansion; optional). Omit to skip graph expansion. */
  readonly graph?: GraphStore;
}

/** Output: fused, deduplicated, ranked results. */
export interface RetrieveOutput {
  readonly results: readonly RetrieveResult[];
  readonly sources: {
    readonly embeddings: number;
    readonly lexical: number;
    readonly graph: number;
  };
}

/** Fusion weights (continue's NoReranker recipe, P-codeintel-9). */
export const FUSION_WEIGHTS = {
  embeddings: 0.5,
  lexical: 0.25,
  graph: 0.25, // gitgecko: recency slot becomes graph expansion (Greptile's edge)
} as const;

/** The contribution shape the retrieve plug registers. */
export interface RetrieveContribution {
  readonly kind: "retriever";
  readonly id: string;
  readonly retrieve: (input: RetrieveInput) => Promise<RetrieveOutput>;
  readonly mutates?: boolean;
}
