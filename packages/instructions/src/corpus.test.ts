/**
 * TDD tests for the corpus router (Phase 6.2, T1 — the strategic differentiator).
 *
 * THE CAPABILITY: the corpus router does semantic keyword routing + tiered load
 * by blast radius. Normative rules always load; advisory rules load only on
 * keyword match; both filter by tier. This is the wedge CR-§8 (glob-only NL)
 * and GP-§10 wp2 (NL-only) lack.
 *
 * Per project TDD rule: tests challenge capability, never degraded to pass.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCorpus, extractKeywords, reviewQualityBand } from "./corpus.js";
import { PROPRIETARY_RULES } from "./rules-corpus.js";
import { inferBlastTier } from "./resolve.js";

describe("corpus router — semantic keyword routing (the CR-§8 wedge)", () => {
  it("normative rules are ALWAYS loaded (even with no keywords)", () => {
    // At tier 3, all normative rules load regardless of keywords.
    const rules = resolveCorpus([], 3);
    const normativeIds = rules.filter((r) => r.status === "normative").map((r) => r.id);
    // W4/W10 (tier 2), NG7 (tier 3), P-plugin-7 (tier 3), W5 (tier 3) are normative.
    assert.ok(normativeIds.includes("W4/W10"), "W4/W10 (normative) must always load");
    assert.ok(normativeIds.includes("NG7"), "NG7 (normative) must always load at tier 3");
    assert.ok(normativeIds.includes("W5"), "W5 (normative) must always load at tier 3");
  });

  it("normative rules ALWAYS load regardless of tier (invariants are non-negotiable)", () => {
    // Normative rules (W4/W10, NG7, W5, P-plugin-7) bypass the tier filter —
    // they are architectural invariants that apply to ALL PRs. Even a Tier-1
    // typo fix gets the least-privilege (NG7), shell:true (W5), deterministic-first
    // (W4/W10), and mutates-gate (P-plugin-7) checks.
    const t1Rules = resolveCorpus([], 1);
    const t1Ids = t1Rules.map((r) => r.id);
    assert.ok(t1Ids.includes("NG7"), "NG7 (normative) MUST load even at Tier-1");
    assert.ok(t1Ids.includes("W5"), "W5 (normative) MUST load even at Tier-1");
    assert.ok(t1Ids.includes("W4/W10"), "W4/W10 (normative) MUST load even at Tier-1");
  });

  it("advisory rules are NOT loaded when keywords don't match", () => {
    const rules = resolveCorpus(["completely-unrelated-keyword"], 2);
    const advisoryIds = rules.filter((r) => r.status === "advisory").map((r) => r.id);
    // No advisory rules should match an unrelated keyword.
    assert.equal(advisoryIds.length, 0, "no advisory rules should load for unrelated keywords");
  });

  it("advisory rules ARE loaded when keywords match (semantic routing)", () => {
    // "auth" + "session" should trigger NG7 (permission/scope) and NG5 (rules/nl).
    const rules = resolveCorpus(["auth", "session", "security"], 3);
    const ids = rules.map((r) => r.id);
    assert.ok(ids.includes("NG7"), "NG7 must load for auth/security keywords");
  });

  it("routing is case-insensitive", () => {
    const lower = resolveCorpus(["auth"], 3).map((r) => r.id);
    const upper = resolveCorpus(["AUTH", "Security"], 3).map((r) => r.id);
    assert.deepEqual(lower, upper, "keyword matching must be case-insensitive");
  });
});

describe("corpus router — tiered load by blast radius (the AGENTS.d model)", () => {
  it("Tier-1 PR (trivial) loads fewer rules than Tier-3 (architectural)", () => {
    const t1 = resolveCorpus(["auth", "shell", "permission", "rules"], 1);
    const t3 = resolveCorpus(["auth", "shell", "permission", "rules"], 3);
    assert.ok(t1.length < t3.length, `Tier-1 (${t1.length}) must load fewer rules than Tier-3 (${t3.length})`);
  });

  it("Tier-3 loads the W5 security rule (shell/injection)", () => {
    const rules = resolveCorpus(["shell", "bash", "exec"], 3);
    const ids = rules.map((r) => r.id);
    assert.ok(ids.includes("W5"), "W5 (shell injection) must load at Tier-3 with security keywords");
  });

  it("Tier-1 does NOT load Tier-3 ADVISORY rules (normative always loads)", () => {
    const rules = resolveCorpus(["rules", "nl", "natural-language", "invariant"], 1);
    const ids = rules.map((r) => r.id);
    // NG5 is advisory tier-3 — should NOT load at tier 1 even with matching keywords.
    assert.ok(!ids.includes("NG5"), "NG5 (advisory tier-3) must NOT load at Tier-1");
    // Normative rules (W4/W10, NG7, W5, P-plugin-7) bypass the tier filter —
    // they are architectural invariants that apply to ALL PRs regardless of
    // blast radius. A Tier-1 typo PR still gets the shell:true check (W5).
    assert.ok(ids.includes("W5"), "W5 (normative) MUST load even at Tier-1");
  });
});

describe("corpus router — keyword extraction from diffs", () => {
  it("extracts file-path segments as keywords", () => {
    const kw = extractKeywords("--- a/src/auth/session.ts\n+++ b/src/auth/session.ts\n+const x = 1;");
    const lower = kw.map((k) => k.toLowerCase());
    assert.ok(lower.includes("auth"));
    assert.ok(lower.includes("session"));
  });

  it("extracts identifiers from added lines (camelCase split)", () => {
    const kw = extractKeywords("+++ b/src/api.ts\n+function createSessionToken(user) {");
    const lower = kw.map((k) => k.toLowerCase());
    assert.ok(lower.includes("session"));
    assert.ok(lower.includes("token"));
    assert.ok(lower.includes("create"));
  });

  it("returns empty for empty diff", () => {
    assert.deepEqual(extractKeywords(""), []);
    assert.deepEqual(extractKeywords("   "), []);
  });

  it("filters stop words (const, function, return, etc.)", () => {
    const kw = extractKeywords("+++ b/f.ts\n+const result = function validateAuth() { return true; }");
    const lower = kw.map((k) => k.toLowerCase());
    assert.ok(!lower.includes("const"));
    assert.ok(!lower.includes("function"));
    assert.ok(!lower.includes("return"));
    assert.ok(lower.includes("auth"));
    assert.ok(lower.includes("validate"));
  });
});

describe("corpus router — review quality band (the rigor metric)", () => {
  it("returns the minimum quality band of fired normative rules", () => {
    const rules = resolveCorpus([], 2); // normative-only (all normative rules load regardless of tier)
    const band = reviewQualityBand(rules);
    // All normative rules fire (they bypass tier), so the band is the min across ALL normative rules.
    const normativeBands = PROPRIETARY_RULES.filter((r) => r.status === "normative").map((r) => r.qualityBand);
    const expectedMin = Math.min(...normativeBands);
    assert.equal(band, expectedMin);
    assert.ok(band > 0, "quality band must be positive when normative rules fired");
  });

  it("returns 0 when no normative rules fired (empty corpus)", () => {
    assert.equal(reviewQualityBand([]), 0);
  });
});

describe("inferBlastTier — blast-radius inference from diff + keywords", () => {
  it("returns Tier 3 when a high-risk signal keyword is present", () => {
    assert.equal(inferBlastTier("", ["auth", "session"]), 3);
    assert.equal(inferBlastTier("", ["billing", "stripe"]), 3);
    assert.equal(inferBlastTier("", ["security", "token"]), 3);
    assert.equal(inferBlastTier("", ["migration", "schema"]), 3);
    assert.equal(inferBlastTier("", ["docker", "deploy"]), 3);
  });

  it("returns Tier 2 for empty diff (can't infer scope — be safe)", () => {
    assert.equal(inferBlastTier("", []), 2);
  });

  it("returns Tier 1 for a small single-file diff (typo/readme)", () => {
    const smallDiff = "--- a/README.md\n+++ b/README.md\n+fixed typo";
    assert.equal(inferBlastTier(smallDiff, []), 1);
  });

  it("returns Tier 2 for a standard multi-line diff (>5 added lines)", () => {
    const standardDiff = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "+function foo() {",
      "+  const a = 1;",
      "+  const b = 2;",
      "+  const c = 3;",
      "+  const d = 4;",
      "+  const e = 5;",
      "+  return a + b + c + d + e;",
      "+}",
    ].join("\n");
    assert.equal(inferBlastTier(standardDiff, []), 2);
  });

  it("returns Tier 3 for a small diff that contains high-risk keywords", () => {
    // Even a 1-line diff with "auth" escalates to Tier 3.
    const smallAuthDiff = "--- a/src/auth.ts\n+++ b/src/auth.ts\n+export function login() {}\n";
    const kw = extractKeywords(smallAuthDiff);
    assert.equal(inferBlastTier(smallAuthDiff, kw), 3);
  });

  it("inferBlastTier + resolveCorpus compose: socket+permission PR loads advisory rules a typo doesn't", () => {
    // A typo diff (Tier 1, no matching keywords) loads only normative invariants.
    const typoDiff = "--- a/README.md\n+++ b/README.md\n+fixed typo";
    const typoKw = extractKeywords(typoDiff);
    const typoTier = inferBlastTier(typoDiff, typoKw);
    const typoRules = resolveCorpus(typoKw, typoTier);

    // A socket+permission diff (Tier 3 via "permission") loads normative +
    // the INV-2.3 advisory rule (matches "socket" keyword).
    const socketKw = ["socket", "plug", "permission", "registry"];
    const socketRules = resolveCorpus(socketKw, 3);

    // The socket PR must load strictly more rules (normative + INV-2.3 advisory).
    assert.ok(
      socketRules.length > typoRules.length,
      `socket diff (${socketRules.length}) must load more rules than typo diff (${typoRules.length})`,
    );
    // And the socket diff includes the advisory rule.
    assert.ok(
      socketRules.some((r) => r.id === "INV-2.3"),
      "socket diff must load the INV-2.3 advisory rule",
    );
  });
});
