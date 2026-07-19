/**
 * @gitgecko/instructions/corpus — the routed, tiered rules corpus (Phase 6.2, T1).
 *
 * THE DIFFERENTIATOR (Finding 06): gitgecko's rules model is the tree (corpus
 * engine), not just the leaf (finding evaluator). This module replaces the flat
 * concat in resolve.ts with semantic keyword routing + tiered load by blast
 * radius — the wedge CR-§8 (glob-only NL) and GP-§10 wp2 (NL-only) lack.
 *
 * Salvage provenance (G11): the tier model + keyword→module map originate with
 * the gitgecko operating contract (the user's ~/.codex/AGENTS.d/index.md — the
 * Tier 1/2/3-by-blast-radius table + the keyword→module routing map). That file
 * IS the reference implementation of the exact product feature gitgecko ships.
 * Re-implemented here, not copied (the source is the user's own prior work,
 * adapted to the review-corpus context). Cited as the corpus-router provenance
 * in .docs/todo/findings/06-directives-and-instruction-templates.md.
 *
 * Routing logic:
 *  1. Normative rules are ALWAYS loaded (they're invariants — non-negotiable).
 *  2. Advisory rules are loaded only when their loadWhen keywords match the
 *     diff/PR's extracted keywords (semantic routing, richer than glob).
 *  3. Both are filtered by blast tier: a Tier-1 PR (typo/readme) loads fewer
 *     rules than a Tier-3 PR (auth/billing/schema change).
 */
import { PROPRIETARY_RULES, type ProprietaryRule, type BlastTier } from "./rules-corpus.js";

/** The keywords extracted from a diff/PR for routing. */
export type Keywords = readonly string[];

/**
 * Resolve the active rule set for a review.
 *
 * @param keywords - extracted from the diff/PR (file paths, identifiers, terms).
 *   Empty = no advisory rules loaded (only normative invariants).
 * @param blastTier - the PR's blast radius: 1=trivial (typo/readme),
 *   2=multi-file (standard PR), 3=architectural (schema/auth/billing/infra).
 *   Higher tiers load more advisory rules.
 * @returns the rules whose loadWhen matches + all normative rules at-or-below tier.
 */
export const resolveCorpus = (
  keywords: Keywords,
  blastTier: BlastTier = 2,
): readonly ProprietaryRule[] => {
  const lowerKeywords = new Set(keywords.map((k) => k.toLowerCase()));

  return PROPRIETARY_RULES.filter((rule) => {
    // Normative rules are ALWAYS loaded (invariants — non-negotiable), regardless
    // of blast tier. A Tier-1 PR still gets the least-privilege / shell:true /
    // deterministic-first checks — these are architectural invariants, not
    // optional domain rules. (The test: "normative rules are ALWAYS loaded".)
    if (rule.status === "normative") return true;

    // Tier filter: an advisory rule only loads if its tier ≤ the PR's blast tier.
    // A Tier-1 PR (typo) doesn't load Tier-3 advisory rules (auth/billing).
    if (rule.tier > blastTier) return false;

    // Advisory rules load only on keyword match (semantic routing).
    if (rule.status === "advisory") {
      if (lowerKeywords.size === 0) return false;
      return rule.loadWhen.some((kw) => lowerKeywords.has(kw.toLowerCase()));
    }

    return false;
  });
};

/**
 * Extract keywords from a diff for routing. Pulls from:
 *  - file paths (e.g. "src/auth/session.ts" → auth, session, src)
 *  - identifiers in added lines (e.g. "createSession" → session, create)
 *  - known trigger terms (security, billing, schema, migration)
 *
 * This is the semantic-routing signal — richer than CR-§8's path globs.
 */
export const extractKeywords = (diff: string): Keywords => {
  if (!diff || diff.trim().length === 0) return [];
  const keywords = new Set<string>();

  for (const line of diff.split("\n")) {
    // File paths from diff headers: +++ b/src/auth/session.ts
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      const filepath = line.slice(4).replace(/^[ab]\//, "").trim();
      const parts = filepath.split(/[\/.]/);
      for (const part of parts) {
        const lower = part.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (lower.length >= 3 && !STOP_WORDS.has(lower)) keywords.add(lower);
      }
    }
    // Added lines: extract camelCase/snake_case identifiers
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const identifiers = line.match(/[a-z][a-zA-Z0-9]*|[a-z][a-z0-9_]*/g) ?? [];
      for (const id of identifiers) {
        const lower = id.toLowerCase();
        if (lower.length >= 4 && !STOP_WORDS.has(lower)) keywords.add(lower);
        // Also split camelCase: createSession → create, session
        const parts = id.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/\s+/);
        for (const part of parts) {
          if (part.length >= 4 && !STOP_WORDS.has(part)) keywords.add(part);
        }
      }
    }
  }

  return [...keywords];
};

/** Common words to exclude from keyword extraction (noise reduction). */
const STOP_WORDS = new Set([
  "the", "and", "for", "not", "you", "all", "can", "had", "her", "was", "one",
  "our", "out", "are", "but", "has", "have", "this", "that", "with", "from",
  "they", "will", "would", "there", "their", "what", "about", "which", "when",
  "make", "like", "into", "time", "some", "them", "than", "then", "been",
  "want", "more", "very", "just", "also", "only", "your", "were", "being",
  "const", "return", "function", "import", "export", "default", "class",
  "void", "null", "true", "false", "await", "async", "type", "interface",
  "readonly", "public", "private", "static",
]);

/**
 * Compute the quality band of a review = the minimum band of all fired
 * normative rules. Higher = more rigorous. This is the "review rigor" metric
 * neither competitor publishes (Finding 06 §4.4).
 */
export const reviewQualityBand = (rules: readonly ProprietaryRule[]): number => {
  const normative = rules.filter((r) => r.status === "normative");
  if (normative.length === 0) return 0;
  return Math.min(...normative.map((r) => r.qualityBand));
};
