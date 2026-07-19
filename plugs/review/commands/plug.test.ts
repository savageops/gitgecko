/**
 * TDD tests for the review-commands plug (finding 18.2 / 18.4).
 *
 * THE CAPABILITY: the command-handler leaf must (a) honor a caller-supplied
 * deny list rather than hardcoding [], and (b) thread instructions (incl.
 * deterministic findings) into the agent run. Before 18.2/18.4 the leaf rebuilt
 * its own agent.run context with subagentDeniedTools: [] and a fresh
 * instructions object, dropping both the W5 deny list and the W4/W10 findings.
 *
 * Per project TDD rule: written FIRST, challenges capability, never degraded.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCommand, resolveReviewCwd } from "./plug.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandInput } from "@gitgecko/review";
import type { Agent, AgentRunContext, AgentResult, ReviewPayload, ResolvedInstructions } from "@gitgecko/review";
import { buildReviewPrompt } from "@gitgecko/review";

const fakePayload: ReviewPayload = {
  repo: "o/r",
  prNumber: 1,
  title: "t",
  diff: "+x",
  files: ["a.ts"],
};

/** Build a capturing Agent that records the AgentRunContext it received. */
const capturingAgent = (capture: { ctx?: AgentRunContext }): Agent => ({
  name: "capture",
  install: async () => "capture",
  run: async (ctx: AgentRunContext): Promise<AgentResult> => {
    capture.ctx = ctx;
    return { success: true, output: "reviewed" };
  },
});

describe("review-commands plug - native cwd boundary", () => {
  it("normalizes an existing review directory", () => {
    assert.equal(resolveReviewCwd("."), process.cwd());
  });

  it("rejects a missing review directory", () => {
    assert.throws(() => resolveReviewCwd(join(tmpdir(), "gitgecko-missing-cwd")), /does not exist/u);
  });

  it("rejects a file as a review directory", () => {
    const root = mkdtempSync(join(tmpdir(), "gitgecko-cwd-file-"));
    const file = join(root, "not-a-directory.txt");
    try {
      writeFileSync(file, "fixture");
      assert.throws(() => resolveReviewCwd(file), /not a directory/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not invoke the provider when cwd validation fails", async () => {
    let invoked = false;
    const agent: Agent = {
      name: "capture",
      install: async () => "capture",
      run: async () => { invoked = true; return { success: true, output: "unexpected" }; },
    };
    await assert.rejects(
      () => runCommand({ command: "review", payload: fakePayload, agent, cwd: join(tmpdir(), "gitgecko-missing-provider-cwd") }),
      /does not exist/u,
    );
    assert.equal(invoked, false);
  });
});

describe("review-commands plug — deny list + findings threading (18.2 / 18.4)", () => {
  it("preserves an agent failure message as user-visible command output", async () => {
    const failedAgent: Agent = {
      name: "unavailable",
      install: async () => "unavailable",
      run: async () => ({ success: false, error: "No model configured" }),
    };

    const result = await runCommand({ command: "review", payload: fakePayload, agent: failedAgent });
    assert.equal(result.success, false);
    assert.equal(result.output, "No model configured");
  });

  it("uses the error when a failed provider returns an empty output string", async () => {
    const failedAgent: Agent = {
      name: "unavailable",
      install: async () => "unavailable",
      run: async () => ({ success: false, output: "", error: "401 Unauthorized", failure: "auth" }),
    };
    const result = await runCommand({ command: "review", payload: fakePayload, agent: failedAgent });
    assert.equal(result.output, "401 Unauthorized");
    assert.equal(result.failure, "auth");
  });

  it("honors the caller's subagentDeniedTools (not a hardcoded empty list)", async () => {
    const capture: { ctx?: AgentRunContext } = {};
    const input: CommandInput = {
      command: "review",
      payload: fakePayload,
      agent: capturingAgent(capture),
      subagentDeniedTools: ["Bash", "Edit"],
    };

    await runCommand(input);

    assert.ok(capture.ctx, "agent.run must be called");
    assert.deepEqual(
      [...capture.ctx!.subagentDeniedTools].sort(),
      ["Bash", "Edit"],
      "the deny list must flow from CommandInput into the agent run (18.2)",
    );
  });

  it("defaults to an empty deny list when none provided (read-only review)", async () => {
    const capture: { ctx?: AgentRunContext } = {};
    const input: CommandInput = {
      command: "review",
      payload: fakePayload,
      agent: capturingAgent(capture),
    };

    await runCommand(input);

    assert.ok(capture.ctx);
    assert.deepEqual(
      [...capture.ctx!.subagentDeniedTools],
      [],
      "absent deny list defaults to [] (no mutates tools → no denies)",
    );
  });

  it("threads deterministic findings from input.instructions into the agent run (18.4)", async () => {
    const capture: { ctx?: AgentRunContext } = {};
    const instructions: ResolvedInstructions = {
      systemPrompt: "gitgecko /review",
      rules: ["[W5] no shell injection"],
      findings: [
        {
          ruleId: "no-eval",
          kind: "lexical",
          source: "deterministic",
          severity: "error",
          message: "eval() is forbidden",
          filepath: "a.ts",
          line: 1,
          column: 0,
          match: "eval(",
        },
      ],
    };
    const input: CommandInput = {
      command: "review",
      payload: fakePayload,
      agent: capturingAgent(capture),
      instructions,
    };

    await runCommand(input);

    assert.ok(capture.ctx, "agent.run must be called");
    // The findings MUST survive into the instructions the agent receives —
    // not be dropped by a fresh {systemPrompt, rules:[]} rebuild (18.4).
    assert.ok(capture.ctx!.instructions.findings, "findings must be threaded");
    assert.equal(
      capture.ctx!.instructions.findings!.length,
      1,
      "exactly the one deterministic finding survives",
    );
    assert.equal(
      capture.ctx!.instructions.findings![0]!.message,
      "eval() is forbidden",
      "the finding survives verbatim",
    );
  });

  it("records the exact provider prompt instead of a parallel trace-only prompt", async () => {
    const capture: { ctx?: AgentRunContext } = {};
    const result = await runCommand({
      command: "improve",
      payload: fakePayload,
      agent: capturingAgent(capture),
      instructions: {
        systemPrompt: "Suggest improvements only.",
        rules: ["No review findings."],
        outputFormat: "Return suggestions.",
      },
    });
    assert.ok(capture.ctx);
    assert.equal(result.trace[0]?.prompt, buildReviewPrompt(capture.ctx!));
    assert.doesNotMatch(result.trace[0]?.prompt ?? "", /Review this PR/u);
  });
});
