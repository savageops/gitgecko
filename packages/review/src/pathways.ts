/**
 * @gitgecko/review/pathways — the agent pathway selector + gitgecko-local config.
 *
 * Three pathways (goal §1.1, A13 + A14), all fitting the same Agent adapter
 * (P-plugin-3):
 *  - native: shell out to claude/codex/opencode (zero-config, device login)
 *  - local: HTTP to an OpenAI-compatible endpoint (LM Studio/Ollama/vLLM)
 *  - native-loop: the built-in gitgecko-native loop (BYOK cloud keys today)
 *
 * The selector resolves which pathway + config to use, with an `auto` mode
 * (native → local → native-loop when configured → deterministic) and explicit modes. This is the UX control
 * that lets the user pick the brain.
 */
import type { LocalProviderOptions } from "@gitgecko/model-client";

/** The executable review pathway families. */
export type PathwayFamily = "native" | "pi" | "local" | "native-loop" | "deterministic";

/** Config for the gitgecko-local pathway (LM Studio/Ollama/vLLM/llama.cpp). */
export interface LocalEndpointConfig extends Omit<LocalProviderOptions, "model"> {
  readonly modelId: string;
}

/** A user's pathway selection — what they asked for. */
export type PathwaySpec =
  | { readonly kind: "auto" }
  | { readonly kind: "native"; readonly binary?: string } // native:claude, native:codex, native:opencode, or native (auto-detect)
  | { readonly kind: "local"; readonly config: LocalEndpointConfig }
  | { readonly kind: "native-loop" }
  | { readonly kind: "deterministic" };

/** The resolved pathway — what gitgecko will actually use. */
export interface PathwayResolution {
  readonly family: PathwayFamily;
  /** For native: which binary (claude/codex/opencode). For local: the config. */
  readonly binary?: string;
  readonly localConfig?: LocalEndpointConfig;
  /** Why this was chosen (for the trace / debug UX). */
  readonly reason: string;
}

/**
 * Resolve a PathwaySpec to a PathwayResolution, given native-agent availability.
 *
 * Resolution rules:
 *  - auto: prefer native (codex > claude > opencode), then local (if config
 *    provided), then native-loop when inference is executable, otherwise the
 *    deterministic rule lane. The default always produces an honest result.
 *  - native: use the specified binary, or auto-detect among native agents.
 *  - local: use the provided LocalEndpointConfig (gitgecko-local).
 *  - native-loop: always use the built-in loop.
 */
import { NATIVE_AGENT_PREFERENCE } from "./native-agents.js";
import { createGitGeckoLocalAgent } from "./gitgecko-local.js";

/** Sort available natives by preference order (codex > claude > opencode). */
const sortByPreference = (available: readonly string[]): readonly string[] => {
  const rank = new Map<string, number>();
  NATIVE_AGENT_PREFERENCE.forEach((b, i) => rank.set(b, i));
  return [...available]
    .filter((b) => rank.has(b))
    .sort((a, b) => (rank.get(a) ?? 99) - (rank.get(b) ?? 99));
};

export const resolvePathway = (
  spec: PathwaySpec,
  availableNatives: readonly string[],
  localConfig?: LocalEndpointConfig,
  inferenceAvailable = true,
): PathwayResolution => {
  // Sort by preference order so input order doesn't matter (codex > claude > opencode).
  const natives = sortByPreference(availableNatives);
  switch (spec.kind) {
    case "auto": {
      if (natives.length > 0 && natives[0]) {
        return { family: "native", binary: natives[0], reason: `auto: native ${natives[0]} available` };
      }
      if (localConfig) {
        return { family: "pi", localConfig, reason: "auto: no native CLI provider, Pi endpoint configured" };
      }
      if (!inferenceAvailable) {
        return { family: "deterministic", reason: "auto: no native agent, local endpoint, or inference provider" };
      }
      return { family: "native-loop", reason: "auto: no native agent, no local config → built-in loop" };
    }
    case "native": {
      if (spec.binary) {
        return { family: "native", binary: spec.binary, reason: `explicit: native:${spec.binary}` };
      }
      if (natives.length > 0 && natives[0]) {
        return { family: "native", binary: natives[0], reason: `native (auto-detected ${natives[0]})` };
      }
      return { family: "native", reason: "native requested but no native binary is installed" };
    }
    case "local": {
      return { family: "pi", localConfig: spec.config, reason: "explicit: Pi model endpoint (local compatibility alias)" };
    }
    case "native-loop": {
      return { family: "native-loop", reason: "explicit: built-in loop" };
    }
    case "deterministic": {
      return { family: "deterministic", reason: "explicit: deterministic rules only" };
    }
  }
};

// --- AgentRegistry factory (Phase 4.3 — the populated instance) --------------

import type { Agent, AgentRegistry } from "./agent.js";
import { binaryToAgentId } from "./native-agents.js";

/**
 * Build a populated AgentRegistry from a set of available agents + a resolved
 * pathway. This is the factory that turns the abstract AgentRegistry type
 * (Readonly<Record<string, Agent>>) into a concrete instance keyed by AgentId.
 *
 * The registry always includes the fallback ("native-loop" → the built-in
 * gitgecko-native agent), plus whichever native/local agents the pathway resolved to.
 * This is what the orchestrator consults to get the Agent for a run.
 *
 * Status: production entrypoints use the canonical `createAgentForResolution`
 * pathway with owner-injected factories. This helper remains a library-level
 * registry builder for consumers that already have an agent pool; it is not a
 * second production dispatch path.
 *
 * @param agents - the pool of constructable agents (keyed by AgentId).
 * @param resolution - the resolved pathway (decides which agents are relevant).
 * @returns a populated AgentRegistry with at least the fallback agent.
 */
export const buildAgentRegistry = (
  agents: Readonly<Record<string, Agent>>,
  resolution: PathwayResolution,
): AgentRegistry => {
  const registry: Record<string, Agent> = {};
  // Always include the native-loop fallback if it's in the pool.
  if (agents["gitgecko-native"]) registry["gitgecko-native"] = agents["gitgecko-native"];
  // Wire the resolved pathway's agent into the registry under its AgentId.
  if (resolution.family === "native" && resolution.binary) {
    const agentId = binaryToAgentId(resolution.binary);
    const agent = agents[agentId];
    if (agent) registry[agentId] = agent;
  }
  if ((resolution.family === "pi" || resolution.family === "local") && agents["gitgecko-local"]) {
    registry["gitgecko-local"] = agents["gitgecko-local"];
  }
  return registry;
};

/**
 * Resolve the active agent from a registry + pathway resolution.
 * This is the "build" step of detect → resolve → build → run.
 */
export const resolveAgent = (
  registry: AgentRegistry,
  resolution: PathwayResolution,
): Agent | null => {
  switch (resolution.family) {
    case "native": {
      const agentId = resolution.binary ? binaryToAgentId(resolution.binary) : null;
      return agentId ? (registry[agentId] ?? null) : null;
    }
    case "pi":
    case "local":
      return registry["gitgecko-local"] ?? null;
    case "native-loop":
      return registry["gitgecko-native"] ?? null;
    case "deterministic":
      return null;
  }
};

// --- The canonical agent factory (collapses the 4 parallel createAgent sites) ---

/**
 * A native-plug constructor: takes a shell-out executor, returns an Agent.
 * Each native agent plug exports this shape (createCodexAgent etc.). The
 * caller injects them because packages/review cannot import the plugs
 * directly (cycle: plugs → review for the Agent type).
 */
export interface NativePlugFactory {
  (shellOut?: NativeShellOut): Agent;
}

/** The shell-out executor signature all native plugs accept. */
export interface NativeShellOut {
  (binary: string, args: readonly string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string }): string;
}

/**
 * The injected native plugs. Each key maps a binary name to its plug factory.
 * Callers populate this from the plugs they have access to; the canonical
 * factory dispatches by resolution.binary.
 */
export interface NativePlugMap {
  readonly codex?: NativePlugFactory;
  readonly claude?: NativePlugFactory;
  readonly opencode?: NativePlugFactory;
}

/** PI is an SDK runtime, not a native binary, so its constructor owns endpoint configuration. */
export interface PiPlugFactory {
  (config: LocalEndpointConfig): Agent;
}

/**
 * The deps the canonical factory needs to construct an Agent.
 * - modelComplete: a BYOK provider (from createAutoComplete or loadModelPlug).
 *    When present and no native binary resolved, used for real LLM reviews.
 * - nativePlugs: the native agent plug factories + a shellOut executor.
 *    When a native binary resolved, the matching plug is used (zero-config).
 * - placeholderMessage: the message the placeholder agent returns when nothing
 *    is configured. Each call site can customize the actionable text.
 */
export interface AgentFactoryDeps {
  readonly modelComplete?: (prompt: string, model?: string) => Promise<string>;
  readonly nativePlugs?: { readonly shellOut?: NativeShellOut; readonly factories: NativePlugMap };
  readonly piFactory?: PiPlugFactory;
  readonly placeholderMessage?: (resolution: AgentResolution) => string;
}

/** The minimal resolution shape the factory needs (callers may pass PathwayResolution or a subset). */
export interface AgentResolution {
  readonly family: string;
  readonly binary?: string;
  readonly localConfig?: LocalEndpointConfig;
}

/**
 * The canonical agent factory. This is the ONE place that decides which Agent
 * to construct for a given pathway resolution. All four entry points (CLI bin,
 * orchestrator app, web app, benchmark) should call this instead of maintaining
 * their own parallel switches.
 *
 * Dispatch order:
 *  1. Native binary resolved + matching plug available → native shell-out (zero-config).
 *  2. BYOK modelComplete available → gitgecko-native wrapping it.
 *  3. Nothing → placeholder agent with an actionable message.
 *
 * The gitgecko-native adapter (createGitGeckoNativeAgent) is NOT imported here to avoid
 * a cycle (the plug imports review). The caller wraps modelComplete into an
 * Agent before passing it — OR passes a pre-built native-loop Agent via the
 * `nativeLoopAgent` field. This keeps the factory cycle-free.
 */
export const createAgentForResolution = (
  resolution: AgentResolution,
  deps: AgentFactoryDeps,
  /** A pre-built native-loop Agent (from createGitGeckoNativeAgent). Required for the BYOK + placeholder paths. */
  nativeLoopAgent: (completeOrPlaceholder: (prompt: string, model?: string) => Promise<string>) => Agent,
): Agent => {
  // 1. Native shell-out: zero-config, uses the developer's own login.
  if (resolution.family === "native" && resolution.binary && deps.nativePlugs) {
    const { shellOut, factories } = deps.nativePlugs;
    const factory = factories[resolution.binary as keyof NativePlugMap];
    if (factory) return factory(shellOut);
  }

  // An explicitly selected native pathway never falls through to another
  // provider. Provider choice is an execution contract, not a retry hint.
  if (resolution.family === "native") {
    return nativeLoopAgent(async () => {
      throw new Error(
        resolution.binary
          ? `[GitGecko] Native agent '${resolution.binary}' is unavailable.`
          : "[GitGecko] Native pathway requested, but codex, claude, and opencode are unavailable.",
      );
    });
  }

  // 2. Local pathway: review semantics over the canonical model-client transport.
  if (resolution.family === "pi" && resolution.localConfig && deps.piFactory) {
    return deps.piFactory(resolution.localConfig);
  }

  if (resolution.family === "pi") {
    return nativeLoopAgent(async () => {
      throw new Error("[GitGecko] PI coding-agent runtime is unavailable.");
    });
  }

  if (resolution.family === "local" && resolution.localConfig) {
    return createGitGeckoLocalAgent(resolution.localConfig);
  }

  // 3. BYOK: a model provider is configured.
  if (deps.modelComplete) {
    return nativeLoopAgent(deps.modelComplete);
  }

  // 4. No executable backend: fail through the normal Agent error contract.
  return nativeLoopAgent(async () => {
    const msg = deps.placeholderMessage
      ? deps.placeholderMessage(resolution)
      : `[GitGecko] No model configured (${resolution.family}). Set ANTHROPIC_API_KEY / OPENAI_API_KEY / GITGECKO_LOCAL_BASE_URL or install claude/codex/opencode.`;
    throw new Error(msg);
  });
};
