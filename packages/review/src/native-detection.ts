/**
 * @gitgecko/review/native-detection — the pure logic of native-agent detection.
 *
 * This module contains NO Node.js imports (no child_process, no util). It's
 * safe to import from the client bundle. The actual PATH probe (which uses
 * execFileSync) lives in native-agents.ts (server-only).
 *
 * Split from native-agents.ts to fix the Vite + TanStack Start client-bundle
 * leak: the barrel export (index.ts) re-exported native-agents.ts which imports
 * node:child_process, breaking browser hydration ("promisify is not a function").
 * Now the barrel exports THIS file (pure), and native-agents.ts is an explicit
 * server-only subpath import.
 */
export const NATIVE_AGENT_PREFERENCE = ["codex", "claude", "opencode"] as const;

export type NativeAgentId = (typeof NATIVE_AGENT_PREFERENCE)[number];

/**
 * Maps a PATH binary name to its canonical agent-plug id.
 *
 * The binary on PATH and the agent-plug id are usually the same — except
 * `claude`, whose binary is `claude` but whose agent-plug (and thus registry
 * key) is `claude-code`. This is the one renaming the contract requires; every
 * other binary passes through unchanged.
 */
export const binaryToAgentId = (binary: string): string => {
  if (binary === "claude") return "claude-code";
  return binary;
};

export interface NativeAgentDetection {
  readonly available: readonly string[];
  readonly preferred: string | null;
}

export type BinaryProbe = (binary: string) => boolean;

export const detectNativeAgents = (probe: BinaryProbe): NativeAgentDetection => {
  const available = NATIVE_AGENT_PREFERENCE.filter(probe);
  return {
    available,
    preferred: available.length > 0 ? available[0]! : null,
  };
};
