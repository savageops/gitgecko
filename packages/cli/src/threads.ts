/**
 * Provider-neutral lifecycle for threads created through GitGecko.
 *
 * The review owner executes providers; this CLI surface only coordinates the
 * normalized store and renders results. Provider-private histories stay private.
 */
import { productIdentity } from "@gitgecko/core";
import {
  appendNativeThreadTurn,
  createFileNativeThreadStore,
  createNativeThreadRecord,
  type Agent,
  type NativeAgentActivityEvent,
  type NativeAgentPermission,
  type NativeAgentProvider,
  type NativeThread,
  type NativeThreadStore,
} from "@gitgecko/review";
import { runCommand } from "@gitgecko/plug-review-commands";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type NativeThreadAction = "start" | "resume" | "list" | "read" | "delete";

export interface NativeThreadCommand {
  readonly action: NativeThreadAction;
  readonly id?: string;
  readonly provider?: NativeAgentProvider;
  readonly prompt?: string;
  readonly cwd?: string;
  readonly permission?: NativeAgentPermission;
  readonly json?: boolean;
}

export interface NativeThreadCommandResult {
  readonly success: boolean;
  readonly action: NativeThreadAction;
  readonly output: string;
  readonly thread?: NativeThread;
  readonly threads?: readonly NativeThread[];
  readonly failure?: string;
}

export interface NativeThreadDependencies {
  readonly store?: NativeThreadStore;
  readonly createAgent: (provider: NativeAgentProvider) => Agent;
  readonly now?: () => string;
  readonly createId?: () => string;
  readonly onActivity?: (event: NativeAgentActivityEvent) => void;
}

export const getNativeThreadDirectory = (): string => join(homedir(), productIdentity.authDirectory, "threads", "v1");

const requireValue = (value: string | undefined, label: string): string => {
  if (!value?.trim()) throw new Error(`threads ${label} is required.`);
  return value;
};

const runTurn = async (
  agent: Agent,
  providerThreadId: string | undefined,
  prompt: string,
  cwd: string,
  permission: NativeAgentPermission,
  conversation: NativeThread["turns"] = [],
  onActivity?: (event: NativeAgentActivityEvent) => void,
) => runCommand({
  command: "ask",
  payload: { repo: cwd, prNumber: 0, title: "GitGecko thread", diff: prompt, files: [] },
  agent,
  instructions: { systemPrompt: "Act as GitGecko's repository review agent. Follow the user's instruction in the target workspace.", rules: [] },
  cwd,
  permission,
  persistence: "thread",
  ...(providerThreadId ? { providerThreadId } : {}),
  ...(conversation.length > 0 ? { conversation } : {}),
  ...(onActivity ? { onActivity } : {}),
});

/** Execute one lifecycle action through the canonical review command owner. */
export const runNativeThreadCommand = async (
  command: NativeThreadCommand,
  dependencies: NativeThreadDependencies,
): Promise<NativeThreadCommandResult> => {
  const store = dependencies.store ?? createFileNativeThreadStore(getNativeThreadDirectory());
  const now = dependencies.now ?? (() => new Date().toISOString());

  if (command.action === "list") {
    const threads = store.list();
    return { success: true, action: "list", output: `${threads.length} GitGecko thread${threads.length === 1 ? "" : "s"}.`, threads };
  }

  if (command.action === "read") {
    const id = requireValue(command.id, "read <id>");
    const thread = store.read(id);
    if (!thread) return { success: false, action: "read", output: `GitGecko thread '${id}' was not found.`, failure: "not-found" };
    return { success: true, action: "read", output: thread.turns.map((turn) => `${turn.role}: ${turn.text}`).join("\n\n"), thread };
  }

  if (command.action === "delete") {
    const id = requireValue(command.id, "delete <id>");
    const deleted = store.delete(id);
    return {
      success: deleted,
      action: "delete",
      output: deleted
        ? `Deleted GitGecko thread '${id}'. Provider-owned CLI history was not deleted.`
        : `GitGecko thread '${id}' was not found.`,
      ...(!deleted ? { failure: "not-found" } : {}),
    };
  }

  if (command.action === "start") {
    const provider = command.provider ?? "codex";
    const prompt = requireValue(command.prompt, "start <prompt>");
    const cwd = resolve(command.cwd ?? process.cwd());
    const permission = command.permission ?? "read-only";
    const result = await runTurn(dependencies.createAgent(provider), undefined, prompt, cwd, permission, [], dependencies.onActivity);
    if (!(result.success && result.providerThreadId)) {
      return {
        success: false,
        action: "start",
        output: result.output || "Provider did not return a resumable thread id.",
        failure: result.failure ?? (result.success ? "malformed-output" : "provider"),
      };
    }
    const timestamp = now();
    const id = dependencies.createId?.() ?? `thr_${randomUUID().replaceAll("-", "")}`;
    let thread = createNativeThreadRecord({ id, provider, providerThreadId: result.providerThreadId, cwd, permission, now: timestamp });
    thread = appendNativeThreadTurn(thread, { role: "user", text: prompt, at: timestamp });
    thread = appendNativeThreadTurn(thread, { role: "assistant", text: result.output, at: timestamp });
    store.write(thread);
    return { success: true, action: "start", output: result.output, thread };
  }

  const id = requireValue(command.id, "resume <id>");
  const prompt = requireValue(command.prompt, "resume <id> <prompt>");
  const existing = store.read(id);
  if (!existing) return { success: false, action: "resume", output: `GitGecko thread '${id}' was not found.`, failure: "not-found" };
  const permission = command.permission ?? existing.permission;
  const result = await runTurn(dependencies.createAgent(existing.provider), existing.providerThreadId, prompt, existing.cwd, permission, existing.turns, dependencies.onActivity);
  const timestamp = now();
  let thread = appendNativeThreadTurn(existing, { role: "user", text: prompt, at: timestamp });
  thread = appendNativeThreadTurn(thread, { role: "assistant", text: result.output, at: timestamp });
  thread = { ...thread, permission, status: result.success ? "active" : "failed" };
  store.write(thread);
  return {
    success: result.success,
    action: "resume",
    output: result.output,
    thread,
    ...(result.failure ? { failure: result.failure } : {}),
  };
};

/** Render human output without leaking provider diagnostics into stdout. */
export const renderNativeThreadCommand = (result: NativeThreadCommandResult): string => {
  if (result.action === "list") {
    if (!result.threads?.length) return "No GitGecko threads.";
    return result.threads.map((thread) => `${thread.id}\t${thread.provider}\t${thread.permission}\t${thread.cwd}\t${thread.updatedAt}`).join("\n");
  }
  if (result.action === "start" && result.thread) return `${result.output}\n\nThread: ${result.thread.id}`;
  return result.output;
};
