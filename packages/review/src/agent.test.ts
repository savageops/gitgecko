/**
 * TDD tests for the review owner — the CodeRabbit-competing agent loop.
 *
 * Challenges the CAPABILITY (observable contracts), not implementation:
 *  - Agent adapter: install + run, by-ref toolState (P-plugin-3)
 *  - Command taxonomy: resolve + dispatch + aliases (CR-§1.2, P-plugin-11)
 *  - Mutates gate: derived deny list, throws-if-empty (P-plugin-7)
 *  - Grounding: review consumes retrieve; trace recorded
 *
 * Uses a fake Agent backend that records calls — deterministic, no LLM needed.
 * Per project TDD rule: written FIRST, fail, then code passes. Never weakened.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Agent, AgentRunContext, AgentResult, ReviewPayload, ToolState } from "./agent.js";
import {
  REVIEW_COMMANDS,
  resolveCommand,
  isReviewCommand,
  deriveMutatesDenyList,
  shouldDenyTool,
} from "./commands.js";

// --- A fake agent backend that records its run + mutates toolState -----------
const makeFakeAgent = (output: string): { agent: Agent; runs: AgentRunContext[] } => {
  const runs: AgentRunContext[] = [];
  const agent: Agent = {
    name: "fake",
    install: async () => "fake-installed",
    run: async (ctx: AgentRunContext): Promise<AgentResult> => {
      runs.push(ctx);
      // Simulate the by-ref invariant: mutate toolState (the gate reads it live)
      ctx.toolState.calls.push({ tool: "read_file", input: { path: "x" }, result: "content" });
      return { success: true, output, usage: { tokensIn: 100, tokensOut: 50, costUsd: 0.001 } };
    },
  };
  return { agent, runs };
};

const payload: ReviewPayload = {
  repo: "myapp",
  prNumber: 1,
  title: "Add login",
  diff: "+def login():\n+    return True",
  files: ["src/auth.py"],
};

describe("Agent adapter (P-plugin-3)", () => {
  it("install provisions the backend and returns a path/id", async () => {
    const { agent } = makeFakeAgent("done");
    const installed = await agent.install("token");
    assert.ok(typeof installed === "string" && installed.length > 0);
  });

  it("run executes and returns a success result", async () => {
    const { agent } = makeFakeAgent("review complete");
    const result = await agent.run({
      payload,
      cwd: process.cwd(), permission: "read-only", persistence: "ephemeral",
      resolvedModel: "fake-model",
      mcpServerUrl: "http://localhost:1",
      tmpdir: "/tmp",
      subagentDeniedTools: [],
      instructions: { systemPrompt: "You are a reviewer.", rules: [] },
      toolState: { calls: [] },
      apiToken: "tok",
    });
    assert.ok(result.success);
    assert.equal(result.output, "review complete");
  });

  it("mutates toolState BY REFERENCE (the gate reads live mutations, P-plugin-3 invariant)", async () => {
    const { agent } = makeFakeAgent("x");
    const toolState: ToolState = { calls: [] };
    await agent.run({
      payload, cwd: process.cwd(), permission: "read-only", persistence: "ephemeral", mcpServerUrl: "http://localhost:1", tmpdir: "/tmp",
      subagentDeniedTools: [], instructions: { systemPrompt: "", rules: [] },
      toolState, apiToken: "tok",
    });
    // The fake agent pushed a call into toolState — by reference, the caller sees it.
    assert.equal(toolState.calls.length, 1);
    assert.equal(toolState.calls[0]!.tool, "read_file");
  });
});

describe("command taxonomy (CR-§1.2, P-plugin-11)", () => {
  it("exposes the canonical CodeRabbit-compatible commands", () => {
    for (const cmd of ["describe", "review", "improve", "ask", "resolve"]) {
      assert.ok((REVIEW_COMMANDS as readonly string[]).includes(cmd), `must include /${cmd}`);
    }
  });

  it("resolves aliases to canonical names (pr-agent's command2class pattern)", () => {
    assert.equal(resolveCommand("/review_pr"), "review");
    assert.equal(resolveCommand("describe_pr"), "describe");
    assert.equal(resolveCommand("/improve_code"), "improve");
    assert.equal(resolveCommand("ask_question"), "ask");
    assert.equal(resolveCommand("auto_review"), "review");
  });

  it("resolves non-alias commands to themselves (stripped of /)", () => {
    assert.equal(resolveCommand("/review"), "review");
    assert.equal(resolveCommand("describe"), "describe");
  });

  it("isReviewCommand recognizes canonical + aliased commands", () => {
    assert.ok(isReviewCommand("/review"));
    assert.ok(isReviewCommand("review_pr"));
    assert.ok(isReviewCommand("improve"));
    assert.ok(!isReviewCommand("/unknown_cmd"));
  });
});

describe("mutates gate (P-plugin-7)", () => {
  it("derives the deny list from tools flagged mutates:true", () => {
    const tools = [
      { name: "read_file", mutates: false },
      { name: "write_file", mutates: true },
      { name: "run_command", mutates: true },
      { name: "search", mutates: false },
    ];
    const deny = deriveMutatesDenyList(tools, true);
    assert.deepEqual([...deny], ["write_file", "run_command"]);
  });

  it("THROWS when expectMutating but no mutating tools (the silent-disable trap)", () => {
    const tools = [{ name: "read_file", mutates: false }];
    assert.throws(
      () => deriveMutatesDenyList(tools, true),
      /gate silently disabled/,
      "must throw — never silently disable the gate (P-plugin-7 invariant)",
    );
  });

  it("does NOT throw when expectMutating is false (read-only agent)", () => {
    const tools = [{ name: "read_file", mutates: false }];
    const deny = deriveMutatesDenyList(tools, false);
    assert.equal(deny.length, 0);
  });

  it("shouldDenyTool returns true for denied tools, false otherwise", () => {
    const deny = ["write_file", "run_command"];
    assert.ok(shouldDenyTool("write_file", deny));
    assert.ok(shouldDenyTool("run_command", deny));
    assert.ok(!shouldDenyTool("read_file", deny));
    assert.ok(!shouldDenyTool("search", deny));
  });
});

describe("review grounding (repoContext in instructions, 002)", () => {
  it("repoContext flows through instructions to the agent (the grounding contract)", async () => {
    // After chain 002, grounding is NOT a retrieve() fn on CommandInput — it's
    // a rendered string on ResolvedInstructions.repoContext, populated by the
    // orchestrator (extractDiffQueries → retrieve → renderRepoContext).
    // This test verifies the agent RECEIVES that context on its instructions.
    const { agent, runs } = makeFakeAgent("grounded review");

    const ctx = {
      payload, cwd: process.cwd(), permission: "read-only", persistence: "ephemeral", mcpServerUrl: "http://localhost:1", tmpdir: "/tmp",
      subagentDeniedTools: [],
      instructions: {
        systemPrompt: "Review this PR.",
        rules: [],
        repoContext: "## Repo context (retrieved):\n--- src/auth.py ---\nexisting login impl",
      },
      toolState: { calls: [] } as ToolState, apiToken: "tok",
    } as AgentRunContext;
    const result = await agent.run(ctx);
    assert.ok(result.success);
    assert.equal(runs.length, 1);
    assert.ok(runs[0]!.instructions.repoContext, "repoContext must be present");
    assert.match(runs[0]!.instructions.repoContext!, /Repo context/);
    assert.match(runs[0]!.instructions.repoContext!, /existing login impl/);
  });

  it("agent works normally without repoContext (graceful, no grounding)", async () => {
    const { agent, runs } = makeFakeAgent("review without context");
    const ctx = {
      payload, cwd: process.cwd(), permission: "read-only", persistence: "ephemeral", mcpServerUrl: "http://localhost:1", tmpdir: "/tmp",
      subagentDeniedTools: [],
      instructions: { systemPrompt: "Review this PR.", rules: [] },
      toolState: { calls: [] } as ToolState, apiToken: "tok",
    } as AgentRunContext;
    const result = await agent.run(ctx);
    assert.ok(result.success);
    assert.ok(!runs[0]!.instructions.repoContext, "repoContext must be absent when not provided");
  });
});
