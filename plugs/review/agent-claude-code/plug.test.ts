/**
 * TDD tests for the claude-code agent plug (Phase 4.1 — A13 zero-config wedge).
 *
 * THE CAPABILITY: the claude-code plug shells out to `claude -p "<prompt>"`
 * (print mode, non-interactive one-shot), denies state-changing tools for
 * read-only safety, and records into toolState by reference. This completes
 * the three-binary zero-config detection (Claude is the secondary provider).
 *
 * Per project TDD rule: tests challenge capability, never degraded to pass.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir as osTmpdir } from "node:os";
import { existsSync, mkdtempSync } from "node:fs";
import { join as pathJoin } from "node:path";
import type { AgentRunContext, AgentResult } from "@gitgecko/review";
import { manifest, createClaudeCodeAgent, parseClaudeOutput, type ShellOut } from "./plug.js";

// A fake ShellOut that records calls + returns deterministic output.
const makeFakeShellOut = (output: string): { fn: ShellOut; calls: { binary: string; args: readonly string[]; opts?: { input?: string } }[] } => {
  const calls: { binary: string; args: readonly string[]; opts?: { input?: string } }[] = [];
  const fn: ShellOut = (binary, args, opts) => {
    calls.push({ binary, args, opts });
    return output;
  };
  return { fn, calls };
};

// A minimal run context for testing.
const makeRunCtx = (overrides: Partial<AgentRunContext> = {}): AgentRunContext => ({
  payload: { repo: "test", prNumber: 1, title: "Test PR", diff: "+const x = 1;", files: [] },
  cwd: process.cwd(), permission: "read-only", persistence: "ephemeral",
  mcpServerUrl: "",
  tmpdir: osTmpdir(),
  subagentDeniedTools: [],
  instructions: { systemPrompt: "Review this PR.", rules: [] },
  toolState: { calls: [] },
  apiToken: "",
  ...overrides,
}) as AgentRunContext;

describe("claude-code agent — manifest", () => {
  it("manifest is valid and declares the agent-backend capability under review owner", () => {
    assert.equal(manifest.owner, "review");
    assert.ok(manifest.capabilities.includes("agent-backend"));
    assert.equal(manifest.id, "review-agent-claude-code");
  });
});

describe("claude-code agent — install (PATH probe)", () => {
  it("install succeeds when claude --version works", async () => {
    const { fn } = makeFakeShellOut("claude-code v2.1.0");
    const agent = createClaudeCodeAgent(fn);
    const result = await agent.install();
    assert.match(result, /claude-code.*installed/i);
  });

  it("install throws when claude binary not found", async () => {
    const failingShellOut: ShellOut = () => { throw new Error("ENOENT"); };
    const agent = createClaudeCodeAgent(failingShellOut);
    await assert.rejects(() => agent.install(), /claude binary not found/);
  });
});

describe("claude-code agent — run (CLI invocation shape)", () => {
  it("calls claude with -p flag (print mode) and pipes prompt via stdin", async () => {
    const { fn, calls } = makeFakeShellOut("LGTM");
    const agent = createClaudeCodeAgent(fn);
    await agent.run(makeRunCtx());
    assert.equal(calls[0]!.binary, "claude");
    const pIndex = calls[0]!.args.indexOf("-p");
    assert.ok(pIndex >= 0, "must pass -p flag for print mode");
    // The prompt is NOT a -p argument — it's piped via stdin to avoid the
    // Windows 8191-char command-line limit.
    assert.ok(calls[0]!.opts?.input && calls[0]!.opts.input.length > 0, "prompt must be piped via stdin (opts.input)");
  });

  it("uses --output-format json (session-aware review output)", async () => {
    const { fn, calls } = makeFakeShellOut("review output");
    const agent = createClaudeCodeAgent(fn);
    await agent.run(makeRunCtx());
    const formatIndex = calls[0]!.args.indexOf("--output-format");
    assert.ok(formatIndex >= 0);
    assert.equal(calls[0]!.args[formatIndex + 1], "json");
  });

  it("maps read-only to Claude's current default permission mode", async () => {
    const { fn, calls } = makeFakeShellOut("review output");
    await createClaudeCodeAgent(fn).run(makeRunCtx());
    const index = calls[0]!.args.indexOf("--permission-mode");
    assert.equal(calls[0]!.args[index + 1], "default");
  });

  it("maps workspace-write and unrestricted to Claude's supported modes", async () => {
    const write = makeFakeShellOut("review output");
    const unrestricted = makeFakeShellOut("review output");
    await createClaudeCodeAgent(write.fn).run(makeRunCtx({ permission: "workspace-write" }));
    await createClaudeCodeAgent(unrestricted.fn).run(makeRunCtx({ permission: "unrestricted" }));
    const writeIndex = write.calls[0]!.args.indexOf("--permission-mode");
    const unrestrictedIndex = unrestricted.calls[0]!.args.indexOf("--permission-mode");
    assert.equal(write.calls[0]!.args[writeIndex + 1], "acceptEdits");
    assert.equal(unrestricted.calls[0]!.args[unrestrictedIndex + 1], "bypassPermissions");
  });

  it("denies state-changing tools via --disallowedTools (read-only safety)", async () => {
    const { fn, calls } = makeFakeShellOut("ok");
    const agent = createClaudeCodeAgent(fn);
    await agent.run(makeRunCtx());
    const denyIndex = calls[0]!.args.indexOf("--disallowedTools");
    assert.ok(denyIndex >= 0, "must pass --disallowedTools");
    const denyList = calls[0]!.args[denyIndex + 1]!;
    // Must deny Bash (pullfrog CLAUDE_EXEC_TOOLS) + Write/Edit (read-only review).
    assert.match(denyList, /Bash/);
    assert.match(denyList, /Write/);
    assert.match(denyList, /Edit/);
    // Must deny Agent(...) variants too (subagent isolation).
    assert.match(denyList, /Agent\(Bash\)/);
  });

  it("does NOT pass --dangerously-skip-permissions (safe default)", async () => {
    const { fn, calls } = makeFakeShellOut("ok");
    const agent = createClaudeCodeAgent(fn);
    await agent.run(makeRunCtx());
    const hasSkip = calls[0]!.args.includes("--dangerously-skip-permissions");
    assert.equal(hasSkip, false, "must NOT use --dangerously-skip-permissions (v1 read-only review)");
  });

  it("passes --model when CLAUDE_MODEL env is set", async () => {
    const prev = process.env.CLAUDE_MODEL;
    process.env.CLAUDE_MODEL = "claude-sonnet-5";
    try {
      const { fn, calls } = makeFakeShellOut("ok");
      const agent = createClaudeCodeAgent(fn);
      await agent.run(makeRunCtx());
      const modelIndex = calls[0]!.args.indexOf("--model");
      assert.ok(modelIndex >= 0, "must pass --model when CLAUDE_MODEL is set");
      assert.equal(calls[0]!.args[modelIndex + 1], "claude-sonnet-5");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_MODEL;
      else process.env.CLAUDE_MODEL = prev;
    }
  });

  it("omits --model when CLAUDE_MODEL is unset (use claude's default)", async () => {
    const prev = process.env.CLAUDE_MODEL;
    delete process.env.CLAUDE_MODEL;
    try {
      const { fn, calls } = makeFakeShellOut("ok");
      const agent = createClaudeCodeAgent(fn);
      await agent.run(makeRunCtx());
      const modelIndex = calls[0]!.args.indexOf("--model");
      assert.equal(modelIndex, -1, "must NOT pass --model when CLAUDE_MODEL is unset");
    } finally {
      if (prev !== undefined) process.env.CLAUDE_MODEL = prev;
    }
  });
});

describe("claude-code agent — run (output + toolState)", () => {
  it("parses the final result and session id from JSON", () => {
    const parsed = parseClaudeOutput(JSON.stringify({ type: "result", result: "Reviewed", session_id: "claude-session", is_error: false }));
    assert.deepEqual(parsed, { success: true, output: "Reviewed", providerThreadId: "claude-session" });
  });

  it("parses a Claude error result without pretending success", () => {
    const parsed = parseClaudeOutput(JSON.stringify({ type: "result", result: "Unauthorized", session_id: "claude-session", is_error: true }));
    assert.equal(parsed.success, false);
    assert.equal(parsed.error, "Unauthorized");
  });

  it("classifies a structured Claude authentication envelope as auth", async () => {
    const { fn } = makeFakeShellOut(JSON.stringify({
      type: "result",
      result: "API Error: 401 Invalid authentication credentials. Please run /login",
      is_error: true,
    }));
    const result = await createClaudeCodeAgent(fn).run(makeRunCtx());
    assert.equal(result.success, false);
    assert.equal(result.failure, "auth");
  });

  it("normalizes provider-reported usage without estimating it", () => {
    const parsed = parseClaudeOutput(JSON.stringify({
      type: "result",
      result: "Reviewed",
      session_id: "claude-session",
      is_error: false,
      usage: { input_tokens: 321, output_tokens: 45 },
      total_cost_usd: 0.0123,
    }));
    assert.deepEqual(parsed.usage, { tokensIn: 321, tokensOut: 45, costUsd: 0.0123 });
  });

  it("omits usage when Claude does not report token counts", async () => {
    const { fn } = makeFakeShellOut(JSON.stringify({ result: "Reviewed", session_id: "claude-session", is_error: false }));
    const result = await createClaudeCodeAgent(fn).run(makeRunCtx());
    assert.equal(result.usage, undefined);
  });

  it("passes --resume for a provider thread", async () => {
    const { fn, calls } = makeFakeShellOut(JSON.stringify({ result: "Continued", session_id: "claude-session", is_error: false }));
    await createClaudeCodeAgent(fn).run(makeRunCtx({ providerThreadId: "claude-session", persistence: "thread" }));
    const index = calls[0]!.args.indexOf("--resume");
    assert.equal(calls[0]!.args[index + 1], "claude-session");
  });

  it("returns the provider session id from a run", async () => {
    const { fn } = makeFakeShellOut(JSON.stringify({ result: "Reviewed", session_id: "claude-session", is_error: false }));
    const result = await createClaudeCodeAgent(fn).run(makeRunCtx({ persistence: "thread" }));
    assert.equal(result.providerThreadId, "claude-session");
  });
  it("returns the claude output as the review result", async () => {
    const { fn } = makeFakeShellOut("## Review\nFound a bug in auth.ts");
    const agent = createClaudeCodeAgent(fn);
    const result: AgentResult = await agent.run(makeRunCtx());
    assert.equal(result.success, true);
    assert.match(result.output!, /Found a bug/);
  });

  it("records the tool call into toolState by reference (P-plugin-3)", async () => {
    const { fn } = makeFakeShellOut("reviewed");
    const agent = createClaudeCodeAgent(fn);
    const ctx = makeRunCtx();
    await agent.run(ctx);
    assert.ok(ctx.toolState.calls.length > 0, "toolState must have the recorded call");
    assert.equal(ctx.toolState.calls[0]!.tool, "claude-code.run");
  });

  it("returns failure on shell-out error (graceful, no crash)", async () => {
    const failingShellOut: ShellOut = () => { throw new Error("claude crashed"); };
    const agent = createClaudeCodeAgent(failingShellOut);
    const result = await agent.run(makeRunCtx());
    assert.equal(result.success, false);
    assert.match(result.error!, /claude crashed/);
  });

  it("threads instructions (persona, rules, findings, repoContext) into the prompt", async () => {
    const { fn, calls } = makeFakeShellOut("ok");
    const agent = createClaudeCodeAgent(fn);
    await agent.run(makeRunCtx({
      instructions: {
        systemPrompt: "You are an expert reviewer.",
        rules: ["Prefer early returns"],
        repoContext: "## Context\nsrc/auth.ts defines authenticate()",
      } as never,
    } as never));
    // The prompt is now piped via stdin (opts.input), not as a -p argument.
    const prompt = calls[0]!.opts?.input ?? "";
    assert.match(prompt, /expert reviewer/);
    assert.match(prompt, /Prefer early returns/);
    assert.match(prompt, /src\/auth\.ts/);
  });
});

describe("claude-code agent — W5 managed-settings bypass-immune deny (Phase 4.4)", () => {
  // Use a real OS tmpdir so the managed-settings file write succeeds (on Windows
  // a literal "/tmp" does not exist; the writeFileSync would be caught + skipped).
  const realTmp = (): string => mkdtempSync(pathJoin(osTmpdir(), "gitgecko-claude-test-"));

  it("writes a managed-settings file and passes --settings <path> (bypass-immune layer)", async () => {
    const { fn, calls } = makeFakeShellOut("ok");
    const agent = createClaudeCodeAgent(fn);
    await agent.run(makeRunCtx({ subagentDeniedTools: ["git_commit", "fs_write"], tmpdir: realTmp() }));
    const settingsIndex = calls[0]!.args.indexOf("--settings");
    assert.ok(settingsIndex >= 0, "must pass --settings when subagentDeniedTools is non-empty");
    const settingsPath = calls[0]!.args[settingsIndex + 1]!;
    assert.ok(settingsPath && settingsPath.length > 0, "--settings must be followed by a path");
    assert.equal(existsSync(settingsPath), false, "managed settings must be removed after execution");
  });

  it("the managed-settings deny list includes the mutatesDenyList tools (bypass-immune)", async () => {
    const { fn } = makeFakeShellOut("ok");
    const agent = createClaudeCodeAgent(fn);
    const ctx = makeRunCtx({ subagentDeniedTools: ["dangerous_tool", "state_changer"], tmpdir: realTmp() });
    await agent.run(ctx);
    // The input trace records that denies were wired into managed settings.
    const call = ctx.toolState.calls[0]!;
    const input = call.input as { managedSettingsDeniedTools: number };
    assert.equal(input.managedSettingsDeniedTools, 2);
  });

  it("always ships the git-deny surfaces even with an empty deny list (free hardening)", async () => {
    const { fn, calls } = makeFakeShellOut("ok");
    const agent = createClaudeCodeAgent(fn);
    // Even with no mutates-derived denies, the managed-settings file is written
    // (it carries the always-on GIT_WRITE_DENY_CLAUDE + GIT_READ_DENY_CLAUDE).
    await agent.run(makeRunCtx({ subagentDeniedTools: [], tmpdir: realTmp() }));
    const settingsIndex = calls[0]!.args.indexOf("--settings");
    assert.ok(settingsIndex >= 0, "managed-settings must ship even with empty deny list (git hardening)");
  });
});
