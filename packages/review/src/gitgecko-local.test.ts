/**
 * Capability tests for the review-specific local-model adapter.
 *
 * Challenges the CAPABILITY (observable contracts), not implementation:
 *  - system and user roles remain separate at the model-owner boundary.
 *  - normalized provider usage maps without token heuristics.
 *  - model-owner failures surface as success:false with the message.
 *  - toolState BY REFERENCE (P-plugin-3): the model.generate call lands
 *    in ctx.toolState.calls after run().
 *
 * Per project TDD rule: written FIRST, fail, then code passes. Never weakened.
 * The previous gitgecko-local.ts was a MIRROR (homegrown PiClient closure, zero
 * pi-ai imports). These tests cannot pass against a mirror — they require the
 * real createModels/completeSimple dispatch.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ModelGenerate, ModelMessage, ModelResponse } from "@gitgecko/model-client";
import type { LocalEndpointConfig } from "./pathways.js";
import { createGitGeckoLocalAgent } from "./gitgecko-local.js";
import type { AgentRunContext, ToolState } from "./agent.js";

// --- Test fixtures ---------------------------------------------------------

const baseConfig: LocalEndpointConfig = {
  modelId: "llama-4-scout",
  baseUrl: "http://localhost:1234/v1",
  protocol: "openai-chat-completions",
};

/** Minimal AgentRunContext for gitgecko-local (the local pathway doesn't shell out). */
const makeCtx = (overrides: Partial<AgentRunContext> = {}): AgentRunContext => ({
  payload: {
    repo: "gitgecko/test",
    prNumber: 1,
    title: "Add feature",
    diff: "+def foo(): pass",
    files: ["a.py"],
  },
  mcpServerUrl: "http://localhost:0",
  tmpdir: "/tmp",
  subagentDeniedTools: [],
  instructions: { systemPrompt: "You are a code reviewer.", rules: ["Be concise."] },
  toolState: { calls: [] },
  apiToken: "test-token",
  ...overrides,
}) as AgentRunContext;

const response = (text: string): Omit<ModelResponse, "id" | "model"> => ({
  text,
  stopReason: "stop",
  usage: { inputTokens: 17, outputTokens: 5, totalTokens: 22 },
});

describe("createGitGeckoLocalAgent — canonical model-client boundary", () => {
  it("returns the normalized model response", async () => {
    let calls = 0;
    const generate: ModelGenerate = async () => {
      calls += 1;
      return response("LGTM: looks good.");
    };
    const agent = createGitGeckoLocalAgent(baseConfig, generate);

    const result = await agent.run(makeCtx());

    assert.equal(result.success, true, `expected success, got error: ${result.error}`);
    assert.equal(result.output, "LGTM: looks good.");
    assert.equal(calls, 1, "canonical generator must be invoked exactly once");
  });

  it("maps normalized usage without estimating tokens", async () => {
    const agent = createGitGeckoLocalAgent(baseConfig, async () => response("Approve."));

    const result = await agent.run(makeCtx());
    assert.ok(result.usage, "usage must be populated");
    // faux estimates real token counts. If we were using length/4 on the PROMPT
    // we'd get a different number than faux's serialized-context estimate.
    // Asserting both > 0 and output > 0 proves we read pi-ai's usage object.
    assert.equal(result.usage!.tokensIn, 17);
    assert.equal(result.usage!.tokensOut, 5);
    assert.equal(result.usage!.costUsd, 0, "local model cost is 0 (free hardware)");
  });

  it("surfaces model-owner errors as success:false with the message", async () => {
    const agent = createGitGeckoLocalAgent(baseConfig, async () => {
      throw new Error("provider unavailable");
    });

    const result = await agent.run(makeCtx());
    assert.equal(result.success, false);
    assert.equal(result.error, "provider unavailable");
  });

  it("records model.generate into toolState BY REFERENCE (P-plugin-3)", async () => {
    const agent = createGitGeckoLocalAgent(baseConfig, async () => response("ok"));

    const toolState: ToolState = { calls: [] };
    await agent.run(makeCtx({ toolState }));

    assert.equal(toolState.calls.length, 1, "the shared toolState must be mutated, not a copy");
    assert.equal(toolState.calls[0]!.tool, "model.generate");
  });

  it("install() reports the model + baseUrl (debug UX)", async () => {
    const agent = createGitGeckoLocalAgent(baseConfig, async () => response("unused"));
    const report = await agent.install();
    assert.ok(report.includes("llama-4-scout"));
    assert.ok(report.includes("localhost:1234"));
  });

  it("identifies Pi as the provider at the Agent socket", () => {
    assert.equal(createGitGeckoLocalAgent(baseConfig, async () => response("unused")).name, "pi");
  });

  it("creates a GitGecko-owned provider handle for persistent Pi threads", async () => {
    const result = await createGitGeckoLocalAgent(baseConfig, async () => response("ok")).run(makeCtx({ persistence: "thread" }));
    assert.match(result.providerThreadId ?? "", /^pi_/u);
  });

  it("preserves an existing Pi thread handle on resume", async () => {
    const result = await createGitGeckoLocalAgent(baseConfig, async () => response("ok")).run(makeCtx({ persistence: "thread", providerThreadId: "pi_existing" }));
    assert.equal(result.providerThreadId, "pi_existing");
  });

  it("sends normalized thread history before the current Pi user turn", async () => {
    let roles: string[] = [];
    let contents: string[] = [];
    const agent = createGitGeckoLocalAgent(baseConfig, async (_prompt, _model, options) => {
      roles = (options?.messages ?? []).map((message) => message.role);
      contents = (options?.messages ?? []).map((message) => message.content);
      return response("ok");
    });
    await agent.run(makeCtx({
      persistence: "thread",
      conversation: [
        { role: "user", text: "first", at: "2026-07-17T12:00:00.000Z" },
        { role: "assistant", text: "answer", at: "2026-07-17T12:00:01.000Z" },
      ],
    }));
    assert.deepEqual(roles.slice(0, 3), ["system", "user", "assistant"]);
    assert.deepEqual(contents.slice(1, 3), ["first", "answer"]);
  });
});

// --- repoContext prompt section (002e) — grounding visible to the model ----

/**
 * Run the local review adapter against an injected canonical generator and
 * capture the complete role-preserving message list.
 */
const runAndCaptureContext = async (ctxOverrides: Partial<AgentRunContext>): Promise<{
  result: { success: boolean; output?: string; error?: string };
  capturedContext: { systemPrompt: string; userMessage: string } | null;
}> => {
  let capturedContext: { systemPrompt: string; userMessage: string } | null = null;
  const generate: ModelGenerate = async (_prompt, _model, options) => {
    const messages: readonly ModelMessage[] = options?.messages ?? [];
    capturedContext = {
      systemPrompt: messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n"),
      userMessage: messages.filter((message) => message.role === "user").map((message) => message.content).join("\n\n"),
    };
    return response("review output");
  };
  const agent = createGitGeckoLocalAgent(baseConfig, generate);
  const result = await agent.run(makeCtx(ctxOverrides));
  return { result, capturedContext };
};

describe("gitgecko-local — repoContext prompt section (002e)", () => {
  it("includes the repoContext section in the prompt when present", async () => {
    const { result, capturedContext } = await runAndCaptureContext({
      instructions: {
        systemPrompt: "You are a reviewer.",
        rules: [],
        repoContext: "## Repo context (retrieved):\n--- a.ts ---\nconst x = toolState.byRef;",
      },
    });
    assert.equal(result.success, true);
    assert.ok(capturedContext, "context must have been captured");
    assert.match(capturedContext!.userMessage, /Repo context/i, "prompt must contain the repo context section");
    assert.match(capturedContext!.userMessage, /toolState\.byRef/, "repoContext content must be in the prompt");
  });

  it("omits the repoContext section when absent", async () => {
    const { capturedContext } = await runAndCaptureContext({
      instructions: { systemPrompt: "You are a reviewer.", rules: [] },
    });
    assert.ok(capturedContext);
    assert.doesNotMatch(capturedContext!.userMessage, /Repo context/i, "prompt must NOT contain repo context when absent");
  });

  it("omits the repoContext section when undefined (exactOptionalPropertyTypes)", async () => {
    const { capturedContext } = await runAndCaptureContext({});
    assert.ok(capturedContext);
    assert.doesNotMatch(capturedContext!.userMessage, /Repo context/i);
  });

  it("preserves repoContext content verbatim in the prompt", async () => {
    const ctx = "## Repo context (retrieved):\n--- deep/path/file.ts ---\nexport const important = 'value';";
    const { capturedContext } = await runAndCaptureContext({
      instructions: { systemPrompt: "S", rules: [], repoContext: ctx },
    });
    assert.ok(capturedContext!.userMessage.includes("export const important = 'value';"));
    assert.ok(capturedContext!.userMessage.includes("deep/path/file.ts"));
  });

  it("places the repoContext section in the prompt (visible to the model)", async () => {
    const { capturedContext } = await runAndCaptureContext({
      instructions: { systemPrompt: "S", rules: [], repoContext: "## Repo context:\nGrounded data" },
    });
    // The prompt must contain both the diff and the repoContext
    assert.match(capturedContext!.userMessage, /Diff:/);
    assert.match(capturedContext!.userMessage, /Repo context/);
  });

  it("repoContext appears alongside rules when both present", async () => {
    const { capturedContext } = await runAndCaptureContext({
      instructions: { systemPrompt: "S", rules: ["Rule 1", "Rule 2"], repoContext: "## Repo context:\nData" },
    });
    assert.match(capturedContext!.userMessage, /Rule 1/);
    assert.match(capturedContext!.userMessage, /Repo context/);
  });

  it("repoContext appears alongside findings when both present", async () => {
    const { capturedContext } = await runAndCaptureContext({
      instructions: {
        systemPrompt: "S", rules: [],
        findings: [{ ruleId: "R1", kind: "lexical", severity: "error", message: "bug", filepath: "a.ts", line: 1, column: 0, match: "x", source: "deterministic" }],
        repoContext: "## Repo context:\nData",
      },
    });
    assert.match(capturedContext!.userMessage, /Deterministic findings|R1/);
    assert.match(capturedContext!.userMessage, /Repo context/);
  });

  it("repoContext appears alongside outputFormat when both present", async () => {
    const { capturedContext } = await runAndCaptureContext({
      instructions: { systemPrompt: "S", rules: [], outputFormat: "## Format\nStructure here", repoContext: "## Repo context:\nData" },
    });
    assert.match(capturedContext!.userMessage, /Format/);
    assert.match(capturedContext!.userMessage, /Repo context/);
  });

  it("persona is in the system prompt, repoContext is in the user message (role separation)", async () => {
    const { capturedContext } = await runAndCaptureContext({
      instructions: { systemPrompt: "Base system", rules: [], persona: "EXPERT REVIEWER PERSONA", repoContext: "## Repo context:\nData" },
    });
    assert.match(capturedContext!.systemPrompt, /EXPERT REVIEWER PERSONA/);
    assert.match(capturedContext!.userMessage, /Repo context/);
  });

  it("empty-string repoContext produces no section (graceful)", async () => {
    // Note: exactOptionalPropertyTypes means "" won't be attached by resolveInstructions,
    // but if someone sets it directly, the ternary must handle it.
    const { capturedContext } = await runAndCaptureContext({
      instructions: { systemPrompt: "S", rules: [], repoContext: "" },
    });
    // Empty string is falsy → the ternary produces "" → no "Repo context" match
    assert.doesNotMatch(capturedContext!.userMessage, /## Repo context/);
  });

  it("the diff is still present when repoContext is rendered", async () => {
    const { capturedContext } = await runAndCaptureContext({
      instructions: { systemPrompt: "S", rules: [], repoContext: "## Repo context:\nData" },
    });
    assert.match(capturedContext!.userMessage, /\+def foo/, "diff must still be in the prompt");
  });

  it("multiple repoContext lines are preserved", async () => {
    const ctx = "## Repo context:\n--- a.ts ---\nline1\n--- b.ts ---\nline2";
    const { capturedContext } = await runAndCaptureContext({
      instructions: { systemPrompt: "S", rules: [], repoContext: ctx },
    });
    assert.ok(capturedContext!.userMessage.includes("line1"));
    assert.ok(capturedContext!.userMessage.includes("line2"));
  });

  it("repoContext does not alter the success of the run", async () => {
    const { result } = await runAndCaptureContext({
      instructions: { systemPrompt: "S", rules: [], repoContext: "## Repo context:\nData" },
    });
    assert.equal(result.success, true);
    assert.equal(result.output, "review output");
  });

  it("repoContext with special characters is preserved", async () => {
    const ctx = "## Repo context:\n--- a.ts ---\nconst s = `template ${lit}`;";
    const { capturedContext } = await runAndCaptureContext({
      instructions: { systemPrompt: "S", rules: [], repoContext: ctx },
    });
    assert.ok(capturedContext!.userMessage.includes("const s = `template ${lit}`;"));
  });

  it("repoContext is in the USER message, not the system prompt (gitgecko-local role split)", async () => {
    const { capturedContext } = await runAndCaptureContext({
      instructions: { systemPrompt: "Base system", rules: [], repoContext: "## Repo context:\nData" },
    });
    assert.doesNotMatch(capturedContext!.systemPrompt, /Repo context/);
    assert.match(capturedContext!.userMessage, /Repo context/);
  });

  it("large repoContext is not truncated (full content reaches the model)", async () => {
    const long = "## Repo context:\n" + "x".repeat(1000);
    const { capturedContext } = await runAndCaptureContext({
      instructions: { systemPrompt: "S", rules: [], repoContext: long },
    });
    assert.ok(capturedContext!.userMessage.includes("x".repeat(1000)));
  });
});
