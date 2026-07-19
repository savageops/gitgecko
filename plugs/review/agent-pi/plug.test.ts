import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import type { AgentRunContext, LocalEndpointConfig, NativeAgentPermission } from "@gitgecko/review";
import { assertPiMutationPath, createNativeAgentProviderPlug, createPiAgent, createPiMutationOperations, manifest, readPiConfig, resolvePiTools, seedPiConversation, setup, type PiSession, type PiSessionEvent, type PiSessionFactory, type PiSessionOptions } from "./plug.js";

const config: LocalEndpointConfig = { baseUrl: "http://127.0.0.1:1234/v1", modelId: "fixture-model", protocol: "openai-chat-completions" };
const context = (overrides: Partial<AgentRunContext> = {}): AgentRunContext => ({
  payload: { repo: "fixture/repo", prNumber: 7, title: "PI fixture", diff: "+const pi = true;", files: ["pi.ts"] },
  cwd: process.cwd(),
  permission: "read-only",
  persistence: "thread",
  mcpServerUrl: "",
  tmpdir: process.cwd(),
  subagentDeniedTools: [],
  instructions: { systemPrompt: "Review the repository.", rules: ["Do not invent findings."] },
  toolState: { calls: [] },
  apiToken: "",
  ...overrides,
});

interface FakeState {
  readonly options: PiSessionOptions[];
  prompts: string[];
  aborts: number;
  disposes: number;
  unsubscribes: number;
}

const fakeFactory = (settings: { output?: string; error?: Error; events?: readonly PiSessionEvent[]; usage?: { input: number; output: number; cost: number }; id?: string; onPrompt?: () => void } = {}): { factory: PiSessionFactory; state: FakeState } => {
  const state: FakeState = { options: [], prompts: [], aborts: 0, disposes: 0, unsubscribes: 0 };
  const factory: PiSessionFactory = async (options) => {
    state.options.push(options);
    let listener: Parameters<PiSession["subscribe"]>[0] = () => undefined;
    return {
      id: settings.id ?? options.sessionId,
      subscribe: (next) => { listener = next; return () => { state.unsubscribes += 1; }; },
      prompt: async (prompt) => {
        state.prompts.push(prompt);
        settings.onPrompt?.();
        if (settings.error) throw settings.error;
        for (const event of settings.events ?? []) listener(event);
        if (settings.output !== undefined) listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: settings.output } });
      },
      abort: async () => { state.aborts += 1; },
      dispose: () => { state.disposes += 1; },
      usage: () => settings.usage,
    };
  };
  return { factory, state };
};

describe("PI manifest and install", () => {
  it("declares the review owner", () => assert.equal(manifest.owner, "review"));
  it("declares agent-backend", () => assert.ok(manifest.capabilities.includes("agent-backend")));
  it("uses the stable PI id", () => assert.equal(manifest.id, "review-agent-pi"));
  it("renders model and endpoint without credentials", async () => assert.equal(await createPiAgent(config, fakeFactory().factory).install(), "pi coding-agent: fixture-model @ http://127.0.0.1:1234"));
  it("rejects a malformed endpoint at install", async () => assert.rejects(() => createPiAgent({ ...config, baseUrl: "not a URL" }, fakeFactory().factory).install(), /Invalid URL/u));
});

describe("PI socket registration", () => {
  it("parses complete endpoint configuration", () => assert.deepEqual(readPiConfig(config), config));
  it("rejects missing endpoint configuration", () => assert.equal(readPiConfig({ modelId: "fixture" }), undefined));
  it("rejects unsupported protocols", () => assert.equal(readPiConfig({ ...config, protocol: "legacy" }), undefined));
  it("registers one request-scoped peer backend", async () => {
    let contribution: Parameters<Parameters<typeof setup>[0]["register"]>[1] | undefined;
    await setup({ ctx: { config: { ...config } }, register: (_capability, value) => { contribution = value; } });
    assert.equal(contribution?.id, "pi-agent");
    assert.equal(contribution?.agent.name, "pi");
    assert.equal(contribution?.create?.({ ...config }).name, "pi");
  });
  it("fingerprints endpoint/model capability inputs without persisting credentials", () => {
    const key = createNativeAgentProviderPlug().profileKey?.({ baseUrl: config.baseUrl, model: config.modelId, ...(config.protocol ? { protocol: config.protocol } : {}), apiKey: "secret" });
    assert.deepEqual(key, { baseUrl: config.baseUrl, model: config.modelId, protocol: config.protocol });
  });
  it("fails closed when the socket receives incomplete config", async () => {
    let contribution: Parameters<Parameters<typeof setup>[0]["register"]>[1] | undefined;
    await setup({ ctx: { config: {} }, register: (_capability, value) => { contribution = value; } });
    const result = await contribution!.agent.run(context());
    assert.equal(result.failure, "invalid-arguments");
  });
});

describe("PI permission-derived tools", () => {
  const expectations: readonly [NativeAgentPermission, readonly string[]][] = [
    ["read-only", ["read", "grep", "find", "ls"]],
    ["workspace-write", ["read", "grep", "find", "ls", "edit", "write"]],
    ["unrestricted", ["read", "grep", "find", "ls", "edit", "write", "bash"]],
  ];
  for (const [permission, expected] of expectations) {
    it(`${permission} exposes its exact allowlist`, () => assert.deepEqual(resolvePiTools(context({ permission })), expected));
    it(`${permission} honors each owner denial`, () => {
      const denied = expected[expected.length - 1]!;
      assert.ok(!resolvePiTools(context({ permission, subagentDeniedTools: [denied] })).includes(denied as never));
    });
    it(`${permission} ignores unrelated denial names`, () => assert.deepEqual(resolvePiTools(context({ permission, subagentDeniedTools: ["unknown"] })), expected));
  }
  it("matches denial names case-insensitively", () => assert.deepEqual(resolvePiTools(context({ subagentDeniedTools: ["READ"] })), ["grep", "find", "ls"]));
  it("never gives bash to workspace-write", () => assert.ok(!resolvePiTools(context({ permission: "workspace-write" })).includes("bash")));
  it("never gives mutation tools to read-only", () => assert.ok(resolvePiTools(context()).every((tool) => !["edit", "write", "bash"].includes(tool))));
});

describe("PI workspace-write confinement", () => {
  const fixture = async () => {
    const base = await mkdtemp(join(tmpdir(), "gitgecko-pi-boundary-"));
    const root = join(base, "repo");
    const outside = join(base, "outside");
    await Promise.all([mkdir(root), mkdir(outside)]);
    return { base, root, outside };
  };

  it("accepts the repository root", async () => { const value = await fixture(); try { assert.equal(await assertPiMutationPath(value.root, value.root), resolve(value.root)); } finally { await rm(value.base, { recursive: true, force: true }); } });
  it("accepts a nested existing file", async () => { const value = await fixture(); try { const path = join(value.root, "src", "file.ts"); await mkdir(join(value.root, "src")); await writeFile(path, "safe"); assert.equal(await assertPiMutationPath(value.root, path), resolve(path)); } finally { await rm(value.base, { recursive: true, force: true }); } });
  it("accepts a nested not-yet-created file", async () => { const value = await fixture(); try { const path = join(value.root, "new", "file.ts"); assert.equal(await assertPiMutationPath(value.root, path), resolve(path)); } finally { await rm(value.base, { recursive: true, force: true }); } });
  it("rejects an absolute path outside the repository", async () => { const value = await fixture(); try { await assert.rejects(() => assertPiMutationPath(value.root, join(value.outside, "escape.ts")), /outside repository/u); } finally { await rm(value.base, { recursive: true, force: true }); } });
  it("rejects parent traversal outside the repository", async () => { const value = await fixture(); try { await assert.rejects(() => assertPiMutationPath(value.root, join(value.root, "..", "outside", "escape.ts")), /outside repository/u); } finally { await rm(value.base, { recursive: true, force: true }); } });
  it("rejects an existing directory symlink escape", async () => { const value = await fixture(); try { const link = join(value.root, "linked"); await symlink(value.outside, link, process.platform === "win32" ? "junction" : "dir"); await assert.rejects(() => assertPiMutationPath(value.root, join(link, "escape.ts")), /symlink escape/u); } finally { await rm(value.base, { recursive: true, force: true }); } });
  it("rejects an existing file symlink escape", async () => { const value = await fixture(); try { const outsideFile = join(value.outside, "secret.txt"); const link = join(value.root, "secret.txt"); await writeFile(outsideFile, "secret"); await symlink(outsideFile, link, "file"); await assert.rejects(() => assertPiMutationPath(value.root, link), /symlink escape/u); } finally { await rm(value.base, { recursive: true, force: true }); } });
  it("confined write creates a nested file inside the repository", async () => { const value = await fixture(); try { const operations = createPiMutationOperations(value.root); const target = join(value.root, "nested", "safe.txt"); await operations.write.mkdir(join(value.root, "nested")); await operations.write.writeFile(target, "safe"); assert.equal(await readFile(target, "utf8"), "safe"); } finally { await rm(value.base, { recursive: true, force: true }); } });
  it("confined write refuses an outside file", async () => { const value = await fixture(); try { const operations = createPiMutationOperations(value.root); await assert.rejects(() => operations.write.writeFile(join(value.outside, "escape.txt"), "unsafe"), /outside repository/u); } finally { await rm(value.base, { recursive: true, force: true }); } });
  it("confined edit refuses reads through a symlinked directory", async () => { const value = await fixture(); try { const link = join(value.root, "linked"); await symlink(value.outside, link, process.platform === "win32" ? "junction" : "dir"); const operations = createPiMutationOperations(value.root); await assert.rejects(() => operations.edit.readFile(join(link, "secret.txt")), /symlink escape/u); } finally { await rm(value.base, { recursive: true, force: true }); } });
});

describe("PI SDK lifecycle", () => {
  it("passes the repository cwd to the SDK", async () => { const fake = fakeFactory({ output: "ok" }); await createPiAgent(config, fake.factory).run(context({ cwd: "C:\\repo" })); assert.equal(fake.state.options[0]?.cwd, "C:\\repo"); });
  it("passes the selected endpoint config unchanged", async () => { const fake = fakeFactory({ output: "ok" }); await createPiAgent(config, fake.factory).run(context()); assert.equal(fake.state.options[0]?.config, config); });
  it("passes the owner system prompt", async () => { const fake = fakeFactory({ output: "ok" }); await createPiAgent(config, fake.factory).run(context()); assert.equal(fake.state.options[0]?.systemPrompt, "Review the repository."); });
  it("prefixes persona exactly once", async () => { const fake = fakeFactory({ output: "ok" }); await createPiAgent(config, fake.factory).run(context({ instructions: { persona: "Senior reviewer", systemPrompt: "Review.", rules: [] } })); assert.equal(fake.state.options[0]?.systemPrompt, "Senior reviewer\n\nReview."); });
  it("uses the existing provider thread id", async () => { const fake = fakeFactory({ output: "ok" }); await createPiAgent(config, fake.factory).run(context({ providerThreadId: "pi_existing" })); assert.equal(fake.state.options[0]?.sessionId, "pi_existing"); });
  it("passes normalized thread history to the SDK session", async () => {
    const conversation = [
      { role: "user" as const, text: "first question", at: "2026-07-17T10:00:00.000Z" },
      { role: "assistant" as const, text: "first answer", at: "2026-07-17T10:00:01.000Z" },
    ];
    const fake = fakeFactory({ output: "continued" });
    await createPiAgent(config, fake.factory).run(context({ conversation }));
    assert.deepEqual(fake.state.options[0]?.conversation, conversation);
  });
  it("generates a PI-prefixed session id", async () => { const fake = fakeFactory({ output: "ok" }); await createPiAgent(config, fake.factory).run(context()); assert.match(fake.state.options[0]?.sessionId ?? "", /^pi_/u); });
  it("returns streamed assistant text", async () => { const fake = fakeFactory({ output: "PI review" }); const result = await createPiAgent(config, fake.factory).run(context()); assert.equal(result.output, "PI review"); });
  it("returns terminal assistant text when a compatible provider does not stream deltas", async () => {
    const fake = fakeFactory({ events: [{ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "PI terminal review" }] }] }] });
    const result = await createPiAgent(config, fake.factory).run(context());
    assert.equal(result.output, "PI terminal review");
  });
  it("classifies terminal provider errors instead of calling an empty response malformed", async () => {
    const fake = fakeFactory({ events: [{ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "401: Authentication Failed" }] }] });
    const result = await createPiAgent(config, fake.factory).run(context());
    assert.equal(result.failure, "auth");
  });
  it("returns provider-reported usage", async () => { const fake = fakeFactory({ output: "ok", usage: { input: 11, output: 4, cost: 0.2 } }); const result = await createPiAgent(config, fake.factory).run(context()); assert.deepEqual(result.usage, { tokensIn: 11, tokensOut: 4, costUsd: 0.2 }); });
  it("does not fabricate absent usage", async () => { const fake = fakeFactory({ output: "ok" }); const result = await createPiAgent(config, fake.factory).run(context()); assert.equal(result.usage, undefined); });
  it("returns the SDK session id for thread persistence", async () => { const fake = fakeFactory({ output: "ok", id: "pi_sdk" }); const result = await createPiAgent(config, fake.factory).run(context()); assert.equal(result.providerThreadId, "pi_sdk"); });
  it("omits provider id for ephemeral runs", async () => { const fake = fakeFactory({ output: "ok" }); const result = await createPiAgent(config, fake.factory).run(context({ persistence: "ephemeral" })); assert.equal(result.providerThreadId, undefined); });
  it("records one normalized tool call", async () => { const fake = fakeFactory({ output: "ok" }); const ctx = context(); await createPiAgent(config, fake.factory).run(ctx); assert.equal(ctx.toolState.calls[0]?.tool, "pi.session"); });
  it("emits one owner tool event", async () => { const fake = fakeFactory({ output: "ok" }); let calls = 0; await createPiAgent(config, fake.factory).run(context({ onToolUse: () => { calls += 1; } })); assert.equal(calls, 1); });
  it("unsubscribes after success", async () => { const fake = fakeFactory({ output: "ok" }); await createPiAgent(config, fake.factory).run(context()); assert.equal(fake.state.unsubscribes, 1); });
  it("disposes after success", async () => { const fake = fakeFactory({ output: "ok" }); await createPiAgent(config, fake.factory).run(context()); assert.equal(fake.state.disposes, 1); });
  it("includes review payload in the prompt", async () => { const fake = fakeFactory({ output: "ok" }); await createPiAgent(config, fake.factory).run(context()); assert.match(fake.state.prompts[0] ?? "", /PI fixture/u); });
  it("classifies empty assistant output", async () => { const fake = fakeFactory({ output: "" }); const result = await createPiAgent(config, fake.factory).run(context()); assert.equal(result.failure, "malformed-output"); });
  it("classifies authentication errors", async () => { const fake = fakeFactory({ error: new Error("401 unauthorized") }); const result = await createPiAgent(config, fake.factory).run(context()); assert.equal(result.failure, "auth"); });
  it("classifies permission errors", async () => { const fake = fakeFactory({ error: new Error("permission denied") }); const result = await createPiAgent(config, fake.factory).run(context()); assert.equal(result.failure, "permission"); });
  it("classifies endpoint errors as provider failures", async () => { const fake = fakeFactory({ error: new Error("endpoint fetch failed") }); const result = await createPiAgent(config, fake.factory).run(context()); assert.equal(result.failure, "provider"); });
  it("disposes after provider failure", async () => { const fake = fakeFactory({ error: new Error("provider failed") }); await createPiAgent(config, fake.factory).run(context()); assert.equal(fake.state.disposes, 1); });
  it("cancels before creating a session", async () => { const controller = new AbortController(); controller.abort(); const fake = fakeFactory({ output: "ignored" }); const result = await createPiAgent(config, fake.factory).run(context({ signal: controller.signal })); assert.equal(result.failure, "cancelled"); assert.equal(fake.state.options.length, 0); });
  it("aborts an active SDK turn", async () => { const controller = new AbortController(); const fake = fakeFactory({ output: "ignored", onPrompt: () => controller.abort() }); const result = await createPiAgent(config, fake.factory).run(context({ signal: controller.signal })); assert.equal(result.failure, "cancelled"); assert.equal(fake.state.aborts, 1); });
});

describe("PI conversation rehydration", () => {
  it("seeds user and assistant turns in order with their timestamps", () => {
    const messages: unknown[] = [];
    seedPiConversation(
      { appendMessage: (message) => { messages.push(message); return "entry"; } },
      [
        { role: "user", text: "question", at: "2026-07-17T10:00:00.000Z" },
        { role: "assistant", text: "answer", at: "2026-07-17T10:00:02.000Z" },
      ],
      config,
    );
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[0], { role: "user", content: "question", timestamp: Date.parse("2026-07-17T10:00:00.000Z") });
    assert.deepEqual((messages[1] as { role: string; content: unknown; timestamp: number }).content, [{ type: "text", text: "answer" }]);
    assert.equal((messages[1] as { role: string }).role, "assistant");
    assert.equal((messages[1] as { timestamp: number }).timestamp, Date.parse("2026-07-17T10:00:02.000Z"));
  });

  it("accepts empty history without creating messages", () => {
    let calls = 0;
    seedPiConversation({ appendMessage: () => { calls += 1; return "entry"; } }, [], config);
    assert.equal(calls, 0);
  });
});
