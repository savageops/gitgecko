import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateCliDiff } from "./deterministic.js";

describe("CLI deterministic review lane", () => {
  it("surfaces baseline findings before the agent and maps them to destination lines", async () => {
    const findings = await evaluateCliDiff([
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -8,0 +9,2 @@",
      "+const unsafe = eval(input);",
      "+const stillUnsafe = eval(other);",
    ].join("\n"));

    assert.ok(findings.some((finding) => finding.ruleId === "baseline-no-eval"));
    assert.ok(findings.every((finding) => finding.source === "deterministic"));
    assert.ok(findings.some((finding) => finding.line === 9));
  });

  it("does not manufacture findings for an empty diff", async () => {
    assert.deepEqual(await evaluateCliDiff("\n  \n"), []);
  });
});
