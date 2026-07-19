/**
 * @gitgecko/code-intel/owner — the code-intel owner declaration.
 *
 * Implements the `code-intel` owner from 02-architecture-overview.md §2.
 * The owner declares its capability enum (04 §2) and the contribution kind
 * each capability accepts. Plugs (tree-sitter-parse, graph-build, embed, etc.)
 * register against this owner via the socket (03-plugin-socket-contract).
 *
 * Capabilities (trimmed 2026-07-08 to match reality — capability-truth):
 *   REAL plugs (5): parse, graph, chunk, embed, retrieve
 *   NEAR-TERM (2, salvage-backed): search-lexical (P-codeintel-5/7), summarize (GP-§8a)
 *   v2 WEDGE (1): graph-temporal (W12, graphiti — deferred per 08 OQ4.4 scope)
 *
 * The rules-structural/lexical/llm capabilities were REMOVED from this owner:
 * they belong to the `rules` owner (which declares capability "evaluate",
 * finding.ts:89). Rules-evaluators registers against the rules owner, NOT
 * code-intel. Declaring them here was dead enumeration — no plug would ever
 * register against them. The "11 plugs" comment in 04 §2 is aspirational;
 * this enum describes what's real + committed-near-term, not a wishlist.
 */
import type { OwnerSpec } from "@gitgecko/socket";
import type { ParsedFile } from "./tags.js";

/** The code-intel owner's capability enum. */
export type CodeIntelCapability =
  | "parse"
  | "graph"
  | "summarize"
  | "chunk"
  | "embed"
  | "search-lexical"
  | "retrieve"
  | "graph-temporal";

/** Contribution kind for the `parse` capability: a parser callable. */
export interface ParseContribution {
  readonly kind: "parser";
  readonly id: string;
  /** Languages this parser handles (lowercase, e.g. "python", "javascript"). */
  readonly languages: readonly string[];
  /**
   * Parse source code into def/ref tags. The capability contract.
   * Returns a ParsedFile (tags may be empty for a file with no symbols).
   */
  readonly parse: (input: ParseInput) => Promise<ParsedFile>;
  readonly mutates?: boolean;
}

export interface ParseInput {
  /** Source code as a UTF-8 string. */
  readonly source: string;
  /** Path relative to repo root (used for language detection + tag relPath). */
  readonly relPath: string;
  /** Language override; if omitted, inferred from relPath extension. */
  readonly language?: string;
}

/**
 * The owner spec. Capabilities are EXCLUSIVE for engines (one active parser,
 * graph builder, embedder, etc. — avoids duplicate work). There are no
 * non-exclusive capabilities in code-intel now that rules-* belong to the
 * `rules` owner. The exclusive predicate encodes this.
 */
export const codeIntelOwner: OwnerSpec<CodeIntelCapability, "parser" | string> = {
  name: "code-intel",
  capabilities: [
    "parse", "graph", "chunk", "embed", "retrieve",
    "search-lexical", "summarize", "graph-temporal",
  ],
  // All code-intel capabilities are exclusive (one active engine each).
  // The rules-* non-exclusion lived on the rules owner, not here.
  exclusive: () => true,
  // Wired capabilities declare their kinds; others fall back to a default.
  kindFor: (cap) =>
    cap === "parse"
      ? "parser"
      : cap === "graph"
        ? "graph-builder"
        : cap === "chunk"
          ? "chunker"
          : cap === "embed"
            ? "embedder"
            : cap === "retrieve"
              ? "retriever"
              : cap === "search-lexical"
                ? "lexical-index"
                : cap === "summarize"
                  ? "summarizer"
                  : cap === "graph-temporal"
                    ? "temporal-graph"
                    : `code-intel-${cap}`,
};
