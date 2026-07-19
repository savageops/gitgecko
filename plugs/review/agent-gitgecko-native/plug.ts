/**
 * gitgecko review plug — agent-gitgecko-native.
 *
 * The first-party agent backend implementing the Agent adapter (P-plugin-3).
 * A MINIMAL agent loop for air-gapped / no-external-agent deployments — the
 * default brain when Claude Code / OpenCode aren't configured.
 *
 * Salvages SWE-agent's lean agent-computer interface (P-plugin-10): one async
 * method + dependency injection. v1 is a deterministic loop that:
 *  1. Builds a prompt from payload + instructions + (optional) retrieved context
 *  2. Calls the model (via a ModelComplete function — BYO from the model owner)
 *  3. Records tool calls into toolState (by reference, P-plugin-3 invariant)
 *  4. Returns the result
 *
 * The "intelligence" (multi-turn tool-use, planning) is the v2 enrichment; v1
 * proves the adapter FITS the socket + the by-ref + trace contracts hold.
 */
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import type { Agent, AgentBackendContribution, AgentRunContext, AgentResult } from "@gitgecko/review";
import { buildReviewPrompt } from "@gitgecko/review";
import manifestJson from "./plug.manifest.json" with { type: "json" };

// --- Manifest (parsed, not cast) --------------------------------------------
const parsedManifest = parseManifest(manifestJson);
if (!parsedManifest.ok) {
  throw new Error(`agent-gitgecko-native manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
}
export const manifest: PlugManifest = parsedManifest.value;

/**
 * The model completion function — BYO from the model owner (P-plugin-10 lean
 * handler). The gitgecko-native loop is model-agnostic: it calls this with a prompt
 * and gets text back. The model owner's plug (anthropic/openai/ollama) provides it.
 */
export type ModelComplete = (prompt: string, model?: string) => Promise<string>;

/**
 * Build the gitgecko-native Agent. The ModelComplete function is injected at run
 * time (BYO model — G5), keeping the agent model-agnostic.
 */
export const createGitGeckoNativeAgent = (complete: ModelComplete): Agent => ({
  name: "gitgecko-native",
  install: async () => "gitgecko-native (built-in, no install needed)",
  run: async (ctx: AgentRunContext): Promise<AgentResult> => {
    try {
      const prompt = buildReviewPrompt(ctx);

      // Call the model (BYO). This is the lean handler (P-plugin-10).
      const output = await complete(prompt, ctx.resolvedModel);

      // Record the tool call into toolState BY REFERENCE (P-plugin-3 invariant).
      ctx.toolState.calls.push({
        tool: "model.complete",
        input: { prompt: prompt.slice(0, 200) },
        result: output.slice(0, 200),
      });

      // Fire the onToolUse event (feeds trace, 05 §5).
      ctx.onToolUse?.({ tool: "model.complete", input: prompt });

      return {
        success: true,
        output,
      };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  },
});

// --- Plug setup (registers the agent-backend capability) --------------------
// The registry supplies request-scoped configuration because hosted model
// entitlement can change the model alias per request. The static `agent` keeps
// the contribution backward-compatible for consumers that do not need a
// request-specific provider; production callers use `create` below.
export async function setup(api: {
  register: (capability: "agent-backend", contribution: AgentBackendContribution) => void;
  readonly ctx: { readonly config: Readonly<Record<string, unknown>> };
}): Promise<void> {
  const configuredComplete = readModelComplete(api.ctx.config);
  const fallback = async () => {
    throw new Error("gitgecko-native requires a configured model owner plug");
  };
  api.register("agent-backend", {
    kind: "agent-backend",
    id: "gitgecko-native-agent",
    agent: createGitGeckoNativeAgent(configuredComplete ?? fallback),
    create: (config) => createGitGeckoNativeAgent(readModelComplete(config) ?? configuredComplete ?? fallback),
    mutates: false,
  });
}

const readModelComplete = (config: Readonly<Record<string, unknown>>): ModelComplete | undefined => {
  const complete = config.modelComplete;
  return typeof complete === "function" ? complete as ModelComplete : undefined;
};

// Re-export for direct use (tests/orchestrator inject the real model fn).
export { createGitGeckoNativeAgent as createAgent };
