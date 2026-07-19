/**
 * Bounded Codex App Server stdio client.
 *
 * Protocol names and fields were verified against `codex app-server generate-ts`
 * from codex-cli 0.144.1. Provenance: openai/codex/codex-rs/app-server
 * (Apache-2.0, P-plugin-codex-app-server).
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Interface as ReadlineInterface } from "node:readline";
import type { NativeAgentActivityEvent, NativeAgentPermission } from "@gitgecko/review";
import { classifyNativeCommandFailure, resolveNativeCommand } from "@gitgecko/review/native-command";

export interface CodexAppServerRequest {
  readonly cwd: string;
  readonly permission: NativeAgentPermission;
  readonly persistence: "ephemeral" | "thread";
  readonly prompt: string;
  readonly providerThreadId?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly initializeTimeoutMs?: number;
  readonly rpcTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onActivity?: (event: NativeAgentActivityEvent) => void;
}

export interface CodexAppServerResult {
  readonly success: boolean;
  readonly output?: string;
  readonly error?: string;
  readonly failure?: "not-installed" | "auth" | "permission" | "invalid-arguments" | "timeout" | "cancelled" | "provider" | "malformed-output";
  readonly providerThreadId?: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
}

export interface CodexAppServerRunner {
  readonly run: (request: CodexAppServerRequest) => Promise<CodexAppServerResult>;
}

interface RpcError { readonly code?: number; readonly message?: string; readonly data?: unknown }
interface RpcMessage {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: RpcError;
  readonly method?: string;
  readonly params?: unknown;
}

type Timer = ReturnType<typeof setTimeout>;
interface Clock {
  readonly setTimeout: (callback: () => void, delayMs: number) => Timer;
  readonly clearTimeout: (timer: Timer) => void;
}

interface AppServerProcess {
  readonly stdin: ChildProcessWithoutNullStreams["stdin"];
  readonly stdout: ChildProcessWithoutNullStreams["stdout"];
  readonly stderr: ChildProcessWithoutNullStreams["stderr"];
  readonly killed: boolean;
  readonly kill: (signal?: NodeJS.Signals | number) => boolean;
  readonly once: ChildProcessWithoutNullStreams["once"];
}

export interface CodexAppServerDependencies {
  readonly resolveCommand?: typeof resolveNativeCommand;
  readonly spawnProcess?: (executable: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => AppServerProcess;
  readonly clock?: Clock;
  readonly environment?: NodeJS.ProcessEnv;
}

interface PendingRpc {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: Timer;
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined => (
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined
);

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const codexSandboxPolicy = (permission: NativeAgentPermission, cwd: string): Readonly<Record<string, unknown>> => {
  if (permission === "unrestricted") return { type: "dangerFullAccess" };
  if (permission === "workspace-write") {
    return {
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    };
  }
  return { type: "readOnly", networkAccess: false };
};

/** Run one bounded Codex turn and always close its private app-server process. */
export const createCodexAppServerRunner = (dependencies: CodexAppServerDependencies = {}): CodexAppServerRunner => ({
  run: async (request) => {
    const clock = dependencies.clock ?? { setTimeout, clearTimeout };
    const environment = dependencies.environment ?? process.env;
    const timeoutMs = request.timeoutMs ?? Number(environment.CODEX_TIMEOUT_MS ?? 180_000);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return { success: false, failure: "invalid-arguments", error: "Codex App Server timeout must be a positive finite number." };
    }
    if (request.signal?.aborted) {
      return { success: false, failure: "cancelled", error: "Codex App Server request was cancelled." };
    }

    let resolved;
    try {
      resolved = (dependencies.resolveCommand ?? resolveNativeCommand)("codex");
    } catch (error) {
      return { success: false, failure: "not-installed", error: errorText(error) };
    }

    let child: AppServerProcess;
    try {
      child = (dependencies.spawnProcess ?? ((executable, args, options) => spawn(executable, args, {
        ...options,
        stdio: ["pipe", "pipe", "pipe"],
      })))(resolved.executable, [...resolved.argumentPrefix, "app-server"], {
        cwd: request.cwd,
        env: environment,
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      const detail = errorText(error);
      return { success: false, failure: classifyNativeCommandFailure(detail, false), error: detail };
    }

    const stderrChunks: string[] = [];
    const pending = new Map<number, PendingRpc>();
    let nextId = 1;
    let finalOutput = "";
    let threadId: string | undefined;
    let turnId: string | undefined;
    let exitCode: number | null | undefined;
    let exitSignal: NodeJS.Signals | null | undefined;
    let terminal = false;
    let terminalPending = false;
    let terminalResult: CodexAppServerResult | undefined;
    let completionResolve!: (value: CodexAppServerResult) => void;
    const completion = new Promise<CodexAppServerResult>((resolve) => { completionResolve = resolve; });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string | Buffer) => stderrChunks.push(String(chunk)));

    const diagnostics = (): Pick<CodexAppServerResult, "stderr" | "exitCode" | "signal"> => ({
      ...(stderrChunks.length > 0 ? { stderr: stderrChunks.join("") } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(exitSignal !== undefined ? { signal: exitSignal } : {}),
    });

    const rejectPending = (detail: string): void => {
      for (const waiting of pending.values()) {
        clock.clearTimeout(waiting.timer);
        waiting.reject(new Error(detail));
      }
      pending.clear();
    };

    const settle = (result: CodexAppServerResult): void => {
      if (terminal) return;
      terminal = true;
      if (!result.success) rejectPending(result.error ?? "Codex App Server failed.");
      terminalResult = { ...result, ...diagnostics() };
      completionResolve(terminalResult);
    };

    /** Let independently delivered stderr bytes drain before freezing diagnostics without relying on a test clock. */
    const settleAfterIoDrain = (result: CodexAppServerResult): void => {
      if (terminal || terminalPending) return;
      terminalPending = true;
      setImmediate(() => {
        terminalPending = false;
        settle(result);
      });
    };

    const send = (message: Readonly<Record<string, unknown>>): void => {
      if (terminal || child.stdin.destroyed || !child.stdin.writable) throw new Error("Codex App Server stdin is not writable.");
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const requestRpc = (method: string, params: Readonly<Record<string, unknown>>, requestTimeoutMs = request.rpcTimeoutMs ?? 30_000): Promise<unknown> => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = clock.setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Codex App Server ${method} timed out after ${requestTimeoutMs}ms.`));
        }, requestTimeoutMs);
        pending.set(id, { method, resolve, reject, timer });
        try {
          send({ method, id, params });
        } catch (error) {
          pending.delete(id);
          clock.clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    };

    const lines: ReadlineInterface = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        settle({ success: false, failure: "malformed-output", error: `Codex App Server emitted malformed JSON: ${line.slice(0, 200)}` });
        return;
      }
      if (!record(message)) {
        settle({ success: false, failure: "malformed-output", error: "Codex App Server emitted a non-object JSON message." });
        return;
      }
      if (typeof message.id === "number") {
        const waiting = pending.get(message.id);
        if (!waiting) return;
        pending.delete(message.id);
        clock.clearTimeout(waiting.timer);
        if (message.error) {
          const suffix = message.error.code === undefined ? "" : ` (RPC ${message.error.code})`;
          waiting.reject(new Error(`${message.error.message ?? `${waiting.method} failed`}${suffix}`));
        } else {
          waiting.resolve(message.result);
        }
        return;
      }
      if (message.method === "item/agentMessage/delta") {
        const delta = record(message.params)?.delta;
        if (typeof delta === "string") finalOutput += delta;
        return;
      }
      if (message.method === "item/completed") {
        const item = record(record(message.params)?.item);
        if (item?.type === "agentMessage" && typeof item.text === "string") finalOutput = item.text;
        return;
      }
      if (message.method === "turn/completed") {
        const turn = record(record(message.params)?.turn);
        const status = turn?.status;
        const turnError = record(turn?.error);
        if (status === "failed") {
          const detail = typeof turnError?.message === "string" ? turnError.message : "Codex turn failed.";
          settleAfterIoDrain({ success: false, error: detail, failure: classifyNativeCommandFailure(detail, false) });
        } else if (status === "interrupted") {
          settleAfterIoDrain({ success: false, error: "Codex turn was cancelled.", failure: "cancelled" });
        } else {
          settleAfterIoDrain({ success: true, output: finalOutput });
        }
      }
    });

    child.once("error", (error: Error) => {
      const detail = `Codex App Server process error: ${error.message}`;
      rejectPending(detail);
      settle({ success: false, error: detail, failure: classifyNativeCommandFailure(detail, false) });
    });
    child.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      if (terminalPending) return;
      const detail = stderrChunks.join("").trim() || `Codex App Server exited before turn completion (${code ?? signal ?? "unknown"}).`;
      rejectPending(detail);
      settle({ success: false, error: detail, failure: "provider" });
    });

    const onAbort = (): void => {
      if (threadId && turnId && !terminal) {
        try { send({ method: "turn/interrupt", id: nextId++, params: { threadId, turnId } }); } catch { /* teardown still kills */ }
      }
      rejectPending("Codex App Server request was cancelled.");
      settle({ success: false, error: "Codex App Server request was cancelled.", failure: "cancelled" });
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      request.onActivity?.({ phase: "starting", provider: "codex", message: "Starting Codex App Server", at: new Date().toISOString() });
      await requestRpc("initialize", { clientInfo: { name: "gitgecko", title: "GitGecko", version: "0.1.3" }, capabilities: null }, request.initializeTimeoutMs ?? 15_000);
      request.onActivity?.({ phase: "starting", provider: "codex", message: "Codex App Server connected", at: new Date().toISOString() });
      send({ method: "initialized" });
      const sandbox = request.permission === "unrestricted" ? "danger-full-access" : request.permission;
      const threadResponse = await requestRpc(
        request.providerThreadId ? "thread/resume" : "thread/start",
        request.providerThreadId
          ? { threadId: request.providerThreadId, cwd: request.cwd, approvalPolicy: "never", sandbox }
          : {
              cwd: request.cwd,
              approvalPolicy: "never",
              sandbox,
              ephemeral: request.persistence === "ephemeral",
              ...(request.model ? { model: request.model } : {}),
            },
      );
      const thread = record(record(threadResponse)?.thread);
      threadId = typeof thread?.id === "string" ? thread.id : request.providerThreadId;
      if (!threadId) throw new Error("Codex App Server did not return a thread id.");
      request.onActivity?.({
        phase: "starting",
        provider: "codex",
        message: request.providerThreadId ? "Codex thread resumed" : "Codex thread started",
        at: new Date().toISOString(),
        metadata: { threadId },
      });
      const turnResponse = await requestRpc("turn/start", {
        threadId,
        input: [{ type: "text", text: request.prompt, text_elements: [] }],
        cwd: request.cwd,
        approvalPolicy: "never",
        sandboxPolicy: codexSandboxPolicy(request.permission, request.cwd),
      });
      const turn = record(record(turnResponse)?.turn);
      turnId = typeof turn?.id === "string" ? turn.id : undefined;
      request.onActivity?.({
        phase: "thinking",
        provider: "codex",
        message: "Codex is reviewing the repository",
        at: new Date().toISOString(),
        ...(turnId ? { metadata: { turnId } } : {}),
      });
      let completionTimer: Timer | undefined;
      const completed = await Promise.race([
        completion,
        new Promise<CodexAppServerResult>((resolve) => {
          completionTimer = clock.setTimeout(() => resolve({
            success: false,
            error: `Codex App Server turn completion timed out after ${timeoutMs}ms.`,
            failure: "timeout",
          }), timeoutMs);
        }),
      ]);
      if (completionTimer) clock.clearTimeout(completionTimer);
      if (!completed.success && completed.failure === "timeout" && threadId && turnId) {
        try { send({ method: "turn/interrupt", id: nextId++, params: { threadId, turnId } }); } catch { /* teardown still kills */ }
      }
      return { ...completed, providerThreadId: threadId, ...diagnostics() };
    } catch (error) {
      if (terminalResult) {
        return { ...terminalResult, ...(threadId ? { providerThreadId: threadId } : {}), ...diagnostics() };
      }
      const detail = errorText(error);
      return {
        success: false,
        error: detail,
        failure: detail.includes("timed out after") ? "timeout" : classifyNativeCommandFailure(detail, false),
        ...(threadId ? { providerThreadId: threadId } : {}),
        ...diagnostics(),
      };
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
      rejectPending("Codex App Server connection closed.");
      lines.close();
      if (!child.stdin.destroyed) child.stdin.end();
      if (!child.killed) child.kill();
    }
  },
});
