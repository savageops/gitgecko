/**
 * @gitgecko/model-client/gitgecko-models — the GitGecko hosted model catalog.
 *
 * The cloud offering hosts its own models (partnered, rebranded). The published
 * source shows provider placeholders — anyone reading the code sees configurable
 * canonical GITGECKO_CLOUD_MODEL_* environment slots, not the actual partner
 * credentials. This is the same plug/socket pattern as billing: the source ships
 * with a socket; the operator fills the plug with their provider.
 *
 * Model catalog:
 *  - gitgecko-light: the free-tier model (fast, for light reviews/docs/writing).
 *    Quota-capped per plan. The public alias hides the provider model id.
 *  - gitgecko-high: the pro+ model (reserved for paid plans).
 *    The public alias hides the provider model id.
 *
 * Both are resold through the GitGecko provider route. The actual provider URL and key
 * are env-configured, never hardcoded. This is the "provider plug" pattern: the
 * source shows a socket, the operator fills the socket with their provider.
 *
 * Protocol support: the hosted route dispatches Anthropic Messages, OpenAI Chat
 * Completions, or OpenAI Responses through the adapter selected by
 * GITGECKO_PROVIDER_FORMAT. The public alias and protocol are independent of the
 * provider's internal model names.
 *
 * Salvaged pattern: LM Studio's /models endpoint + OpenAI-compatible API surface
 * (provider-models research captures).
 */

/**
 * The default context window and max-tokens floor. These are conservative
 * values safe for any backend. A larger backend ceiling can be
 * configured via env vars below — see getGitGeckoModelLimits (GAP-D).
 */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_LIGHT_MAX_TOKENS = 8_192;
const DEFAULT_HIGH_MAX_TOKENS = 16_384;


/** Resolve every hosted provider slot through one canonical configuration owner. */
export const readHostedProviderEnvironment = (env: NodeJS.ProcessEnv = process.env) => ({
  apiKey: env.GITGECKO_CLOUD_MODEL_API_KEY?.trim(),
  baseUrl: env.GITGECKO_CLOUD_MODEL_BASE_URL?.trim(),
  lightModel: env.GITGECKO_CLOUD_LIGHT_MODEL?.trim(),
  highModel: env.GITGECKO_CLOUD_HIGH_MODEL?.trim(),
  // Compose passes an empty string for an unset optional variable. Treat
  // whitespace-only values like an omitted value so the documented default
  // remains effective in self-hosted and cloud deployments.
  format: env.GITGECKO_PROVIDER_FORMAT?.trim() || "anthropic",
});

/** The GitGecko hosted model IDs (rebranded — never the underlying model name). */
export const GITGECKO_MODELS = {
  /** Free-tier model. Fast. For light reviews, docs, writing. Quota-capped per plan. */
  light: {
    id: "gitgecko-light",
    name: "GitGecko Light",
    description: "Fast model for reviews, docs, and writing. Free tier.",
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_LIGHT_MAX_TOKENS,
  },
  /** Pro+ model. Reserved for paid plans (pro/max/custom). */
  high: {
    id: "gitgecko-high",
    name: "GitGecko High",
    description: "High-capability model for deep reviews and complex analysis. Pro and above.",
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_HIGH_MAX_TOKENS,
  },
} as const;

/**
 * Read the configurable context window and max-tokens from env (GAP-D).
 *
 * The hardcoded 128K/8K floor is safe for any backend but conservative — a
 * hosted backend may expose a 1,000,000-token context window, and under-reporting means the
 * pipeline may chunk or truncate a review pass that would fit in a single call.
 * The operator sets the real ceiling via GITGECKO_CLOUD_MODEL_CONTEXT_WINDOW and
 * the per-tier max output via GITGECKO_CLOUD_LIGHT_MAX_TOKENS /
 * GITGECKO_CLOUD_HIGH_MAX_TOKENS.
 * When unset, the conservative defaults apply.
 */
export const getGitGeckoModelLimits = (env: NodeJS.ProcessEnv = process.env): {
  readonly contextWindow: number;
  readonly lightMaxTokens: number;
  readonly highMaxTokens: number;
} => {
  const parsePositiveInt = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    contextWindow: parsePositiveInt(env.GITGECKO_CLOUD_MODEL_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW),
    lightMaxTokens: parsePositiveInt(env.GITGECKO_CLOUD_LIGHT_MAX_TOKENS, DEFAULT_LIGHT_MAX_TOKENS),
    highMaxTokens: parsePositiveInt(env.GITGECKO_CLOUD_HIGH_MAX_TOKENS, DEFAULT_HIGH_MAX_TOKENS),
  };
};

/**
 * Resolve the full model descriptor (with env-configured limits) for a tier.
 * Used by listGitGeckoModels (the discovery surface) and by the hosted adapter
 * (so the request model carries the real ceiling, not the hardcoded floor).
 */
export const resolveGitGeckoModel = (tier: "light" | "high") => {
  const limits = getGitGeckoModelLimits();
  const base = GITGECKO_MODELS[tier];
  return {
    id: base.id,
    name: base.name,
    description: base.description,
    contextWindow: limits.contextWindow,
    maxTokens: tier === "light" ? limits.lightMaxTokens : limits.highMaxTokens,
  };
};

/** Which plan tier gets which model. */
export const MODEL_FOR_PLAN: Readonly<Record<string, keyof typeof GITGECKO_MODELS>> = {
  free: "light",
  pro: "high",
  max: "high",
  enterprise: "high",
  custom: "high",
};

/**
 * The provider config — read from env, never hardcoded. This is the canonical
 * four-variable contract consumed by BOTH createAutoComplete (the hot path) and
 * listGitGeckoModels (the discovery surface). All four must be set together — a
 * partial configuration is a deployment error, not a silent fallback.
 */
export interface GitGeckoProviderConfig {
  /** The provider API key (partner credential). From GITGECKO_CLOUD_MODEL_API_KEY. */
  readonly apiKey: string;
  /** The provider base URL. From GITGECKO_CLOUD_MODEL_BASE_URL. */
  readonly baseUrl: string;
  /** The light provider model routed behind gitgecko-light. From GITGECKO_CLOUD_LIGHT_MODEL. */
  readonly lightModel: string;
  /** The high provider model routed behind gitgecko-high. From GITGECKO_CLOUD_HIGH_MODEL. */
  readonly highModel: string;
  /**
   * The wire format the provider speaks. From GITGECKO_PROVIDER_FORMAT (default anthropic).
   * Selects the hosted adapter protocol: anthropic, OpenAI chat completions, or responses.
   */
  readonly format: "completions" | "responses" | "anthropic";
}

/** Parse the provider wire format once and reject unknown values at the owner boundary. */
export const parseGitGeckoProviderFormat = (formatRaw: string): GitGeckoProviderConfig["format"] => {
  if (formatRaw === "completions" || formatRaw === "responses" || formatRaw === "anthropic") return formatRaw;
  throw new Error(`GITGECKO_PROVIDER_FORMAT must be one of: anthropic, completions, responses. Received '${formatRaw}'.`);
};

/**
 * Read the gitgecko provider config from environment variables.
 * Returns undefined if the provider is not configured (local/self-hosted
 * without the gitgecko cloud provider). This is correct: local users use their
 * own native agents or local models; only the cloud deployment has the
 * partner provider key.
 *
 * A partial configuration (some-but-not-all of the four vars) returns undefined
 * here — the createAutoComplete hot path is the place that throws on partial
 * config, because it has the context to name the missing vars in the error.
 */
export const readGitGeckoProviderConfig = (env: NodeJS.ProcessEnv = process.env): GitGeckoProviderConfig | undefined => {
  const { apiKey, baseUrl, lightModel, highModel, format: formatRaw } = readHostedProviderEnvironment(env);
  if (!apiKey || !baseUrl || !lightModel || !highModel) return undefined;

  const format = parseGitGeckoProviderFormat(formatRaw);

  return { apiKey, baseUrl, lightModel, highModel, format };
};

/**
 * The /models endpoint response — lists available models for the current
 * deployment. This is what `gitgecko models` or the dashboard's model picker shows.
 *
 * When the hosted provider is configured: shows gitgecko-light + gitgecko-high with
 * env-configured limits (GAP-D: contextWindow/maxTokens reflect
 * the real backend ceiling, not the hardcoded floor). When not configured
 * (local): shows an empty list (the user configures their own model via env
 * vars or native agents).
 */
export const listGitGeckoModels = (): readonly {
  id: string;
  name: string;
  description: string;
  contextWindow: number;
  maxTokens: number;
}[] => {
  const config = readGitGeckoProviderConfig();
  if (!config) return [];

  return [resolveGitGeckoModel("light"), resolveGitGeckoModel("high")];
};

/**
 * Resolve the model for a given plan tier. Falls back to gitgecko-light for
 * unknown/free tiers (the generous free model).
 */
export const modelForPlan = (plan: string): string =>
  GITGECKO_MODELS[MODEL_FOR_PLAN[plan] ?? "light"].id;
