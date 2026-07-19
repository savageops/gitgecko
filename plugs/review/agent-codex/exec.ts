/** Asynchronous Codex exec JSONL transport for one-shot reviews. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { classifyNativeCommandFailure, resolveNativeCommand } from "@gitgecko/review/native-command";
import type { NativeAgentActivityEvent, NativeAgentPermission, NativeAgentResult } from "@gitgecko/review";

export interface CodexExecRequest {
  readonly cwd: string;
  readonly permission: NativeAgentPermission;
  readonly prompt: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onActivity?: (event: NativeAgentActivityEvent) => void;
}

const emit = (request: CodexExecRequest, phase: NativeAgentActivityEvent["phase"], message?: string, tool?: string): void => {
  request.onActivity?.({ provider: "codex", phase, ...(message ? { message } : {}), ...(tool ? { tool } : {}), at: new Date().toISOString() });
};

/** Run the installed Codex binary without owning or inspecting its authentication. */
export const runCodexExec = async (request: CodexExecRequest): Promise<NativeAgentResult> => {
  if (request.signal?.aborted) return { success: false, failure: "cancelled", error: "Codex review was cancelled." };
  const timeoutMs = request.timeoutMs ?? Number(process.env.CODEX_TIMEOUT_MS ?? 180_000);
  const resolved = resolveNativeCommand("codex");
  const sandbox = request.permission === "unrestricted" ? "danger-full-access" : request.permission;
  const args = [...resolved.argumentPrefix, "exec", "--json", "-s", sandbox, "--skip-git-repo-check", ...(request.model ? ["-m", request.model] : []), "-"];
  emit(request, "starting", "Starting Codex");
  return await new Promise<NativeAgentResult>((resolve) => {
    const child = spawn(resolved.executable, args, { cwd: request.cwd, env: process.env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stderr: string[] = [];
    let output = "";
    let providerThreadId: string | undefined;
    let settled = false;
    const finish = (result: NativeAgentResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      lines.close();
      if (!child.stdin.destroyed) child.stdin.end();
      if (!child.killed) child.kill();
      resolve({ ...result, ...(providerThreadId ? { providerThreadId } : {}), diagnostics: { stderr: stderr.join(""), exitCode: child.exitCode, signal: child.signalCode } });
    };
    const timer = setTimeout(() => finish({ success: false, failure: "timeout", error: `Codex review timed out after ${timeoutMs}ms.` }), timeoutMs);
    const abort = (): void => finish({ success: false, failure: "cancelled", error: "Codex review was cancelled." });
    request.signal?.addEventListener("abort", abort, { once: true });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string | Buffer) => stderr.push(String(chunk)));
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let event: Readonly<Record<string, unknown>>;
      try { event = JSON.parse(line) as Readonly<Record<string, unknown>>; }
      catch { return; } // Additive/non-JSON provider output is diagnostic, never public JSON.
      const type = typeof event.type === "string" ? event.type : "";
      if (type === "thread.started" && typeof event.thread_id === "string") providerThreadId = event.thread_id;
      if (type === "turn.started") emit(request, "thinking", "Codex is reviewing");
      if (type === "item.started") {
        const item = event.item as Readonly<Record<string, unknown>> | undefined;
        emit(request, "tool", undefined, typeof item?.type === "string" ? item.type : "tool");
      }
      if (type === "item.completed") {
        const item = event.item as Readonly<Record<string, unknown>> | undefined;
        if ((item?.type === "agent_message" || item?.type === "agentMessage") && typeof item.text === "string") output = item.text;
      }
      if (type === "turn.completed") {
        emit(request, "completed", "Codex review completed");
        finish({ success: true, output });
      }
      if (type === "turn.failed" || type === "error") {
        const detail = typeof event.message === "string" ? event.message : "Codex review failed.";
        finish({ success: false, failure: classifyNativeCommandFailure(detail, false), error: detail });
      }
    });
    child.once("error", (error) => finish({ success: false, failure: classifyNativeCommandFailure(error.message, false), error: error.message }));
    child.once("exit", (code, signal) => {
      if (settled) return;
      const detail = stderr.join("").trim() || `Codex exited before completing the review (${code ?? signal ?? "unknown"}).`;
      finish({ success: false, failure: classifyNativeCommandFailure(detail, false), error: detail });
    });
    child.stdin.end(request.prompt);
  });
};

