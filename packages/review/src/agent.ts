/**
 * @gitgecko/review/agent — the Agent adapter + run context.
 *
 * Salvaged verbatim from pullfrog's Agent interface (research manifest P-plugin-3,
 * .refs/01-pr-review/pullfrog-main/agents/shared.ts). The 2-method contract for
 * swapping agent brains (claude-code / opencode / gitgecko-native) behind one shape.
 *
 * Critical invariant (P-plugin-3): toolState is passed BY REFERENCE. The MCP
 * server (serving the agent's tools) + the post-run gate read live mutations
 * from the same object — no IPC state-sync. This is what makes the mutates gate
 * enforceable across backends.
 */
import type { OwnerSpec } from "@gitgecko/socket";
import type { Finding } from "@gitgecko/rules";
import type { ReviewCheckReport, ReviewCheckReceipt, ReviewCheckStatus } from "@gitgecko/sandbox";
import type { NativeAgentPermission, NativeThreadTurn } from "./native-threads.js";
import type { NativeAgentActivityEvent } from "./native-provider.js";
import type { ReviewMission } from "./missions.js";

/** Agent backend identifier (which brain). All 5 backends as first-class literals. */
export type AgentId = "claude-code" | "opencode" | "gitgecko-native" | "codex" | "gitgecko-local" | "pi" | string;

/** A tool the agent can call (mirrors pullfrog's PullfrogTool + mutates flag, P-plugin-7). */
export interface AgentTool {
  readonly name: string;
  readonly description: string;
  /** THE mutates flag — single source of truth for "this tool changes state" (P-plugin-7). */
  readonly mutates?: boolean;
}

/** Mutable per-run tool state — passed BY REFERENCE (P-plugin-3 invariant). */
export interface ToolState {
  calls: AgentToolCall[];
}

export interface AgentToolCall {
  readonly tool: string;
  readonly input: unknown;
  readonly result?: unknown;
  readonly denied?: boolean;
  readonly denyReason?: string;
}

/** A requirement retrieved from the review source, never supplied by untrusted review text. */
export interface LinkedReviewRequirement {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
}

/** Public review aliases preserve one canonical receipt schema in the sandbox owner. */
export type ReviewRuntimeCheckStatus = ReviewCheckStatus;
export type ReviewRuntimeCheckReceipt = ReviewCheckReceipt;
export type ReviewRuntimeCheckReport = ReviewCheckReport;

/** The PR/MR/diff payload under review. */
export interface ReviewPayload {
  readonly repo: string;
  readonly prNumber: number;
  readonly title: string;
  readonly diff: string;
  readonly files: readonly string[];
  /** Optional customer-selected focus that bounds probabilistic review findings, never deterministic findings. */
  readonly mission?: ReviewMission;
  /** Authoritative requirements from tickets linked by the review source. */
  readonly linkedIssues?: readonly LinkedReviewRequirement[];
  /** Opt-in bounded runtime evidence supplied by the execution owner. */
  readonly runtimeChecks?: ReviewRuntimeCheckReport;
}

/** Resolved instructions (persona + rules + output format + findings from the instructions/rules owners). */
export interface ResolvedInstructions {
  readonly systemPrompt: string;
  readonly rules: readonly string[];
  /** The reviewer persona (expertise + discipline + tone). Consumed by all backends. */
  readonly persona?: string;
  /** The output-format blueprint (severity sections, walkthrough, etc.). */
  readonly outputFormat?: string;
  /** Minimum quality band of the active normative corpus; 0 means no normative rules. */
  readonly qualityBand?: number;
  /** Deterministic findings (authoritative — from evaluateRules, the W4/W10 wedge). */
  readonly findings?: readonly Finding[];
  /**
   * Grounded repo context (retrieved snippets rendered as a section, 002b).
   * Consumed by all backends — the single source of grounding (I1). When absent
   * or empty, backends render no repo-context section (graceful, I3).
   */
  readonly repoContext?: string;
}

/** Everything an agent run needs — threaded through the harness (P-plugin-3). */
export type NativeAgentPersistence = "ephemeral" | "thread";
export type NativeAgentFailure = "not-installed" | "auth" | "permission" | "invalid-arguments" | "timeout" | "cancelled" | "provider" | "malformed-output" | "unsupported";

export interface NativeAgentDiagnostics {
  readonly stderr?: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
}

export interface NativeAgentUsage {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
}

/** Provider-neutral execution fields shared by every native-agent plug. */
export interface NativeAgentRequest {
  /** The repository the provider must inspect and operate within. */
  readonly cwd: string;
  /** Provider-neutral execution policy. Reviews default to read-only. */
  readonly permission: NativeAgentPermission;
  /** Ephemeral one-shot or a provider session GitGecko can resume. */
  readonly persistence: NativeAgentPersistence;
  /** Provider-owned session identity when resuming a GitGecko thread. */
  readonly providerThreadId?: string;
  /** GitGecko-owned normalized history for providers such as Pi without a provider session store. */
  readonly conversation?: readonly NativeThreadTurn[];
  /** Cancels an active provider turn without changing provider selection. */
  readonly signal?: AbortSignal;
  /** Provider-neutral activity; unknown provider events remain plug-private. */
  readonly onActivity?: (event: NativeAgentActivityEvent) => void;
}

/** Provider-neutral result; absent usage means the provider did not report it. */
export interface NativeAgentResult {
  readonly success: boolean;
  readonly output?: string;
  readonly error?: string;
  readonly failure?: NativeAgentFailure;
  readonly providerThreadId?: string;
  readonly diagnostics?: NativeAgentDiagnostics;
  readonly usage?: NativeAgentUsage;
}

/** Everything an agent run needs through the review harness. */
export interface AgentRunContext extends NativeAgentRequest {
  readonly payload: ReviewPayload;
  readonly resolvedModel?: string;
  readonly mcpServerUrl: string;
  readonly tmpdir: string;
  readonly secretDenyPaths?: readonly string[];
  /** Derived from the mutates flag (P-plugin-7) — these tools are denied to subagents. */
  readonly subagentDeniedTools: readonly string[];
  readonly instructions: ResolvedInstructions;
  /** BY REFERENCE — the gate + trace read live mutations from this object. */
  readonly toolState: ToolState;
  readonly apiToken: string;
  readonly onActivityTimeout?: () => void;
  readonly onToolUse?: (e: AgentToolUseEvent) => void;
}

export interface AgentToolUseEvent {
  readonly tool: string;
  readonly input: unknown;
  readonly denied?: boolean;
}

/** The result of one agent run. */
export interface AgentResult extends NativeAgentResult {}

/** Compatibility alias retained for existing review consumers. */
export type AgentUsage = NativeAgentUsage;

/** THE Agent adapter contract (P-plugin-3 verbatim): name + install + run. */
export interface Agent {
  readonly name: AgentId;
  readonly install: (token?: string) => Promise<string>;
  readonly run: (ctx: AgentRunContext) => Promise<AgentResult>;
}

/** A registry of agents (pullfrog's `agents = {claude, opencode} satisfies Record<string, Agent>`). */
export type AgentRegistry = Readonly<Record<string, Agent>>;

// --- Owner spec (02-architecture-overview §2: the review owner) -------------

/** The review owner's capabilities. */
export type ReviewCapability = "command" | "agent-backend";

/** Contribution: a command handler (the /describe /review /improve /ask taxonomy, CR-§1.2). */
export interface CommandContribution {
  readonly kind: "command-handler";
  readonly id: string;
  /** Which command(s) this handler serves (e.g. ["review", "review_pr"]). */
  readonly commands: readonly string[];
  readonly run: (input: CommandInput) => Promise<CommandResult>;
  readonly mutates?: boolean;
}

/** Contribution: an agent backend (the Agent adapter, P-plugin-3). */
export interface AgentBackendContribution {
  readonly kind: "agent-backend";
  readonly id: string;
  readonly agent: Agent;
  /**
   * Build a request-scoped backend when the agent depends on live entitlement
   * or provider resolution. The registry owns the capability; callers do not
   * construct the backend by importing a plug directly.
   */
  readonly create?: (config: Readonly<Record<string, unknown>>) => Agent;
  readonly mutates?: boolean;
}

export interface CommandInput {
  readonly command: string;
  readonly payload: ReviewPayload;
  readonly agent: Agent;
  readonly instructions?: ResolvedInstructions;
  readonly cwd?: string;
  readonly permission?: NativeAgentPermission;
  readonly persistence?: NativeAgentPersistence;
  readonly providerThreadId?: string;
  readonly conversation?: readonly NativeThreadTurn[];
  readonly onActivity?: (event: NativeAgentActivityEvent) => void;
  /**
   * The mutates-deny list (W5, P-plugin-7). Derived by the orchestrator from
   * the active review plug's mutates:true tools and threaded here so the
   * command-handler leaf honors it. Absent (→ []) for read-only review where
   * no plug declares mutatesTools. Finding 18.2: the leaf must NOT hardcode [].
   */
  readonly subagentDeniedTools?: readonly string[];
}

export interface CommandResult {
  readonly command: string;
  readonly output: string;
  readonly toolState: ToolState;
  readonly success: boolean;
  readonly providerThreadId?: string;
  readonly failure?: AgentResult["failure"];
  readonly diagnostics?: AgentResult["diagnostics"];
  readonly trace: readonly TraceRecord[];
}

/** Per-step trace record (G8 — the auditability wedge, 05 §7). */
export interface TraceRecord {
  readonly step: string;
  readonly command: string;
  readonly model?: string;
  readonly prompt?: string;
  readonly toolCalls?: readonly AgentToolCall[];
  readonly output?: string;
  readonly cost?: { tokensIn: number; tokensOut: number; usd: number };
  readonly source: "deterministic" | "llm";
}

export const reviewOwner: OwnerSpec<ReviewCapability, string> = {
  name: "review",
  capabilities: ["command", "agent-backend"],
  // Commands are NON-exclusive (many coexist); agent-backend is exclusive (one active brain).
  exclusive: (cap) => cap === "agent-backend",
  kindFor: (cap) => (cap === "command" ? "command-handler" : "agent-backend"),
};
