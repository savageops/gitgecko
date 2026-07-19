/**
 * @gitgecko/instructions/glossary — the made-whole citation index.
 *
 * Every citation ID that appears in a shipped instruction string is resolvable
 * here. When a review finding is tagged `[W5]` or `[NG8]`, the user (or the
 * CLI `explain` command, or the web UI tooltip) looks the tag up in this
 * glossary and gets a self-contained definition — no `.docs/` path, no
 * `AGENTS.d/` pointer, no internal reference the user's repo does not have.
 *
 * This is the productization pivot: the corpus is self-contained. The
 * proprietary knowledge ships; the internal provenance does not dangle.
 *
 * Each definition names the competitor weakness where one exists — that IS the
 * secret sauce. The user sees not just what the rule is, but why gitgecko's
 * approach is better than the alternative the rule refuses.
 */

/** A single glossary entry: a stable citation ID and its self-contained meaning. */
export interface GlossaryEntry {
  /** The stable citation ID as it appears in finding tags (e.g. "W5", "NG8"). */
  readonly id: string;
  /** A short coined handle (e.g. "the blast-radius gate"). */
  readonly term: string;
  /**
   * One self-contained sentence. Names the mechanism, the consequence, and —
   * where relevant — the competitor weakness the rule exists to refuse.
   * No internal paths. No "see .docs/...". Stands alone.
   */
  readonly definition: string;
}

/**
 * The citation glossary. Covers every ID referenced anywhere in the shipped
 * instruction strings (persona, guardrails, rules-corpus, output-format,
 * command-tasks). The completeness test in instructions.test.ts asserts that
 * every ID used in the corpus has an entry here.
 */
export const CITATION_GLOSSARY: readonly GlossaryEntry[] = [
  // --- Wedges (W1–W14): gitgecko's competitive advantages ---
  {
    id: "W3",
    term: "traceability",
    definition: "Every review step — model, prompt, retrieved context, rule eval, cost — is recorded in a queryable trace. Opacity is the competitor weakness we refuse: a review you cannot audit is a review whose quality you cannot verify.",
  },
  {
    id: "W4",
    term: "deterministic-first",
    definition: "Deterministic rules (ast-grep structural, regex lexical) run before the LLM lane and are authoritative. This is the wedge CodeRabbit and Greptile lack — their rules are natural-language-only, so precision depends on the model.",
  },
  {
    id: "W4/W10",
    term: "deterministic-first + noise elimination",
    definition: "Deterministic findings are authoritative and run first to eliminate noise (W10). Do not reword, soften, or omit them — the deterministic lane is precise and reproducible where the LLM lane is probabilistic.",
  },
  {
    id: "W5",
    term: "the blast-radius gate",
    definition: "`shell:true` combined with untrusted input is arbitrary code execution — the blast radius is the whole machine. Flag it as error; a weak allowlist that checks only the first token is defeated by `npm; rm -rf /`.",
  },
  {
    id: "W7",
    term: "the open-graph wedge",
    definition: "A review that cites retrieved repo context proves the retrieval works. Grounding findings in actual code (not assumed code) is the anti-hallucination wedge — a finding that names the consequence AND the retrieved path is a finding you can trust.",
  },
  {
    id: "W10",
    term: "noise elimination",
    definition: "Style nits — formatting, naming, JSDoc, prefer-const — flood reviews without catching bugs (the Greptile existential pain). Only flag style if it introduces a defect. A finding that does not improve correctness is noise.",
  },

  // --- Non-goals (NG1–NG8): the scope fences ---
  {
    id: "NG5",
    term: "no NL-only rules",
    definition: "Rules must be deterministic first; natural-language rules are secondary. An architecture that makes rules NL-only is the competitor weakness we exist to fix — CodeRabbit is glob-only NL, Greptile is NL-only.",
  },
  {
    id: "NG7",
    term: "least-privilege default",
    definition: "Least-privilege is the default; write scope is explicit opt-in. A privilege granted by default fires on every request, including the hostile one. Flag any scope expansion as a warning.",
  },
  {
    id: "NG8",
    term: "salvage-first",
    definition: "Never rewrite from scratch; salvage existing code and connect the pieces. A rewrite throws away the battle-testing the original accumulated. Prefer behavior-preserving refactors with tests.",
  },

  // --- Salvaged provenance (P-*): where a component was lifted from ---
  {
    id: "P-plugin-3",
    term: "the agent adapter",
    definition: "Every agent backend (native, local, cloud) implements the same adapter contract so the review loop is provider-agnostic. Salvaged from the pi-harness agent runtime pattern.",
  },
  {
    id: "P-plugin-7",
    term: "the derived mutates gate",
    definition: "The mutates deny-list is DERIVED from `mutates===true` tools — never hand-maintained. If mutating tools exist but the deny-list is empty, the code MUST throw: an empty deny-list is a gate silently disabled.",
  },
  {
    id: "P-plugin-11",
    term: "the command taxonomy",
    definition: "The /describe /review /improve /ask /resolve taxonomy (CodeRabbit-compatible). Each command maps to a distinct output shape; the orchestrator dispatches by name.",
  },
  {
    id: "P-codeintel-9",
    term: "code-intelligence salvage",
    definition: "A salvaged code-intelligence component (parse, graph-build, retrieve, or embed) cited from an upstream open-source project. The P-codeintel-N ID is the provenance audit trail — it lets the next reader trace where the logic came from.",
  },

  // --- Invariants (INV-N): structural laws the architecture preserves ---
  {
    id: "INV-2.3",
    term: "the two-plug interchangeability invariant",
    definition: "Every socket owner needs at least two proving plugs. A single-plug owner is a socket shaped around one plug — the contract is unproven, and the second plug will not fit. Two plugs prove interchangeability.",
  },

  // --- Drift refusals (D1–D10): the anti-patterns we refuse by name ---
  {
    id: "D8",
    term: "no forced keys",
    definition: "Refuse 'just require API keys / cloud.' gitgecko supports local and zero-config; a forced key requirement is the UX wedge we exist to remove. Native agents use the device's installed binary — no keys needed.",
  },
  {
    id: "D9",
    term: "no homegrown client",
    definition: "Refuse 'write our own LLM client.' We wrap pi-ai, because a homegrown client re-implements what pi-ai already does (retries, streaming, provider quirks) and diverges over time.",
  },
  {
    id: "D8/D9",
    term: "the anti-drift pair",
    definition: "D8 (no forced keys) and D9 (no homegrown client) together: suggestions that introduce drift — requiring cloud, or rebuilding what pi-ai provides — violate the core design principles of zero-config local-first execution.",
  },

  // --- Corpus meta-rules (G8–G11): rules about the rules ---
  {
    id: "G8",
    term: "traceability rule",
    definition: "Every review step is recorded in a queryable TraceRecord. Flag any review path that bypasses trace recording — an unauditable review is a review whose quality cannot be verified or improved.",
  },
  {
    id: "G9",
    term: "the dialect rule",
    definition: "The review obeys the dialect: name the consequence not the symptom, do not speculate, no motivational filler, coin the concept, ship the why. This is the discipline that makes a review legible to a local model and elite on a frontier model.",
  },
  {
    id: "G10",
    term: "coin-the-term rule",
    definition: "If a diff reaches for the same abstraction three or more times without naming it, flag it: the concept needs a coined term reused everywhere as a stable handle. A concept without a name is a concept a local model forgets.",
  },
  {
    id: "G11",
    term: "provenance rule",
    definition: "Salvaged code cites its source (P-* ID); a competitor-derived pattern cites CR-§N or GP-§N. A salvage without a citation is an orphan — unattributed knowledge drifts. Provenance is the audit trail (W3).",
  },
  {
    id: "G12",
    term: "the register rule",
    definition: "Claim the capability, not the task; use transferable capability vocabulary, not literal-action verbs; upgrade to corporate-register language. Origin: gitgecko, wyrmcast.com / svg.wiki. Do not downgrade precision into vagueness; vivid defect-naming stays load-bearing.",
  },

  // --- Competitor evidence (CR-§N, GP-§N): the reverse-engineering anchors ---
  {
    id: "CR-§1.2",
    term: "CodeRabbit command taxonomy",
    definition: "CodeRabbit's /describe /review /improve /ask /resolve slash-command structure — the taxonomy gitgecko's command system is compatible with, so users familiar with CodeRabbit onboard instantly.",
  },
  {
    id: "CR-§8",
    term: "CodeRabbit NL-only rules",
    definition: "CodeRabbit's rules are natural-language-only with glob routing — no deterministic structural lane, no semantic keyword routing. This is the precision weakness gitgecko's deterministic-first (W4) corpus routing exists to fix.",
  },
  {
    id: "GP-§8",
    term: "Greptile style-noise problem",
    definition: "Greptile's review surface floods with style nits (formatting, naming, JSDoc) that do not catch bugs — the existential pain that drives users away. gitgecko's noise elimination (W10) suppresses exactly these.",
  },
  {
    id: "GP-§10",
    term: "Greptile NL-only rules",
    definition: "Greptile's rule engine is natural-language-only with no deterministic lane — precision depends entirely on the model. gitgecko runs deterministic rules first (W4/W10) so precision does not depend on model quality.",
  },
  {
    id: "G13",
    term: "hosted model provider rule",
    definition: "The GitGecko hosted models (gitgecko-light, gitgecko-high) are rebranded partner models. Provider credentials are env-configured placeholders, never hardcoded. The model aliases are the user-facing names; the partner brand is internal.",
  },
];

/** The set of citation IDs the glossary covers, for fast membership checks. */
const GLOSSARY_IDS: ReadonlySet<string> = new Set(CITATION_GLOSSARY.map((e) => e.id));

/** Look up a glossary entry by its citation ID. Returns undefined if unknown. */
export const glossaryFor = (id: string): GlossaryEntry | undefined =>
  CITATION_GLOSSARY.find((e) => e.id === id);

/**
 * Resolve a citation ID to its coined term, falling back to the raw id.
 * Use this for inline rendering where an unknown tag should degrade gracefully
 * (e.g. `[${glossaryTerm("W5")}]` → `[the blast-radius gate]`).
 */
export const glossaryTerm = (id: string): string => glossaryFor(id)?.term ?? id;

/** Whether a citation ID has a glossary entry. */
export const hasGlossaryEntry = (id: string): boolean => GLOSSARY_IDS.has(id);
