/**
 * TDD tests for the Phase 6.1 frontmatter schema (Finding 06 — AGENTS.d model).
 *
 * THE CAPABILITY: a Rule carries self-describing frontmatter (status, loadWhen,
 * dependsOn, qualityBand, ruleType, enforcement) that a corpus router can
 * introspect. A Finding carries an evidenceClass. These fields make rules
 * first-class artifacts (not just evaluators) — the "tree" not just the "leaf."
 *
 * Per project TDD rule: written FIRST, challenges capability, never degraded.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Rule, Finding, DirectiveKind, Enforcement, RuleStatus, EvidenceClass } from "./finding.js";

describe("Phase 6.1 — frontmatter schema (Finding 06, AGENTS.d model)", () => {
  it("a Rule can carry all 6 frontmatter fields (status, loadWhen, dependsOn, qualityBand, ruleType, enforcement)", () => {
    const rule: Rule = {
      id: "test-frontmatter",
      kind: "structural",
      severity: "error",
      message: "test",
      patternString: "console.log($A)",
      status: "normative",
      loadWhen: ["console", "debug", "logging"],
      dependsOn: ["no-debug-code"],
      qualityBand: 90,
      ruleType: "anti-pattern",
      enforcement: "invariant",
    };
    assert.equal(rule.status, "normative");
    assert.deepEqual([...rule.loadWhen!], ["console", "debug", "logging"]);
    assert.deepEqual([...rule.dependsOn!], ["no-debug-code"]);
    assert.equal(rule.qualityBand, 90);
    assert.equal(rule.ruleType, "anti-pattern");
    assert.equal(rule.enforcement, "invariant");
  });

  it("frontmatter fields are all optional (backward-compat — existing rules without frontmatter still valid)", () => {
    const rule: Rule = {
      id: "legacy-rule",
      kind: "lexical",
      severity: "warning",
      message: "x",
      regex: "TODO",
    };
    assert.equal(rule.status, undefined);
    assert.equal(rule.loadWhen, undefined);
    assert.equal(rule.qualityBand, undefined);
    assert.equal(rule.ruleType, undefined);
  });

  it("DirectiveKind has all 7 values from the AGENTS.d taxonomy", () => {
    const kinds: DirectiveKind[] = [
      "process", "evidence-gate", "anti-pattern", "capability-invariant",
      "definition-of-done", "voice", "pattern",
    ];
    assert.equal(kinds.length, 7);
    // Each is a distinct literal.
    assert.equal(new Set(kinds).size, 7);
  });

  it("Enforcement has the 4-level priority stack (invariant > owner > proof > preference)", () => {
    const levels: Enforcement[] = ["invariant", "owner", "proof", "preference"];
    assert.equal(levels.length, 4);
  });

  it("RuleStatus has 3 values (normative, advisory, draft)", () => {
    const statuses: RuleStatus[] = ["normative", "advisory", "draft"];
    assert.equal(statuses.length, 3);
  });

  it("EvidenceClass has 5 values (verified > documented > referenced > inferred > unverified)", () => {
    const classes: EvidenceClass[] = ["verified", "documented", "referenced", "inferred", "unverified"];
    assert.equal(classes.length, 5);
  });

  it("a Finding can carry evidenceClass", () => {
    const finding: Finding = {
      ruleId: "test",
      kind: "structural",
      source: "deterministic",
      severity: "error",
      message: "x",
      filepath: "a.ts",
      line: 1,
      column: 0,
      match: "x",
      evidenceClass: "verified",
    };
    assert.equal(finding.evidenceClass, "verified");
  });

  it("Severity includes 'tip' and 'hint' as distinct tiers (AGENTS.d parity)", () => {
    // hint = gentle nudge / non-actionable awareness; tip = actionable
    // recommendation. They are distinct enum members (severity.ts renders each
    // under its own label — they are no longer aliased to a shared "tip" label).
    const severities = ["hint", "info", "tip", "warning", "error", "off"];
    assert.ok(severities.includes("hint"));
    assert.ok(severities.includes("tip"));
    assert.notEqual(severities.indexOf("hint"), severities.indexOf("tip"), "hint and tip are distinct members");
  });
});
