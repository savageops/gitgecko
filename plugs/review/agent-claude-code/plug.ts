/**
 * gitgecko review plug — agent-claude-code.
 *
 * Shells out to the developer's installed `claude` binary (Anthropic Claude Code
 * CLI). Zero-config (goal §1.1, A13): uses the developer's existing Anthropic
 * login — NO API keys needed. Detected on PATH via `detectNativeAgents`
 * (claude is the HIGHEST preference binary).
 *
 * Implements the Agent adapter (P-plugin-3): name + install + run. The run()
 * shells out to `claude -p "<prompt>"` (print mode = non-interactive one-shot).
 * The invocation shape is salvaged from pullfrog's agents/claude.ts (P-plugin-13):
 *   - `-p` flag for the prompt (NOT stdin like codex)
 *   - `--output-format text` for clean review output (pullfrog uses stream-json
 *     for event parsing; we use text for a plain review report)
 *   - `--disallowedTools` denies Bash/Monitor/REPL/Workflow + Write/Edit for
 *     read-only safety (pullfrog's CLAUDE_EXEC_TOOLS deny list, lines 103-108).
 *     We do NOT use --dangerously-skip-permissions (pullfrog's bypass mode);
 *     without it, claude-code follows normal permission rules — the safe default.
 *
 * The shell-out function is INJECTED (ShellOut type) so the adapter is testable
 * without a real claude binary. toolState is mutated BY REFERENCE (P-plugin-3).
 *
 * Verified against claude-code CLI 2.1.x (2026-07-08, P-plugin-13 salvage).
 */
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import type { Agent, AgentBackendContribution, AgentRunContext, AgentResult, AgentUsage, NativeAgentProviderPlug, NativeAgentRuntimeProfile } from "@gitgecko/review";
import { buildReviewPrompt, formatClaudeManagedSettingsDeny } from "@gitgecko/review";
import { classifyNativeCommandFailure, executeNativeCommandResult, NativeCommandError, resolveNativeCommand } from "@gitgecko/review/native-command";
import { hashProviderSchema, writeProviderProfile } from "@gitgecko/review/native-provider-runtime";
import { unlinkSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import manifestJson from "./plug.manifest.json" with { type: "json" };

// --- Manifest (parsed, not cast) --------------------------------------------
const parsedManifest = parseManifest(manifestJson);
if (!parsedManifest.ok) {
  throw new Error(`agent-claude-code manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
}
export const manifest: PlugManifest = parsedManifest.value;

/**
 * The shell-out function type. Takes the binary + args, returns stdout.
 * Injectable so tests fake it (no real claude needed). Production uses execFileSync.
 */
export interface ShellOut {
  (binary: string, args: readonly string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string }): string;
}

/**
 * The real shell-out uses the review owner's shell-free native command runner.
 */
export const createRealShellOut = (): ShellOut => {
  return (binary, args, opts) => {
    const result = executeNativeCommandResult(binary, args, {
      ...(opts.cwd !== undefined && { cwd: opts.cwd }),
      ...(opts.env !== undefined && { env: opts.env }),
      timeout: Number(process.env.CLAUDE_TIMEOUT_MS ?? 180_000),
      maxBuffer: 10 * 1024 * 1024,
      ...(opts.input && { input: opts.input }),
    });
    // Claude emits structured JSON for authentication and policy failures while
    // returning a non-zero exit code; preserve it for normalized failures.
    if (!result.ok && result.stdout.trim()) return result.stdout;
    if (!result.ok) throw new NativeCommandError(binary, result);
    return result.stdout;
  };
};

/**
 * Tools denied to claude-code for a read-only review (P-plugin-13, pullfrog
 * claude.ts:103-108). Denies state-changing tools + their Agent(...) subagent
 * variants. We do NOT use --dangerously-skip-permissions, so claude-code's
 * normal permission rules apply for anything not explicitly denied.
 */
const CLAUDE_DISALLOWED_TOOLS = [
  "Bash", "Monitor", "REPL", "Workflow",
  "Write", "Edit",
  "Agent(Bash)", "Agent(Monitor)", "Agent(REPL)", "Agent(Workflow)",
  "Agent(Write)", "Agent(Edit)",
].join(",");

const CLAUDE_EXECUTION_DENIES = ["Bash", "Monitor", "REPL", "Workflow", "Agent(Bash)", "Agent(Monitor)", "Agent(REPL)", "Agent(Workflow)"].join(",");

/**
 * Claude CLI invocation: `claude -p --output-format text --disallowedTools ... --settings <managed>`.
 * The `-p` flag triggers print mode (non-interactive one-shot). The prompt is
 * piped via STDIN (NOT as a command-line argument), which avoids the Windows
 * 8191-char command-line limit on long review prompts. Claude reads from stdin
 * when it's piped. This mirrors how the codex plug delivers its prompt (`-` arg).
 *
 * W5 SECURITY WEDGE (battle-lesson, security-hook.ts): `--disallowedTools` alone
 * leaks under `--dangerously-skip-permissions`. The managed-settings JSON passed
 * via `--settings` is the BYPASS-IMMUNE authoritative deny layer. We write it to
 * a tmp file per run and pass `--settings <path>`. The managed-settings carries:
 *  - the mutatesDenyList (from ctx.subagentDeniedTools, derived by the Registry)
 *  - the always-on GIT_WRITE_DENY_CLAUDE + GIT_READ_DENY_CLAUDE surfaces
 * Together: `--disallowedTools` is the fast path, `--settings` is the backstop.
 */
const buildClaudeInvocation = (
  _prompt: string,
  settingsPath: string | null,
  permission: AgentRunContext["permission"] = "read-only",
  providerThreadId?: string,
): { binary: string; args: readonly string[] } => {
  const model = process.env.CLAUDE_MODEL;
  const args = [
    "-p",
    "--output-format", "json",
    "--permission-mode", permission === "unrestricted" ? "bypassPermissions" : permission === "workspace-write" ? "acceptEdits" : "default",
    "--disallowedTools", permission === "read-only" ? CLAUDE_DISALLOWED_TOOLS : CLAUDE_EXECUTION_DENIES,
    ...(settingsPath ? ["--settings", settingsPath] : []),
    ...(providerThreadId ? ["--resume", providerThreadId] : []),
    ...(permission === "unrestricted" ? ["--dangerously-skip-permissions"] : []),
    ...(model ? ["--model", model] : []),
  ];
  return { binary: "claude", args };
};

export interface ParsedClaudeOutput {
  readonly success: boolean;
  readonly output: string;
  readonly providerThreadId?: string;
  readonly error?: string;
  readonly usage?: AgentUsage;
}

/** Normalize Claude Code's print-mode JSON while retaining plain-text test compatibility. */
export const parseClaudeOutput = (stdout: string): ParsedClaudeOutput => {
  try {
    const envelope = JSON.parse(stdout) as Readonly<Record<string, unknown>>;
    const output = typeof envelope.result === "string" ? envelope.result : "";
    const providerThreadId = typeof envelope.session_id === "string" ? envelope.session_id : undefined;
    const isError = envelope.is_error === true;
    const rawUsage = typeof envelope.usage === "object" && envelope.usage !== null
      ? envelope.usage as Readonly<Record<string, unknown>>
      : undefined;
    const tokensIn = rawUsage?.input_tokens;
    const tokensOut = rawUsage?.output_tokens;
    const costUsd = envelope.total_cost_usd;
    const usage = typeof tokensIn === "number" && Number.isFinite(tokensIn)
      && typeof tokensOut === "number" && Number.isFinite(tokensOut)
      ? {
          tokensIn,
          tokensOut,
          costUsd: typeof costUsd === "number" && Number.isFinite(costUsd) ? costUsd : 0,
        }
      : undefined;
    return {
      success: !isError,
      output,
      ...(providerThreadId ? { providerThreadId } : {}),
      ...(isError ? { error: output || "Claude Code returned an error result." } : {}),
      ...(usage ? { usage } : {}),
    };
  } catch {
    return { success: true, output: stdout };
  }
};

/**
 * Build the claude-code Agent. The ShellOut function is injected (BYO at runtime;
 * tests inject a fake). The agent is structurally identical to codex/gitgecko-native —
 * same Agent adapter — but runs the claude binary in print mode.
 */
export const createClaudeCodeAgent = (shellOut: ShellOut = createRealShellOut()): Agent => ({
  name: "claude-code",
  install: async (token?: string) => {
    void token;
    // claude is the developer's own install — we don't provision it, just verify.
    try {
      shellOut("claude", ["--version"], {});
      return "claude-code (already installed)";
    } catch {
      throw new Error("claude binary not found on PATH. Install it or configure a different agent.");
    }
  },
  run: async (ctx: AgentRunContext): Promise<AgentResult> => {
    try {
      const prompt = buildReviewPrompt(ctx);
      const cwd = ctx.cwd ?? process.cwd();
      const permission = ctx.permission ?? "read-only";
      ctx.onActivity?.({ phase: "starting", provider: "claude", message: "Starting Claude Code", at: new Date().toISOString() });

      // W5 managed-settings layer: write the bypass-immune deny JSON to a tmp
      // file when there are mutates-derived denies. The always-on git-deny
      // surfaces ship even with an empty deny list (free hardening).
      const settingsPath = pathJoin(ctx.tmpdir, `claude-managed-settings-${Date.now()}.json`);
      const managed = formatClaudeManagedSettingsDeny(ctx.subagentDeniedTools ?? []);
      try {
        writeFileSync(settingsPath, JSON.stringify(managed), { mode: 0o600 });
      } catch (error) {
        throw new Error(`Claude managed deny settings could not be created: ${error instanceof Error ? error.message : String(error)}`);
      }

      const { binary, args } = buildClaudeInvocation(prompt, settingsPath, permission, ctx.providerThreadId);
      // Run claude from the OS temp dir so it doesn't explore project files.
      // The prompt flows via STDIN (not command-line args) to avoid the Windows
      // 8191-char command-line limit on long review prompts.
      let output: string;
      try {
        ctx.onActivity?.({ phase: "thinking", provider: "claude", message: "Claude is reviewing the repository", at: new Date().toISOString() });
        output = shellOut(binary, args, { cwd, env: process.env, input: prompt });
      } finally {
        try { unlinkSync(settingsPath); } catch { /* best-effort cleanup after enforced creation */ }
      }

      // Record the tool call into toolState BY REFERENCE (P-plugin-3 invariant).
      const parsed = parseClaudeOutput(output);
      ctx.onActivity?.({ phase: "completed", provider: "claude", message: parsed.success ? "Claude review completed" : "Claude review failed", at: new Date().toISOString() });
      ctx.toolState.calls.push({
        tool: "claude-code.run",
        input: { prompt: prompt.slice(0, 200), cwd, permission, managedSettingsDeniedTools: ctx.subagentDeniedTools?.length ?? 0 },
        result: parsed.output.slice(0, 200),
      });
      ctx.onToolUse?.({ tool: "claude-code.run", input: prompt });

      return {
        success: parsed.success,
        output: parsed.output,
        ...(parsed.error ? { error: parsed.error, failure: classifyNativeCommandFailure(parsed.error, false) } : {}),
        ...(parsed.providerThreadId ? { providerThreadId: parsed.providerThreadId } : {}),
        ...(parsed.usage ? { usage: parsed.usage } : {}),
      };
    } catch (e) {
      if (e instanceof NativeCommandError) {
        return {
          success: false,
          error: e.message,
          ...(e.result.failure ? { failure: e.result.failure } : {}),
          diagnostics: { stderr: e.result.stderr, exitCode: e.result.exitCode, signal: e.result.signal },
        };
      }
      return { success: false, error: e instanceof Error ? e.message : String(e), failure: "provider" };
    }
  },
});

// --- Plug setup (registers the agent-backend capability) --------------------
export async function setup(api: {
  register: (capability: "agent-backend", contribution: AgentBackendContribution) => void;
}): Promise<void> {
  api.register("agent-backend", {
    kind: "agent-backend",
    id: "claude-code-agent",
    agent: createClaudeCodeAgent(),
    mutates: false,
  });
}

export const createNativeAgentProviderPlug = (): NativeAgentProviderPlug => ({
  id: "claude", manifest, preference: 1,
  probe: () => {
    try {
      const command = resolveNativeCommand("claude");
      const version = executeNativeCommandResult("claude", ["--version"], { timeout: 10_000 });
      return { installed: version.ok, executable: command.executable, version: version.stdout.trim(), ...(!version.ok ? { failure: version.failure, diagnostic: version.error } : {}) };
    } catch (error) { return { installed: false, failure: "not-installed", diagnostic: error instanceof Error ? error.message : String(error) }; }
  },
  discoverCapabilities: async (): Promise<NativeAgentRuntimeProfile> => {
    const probe = await createNativeAgentProviderPlug().probe();
    if (!probe.installed) throw new Error(probe.diagnostic ?? "Claude is not installed.");
    const rawSchema = { output: "json", parser: "passthrough", session: ["session_id", "--resume"] };
    const profile: NativeAgentRuntimeProfile = { schemaVersion: "native-agent-runtime.v1", provider: "claude", providerVersion: probe.version ?? "unknown", ...(probe.executable ? { executable: probe.executable } : {}), schemaHash: hashProviderSchema(rawSchema), rawSchema, capabilities: { cwd: true, permissions: ["read-only", "workspace-write", "unrestricted"], ephemeral: true, threads: true, resume: true, cancellation: false, activity: false, usage: true, schemaDiscovery: false } };
    writeProviderProfile(profile); return profile;
  },
  create: () => createClaudeCodeAgent(),
});
export const providerPlug = createNativeAgentProviderPlug();

export { createClaudeCodeAgent as createAgent };
