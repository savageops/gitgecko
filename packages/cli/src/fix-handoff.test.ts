import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFixAllHandoff } from "./fix-handoff.js";

const result = {
  artifact: {
    schemaVersion: "review.v2",
    runId: "run_1",
    rawOutput: "do not forward this provider prose",
    findings: [
      { fingerprint: "one", severity: "error", message: "Reject zero denominators.", disposition: "open", source: "deterministic", category: "lexical", file: "divide.ts", line: 2, evidence: "right === 0" },
      { fingerprint: "two", severity: "info", message: "Already fixed.", disposition: "fixed", source: "llm", category: "model-review" },
    ],
  },
};

describe("fix-all review artifact handoff", () => {
  it("uses only open review.v2 findings and preserves their location", () => {
    const handoff = buildFixAllHandoff(JSON.stringify(result));
    assert.match(handoff, /Reject zero denominators/u);
    assert.match(handoff, /divide\.ts:2/u);
    assert.doesNotMatch(handoff, /Already fixed/u);
    assert.doesNotMatch(handoff, /do not forward this provider prose/u);
  });

  it("accepts a bare review.v2 artifact as well as public CLI output", () => {
    assert.match(buildFixAllHandoff(JSON.stringify(result.artifact)), /run_1/u);
  });

  it("rejects malformed, non-review, or finding-free input", () => {
    assert.throws(() => buildFixAllHandoff("not json"), /valid JSON/u);
    assert.throws(() => buildFixAllHandoff(JSON.stringify({ artifact: { schemaVersion: "review.v1", findings: [] } })), /review\.v2/u);
    assert.throws(() => buildFixAllHandoff(JSON.stringify({ artifact: { schemaVersion: "review.v2", findings: [] } })), /open findings/u);
  });

  it("bounds a large artifact so a handoff remains reviewable", () => {
    const large = {
      artifact: {
        schemaVersion: "review.v2",
        runId: "run_many",
        findings: Array.from({ length: 30 }, (_, index) => ({
          fingerprint: String(index), severity: "warning", message: `Finding ${index}`, disposition: "open", source: "llm", category: "model-review",
        })),
      },
    };
    const handoff = buildFixAllHandoff(JSON.stringify(large));
    assert.match(handoff, /first 25/u);
    assert.doesNotMatch(handoff, /Finding 25/u);
  });
});
