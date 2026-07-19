/**
 * gitgecko review plug — agent-opencode.
 *
 * Shells out to the developer's installed `opencode` binary. Zero-config (goal
 * §1.1, A13): uses the developer's existing model login — NO API keys needed.
 * Detected on PATH via `detectNativeAgents`.
 *
 * RE NOTE (salvage-source-hierarchy rule, AGENTS.md): pullfrog's opencode_v2.ts
 * (1200 lines) was REJECTED — it's a pile of SDK-fighting workarounds for a
 * multi-turn gate-retry feature gitgecko doesn't need (custom undici dispatchers,
 * process-group teardown, SSE-connect-race fallbacks, activity watchdogs). RE
 * of the mature alternatives revealed:
 *  - pr-agent (~12k stars): in-process LiteLLM calls, no subprocess agents
 *  - open-code-review (~10k stars): in-process Go tool-use loop
 *  - opencode CLI itself: has `opencode run --format json` — a one-shot non-
 *    interactive mode (analogous to codex `exec` and claude `-p`). pullfrog
 *    used this in v1 before their gate-retry feature forced the server approach.
 *
 * This plug uses the SIMPLE one-shot pattern — same shell-out shape as codex
 * and claude-code. ~100 lines, not 1200. If a future multi-turn feature needs
 * session reuse, migrating to `opencode serve` + session.prompt is a localized
 * swap behind this interface (the pullfrog v1→v2 migration already proved it).
 *
 * The `opencode run` command emits NDJSON events on stdout; we parse the `text`
 * events (the assistant's response) and concatenate them as the review output.
 * Verified against opencode-ai 1.16.2 (2026-07-09, pullfrog pin).
 *
 * Implements the Agent adapter (P-plugin-3): name + install + run. toolState
 * mutated BY REFERENCE. The shell-out function is INJECTED for testability.
 */
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import type { Agent, AgentBackendContribution, AgentRunContext, AgentResult, AgentUsage, NativeAgentProviderPlug, NativeAgentRuntimeProfile } from "@gitgecko/review";
import {
  buildReviewPrompt,
  GIT_WRITE_DENY_OPENCODE,
  GIT_READ_DENY_OPENCODE,
} from "@gitgecko/review";
import { classifyNativeCommandFailure, executeNativeCommandResult, NativeCommandError, resolveNativeCommand } from "@gitgecko/review/native-command";
import { hashProviderSchema, writeProviderProfile } from "@gitgecko/review/native-provider-runtime";
import { unlinkSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import manifestJson from "./plug.manifest.json" with { type: "json" };

// --- Manifest (parsed, not cast) --------------------------------------------
const parsedManifest = parseManifest(manifestJson);
if (!parsedManifest.ok) {
  throw new Error(`agent-opencode manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
}
export const manifest: PlugManifest = parsedManifest.value;

/**
 * The shell-out function type. Injectable so tests fake it (no real opencode).
 * Production uses the review owner's shell-free native command runner.
 */
export interface ShellOut {
  (binary: string, args: readonly string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }): string;
}

export const createRealShellOut = (): ShellOut => {
  return (binary, args, opts) => {
    const result = executeNativeCommandResult(binary, args, {
      ...(opts.cwd !== undefined && { cwd: opts.cwd }),
      ...(opts.env !== undefined && { env: opts.env }),
      timeout: Number(process.env.OPENCODE_TIMEOUT_MS ?? 180_000),
      maxBuffer: 10 * 1024 * 1024,
    });
    if (!result.ok) throw new NativeCommandError(binary, result);
    if (!result.stdout.trim()) {
      const diagnostic = result.stderr.trim() || "OpenCode completed without a JSON result.";
      throw new NativeCommandError(binary, {
        ...result,
        ok: false,
        failure: result.stderr.trim() ? classifyNativeCommandFailure(diagnostic, false) : "malformed-output",
        error: diagnostic,
      });
    }
    return result.stdout;
  };
};

/**
 * opencode CLI invocation with a private prompt attachment.
 * The `run` subcommand is the one-shot non-interactive mode. `--format json`
 * emits NDJSON events on stdout; `--print-logs` includes tool-use events.
 * The fixed positional message keeps generated content out of process argv.
 *
 * The model is optional (`OPENCODE_MODEL` env) — opencode uses its configured
 * default if not specified.
 */
const buildOpencodeInvocation = (promptPath: string, ctx: AgentRunContext): { binary: string; args: readonly string[] } => {
  const model = process.env.OPENCODE_MODEL;
  const args = [
    "run",
    "Review the attached GitGecko instructions and return only the review.",
    "--format", "json",
    "--print-logs",
    "--dir", ctx.cwd,
    ...(ctx.providerThreadId ? ["--session", ctx.providerThreadId] : []),
    "--file", promptPath,
    ...(model ? ["--model", model] : []),
  ];
  return { binary: "opencode", args };
};

/**
 * W5 SECURITY WEDGE — build the OPENCODE_PERMISSION env value (authoritative
 * deny layer). Salvaged from pullfrog opencode.ts:1185-1195. OpenCode's
 * permission model:
 *  - `external_directory: { "*": "deny", "/tmp/*": "allow" }` — sandbox to /tmp;
 *    deny ALL native FS tools outside the project root + /tmp.
 *  - `read` / `edit` — last-match-wins Wildcard.match against worktree-relative
 *    paths. We deny .git writes (blanket) + .git/config reads (narrow).
 *
 * OPENCODE_PERMISSION has the HIGHEST precedence in opencode's config merge
 * (over managed + MDM configs) — it is the bypass-immune layer (analogous to
 * Claude's managed-settings permissions.deny). The mutatesDenyList is already
 * enforced at the orchestrator's MCP-tool layer (ctx.subagentDeniedTools); this
 * env hardens the NATIVE opencode tools (Read/Edit/Write/Bash) that bypass MCP.
 */
// Compatibility correction: OpenCode 1.3 on Windows needs its external
// runtime state for session/provider startup. Do not emit external_directory;
// read-only safety is enforced by edit and bash denial below.
const buildOpencodePermissionEnv = (permission: AgentRunContext["permission"], temporaryDirectory: string): string => {
  // OpenCode uses external runtime directories for provider/session state; deny
  // mutation through edit/bash instead of blocking that state at startup.
  void temporaryDirectory;
  return JSON.stringify({
    read: { "*": "allow", ...GIT_READ_DENY_OPENCODE },
    edit: { "*": permission === "read-only" ? "deny" : "allow", ...GIT_WRITE_DENY_OPENCODE },
  });
};

/**
 * OPENCODE_CONFIG_CONTENT — bash: "deny" so the agent cannot shell out. This is
 * the second deny layer (the first is OPENCODE_PERMISSION's external_directory).
 * Salvaged from pullfrog opencode.ts:94-95.
 */
const buildOpencodeSecurityConfig = (permission: AgentRunContext["permission"]): string => {
  return JSON.stringify({ permission: { bash: permission === "unrestricted" ? "allow" : "deny" } });
};

/**
 * Parse NDJSON output from `opencode run --format json`. Each line is a JSON
 * event envelope. We extract `text` events (the assistant's response chunks)
 * and concatenate them. Other event types (`init`, `tool_use`, `step_finish`,
 * `error`) are ignored for v1 — they're available for future trace enrichment.
 *
 * Salvaged pattern: pullfrog opencode.ts:149-308 defines the full event schema
 * (OpenCodeTextEvent, OpenCodeToolUseEvent, etc.). We only need `text` for v1.
 */
export interface ParsedOpencodeOutput {
  readonly success: boolean;
  readonly output: string;
  readonly providerThreadId?: string;
  readonly error?: string;
  readonly usage?: AgentUsage;
}

export const parseOpencodeResult = (stdout: string): ParsedOpencodeOutput => {
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  const textChunks: string[] = [];
  let providerThreadId: string | undefined;
  let error: string | undefined;
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let hasUsage = false;
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as {
        type?: string;
        content?: string;
        text?: string;
        sessionID?: string;
        part?: { text?: string };
        tokens?: { input?: number; output?: number; reasoning?: number };
        cost?: number;
        error?: { data?: { message?: string; statusCode?: number }; message?: string };
      };
      if (event.sessionID) providerThreadId = event.sessionID;
      if (event.type === "text" && event.content) {
        textChunks.push(event.content);
      } else if (event.type === "text" && event.part?.text) {
        textChunks.push(event.part.text);
      } else if (event.type === "text" && event.text) {
        textChunks.push(event.text);
      } else if (event.type === "error") {
        const message = event.error?.data?.message ?? event.error?.message ?? event.content ?? "OpenCode returned an unknown error.";
        error = event.error?.data?.statusCode
          ? `OpenCode provider returned HTTP ${event.error.data.statusCode}: ${message}`
          : message;
      }
      if (event.tokens) {
        const input = event.tokens.input;
        const output = event.tokens.output;
        const reasoning = event.tokens.reasoning;
        if (typeof input === "number" && Number.isFinite(input)) { tokensIn += input; hasUsage = true; }
        if (typeof output === "number" && Number.isFinite(output)) { tokensOut += output; hasUsage = true; }
        if (typeof reasoning === "number" && Number.isFinite(reasoning)) { tokensOut += reasoning; hasUsage = true; }
      }
      if (typeof event.cost === "number" && Number.isFinite(event.cost)) {
        costUsd += event.cost;
        hasUsage = true;
      }
    } catch {
      // Not JSON — skip (opencode may emit non-JSON log lines with --print-logs).
    }
  }
  // If no text events were parsed, fall back to the raw stdout (best-effort).
  const output = textChunks.length > 0 ? textChunks.join("") : error ? "" : stdout.trim();
  return {
    success: error === undefined,
    output,
    ...(providerThreadId ? { providerThreadId } : {}),
    ...(error ? { error } : {}),
    ...(hasUsage ? { usage: { tokensIn, tokensOut, costUsd } } : {}),
  };
};

export const parseOpencodeOutput = (stdout: string): string => {
  const parsed = parseOpencodeResult(stdout);
  return parsed.error ? `[opencode error: ${parsed.error}]` : parsed.output;
};

/**
 * Build the opencode Agent. The ShellOut function is injected (BYO at runtime;
 * tests inject a fake). Same Agent adapter shape as codex/claude-code.
 */
export const createOpencodeAgent = (shellOut: ShellOut = createRealShellOut()): Agent => ({
  name: "opencode",
  install: async (token?: string) => {
    void token;
    try {
      shellOut("opencode", ["--version"], {});
      return "opencode (already installed)";
    } catch {
      throw new Error("opencode binary not found on PATH. Install it or configure a different agent.");
    }
  },
  run: async (ctx: AgentRunContext): Promise<AgentResult> => {
    try {
      const prompt = buildReviewPrompt(ctx);
      const cwd = ctx.cwd ?? process.cwd();
      const permission = ctx.permission ?? "read-only";
      const executionContext = { ...ctx, cwd, permission };
      ctx.onActivity?.({ phase: "starting", provider: "opencode", message: "Starting OpenCode", at: new Date().toISOString() });

      const promptFile = pathJoin(ctx.tmpdir, `gitgecko-opencode-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
      writeFileSync(promptFile, prompt, { encoding: "utf8", mode: 0o600 });
      const { binary, args } = buildOpencodeInvocation(promptFile, executionContext);
      // W5: inject the authoritative OPENCODE_PERMISSION + OPENCODE_CONFIG_CONTENT
      // deny layers into the env. These harden the NATIVE opencode tools against
      // git-mutation + external-dir access (the MCP deny list covers MCP tools).
      const securedEnv: NodeJS.ProcessEnv = {
        ...process.env,
        OPENCODE_PERMISSION: buildOpencodePermissionEnv(permission, ctx.tmpdir),
        OPENCODE_CONFIG_CONTENT: buildOpencodeSecurityConfig(permission),
      };
      // Execute in the reviewed repository; temporary storage holds prompt/config artifacts only.
      let rawOutput: string;
      try {
        ctx.onActivity?.({ phase: "thinking", provider: "opencode", message: "OpenCode is reviewing the repository", at: new Date().toISOString() });
        rawOutput = shellOut(binary, args, { cwd, env: securedEnv });
      } finally {
        try { unlinkSync(promptFile); } catch { /* best-effort cleanup */ }
      }
      const parsed = parseOpencodeResult(rawOutput);
      const output = parsed.output;
      ctx.onActivity?.({ phase: "completed", provider: "opencode", message: parsed.success ? "OpenCode review completed" : "OpenCode review failed", at: new Date().toISOString() });

      // Record the tool call into toolState BY REFERENCE (P-plugin-3 invariant).
      ctx.toolState.calls.push({
        tool: "opencode.run",
        input: { prompt: prompt.slice(0, 200), cwd, permission, permissionDeny: permission !== "unrestricted", deniedToolsCount: ctx.subagentDeniedTools?.length ?? 0 },
        result: output.slice(0, 200),
      });
      ctx.onToolUse?.({ tool: "opencode.run", input: prompt });

      return {
        success: parsed.success,
        output: output || parsed.error || "",
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
    id: "opencode-agent",
    agent: createOpencodeAgent(),
    mutates: false,
  });
}

export const createNativeAgentProviderPlug = (): NativeAgentProviderPlug => ({
  id: "opencode", manifest, preference: 2,
  probe: () => {
    try {
      const command = resolveNativeCommand("opencode");
      const version = executeNativeCommandResult("opencode", ["--version"], { timeout: 10_000 });
      return { installed: version.ok, executable: command.executable, version: version.stdout.trim(), ...(!version.ok ? { failure: version.failure, diagnostic: version.error } : {}) };
    } catch (error) { return { installed: false, failure: "not-installed", diagnostic: error instanceof Error ? error.message : String(error) }; }
  },
  discoverCapabilities: async (): Promise<NativeAgentRuntimeProfile> => {
    const probe = await createNativeAgentProviderPlug().probe();
    if (!probe.installed) throw new Error(probe.diagnostic ?? "OpenCode is not installed.");
    const rawSchema = { output: "ndjson", parser: "passthrough", directory: "--dir", session: ["--session", "--continue"] };
    const profile: NativeAgentRuntimeProfile = { schemaVersion: "native-agent-runtime.v1", provider: "opencode", providerVersion: probe.version ?? "unknown", ...(probe.executable ? { executable: probe.executable } : {}), schemaHash: hashProviderSchema(rawSchema), rawSchema, capabilities: { cwd: true, permissions: ["read-only", "workspace-write", "unrestricted"], ephemeral: true, threads: true, resume: true, cancellation: false, activity: false, usage: true, schemaDiscovery: false } };
    writeProviderProfile(profile); return profile;
  },
  create: () => createOpencodeAgent(),
});
export const providerPlug = createNativeAgentProviderPlug();

export { createOpencodeAgent as createAgent };
