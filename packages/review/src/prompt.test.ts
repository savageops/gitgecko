import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentRunContext } from "./agent.js";
import { REVIEW_MISSIONS } from "./missions.js";
import { buildReviewPrompt } from "./prompt.js";

const improveContext: AgentRunContext = {
  cwd: process.cwd(),
  permission: "read-only",
  persistence: "ephemeral",
  payload: { repo: "o/r", prNumber: 1, title: "Improve", diff: "+const value = input;", files: ["src/value.ts"] },
  mcpServerUrl: "http://localhost:0",
  tmpdir: process.cwd(),
  subagentDeniedTools: [],
  instructions: {
    systemPrompt: "You are gitgecko's code-change assistant.\n\nCommand: /improve",
    rules: [],
    outputFormat: "Provide code improvement suggestions only - no summary, no review findings.",
    qualityBand: 0,
  },
  toolState: { calls: [] },
  apiToken: "",
};

describe("buildReviewPrompt command lanes", () => {
  it("keeps /improve free of reviewer policy", () => {
    const prompt = buildReviewPrompt(improveContext);

    assert.match(prompt, /Command: \/improve/);
    assert.match(prompt, /suggestions only/i);
    assert.doesNotMatch(prompt, /## Rules|## Deterministic findings|code reviewer|severity-tagged/i);
  });

  it("keeps the diff and repository identity available to /improve", () => {
    const prompt = buildReviewPrompt(improveContext);

    assert.match(prompt, /PR #1: Improve/);
    assert.match(prompt, /\+const value = input;/);
  });

  it("renders source-authoritative linked requirements for review assessment", () => {
    const prompt = buildReviewPrompt({
      ...improveContext,
      payload: {
        ...improveContext.payload,
        linkedIssues: [{
          number: 42,
          title: "Protect login",
          body: "- [ ] reject expired token",
          url: "https://github.com/acme/repo/issues/42",
        }],
      },
    });

    assert.match(prompt, /## Linked requirements/);
    assert.match(prompt, /#42 Protect login: - \[ \] reject expired token/);
  });

  it("renders bounded runtime check evidence without making the check executor an agent tool", () => {
    const prompt = buildReviewPrompt({
      ...improveContext,
      payload: {
        ...improveContext.payload,
        runtimeChecks: {
          allRequiredPassed: false,
          receipts: [{
            id: "unit",
            label: "Unit tests",
            required: true,
            status: "failed",
            command: "pnpm",
            exitCode: 1,
            durationMs: 42,
            stdout: "",
            stderr: "one assertion failed",
            outputTruncated: false,
            backend: { id: "subprocess", isolated: false },
          }],
        },
      },
    });

    assert.match(prompt, /## Runtime validation/);
    assert.match(prompt, /required unit: failed \(exit 1, 42ms\) — one assertion failed/);
  });

  it("threads a bounded review mission through the shared provider prompt", () => {
    const prompt = buildReviewPrompt({
      ...improveContext,
      payload: { ...improveContext.payload, mission: REVIEW_MISSIONS.security },
    });
    assert.match(prompt, /## Review mission: security/u);
    assert.match(prompt, /trust boundaries/u);
    assert.match(prompt, /deterministic findings remain authoritative/u);
  });
});
