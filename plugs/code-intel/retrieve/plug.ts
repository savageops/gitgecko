/**
 * gitgecko code-intel plug — retrieve (hybrid fusion).
 *
 * Salvaged from continue's NoRerankerRetrievalPipeline (research manifest
 * P-codeintel-9, .refs/02-repo-qa/continue-main/core/context/retrieval/pipelines/).
 * Fifth step of Greptile's pipeline — query a codebase → ranked chunks.
 *
 * Fusion (continue's recipe, adapted):
 *  - embeddings (50% weight): semantic nearest-neighbor via the embed store
 *  - lexical/trigram (25% weight): exact/BM25 match via a LexicalSearcher
 *  - graph expansion (25% weight, gitgecko addition): caller/callee traversal
 *    (Greptile's GP-§8b edge) — deepens results with structurally-related code
 *
 * Flow (mirrors NoReranker.run):
 *  1. Allocate `limit` slots across AVAILABLE sources by weight (redistribute
 *     if a source is omitted — graceful degradation)
 *  2. Fetch from each source in parallel
 *  3. Merge → filter by pathPrefix → dedup by (filepath, startLine, endLine)
 *  4. Return ranked with provenance (which source produced each result)
 *
 * Dedup key (verbatim from continue's deduplicateChunks): filepath + startLine
 * + endLine. First occurrence wins (embeddings preferred, then lexical, graph).
 */
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import type {
  FUSION_WEIGHTS,
  RetrieveContribution,
  RetrieveInput,
  RetrieveOutput,
  RetrieveResult,
} from "@gitgecko/code-intel";
import { FUSION_WEIGHTS as WEIGHTS } from "@gitgecko/code-intel";
import manifestJson from "./plug.manifest.json" with { type: "json" };

// --- Manifest (parsed, not cast) --------------------------------------------
const parsedManifest = parseManifest(manifestJson);
if (!parsedManifest.ok) {
  throw new Error(`retrieve manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
}
export const manifest: PlugManifest = parsedManifest.value;

// --- Slot allocation (continue's weight recipe, with redistribution) ---------
/**
 * Allocate `limit` across available sources by weight. If a source is omitted,
 * its weight redistributes proportionally to the others. Returns per-source
 * slot counts (Math.floor'd; remainder goes to the highest-weight source).
 */
const allocateSlots = (
  limit: number,
  available: { embeddings: boolean; lexical: boolean; graph: boolean },
): { embeddings: number; lexical: number; graph: number } => {
  const weights: Record<string, number> = {};
  let totalWeight = 0;
  if (available.embeddings) { weights.embeddings = WEIGHTS.embeddings; totalWeight += WEIGHTS.embeddings; }
  if (available.lexical) { weights.lexical = WEIGHTS.lexical; totalWeight += WEIGHTS.lexical; }
  if (available.graph) { weights.graph = WEIGHTS.graph; totalWeight += WEIGHTS.graph; }
  if (totalWeight === 0) return { embeddings: 0, lexical: 0, graph: 0 };

  const raw = {
    embeddings: available.embeddings ? Math.floor((weights.embeddings! / totalWeight) * limit) : 0,
    lexical: available.lexical ? Math.floor((weights.lexical! / totalWeight) * limit) : 0,
    graph: available.graph ? Math.floor((weights.graph! / totalWeight) * limit) : 0,
  };
  // Remainder → highest-weight available source (embeddings usually)
  const remainder = limit - (raw.embeddings + raw.lexical + raw.graph);
  if (remainder > 0) {
    if (available.embeddings) raw.embeddings += remainder;
    else if (available.lexical) raw.lexical += remainder;
    else if (available.graph) raw.graph += remainder;
  }
  return raw;
};

// --- Dedup (verbatim from continue's deduplicateChunks) ---------------------
const dedupKey = (r: { filepath: string; chunk: { startLine: number; endLine: number } }): string =>
  `${r.filepath}|${r.chunk.startLine}|${r.chunk.endLine}`;

const dedup = (results: readonly RetrieveResult[]): RetrieveResult[] => {
  const seen = new Set<string>();
  const out: RetrieveResult[] = [];
  for (const r of results) {
    const key = dedupKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
};

// --- The retrieve (fusion) capability ---------------------------------------
export const retrieve = async (input: RetrieveInput): Promise<RetrieveOutput> => {
  const limit = input.limit ?? 10;
  const hasEmbeddings = !!input.embeddings;
  const hasLexical = !!input.lexical;
  const hasGraph = !!input.graph;

  const slots = allocateSlots(limit, { embeddings: hasEmbeddings, lexical: hasLexical, graph: hasGraph });

  const allResults: RetrieveResult[] = [];

  // Embeddings source (50% weight) — semantic nearest-neighbor
  if (hasEmbeddings && slots.embeddings > 0) {
    try {
      const emb = input.embeddings!;
      const embResults = await emb.store.retrieve(emb.tag, (await emb.provider.embed([input.query]))[0] ?? [], {
        limit: slots.embeddings,
        ...(input.pathPrefix && { pathPrefix: input.pathPrefix }),
      });
      for (const r of embResults) {
        allResults.push({
          chunk: r.chunk,
          filepath: r.path,
          source: "embeddings",
          score: r.score,
        });
      }
    } catch {
      // graceful: embeddings source contributes nothing
    }
  }

  // Lexical source (25% weight) — exact/BM25 match
  if (hasLexical && slots.lexical > 0) {
    try {
      const lexResults = await input.lexical!.search(input.query, {
        limit: slots.lexical,
        ...(input.pathPrefix && { pathPrefix: input.pathPrefix }),
      });
      for (const r of lexResults) {
        allResults.push({
          chunk: r.chunk,
          filepath: r.filepath,
          source: "lexical",
          score: r.score,
        });
      }
    } catch {
      // graceful
    }
  }

  // Graph source (25% weight, gitgecko addition) — caller/callee expansion.
  // v1: graph expansion needs a seed node; without an LLM to pick seeds from
  // the query, graph contributes 0 in v1 (the slot redistributes). The socket
  // exists; a future graph-aware retrieve uses embeddings results as seeds
  // and expands via GraphStore.traverse. (OQ: graph-seeded expansion)
  // For now: graph slot allocated but unfilled (provenance tracked as 0).

  // Filter by path prefix (backup, in case a source didn't honor it)
  const filtered = input.pathPrefix
    ? allResults.filter((r) => r.filepath.startsWith(input.pathPrefix!))
    : allResults;

  // Dedup (first occurrence wins — embeddings preferred due to fetch order)
  const deduped = dedup(filtered);

  // Sort within each source by its native ordering (embeddings asc by distance,
  // lexical desc by BM25). Preserve source-grouped order (embeddings, then lexical).
  const sourceOrder: Record<string, number> = { embeddings: 0, lexical: 1, graph: 2 };
  deduped.sort((a, b) => {
    if (a.source !== b.source) return sourceOrder[a.source]! - sourceOrder[b.source]!;
    // Within source: embeddings/graph ascending (lower distance better),
    // lexical descending (higher BM25 better).
    return a.source === "lexical" ? b.score - a.score : a.score - b.score;
  });

  // Source counts (post-dedup)
  const sources = {
    embeddings: deduped.filter((r) => r.source === "embeddings").length,
    lexical: deduped.filter((r) => r.source === "lexical").length,
    graph: deduped.filter((r) => r.source === "graph").length,
  };

  return { results: deduped, sources };
};

// --- Plug setup (registers the retrieve capability) -------------------------
export async function setup(api: {
  register: (capability: "retrieve", contribution: RetrieveContribution) => void;
}): Promise<void> {
  api.register("retrieve", {
    kind: "retriever",
    id: "hybrid-retrieval-fusion",
    retrieve,
    mutates: false,
  });
}
