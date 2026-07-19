/**
 * TDD tests for the codex agent plug (audit 4.3 — security-relevant shell-out).
 *
 * THE CAPABILITY: the codex plug shells out to `codex exec` with the prompt via
 * stdin, reads output from a temp file, and records into toolState. The shell-out
 * uses the shell-free native command owner. This test exercises the injection
 * seam to verify the invocation shape and security properties.
 *
 * Per project TDD rule: tests challenge capability, never degraded to pass.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentRunContext, AgentResult } from "@gitgecko/review";
import { manifest, createCodexAgent, type ShellOut } from "./plug.js";
import { codexSandboxPolicy } from "./app-server.js";

const makeFakeShellOut = (output: string): { fn: ShellOut; calls: { binary: string; args: readonly string[] }[] } => {
  const calls: { binary: string; args: readonly string[] }[] = [];
  const fn: ShellOut = (binary, args) => {
    calls.push({ binary, args });
    return output;
  };
  return { fn, calls };
};

const makeRunCtx = (overrides: Partial<AgentRunContext> = {}): AgentRunContext => ({
  payload: { repo: "test", prNumber: 1, title: "Test PR", diff: "+const x = 1;", files: [] },
  cwd: process.cwd(), permission: "read-only", persistence: "ephemeral",
  mcpServerUrl: "",
  tmpdir: "/tmp",
  subagentDeniedTools: [],
  instructions: { systemPrompt: "Review this PR.", rules: [] },
  toolState: { calls: [] },
  apiToken: "",
  ...overrides,
}) as AgentRunContext;

describe("codex agent — manifest", () => {
  it("manifest declares the agent-backend capability under review owner", () => {
    assert.equal(manifest.owner, "review");
    assert.ok(manifest.capabilities.includes("agent-backend"));
  });
});

describe("codex App Server permission mapping", () => {
  it("maps read-only without network", () => assert.deepEqual(codexSandboxPolicy("read-only", "C:\\repo"), { type: "readOnly", networkAccess: false }));
  it("maps workspace-write to the target root only", () => assert.deepEqual(codexSandboxPolicy("workspace-write", "C:\\repo"), { type: "workspaceWrite", writableRoots: ["C:\\repo"], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }));
  it("maps unrestricted to dangerFullAccess", () => assert.deepEqual(codexSandboxPolicy("unrestricted", "C:\\repo"), { type: "dangerFullAccess" }));
});

describe("codex agent — install (PATH probe)", () => {
  it("succeeds when codex --version works", async () => {
    const { fn } = makeFakeShellOut("codex 0.142.5");
    const agent = createCodexAgent(fn);
    const result = await agent.install();
    assert.match(result, /codex.*installed/i);
  });

  it("throws when codex binary not found", async () => {
    const failing: ShellOut = () => { throw new Error("ENOENT"); };
    const agent = createCodexAgent(failing);
    await assert.rejects(() => agent.install(), /codex binary not found/);
  });
});

describe("codex agent — run (CLI invocation shape)", () => {
  it("calls codex with `exec` subcommand (one-shot non-interactive)", async () => {
    const { fn, calls } = makeFakeShellOut("output file content");
    const agent = createCodexAgent(fn);
    await agent.run(makeRunCtx());
    assert.equal(calls[0]!.binary, "codex");
    assert.ok(calls[0]!.args.includes("exec"), "must use `exec` subcommand");
  });

  it("passes the prompt via stdin (the `-` arg)", async () => {
    const { fn, calls } = makeFakeShellOut("ok");
    const agent = createCodexAgent(fn);
    await agent.run(makeRunCtx());
    assert.ok(calls[0]!.args.includes("-"), "must pass `-` for stdin prompt");
  });

  it("uses read-only sandbox (`-s read-only`)", async () => {
    const { fn, calls } = makeFakeShellOut("ok");
    const agent = createCodexAgent(fn);
    await agent.run(makeRunCtx());
    const sIndex = calls[0]!.args.indexOf("-s");
    assert.ok(sIndex >= 0, "must pass -s flag");
    assert.equal(calls[0]!.args[sIndex + 1], "read-only");
  });

  it("passes --model when CODEX_MODEL env is set", async () => {
    const prev = process.env.CODEX_MODEL;
    process.env.CODEX_MODEL = "gpt-5.4-mini";
    try {
      const { fn, calls } = makeFakeShellOut("ok");
      const agent = createCodexAgent(fn);
      await agent.run(makeRunCtx());
      const mIndex = calls[0]!.args.indexOf("-m");
      assert.ok(mIndex >= 0);
      assert.equal(calls[0]!.args[mIndex + 1], "gpt-5.4-mini");
    } finally {
      if (prev === undefined) delete process.env.CODEX_MODEL;
      else process.env.CODEX_MODEL = prev;
    }
  });
});

describe("codex agent — run (output + toolState)", () => {
  it("returns the codex output as the review result", async () => {
    const { fn } = makeFakeShellOut("## Review\nLooks good but add a test.");
    const agent = createCodexAgent(fn);
    const result: AgentResult = await agent.run(makeRunCtx());
    assert.equal(result.success, true);
    assert.match(result.output!, /add a test/);
  });

  it("does not fabricate token usage when Codex reports none", async () => {
    const { fn } = makeFakeShellOut("reviewed");
    const result = await createCodexAgent(fn).run(makeRunCtx());
    assert.equal(result.usage, undefined);
  });

  it("records the tool call into toolState by reference (P-plugin-3)", async () => {
    const { fn } = makeFakeShellOut("reviewed");
    const agent = createCodexAgent(fn);
    const ctx = makeRunCtx();
    await agent.run(ctx);
    assert.ok(ctx.toolState.calls.length > 0);
    assert.equal(ctx.toolState.calls[0]!.tool, "codex.run");
  });

  it("returns failure on shell-out error (graceful)", async () => {
    const failing: ShellOut = () => { throw new Error("codex crashed"); };
    const agent = createCodexAgent(failing);
    const result = await agent.run(makeRunCtx());
    assert.equal(result.success, false);
    assert.match(result.error!, /codex crashed/);
  });
});
