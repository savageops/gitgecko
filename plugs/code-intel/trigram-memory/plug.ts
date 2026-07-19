/**
 * gitgecko code-intel plug — trigram-memory (lexical search pillar).
 *
 * Salvaged from continue's FullTextSearchCodebaseIndex (P-codeintel-7): FTS5
 * with tokenize='trigram' + BM25 ranking + pathWeightMultiplier (10x for path
 * matches). gitgecko's v1 is a pure-TS in-memory implementation (no native
 * SQLite dependency) so it works everywhere + is fully testable.
 *
 * This is the lexical pillar of the hybrid retrieval fusion (25% weight per
 * P-codeintel-9). The retrieve plug consumes it via the LexicalSearcher
 * interface. Phase 2.2 (2026-07-08): promoted from a library class
 * (InMemoryLexicalIndex) into a socket-bound plug with manifest + setup().
 */
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import {
  InMemoryLexicalIndex,
  type LexicalContribution,
  type LexicalDoc,
  type LexicalIndexResult,
} from "@gitgecko/code-intel";
import manifestJson from "./plug.manifest.json" with { type: "json" };

// --- Manifest (parsed, not cast) --------------------------------------------
const parsedManifest = parseManifest(manifestJson);
if (!parsedManifest.ok) {
  throw new Error(`trigram-memory manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
}
export const manifest: PlugManifest = parsedManifest.value;

// --- The search-lexical capability ------------------------------------------
// Wraps InMemoryLexicalIndex into the LexicalContribution shape the socket
// expects. The index() method adds docs to the BM25 corpus; search() returns
// ranked results adapted to the LexicalIndexResult shape (chunk-wrapped).

/** Create the lexical contribution from an InMemoryLexicalIndex instance. */
export const createLexicalContribution = (index: InMemoryLexicalIndex): LexicalContribution => {
  return {
    kind: "lexical-index",
    id: "trigram-memory-index",
    index: (docs: readonly LexicalDoc[]): void => {
      index.index(docs);
    },
    clear: (): void => index.clear(),
    search: async (
      query: string,
      opts: { limit: number; pathPrefix?: string },
    ): Promise<readonly LexicalIndexResult[]> => {
      const results = index.search(query, opts);
      // Adapt LexicalSearchResult (flat) → LexicalIndexResult (chunk-wrapped).
      return results.map((r) => ({
        chunk: {
          content: r.content,
          startLine: r.startLine,
          endLine: r.endLine,
        },
        filepath: r.filepath,
        score: r.score,
      }));
    },
    mutates: false,
  };
};

// --- Plug setup (registers the search-lexical capability) -------------------
export async function setup(api: {
  register: (capability: "search-lexical", contribution: LexicalContribution) => void;
}): Promise<void> {
  // Each plug instance gets its own InMemoryLexicalIndex (fresh corpus).
  const index = new InMemoryLexicalIndex();
  api.register("search-lexical", createLexicalContribution(index));
}
