/**
 * TDD tests for the baseline-pack rules plug — proves each baseline rule fires
 * on its target pattern and does NOT fire on clean code or excluded files.
 *
 * Per project TDD rule: tests challenge capability (each rule must produce a
 * real finding on its defect pattern), never degraded to pass. Per the ≥30
 * meaningful test floor: these are feature-value tests proving the plug's
 * intended entrypoint (evaluateBaseline + the registered evaluator contribution).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BASELINE_RULES,
  evaluateBaseline,
  setup,
  manifest,
} from "./plug.js";
import type { RuleEvalInput, RuleEvaluatorContribution } from "@gitgecko/rules";

const evalInput = (source: string, filepath = "src/app.ts"): RuleEvalInput => ({
  filepath,
  source,
  language: "typescript",
  rules: [],
});

const findRule = (id: string) => {
  const rule = BASELINE_RULES.find((r) => r.id === id);
  assert.ok(rule, `rule ${id} must exist in the baseline pack`);
  return rule!;
};

describe("baseline-pack — rule pack composition", () => {
  it("ships ≥8 baseline rules (the pack is non-vacuous)", () => {
    assert.ok(BASELINE_RULES.length >= 8, `expected ≥8 baseline rules, got ${BASELINE_RULES.length}`);
  });

  it("every baseline rule has a stable citable id, a regex, and a message", () => {
    for (const rule of BASELINE_RULES) {
      assert.ok(rule.id.startsWith("baseline-"), `rule id ${rule.id} should be prefixed baseline-`);
      assert.ok(rule.regex, `rule ${rule.id} must have a regex`);
      assert.ok(rule.message.length > 20, `rule ${rule.id} must have a meaningful message`);
      assert.equal(rule.kind, "lexical");
    }
  });

  it("no two baseline rules share an id (uniqueness)", () => {
    const ids = BASELINE_RULES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate rule ids in the baseline pack");
  });
});

describe("baseline-pack — eval detection", () => {
  it("flags eval() usage", async () => {
    const findings = await evaluateBaseline(evalInput("const x = eval('1+1');"));
    const evalFinding = findings.find((f) => f.ruleId === "baseline-no-eval");
    assert.ok(evalFinding, "eval() must produce a baseline-no-eval finding");
    assert.equal(evalFinding!.severity, "error");
    assert.equal(evalFinding!.source, "deterministic");
    assert.ok(evalFinding!.match.includes("eval"));
  });

  it("flags eval in a repository-root file", async () => {
    const findings = await evaluateBaseline(evalInput("eval(userInput);", "app.ts"));
    assert.ok(findings.some((finding) => finding.ruleId === "baseline-no-eval"));
  });

  it("does NOT flag eval in a comment or string literal that isn't a call", async () => {
    const findings = await evaluateBaseline(evalInput('// eval is dangerous\nconst note = "don\'t use eval";'));
    const evalFindings = findings.filter((f) => f.ruleId === "baseline-no-eval");
    // The regex requires eval followed by ( — "eval is" and "use eval" won't match.
    assert.equal(evalFindings.length, 0, "eval in a comment/string without () should not fire");
  });
});

describe("baseline-pack — new Function detection", () => {
  it("flags new Function() constructor", async () => {
    const findings = await evaluateBaseline(evalInput("const fn = new Function('return 1');"));
    const fnFinding = findings.find((f) => f.ruleId === "baseline-no-new-function");
    assert.ok(fnFinding, "new Function() must produce a baseline-no-new-function finding");
    assert.equal(fnFinding!.severity, "error");
  });
});

describe("baseline-pack — hardcoded secret detection", () => {
  it("flags an API key literal", async () => {
    const findings = await evaluateBaseline(evalInput('const apiKey = "sk_live_abc123def456ghi789jkl";'));
    const secretFinding = findings.find((f) => f.ruleId === "baseline-hardcoded-secret");
    assert.ok(secretFinding, "a long key-like literal must produce a baseline-hardcoded-secret finding");
    assert.equal(secretFinding!.severity, "warning");
  });

  it("does NOT flag a short placeholder value", async () => {
    const findings = await evaluateBaseline(evalInput('const apiKey = "test";'));
    const secretFindings = findings.filter((f) => f.ruleId === "baseline-hardcoded-secret");
    assert.equal(secretFindings.length, 0, "short values (<16 chars) should not trigger the secret rule");
  });
});

describe("baseline-pack — disabled TLS detection", () => {
  it("flags rejectUnauthorized: false", async () => {
    const findings = await evaluateBaseline(evalInput("const agent = new https.Agent({ rejectUnauthorized: false });"));
    const tlsFinding = findings.find((f) => f.ruleId === "baseline-disabled-tls");
    assert.ok(tlsFinding, "rejectUnauthorized:false must produce a baseline-disabled-tls finding");
    assert.equal(tlsFinding!.severity, "error");
  });
});

describe("baseline-pack — dangerous innerHTML detection", () => {
  it("flags innerHTML assignment", async () => {
    const findings = await evaluateBaseline(evalInput('element.innerHTML = userInput;'));
    const htmlFinding = findings.find((f) => f.ruleId === "baseline-dangerous-innerhtml");
    assert.ok(htmlFinding, ".innerHTML = must produce a baseline-dangerous-innerhtml finding");
  });
});

describe("baseline-pack — SQL string concatenation detection", () => {
  it("flags SQL query with template literal interpolation", async () => {
    const findings = await evaluateBaseline(evalInput('db.query(`SELECT * FROM users WHERE id = ${userId}`);'));
    const sqlFinding = findings.find((f) => f.ruleId === "baseline-sql-string-concat");
    assert.ok(sqlFinding, "template-literal SQL interpolation must produce a baseline-sql-string-concat finding");
    assert.equal(sqlFinding!.severity, "warning");
  });
});

describe("baseline-pack — debugger statement detection", () => {
  it("flags a leftover debugger statement", async () => {
    const findings = await evaluateBaseline(evalInput("function check() {\n  debugger;\n  return true;\n}"));
    const dbgFinding = findings.find((f) => f.ruleId === "baseline-debugger-statement");
    assert.ok(dbgFinding, "debugger statement must produce a baseline-debugger-statement finding");
  });
});

describe("baseline-pack — console detection with file ignores", () => {
  it("flags console.log in a source file", async () => {
    const findings = await evaluateBaseline(evalInput('console.log("here");', "src/handler.ts"));
    const consoleFinding = findings.find((f) => f.ruleId === "baseline-console-in-prod-path");
    assert.ok(consoleFinding, "console.log in a source file must produce a finding");
    assert.equal(consoleFinding!.severity, "info");
  });

  it("does NOT flag console.log in test files (ignored by the rule's ignores glob)", async () => {
    const findings = await evaluateBaseline(evalInput('console.log("test output");', "src/handler.test.ts"));
    const consoleFindings = findings.filter((f) => f.ruleId === "baseline-console-in-prod-path");
    assert.equal(consoleFindings.length, 0, "console in test files should be ignored");
  });
});

describe("baseline-pack — multi-rule scan", () => {
  it("produces findings from multiple rules on source with several defects", async () => {
    const source = [
      'const apiKey = "sk_live_abcdefghijklmnop";',
      "eval(apiKey);",
      "debugger;",
    ].join("\n");
    const findings = await evaluateBaseline(evalInput(source));
    const ruleIds = new Set(findings.map((f) => f.ruleId));
    assert.ok(ruleIds.has("baseline-hardcoded-secret"), "secret detected in multi-defect scan");
    assert.ok(ruleIds.has("baseline-no-eval"), "eval detected in multi-defect scan");
    assert.ok(ruleIds.has("baseline-debugger-statement"), "debugger detected in multi-defect scan");
    assert.ok(findings.length >= 3, "at least 3 findings from 3 defects");
  });

  it("produces zero findings on clean code", async () => {
    const source = [
      'import { config } from "./config";',
      "export function handler(req: Request): Response {",
      "  const user = authenticate(req.headers.get('authorization'));",
      "  if (!user) return new Response('Unauthorized', { status: 401 });",
      "  return Response.json({ id: user.id });",
      "}",
    ].join("\n");
    const findings = await evaluateBaseline(evalInput(source));
    assert.equal(findings.length, 0, "clean code must produce zero baseline findings");
  });
});

describe("baseline-pack — plug setup registers a contribution", () => {
  it("registers a lexical evaluator contribution through setup()", async () => {
    const contributions: RuleEvaluatorContribution[] = [];
    await setup({
      register: (_cap, contribution) => contributions.push(contribution),
    });
    assert.equal(contributions.length, 1, "setup registers exactly one evaluator contribution");
    assert.equal(contributions[0]!.id, "baseline-lexical-evaluator");
    assert.equal(contributions[0]!.ruleKind, "lexical");
    assert.equal(contributions[0]!.mutates, false);
  });

  it("the registered evaluator is callable and produces findings", async () => {
    const contributions: RuleEvaluatorContribution[] = [];
    await setup({ register: (_cap, c) => contributions.push(c) });
    const evaluator = contributions[0]!;
    const findings = await evaluator.evaluate(evalInput("eval('1');"));
    assert.ok(findings.length >= 1, "the registered evaluator produces findings on eval()");
    assert.equal(findings[0]!.source, "deterministic");
  });

  it("the manifest declares the rules owner and evaluate capability", () => {
    assert.equal(manifest.owner, "rules");
    assert.ok(manifest.capabilities.includes("evaluate"));
    assert.equal(manifest.id, "rules-baseline-pack");
  });
});
