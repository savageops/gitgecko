import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createReviewArtifact, createReviewArtifactV2, toReviewArtifactV1 } from "./artifact.js";

describe("review artifact", () => {
  it("parses repeated headings by position without indexOf duplicate-line bugs", () => {
    const artifact = createReviewArtifact({
      runId: "run-1",
      title: "Repeated output",
      output: [
        "## Summary",
        "The change is safe.",
        "## warning",
        "- first warning",
        "## warning",
        "- second warning",
      ].join("\n"),
      success: true,
      pathway: { family: "native" },
    });

    assert.equal(artifact.summary, "The change is safe.");
    assert.deepEqual(artifact.findings.map((finding) => finding.message), ["first warning", "second warning"]);
  });

  it("marks failed execution as non-mergeable and preserves files", () => {
    const artifact = createReviewArtifact({
      runId: "run-2",
      title: "Failed",
      output: "backend unavailable",
      success: false,
      files: ["src/app.ts"],
      pathway: { family: "native-loop" },
    });

    assert.equal(artifact.status, "failed");
    assert.equal(artifact.mergeable, false);
    assert.deepEqual(artifact.files, ["src/app.ts"]);
  });

  it("places deterministic findings before model findings without prose reconstruction", () => {
    const artifact = createReviewArtifactV2({
      runId: "run-3",
      title: "Structured",
      output: "## Warning\n- model warning",
      success: true,
      deterministicFindings: [{
        ruleId: "no-eval",
        kind: "lexical",
        source: "deterministic",
        severity: "error",
        message: "Avoid eval.",
        filepath: "src/app.ts",
        line: 4,
        column: 2,
        match: "eval(input)",
      }],
      pathway: { family: "native-loop" },
    });

    assert.equal(artifact.schemaVersion, "review.v2");
    assert.equal(artifact.findings[0]?.source, "deterministic");
    assert.equal(artifact.findings[0]?.ruleId, "no-eval");
    assert.equal(artifact.findings[0]?.evidence, "eval(input)");
    assert.equal(artifact.findings[1]?.source, "llm");
    assert.equal(artifact.mergeable, false);
  });

  it("keeps raw output only in v2 and adapts file changes for v1", () => {
    const artifact = createReviewArtifactV2({
      runId: "run-4",
      title: "Deleted file",
      output: "Review complete.",
      success: true,
      diff: [
        "diff --git a/src/old.ts b/src/old.ts",
        "deleted file mode 100644",
        "--- a/src/old.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-legacy();",
      ].join("\n"),
      pathway: { family: "native" },
    });

    assert.equal(artifact.rawOutput, "Review complete.");
    assert.equal(artifact.files[0]?.status, "deleted");
    assert.deepEqual(toReviewArtifactV1(artifact).files, ["src/old.ts"]);
  });

  it("preserves prose findings emitted as bold titles under severity headings", () => {
    const artifact = createReviewArtifactV2({
      runId: "run-5",
      title: "Provider format",
      output: [
        "## Summary",
        "Two defects were found.",
        "## 🔴 error",
        "**Secret exported as named module constant — blast radius expansion.**",
        "The export exposes the secret to every consumer.",
        "**Fix:** Keep the secret behind a server-only accessor.",
        "## 🟡 warning",
        "**Unguarded `string | undefined` export.**",
        "The environment value can be absent.",
      ].join("\n"),
      success: true,
      pathway: { family: "native-loop" },
    });

    assert.deepEqual(
      artifact.findings.map(({ severity, message }) => ({ severity, message })),
      [
        { severity: "error", message: "Secret exported as named module constant — blast radius expansion." },
        { severity: "warning", message: "Unguarded `string | undefined` export." },
      ],
    );
    assert.equal(artifact.mergeable, false);
    assert.equal(artifact.blastRadius, "medium");
  });

  it("keeps linked-requirement assessments structured and defaults missing declarations to unverified", () => {
    const artifact = createReviewArtifactV2({
      runId: "run-6",
      title: "Linked requirements",
      output: [
        "## Linked requirement assessment",
        "- #42 | satisfied | src/auth.ts:14 rejects expired tokens.",
      ].join("\n"),
      success: true,
      linkedIssues: [
        { number: 42, title: "Protect login", body: "Reject expired tokens", url: "https://github.com/acme/repo/issues/42" },
        { number: 43, title: "Log audit events", body: "Record failed logins", url: "https://github.com/acme/repo/issues/43" },
      ],
      pathway: { family: "native" },
    });

    assert.deepEqual(artifact.linkedRequirements?.map(({ number, status, evidence }) => ({ number, status, evidence })), [
      { number: 42, status: "satisfied", evidence: "src/auth.ts:14 rejects expired tokens." },
      { number: 43, status: "unverified", evidence: "No structured assessment returned by the review provider." },
    ]);
    assert.equal(artifact.mergeable, false, "an unverified authoritative requirement must block mergeability");
  });

  it("allows merge only when every linked requirement is satisfied", () => {
    const artifact = createReviewArtifactV2({
      runId: "run-requirements-satisfied",
      title: "Linked requirements",
      output: [
        "## Linked requirement assessment",
        "- #42 | satisfied | src/auth.ts:14 rejects expired tokens.",
        "- #43 | satisfied | src/audit.ts:20 records failed logins.",
      ].join("\n"),
      success: true,
      linkedIssues: [
        { number: 42, title: "Protect login", body: "Reject expired tokens", url: "https://github.com/acme/repo/issues/42" },
        { number: 43, title: "Log audit events", body: "Record failed logins", url: "https://github.com/acme/repo/issues/43" },
      ],
      pathway: { family: "native" },
    });

    assert.equal(artifact.mergeable, true);
  });

  it("blocks merge when a linked requirement is explicitly unmet", () => {
    const artifact = createReviewArtifactV2({
      runId: "run-requirement-unmet",
      title: "Linked requirement",
      output: "## Linked requirement assessment\n- #42 | unmet | No expiry check appears in the diff.",
      success: true,
      linkedIssues: [
        { number: 42, title: "Protect login", body: "Reject expired tokens", url: "https://github.com/acme/repo/issues/42" },
      ],
      pathway: { family: "native" },
    });

    assert.equal(artifact.mergeable, false);
  });

  it("records runtime receipts and blocks merge when a required check fails", () => {
    const artifact = createReviewArtifactV2({
      runId: "run-7",
      title: "Runtime validation",
      output: "## Summary\nReview complete.",
      success: true,
      runtimeChecks: {
        allRequiredPassed: false,
        receipts: [{
          id: "unit",
          label: "Unit tests",
          required: true,
          status: "failed",
          command: "pnpm",
          exitCode: 1,
          durationMs: 50,
          stdout: "",
          stderr: "1 test failed",
          outputTruncated: false,
          backend: { id: "subprocess", isolated: false },
        }],
      },
      pathway: { family: "native" },
    });
    assert.equal(artifact.mergeable, false);
    assert.equal(artifact.runtimeChecks?.receipts[0]?.stderr, "1 test failed");
  });
});
