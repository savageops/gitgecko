/**
 * @gitgecko/code-intel/chunk — the chunk capability contract.
 *
 * Salvaged from continue's smart-collapse chunker (research manifest P-codeintel-8,
 * .refs/02-repo-qa/continue-main/core/indexing/chunk/code.ts). AST-aware chunking
 * that recursively walks the tree-sitter AST and emits nested/collapsed chunks
 * respecting a token budget, with class-context injection for methods.
 *
 * This is the third step of Greptile's pipeline — produces the units the
 * embeddings pillar (P-codeintel-10) embeds. Better than naive line-splitting
 * because chunks respect symbol boundaries + retain ownership context.
 */
import type { ParsedFile } from "./tags.js";

/** A chunk of code. Mirrors continue's ChunkWithoutID (P-codeintel-8). */
export interface Chunk {
  /** The chunk's source text (possibly collapsed: method bodies → "{ ... }"). */
  readonly content: string;
  /** 0-based start line (matches continue's convention). */
  readonly startLine: number;
  /** 0-based end line. */
  readonly endLine: number;
  /** Optional symbol signature (for the embeddings metadata). */
  readonly signature?: string;
  /** Other metadata (language, node type, etc.). */
  readonly otherMetadata?: Readonly<Record<string, unknown>>;
}

/** Input to the chunk capability. */
export interface ChunkInput {
  /** Source code as a UTF-8 string. */
  readonly source: string;
  /** Path relative to repo root (language detection + chunk filepath). */
  readonly relPath: string;
  /** Language override; if omitted, inferred from relPath extension. */
  readonly language?: string;
  /** Max tokens per chunk (default 500). Chunks over budget are collapsed/split. */
  readonly maxChunkSize?: number;
}

/** Output: the chunks for one file. */
export interface ChunkOutput {
  readonly relPath: string;
  readonly language: string;
  readonly chunks: readonly Chunk[];
}

/** The contribution shape the chunk plug registers (chunk capability). */
export interface ChunkContribution {
  readonly kind: "chunker";
  readonly id: string;
  /** Chunk a file's source into budget-respecting, AST-aware chunks. */
  readonly chunk: (input: ChunkInput) => Promise<ChunkOutput>;
  readonly mutates?: boolean;
}

/** Re-export ParsedFile so consumers can import from one place. */
export type { ParsedFile };
