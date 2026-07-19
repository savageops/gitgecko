/**
 * gitgecko rules baseline-pack — the second rules plug (INV-2.3 proving plug).
 *
 * THE INVARIANT (INV-2.3): the rules owner is non-exclusive — multiple evaluator
 * plugs coexist, each contributing its own rule-evaluator lane. This plug proves
 * that invariant by existing alongside plug-rules-evaluators as a distinct,
 * real implementation (not a stub or a renamed copy).
 *
 * WHAT THIS PLUG DOES: ships a pack of pre-built lexical rules for common
 * security/baseline defect patterns — hardcoded secrets, eval usage, disabled
 * TLS, dangerous innerHTML, SQL string concatenation. These are the "banned API"
 * patterns a baseline review should flag deterministically, without an LLM.
 *
 * HOW IT DIFFERS FROM plug-rules-evaluators: the evaluators plug provides the
 * ENGINE (ast-grep structural + generic regex lexical, driven by user-configured
 * rules). This plug provides CONTENT — a curated pack of rules with known-good
 * regexes that the lexical engine runs. Both register lexical evaluator
 * contributions; their findings merge in the orchestrator's dedup pass.
 *
 * Salvaged pattern: pr-agent's "tools/banned_apis" + Continue's "baseline rules"
 * — every review tool ships a starter pack of common defect patterns.
 */
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import {
  ruleAppliesToPath,
  type Finding,
  type Rule,
  type RuleEvalInput,
  type RuleEvaluatorContribution,
} from "@gitgecko/rules";
import manifestJson from "./plug.manifest.json" with { type: "json" };

// --- Manifest (parsed, not cast) --------------------------------------------
const parsedManifest = parseManifest(manifestJson);
if (!parsedManifest.ok) {
  throw new Error(`rules-baseline-pack manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
}
export const manifest: PlugManifest = parsedManifest.value;

// --- The baseline rule pack -------------------------------------------------
//
// Each rule is a lexical (regex) rule with a known-good pattern for a common
// security/baseline defect. These are NOT user-configured — they ship with the
// plug and are always active when the plug is loaded. The rule ids are stable
// and citable (baseline-no-eval, baseline-hardcoded-secret, etc.).
//
// The regexes are deliberately conservative: they target unambiguous patterns
// (eval(, innerHTML =, rejectUnauthorized: false) rather than heuristics that
// would produce false positives. Precision over recall — the deterministic-first
// wedge (W4) demands zero-hallucination findings.

export const BASELINE_RULES: readonly Rule[] = [
  {
    id: "baseline-no-eval",
    kind: "lexical",
    severity: "error",
    message: "eval() executes arbitrary code — a code-injection vector. Use a parser or JSON.parse for data.",
    regex: /\beval\s*\(/.source,
    files: ["**/*.js", "**/*.ts", "**/*.tsx", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
  },
  {
    id: "baseline-no-new-function",
    kind: "lexical",
    severity: "error",
    message: "new Function() compiles arbitrary code at runtime — equivalent to eval(). Use a static function.",
    regex: /\bnew\s+Function\s*\(/.source,
    files: ["**/*.js", "**/*.ts", "**/*.tsx", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
  },
  {
    id: "baseline-hardcoded-secret",
    kind: "lexical",
    severity: "warning",
    message: "Possible hardcoded secret — API key or token literal in source. Move to an environment variable.",
    regex: /(?:[Aa][Pp][Ii][_\-]?[Kk]ey|[Ss]ecret|[Tt]oken|[Pp]assword|[Pp]asswd|[Pp]wd)\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/.source,
    files: ["**/*.js", "**/*.ts", "**/*.tsx", "**/*.jsx", "**/*.py", "**/*.rb", "**/*.go", "**/*.rs"],
  },
  {
    id: "baseline-disabled-tls",
    kind: "lexical",
    severity: "error",
    message: "TLS verification disabled (rejectUnauthorized: false) — enables MITM attacks. Never disable in production.",
    regex: /rejectUnauthorized\s*:\s*false/.source,
    files: ["**/*.js", "**/*.ts", "**/*.tsx", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
  },
  {
    id: "baseline-dangerous-innerhtml",
    kind: "lexical",
    severity: "warning",
    message: "innerHTML assignment can introduce XSS if the value is user-controlled. Use textContent or sanitize.",
    regex: /\.innerHTML\s*=/.source,
    files: ["**/*.js", "**/*.ts", "**/*.tsx", "**/*.jsx"],
  },
  {
    id: "baseline-sql-string-concat",
    kind: "lexical",
    severity: "warning",
    message: "SQL query built via string concatenation — a SQL-injection vector. Use parameterized queries.",
    regex: /(?:query|execute|sql)\s*\(\s*[`"'].*?\$\{/.source,
    files: ["**/*.js", "**/*.ts", "**/*.tsx", "**/*.jsx", "**/*.py"],
  },
  {
    id: "baseline-debugger-statement",
    kind: "lexical",
    severity: "warning",
    message: "debugger statement left in source — will pause execution in devtools. Remove before shipping.",
    regex: /\bdebugger\b/.source,
    files: ["**/*.js", "**/*.ts", "**/*.tsx", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
  },
  {
    id: "baseline-console-in-prod-path",
    kind: "lexical",
    severity: "info",
    message: "console output in what may be a production code path. Consider a proper logger with levels.",
    regex: /\bconsole\.(log|debug|info)\s*\(/.source,
    files: ["**/*.js", "**/*.ts", "**/*.tsx", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
    ignores: ["**/*.test.ts", "**/*.test.tsx", "**/*.test.js", "**/*.spec.ts", "**/*.spec.js", "**/test/**", "**/tests/**", "**/__tests__/**"],
  },
];

// --- Evaluator implementation ------------------------------------------------
//
// The evaluator runs the BASELINE_RULES against the input source. It merges
// the baseline rules with any user-configured lexical rules of the same kind,
// so both the shipped pack and custom rules produce findings in one pass.

/** Convert a byte offset to 1-based line + 0-based column. */
const offsetToLineCol = (source: string, offset: number): { line: number; column: number } => {
  let line = 1;
  let col = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") { line++; col = 0; } else { col++; }
  }
  return { line, column: col };
};

// Simple glob → regex (same approach as plug-rules-evaluators).
export const evaluateBaseline = async (input: RuleEvalInput): Promise<readonly Finding[]> => {
  if (input.source.length === 0) return [];

  // Merge shipped baseline rules with any user-configured lexical rules.
  const userLexical = input.rules.filter((r) => r.kind === "lexical" && r.regex);
  const rulesById = new Map([...BASELINE_RULES, ...userLexical].map((rule) => [rule.id, rule]));
  const allRules = [...rulesById.values()].filter((r) => ruleAppliesToPath(r, input.filepath));

  const findings: Finding[] = [];
  for (const rule of allRules) {
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

// --- Plug setup (registers the evaluate capability) -------------------------
export async function setup(api: {
  register: (capability: "evaluate", contribution: RuleEvaluatorContribution) => void;
}): Promise<void> {
  api.register("evaluate", {
    kind: "rule-evaluator",
    id: "baseline-lexical-evaluator",
    ruleKind: "lexical",
    evaluate: (input) => evaluateBaseline(input).then((f) => f as Finding[]),
    mutates: false,
  });
}
