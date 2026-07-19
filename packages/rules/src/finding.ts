/**
 * @gitgecko/rules/finding — the rule + finding data contracts.
 *
 * Salvaged from ast-grep's rule schema (research manifest P-codeintel-11,
 * .refs/04-code-analysis/ast-grep-main/crates/napi/types/rule.d.ts) +
 * CodeRabbit's path_instructions (CR-§8). Three rule kinds, one finding shape.
 *
 * THE WEDGE: deterministic rules (structural + regex) produce zero-hallucination,
 * zero-noise findings — neither CodeRabbit (CR-§8 NL-only) nor Greptile
 * (GP-§10 wp2 NL-only) has this. Every finding carries a `source` tag so users
 * see WHY it fired (the rule id + matched span) — the auditability wedge.
 */
import type { OwnerSpec } from "@gitgecko/socket";

/** The three rule kinds. Deterministic first, LLM second (04 §8). */
export type RuleKind = "structural" | "lexical" | "llm";

/**
 * The directive-kind taxonomy (Phase 6.1 — Finding 06, AGENTS.d model).
 * Orthogonal to RuleKind: the kind-of-directive describes WHAT the rule is
 * (an anti-pattern, an evidence-gate, a capability-invariant), while RuleKind
 * describes HOW it's evaluated (structural/lexical/llm). This is the more
 * product-relevant axis — users group "anti-pattern findings" vs "evidence-gate
 * failures" in the UI, not "structural vs lexical."
 */
export type DirectiveKind =
  | "process"
  | "evidence-gate"
  | "anti-pattern"
  | "capability-invariant"
  | "definition-of-done"
  | "voice"
  | "pattern";

/**
 * The 4-level enforcement stack (from 00-core.md:104-112, AGENTS.d model).
 * - invariant: non-negotiable, always enforced (like the mutates gate).
 * - owner: the owning module enforces it (capability-truth).
 * - proof: requires runtime proof (evidence-gate).
 * - preference: a style/convention tip (the `tip` severity tier).
 */
export type Enforcement = "invariant" | "owner" | "proof" | "preference";

/**
 * The status of a rule (AGENTS.d frontmatter contract).
 * - normative: enforced in production reviews.
 * - advisory: surfaced but doesn't block.
 * - draft: staged but not yet active.
 */
export type RuleStatus = "normative" | "advisory" | "draft";

/**
 * Severity (ast-grep's enum, P-codeintel-11). hint and tip are DISTINCT tiers:
 *  - hint  = a gentle nudge / non-actionable awareness (context, no action).
 *  - tip   = an actionable recommendation (what would be better — apply to improve).
 * They are NOT aliases; severity.ts renders each under its own label/emoji so two
 * findings never collapse into one rendering group.
 */
export type Severity = "hint" | "info" | "tip" | "warning" | "error" | "off";

/** Provenance: deterministic rules never hallucinate; LLM rules might. */
export type FindingSource = "deterministic" | "llm";

/**
 * Evidence class on a finding (from 80-communication-output.md:26, AGENTS.d).
 * How well-evidenced the finding is — surfaced in the UI so users see the
 * difference between a verified deterministic hit and an inferred LLM guess.
 */
export type EvidenceClass = "verified" | "documented" | "referenced" | "inferred" | "unverified";

/**
 * A rule. The structural kind uses ast-grep's rule shape verbatim (pattern|
 * kind|regex|inside|has|all|any|not). The lexical kind uses a JS regex. The
 * llm kind is a natural-language instruction (CodeRabbit path_instructions).
 *
 * Phase 6.1 frontmatter fields (all optional, backward-compat): status, loadWhen,
 * dependsOn, qualityBand, ruleType, enforcement. These make rules self-describing
 * artifacts a corpus router can introspect (Finding 06 — the AGENTS.d model).
 */
export interface Rule {
  readonly id: string;
  readonly kind: RuleKind;
  readonly language?: string;
  readonly severity: Severity;
  readonly message: string;
  /** Glob patterns for which files this rule applies to. */
  readonly files?: readonly string[];
  /** Glob patterns to ignore. */
  readonly ignores?: readonly string[];
  /** structural: the ast-grep rule body (pattern/kind/regex/all/any/not/inside/has). */
  readonly pattern?: Record<string, unknown>;
  /** structural: a shortcut — just a pattern string (ast-grep's `pattern` field). */
  readonly patternString?: string;
  /** lexical: a JS regex source (e.g. "console\\.log"). */
  readonly regex?: string;
  /** llm: a natural-language instruction. */
  readonly instruction?: string;
  /** Optional auto-fix (ast-grep's fix). */
  readonly fix?: string;
  // --- Phase 6.1 frontmatter (Finding 06, AGENTS.d model) ---
  /** Status: normative (enforced), advisory (surfaced), draft (staged). */
  readonly status?: RuleStatus;
  /** Keyword/routing trigger — when to load this rule (semantic, richer than glob). */
  readonly loadWhen?: readonly string[];
  /** Rule IDs this rule depends on (inheritance/prerequisite DAG). */
  readonly dependsOn?: readonly string[];
  /** Quality band (0-100) — min band of fired invariant rules = review rigor. */
  readonly qualityBand?: number;
  /** The directive kind (WHAT this rule is — orthogonal to HOW it's evaluated). */
  readonly ruleType?: DirectiveKind;
  /** The enforcement level (invariant > owner > proof > preference). */
  readonly enforcement?: Enforcement;
}

/** A finding: a rule fired on a specific span of source. */
export interface Finding {
  /** The rule that fired. */
  readonly ruleId: string;
  /** The rule kind (structural/lexical/llm). */
  readonly kind: RuleKind;
  /** Deterministic or LLM — the provenance tag (04 §8). */
  readonly source: FindingSource;
  readonly severity: Severity;
  readonly message: string;
  /** File path (relative to repo). */
  readonly filepath: string;
  /** 1-based line where the match starts. */
  readonly line: number;
  /** 0-based column. */
  readonly column: number;
  /** The matched source text. */
  readonly match: string;
  /** Optional auto-fix. */
  readonly fix?: string;
  /** Evidence class (Phase 6.1): how well-evidenced this finding is. */
  readonly evidenceClass?: EvidenceClass;
}

/** Input to rule evaluation. */
export interface RuleEvalInput {
  readonly filepath: string;
  readonly source: string;
  readonly language?: string;
  readonly rules: readonly Rule[];
}

/** Output: all findings, tagged by source. */
export interface RuleEvalOutput {
  readonly findings: readonly Finding[];
  readonly deterministicCount: number;
  readonly llmCount: number;
}

/** The rules owner's capabilities (02-architecture-overview §2). */
export type RulesCapability = "evaluate";

/** Contribution: a rule evaluator (one of the three kinds). */
export interface RuleEvaluatorContribution {
  readonly kind: "rule-evaluator";
  readonly id: string;
  /** Which rule kind this evaluator handles. */
  readonly ruleKind: RuleKind;
  /** Evaluate rules of this kind against source. */
  readonly evaluate: (input: RuleEvalInput) => Promise<readonly Finding[]>;
  readonly mutates?: boolean;
}

export const rulesOwner: OwnerSpec<RulesCapability, string> = {
  name: "rules",
  capabilities: ["evaluate"],
  // NON-exclusive: multiple rule evaluators coexist (structural + lexical + llm).
  // Each handles its own rule kind; findings merge.
  exclusive: () => false,
  kindFor: () => "rule-evaluator",
};

/**
 * The evaluation order (04 §8): deterministic rules first (structural → lexical),
 * then LLM. This is the anti-noise invariant — high-precision checks run before
 * the probabilistic LLM sees anything.
 */
export const EVALUATION_ORDER: readonly RuleKind[] = ["structural", "lexical", "llm"];

/** Map a rule kind to its source tag. */
export const kindToSource = (kind: RuleKind): FindingSource =>
  kind === "llm" ? "llm" : "deterministic";
