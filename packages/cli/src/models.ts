import { configuredLocalModel, discoverLocalModels, type GitGeckoModel, type ModelProtocol } from "@gitgecko/model-client";
import { resolveProductCloudUrl } from "@gitgecko/core/product-identity";
import type { AuthState } from "./auth.js";
import type { ModelProviderConfig } from "./config.js";

interface ModelsResponse {
  readonly data?: ReadonlyArray<{
    readonly id?: unknown;
    readonly owned_by?: unknown;
    readonly name?: unknown;
    readonly protocols?: unknown;
    readonly capabilities?: unknown;
  }>;
}

/** Load the model catalog from local discovery or the authenticated cloud API. */
export const loadAvailableModels = async (
  auth: AuthState | undefined,
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
  provider?: ModelProviderConfig,
): Promise<readonly GitGeckoModel[]> => {
  const localBaseUrl = provider?.baseUrl ?? (env.GITGECKO_LOCAL_BASE_URL?.trim() || env.OPENAI_BASE_URL?.trim());
  if (localBaseUrl) {
    const configured = provider?.protocol ?? env.GITGECKO_LOCAL_PROTOCOL;
    const protocol: ModelProtocol = configured === "openai-responses" || configured === "anthropic-messages"
      ? configured
      : "openai-chat-completions";
    const selected = configuredLocalModel(provider?.model ?? env.GITGECKO_LOCAL_MODEL, protocol);
    try {
      const discovered = await discoverLocalModels(localBaseUrl, protocol, request);
      if (!selected || discovered.some((model) => model.id === selected.id)) return discovered;
      return [selected, ...discovered];
    } catch (error) {
      // Match the HTTP catalog owner: an explicit local model remains useful
      // when the endpoint has no catalog, while an unconfigured endpoint still
      // fails honestly instead of inventing a model.
      if (selected) return [selected];
      let endpoint = "the configured local endpoint";
      try { endpoint = new URL(localBaseUrl).origin; } catch { /* schema/config owner reports malformed URLs */ }
      throw new Error(`Local model discovery failed at ${endpoint}: ${error instanceof Error ? error.message : String(error)}. Run \`gitgecko models show\` to inspect routing or \`gitgecko models clear\` to remove it.`);
    }
  }

  const cloudUrl = auth?.cloudUrl ?? resolveProductCloudUrl(env);
  let response: Response;
  try {
    response = await request(`${cloudUrl.replace(/\/$/, "")}/models`, {
      headers: auth ? { Authorization: `Bearer ${auth.token}` } : {},
    });
  } catch (error) {
    throw new Error(`Model catalog request failed at ${cloudUrl}: ${error instanceof Error ? error.message : String(error)}. Run \`gitgecko doctor\` to verify connectivity.`);
  }
  if (response.status === 401) {
    throw new Error("Cloud session expired or this device was revoked. Run `gitgecko login` to relink it.");
  }
  if (!response.ok) throw new Error(`Model catalog returned ${response.status} from ${cloudUrl}.`);
  const payload = await response.json() as ModelsResponse;
  return (payload.data ?? [])
    .filter((model): model is typeof model & { id: string } => typeof model.id === "string")
    .map((model) => ({
      id: model.id,
      object: "model" as const,
      ownedBy: model.owned_by === "local" ? "local" as const : "gitgecko" as const,
      name: typeof model.name === "string" ? model.name : model.id,
      protocols: Array.isArray(model.protocols) ? model.protocols as ModelProtocol[] : [],
      capabilities: {
        text: true as const,
        tools: Boolean((model.capabilities as { tools?: unknown } | undefined)?.tools),
        reasoning: Boolean((model.capabilities as { reasoning?: unknown } | undefined)?.reasoning),
        streaming: Boolean((model.capabilities as { streaming?: unknown } | undefined)?.streaming),
      },
    }));
};

/** Render the compact, script-friendly `gitgecko models` output. */
export const renderModels = (models: readonly GitGeckoModel[]): string =>
  models.length === 0
    ? "No models discovered. Run `gitgecko doctor` to check provider connectivity."
    : models.map((model) => `${model.id}\t${model.ownedBy}\t${model.protocols.join(",")}`).join("\n");
