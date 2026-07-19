/**
 * TDD tests for the opencode agent plug (Phase 4.2 / T6 — A13 zero-config wedge).
 *
 * THE CAPABILITY: the opencode plug shells out to `opencode run --format json`
 * (the one-shot non-interactive mode). This is the SIMPLE approach — not the
 * 1200-line server adapter from pullfrog (REJECTED per the salvage-source-
 * hierarchy rule in AGENTS.md). The `run` subcommand emits NDJSON events; we
 * parse `text` events as the review output.
 *
 * Per project TDD rule: tests challenge capability, never degraded to pass.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import type { AgentRunContext, AgentResult } from "@gitgecko/review";
import { manifest, createOpencodeAgent, type ShellOut, parseOpencodeOutput, parseOpencodeResult } from "./plug.js";

// A fake ShellOut that records calls + returns deterministic NDJSON output.
const NDOCJSON_OUTPUT = [
  JSON.stringify({ type: "init", sessionID: "test" }),
  JSON.stringify({ type: "text", content: "## Review\n" }),
  JSON.stringify({ type: "text", content: "Found a bug in auth.ts." }),
  JSON.stringify({ type: "step_finish" }),
].join("\n");

const makeFakeShellOut = (output: string): {
  fn: ShellOut;
  calls: { binary: string; args: readonly string[]; opts: { cwd?: string; env?: NodeJS.ProcessEnv } }[];
} => {
  const calls: { binary: string; args: readonly string[]; opts: { cwd?: string; env?: NodeJS.ProcessEnv } }[] = [];
  const fn: ShellOut = (binary, args, opts) => {
    calls.push({ binary, args, opts: opts ?? {} });
    return output;
  };
  return { fn, calls };
};

const makeRunCtx = (overrides: Partial<AgentRunContext> = {}): AgentRunContext => ({
  payload: { repo: "test", prNumber: 1, title: "Test PR", diff: "+const x = 1;", files: [] },
  cwd: process.cwd(), permission: "read-only", persistence: "ephemeral",
  mcpServerUrl: "",
  tmpdir: mkdtempSync(pathJoin(osTmpdir(), "gitgecko-opencode-test-")),
  subagentDeniedTools: [],
  instructions: { systemPrompt: "Review this PR.", rules: [] },
  toolState: { calls: [] },
  apiToken: "",
  ...overrides,
}) as AgentRunContext;

describe("opencode agent — manifest", () => {
  it("manifest is valid and declares the agent-backend capability under review owner", () => {
    assert.equal(manifest.owner, "review");
    assert.ok(manifest.capabilities.includes("agent-backend"));
    assert.equal(manifest.id, "review-agent-opencode");
  });
});

describe("opencode agent — install (PATH probe)", () => {
  it("install succeeds when opencode --version works", async () => {
    const { fn } = makeFakeShellOut("opencode 1.16.2");
    const agent = createOpencodeAgent(fn);
    const result = await agent.install();
    assert.match(result, /opencode.*installed/i);
  });

  it("install throws when opencode binary not found", async () => {
    const failingShellOut: ShellOut = () => { throw new Error("ENOENT"); };
    const agent = createOpencodeAgent(failingShellOut);
    await assert.rejects(() => agent.install(), /opencode binary not found/);
  });
});

describe("opencode agent — run (CLI invocation shape)", () => {
  it("calls opencode with `run` subcommand (one-shot non-interactive)", async () => {
    const { fn, calls } = makeFakeShellOut(NDOCJSON_OUTPUT);
    const agent = createOpencodeAgent(fn);
    await agent.run(makeRunCtx());
    assert.equal(calls[0]!.binary, "opencode");
    assert.ok(calls[0]!.args.includes("run"), "must use `run` subcommand for one-shot mode");
  });

  it("uses --format json (NDJSON event output)", async () => {
    const { fn, calls } = makeFakeShellOut(NDOCJSON_OUTPUT);
    const agent = createOpencodeAgent(fn);
    await agent.run(makeRunCtx());
    const formatIndex = calls[0]!.args.indexOf("--format");
    assert.ok(formatIndex >= 0);
    assert.equal(calls[0]!.args[formatIndex + 1], "json");
  });

  it("attaches the prompt without exposing generated content in argv", async () => {
    let attachedPrompt = "";
    const calls: { binary: string; args: readonly string[]; opts: { cwd?: string; env?: NodeJS.ProcessEnv } }[] = [];
    const fn: ShellOut = (binary, args, opts) => {
      calls.push({ binary, args, opts });
      const fileIndex = args.indexOf("--file");
      assert.ok(fileIndex >= 0, "must attach the review prompt with --file");
      attachedPrompt = readFileSync(args[fileIndex + 1]!, "utf8");
      return NDOCJSON_OUTPUT;
    };
    const agent = createOpencodeAgent(fn);
    await agent.run(makeRunCtx());
    assert.match(attachedPrompt, /Review this PR/);
    assert.equal(calls[0]!.args.some((arg) => /Review this PR/u.test(arg)), false);
  });

  it("passes --model when OPENCODE_MODEL env is set", async () => {
    const prev = process.env.OPENCODE_MODEL;
    process.env.OPENCODE_MODEL = "claude-sonnet-5";
    try {
      const { fn, calls } = makeFakeShellOut(NDOCJSON_OUTPUT);
      const agent = createOpencodeAgent(fn);
      await agent.run(makeRunCtx());
      const modelIndex = calls[0]!.args.indexOf("--model");
      assert.ok(modelIndex >= 0, "must pass --model when OPENCODE_MODEL is set");
      assert.equal(calls[0]!.args[modelIndex + 1], "claude-sonnet-5");
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_MODEL;
      else process.env.OPENCODE_MODEL = prev;
    }
  });

  it("omits --model when OPENCODE_MODEL is unset (use opencode's default)", async () => {
    const prev = process.env.OPENCODE_MODEL;
    delete process.env.OPENCODE_MODEL;
    try {
      const { fn, calls } = makeFakeShellOut(NDOCJSON_OUTPUT);
      const agent = createOpencodeAgent(fn);
      await agent.run(makeRunCtx());
      const modelIndex = calls[0]!.args.indexOf("--model");
      assert.equal(modelIndex, -1, "must NOT pass --model when OPENCODE_MODEL is unset");
    } finally {
      if (prev !== undefined) process.env.OPENCODE_MODEL = prev;
    }
  });
});

describe("opencode agent — NDJSON output parsing", () => {
  it("parses current part.text events and their session id", () => {
    const parsed = parseOpencodeResult(JSON.stringify({ type: "text", sessionID: "oc-session", part: { text: "Reviewed" } }));
    assert.deepEqual(parsed, { success: true, output: "Reviewed", providerThreadId: "oc-session" });
  });

  it("parses nested provider errors as failures", () => {
    const parsed = parseOpencodeResult(JSON.stringify({ type: "error", sessionID: "oc-session", error: { data: { message: "Unauthorized" } } }));
    assert.equal(parsed.success, false);
    assert.equal(parsed.error, "Unauthorized");
  });

  it("returns a session id from a run", async () => {
    const { fn } = makeFakeShellOut(NDOCJSON_OUTPUT);
    const result = await createOpencodeAgent(fn).run(makeRunCtx({ persistence: "thread" }));
    assert.equal(result.providerThreadId, "test");
  });

  it("passes --session when resuming", async () => {
    const { fn, calls } = makeFakeShellOut(NDOCJSON_OUTPUT);
    await createOpencodeAgent(fn).run(makeRunCtx({ providerThreadId: "oc-session", persistence: "thread" }));
    const index = calls[0]!.args.indexOf("--session");
    assert.equal(calls[0]!.args[index + 1], "oc-session");
  });
  it("parses text events and concatenates the content", () => {
    const output = parseOpencodeOutput(NDOCJSON_OUTPUT);
    assert.match(output, /## Review/);
    assert.match(output, /Found a bug in auth\.ts/);
  });

  it("handles error events by surfacing them in the output", () => {
    const errorOutput = JSON.stringify({ type: "error", content: "model timeout" });
    const result = parseOpencodeOutput(errorOutput);
    assert.match(result, /opencode error: model timeout/);
  });

  it("falls back to raw stdout when no JSON events are found", () => {
    const plain = "This is plain text, not NDJSON.";
    const result = parseOpencodeOutput(plain);
    assert.equal(result, plain);
  });

  it("handles empty output gracefully", () => {
    assert.equal(parseOpencodeOutput(""), "");
  });

  it("normalizes provider-reported token and cost events", () => {
    const parsed = parseOpencodeResult([
      JSON.stringify({ type: "step_finish", tokens: { input: 120, output: 20, reasoning: 5 }, cost: 0.004 }),
      JSON.stringify({ type: "text", content: "Reviewed" }),
    ].join("\n"));
    assert.deepEqual(parsed.usage, { tokensIn: 120, tokensOut: 25, costUsd: 0.004 });
  });

  it("omits usage when OpenCode emits no accounting event", async () => {
    const { fn } = makeFakeShellOut(NDOCJSON_OUTPUT);
    const result = await createOpencodeAgent(fn).run(makeRunCtx());
    assert.equal(result.usage, undefined);
  });
});

describe("opencode agent — run (output + toolState)", () => {
  it("returns the parsed NDJSON text as the review result", async () => {
    const { fn } = makeFakeShellOut(NDOCJSON_OUTPUT);
    const agent = createOpencodeAgent(fn);
    const result: AgentResult = await agent.run(makeRunCtx());
    assert.equal(result.success, true);
    assert.match(result.output!, /Found a bug/);
  });

  it("records the tool call into toolState by reference (P-plugin-3)", async () => {
    const { fn } = makeFakeShellOut(NDOCJSON_OUTPUT);
    const agent = createOpencodeAgent(fn);
    const ctx = makeRunCtx();
    await agent.run(ctx);
    assert.ok(ctx.toolState.calls.length > 0, "toolState must have the recorded call");
    assert.equal(ctx.toolState.calls[0]!.tool, "opencode.run");
  });

  it("returns failure on shell-out error (graceful, no crash)", async () => {
    const failingShellOut: ShellOut = () => { throw new Error("opencode crashed"); };
    const agent = createOpencodeAgent(failingShellOut);
    const result = await agent.run(makeRunCtx());
    assert.equal(result.success, false);
    assert.match(result.error!, /opencode crashed/);
  });

  it("preserves the provider status code in a current OpenCode error envelope", () => {
    const parsed = parseOpencodeResult(JSON.stringify({ type: "error", error: { data: { message: "authentication failed", statusCode: 401 } } }));
    assert.equal(parsed.error, "OpenCode provider returned HTTP 401: authentication failed");
  });

  it("classifies a provider 401 NDJSON envelope as authentication failure", async () => {
    const error = JSON.stringify({ type: "error", error: { data: { message: "Provider returned HTTP 401 Unauthorized" } } });
    const { fn } = makeFakeShellOut(error);
    const result = await createOpencodeAgent(fn).run(makeRunCtx());
    assert.equal(result.success, false);
    assert.equal(result.failure, "auth");
    assert.match(result.output ?? "", /401 Unauthorized/u);
  });
});

describe("opencode agent — W5 OPENCODE_PERMISSION bypass-immune deny (Phase 4.4)", () => {
  it("does not restrict OpenCode external runtime state through external_directory", async () => {
    const { fn, calls } = makeFakeShellOut(NDOCJSON_OUTPUT);
    const agent = createOpencodeAgent(fn);
    await agent.run(makeRunCtx());
    const env = calls[0]!.opts.env;
    assert.ok(env, "must pass env to shell-out");
    const perm = env!.OPENCODE_PERMISSION;
    assert.ok(perm, "must inject OPENCODE_PERMISSION env var");
    const parsed = JSON.parse(perm!) as { external_directory?: Record<string, string> };
    assert.equal(parsed.external_directory, undefined, "OpenCode needs its own external runtime state on Windows");
  });

  it("denies .git writes in the edit ruleset (git-mutation vector)", async () => {
    const { fn, calls } = makeFakeShellOut(NDOCJSON_OUTPUT);
    const agent = createOpencodeAgent(fn);
    await agent.run(makeRunCtx());
    const parsed = JSON.parse(calls[0]!.opts.env!.OPENCODE_PERMISSION!) as { edit: Record<string, string> };
    assert.equal(parsed.edit[".git"], "deny", "edit .git must be denied");
    assert.equal(parsed.edit["*/.git/*"], "deny", "nested .git writes must be denied");
  });

  it("denies .git/config reads in the read ruleset (credential leak vector)", async () => {
    const { fn, calls } = makeFakeShellOut(NDOCJSON_OUTPUT);
    const agent = createOpencodeAgent(fn);
    await agent.run(makeRunCtx());
    const parsed = JSON.parse(calls[0]!.opts.env!.OPENCODE_PERMISSION!) as { read: Record<string, string> };
    assert.equal(parsed.read[".git/config"], "deny", "read .git/config must be denied");
  });

  it("injects OPENCODE_CONFIG_CONTENT with bash:deny (no shell-out)", async () => {
    const { fn, calls } = makeFakeShellOut(NDOCJSON_OUTPUT);
    const agent = createOpencodeAgent(fn);
    await agent.run(makeRunCtx());
    const cfg = calls[0]!.opts.env!.OPENCODE_CONFIG_CONTENT;
    assert.ok(cfg, "must inject OPENCODE_CONFIG_CONTENT");
    const parsed = JSON.parse(cfg!) as { permission: { bash: string } };
    assert.equal(parsed.permission.bash, "deny", "bash must be denied");
  });

  it("records the permission-deny posture into the toolState trace (auditability)", async () => {
    const { fn } = makeFakeShellOut(NDOCJSON_OUTPUT);
    const agent = createOpencodeAgent(fn);
    const ctx = makeRunCtx({ subagentDeniedTools: ["git_push"] });
    await agent.run(ctx);
    const call = ctx.toolState.calls[0]!;
    const input = call.input as { permissionDeny: boolean; deniedToolsCount: number };
    assert.equal(input.permissionDeny, true);
    assert.equal(input.deniedToolsCount, 1);
  });
});
