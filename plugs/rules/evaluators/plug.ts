/**
 * gitgecko rules plug — deterministic evaluators (structural + lexical).
 *
 * THE WEDGE (04 §8): deterministic rules produce zero-hallucination findings —
 * neither CodeRabbit (CR-§8 NL-only) nor Greptile (GP-§10 wp2 NL-only) has this.
 *
 * Two deterministic evaluators + one orchestrator:
 *  - evaluateStructural: ast-grep napi (P-codeintel-11). parse(lang, src) → findAll(rule).
 *  - evaluateLexical: JS regex over source lines. Trivial, fast, zero-dep.
 *  - evaluateRules: orchestrator. Runs deterministic first (structural → lexical).
 *    Merges, tags source, counts.
 *
 * NOTE on the "llm" rule kind: the Rule type retains `kind: "llm"` for NL
 * path-instructions (CR-§8 model), but these are NOT evaluated as findings here.
 * NL rules flow into the review prompt via ResolvedInstructions.rules (the
 * review owner's path), NOT via this evaluator lane. A separate evaluateLlm
 * that synthesized findings would duplicate that path and diverge from the
 * proven CR-§8 model. The llmCount in the output is therefore always 0 from
 * this evaluator (LLM-produced findings, if any, are tagged by the review loop).
 *
 * File-glob matching (files/ignores) is delegated to the canonical rules owner.
 */
import { parse, type Lang } from "@ast-grep/napi";
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import {
  EVALUATION_ORDER,
  kindToSource,
  ruleAppliesToPath,
  type Finding,
  type Rule,
  type RuleEvalInput,
  type RuleEvalOutput,
  type RuleEvaluatorContribution,
} from "@gitgecko/rules";
import manifestJson from "./plug.manifest.json" with { type: "json" };

// --- Manifest (parsed, not cast) --------------------------------------------
const parsedManifest = parseManifest(manifestJson);
if (!parsedManifest.ok) {
  throw new Error(`rules-evaluators manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
}
export const manifest: PlugManifest = parsedManifest.value;

// --- Line/column helpers ----------------------------------------------------
/** Convert a byte offset to 1-based line + 0-based column. */
const offsetToLineCol = (source: string, offset: number): { line: number; column: number } => {
  let line = 1;
  let col = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") { line++; col = 0; } else { col++; }
  }
  return { line, column: col };
};

// --- Structural evaluator (ast-grep napi, P-codeintel-11) -------------------
const LANG_MAP: Readonly<Record<string, Lang>> = {
  javascript: "JavaScript" as Lang,
  typescript: "TypeScript" as Lang,
  tsx: "TsxAst" as Lang,
  python: "Python" as Lang,
  rust: "Rust" as Lang,
  go: "Go" as Lang,
  ruby: "Ruby" as Lang,
  java: "Java" as Lang,
  c: "C" as Lang,
  cpp: "Cpp" as Lang,
};

export const evaluateStructural = async (input: RuleEvalInput): Promise<readonly Finding[]> => {
  const langName = input.language ?? inferLangFromPath(input.filepath);
  const lang = langName ? LANG_MAP[langName] : undefined;
  if (!lang) return []; // unsupported language → no structural findings

  const applicableRules = input.rules.filter(
    (r) => r.kind === "structural" && ruleAppliesToPath(r, input.filepath) && (r.patternString || r.pattern),
  );
  if (applicableRules.length === 0 || input.source.trim().length === 0) return [];

  const findings: Finding[] = [];
  try {
    const root = parse(lang, input.source);
    for (const rule of applicableRules) {
      try {
        // Build the ast-grep config from patternString or pattern object.
        const config = rule.patternString
          ? { rule: { pattern: rule.patternString } }
          : { rule: rule.pattern ?? {} };
        const matches = root.root().findAll(config);
        for (const m of matches) {
          const range = m.range();
          const start = offsetToLineCol(input.source, range.start.index);
          findings.push({
            ruleId: rule.id,
            kind: "structural",
            source: "deterministic",
            severity: rule.severity,
            message: rule.message,
            filepath: input.filepath,
            line: start.line,
            column: start.column,
            match: m.text(),
            ...(rule.fix && { fix: rule.fix }),
          });
        }
      } catch {
        // invalid rule pattern — skip, don't crash
      }
    }
  } catch {
    // parse failure — no structural findings
  }
  return findings;
};

const inferLangFromPath = (filepath: string): string | undefined => {
  const ext = filepath.split(".").pop()?.toLowerCase();
  const map: Readonly<Record<string, string>> = {
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "tsx", py: "python", rs: "rust", go: "go",
    rb: "ruby", java: "java", c: "c", cpp: "cpp", cc: "cpp",
  };
  return ext ? map[ext] : undefined;
};

// --- Lexical evaluator (regex) ----------------------------------------------
export const evaluateLexical = async (input: RuleEvalInput): Promise<readonly Finding[]> => {
  if (input.source.length === 0) return [];
  const applicableRules = input.rules.filter((r) => r.kind === "lexical" && r.regex && ruleAppliesToPath(r, input.filepath));
  if (applicableRules.length === 0) return [];

  const findings: Finding[] = [];
  for (const rule of applicableRules) {
    try {
      const re = new RegExp(rule.regex!, "g");
      let match: RegExpExecArray | null;
      while ((match = re.exec(input.source)) !== null) {
        const start = offsetToLineCol(input.source, match.index);
        findings.push({
          ruleId: rule.id,
          kind: "lexical",
          source: "deterministic",
          severity: rule.severity,
          message: rule.message,
          filepath: input.filepath,
          line: start.line,
          column: start.column,
          match: match[0],
        });
        if (match.index === re.lastIndex) re.lastIndex++; // avoid zero-length loop
      }
    } catch {
      // invalid regex — skip
    }
  }
  return findings;
};

// --- Orchestrator (deterministic first, 04 §8) ------------------------------
export const evaluateRules = async (input: RuleEvalInput): Promise<RuleEvalOutput> => {
  const allFindings: Finding[] = [];

  // Deterministic first (structural → lexical). The "llm" kind is NOT evaluated
  // here — NL path-instructions (CR-§8) flow into the review prompt via
  // ResolvedInstructions.rules (the review owner's path), not as findings.
  // EVALUATION_ORDER still includes "llm" for the data model, but we skip it
  // in the finding-producer loop: llm rules produce 0 findings from this lane.
  for (const kind of EVALUATION_ORDER) {
    let findings: readonly Finding[] = [];
    if (kind === "structural") findings = await evaluateStructural(input);
    else if (kind === "lexical") findings = await evaluateLexical(input);
    // kind === "llm": no findings produced here (NL rules → instructions.rules).
    allFindings.push(...findings);
  }

  // Finding dedup (salvaged from pr-agent + continue's deduplicateChunks pattern):
  // two rules flagging the same (filepath, line, ruleId) collapse to one. Without
  // this, structural + lexical lanes can produce duplicate findings on the same span.
  const seen = new Set<string>();
  const deduped = allFindings.filter((f) => {
    const key = `${f.filepath}:${f.line}:${f.ruleId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Finding cap (salvaged from pr-agent's num_max_findings, pr_reviewer.py:107):
  // a giant PR produces a readable review, not a wall. Sort by severity (error >
  // warning > info > tip > hint) and keep the top N. Default 50; override via env.
  const MAX_FINDINGS = Number(process.env.GITGECKO_MAX_FINDINGS ?? 50);
  const SEVERITY_RANK: Record<string, number> = { error: 0, warning: 1, info: 2, hint: 3, tip: 4, off: 5 };
  const capped = deduped.length > MAX_FINDINGS
    ? [...deduped]
        .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9))
        .slice(0, MAX_FINDINGS)
    : deduped;

  const deterministicCount = capped.filter((f) => f.source === "deterministic").length;
  const llmCount = capped.filter((f) => f.source === "llm").length;

  return { findings: capped, deterministicCount, llmCount };
};

// --- Plug setup (registers the evaluate capability) -------------------------
export async function setup(api: {
  register: (capability: "evaluate", contribution: RuleEvaluatorContribution) => void;
}): Promise<void> {
  // Register one contribution per DETERMINISTIC kind (non-exclusive: coexist).
  // The "llm" kind is intentionally NOT registered as an evaluator — NL rules
  // (CR-§8 path_instructions) flow into the review prompt via
  // ResolvedInstructions.rules, not as synthesized findings. Registering an
  // llm-evaluator that returns [] was a vacuous stub (violated the project
  // feedback rule: "tests challenge capability, never degraded to pass").
  api.register("evaluate", {
    kind: "rule-evaluator",
    id: "structural-evaluator",
    ruleKind: "structural",
    evaluate: (input) => evaluateStructural(input).then((f) => f as Finding[]),
    mutates: false,
  });
  api.register("evaluate", {
    kind: "rule-evaluator",
    id: "lexical-evaluator",
    ruleKind: "lexical",
    evaluate: (input) => evaluateLexical(input).then((f) => f as Finding[]),
    mutates: false,
  });
}
