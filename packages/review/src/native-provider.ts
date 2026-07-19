/** Provider-neutral socket for installed CLI and SDK review runtimes. */
import type { PlugManifest } from "@gitgecko/socket";
import type { Agent, NativeAgentFailure } from "./agent.js";
import type { NativeAgentPermission } from "./native-threads.js";

export const NATIVE_PROVIDER_ORDER = ["codex", "claude", "opencode", "pi"] as const;
export type NativeAgentProviderId = typeof NATIVE_PROVIDER_ORDER[number];
export type NativeAgentActivityPhase = "starting" | "thinking" | "tool" | "finalizing" | "completed";

export interface NativeAgentActivityEvent {
  readonly phase: NativeAgentActivityPhase;
  readonly provider: NativeAgentProviderId;
  readonly message?: string;
  readonly tool?: string;
  readonly at: string;
  /** Additive provider fields stay internal until a consumer explicitly adopts them. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface NativeAgentCapabilities {
  readonly cwd: boolean;
  readonly permissions: readonly NativeAgentPermission[];
  readonly ephemeral: boolean;
  readonly threads: boolean;
  readonly resume: boolean;
  readonly cancellation: boolean;
  readonly activity: boolean;
  readonly usage: boolean;
  readonly schemaDiscovery: boolean;
}

export interface NativeAgentRuntimeProfile {
  readonly schemaVersion: "native-agent-runtime.v1";
  readonly provider: NativeAgentProviderId;
  readonly providerVersion: string;
  readonly executable?: string;
  readonly schemaHash: string;
  /** Non-secret configuration fingerprint when capability shape depends on config. */
  readonly configurationHash?: string;
  readonly capabilities: NativeAgentCapabilities;
  /** Provider-owned, forward-compatible data. Never copied into public review JSON. */
  readonly rawSchema?: unknown;
  readonly diagnostics?: readonly string[];
}

export interface NativeAgentProviderConfig {
  readonly cwd?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly protocol?: string;
  readonly apiKey?: string;
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface NativeAgentProviderProbe {
  readonly installed: boolean;
  readonly executable?: string;
  readonly version?: string;
  readonly failure?: NativeAgentFailure;
  readonly diagnostic?: string;
}

/** Every native provider plug implements this exact construction contract. */
export interface NativeAgentProviderPlug {
  readonly id: NativeAgentProviderId;
  readonly manifest: PlugManifest;
  readonly preference: number;
  readonly probe: () => NativeAgentProviderProbe | Promise<NativeAgentProviderProbe>;
  /** Returns only non-secret inputs that can change the discovered profile. */
  readonly profileKey?: (config?: NativeAgentProviderConfig) => unknown;
  readonly discoverCapabilities: (config?: NativeAgentProviderConfig) => Promise<NativeAgentRuntimeProfile>;
  readonly create: (config?: NativeAgentProviderConfig) => Agent;
}

export interface NativeAgentProviderRegistry {
  readonly register: (plug: NativeAgentProviderPlug) => void;
  readonly get: (id: NativeAgentProviderId) => NativeAgentProviderPlug | undefined;
  readonly list: () => readonly NativeAgentProviderPlug[];
  readonly select: (available: readonly NativeAgentProviderId[]) => NativeAgentProviderPlug | undefined;
}

/** One non-exclusive registry owns selection; entrypoints only compose plugs. */
export const createNativeAgentProviderRegistry = (
  initial: readonly NativeAgentProviderPlug[] = [],
): NativeAgentProviderRegistry => {
  const plugs = new Map<NativeAgentProviderId, NativeAgentProviderPlug>();
  const register = (plug: NativeAgentProviderPlug): void => {
    if (plugs.has(plug.id)) throw new Error(`Native agent provider '${plug.id}' is already registered.`);
    if (plug.manifest.owner !== "review") throw new Error(`Native agent provider '${plug.id}' must target the review owner.`);
    plugs.set(plug.id, plug);
  };
  initial.forEach(register);
  return {
    register,
    get: (id) => plugs.get(id),
    list: () => [...plugs.values()].sort((a, b) => a.preference - b.preference),
    select: (available) => [...plugs.values()]
      .filter((plug) => available.includes(plug.id))
      .sort((a, b) => a.preference - b.preference)[0],
  };
};

/** Resolve a provider through the socket without another-provider fallback. */
export const createAgentFromProviderRegistry = (
  registry: NativeAgentProviderRegistry,
  provider: NativeAgentProviderId,
  config?: NativeAgentProviderConfig,
): Agent => {
  const plug = registry.get(provider);
  if (!plug) throw new Error(`Native agent provider '${provider}' is unavailable.`);
  return plug.create(config);
};
