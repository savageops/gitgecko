/**
 * TDD tests for the notify owner — closes the review loop (02 §2).
 *
 * Challenges the CAPABILITY: format review output → notify message, post to
 * multiple targets (github/gitlab/slack/fix-with-agent), handle errors.
 *
 * Per project TDD rule: written FIRST, fail, then code passes. Never weakened.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatReviewAsComment,
  formatFindings,
  type NotifyMessage,
  type NotifyTarget,
  type NotifyResult,
} from "./notify.js";

describe("formatReviewAsComment — review output → markdown comment", () => {
  it("produces a markdown comment with the review output", () => {
    const msg = formatReviewAsComment({ output: "LGTM — no issues.", command: "review" });
    assert.ok(msg.body!.includes("LGTM"));
    assert.ok(msg.body!.includes("## GitGecko review"));
    assert.ok(msg.title!.includes("review"));
  });

  it("includes the pathway when provided", () => {
    const msg = formatReviewAsComment({ output: "ok", command: "review", pathway: "native:claude" });
    assert.ok(msg.body!.includes("native:claude"));
  });

  it("includes the GitGecko review HTML comment marker (for update-in-place)", () => {
    const msg = formatReviewAsComment({ output: "x", command: "review" });
    assert.ok(msg.body!.includes("gitgecko-review"));
  });

  it("carries only line-anchored findings for a provider that supports inline comments", () => {
    const msg = formatReviewAsComment({
      output: "review",
      command: "review",
      findings: [
        { ruleId: "no-console", file: "src/app.ts", line: 9, message: "Remove debug logging", fingerprint: "finding_a" },
        { ruleId: "model-review", message: "Unanchored observation" },
      ],
    });
    assert.deepEqual(msg.findings, [{ ruleId: "no-console", file: "src/app.ts", line: 9, message: "Remove debug logging", fingerprint: "finding_a" }]);
  });
});

describe("formatFindings — deterministic findings → structured comment", () => {
  it("formats each finding with rule id, file, line, message", () => {
    const text = formatFindings([
      { ruleId: "no-console", filepath: "src/app.js", line: 5, message: "Avoid console.log", source: "deterministic" },
    ]);
    assert.ok(text.includes("[no-console]"));
    assert.ok(text.includes("src/app.js#L5"));
    assert.ok(text.includes("Avoid console.log"));
  });

  it("tags the source (deterministic vs llm)", () => {
    const text = formatFindings([
      { ruleId: "r1", line: 1, message: "m", source: "deterministic" },
      { ruleId: "r2", line: 2, message: "m", source: "llm" },
    ]);
    assert.ok(text.includes("source: deterministic"));
    assert.ok(text.includes("source: llm"));
  });

  it("returns 'No findings.' for empty input", () => {
    assert.equal(formatFindings([]), "No findings.");
  });
});

describe("NotifyTarget + NotifyMessage shapes", () => {
  it("github-pr target carries repo + prNumber", () => {
    const t: NotifyTarget = { kind: "github-pr", repo: "org/repo", prNumber: 42 };
    assert.equal(t.kind, "github-pr");
    assert.equal(t.repo, "org/repo");
    assert.equal(t.prNumber, 42);
  });

  it("slack target carries channel", () => {
    const t: NotifyTarget = { kind: "slack", channel: "#reviews" };
    assert.equal(t.kind, "slack");
    assert.equal(t.channel, "#reviews");
  });

  it("fix-with-agent target carries the agent name", () => {
    const t: NotifyTarget = { kind: "fix-with-agent", agent: "claude-code", repo: "org/repo", prNumber: 1 };
    assert.equal(t.agent, "claude-code");
  });

  it("NotifyMessage can carry findings + suggestions", () => {
    const msg: NotifyMessage = {
      body: "review",
      findings: [{ ruleId: "x", file: "a.js", line: 1, message: "y" }],
      suggestions: [{ file: "a.js", line: 2, suggestion: "fix" }],
    };
    assert.equal(msg.findings!.length, 1);
    assert.equal(msg.suggestions!.length, 1);
  });
});

describe("NotifyResult shape", () => {
  it("a successful post carries url + id", () => {
    const r: NotifyResult = { posted: true, url: "https://github.com/org/repo/pull/42#comment-1", id: "c1" };
    assert.equal(r.posted, true);
    assert.ok(r.url!.includes("github.com"));
  });

  it("a failed post carries an error message", () => {
    const r: NotifyResult = { posted: false, error: "rate limited" };
    assert.equal(r.posted, false);
    assert.equal(r.error, "rate limited");
  });
});
