/**
 * @gitgecko/code-intel/search-lexical — trigram/BM25 lexical search (P-codeintel-7).
 *
 * Salvaged from continue's FullTextSearchCodebaseIndex (P-codeintel-7): FTS5
 * with tokenize='trigram' + BM25 ranking + pathWeightMultiplier (10x for path
 * matches). gitgecko's v1 is a pure-TS in-memory implementation (no native
 * SQLite dependency) so it works everywhere + is fully testable.
 *
 * Implements the LexicalSearcher interface from retrieve.ts — the lexical
 * pillar of the hybrid retrieval fusion (25% weight per P-codeintel-9).
 *
 * Phase 2.2 (2026-07-08): promoted into a plug (plugs/code-intel/trigram-memory/)
 * with manifest + setup() registering the `search-lexical` capability.
 */
import type { Contribution } from "@gitgecko/socket";
import type { Chunk } from "./chunk.js";

/** A document in the lexical index. */
export interface LexicalDoc {
  readonly filepath: string;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** A search result (matches LexicalResult from retrieve.ts). */
export interface LexicalSearchResult {
  readonly content: string;
  readonly filepath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly score: number; // BM25 (higher = better)
}

/**
 * Extract trigrams (3-char substrings) from text, lowercase.
 * Mirrors continue's `tokenize='trigram'` (P-codeintel-7).
 */
const extractTrigrams = (text: string): readonly string[] => {
  const lower = text.toLowerCase();
  if (lower.length < 3) return [];
  const trigrams: string[] = [];
  for (let i = 0; i <= lower.length - 3; i++) {
    trigrams.push(lower.slice(i, i + 3));
  }
  return trigrams;
};

/**
 * Extract query trigrams (from a natural-language or code query).
 * Mirrors continue's `getCleanedTrigrams` (P-codeintel-7): stem → trigrams.
 */
const extractQueryTrigrams = (query: string): readonly string[] => {
  // Simple: just lowercase + trigram the whole query (continue also stems + dedupes).
  const lower = query.toLowerCase().trim();
  const trigrams = extractTrigrams(lower);
  // Dedupe (set of words, per continue's setOfWords)
  return [...new Set(trigrams)];
};

/** BM25 scoring (P-codeintel-7's ranking algorithm). */
const bm25Score = (
  docTrigramCount: number,
  queryTrigramsInDoc: number,
  docLength: number,
  avgDocLength: number,
  docFreq: number, // how many docs contain the trigram
  totalDocs: number,
): number => {
  const k1 = 1.5;
  const b = 0.75;
  const idf = Math.log(1 + (totalDocs - docFreq + 0.5) / (docFreq + 0.5));
  const tf = queryTrigramsInDoc / (queryTrigramsInDoc + k1 * (1 - b + b * (docLength / avgDocLength)));
  return idf * tf;
};

/**
 * In-memory trigram lexical index. Index documents → search by query.
 * Path-weight multiplier (10x) per continue's pathWeightMultiplier (P-codeintel-7).
 */
export class InMemoryLexicalIndex {
  private docs: LexicalDoc[] = [];
  private docTrigrams: Map<string, readonly string[]>[] = [];
  private avgDocLength = 0;

  /** Index documents (add to the corpus). */
  index(docs: readonly LexicalDoc[]): void {
    this.docs = [...this.docs, ...docs];
    this.docTrigrams = this.docs.map((d) => {
      const m = new Map<string, readonly string[]>();
      // Index BOTH filepath + content (continue's FTS5 indexes path + content as FTS columns)
      m.set(d.filepath, [...extractTrigrams(d.filepath), ...extractTrigrams(d.content)]);
      return m;
    });
    this.avgDocLength = this.docs.length > 0
      ? this.docs.reduce((sum, d) => sum + extractTrigrams(d.content).length, 0) / this.docs.length
      : 0;
  }

  /** Clear the index. */
  clear(): void {
    this.docs = [];
    this.docTrigrams = [];
    this.avgDocLength = 0;
  }

  /**
   * Search the index. Returns BM25-ranked results.
   * Path matches get 10x weight (continue's pathWeightMultiplier).
   */
  search(query: string, opts: { limit?: number; pathPrefix?: string } = {}): readonly LexicalSearchResult[] {
    if (this.docs.length === 0) return [];
    const queryTrigrams = extractQueryTrigrams(query);
    if (queryTrigrams.length === 0) return [];

    const limit = opts.limit ?? 10;
    const results: LexicalSearchResult[] = [];

    for (let i = 0; i < this.docs.length; i++) {
      const doc = this.docs[i]!;
      if (opts.pathPrefix && !doc.filepath.startsWith(opts.pathPrefix)) continue;

      const docTrigs = this.docTrigrams[i]!.get(doc.filepath)!;
      const docTrigSet = new Set(docTrigs);

      // Count matching trigrams
      let matchingCount = 0;
      for (const qt of queryTrigrams) {
        if (docTrigSet.has(qt)) matchingCount++;
      }
      if (matchingCount === 0) continue;

      // BM25 score (simplified: docFreq = 1 for each trigram, since we don't track per-trigram)
      const docLength = docTrigs.length;
      const score = bm25Score(matchingCount, matchingCount, docLength, this.avgDocLength, 1, this.docs.length);

      // Path boost: if the query appears in the filepath, 10x weight
      const pathBoost = doc.filepath.toLowerCase().includes(query.toLowerCase().slice(0, Math.min(query.length, 10)))
        ? 10.0 : 1.0;

      results.push({
        content: doc.content,
        filepath: doc.filepath,
        startLine: doc.startLine,
        endLine: doc.endLine,
        score: score * pathBoost,
      });
    }

    // Sort by score descending (BM25: higher = better)
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}

// --- Contribution shape for the search-lexical plug (Phase 2.2) -------------

/** Input to the search-lexical capability: index docs + search. */
export interface LexicalIndexInput {
  readonly query: string;
  readonly limit: number;
  readonly pathPrefix?: string;
}

/** A search result from the lexical index (mirrors LexicalResult from retrieve.ts). */
export interface LexicalIndexResult {
  readonly chunk: Chunk;
  readonly filepath: string;
  readonly score: number;
}

/** The contribution shape the trigram/lexical plug registers. */
export interface LexicalContribution extends Contribution {
  readonly kind: "lexical-index";
  readonly id: string;
  /** Index documents into the lexical store (BM25 corpus). */
  readonly index: (docs: readonly LexicalDoc[]) => void;
  /** Clear the corpus before a replacement reindex. */
  readonly clear: () => void;
  /** Search the index — BM25-ranked results. */
  readonly search: (query: string, opts: { limit: number; pathPrefix?: string }) => Promise<readonly LexicalIndexResult[]>;
  readonly mutates?: boolean;
}
