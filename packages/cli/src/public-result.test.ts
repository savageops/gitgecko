import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OrchestratorResult } from "./orchestrator.js";
import { toPublicCliResult } from "./public-result.js";

const artifact = {
  schemaVersion: "review.v2",
  runId: "run_fixture",
  status: "succeeded",
  title: "Fixture",
  summary: "Fixture review.",
  mergeable: true,
  blastRadius: "low",
  findings: [],
  files: [],
  pathway: { family: "native", binary: "codex" },
  rawOutput: "review complete",
} satisfies OrchestratorResult["artifact"];

describe("public CLI result", () => {
  it("removes provider stderr before JSON serialization", () => {
    const result = toPublicCliResult({
      success: true,
      output: "review complete",
      artifact,
      pathwayResolution: { family: "native", binary: "codex", reason: "explicit" },
      command: "review",
      diagnostics: { stderr: "provider warning", exitCode: 0, signal: null },
    });

    assert.deepEqual(result.diagnostics, { exitCode: 0, signal: null });
    assert.doesNotMatch(JSON.stringify(result), /provider warning/u);
  });

  it("omits diagnostics when stderr was the only private field", () => {
    const result = toPublicCliResult({
      success: false,
      output: "failed",
      artifact,
      pathwayResolution: { family: "native", binary: "claude", reason: "explicit" },
      command: "review",
      diagnostics: { stderr: "raw provider failure" },
    });

    assert.equal("diagnostics" in result, false);
  });

  it("omits internal traces so prompts and repository instructions never enter public JSON", () => {
    const result = toPublicCliResult({
      success: true,
      output: "review complete",
      artifact,
      pathwayResolution: { family: "native", binary: "codex", reason: "explicit" },
      command: "review",
      trace: [{ step: "review", command: "review", prompt: "private repository instruction", output: "review complete", source: "llm" }],
    });

    assert.equal("trace" in result, false);
    assert.doesNotMatch(JSON.stringify(result), /private repository instruction/u);
  });
});
