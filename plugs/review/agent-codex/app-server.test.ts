import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type { SpawnOptionsWithoutStdio } from "node:child_process";
import { codexSandboxPolicy, createCodexAppServerRunner, type CodexAppServerRequest } from "./app-server.js";

interface WireMessage { readonly id?: number; readonly method?: string; readonly params?: unknown }

class ManualClock {
  private nextId = 1;
  readonly timers = new Map<number, () => void>();
  readonly setTimeout = (callback: () => void): ReturnType<typeof setTimeout> => {
    const id = this.nextId++;
    this.timers.set(id, callback);
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  readonly clearTimeout = (timer: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(timer as unknown as number);
  };
  fireNext(): void {
    const entry = this.timers.entries().next().value as [number, () => void] | undefined;
    assert.ok(entry, "expected a pending timer");
    this.timers.delete(entry[0]);
    entry[1]();
  }
}

class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  killCalls = 0;
  readonly messages: WireMessage[] = [];
  private buffer = "";

  constructor(private readonly onMessage?: (message: WireMessage, process: FakeProcess) => void) {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        const message = JSON.parse(line) as WireMessage;
        this.messages.push(message);
        this.onMessage?.(message, this);
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  kill(): boolean {
    this.killed = true;
    this.killCalls += 1;
    return true;
  }

  reply(id: number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
  }

  rpcError(id: number, message: string, code = -32000): void {
    this.stdout.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
  }

  notify(method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }
}

const baseRequest = (overrides: Partial<CodexAppServerRequest> = {}): CodexAppServerRequest => ({
  cwd: "C:\\repo",
  permission: "read-only",
  persistence: "ephemeral",
  prompt: "Review this patch.",
  timeoutMs: 1_000,
  ...overrides,
});

const successfulProcess = (custom?: (message: WireMessage, process: FakeProcess) => boolean): FakeProcess => new FakeProcess((message, process) => {
  if (custom?.(message, process)) return;
  if (message.method === "initialize") process.reply(message.id!, { userAgent: "test" });
  if (message.method === "thread/start" || message.method === "thread/resume") process.reply(message.id!, { thread: { id: "thread-1" } });
  if (message.method === "turn/start") {
    process.reply(message.id!, { turn: { id: "turn-1" } });
    queueMicrotask(() => process.notify("turn/completed", { turn: { id: "turn-1", status: "completed" } }));
  }
});

const harness = (process: FakeProcess, clock = new ManualClock()) => {
  const spawns: Array<{ executable: string; args: readonly string[]; options: SpawnOptionsWithoutStdio }> = [];
  const runner = createCodexAppServerRunner({
    resolveCommand: () => ({ executable: "C:\\bin\\codex.exe", argumentPrefix: ["shim"] }),
    spawnProcess: (executable, args, options) => {
      spawns.push({ executable, args, options });
      return process as never;
    },
    clock,
    environment: { TEST_ENV: "yes" },
  });
  return { runner, spawns, clock };
};

const flush = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };

describe("Codex App Server mapping", () => {
  it("maps read-only to the official policy", () => assert.deepEqual(codexSandboxPolicy("read-only", "C:\\repo"), { type: "readOnly", networkAccess: false }));
  it("maps workspace-write to only the requested cwd", () => assert.deepEqual(codexSandboxPolicy("workspace-write", "C:\\repo"), { type: "workspaceWrite", writableRoots: ["C:\\repo"], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }));
  it("maps unrestricted to dangerFullAccess", () => assert.deepEqual(codexSandboxPolicy("unrestricted", "C:\\repo"), { type: "dangerFullAccess" }));
  it("passes cwd, environment, shell-free mode, and app-server command to spawn", async () => {
    const process = successfulProcess();
    const { runner, spawns } = harness(process);
    await runner.run(baseRequest());
    assert.deepEqual(spawns[0], { executable: "C:\\bin\\codex.exe", args: ["shim", "app-server"], options: { cwd: "C:\\repo", env: { TEST_ENV: "yes" }, shell: false, windowsHide: true } });
  });
  it("maps unrestricted thread sandbox to the CLI spelling", async () => {
    const process = successfulProcess();
    await harness(process).runner.run(baseRequest({ permission: "unrestricted" }));
    assert.equal((process.messages.find((message) => message.method === "thread/start")!.params as { sandbox: string }).sandbox, "danger-full-access");
  });
});

describe("Codex App Server lifecycle", () => {
  it("initializes before starting a thread", async () => {
    const process = successfulProcess();
    await harness(process).runner.run(baseRequest());
    assert.deepEqual(process.messages.slice(0, 3).map(({ method }) => method), ["initialize", "initialized", "thread/start"]);
  });
  it("sends the official parameterless initialized notification", async () => {
    const process = successfulProcess();
    await harness(process).runner.run(baseRequest());
    assert.deepEqual(process.messages.find(({ method }) => method === "initialized"), { method: "initialized" });
  });
  it("starts an ephemeral thread by default", async () => {
    const process = successfulProcess();
    await harness(process).runner.run(baseRequest());
    assert.equal((process.messages.find(({ method }) => method === "thread/start")!.params as { ephemeral: boolean }).ephemeral, true);
  });
  it("starts a persistent thread when requested", async () => {
    const process = successfulProcess();
    await harness(process).runner.run(baseRequest({ persistence: "thread" }));
    assert.equal((process.messages.find(({ method }) => method === "thread/start")!.params as { ephemeral: boolean }).ephemeral, false);
  });
  it("passes an optional model only on thread start", async () => {
    const process = successfulProcess();
    await harness(process).runner.run(baseRequest({ model: "gpt-5.4-mini" }));
    assert.equal((process.messages.find(({ method }) => method === "thread/start")!.params as { model: string }).model, "gpt-5.4-mini");
  });
  it("resumes the supplied provider thread", async () => {
    const process = successfulProcess();
    const result = await harness(process).runner.run(baseRequest({ providerThreadId: "existing" }));
    assert.equal((process.messages.find(({ method }) => method === "thread/resume")!.params as { threadId: string }).threadId, "existing");
    assert.equal(result.providerThreadId, "thread-1");
  });
  it("falls back to the supplied id when resume omits its thread", async () => {
    const process = successfulProcess((message, child) => {
      if (message.method !== "thread/resume") return false;
      child.reply(message.id!, {});
      return true;
    });
    const result = await harness(process).runner.run(baseRequest({ providerThreadId: "existing" }));
    assert.equal(result.providerThreadId, "existing");
  });
  it("rejects a start response without a thread id", async () => {
    const process = successfulProcess((message, child) => {
      if (message.method !== "thread/start") return false;
      child.reply(message.id!, { thread: {} });
      return true;
    });
    const result = await harness(process).runner.run(baseRequest());
    assert.equal(result.success, false);
    assert.match(result.error!, /thread id/);
  });
  it("starts a turn with prompt, cwd, approval policy, and sandbox policy", async () => {
    const process = successfulProcess();
    await harness(process).runner.run(baseRequest({ permission: "workspace-write" }));
    const params = process.messages.find(({ method }) => method === "turn/start")!.params as Record<string, unknown>;
    assert.deepEqual(params, { threadId: "thread-1", input: [{ type: "text", text: "Review this patch.", text_elements: [] }], cwd: "C:\\repo", approvalPolicy: "never", sandboxPolicy: codexSandboxPolicy("workspace-write", "C:\\repo") });
  });
  it("returns streamed deltas in order", async () => {
    const process = successfulProcess((message, child) => {
      if (message.method !== "turn/start") return false;
      child.reply(message.id!, { turn: { id: "turn-1" } });
      child.notify("item/agentMessage/delta", { delta: "hello " });
      child.notify("item/agentMessage/delta", { delta: "world" });
      child.notify("turn/completed", { turn: { status: "completed" } });
      return true;
    });
    assert.equal((await harness(process).runner.run(baseRequest())).output, "hello world");
  });
  it("uses completed agent text as the authoritative final output", async () => {
    const process = successfulProcess((message, child) => {
      if (message.method !== "turn/start") return false;
      child.reply(message.id!, { turn: { id: "turn-1" } });
      child.notify("item/agentMessage/delta", { delta: "draft" });
      child.notify("item/completed", { item: { type: "agentMessage", text: "final" } });
      child.notify("turn/completed", { turn: { status: "completed" } });
      return true;
    });
    assert.equal((await harness(process).runner.run(baseRequest())).output, "final");
  });
  it("ignores completed non-agent items", async () => {
    const process = successfulProcess((message, child) => {
      if (message.method !== "turn/start") return false;
      child.reply(message.id!, { turn: { id: "turn-1" } });
      child.notify("item/agentMessage/delta", { delta: "answer" });
      child.notify("item/completed", { item: { type: "commandExecution", text: "noise" } });
      child.notify("turn/completed", { turn: { status: "completed" } });
      return true;
    });
    assert.equal((await harness(process).runner.run(baseRequest())).output, "answer");
  });
  it("returns failed turn details", async () => {
    const process = successfulProcess((message, child) => {
      if (message.method !== "turn/start") return false;
      child.reply(message.id!, { turn: { id: "turn-1" } });
      child.notify("turn/completed", { turn: { status: "failed", error: { message: "provider rejected request" } } });
      return true;
    });
    assert.match((await harness(process).runner.run(baseRequest())).error!, /provider rejected/);
  });
  it("maps interrupted completion to cancellation failure", async () => {
    const process = successfulProcess((message, child) => {
      if (message.method !== "turn/start") return false;
      child.reply(message.id!, { turn: { id: "turn-1" } });
      child.notify("turn/completed", { turn: { status: "interrupted" } });
      return true;
    });
    const result = await harness(process).runner.run(baseRequest());
    assert.match(result.error!, /cancelled/);
    assert.equal(result.failure, "cancelled");
  });
});

describe("Codex App Server failures and bounds", () => {
  it("reports command resolution failure as not installed", async () => {
    const runner = createCodexAppServerRunner({ resolveCommand: () => { throw new Error("ENOENT codex"); } });
    assert.equal((await runner.run(baseRequest())).failure, "not-installed");
  });
  it("reports synchronous spawn failure", async () => {
    const runner = createCodexAppServerRunner({ resolveCommand: () => ({ executable: "codex", argumentPrefix: [] }), spawnProcess: () => { throw new Error("spawn denied"); } });
    assert.match((await runner.run(baseRequest())).error!, /spawn denied/);
  });
  it("rejects zero timeout before spawning", async () => {
    const process = successfulProcess();
    const { runner, spawns } = harness(process);
    assert.equal((await runner.run(baseRequest({ timeoutMs: 0 }))).failure, "invalid-arguments");
    assert.equal(spawns.length, 0);
  });
  it("rejects non-finite environment timeout", async () => {
    const runner = createCodexAppServerRunner({ environment: { CODEX_TIMEOUT_MS: "NaN" } });
    assert.equal((await runner.run({ cwd: "C:\\repo", permission: "read-only", persistence: "ephemeral", prompt: "Review this patch." })).failure, "invalid-arguments");
  });
  it("times out initialize independently", async () => {
    const process = new FakeProcess();
    const { runner, clock } = harness(process);
    const pending = runner.run(baseRequest());
    await flush(); clock.fireNext();
    assert.match((await pending).error!, /initialize timed out/);
  });
  it("times out thread start independently", async () => {
    const process = new FakeProcess((message, child) => { if (message.method === "initialize") child.reply(message.id!, {}); });
    const { runner, clock } = harness(process);
    const pending = runner.run(baseRequest());
    await flush(); clock.fireNext();
    assert.match((await pending).error!, /thread\/start timed out/);
  });
  it("times out thread resume independently", async () => {
    const process = new FakeProcess((message, child) => { if (message.method === "initialize") child.reply(message.id!, {}); });
    const { runner, clock } = harness(process);
    const pending = runner.run(baseRequest({ providerThreadId: "old" }));
    await flush(); clock.fireNext();
    assert.match((await pending).error!, /thread\/resume timed out/);
  });
  it("times out turn start independently", async () => {
    const process = new FakeProcess((message, child) => {
      if (message.method === "initialize") child.reply(message.id!, {});
      if (message.method === "thread/start") child.reply(message.id!, { thread: { id: "thread-1" } });
    });
    const { runner, clock } = harness(process);
    const pending = runner.run(baseRequest());
    await flush(); clock.fireNext();
    assert.match((await pending).error!, /turn\/start timed out/);
  });
  it("times out turn completion and sends turn interrupt", async () => {
    const process = successfulProcess((message, child) => {
      if (message.method !== "turn/start") return false;
      child.reply(message.id!, { turn: { id: "turn-1" } });
      return true;
    });
    const { runner, clock } = harness(process);
    const pending = runner.run(baseRequest());
    await flush(); clock.fireNext();
    const result = await pending;
    assert.equal(result.failure, "timeout");
    assert.equal(process.messages.at(-1)!.method, "turn/interrupt");
  });
  it("fails on malformed JSON instead of silently ignoring it", async () => {
    const process = new FakeProcess((message, child) => { if (message.method === "initialize") child.stdout.write("not-json\n"); });
    const result = await harness(process).runner.run(baseRequest());
    assert.equal(result.failure, "malformed-output");
  });
  it("fails on non-object JSON", async () => {
    const process = new FakeProcess((message, child) => { if (message.method === "initialize") child.stdout.write("[]\n"); });
    assert.equal((await harness(process).runner.run(baseRequest())).failure, "malformed-output");
  });
  it("surfaces RPC code and message", async () => {
    const process = new FakeProcess((message, child) => { if (message.method === "initialize") child.rpcError(message.id!, "bad client", -32602); });
    assert.match((await harness(process).runner.run(baseRequest())).error!, /bad client \(RPC -32602\)/);
  });
  it("surfaces asynchronous process errors", async () => {
    const process = new FakeProcess((message, child) => { if (message.method === "initialize") child.emit("error", new Error("pipe broke")); });
    assert.match((await harness(process).runner.run(baseRequest())).error!, /process error: pipe broke/);
  });
  it("surfaces stderr and exit code on early exit", async () => {
    const process = new FakeProcess((message, child) => {
      if (message.method === "initialize") { child.stderr.write("fatal config"); child.emit("exit", 7, null); }
    });
    const result = await harness(process).runner.run(baseRequest());
    assert.equal(result.stderr, "fatal config");
    assert.equal(result.exitCode, 7);
    assert.equal(result.error, "fatal config");
  });
  it("surfaces an early-exit signal", async () => {
    const process = new FakeProcess((message, child) => { if (message.method === "initialize") child.emit("exit", null, "SIGTERM"); });
    const result = await harness(process).runner.run(baseRequest());
    assert.equal(result.signal, "SIGTERM");
    assert.match(result.error!, /SIGTERM/);
  });
  it("rejects a pre-aborted request without spawning", async () => {
    const controller = new AbortController(); controller.abort();
    const process = successfulProcess();
    const { runner, spawns } = harness(process);
    const result = await runner.run(baseRequest({ signal: controller.signal }));
    assert.match(result.error!, /cancelled/);
    assert.equal(result.failure, "cancelled");
    assert.equal(spawns.length, 0);
  });
  it("cancels an active turn with the official interrupt request", async () => {
    const controller = new AbortController();
    const process = successfulProcess((message, child) => {
      if (message.method !== "turn/start") return false;
      child.reply(message.id!, { turn: { id: "turn-1" } });
      setImmediate(() => controller.abort());
      return true;
    });
    const result = await harness(process).runner.run(baseRequest({ signal: controller.signal }));
    assert.match(result.error!, /cancelled/);
    assert.equal(result.failure, "cancelled");
    assert.equal(process.messages.at(-1)!.method, "turn/interrupt");
  });
  it("kills and closes the child after successful completion", async () => {
    const process = successfulProcess();
    await harness(process).runner.run(baseRequest());
    assert.equal(process.killCalls, 1);
    assert.equal(process.stdin.writableEnded, true);
  });
  it("kills the child after RPC failure", async () => {
    const process = new FakeProcess((message, child) => { if (message.method === "initialize") child.rpcError(message.id!, "no auth"); });
    await harness(process).runner.run(baseRequest());
    assert.equal(process.killCalls, 1);
  });
  it("does not let a late exit overwrite a completed result", async () => {
    const process = successfulProcess((message, child) => {
      if (message.method !== "turn/start") return false;
      child.reply(message.id!, { turn: { id: "turn-1" } });
      child.notify("item/agentMessage/delta", { delta: "stable" });
      child.notify("turn/completed", { turn: { status: "completed" } });
      child.emit("exit", 9, null);
      return true;
    });
    const result = await harness(process).runner.run(baseRequest());
    assert.equal(result.success, true);
    assert.equal(result.output, "stable");
  });
});
