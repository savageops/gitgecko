/**
 * gitgecko code-intel plug — embed.
 *
 * Salvaged from continue's LanceDbIndex (research manifest P-codeintel-10,
 * .refs/02-repo-qa/continue-main/core/indexing/LanceDbIndex.ts). Fourth step
 * of Greptile's pipeline — the embeddings pillar.
 *
 * Flow (mirrors continue):
 *  1. embed(): batch all chunk contents through the EmbeddingProvider → vectors
 *  2. build EmbedRows (uuid = deterministic hash of tag+path+cacheKey+content)
 *  3. upsert into the EmbedStore (idempotent by uuid — re-index safe)
 *  4. retrieve(): embed the query → cosine nearest-neighbor over stored vectors
 *     → hydrate top-N chunks
 *
 * Storage-agnostic via the EmbedStore interface. The in-memory impl is here
 * (for tests + small/self-hosted); LanceDB+SQLite is the prod backend (plugs
 * in via the same interface — continue's dual-store pattern, P-codeintel-10).
 *
 * Provider-agnostic (G5 BYO model): the EmbeddingProvider is passed per call.
 * OpenAI/nomic/transformers.js impls register under the `model` owner.
 */
import { randomUUID } from "node:crypto";
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import type {
  Chunk,
  EmbedContribution,
  EmbedInput,
  EmbedOutput,
  EmbedRow,
  EmbedSearchResult,
  EmbedStore,
  EmbedTag,
  EmbedRetrieveInput,
} from "@gitgecko/code-intel";
import manifestJson from "./plug.manifest.json" with { type: "json" };

// --- Manifest (parsed, not cast) --------------------------------------------
const parsedManifest = parseManifest(manifestJson);
if (!parsedManifest.ok) {
  throw new Error(`embed manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
}
export const manifest: PlugManifest = parsedManifest.value;

// --- Deterministic UUID for idempotent upsert (re-index safe) ---------------
// continue uses random UUIDs; we derive from tag+path+content so re-embedding
// the same input upserts the same row (no duplication). This is an gitgecko
// improvement over continue (their re-index path deletes-then-inserts).
const rowUuid = (tag: EmbedTag, filepath: string, content: string): string => {
  // Simple deterministic hash (not crypto-grade; sufficient for dedup keys).
  const key = `${tag.repo}|${tag.branch}|${tag.embeddingId}|${filepath}|${content.length}|${content.slice(0, 32)}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
  }
  return `row-${(h >>> 0).toString(16)}-${content.length}`;
};

// --- The embed capability ---------------------------------------------------

/**
 * Batch-embed chunks + store. Mirrors continue's computeRows + addComputedLanceDbRows.
 * Returns counts. Idempotent (uuid-keyed upsert).
 */
export const embed = async (input: EmbedInput): Promise<EmbedOutput> => {
  if (input.chunks.length === 0) return { embedded: 0, stored: 0 };

  const contents = input.chunks.map((c) => c.content);
  const vectors = await input.provider.embed(contents);

  // Drop any chunks that failed to embed (continue's undefined-filtering)
  const rows: EmbedRow[] = [];
  for (let i = 0; i < input.chunks.length; i++) {
    const chunk = input.chunks[i]!;
    const vec = vectors[i];
    if (!vec) continue; // provider returned undefined for this one
    rows.push({
      uuid: rowUuid(input.tag, chunk.filepath, chunk.content),
      path: chunk.filepath,
      cacheKey: `${chunk.startLine}-${chunk.endLine}`,
      vector: vec,
      content: chunk.content,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
    });
  }

  await input.store.upsert(input.tag, rows);
  return { embedded: vectors.length, stored: rows.length };
};

/**
 * Retrieve nearest chunks for a natural-language query. Mirrors continue's
 * _retrieveForTag: embed query → search → hydrate.
 */
export const retrieve = async (input: EmbedRetrieveInput): Promise<readonly EmbedSearchResult[]> => {
  const queryVec = (await input.provider.embed([input.query]))[0];
  if (!queryVec) return [];
  return input.store.retrieve(input.tag, queryVec, {
    limit: input.limit ?? 10,
    ...(input.pathPrefix && { pathPrefix: input.pathPrefix }),
  });
};

// --- Plug setup (registers the embed capability) ----------------------------
export async function setup(api: {
  register: (capability: "embed", contribution: EmbedContribution) => void;
}): Promise<void> {
  api.register("embed", {
    kind: "embedder",
    id: "embed-indexer",
    embed,
    retrieve,
    mutates: false,
  });
}

// --- InMemoryEmbedStore: the test/small-deployment backend ------------------
// LanceDB+SQLite is the prod backend (P-codeintel-10 dual-store); this in-memory
// impl proves the logic without a native dep. Tag-isolated (per continue's
// tableNameForTag), cosine-distance nearest-neighbor.
export class InMemoryEmbedStore implements EmbedStore {
  private readonly tables = new Map<string, Map<string, EmbedRow>>();

  private table(tag: EmbedTag): Map<string, EmbedRow> {
    const key = `${tag.repo}|${tag.branch}|${tag.embeddingId}`;
    let t = this.tables.get(key);
    if (!t) {
      t = new Map();
      this.tables.set(key, t);
    }
    return t;
  }

  async upsert(tag: EmbedTag, rows: readonly EmbedRow[]): Promise<void> {
    const t = this.table(tag);
    for (const row of rows) t.set(row.uuid, row);
  }

  async retrieve(
    tag: EmbedTag,
    vector: readonly number[],
    opts: { limit: number; pathPrefix?: string },
  ): Promise<readonly EmbedSearchResult[]> {
    const t = this.table(tag);
    const scored: EmbedSearchResult[] = [];
    for (const row of t.values()) {
      if (opts.pathPrefix && !row.path.startsWith(opts.pathPrefix)) continue;
      const dist = cosineDistance(vector, row.vector);
      scored.push({
        chunk: {
          content: row.content,
          startLine: row.startLine,
          endLine: row.endLine,
        },
        path: row.path,
        score: dist,
      });
    }
    scored.sort((a, b) => a.score - b.score); // nearest first
    return scored.slice(0, opts.limit);
  }

  async clear(tag: EmbedTag): Promise<void> {
    const key = `${tag.repo}|${tag.branch}|${tag.embeddingId}`;
    this.tables.delete(key);
  }

  async count(tag: EmbedTag): Promise<number> {
    return this.table(tag).size;
  }
}

/** Cosine distance = 1 - cosine similarity. 0 = identical, 2 = opposite. */
const cosineDistance = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 2; // treat zero-vector as maximally distant
  return 1 - dot / denom;
};
