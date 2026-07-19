/** Bundled plug composition. Provider policy remains owned by @gitgecko/review. */
import {
  createAgentFromProviderRegistry,
  createNativeAgentProviderRegistry,
  createAgentForResolution,
  type Agent,
  type AgentResolution,
  type LocalEndpointConfig,
  type NativeAgentProviderConfig,
  type NativeAgentProviderId,
} from "@gitgecko/review";
import { providerPlug as codex } from "@gitgecko/plug-agent-codex";
import { providerPlug as claude } from "@gitgecko/plug-agent-claude-code";
import { providerPlug as opencode } from "@gitgecko/plug-agent-opencode";
import { providerPlug as pi } from "@gitgecko/plug-agent-pi";
import { ensureProviderRuntimeProfile } from "@gitgecko/review/native-provider-runtime";

export const bundledProviderRegistry = createNativeAgentProviderRegistry([codex, claude, opencode, pi]);

/** Discover/cache runtime capabilities before delegating to the provider agent. */
const createPreparedProviderAgent = (provider: NativeAgentProviderId, config?: NativeAgentProviderConfig): Agent => {
  const plug = bundledProviderRegistry.get(provider);
  if (!plug) throw new Error(`Native agent provider '${provider}' is unavailable.`);
  const agent = createAgentFromProviderRegistry(bundledProviderRegistry, provider, config);
  return {
    name: agent.name,
    install: agent.install,
    run: async (ctx) => {
      ctx.onActivity?.({ phase: "starting", provider, message: `Checking ${provider} runtime capabilities`, at: new Date().toISOString() });
      await ensureProviderRuntimeProfile(plug, config);
      return agent.run(ctx);
    },
  };
};

const piProviderConfig = (config: LocalEndpointConfig): NativeAgentProviderConfig => ({
  baseUrl: config.baseUrl,
  model: config.modelId,
  ...(config.protocol ? { protocol: config.protocol } : {}),
  ...(config.apiKey ? { apiKey: config.apiKey } : {}),
});

/** Resolve all bundled providers through the same socket construction path. */
export const createBundledAgent = (
  resolution: AgentResolution,
  nativeLoopAgent: (complete: (prompt: string, model?: string) => Promise<string>) => Agent,
  modelComplete?: (prompt: string, model?: string) => Promise<string>,
): Agent => {
  if (resolution.family === "native" && resolution.binary) {
    return createPreparedProviderAgent(resolution.binary as NativeAgentProviderId);
  }
  if (resolution.family === "pi" && resolution.localConfig) {
    return createPreparedProviderAgent("pi", piProviderConfig(resolution.localConfig));
  }
  return createAgentForResolution(resolution, { ...(modelComplete ? { modelComplete } : {}) }, nativeLoopAgent);
};

export const createBundledThreadAgent = (
  provider: NativeAgentProviderId,
  piConfig?: LocalEndpointConfig,
): Agent => createPreparedProviderAgent(provider, provider === "pi" && piConfig ? piProviderConfig(piConfig) : undefined);
