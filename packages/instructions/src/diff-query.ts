/**
 * @gitgecko/instructions/diff-query — the diff-analysis query extractor (002c).
 *
 * Derives retrieval queries from a unified diff by extracting code-surface
 * signals: changed file paths + identifiers from added lines. This REPLACES
 * the prior title-only query (`context for: ${title}`) which rarely matched
 * indexed chunk content.
 *
 * Salvage-first (U4, E1): the diff-parsing shape is harvested from an earlier
 * orchestrator prototype (parseDiffForRules — file header + added-line
 * extraction). The query-construction philosophy is harvested from continue's
 * NoRerankerRetrievalPipeline (P-codeintel-9,
 * `.refs/02-repo-qa/continue-main/core/context/retrieval/pipelines/`):
 * derive the query from the code surface, not a human title.
 *
 * Deterministic v1 (no LLM query generation — that's the v2 graph-seeded
 * expansion, out of scope per the retrieve plug's open question at
 * `plugs/code-intel/retrieve/plug.ts:142-147`). Pure function, fully testable.
 */

/** Maximum queries returned (caps over-querying — 8 is enough signal). */
const MAX_QUERIES = 8;

/**
 * Language keywords filtered from identifier extraction. These carry no
 * retrieval signal — they're syntax, not domain identifiers. Keeping the
 * blocklist explicit (not a regex heuristic) so the filtering is auditable.
 */
const KEYWORD_BLOCKLIST = new Set([
  "const", "let", "var", "return", "function", "import", "export", "from",
  "default", "async", "await", "class", "interface", "type", "extends",
  "implements", "public", "private", "readonly", "static", "new", "if",
  "else", "for", "while", "switch", "case", "break", "continue", "throw",
  "try", "catch", "finally", "void", "null", "undefined", "true", "false",
  "this", "super", "yield", "enum", "namespace", "module", "declare",
  "abstract", "get", "set", "typeof", "instanceof", "in", "of", "delete",
  "do",
]);

/**
 * Extract retrieval queries from a unified diff. Queries are derived from the
 * code surface: changed file paths (from `+++ b/path` headers) and identifiers
 * from added (`+`) lines (function names, variable names, type names, dotted
 * member access). Keywords and short tokens are filtered; results are
 * deduplicated and capped at MAX_QUERIES.
 *
 * @param diff - a unified diff string
 * @returns an array of query strings (file paths + identifiers), ≤8 items.
 *   Returns [] for empty/no-signal diffs. Never throws.
 */
export const extractDiffQueries = (diff: string): readonly string[] => {
  if (!diff || diff.trim().length === 0) return [];

  const lines = diff.split("\n");
  const filePaths: string[] = [];
  const addedLines: string[] = [];

  for (const line of lines) {
    // File header: +++ b/path/to/file — harvest the path (strip b/ prefix).
    // Must check +++ before generic + to avoid misclassifying the header.
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      // Strip the b/ prefix (standard unified-diff convention). Also handle
      // /dev/null (deletion) — skip it.
      const path = raw.startsWith("b/") ? raw.slice(2) : raw === "/dev/null" ? null : raw;
      if (path && path.length > 0) {
        // Use just the basename for the query — the embed store indexes by
        // file, and a basename is a stronger retrieval signal than a full path
        // (less noise). But keep the full path too if it's short.
        filePaths.push(path);
      }
      continue;
    }
    // Added line (the code under review) — but not the +++ header.
    if (line.startsWith("+") && !line.startsWith("+++")) {
      addedLines.push(line.slice(1));
    }
  }

  // Deduplicate file paths and extract basenames.
  const uniquePaths = [...new Set(filePaths)];
  const queries: string[] = [];
  for (const p of uniquePaths) {
    // The full path is a query (matches chunk indexing by file).
    queries.push(p);
  }

  // Extract identifiers from added lines.
  const identifiers = new Set<string>();
  for (const line of addedLines) {
    // PascalCase / camelCase identifiers (≥3 chars): starts with a letter,
    // followed by 2+ alphanumerics. Catches ResolvedInstructions, createProvider.
    const camelMatch = line.match(/[a-zA-Z_$][a-zA-Z0-9_$]{2,}/g);
    if (camelMatch) {
      for (const token of camelMatch) {
        const lower = token.toLowerCase();
        if (KEYWORD_BLOCKLIST.has(lower)) continue;
        if (token.length < 3) continue;
        identifiers.add(token);
      }
    }
  }

  // Merge: file paths first (strongest signal), then identifiers sorted by
  // length DESCENDING — longer identifiers are more specific (higher retrieval
  // precision; they match fewer chunks). This prioritizes domain identifiers
  // (createProvider, setProvider) over generic tokens (api, models, opts).
  const sortedIds = [...identifiers].sort((a, b) => b.length - a.length);
  for (const id of sortedIds) {
    if (!queries.includes(id)) {
      queries.push(id);
    }
    if (queries.length >= MAX_QUERIES) break;
  }

  return queries.slice(0, MAX_QUERIES);
};
