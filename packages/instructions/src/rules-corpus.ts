/**
 * @gitgecko/instructions/rules-corpus — the proprietary rules.
 *
 * Encodes gitgecko's architecture expertise as cite-able review rules. Every
 * rule cites a stable ID (W/NG/P/INV) per the 00-INDEX citation conventions,
 * so findings are auditable (invariant I3). These are NL instructions the
 * reviewer follows — NOT the deterministic ast-grep rules (those live in the
 * rules owner and run first per W4/W10).
 *
 * Phase 6.2 (T1): each rule now carries frontmatter (loadWhen, status,
 * qualityBand, ruleType, enforcement, tier) so the corpus router can do
 * semantic keyword routing + tiered load by blast radius — the wedge CR-§8
 * (glob-only NL) and GP-§10 wp2 (NL-only) lack.
 *
 * Sourced from .docs/todo/system-design/{01,03,07}.md + goal/0016_*.md (D1-D9)
 * + AGENTS.d/01-dialect.md (the G9 dialect rule). NOT copied from AGPL kodus
 * — re-implemented from our own docs.
 */

/** The blast-radius tier (AGENTS.d model: Tier 1/2/3 by scope). */
export type BlastTier = 1 | 2 | 3;

export interface ProprietaryRule {
  /** The stable citation ID (W4, NG8, P-plugin-7, INV-2.3, D8, etc.). */
  readonly id: string;
  /** One-line summary. */
  readonly summary: string;
  /** The instruction the reviewer follows. */
  readonly instruction: string;
  // --- Phase 6.2 frontmatter (corpus router) ---
  /** Keywords that trigger this rule (semantic routing, richer than glob). */
  readonly loadWhen: readonly string[];
  /** Status: normative (always loaded), advisory (on keyword match). */
  readonly status: "normative" | "advisory";
  /** Quality band (0-100) — the review's rigor = min of fired normative rules. */
  readonly qualityBand: number;
  /** The blast-radius tier: 1=trivial, 2=multi-file, 3=architectural/auth/billing. */
  readonly tier: BlastTier;
}

/**
 * The proprietary rules corpus. Each cites a stable architecture ID.
 * A reviewer receiving these knows the project's invariants — a diff violating
 * any of them gets flagged with the citation.
 */
export const PROPRIETARY_RULES: readonly ProprietaryRule[] = [
  {
    id: "W4/W10",
    summary: "Deterministic rules are authoritative and run first",
    instruction:
      "The deterministic lane runs first. Its findings (ast-grep/regex) are authoritative — do not reword, soften, or omit them. The why: a deterministic rule is precise and reproducible, and running it before the LLM lane eliminates the noise and hallucination the LLM would otherwise produce on cases the deterministic lane already nailed (W10). If deterministic findings exist, they are the source of truth.",
    loadWhen: ["rules", "deterministic", "ast-grep", "regex", "finding", "noise", "hallucination"],
    status: "normative",
    qualityBand: 95,
    tier: 2,
  },
  {
    id: "NG5",
    summary: "NL-only rules are forbidden; deterministic comes first",
    instruction:
      "Rules must be deterministic (ast-grep structural or regex lexical) first; natural-language rules are secondary and tagged source:llm. An architecture that makes rules NL-only is the competitor weakness we exist to fix — CodeRabbit is glob-only NL (CR-§8), Greptile is NL-only (GP-§10 wp2). Flag it (NG5).",
    loadWhen: ["rules", "nl", "natural-language", "path-instructions", "coderabbit"],
    status: "advisory",
    qualityBand: 85,
    tier: 3,
  },
  {
    id: "NG7",
    summary: "Least-privilege by default; write scope is opt-in",
    instruction:
      "Least-privilege is the default. Write scope is explicit opt-in (NG7, W5). Flag any scope expansion as a warning: new write permissions, broad filesystem access, elevated GitHub App scopes, or command execution with untrusted input. The why: a privilege granted by default is a privilege that fires on every request, including the hostile one.",
    loadWhen: ["permission", "scope", "write", "filesystem", "github-app", "token", "auth", "security"],
    status: "normative",
    qualityBand: 90,
    tier: 3,
  },
  {
    id: "NG8",
    summary: "Salvage-first; never rewrite from scratch",
    instruction:
      "Never rewrite from scratch. salvage existing code and connect the pieces (NG8, goal A3). A 'rewrite this from scratch' or 'delete and redo' suggestion is drift — it throws away the battle-testing the original accumulated. Flag it. Prefer behavior-preserving refactors with tests.",
    loadWhen: ["rewrite", "refactor", "salvage", "delete", "redo", "from-scratch"],
    status: "advisory",
    qualityBand: 80,
    tier: 2,
  },
  {
    id: "P-plugin-7",
    summary: "The mutates gate is derived, never hand-maintained, throws if empty",
    instruction:
      "The mutates deny-list is DERIVED from the mutates===true tools — never hand-maintained. If mutatesTools is true but the deny-list is empty, the code MUST throw. The why: an empty deny-list on a mutating tool is the 'gate silently disabled' trap — a gate configured to protect whose protection has been emptied without anyone noticing. A throw makes the absence loud. Flag any hand-maintained deny-list or a missing throw-if-empty (P-plugin-7).",
    loadWhen: ["mutates", "deny-list", "gate", "tool", "permission", "security"],
    status: "normative",
    qualityBand: 92,
    tier: 3,
  },
  {
    id: "INV-2.3",
    summary: "Every owner needs ≥2 proving plugs (interchangeability)",
    instruction:
      "Every socket owner must have at least 2 proving plugs. The why: a single-plug owner is a socket shaped around one plug — the socket contract is unproven, and the second plug will not fit. Two plugs prove the socket is real and plugs are interchangeable. Flag a single-plug owner (INV-2.3).",
    loadWhen: ["socket", "plug", "owner", "interchangeable", "provider", "registry"],
    status: "advisory",
    qualityBand: 75,
    tier: 3,
  },
  {
    id: "W5",
    summary: "Blast radius: shell + untrusted input = arbitrary execution",
    instruction:
      "shell:true combined with allowing bash/sh, or any command construction from untrusted (PR) input, defeats allowlists entirely. The why: 'npm; rm -rf /' bypasses the first-token check, and the blast radius is the whole machine. Flag as error: this is arbitrary code execution (W5).",
    loadWhen: ["shell", "bash", "exec", "command", "untrusted", "injection", "security"],
    status: "normative",
    qualityBand: 98,
    tier: 3,
  },
  {
    id: "D8/D9",
    summary: "Anti-drift: no 'just require API keys', no 'write our own client'",
    instruction:
      "Flag suggestions that introduce drift. 'Just require API keys/cloud' (D8) is drift — we support local and zero-config, and a forced key requirement is the wedge we exist to remove. 'Write our own LLM client' (D9) is drift — we wrap pi-ai, because a homegrown client re-implements what pi-ai already does and diverges over time. Both violate the project's core design principles.",
    loadWhen: ["api-key", "cloud", "client", "http", "drift", "pi-ai", "model"],
    status: "advisory",
    qualityBand: 82,
    tier: 2,
  },
  {
    id: "G8",
    summary: "Traceability: every review step is auditable",
    instruction:
      "Every review step — model, prompt, retrieved context, tool calls, rule evals, cost — is recorded in a queryable TraceRecord. The why: opacity is the competitor weakness we fix; an unauditable review is a review whose quality cannot be verified or improved. Flag any review path that bypasses trace recording (W3, G8).",
    loadWhen: ["trace", "audit", "opacity", "model", "prompt", "cost", "logging"],
    status: "advisory",
    qualityBand: 78,
    tier: 2,
  },
  {
    id: "G9",
    summary: "The dialect: consequence not symptom, no thumb-sucking, no filler",
    instruction:
      "The review obeys the dialect. Name the consequence, not just the symptom — a symptom without its impact is incomplete. Do not speculate; trace the execution path or stay silent. No motivational filler, no praise, no cheerful throat-clearing — the register is matter-of-fact. Coin the concept, name the anti-pattern, ship the why. This is the discipline that makes a review legible to a local model and elite on a larger one (G9).",
    loadWhen: ["dialect", "tone", "clarity", "noise", "prose", "consequence", "symptom", "filler"],
    status: "normative",
    qualityBand: 80,
    tier: 1,
  },
  {
    id: "G10",
    summary: "Coin the load-bearing term: flag recurring unnamed abstractions",
    instruction:
      "Name recurring abstractions. If a diff reaches for the same abstraction three or more times without naming it, flag it: the concept needs a coined term that is then reused everywhere as a stable handle. The why: a concept without a name is a concept a local model forgets, and a reader has to reconstruct from scratch on every encounter. An unnamed recurring abstraction is friction taxed on every future reader. Name it once, reuse the coin. Do NOT flag single-use helpers or genuinely unique locals — only recurrence (G10).",
    loadWhen: ["abstraction", "name", "concept", "pattern", "naming", "helper", "repeated", "recurrence"],
    status: "advisory",
    qualityBand: 78,
    tier: 2,
  },
  {
    id: "G11",
    summary: "Provenance is a hard rule: cite P-*/CR-§N/GP-§N on every salvage",
    instruction:
      "Provenance is a hard rule. Salvaged code cites its source with a P-plugin-N / P-codeintel-N / P-frontend-N ID. A competitor-derived pattern cites CR-§N or GP-§N. A salvage without a citation is an orphan — nobody can verify where it came from or whether it is still the best available pattern, and the next reader cannot trace the decision. The why: provenance is the audit trail (W3); unattributed knowledge drifts. Flag salvaged code with no P-* tag, or a competitor claim with no CR-§N/GP-§N anchor (G11).",
    loadWhen: ["salvage", "harvest", "provenance", "citation", "copy", "adapt", "port", "reference", "refs"],
    status: "normative",
    qualityBand: 85,
    tier: 2,
  },
  {
    id: "G12",
    summary: "The register: claim the capability, not the task",
    instruction:
      "Every emitted surface — findings, comments, commits, docs, public APIs, log messages — obeys the register discipline (origin: gitgecko, wyrmcast.com / svg.wiki). Three moves. (1) Claim the capability, not the task: name the outcome the reader can act on, not the action performed — 'Enabled secure authentication', not 'I wrote a login script'. (2) Use transferable capability vocabulary, not literal-action verbs: 'Engineered production capability', not 'I did X'; strip job-title fluff that carries no signal. (3) Upgrade to corporate-register language — the vocabulary managers, experts, and systems pattern-match against: 'store floor and stock management', not 'shelf packer'. The why: a task-literal or job-title-literal phrase carries no signal a reader can generalize; capability-register language survives the surface it was written for and compounds across the codebase. Do NOT downgrade precision into vagueness — 'AVX2 vpshufb' must not become 'advanced SIMD'. Vivid defect-naming stays load-bearing ('parity defect wearing the costume of completion'). Flag comments, findings, or docs that undersell capability or bury it in job-title or task-literal language (G12).",
    loadWhen: ["register", "vocabulary", "naming", "tone", "comment", "doc", "capability", "wording", "dialect"],
    status: "normative",
    qualityBand: 80,
    tier: 1,
  },
  {
    id: "G13",
    summary: "Hosted models: provider placeholders, never hardcode credentials",
    instruction:
      "The GitGecko hosted model offering (gitgecko-light for Free, gitgecko-high for Pro+) uses rebranded partner models. Published source exposes GITGECKO_CLOUD_MODEL_* provider slots, never a partner credential, URL, or private model name. Public model IDs are gitgecko-light and gitgecko-high. Flag hardcoded provider credentials, URLs, private model IDs, or partner branding in user-facing strings. The provider route supports anthropic, completions, and responses formats through the model socket (G13).",
    loadWhen: ["provider", "hosted", "gitgecko-light", "gitgecko-high", "model", "api-key", "credential", "cloud", "partner", "resell", "rebrand"],
    status: "normative",
    qualityBand: 90,
    tier: 3,
  },
];

/** Look up a rule by its citation ID. */
export const ruleById = (id: string): ProprietaryRule | undefined =>
  PROPRIETARY_RULES.find((r) => r.id === id);
