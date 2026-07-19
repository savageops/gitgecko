/**
 * @gitgecko/cli/orchestrator — the end-to-end review flow.
 *
 * Ties all 7 owners into one callable flow (the §1.1 zero-config UX):
 *  1. Parse CLI args (command + diff/files/pathway)
 *  2. Detect native agents on PATH (claude/codex/opencode)
 *  3. Resolve the pathway (auto/native/local/native-loop/deterministic)
 *  4. Construct the right Agent (native shell-out / gitgecko-local / gitgecko-native)
 *  5. Run the review command (grounded in repo context via retrieve)
 *  6. Return the result (output + trace)
 *
 * Zero-config: `runReview()` with no pathway uses a detected native agent and
 * its existing login, or produces an offline deterministic review when no
 * inference backend exists. No API keys are required for either path (A13).
 *
 * All external dependencies (PATH probe, agent factory, retrieve fn) are injected
 * so the orchestrator is fully testable in-process — no real binary, no real LLM.
 */
import { createMutationReceipt, createReviewArtifactV2, resolveReviewMission, type Agent, type MutationReceipt, type NativeAgentActivityEvent, type NativeAgentPermission, type NativeAgentProvider, type ReviewMissionId, type ReviewPayload, type ResolvedInstructions, type WorkspaceSnapshot } from "@gitgecko/review";
import type { ReviewCheckReport } from "@gitgecko/sandbox";
import { resolvePathway, type PathwaySpec, type LocalEndpointConfig } from "@gitgecko/review";
import type { CommandResult } from "@gitgecko/review";
import type { Finding } from "@gitgecko/rules";
import { extractDiffQueries, renderRepoContext } from "@gitgecko/instructions";
import { runCommand } from "@gitgecko/plug-review-commands";
import { enforcePlan, type PlanId, type UsageState } from "@gitgecko/plans";
import { productIdentity } from "@gitgecko/core/product-identity";

/** Parsed CLI args — what the user asked for. */
export interface CliArgs {
  readonly command: "review" | "describe" | "improve" | "ask" | "fix" | "fix-all" | "help" | "version" | "doctor" | "login" | "logout" | "whoami" | "models" | "history" | "threads";
  readonly diff?: string;
  readonly diffFile?: string;
  readonly files?: readonly string[];
  readonly repo?: string;
  /** Connected cloud project whose GitHub installation owns pull-request acquisition. */
  readonly projectId?: string;
  readonly pullNumber?: number;
  readonly title?: string;
  /** Exact customer-selected bounded review mission. */
  readonly mission?: ReviewMissionId;
  /** Requirements fetched by an authenticated review source, never parsed from CLI input. */
  readonly linkedIssues?: ReviewPayload["linkedIssues"];
  /** Receipts from explicitly requested customer-configured runtime checks. */
  readonly runtimeChecks?: ReviewPayload["runtimeChecks"];
  /** Opt-in switch; check definitions are configuration-owned, never argv shell text. */
  readonly runChecks?: boolean;
  /** Explicit customer authorization for the local workspace-writing fix lane. */
  readonly apply?: boolean;
  /** The specific finding or requested correction approved for a local fix. */
  readonly fixInstruction?: string;
  /** A review.v2 artifact file supplying the approved finding set for fix-all. */
  readonly findingsFile?: string;
  readonly pathway?: PathwaySpec;
  /** Force the authenticated cloud review owner instead of auto pathway selection. */
  readonly cloud?: boolean;
  /** A caller-owned run identity used to join accepted, running, and terminal state. */
  readonly runId?: string;
  /** For /ask: the question. */
  readonly question?: string;
  /** Output the full result as JSON to stdout (for machine consumption). */
  readonly json?: boolean;
  /** Suppress stderr noise — output only the review text (for agent workflows). */
  readonly agent?: boolean;
  readonly cwd?: string;
  readonly permission?: NativeAgentPermission;
  readonly threadAction?: "start" | "resume" | "list" | "read" | "delete";
  readonly threadId?: string;
  readonly threadProvider?: NativeAgentProvider;
  readonly threadPrompt?: string;
  readonly modelsAction?: "list" | "show" | "configure" | "clear";
  readonly modelProvider?: {
    readonly baseUrl?: string;
    readonly model?: string;
    readonly protocol?: "openai-chat-completions" | "openai-responses" | "anthropic-messages";
    readonly apiKeyEnv?: string;
  };
}

/** The orchestrator's injectable dependencies (for testing). */
export interface OrchestratorDeps {
  /** PATH probe for native-agent detection (default: real probe). */
  readonly probeNatives?: () => readonly string[];
  /** Agent factory — constructs the right Agent for a resolved pathway. */
  readonly createAgent: (resolution: { family: string; binary?: string; localConfig?: LocalEndpointConfig }) => Agent;
  /** Retrieve function for grounding (default: none — ungrounded review). */
  readonly retrieve?: (query: string) => Promise<readonly { content: string; filepath: string }[]>;
  /** Deterministic findings produced by the caller's canonical configured-rules owner. */
  readonly findings?: readonly Finding[];
  /** Whether auto mode can execute inference after local/native detection. */
  readonly inferenceAvailable?: boolean;
  /** Configured Pi endpoint; participates in the same provider-selection order as native CLIs. */
  readonly piConfig?: LocalEndpointConfig;
  /** Human-facing progress sink. Machine callers omit it to keep output pure. */
  readonly onActivity?: (event: NativeAgentActivityEvent) => void;
  /** Provider-neutral trusted workspace observer for mutation commands. */
  readonly captureWorkspace?: (cwd: string) => Promise<WorkspaceSnapshot>;
  /** Existing sandbox-owned checks, deliberately invoked only after mutation. */
  readonly verifyMutation?: (cwd: string) => Promise<ReviewCheckReport>;
  /**
   * Resolve the full instructions (persona + rules + outputFormat + findings +
   * repoContext) for a review. When undefined, falls back to a bare stub
   * (backwards-compat). Production wires this to @gitgecko/instructions
   * resolveInstructions (001c). repoContext (4th arg) is the rendered grounding
   * string from retrieve (002d); undefined when no grounding is available.
   */
  readonly resolveInstructions?: (args: CliArgs, payload: ReviewPayload, findings?: readonly Finding[], repoContext?: string) => ResolvedInstructions;
  /**
   * The mutates-deny list (P-plugin-7, W5 security wedge). Derived from the
   * active review plug's ActivePlug.mutatesDenyList — tool names that mutate
   * state and must be denied to the agent's subagents. When undefined or empty,
   * no tools are denied (the agent runs with full tool access). The orchestrator
   * server resolves this from the Registry; tests inject it directly.
   */
  readonly mutatesDenyList?: readonly string[];
  /**
   * The plan-enforcement gate (UX-SYNTHESIS §1 — the billing/plans socket).
   * When provided, the orchestrator calls it BEFORE the agent runs: native +
   * local pathways pass `action: "native-review"` (always allowed — the zero-cost
   * wedge), native-loop passes `action: "cloud-review"` (metered against the
   * plan's credit cap). When undefined, no gate runs (local/dev/unauthed — the
   * CLI never gates by default; the gate is a cloud-deployment concern).
   */
  readonly planGate?: {
    readonly planId: PlanId;
    readonly usage: UsageState;
  };
}

/** The orchestrator result — the review output + how the pathway was resolved. */
export interface OrchestratorResult {
  readonly success: boolean;
  readonly output: string;
  readonly artifact: ReturnType<typeof createReviewArtifactV2>;
  readonly pathwayResolution: { family: string; binary?: string; reason: string };
  readonly command: string;
  readonly trace?: CommandResult["trace"];
  readonly failure?: CommandResult["failure"];
  readonly diagnostics?: CommandResult["diagnostics"];
  readonly mutation?: MutationReceipt;
}

/**
 * Parse raw CLI args (process.argv slice) into a CliArgs.
 * Salvage pattern: pullfrog's arg spec (P-frontend-5, cli.ts).
 */
export const parseArgs = (argv: readonly string[]): CliArgs => {
  const args = [...argv];
  // Resolve informational aliases before command parsing so help can never
  // acquire a diff, detect providers, or start a billable review turn.
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { command: "help" };
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) return { command: "version" };
  if (args.length === 2 && (args[1] === "--help" || args[1] === "-h")) return { command: "help" };
  const command = args[0] ?? "help";

  switch (command) {
    case "review":
    case "describe":
    case "improve":
    case "ask":
    case "fix":
    case "fix-all": {
      const result: { diff?: string; diffFile?: string; files?: string[]; question?: string; fixInstruction?: string; findingsFile?: string; repo?: string; projectId?: string; pullNumber?: number; title?: string; mission?: ReviewMissionId; pathway?: PathwaySpec; cloud?: boolean; json?: boolean; agent?: boolean; cwd?: string; permission?: NativeAgentPermission; runChecks?: boolean; apply?: boolean } = {};
      for (let i = 1; i < args.length; i++) {
        const a = args[i]!;
        if (a === "--diff" && args[i + 1]) { result.diff = args[++i]!; continue; }
        if (a === "--diff-file" && args[i + 1]) { result.diffFile = args[++i]!; continue; }
        if (a === "--file" && args[i + 1]) { (result.files ??= []).push(args[++i]!); continue; }
        if (a === "--repo" && args[i + 1]) { result.repo = args[++i]!; continue; }
        if (a === "--project" && args[i + 1]) { result.projectId = args[++i]!.trim(); continue; }
        if (a === "--pull" && args[i + 1]) {
          const pullNumber = Number(args[++i]);
          if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) throw new Error("--pull must be a positive integer.");
          result.pullNumber = pullNumber;
          continue;
        }
        if (a === "--title" && args[i + 1]) { result.title = args[++i]!; continue; }
        if (a === "--mission" && args[i + 1]) {
          const mission = resolveReviewMission(args[++i]!);
          if (!mission || command !== "review") throw new Error("--mission is available only for review and must be correctness, security, reliability, performance, or testability.");
          result.mission = mission.id;
          continue;
        }
        if (a === "--cwd" && args[i + 1]) { result.cwd = args[++i]!; continue; }
        if (a === "--permission" && args[i + 1]) {
          const permission = args[++i]!;
          if (!(permission === "read-only" || permission === "workspace-write" || permission === "unrestricted")) {
            throw new Error("--permission must be read-only, workspace-write, or unrestricted.");
          }
          result.permission = permission;
          continue;
        }
        if (a === "--pathway" && args[i + 1]) {
          const p = args[++i]!;
          if (p === "auto") result.pathway = { kind: "auto" };
          else if (p === "native") result.pathway = { kind: "native" };
          else if (p === "pi" || p === "local") result.pathway = { kind: "local", config: { modelId: "local", baseUrl: "http://localhost:1234/v1", protocol: "openai-chat-completions" } };
          else if (p === "native-loop") result.pathway = { kind: "native-loop" };
          else if (p === "deterministic") result.pathway = { kind: "deterministic" };
          else if (p === "cloud") result.cloud = true;
          else if (p.startsWith("native:")) result.pathway = { kind: "native", binary: p.slice(7) };
          else result.pathway = { kind: "native", binary: p };
          continue;
        }
        if (a === "--json") { result.json = true; continue; }
        if (a === "--agent") { result.agent = true; continue; }
        if (a === "--run-checks") { result.runChecks = true; continue; }
        if (a === "--apply") { result.apply = true; continue; }
        if (a === "--findings-file" && args[i + 1]) { result.findingsFile = args[++i]!; continue; }
        if (command === "fix" && a === "--instruction" && args[i + 1]) { result.fixInstruction = args[++i]!; continue; }
        if (command === "ask" && !result.question) { result.question = a; continue; }
        if (command === "fix" && !result.fixInstruction) { result.fixInstruction = a; continue; }
      }
      if (isWorkspaceFixCommand(command)) {
        if (!result.apply) throw new Error(`${command} requires --apply because it can change the reviewed workspace.`);
        if (result.permission && result.permission !== "workspace-write") {
          throw new Error(`${command} requires workspace-write permission; unrestricted execution is not needed.`);
        }
        if (command === "fix-all" && !result.findingsFile) throw new Error("fix-all requires --findings-file <review.json>.");
        result.permission = "workspace-write";
      }
      const connectedPull = result.projectId !== undefined || result.pullNumber !== undefined;
      if (connectedPull && command !== "review") throw new Error("--project and --pull are available only for review.");
      if (connectedPull && (!result.projectId || result.pullNumber === undefined)) throw new Error("connected pull-request review requires both --project and --pull.");
      if (connectedPull && result.cloud !== true) throw new Error("--project and --pull require --pathway cloud.");
      return {
        command,
        ...(result.diff !== undefined && { diff: result.diff }),
        ...(result.diffFile !== undefined && { diffFile: result.diffFile }),
        ...(result.files !== undefined && { files: result.files }),
        ...(result.repo !== undefined && { repo: result.repo }),
        ...(result.projectId !== undefined && { projectId: result.projectId }),
        ...(result.pullNumber !== undefined && { pullNumber: result.pullNumber }),
        ...(result.title !== undefined && { title: result.title }),
        ...(result.mission !== undefined && { mission: result.mission }),
        ...(result.cloud !== undefined && { cloud: result.cloud }),
        ...(result.question !== undefined && { question: result.question }),
        ...(result.pathway !== undefined && { pathway: result.pathway }),
        ...(result.json !== undefined && { json: result.json }),
        ...(result.agent !== undefined && { agent: result.agent }),
        ...(result.cwd !== undefined && { cwd: result.cwd }),
        ...(result.permission !== undefined && { permission: result.permission }),
        ...(result.runChecks !== undefined && { runChecks: result.runChecks }),
        ...(result.apply !== undefined && { apply: result.apply }),
        ...(result.fixInstruction !== undefined && { fixInstruction: result.fixInstruction }),
        ...(result.findingsFile !== undefined && { findingsFile: result.findingsFile }),
      };
    }
    case "help":
    case "version":
    case "doctor":
    case "login":
    case "logout":
    case "whoami":
      return { command };
    case "auth":
      return { command: "login" };
    case "models": {
      const action = args[1] === "configure" || args[1] === "show" || args[1] === "clear" ? args[1] : "list";
      if (action !== "configure") return { command, modelsAction: action };
      const provider: {
        baseUrl?: string;
        model?: string;
        protocol?: "openai-chat-completions" | "openai-responses" | "anthropic-messages";
        apiKeyEnv?: string;
      } = {};
      for (let i = 2; i < args.length; i++) {
        const value = args[i + 1];
        if (args[i] === "--base-url" && value) { provider.baseUrl = value; i++; continue; }
        if (args[i] === "--model" && value) { provider.model = value; i++; continue; }
        if (args[i] === "--api-key-env" && value) { provider.apiKeyEnv = value; i++; continue; }
        if (args[i] === "--protocol") {
          if (!(value === "openai-chat-completions" || value === "openai-responses" || value === "anthropic-messages")) {
            throw new Error("--protocol must be openai-chat-completions, openai-responses, or anthropic-messages.");
          }
          provider.protocol = value; i++;
        }
      }
      return { command, modelsAction: action, modelProvider: provider };
    }
    case "history":
      return { command, ...(args.includes("--json") ? { json: true } : {}) };
    case "threads": {
      const action = args[1];
      if (!(action === "start" || action === "resume" || action === "list" || action === "read" || action === "delete")) {
        throw new Error("threads requires start, resume, list, read, or delete.");
      }
      let provider: NativeAgentProvider | undefined;
      let cwd: string | undefined;
      let permission: NativeAgentPermission | undefined;
      let json = false;
      const positionals: string[] = [];
      for (let i = 2; i < args.length; i++) {
        const value = args[i]!;
        if (value === "--provider" && args[i + 1]) {
          const candidate = args[++i]!;
          if (!(candidate === "codex" || candidate === "claude" || candidate === "opencode" || candidate === "pi")) throw new Error("--provider must be codex, claude, opencode, or pi.");
          provider = candidate;
          continue;
        }
        if (value === "--cwd" && args[i + 1]) { cwd = args[++i]!; continue; }
        if (value === "--permission" && args[i + 1]) {
          const candidate = args[++i]!;
          if (!(candidate === "read-only" || candidate === "workspace-write" || candidate === "unrestricted")) throw new Error("--permission must be read-only, workspace-write, or unrestricted.");
          permission = candidate;
          continue;
        }
        if (value === "--json") { json = true; continue; }
        positionals.push(value);
      }
      return {
        command: "threads",
        threadAction: action,
        ...(action === "resume" || action === "read" || action === "delete" ? { threadId: positionals[0] } : {}),
        ...(action === "start" ? { threadPrompt: positionals.join(" ") } : {}),
        ...(action === "resume" ? { threadPrompt: positionals.slice(1).join(" ") } : {}),
        ...(provider ? { threadProvider: provider } : {}),
        ...(cwd ? { cwd } : {}),
        ...(permission ? { permission } : {}),
        ...(json ? { json: true } : {}),
      };
    }
    default:
      throw new Error(`Unknown command '${command}'. Run '${productIdentity.cliCommand} help' for usage.`);
  }
};

/**
 * The end-to-end orchestrator: detect pathway → construct agent → run review.
 *
 * This is the function `gitgecko review` calls. Zero-config when no pathway
 * is specified: auto-detects the developer's installed agent (A13).
 */
export const runReview = async (
  args: CliArgs,
  deps: OrchestratorDeps,
): Promise<OrchestratorResult> => {
  if (isWorkspaceFixCommand(args.command) && (!args.apply || (args.permission !== undefined && args.permission !== "workspace-write"))) {
    const output = `[${productIdentity.shortName}] /${args.command} requires explicit --apply approval and workspace-write permission. No provider was started.`;
    const artifact = createReviewArtifactV2({
      runId: args.runId ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      title: args.title ?? "Fix",
      output,
      success: false,
      ...(args.diff !== undefined && { diff: args.diff }),
      ...(args.files && { files: args.files }),
      pathway: { family: "local" },
    });
    return {
      success: false,
      output,
      artifact,
      pathwayResolution: { family: "local", reason: "fix-requires-explicit-approval" },
      command: args.command,
      failure: "permission",
      trace: [{ step: "capability-gate", command: args.command, output, source: "deterministic" }],
    };
  }
  // 1. Detect native agents (zero-config)
  const availableNatives = deps.probeNatives ? deps.probeNatives() : [];

  // 2. Resolve the pathway
  const pathwaySpec: PathwaySpec = args.pathway ?? { kind: "auto" };
  const resolution = resolvePathway(pathwaySpec, availableNatives, deps.piConfig, deps.inferenceAvailable ?? true);

  // 2b. Plan-enforcement gate (UX-SYNTHESIS §1). When deps.planGate is provided
  // (cloud deployment), enforce the plan BEFORE constructing/running the agent.
  // The metering boundary follows the COST boundary:
  //  - native: the user's installed agent — GitGecko pays nothing → "native-review" (always allowed).
  //  - local: the user's own endpoint (LM Studio/Ollama) — GitGecko pays nothing → "native-review".
  //  - native-loop: BYOK cloud or GitGecko-hosted model — GitGecko pays for inference → "cloud-review" (metered).
  // When undefined (local/dev/unauthed CLI), no gate — the gate is a cloud-deployment concern.
  if (deps.planGate) {
    const action = resolution.family === "native-loop" ? "cloud-review" : "native-review";
    const decision = enforcePlan(deps.planGate.planId, { action }, deps.planGate.usage);
    if (!decision.allowed) {
      const blockedOutput = `[${productIdentity.shortName}] Plan limit reached.\n\n${decision.reason ?? "Action not permitted on your plan."}\n\nLocal agent reviews remain unlimited (zero-cost). Run \`${productIdentity.cliCommand} review\` to use an installed agent.`;
      const artifact = createReviewArtifactV2({
        runId: args.runId ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        title: args.title ?? "Review",
        output: blockedOutput,
        success: false,
        ...(args.files && { files: args.files }),
        ...(args.linkedIssues && args.linkedIssues.length > 0 ? { linkedIssues: args.linkedIssues } : {}),
        ...(args.runtimeChecks ? { runtimeChecks: args.runtimeChecks } : {}),
        pathway: { family: resolution.family, ...(resolution.binary && { binary: resolution.binary }) },
      });
      return {
        success: false,
        output: blockedOutput,
        artifact,
        pathwayResolution: { family: resolution.family, ...(resolution.binary && { binary: resolution.binary }), reason: "plan-blocked" },
        command: args.command,
      };
    }
  }

  if (resolution.family === "deterministic") {
    const findings = deps.findings ?? [];
    if (args.command !== "review") {
      const output = `[${productIdentity.shortName}] /${args.command} requires a configured model or installed agent. Deterministic mode supports review only.`;
      const artifact = createReviewArtifactV2({
        runId: args.runId ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        title: args.title ?? args.command,
        output,
        success: false,
        ...(args.diff !== undefined && { diff: args.diff }),
        ...(args.files && { files: args.files }),
        ...(args.linkedIssues && args.linkedIssues.length > 0 ? { linkedIssues: args.linkedIssues } : {}),
        ...(args.runtimeChecks ? { runtimeChecks: args.runtimeChecks } : {}),
        pathway: { family: resolution.family },
      });
      return {
        success: false,
        output,
        artifact,
        pathwayResolution: { family: resolution.family, reason: "semantic-command-requires-inference" },
        command: args.command,
        failure: "provider",
        trace: [{ step: "capability-gate", command: args.command, output, source: "deterministic" }],
      };
    }
    const output = renderDeterministicReview(findings);
    const artifact = createReviewArtifactV2({
      runId: args.runId ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      title: args.title ?? "Review",
      output,
      success: true,
      ...(args.diff !== undefined && { diff: args.diff }),
      ...(args.files && { files: args.files }),
      deterministicFindings: findings,
      ...(args.linkedIssues && args.linkedIssues.length > 0 ? { linkedIssues: args.linkedIssues } : {}),
      ...(args.runtimeChecks ? { runtimeChecks: args.runtimeChecks } : {}),
      pathway: { family: resolution.family },
    });
    return {
      success: true,
      output,
      artifact,
      pathwayResolution: { family: resolution.family, reason: resolution.reason },
      command: args.command,
      trace: [{ step: "deterministic", command: args.command, output, source: "deterministic" }],
    };
  }

  // 3. Construct the agent
  const agent = deps.createAgent({
    family: resolution.family,
    ...(resolution.binary && { binary: resolution.binary }),
    ...(resolution.localConfig && { localConfig: resolution.localConfig }),
  });

  // 4. Build the review payload
  const payload: ReviewPayload = {
    repo: args.repo ?? "local",
    prNumber: args.pullNumber ?? 0,
    title: args.title ?? "Review",
    diff: args.diff ?? "",
    files: args.files ?? [],
    ...(args.mission ? { mission: resolveReviewMission(args.mission)! } : {}),
    ...(args.linkedIssues && args.linkedIssues.length > 0 ? { linkedIssues: args.linkedIssues } : {}),
    ...(args.runtimeChecks ? { runtimeChecks: args.runtimeChecks } : {}),
  };

  // 5. Run the review command (grounded via retrieve)
  // 5a. Grounding (002d): if retrieve is configured AND a diff is present,
  // extract diff-derived queries, call retrieve per query, render the results
  // into a repoContext string. Graceful: undefined retrieve, empty results,
  // or retrieval failure → no repoContext, review proceeds ungrounded (I3).
  let repoContext: string | undefined;
  if (deps.retrieve && args.diff && args.diff.trim().length > 0) {
    try {
      const queries = extractDiffQueries(args.diff);
      if (queries.length > 0) {
        const allResults: { content: string; filepath: string }[] = [];
        const seenFiles = new Set<string>();
        for (const query of queries) {
          const results = await deps.retrieve(query);
          for (const r of results) {
            if (!seenFiles.has(r.filepath)) {
              seenFiles.add(r.filepath);
              allResults.push(r);
            }
          }
        }
        if (allResults.length > 0) {
          repoContext = renderRepoContext(allResults);
        }
      }
    } catch {
      // Retrieve failure does not abort the review — the review proceeds
      // ungrounded (I3). Grounding is an enhancement, not a gate.
    }
  }

  // 5b. Resolve instructions: persona + rules + outputFormat + findings + repoContext.
  // When deps.resolveInstructions is undefined (bare/test callers), fall back
  // to the minimal stub so the pipeline still runs. Production wires the real
  // resolver from @gitgecko/instructions (001c). repoContext is threaded as
  // the 4th arg (002b/002d); the stub path also attaches it when available
  // (exactOptionalPropertyTypes — only include when non-empty).
  let instructions: ResolvedInstructions;
  if (deps.resolveInstructions) {
    instructions = deps.resolveInstructions(args, payload, deps.findings, repoContext);
  } else {
    const stub: ResolvedInstructions = { systemPrompt: `gitgecko /${args.command}`, rules: [] };
    instructions = repoContext && repoContext.length > 0 ? { ...stub, repoContext } : stub;
  }
  if (isWorkspaceFixCommand(args.command) && args.fixInstruction) {
    instructions = {
      ...instructions,
      systemPrompt: `${instructions.systemPrompt}\n\nApproved fix request:\n${args.fixInstruction}`,
    };
  }

  // Delegate agent execution to runCommand — the canonical command-dispatch
  // layer (plugs/review/commands/plug.ts). This closes the parallel-systems
  // finding: production dispatch now routes through the commands plug, not an
  // inline agent.run(). runCommand builds the command-specific prompt via
  // commandTask, runs the agent, and records the trace (G8).
  const mutationCwd = args.cwd ?? process.cwd();
  const beforeMutation = isWorkspaceFixCommand(args.command) && deps.captureWorkspace
    ? await deps.captureWorkspace(mutationCwd)
    : undefined;
  const cmdResult: CommandResult = await runCommand({
    command: args.command,
    payload,
    agent,
    instructions,
    ...(args.cwd ? { cwd: args.cwd } : {}),
    ...(isWorkspaceFixCommand(args.command) ? { permission: "workspace-write" as const } : args.permission ? { permission: args.permission } : {}),
    ...(deps.mutatesDenyList && deps.mutatesDenyList.length > 0 && { subagentDeniedTools: deps.mutatesDenyList }),
    ...(deps.onActivity ? { onActivity: deps.onActivity } : {}),
  });

  let mutation: MutationReceipt | undefined;
  if (isWorkspaceFixCommand(args.command)) {
    if (!beforeMutation || !deps.captureWorkspace) {
      mutation = { schemaVersion: "mutation.v1", status: "no-change", changedFiles: [] };
    } else {
      const afterMutation = await deps.captureWorkspace(mutationCwd);
      const provisional = createMutationReceipt(beforeMutation, afterMutation);
      const verification = provisional.changedFiles.length > 0 && deps.verifyMutation
        ? await deps.verifyMutation(mutationCwd)
        : undefined;
      mutation = createMutationReceipt(beforeMutation, afterMutation, verification);
    }
  }
  const mutationSucceeded = mutation === undefined
    || mutation.status === "applied-unverified"
    || mutation.status === "applied-verified";
  const commandSucceeded = cmdResult.success && mutationSucceeded;
  const publicOutput = mutation !== undefined && !cmdResult.success
    ? mutation.changedFiles.length > 0
      ? `[${productIdentity.shortName}] Provider failed after modifying the workspace. Changes remain ${mutation.status === "applied-verified" ? "verified" : "unverified"}; inspect them before retrying.\n\n${cmdResult.output}`
      : `[${productIdentity.shortName}] Fix failed; no workspace change was observed.\n\n${cmdResult.output}`
    : mutation === undefined
    ? cmdResult.output || "(no output)"
    : mutation.status === "no-change"
      ? `[${productIdentity.shortName}] Fix not applied: the provider completed, but no workspace change was observed.\n\n${cmdResult.output}`
      : mutation.status === "verification-failed"
        ? `[${productIdentity.shortName}] Fix applied, but required post-mutation verification failed.\n\n${cmdResult.output}`
        : mutation.status === "applied-unverified"
          ? `[${productIdentity.shortName}] Fix applied; no post-mutation checks were requested.\n\n${cmdResult.output}`
          : `[${productIdentity.shortName}] Fix applied and post-mutation checks passed.\n\n${cmdResult.output}`;

  const artifact = createReviewArtifactV2({
    runId: args.runId ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: args.title ?? "Review",
    output: publicOutput,
    success: commandSucceeded,
    ...(args.diff !== undefined && { diff: args.diff }),
    ...(args.files && { files: args.files }),
    ...(args.command === "review" && deps.findings && { deterministicFindings: deps.findings }),
    ...(args.linkedIssues && args.linkedIssues.length > 0 ? { linkedIssues: args.linkedIssues } : {}),
    ...(args.runtimeChecks ? { runtimeChecks: args.runtimeChecks } : {}),
    ...(mutation ? { mutation } : {}),
    pathway: { family: resolution.family, ...(resolution.binary && { binary: resolution.binary }) },
  });

  return {
    success: commandSucceeded,
    output: publicOutput,
    artifact,
    pathwayResolution: {
      family: resolution.family,
      ...(resolution.binary && { binary: resolution.binary }),
      reason: resolution.reason,
    },
    command: args.command,
    trace: cmdResult.trace,
    ...(cmdResult.failure ? { failure: cmdResult.failure } : {}),
    ...(cmdResult.diagnostics ? { diagnostics: cmdResult.diagnostics } : {}),
    ...(mutation ? { mutation } : {}),
  };
};

/** Keep every workspace-writing command behind the same consent and policy boundary. */
const isWorkspaceFixCommand = (command: string): command is "fix" | "fix-all" =>
  command === "fix" || command === "fix-all";

/** Render the offline rule lane without inventing an LLM-shaped response. */
export function renderDeterministicReview(findings: readonly Finding[]): string {
  if (findings.length === 0) return `[${productIdentity.shortName}] Deterministic review\n\nNo deterministic findings.`;
  const lines = findings.map((finding) =>
    `${finding.severity.toUpperCase()} ${finding.filepath}:${finding.line}:${finding.column + 1} [${finding.ruleId}] ${finding.message}`,
  );
  return `[${productIdentity.shortName}] Deterministic review\n\n${findings.length} finding${findings.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
}
