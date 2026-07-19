/**
 * gitgecko review plug — command handlers.
 *
 * The /describe /review /improve /ask /resolve taxonomy (CR-§1.2 compatible,
 * P-plugin-11 command2class pattern). Each handler:
 *  1. Builds a command-specific prompt
 *  2. Runs the agent (P-plugin-3 adapter)
 *  3. Records a per-step trace (G8 — the auditability wedge)
 *
 * Grounding (002): repo context now flows through instructions.repoContext,
 * populated by the orchestrator (extractDiffQueries → retrieve → renderRepoContext).
 * The handler no longer calls retrieve directly.
 *
 * Commands are NON-exclusive (many coexist under the review owner). The
 * orchestrator dispatches by command name; aliases resolve via resolveCommand.
 */
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import type { AgentResult, CommandContribution, CommandInput, CommandResult, TraceRecord } from "@gitgecko/review";
import { buildReviewPrompt, resolveCommand } from "@gitgecko/review";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join, resolve } from "node:path";
import manifestJson from "./plug.manifest.json" with { type: "json" };

/** Resolve an existing directory before any provider process is started. */
export const resolveReviewCwd = (candidate: string = process.cwd()): string => {
  const cwd = resolve(candidate);
  let directory: boolean;
  try {
    directory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`Review working directory does not exist: ${cwd}`);
  }
  if (!directory) throw new Error(`Review working directory is not a directory: ${cwd}`);
  return cwd;
};

// --- Manifest (parsed, not cast) --------------------------------------------
const parsedManifest = parseManifest(manifestJson);
if (!parsedManifest.ok) {
  throw new Error(`review-commands manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
}
export const manifest: PlugManifest = parsedManifest.value;

// --- Per-command prompt builder ---------------------------------------------
// The task verb comes from the instructions corpus (commandTask) — the single
// source of truth for the /describe /review /improve /ask /resolve taxonomy.
// --- The command handler (one contribution serving all commands) ------------

/**
 * Run a review command. Runs the agent, records trace.
 *
 * NOTE (002e): grounding is now handled by the orchestrator (002d), which
 * calls retrieve with diff-derived queries and threads the result through
 * resolveInstructions → ctx.instructions.repoContext. The agent backend
 * renders the repoContext section in its prompt. This handler no longer
 * builds a separate groundedContext string (that was dead code — it was
 * never passed to the agent, which rebuilds its own prompt).
 */
export const runCommand = async (input: CommandInput): Promise<CommandResult> => {
  const canonical = resolveCommand(input.command);
  const trace: TraceRecord[] = [];
  const cwd = resolveReviewCwd(input.cwd);

  // Run the agent (P-plugin-3 adapter).
  const toolState = { calls: [] as { tool: string; input: unknown; result?: unknown; denied?: boolean; denyReason?: string }[] };
  const temporaryDirectory = mkdtempSync(join(osTmpdir(), "gitgecko-agent-"));
  const context = {
    payload: input.payload,
    cwd,
    permission: input.permission ?? "read-only",
    persistence: input.persistence ?? "ephemeral",
    ...(input.providerThreadId ? { providerThreadId: input.providerThreadId } : {}),
    ...(input.conversation ? { conversation: input.conversation } : {}),
    mcpServerUrl: "http://localhost:0",
    tmpdir: temporaryDirectory,
    subagentDeniedTools: [...(input.subagentDeniedTools ?? [])],
    instructions: input.instructions ?? { systemPrompt: `gitgecko /${canonical}`, rules: [] },
    toolState,
    apiToken: "",
    ...(input.onActivity ? { onActivity: input.onActivity } : {}),
  } as const;
  const prompt = buildReviewPrompt(context);
  let result: AgentResult;
  try {
    result = await input.agent.run(context);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  // Record the trace (G8 — auditability).
  trace.push({
    step: canonical,
    command: input.command,
    prompt,
    ...(result.usage && { cost: { tokensIn: result.usage.tokensIn, tokensOut: result.usage.tokensOut, usd: result.usage.costUsd } }),
    ...(toolState.calls.length > 0 && { toolCalls: toolState.calls }),
    output: result.output || result.error || "Review backend failed without an error message.",
    source: "llm",
  });

  return {
    command: input.command,
    output: result.output || result.error || "Review backend failed without an error message.",
    toolState,
    success: result.success,
    ...(result.providerThreadId ? { providerThreadId: result.providerThreadId } : {}),
    ...(result.failure ? { failure: result.failure } : {}),
    ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
    trace,
  };
};

// --- Plug setup (registers the command capability) --------------------------
export async function setup(api: {
  register: (capability: "command", contribution: CommandContribution) => void;
}): Promise<void> {
  api.register("command", {
    kind: "command-handler",
    id: "review-read-commands",
    commands: ["describe", "review", "improve", "ask", "resolve", "learn"],
    run: runCommand,
    mutates: false,
  });
  api.register("command", {
    kind: "command-handler",
    id: "review-mutation-commands",
    commands: ["fix", "fix-all"],
    run: runCommand,
    mutates: true,
  });
}
