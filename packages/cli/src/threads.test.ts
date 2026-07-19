import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent, AgentRunContext, AgentResult, NativeAgentProvider, NativeThread, NativeThreadStore } from "@gitgecko/review";
import { parseArgs } from "./orchestrator.js";
import { renderNativeThreadCommand, runNativeThreadCommand } from "./threads.js";

const createMemoryStore = (): NativeThreadStore & { records: Map<string, NativeThread> } => {
  const records = new Map<string, NativeThread>();
  return {
    records,
    read: (id) => records.get(id),
    list: () => [...records.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    write: (thread) => { records.set(thread.id, thread); },
    delete: (id) => records.delete(id),
    paths: () => [],
  };
};

const createAgentHarness = (result: AgentResult = { success: true, output: "Reviewed", providerThreadId: "provider-01" }) => {
  const contexts: AgentRunContext[] = [];
  const providers: NativeAgentProvider[] = [];
  const createAgent = (provider: NativeAgentProvider): Agent => {
    providers.push(provider);
    return {
      name: provider,
      install: async () => provider,
      run: async (context) => { contexts.push(context); return result; },
    };
  };
  return { contexts, providers, createAgent };
};

const fixed = {
  now: () => "2026-07-17T12:00:00.000Z",
  createId: () => "thr_gitgecko_test",
};

describe("threads argument contract", () => {
  const cases: readonly [readonly string[], Readonly<Record<string, unknown>>][] = [
    [["threads", "start", "review", "this"], { threadAction: "start", threadPrompt: "review this" }],
    [["threads", "start", "review", "--provider", "claude"], { threadProvider: "claude" }],
    [["threads", "start", "review", "--provider", "pi"], { threadProvider: "pi" }],
    [["threads", "start", "review", "--cwd", "C:\\repo"], { cwd: "C:\\repo" }],
    [["threads", "start", "review", "--permission", "workspace-write"], { permission: "workspace-write" }],
    [["threads", "start", "review", "--permission", "unrestricted"], { permission: "unrestricted" }],
    [["threads", "start", "review", "--json"], { json: true }],
    [["threads", "resume", "thr_abc", "continue"], { threadAction: "resume", threadId: "thr_abc", threadPrompt: "continue" }],
    [["threads", "read", "thr_abc"], { threadAction: "read", threadId: "thr_abc" }],
    [["threads", "delete", "thr_abc"], { threadAction: "delete", threadId: "thr_abc" }],
    [["threads", "list"], { threadAction: "list" }],
  ];
  for (const [argv, expected] of cases) {
    it(`parses ${argv.join(" ")}`, () => {
      const parsed = parseArgs(argv);
      assert.equal(parsed.command, "threads");
      for (const [key, value] of Object.entries(expected)) assert.deepEqual((parsed as unknown as Record<string, unknown>)[key], value);
    });
  }

  it("rejects an unknown action", () => assert.throws(() => parseArgs(["threads", "archive"]), /requires start/u));
  it("rejects an unknown provider", () => assert.throws(() => parseArgs(["threads", "start", "x", "--provider", "other"]), /provider/u));
  it("rejects an unknown permission", () => assert.throws(() => parseArgs(["threads", "start", "x", "--permission", "root"]), /permission/u));
});

describe("GitGecko-owned thread lifecycle", () => {
  it("starts with Codex by default", async () => {
    const store = createMemoryStore(); const harness = createAgentHarness();
    await runNativeThreadCommand({ action: "start", prompt: "Review" }, { store, ...harness, ...fixed });
    assert.deepEqual(harness.providers, ["codex"]);
  });

  it("starts with the selected Claude provider", async () => {
    const store = createMemoryStore(); const harness = createAgentHarness();
    await runNativeThreadCommand({ action: "start", provider: "claude", prompt: "Review" }, { store, ...harness, ...fixed });
    assert.deepEqual(harness.providers, ["claude"]);
  });

  it("starts with the selected Pi provider", async () => {
    const store = createMemoryStore(); const harness = createAgentHarness();
    await runNativeThreadCommand({ action: "start", provider: "pi", prompt: "Review" }, { store, ...harness, ...fixed });
    assert.deepEqual(harness.providers, ["pi"]);
  });

  it("defaults execution to read-only", async () => {
    const store = createMemoryStore(); const harness = createAgentHarness();
    await runNativeThreadCommand({ action: "start", prompt: "Review" }, { store, ...harness, ...fixed });
    assert.equal(harness.contexts[0]?.permission, "read-only");
  });

  for (const permission of ["workspace-write", "unrestricted"] as const) {
    it(`passes explicit ${permission} permission`, async () => {
      const store = createMemoryStore(); const harness = createAgentHarness();
      await runNativeThreadCommand({ action: "start", prompt: "Review", permission }, { store, ...harness, ...fixed });
      assert.equal(harness.contexts[0]?.permission, permission);
    });
  }

  it("executes in the selected cwd", async () => {
    const store = createMemoryStore(); const harness = createAgentHarness();
    await runNativeThreadCommand({ action: "start", prompt: "Review", cwd: process.cwd() }, { store, ...harness, ...fixed });
    assert.equal(harness.contexts[0]?.cwd, process.cwd());
  });

  it("requests provider thread persistence", async () => {
    const store = createMemoryStore(); const harness = createAgentHarness();
    await runNativeThreadCommand({ action: "start", prompt: "Review" }, { store, ...harness, ...fixed });
    assert.equal(harness.contexts[0]?.persistence, "thread");
  });

  it("stores the provider thread id", async () => {
    const store = createMemoryStore(); const harness = createAgentHarness();
    const result = await runNativeThreadCommand({ action: "start", prompt: "Review" }, { store, ...harness, ...fixed });
    assert.equal(result.thread?.providerThreadId, "provider-01");
  });

  it("stores normalized user and assistant turns", async () => {
    const store = createMemoryStore(); const harness = createAgentHarness();
    const result = await runNativeThreadCommand({ action: "start", prompt: "Review" }, { store, ...harness, ...fixed });
    assert.deepEqual(result.thread?.turns.map((turn) => turn.role), ["user", "assistant"]);
  });

  it("does not persist a failed start", async () => {
    const store = createMemoryStore(); const harness = createAgentHarness({ success: false, error: "401", failure: "auth" });
    const result = await runNativeThreadCommand({ action: "start", prompt: "Review" }, { store, ...harness, ...fixed });
    assert.equal(result.success, false); assert.equal(store.list().length, 0); assert.equal(result.failure, "auth");
  });

  it("rejects a successful provider response without a session id", async () => {
    const store = createMemoryStore(); const harness = createAgentHarness({ success: true, output: "Reviewed" });
    const result = await runNativeThreadCommand({ action: "start", prompt: "Review" }, { store, ...harness, ...fixed });
    assert.equal(result.failure, "malformed-output");
  });

  it("rejects an empty start prompt", async () => {
    await assert.rejects(() => runNativeThreadCommand({ action: "start", prompt: "" }, { store: createMemoryStore(), ...createAgentHarness(), ...fixed }), /required/u);
  });

  it("resumes through the original provider", async () => {
    const store = createMemoryStore(); const first = createAgentHarness();
    await runNativeThreadCommand({ action: "start", provider: "claude", prompt: "Review" }, { store, ...first, ...fixed });
    const second = createAgentHarness({ success: true, output: "Continued", providerThreadId: "provider-01" });
    await runNativeThreadCommand({ action: "resume", id: "thr_gitgecko_test", prompt: "Continue" }, { store, ...second, ...fixed });
    assert.deepEqual(second.providers, ["claude"]);
  });

  it("passes the provider session id on resume", async () => {
    const store = createMemoryStore(); const first = createAgentHarness();
    await runNativeThreadCommand({ action: "start", prompt: "Review" }, { store, ...first, ...fixed });
    const second = createAgentHarness();
    await runNativeThreadCommand({ action: "resume", id: "thr_gitgecko_test", prompt: "Continue" }, { store, ...second, ...fixed });
    assert.equal(second.contexts[0]?.providerThreadId, "provider-01");
  });

  it("passes normalized history to providers that do not own session storage", async () => {
    const store = createMemoryStore(); const first = createAgentHarness();
    await runNativeThreadCommand({ action: "start", provider: "pi", prompt: "Review" }, { store, ...first, ...fixed });
    const second = createAgentHarness();
    await runNativeThreadCommand({ action: "resume", id: "thr_gitgecko_test", prompt: "Continue" }, { store, ...second, ...fixed });
    assert.deepEqual(second.contexts[0]?.conversation?.map((turn) => turn.text), ["Review", "Reviewed"]);
  });

  it("appends resume turns", async () => {
    const store = createMemoryStore(); const harness = createAgentHarness();
    await runNativeThreadCommand({ action: "start", prompt: "Review" }, { store, ...harness, ...fixed });
    const result = await runNativeThreadCommand({ action: "resume", id: "thr_gitgecko_test", prompt: "Continue" }, { store, ...harness, ...fixed });
    assert.equal(result.thread?.turns.length, 4);
  });

  it("marks a failed resume without losing history", async () => {
    const store = createMemoryStore(); const first = createAgentHarness();
    await runNativeThreadCommand({ action: "start", prompt: "Review" }, { store, ...first, ...fixed });
    const failed = createAgentHarness({ success: false, error: "session gone", failure: "provider" });
    const result = await runNativeThreadCommand({ action: "resume", id: "thr_gitgecko_test", prompt: "Continue" }, { store, ...failed, ...fixed });
    assert.equal(result.thread?.status, "failed"); assert.equal(result.thread?.turns.length, 4);
  });

  it("returns not-found for an unknown resume id", async () => {
    const result = await runNativeThreadCommand({ action: "resume", id: "thr_missing", prompt: "Continue" }, { store: createMemoryStore(), ...createAgentHarness(), ...fixed });
    assert.equal(result.failure, "not-found");
  });

  it("lists only owner records", async () => {
    const store = createMemoryStore(); const harness = createAgentHarness();
    await runNativeThreadCommand({ action: "start", prompt: "Review" }, { store, ...harness, ...fixed });
    const result = await runNativeThreadCommand({ action: "list" }, { store, ...harness, ...fixed });
    assert.deepEqual(result.threads?.map((thread) => thread.id), ["thr_gitgecko_test"]);
  });

  it("reads a normalized transcript", async () => {
    const store = createMemoryStore(); const harness = createAgentHarness();
    await runNativeThreadCommand({ action: "start", prompt: "Review" }, { store, ...harness, ...fixed });
    const result = await runNativeThreadCommand({ action: "read", id: "thr_gitgecko_test" }, { store, ...harness, ...fixed });
    assert.match(result.output, /user: Review/u); assert.match(result.output, /assistant: Reviewed/u);
  });

  it("returns not-found for an unknown read id", async () => {
    const result = await runNativeThreadCommand({ action: "read", id: "thr_missing" }, { store: createMemoryStore(), ...createAgentHarness(), ...fixed });
    assert.equal(result.failure, "not-found");
  });

  it("deletes only the GitGecko record", async () => {
    const store = createMemoryStore(); const harness = createAgentHarness();
    await runNativeThreadCommand({ action: "start", prompt: "Review" }, { store, ...harness, ...fixed });
    const result = await runNativeThreadCommand({ action: "delete", id: "thr_gitgecko_test" }, { store, ...harness, ...fixed });
    assert.equal(result.success, true); assert.match(result.output, /Provider-owned CLI history was not deleted/u); assert.equal(store.list().length, 0);
  });

  it("returns not-found when deleting twice", async () => {
    const result = await runNativeThreadCommand({ action: "delete", id: "thr_missing" }, { store: createMemoryStore(), ...createAgentHarness(), ...fixed });
    assert.equal(result.failure, "not-found");
  });

  it("renders an empty list without pretending provider history was scanned", () => {
    assert.equal(renderNativeThreadCommand({ success: true, action: "list", output: "0", threads: [] }), "No GitGecko threads.");
  });

  it("renders the GitGecko thread id after start", async () => {
    const store = createMemoryStore(); const harness = createAgentHarness();
    const result = await runNativeThreadCommand({ action: "start", prompt: "Review" }, { store, ...harness, ...fixed });
    assert.match(renderNativeThreadCommand(result), /Thread: thr_gitgecko_test/u);
  });
});
