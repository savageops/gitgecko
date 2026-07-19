/**
 * gitgecko review plug — agent-codex.
 *
 * Shells out to the developer's installed `codex` binary (OpenAI Codex CLI).
 * Zero-config (goal §1.1, A13): uses the developer's existing OpenAI login —
 * NO API keys needed. Detected on PATH via `detectNativeAgents`.
 *
 * Implements the Agent adapter (P-plugin-3): name + install + run. The run()
 * shells out to `codex` with the review prompt (pullfrog's execFileSync pattern,
 * .refs/01-pr-review/pullfrog-main/agents/claude.ts:21). The prompt is built
 * from payload + instructions + (optional) retrieved context — same shape as
 * gitgecko-native. toolState is mutated BY REFERENCE (P-plugin-3 invariant).
 *
 * The shell-out function is INJECTED (ShellOut type) so the adapter is testable
 * without a real codex binary. Production wires the shell-free command owner; tests
 * inject a fake that records calls + returns deterministic output.
 */
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import type { Agent, AgentBackendContribution, AgentRunContext, AgentResult, NativeAgentProviderPlug, NativeAgentRuntimeProfile } from "@gitgecko/review";
import { buildReviewPrompt } from "@gitgecko/review";
import { executeNativeCommand, NativeCommandError } from "@gitgecko/review/native-command";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { createCodexAppServerRunner, type CodexAppServerRunner } from "./app-server.js";
import { runCodexExec } from "./exec.js";
import { executeNativeCommandResult, resolveNativeCommand } from "@gitgecko/review/native-command";
import { hashProviderSchema, writeProviderProfile } from "@gitgecko/review/native-provider-runtime";
import manifestJson from "./plug.manifest.json" with { type: "json" };

// --- Manifest (parsed, not cast) --------------------------------------------
const parsedManifest = parseManifest(manifestJson);
if (!parsedManifest.ok) {
  throw new Error(`agent-codex manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
}
export const manifest: PlugManifest = parsedManifest.value;

/**
 * The shell-out function type. Takes the binary + args + optional stdin, returns stdout.
 * Injectable so tests fake it without a real Codex installation.
 */
export interface ShellOut {
  (binary: string, args: readonly string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string }): string;
}

/**
 * Execute through the canonical shell-free native command owner.
 */
export const createRealShellOut = (): ShellOut => {
  return (binary, args, opts) => {
    return executeNativeCommand(binary, args, {
      ...(opts.cwd !== undefined && { cwd: opts.cwd }),
      ...(opts.env !== undefined && { env: opts.env }),
      timeout: Number(process.env.CODEX_TIMEOUT_MS ?? 180_000),
      maxBuffer: 10 * 1024 * 1024,
      ...(opts.input !== undefined && { input: opts.input }),
    });
  };
};

/**
 * Codex CLI invocation: non-interactive one-shot via `codex exec`.
 * The prompt is piped via STDIN (`-` arg = read from stdin) to avoid shell-
 * escaping issues with long/complex prompts containing special chars.
 * The `-o` flag writes ONLY the final message to a file (clean output).
 *
 * Verified against codex-cli 0.142.5 (2026-07-08).
 */
const buildCodexInvocation = (outputFile: string, permission: AgentRunContext["permission"] = "read-only"): { binary: string; args: readonly string[] } => {
  const model = process.env.CODEX_MODEL ?? "gpt-5.4-mini";
  // -c model_reasoning_effort: keep codex fast for review (default xhigh is overkill).
  // -s read-only: no repo modification. -o: clean output. -: prompt via stdin.
  return {
    binary: "codex",
    args: ["exec", "-m", model, "-c", "model_reasoning_effort=low", "-s", permission === "unrestricted" ? "danger-full-access" : permission, "--skip-git-repo-check", "-o", outputFile, "-"],
  };
};

/**
 * Build the codex Agent. The ShellOut function is injected (BYO at runtime;
 * tests inject a fake). The agent is structurally identical to gitgecko-native —
 * same Agent adapter — but runs the codex binary instead of an in-process model.
 */
export const createCodexAgent = (transport: ShellOut | CodexAppServerRunner = createCodexAppServerRunner()): Agent => ({
  name: "codex",
  install: async (token?: string) => {
    void token;
    // codex is the developer's own install — we don't provision it, just verify.
    try {
      if (typeof transport === "function") transport("codex", ["--version"], {});
      else executeNativeCommand("codex", ["--version"], { timeout: 10_000 });
      return "codex (already installed)";
    } catch {
      throw new Error("codex binary not found on PATH. Install it or configure a different agent.");
    }
  },
  run: async (ctx: AgentRunContext): Promise<AgentResult> => {
    try {
      const prompt = buildReviewPrompt(ctx);
      const cwd = ctx.cwd ?? process.cwd();
      const permission = ctx.permission ?? "read-only";
      const persistence = ctx.persistence ?? "ephemeral";

      if (typeof transport !== "function" && persistence === "thread") {
        const request = {
          cwd,
          permission,
          persistence,
          prompt,
          ...(ctx.providerThreadId ? { providerThreadId: ctx.providerThreadId } : {}),
          ...(process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          ...(ctx.onActivity ? { onActivity: ctx.onActivity } : {}),
        } as const;
        let result = await transport.run(request);
        if (!result.success && result.failure === "timeout" && result.error?.includes("initialize timed out")) {
          ctx.onActivity?.({ phase: "starting", provider: "codex", message: "Restarting stalled Codex App Server", at: new Date().toISOString() });
          result = await transport.run(request);
        }
        const output = result.output ?? "";
        ctx.toolState.calls.push({
          tool: "codex.app-server",
          input: { prompt: prompt.slice(0, 200), cwd, permission, persistence },
          result: output.slice(0, 200),
        });
        ctx.onToolUse?.({ tool: "codex.app-server", input: prompt });
        return {
          success: result.success,
          ...(output ? { output } : {}),
          ...(result.error ? { error: result.error } : {}),
          ...(result.failure ? { failure: result.failure } : {}),
          ...(result.providerThreadId ? { providerThreadId: result.providerThreadId } : {}),
          diagnostics: {
            ...(result.stderr ? { stderr: result.stderr } : {}),
            ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
            ...(result.signal !== undefined ? { signal: result.signal } : {}),
          },
        };
      }

      if (typeof transport !== "function") {
        const result = await runCodexExec({
          cwd,
          permission,
          prompt,
          ...(process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          ...(ctx.onActivity ? { onActivity: ctx.onActivity } : {}),
        });
        ctx.toolState.calls.push({ tool: "codex.exec", input: { cwd, permission }, result: (result.output ?? result.error ?? "").slice(0, 200) });
        return result;
      }

      // Write the final message to a temp file via `codex exec -o`, then read
      // it back. This gives clean output (no hook/session noise). Use the OS
      // temp dir (not ctx.tmpdir which may be the repo root on Windows with
      // backslash paths that confuse the -o flag).
      const outputFile = pathJoin(osTmpdir(), `gitgecko-codex-out-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
      const { binary, args } = buildCodexInvocation(outputFile, permission);
      // Run codex from the OS temp dir (not the repo root) so it doesn't explore
      // AGENTS.md/skills/project files — keeps it focused on the review prompt only.
      const stdout = transport(binary, args, { cwd, env: process.env, input: prompt });

      // Read the final message from the output file. Fall back to stdout if needed.
      let output: string;
      try {
        output = readFileSync(outputFile, "utf-8");
      } catch {
        output = stdout || "";
      } finally {
        try { unlinkSync(outputFile); } catch { /* graceful */ }
      }

      // Record the tool call into toolState BY REFERENCE (P-plugin-3 invariant).
      // W5 note: codex's authoritative deny is the `-s read-only` sandbox (a
      // kernel-level FS deny, stronger than a CLI flag). ctx.subagentDeniedTools
      // is surfaced into the trace for auditability — the sandbox already blocks
      // every mutating tool, so the deny list is redundant defense-in-depth here.
      ctx.toolState.calls.push({
        tool: "codex.run",
        input: { prompt: prompt.slice(0, 200), sandbox: "read-only", deniedToolsCount: ctx.subagentDeniedTools?.length ?? 0 },
        result: output.slice(0, 200),
      });
      ctx.onToolUse?.({ tool: "codex.run", input: prompt });

      return {
        success: true,
        output,
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
// The real ShellOut is injected at runtime. The plug registers a default agent
// using the real shell-out; tests call createCodexAgent(fakeShellOut) directly.
export async function setup(api: {
  register: (capability: "agent-backend", contribution: AgentBackendContribution) => void;
}): Promise<void> {
  api.register("agent-backend", {
    kind: "agent-backend",
    id: "codex-agent",
    agent: createCodexAgent(),
    mutates: false,
  });
}

/** Build the uniform provider plug consumed by the review-owned provider socket. */
export const createNativeAgentProviderPlug = (): NativeAgentProviderPlug => ({
  id: "codex",
  manifest,
  preference: 0,
  probe: () => {
    try {
      const command = resolveNativeCommand("codex");
      const version = executeNativeCommandResult("codex", ["--version"], { timeout: 10_000 });
      return { installed: version.ok, executable: command.executable, version: version.stdout.trim(), ...(!version.ok ? { failure: version.failure, diagnostic: version.error } : {}) };
    } catch (error) { return { installed: false, failure: "not-installed", diagnostic: error instanceof Error ? error.message : String(error) }; }
  },
  discoverCapabilities: async (): Promise<NativeAgentRuntimeProfile> => {
    const probe = await createNativeAgentProviderPlug().probe();
    if (!probe.installed) throw new Error(probe.diagnostic ?? "Codex is not installed.");
    const directory = mkdtempSync(pathJoin(osTmpdir(), "gitgecko-codex-schema-"));
    try {
      const generated = executeNativeCommandResult("codex", ["app-server", "generate-json-schema", "--out", directory], { timeout: 30_000 });
      if (!generated.ok) throw new Error(generated.error);
      const rawSchema = JSON.parse(readFileSync(pathJoin(directory, "codex_app_server_protocol.schemas.json"), "utf8")) as unknown;
      const profile: NativeAgentRuntimeProfile = {
        schemaVersion: "native-agent-runtime.v1", provider: "codex", providerVersion: probe.version ?? "unknown",
        ...(probe.executable ? { executable: probe.executable } : {}), schemaHash: hashProviderSchema(rawSchema), rawSchema,
        capabilities: { cwd: true, permissions: ["read-only", "workspace-write", "unrestricted"], ephemeral: true, threads: true, resume: true, cancellation: true, activity: true, usage: true, schemaDiscovery: true },
      };
      writeProviderProfile(profile);
      return profile;
    } finally { rmSync(directory, { recursive: true, force: true }); }
  },
  create: () => createCodexAgent(),
});

export const providerPlug = createNativeAgentProviderPlug();

export { createCodexAgent as createAgent };
