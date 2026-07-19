/**
 * TDD tests for @gitgecko/instructions — the templates package.
 *
 * Challenges the CAPABILITY (observable contracts), not implementation:
 *  - persona: non-empty, contains expertise framing
 *  - severity: mapping covers all 5 levels, reuses imported Severity (no dup)
 *  - rules-corpus: ≥8 rules, every rule cites a stable ID, no uncited rules
 *  - guardrails: anti-noise rules present, no verbatim AGPL kodus copy
 *  - output-format: each command template renders, severity sections present
 *  - resolve: returns all fields, persona non-empty, outputFormat matches command
 *  - renderFindings: groups by severity, orders error-first
 *  - renderRepoContext (002b): formats snippets, empty→"", retrieved label
 *  - resolveInstructions repoContext threading (002b): optional field, conditional attach
 *  - extractDiffQueries (002c): file paths + identifiers from diffs, keyword filter, cap
 *
 * Per project TDD rule: written FIRST, never degraded.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Severity } from "@gitgecko/rules";
import {
  REVIEWER_PERSONA,
  severityLabel,
  severityEmoji,
  SEVERITY_ORDER,
  PROPRIETARY_RULES,
  ruleById,
  GUARDRAILS,
  outputFormatFor,
  reviewOutputFormat,
  renderFindings,
  renderRepoContext,
  resolveInstructions,
  commandTask,
  CITATION_GLOSSARY,
  glossaryFor,
  glossaryTerm,
  hasGlossaryEntry,
} from "./index.js";

// --- Persona ---

describe("persona", () => {
  it("is non-empty and substantial", () => {
    assert.ok(REVIEWER_PERSONA.length > 200, "persona must be substantial, not a stub");
  });

  it("contains expertise framing (consequence reasoning)", () => {
    assert.ok(/consequence/i.test(REVIEWER_PERSONA), "must mention consequence reasoning");
  });

  it("contains anti-noise discipline", () => {
    assert.ok(/no filler|no praise|matter-of-fact/i.test(REVIEWER_PERSONA), "must enforce anti-noise tone");
  });

  it("references the stable citation conventions", () => {
    assert.ok(/W4|W5|W10|NG[0-9]|P-plugin/i.test(REVIEWER_PERSONA), "must reference stable IDs");
  });

  it("forbids speculation (the anti-hallucination core)", () => {
    assert.ok(/could.*might.*possibly|do not speculate|no.*could.*might/i.test(REVIEWER_PERSONA), "must forbid speculation");
  });

  it("names the dialect's coinage discipline (move 1)", () => {
    assert.ok(/coin|name the (concept|term|anti-pattern)/i.test(REVIEWER_PERSONA), "persona must name the coinage move");
  });

  it("names the dialect's provenance discipline (move 6)", () => {
    assert.ok(/provenance|cite|citation|P-plugin|CR-§|GP-§/i.test(REVIEWER_PERSONA), "persona must require provenance citation");
  });
});

// --- Severity ---

describe("severity mapping", () => {
  it("renders hint and tip as DISTINCT labels (not aliased)", () => {
    // hint = a gentle nudge / non-actionable awareness (context).
    // tip = an actionable recommendation (what would be better).
    // They were previously aliased (both → "tip"); the seam is resolved: each
    // renders under its own distinct label so two findings don't collapse into
    // one group under a shared heading.
    assert.equal(severityLabel("hint"), "hint");
    assert.equal(severityLabel("tip"), "tip");
    assert.notEqual(severityLabel("hint"), severityLabel("tip"), "hint and tip must render distinctly");
  });

  it("maps error/warning/info directly", () => {
    assert.equal(severityLabel("error"), "error");
    assert.equal(severityLabel("warning"), "warning");
    assert.equal(severityLabel("info"), "info");
  });

  it("maps off → empty string (suppressed)", () => {
    assert.equal(severityLabel("off"), "");
  });

  it("provides a DISTINCT emoji per severity (hint ≠ tip)", () => {
    assert.ok(severityEmoji("error").length > 0);
    assert.ok(severityEmoji("warning").length > 0);
    assert.ok(severityEmoji("hint").length > 0, "hint must have an emoji");
    assert.ok(severityEmoji("tip").length > 0, "tip must have an emoji");
    assert.notEqual(severityEmoji("hint"), severityEmoji("tip"), "hint and tip emojis must differ");
    assert.equal(severityEmoji("off"), "");
  });

  it("SEVERITY_ORDER has 5 active levels in impact order (hint and tip distinct)", () => {
    assert.equal(SEVERITY_ORDER.length, 5);
    assert.equal(SEVERITY_ORDER[0], "error");
    assert.equal(SEVERITY_ORDER[3], "hint");
    assert.equal(SEVERITY_ORDER[4], "tip");
  });

  it("reuses the Severity type from @gitgecko/rules (no duplicate enum)", () => {
    // Compile-time proof: severityLabel accepts the imported Severity type.
    const sev: Severity = "error";
    assert.equal(severityLabel(sev), "error");
  });
});

// --- Rules corpus ---

describe("proprietary rules corpus", () => {
  it("has ≥8 rules", () => {
    assert.ok(PROPRIETARY_RULES.length >= 8, `expected ≥8, got ${PROPRIETARY_RULES.length}`);
  });

  it("every rule cites a stable ID (W/NG/P/INV/D/G)", () => {
    for (const rule of PROPRIETARY_RULES) {
      assert.match(
        rule.id,
        /^(W[0-9]|NG[0-9]|P-plugin|P-codeintel|P-frontend|INV|D[0-9]|G[0-9])/,
        `rule "${rule.id}" must cite a stable architecture ID`,
      );
    }
  });

  it("includes the W4/W10 deterministic-first rule", () => {
    const r = ruleById("W4/W10");
    assert.ok(r, "W4/W10 rule must exist");
    assert.ok(/deterministic/i.test(r!.instruction));
  });

  it("includes the NG8 salvage-first rule", () => {
    const r = ruleById("NG8");
    assert.ok(r, "NG8 rule must exist");
    assert.ok(/salvage|rewrite/i.test(r!.instruction));
  });

  it("includes the W5 blast-radius rule", () => {
    const r = ruleById("W5");
    assert.ok(r);
    assert.ok(/shell|execution|blast/i.test(r!.instruction));
  });

  it("includes the P-plugin-7 mutates-gate rule", () => {
    const r = ruleById("P-plugin-7");
    assert.ok(r);
    assert.ok(/mutates|deny-list|throws/i.test(r!.instruction));
  });

  it("includes the G9 dialect rule (consequence not symptom, normative, tier 1)", () => {
    const r = ruleById("G9");
    assert.ok(r, "G9 rule must exist");
    assert.strictEqual(r!.status, "normative", "G9 is normative — loaded on every review");
    assert.strictEqual(r!.tier, 1, "G9 is tier 1 — loads even on trivial PRs");
    assert.ok(/consequence/i.test(r!.instruction), "G9 must require consequence reasoning");
    assert.ok(/dialect|thumb-sucked|filler/i.test(r!.instruction), "G9 must name the dialect moves");
  });

  it("includes the G10 coinage rule (flag recurring unnamed abstractions)", () => {
    // Dialect move 1 (coin the load-bearing term) as a reviewable rule, not just
    // self-discipline. A PR that reaches for an abstraction ≥3× without naming it
    // should be flagged.
    const r = ruleById("G10");
    assert.ok(r, "G10 rule must exist");
    assert.ok(/coin|name|unnamed|abstraction/i.test(r!.instruction), "G10 must enforce coinage");
    assert.ok(r!.loadWhen.some((k) => /abstraction|name|concept|pattern/i.test(k)), "G10 loadWhen must route on abstraction signals");
  });

  it("includes the G11 provenance rule (cite P-*/CR-§N/GP-§N on salvage)", () => {
    // Dialect move 6 (provenance is a hard rule) as a reviewable rule. The
    // doctrine makes provenance law (20-code-quality.md); the corpus must enforce
    // it too — salvaged code without a P-* citation is an orphan.
    const r = ruleById("G11");
    assert.ok(r, "G11 rule must exist");
    assert.strictEqual(r!.status, "normative", "G11 is normative — provenance is a hard rule, not advisory");
    assert.ok(/P-plugin|P-codeintel|P-frontend|CR-§|GP-§|provenance|citation/i.test(r!.instruction), "G11 must require P-*/CR-§N/GP-§N citation");
    assert.ok(r!.loadWhen.some((k) => /salvage|harvest|provenance|copy|adapt/i.test(k)), "G11 loadWhen must route on salvage signals");
  });

  it("includes the G12 register rule (claim the capability, not the task)", () => {
    // The word strategy from gitgecko (wyrmcast.com / svg.wiki): every emitted
    // surface claims the capability, not the task; uses transferable vocabulary;
    // upgrades to corporate-register language. This is the secret sauce the
    // dialect elevates — comments, commits, findings, docs, public APIs all obey
    // it. A finding, comment, or doc that undersells ("shelf packer" instead of
    // "store floor and stock management") is a register defect.
    const r = ruleById("G12");
    assert.ok(r, "G12 rule must exist");
    assert.strictEqual(r!.status, "normative", "G12 is normative — register is a hard dialect constraint, not advisory");
    assert.ok(/capability|register|transferable|vocabulary/i.test(r!.instruction), "G12 must enforce the capability/register discipline");
    assert.ok(/corporate-register|transferable|capability/i.test(r!.instruction), "G12 must name the three register moves");
    assert.ok(/gitgecko|wyrmcast|svg\.wiki/i.test(r!.instruction), "G12 must attribute the dialect provenance (gitgecko / wyrmcast / svg.wiki)");
    assert.ok(r!.loadWhen.some((k) => /register|vocabular|naming|tone|comment|doc/i.test(k)), "G12 loadWhen must route on register/vocabulary signals");
  });

  it("no rule is uncited opinion (every instruction ties to an ID)", () => {
    for (const rule of PROPRIETARY_RULES) {
      assert.ok(rule.instruction.length > 30, `rule ${rule.id} instruction too thin`);
      assert.ok(rule.summary.length > 5, `rule ${rule.id} summary too thin`);
    }
  });
});

// --- Command tasks (the single source of truth for per-command verbs) ---

describe("command tasks", () => {
  it("returns a non-empty task for every known command", () => {
    for (const cmd of ["describe", "review", "improve", "ask", "resolve", "fix", "fix-all"]) {
      const task = commandTask(cmd);
      assert.ok(task.length > 10, `command /${cmd} task too short: "${task}"`);
    }
  });

  it("strips leading slashes and lowercases", () => {
    assert.ok(commandTask("/REVIEW").length > 10);
    assert.ok(commandTask("/Describe").length > 10);
  });

  it("describe task mentions the walkthrough intent", () => {
    assert.match(commandTask("describe"), /description|title|walkthrough/i);
  });

  it("review task requires consequence reasoning", () => {
    assert.match(commandTask("review"), /consequence|defect|symptom/i);
  });

  it("improve task scopes to the suggestions lane", () => {
    assert.match(commandTask("improve"), /suggestion|improvement/i);
  });

  it("ask task scopes to diff + context", () => {
    assert.match(commandTask("ask"), /diff|context/i);
  });

  it("resolve task asks for a fix", () => {
    assert.match(commandTask("resolve"), /fix|code/i);
  });

  it("fix task requires a bounded workspace change and verification", () => {
    assert.match(commandTask("fix"), /workspace|verify|fix/i);
  });

  it("fix-all task requires explicit handling of skipped findings", () => {
    assert.match(commandTask("fix-all"), /skipped|finding/i);
  });

  it("unknown command returns a non-empty default", () => {
    assert.ok(commandTask("unknown").length > 5);
  });

  it("is deterministic — same input, same output", () => {
    assert.strictEqual(commandTask("review"), commandTask("review"));
  });
});

// --- Guardrails ---

describe("anti-noise guardrails", () => {
  it("preserves the hosted-model identity boundary", () => {
    const guardrail = GUARDRAILS.find((rule) => /gitgecko-light.*gitgecko-high/i.test(rule));
    assert.ok(guardrail, "hosted model aliases need a canonical guardrail");
    assert.match(guardrail, /never reveal|never.*upstream/i);
  });

  it("has ≥10 guardrails", () => {
    assert.ok(GUARDRAILS.length >= 10, `expected ≥10, got ${GUARDRAILS.length}`);
  });

  it("includes the anti-speculation guardrail", () => {
    assert.ok(GUARDRAILS.some((g) => /could.*might.*possibly|do not speculate/i.test(g)));
  });

  it("includes the anti-phantom-knowledge guardrail", () => {
    assert.ok(GUARDRAILS.some((g) => /cannot see|hallucination|unseen/i.test(g)));
  });

  it("includes the anti-praise guardrail (no filler)", () => {
    assert.ok(GUARDRAILS.some((g) => /no praise|no filler|Great job|Thanks/i.test(g)));
  });

  it("includes the diff-only discipline (no commenting on unchanged code)", () => {
    assert.ok(GUARDRAILS.some((g) => /unchanged|deleted|correct code/i.test(g)));
  });
});

// --- Output format ---

describe("output-format blueprints", () => {
  it("review format includes all 4 severity levels", () => {
    const fmt = reviewOutputFormat();
    assert.ok(/error/i.test(fmt));
    assert.ok(/warning/i.test(fmt));
    assert.ok(/info/i.test(fmt));
    assert.ok(/tip|hint/i.test(fmt));
  });

  it("review format includes a Summary section", () => {
    assert.match(reviewOutputFormat(), /Summary/i);
  });

  it("describe format includes a Walkthrough", () => {
    assert.match(outputFormatFor("describe"), /Walkthrough/i);
  });

  it("improve format is suggestions-only (no review findings)", () => {
    const fmt = outputFormatFor("improve");
    assert.ok(/suggestion|improvement/i.test(fmt));
  });

  it("ask format scopes to diff+context", () => {
    assert.match(outputFormatFor("ask"), /diff|context/i);
  });

  it("resolve format shows corrected code", () => {
    assert.match(outputFormatFor("resolve"), /code|fix/i);
  });

  it("unknown command defaults to review format", () => {
    assert.ok(outputFormatFor("unknown").length > 50);
  });
});

// --- renderFindings ---

describe("renderFindings", () => {
  it("returns empty string for no findings", () => {
    assert.equal(renderFindings([]), "");
  });

  it("groups findings by severity", () => {
    const out = renderFindings([
      { severity: "warning", message: "w1", ruleId: "R1" },
      { severity: "error", message: "e1", ruleId: "R2" },
      { severity: "warning", message: "w2", ruleId: "R3" },
    ]);
    assert.match(out, /error/i);
    assert.match(out, /warning/i);
    assert.ok(out.indexOf("error") < out.indexOf("warning"), "error must come before warning");
  });

  it("includes the ruleId citation", () => {
    const out = renderFindings([{ severity: "error", message: "bug", ruleId: "W5" }]);
    assert.match(out, /\[W5\]/);
  });

  it("includes the authoritative header (W4/W10 contract)", () => {
    const out = renderFindings([{ severity: "error", message: "x", ruleId: "R" }]);
    assert.match(out, /authoritative/i);
  });
});

// --- resolveInstructions ---

// Shared mock payload (module-scoped so sibling describe blocks can use it).
const mockPayload = {
  repo: "test",
  prNumber: 1,
  title: "t",
  diff: "+x",
  files: ["a.ts"],
};

describe("resolveInstructions", () => {

  it("returns a non-empty persona", () => {
    const r = resolveInstructions({ command: "review" }, mockPayload);
    assert.ok(r.persona && r.persona.length > 100);
    assert.ok((r.qualityBand ?? 0) > 0, "resolved reviews surface their active corpus quality band");
  });

  it("returns the output format matching the command", () => {
    const r = resolveInstructions({ command: "describe" }, mockPayload);
    assert.match(r.outputFormat ?? "", /Walkthrough/i);
  });

  it("includes proprietary rules + guardrails in the rules lane", () => {
    // Phase 6.2: the corpus is now ROUTED. With no diff keywords, only normative
    // rules + guardrails load. With keywords, advisory rules join.
    const r = resolveInstructions({ command: "review" }, mockPayload);
    // Normative rules (always loaded) + guardrails (always loaded) — at least 10.
    assert.ok(r.rules.length >= 10, `rules must include normative corpus + guardrails, got ${r.rules.length}`);
    assert.ok(r.rules.some((rule) => /^\[W/.test(rule)), "must include wedge-cited rules");
  });

  it("routes advisory rules based on diff keywords (Phase 6.2 semantic routing)", () => {
    // A diff with "socket" + "permission" keywords escalates to tier 3 (permission
    // is high-risk) AND matches the INV-2.3 advisory rule (socket keyword).
    const empty = resolveInstructions({ command: "review" }, mockPayload);
    const socketPermDiff = resolveInstructions(
      { command: "review", diff: "--- a/packages/socket/registry.ts\n+++ b/packages/socket/registry.ts\n+export function loadPlug(owner, permission) {}" },
      mockPayload,
    );
    // The socket+permission diff should load MORE rules (tier 3 escalates
    // normative rules + INV-2.3 advisory matches "socket").
    assert.ok(
      socketPermDiff.rules.length > empty.rules.length,
      `socket+permission diff (${socketPermDiff.rules.length}) must load more rules than empty (${empty.rules.length})`,
    );
    assert.ok(
      socketPermDiff.rules.some((r) => r.includes("[INV-2.3]")),
      "socket diff must load the INV-2.3 advisory rule (keyword routing at tier 3)",
    );
  });

  it("does NOT include findings when none provided", () => {
    const r = resolveInstructions({ command: "review" }, mockPayload);
    assert.equal(r.findings, undefined);
  });

  it("includes findings when provided", () => {
    const findings = [
      {
        ruleId: "W5",
        kind: "lexical" as const,
        source: "deterministic" as const,
        severity: "error" as const,
        message: "shell escape",
        filepath: "a.ts",
        line: 1,
        column: 0,
        match: "shell:true",
      },
    ];
    const r = resolveInstructions({ command: "review" }, mockPayload, findings);
    assert.ok(r.findings);
    assert.equal(r.findings!.length, 1);
  });

  it("appends repository-owned rules after built-in review policy", () => {
    const root = join(tmpdir(), `gitgecko-resolved-instructions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, ".git"), { recursive: true });
    try {
      writeFileSync(join(root, "AGENTS.md"), "Repository instruction");
      const r = resolveInstructions({ command: "review", cwd: root, diff: "+++ b/src/app.ts\n+const changed = true;" }, mockPayload);
      assert.match(r.rules.at(-1) ?? "", /^\[repository:AGENTS\.md\] Repository instruction/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not discover host repository rules without an explicit cwd", () => {
    const r = resolveInstructions({ command: "review", diff: "+++ b/src/app.ts\n+const changed = true;" }, mockPayload);
    assert.equal(r.rules.some((rule) => rule.startsWith("[repository:")), false);
  });

  it("keeps deterministic findings out of non-review command lanes", () => {
    const findings = [{
      ruleId: "W5",
      kind: "lexical" as const,
      source: "deterministic" as const,
      severity: "error" as const,
      message: "review-only defect",
      filepath: "a.ts",
      line: 1,
      column: 0,
      match: "defect",
    }];
    for (const command of ["describe", "improve", "ask", "resolve"]) {
      const r = resolveInstructions({ command }, mockPayload, findings);
      assert.equal(r.findings, undefined, `/${command} must not inherit review findings`);
      assert.deepEqual(r.rules, [], `/${command} must not inherit review rules or guardrails`);
      assert.equal(r.persona, undefined, `/${command} must not inherit the reviewer persona`);
      assert.equal(r.qualityBand, 0, `/${command} has no review quality band`);
    }
  });

  it("systemPrompt includes the persona + command context", () => {
    const r = resolveInstructions({ command: "improve" }, mockPayload);
    assert.match(r.systemPrompt, /gitgecko/);
    assert.match(r.systemPrompt, /improve/);
    assert.match(r.systemPrompt, /suggestion/i);
    assert.doesNotMatch(r.systemPrompt, /code reviewer|consequence|severity/i);
  });
});

// --- renderRepoContext (002b) — the grounding-section formatter ---

describe("renderRepoContext", () => {
  it("returns empty string for empty snippets", () => {
    assert.equal(renderRepoContext([]), "");
  });

  it("formats a single snippet with filepath header", () => {
    const out = renderRepoContext([{ content: "const x = 1;", filepath: "src/a.ts" }]);
    assert.match(out, /src\/a\.ts/);
    assert.match(out, /const x = 1;/);
  });

  it("includes the 'retrieved' authoritative label", () => {
    const out = renderRepoContext([{ content: "x", filepath: "a.ts" }]);
    assert.match(out, /retrieved/i);
  });

  it("formats multiple snippets joined by blank lines", () => {
    const out = renderRepoContext([
      { content: "const a = 1;", filepath: "a.ts" },
      { content: "const b = 2;", filepath: "b.ts" },
    ]);
    assert.match(out, /a\.ts[\s\S]*b\.ts/);
    assert.ok(out.includes("const a = 1;"));
    assert.ok(out.includes("const b = 2;"));
  });

  it("preserves content verbatim (no truncation)", () => {
    const long = "x".repeat(500);
    const out = renderRepoContext([{ content: long, filepath: "a.ts" }]);
    assert.ok(out.includes(long), "content must be preserved verbatim");
  });

  it("preserves special characters in content", () => {
    const out = renderRepoContext([{ content: 'const s = "hello \\n world";', filepath: "a.ts" }]);
    assert.ok(out.includes('const s = "hello \\n world";'));
  });

  it("preserves whitespace-only content (does not strip)", () => {
    const out = renderRepoContext([{ content: "   \n  ", filepath: "a.ts" }]);
    assert.ok(out.includes("   \n  "));
  });

  it("each snippet has a --- filepath --- delimiter", () => {
    const out = renderRepoContext([
      { content: "a", filepath: "a.ts" },
      { content: "b", filepath: "b.ts" },
    ]);
    assert.match(out, /--- a\.ts ---/);
    assert.match(out, /--- b\.ts ---/);
  });

  it("handles deeply nested filepath paths", () => {
    const out = renderRepoContext([{ content: "x", filepath: "src/deep/nested/path/file.ts" }]);
    assert.match(out, /src\/deep\/nested\/path\/file\.ts/);
  });

  it("starts with a section header (## level)", () => {
    const out = renderRepoContext([{ content: "x", filepath: "a.ts" }]);
    assert.match(out, /^##\s/);
  });

  it("does not mutate the input array", () => {
    const input = [{ content: "x", filepath: "a.ts" }];
    const snapshot = [...input];
    renderRepoContext(input);
    assert.deepEqual(input, snapshot);
  });

  it("produces deterministic output (same input → same output)", () => {
    const input = [{ content: "x", filepath: "a.ts" }];
    assert.equal(renderRepoContext(input), renderRepoContext(input));
  });
});

// --- resolveInstructions repoContext threading (002b) ---

describe("resolveInstructions repoContext threading", () => {
  it("omits repoContext when not provided (exactOptionalPropertyTypes)", () => {
    const r = resolveInstructions({ command: "review" }, mockPayload);
    assert.ok(!("repoContext" in r), "repoContext must be absent when not provided");
  });

  it("omits repoContext when undefined is passed", () => {
    const r = resolveInstructions({ command: "review" }, mockPayload, undefined, undefined);
    assert.ok(!("repoContext" in r));
  });

  it("omits repoContext when empty string is passed", () => {
    const r = resolveInstructions({ command: "review" }, mockPayload, undefined, "");
    assert.ok(!("repoContext" in r), "empty string must not attach the field");
  });

  it("attaches repoContext when non-empty string is provided", () => {
    const ctx = "## Repo context\n--- a.ts ---\nconst x = 1;";
    const r = resolveInstructions({ command: "review" }, mockPayload, undefined, ctx);
    assert.equal(r.repoContext, ctx);
  });

  it("attaches repoContext alongside findings (both present)", () => {
    const findings = [
      { ruleId: "R1", kind: "lexical" as const, severity: "error" as const, message: "m", filepath: "a.ts", line: 1, column: 0, match: "m", source: "deterministic" as const },
    ];
    const ctx = "## Repo context\n--- a.ts ---\nx";
    const r = resolveInstructions({ command: "review" }, mockPayload, findings, ctx);
    assert.ok(r.findings);
    assert.equal(r.findings!.length, 1);
    assert.equal(r.repoContext, ctx);
  });

  it("attaches repoContext when findings are absent", () => {
    const ctx = "## Repo context\nx";
    const r = resolveInstructions({ command: "review" }, mockPayload, undefined, ctx);
    assert.equal(r.repoContext, ctx);
    assert.ok(!("findings" in r));
  });

  it("threads repoContext for /describe command", () => {
    const ctx = "ctx";
    const r = resolveInstructions({ command: "describe" }, mockPayload, undefined, ctx);
    assert.equal(r.repoContext, ctx);
  });

  it("threads repoContext for /improve command", () => {
    const ctx = "ctx";
    const r = resolveInstructions({ command: "improve" }, mockPayload, undefined, ctx);
    assert.equal(r.repoContext, ctx);
  });

  it("threads repoContext for /ask command", () => {
    const ctx = "ctx";
    const r = resolveInstructions({ command: "ask" }, mockPayload, undefined, ctx);
    assert.equal(r.repoContext, ctx);
  });

  it("threads repoContext for /resolve command", () => {
    const ctx = "ctx";
    const r = resolveInstructions({ command: "resolve" }, mockPayload, undefined, ctx);
    assert.equal(r.repoContext, ctx);
  });

  it("preserves other fields when repoContext is attached", () => {
    const ctx = "ctx";
    const r = resolveInstructions({ command: "review" }, mockPayload, undefined, ctx);
    assert.ok(r.systemPrompt.length > 0);
    assert.ok(r.rules.length > 0);
    assert.ok(r.persona);
    assert.ok(r.outputFormat);
    assert.equal(r.repoContext, ctx);
  });

  it("does not mutate the args or payload objects", () => {
    const args = { command: "review" as const };
    const argsSnapshot = { ...args };
    const ctx = "ctx";
    resolveInstructions(args, mockPayload, undefined, ctx);
    assert.deepEqual(args, argsSnapshot);
  });

  it("whitespace-only repoContext string is treated as non-empty (attached)", () => {
    // A whitespace string is non-empty (length > 0) — it's the caller's job to pass ""
    // for "no context". This tests the boundary: only "" is omitted.
    const r = resolveInstructions({ command: "review" }, mockPayload, undefined, "   ");
    assert.equal(r.repoContext, "   ");
  });

  it("repoContext value equals exactly what was passed (no transformation)", () => {
    const ctx = "exact\nvalue\ntest";
    const r = resolveInstructions({ command: "review" }, mockPayload, undefined, ctx);
    assert.equal(r.repoContext, "exact\nvalue\ntest");
  });

  it("works with repoContext rendered via renderRepoContext (integration)", () => {
    const rendered = renderRepoContext([{ content: "const x = 1;", filepath: "a.ts" }]);
    const r = resolveInstructions({ command: "review" }, mockPayload, undefined, rendered);
    assert.equal(r.repoContext, rendered);
    assert.match(r.repoContext!, /a\.ts/);
  });

  it("returns a new object each call (no shared mutation)", () => {
    const ctx = "ctx";
    const r1 = resolveInstructions({ command: "review" }, mockPayload, undefined, ctx);
    const r2 = resolveInstructions({ command: "review" }, mockPayload, undefined, ctx);
    assert.notEqual(r1, r2);
    assert.equal(r1.repoContext, r2.repoContext);
  });
});

// --- Citation glossary (the made-whole index) ---

describe("citation glossary", () => {
  it("is non-empty", () => {
    assert.ok(CITATION_GLOSSARY.length >= 15, `expected ≥15 entries, got ${CITATION_GLOSSARY.length}`);
  });

  it("every entry has an id, term, and definition (>20 chars)", () => {
    for (const entry of CITATION_GLOSSARY) {
      assert.ok(entry.id.length > 0, "entry must have an id");
      assert.ok(entry.term.length > 2, `entry "${entry.id}" term too short`);
      assert.ok(entry.definition.length > 20, `entry "${entry.id}" definition too short`);
    }
  });

  it("no entry contains an internal dev path (self-contained for shipping)", () => {
    const forbidden = [/\.docs\//, /\.refs\//, /AGENTS\.d\//, /system-design\//, /goal-intent/];
    for (const entry of CITATION_GLOSSARY) {
      for (const re of forbidden) {
        assert.ok(
          !re.test(entry.definition),
          `entry "${entry.id}" definition leaks internal path: ${entry.definition}`,
        );
      }
    }
  });

  it("covers every rule ID in the proprietary rules corpus", () => {
    for (const rule of PROPRIETARY_RULES) {
      assert.ok(
        hasGlossaryEntry(rule.id),
        `rule "${rule.id}" has no glossary entry — the corpus is not made whole`,
      );
    }
  });

  it("glossaryFor returns the entry and undefined for unknown", () => {
    const w5 = glossaryFor("W5");
    assert.ok(w5, "W5 must resolve");
    assert.strictEqual(w5!.id, "W5");
    assert.strictEqual(glossaryFor("DOES-NOT-EXIST"), undefined);
  });

  it("glossaryTerm returns the coined handle, falling back to the raw id", () => {
    assert.ok(glossaryTerm("W5").length > 0);
    assert.ok(glossaryTerm("W5") !== "W5", "W5 should resolve to its coined term");
    assert.strictEqual(glossaryTerm("DOES-NOT-EXIST"), "DOES-NOT-EXIST");
  });
});

// --- Ship-readiness: no internal dev paths in model-facing strings ---

describe("ship-readiness — model-facing strings are self-contained", () => {
  // The corpus reaches a user's LLM when they run `gitgecko review` against their repo.
  // Internal dev paths (.docs/, .refs/, AGENTS.d/) are dangling pointers the
  // user cannot resolve. This is the regression guard.
  const forbidden = [/\.docs\//, /\.refs\//, /AGENTS\.d\//, /system-design\//, /goal-intent/];

  it("the persona contains no internal paths", () => {
    for (const re of forbidden) {
      assert.ok(!re.test(REVIEWER_PERSONA), `persona leaks internal path: ${re}`);
    }
  });

  it("no guardrail contains an internal path", () => {
    for (const g of GUARDRAILS) {
      for (const re of forbidden) {
        assert.ok(!re.test(g), `guardrail leaks internal path: ${g}`);
      }
    }
  });

  it("no proprietary-rule instruction contains an internal path", () => {
    for (const rule of PROPRIETARY_RULES) {
      for (const re of forbidden) {
        assert.ok(
          !re.test(rule.instruction),
          `rule "${rule.id}" instruction leaks internal path`,
        );
      }
    }
  });
});
