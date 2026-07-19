import { getPlan, type PlanId } from "@gitgecko/plans";
import { GITGECKO_MODELS } from "./gitgecko-models.js";

/** Protocols accepted by GitGecko model adapters and discoverable local servers. */
export type ModelProtocol = "openai-chat-completions" | "openai-responses" | "anthropic-messages";

/** Public model metadata. Upstream provider identities never cross this boundary. */
export interface GitGeckoModel {
  readonly id: string;
  readonly object: "model";
  readonly ownedBy: "gitgecko" | "local";
  readonly name: string;
  readonly protocols: readonly ModelProtocol[];
  readonly capabilities: ModelCapabilities;
}

/** Capabilities exposed by the active model adapter, not by a provider guess. */
export interface ModelCapabilities {
    readonly text: true;
    readonly tools: boolean;
    readonly reasoning: boolean;
    readonly streaming: boolean;
}

interface HostedModel extends GitGeckoModel {
  readonly minimumPlan: PlanId;
}

export type HostedModelAlias = "gitgecko-light" | "gitgecko-high";

/** Normalize only canonical hosted IDs at the model owner boundary. */
export const normalizeHostedModelAlias = (alias: string): HostedModelAlias | undefined => {
  if (alias === "gitgecko-light") return "gitgecko-light";
  if (alias === "gitgecko-high") return "gitgecko-high";
  return undefined;
};

const HOSTED_PROTOCOLS: readonly ModelProtocol[] = [
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
] as const;

const HOSTED_CAPABILITIES: ModelCapabilities = {
  text: true,
  tools: true,
  reasoning: false,
  // Hosted adapters expose a real stream for each supported wire format.
  streaming: true,
};

/** Public catalog metadata is derived from the provider-routing owner. */
const HOSTED_MODELS: readonly HostedModel[] = [
  {
    id: GITGECKO_MODELS.light.id,
    object: "model",
    ownedBy: "gitgecko",
    name: GITGECKO_MODELS.light.name,
    minimumPlan: "free",
    protocols: HOSTED_PROTOCOLS,
    capabilities: HOSTED_CAPABILITIES,
  },
  {
    id: GITGECKO_MODELS.high.id,
    object: "model",
    ownedBy: "gitgecko",
    name: GITGECKO_MODELS.high.name,
    minimumPlan: "pro",
    protocols: HOSTED_PROTOCOLS,
    capabilities: HOSTED_CAPABILITIES,
  },
];

/** Return only hosted aliases available to a plan, stripped of private routing data. */
export const listHostedModels = (planId: PlanId): readonly GitGeckoModel[] => {
  const plan = getPlan(planId) ?? getPlan("free")!;
  return HOSTED_MODELS
    .filter((model) => plan.rank >= (getPlan(model.minimumPlan)?.rank ?? Number.POSITIVE_INFINITY))
    .map(({ minimumPlan: _minimumPlan, ...model }) => model);
};

/**
 * Publish an explicitly selected local model even when its server has no
 * `/models` endpoint. The configured ID is operator input, not an inferred
 * provider catalog, so callers can distinguish it from discovery results.
 */
export const configuredLocalModel = (
  modelId: string | undefined,
  protocol: ModelProtocol = "openai-chat-completions",
): GitGeckoModel | undefined => {
  const id = modelId?.trim();
  if (!id) return undefined;
  return {
    id,
    object: "model",
    ownedBy: "local",
    name: id,
    protocols: [protocol],
    capabilities: { text: true, tools: true, reasoning: false, streaming: true },
  };
};

/** Resolve a public hosted alias to its private provider model after entitlement checks. */
export const resolveHostedModel = (
  alias: string,
  planId: PlanId,
): { readonly alias: HostedModelAlias } => {
  const normalized = normalizeHostedModelAlias(alias);
  const model = normalized ? HOSTED_MODELS.find((candidate) => candidate.id === normalized) : undefined;
  if (!model) throw new Error(`Unknown GitGecko model "${alias}".`);
  const entitled = listHostedModels(planId).some((candidate) => candidate.id === normalized);
  if (!entitled) throw new Error(`Model "${alias}" requires the ${model.minimumPlan} plan or higher.`);
  return { alias: model.id as HostedModelAlias };
};

/** Discover model IDs from an OpenAI-compatible server without assuming its catalog. */
export const discoverLocalModels = async (
  baseUrl: string,
  protocol: ModelProtocol = "openai-chat-completions",
  request: typeof fetch = fetch,
): Promise<readonly GitGeckoModel[]> => {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/models`;
  const response = await request(endpoint, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Local model discovery returned ${response.status} from ${endpoint}.`);
  const payload = await response.json() as { data?: Array<{ id?: unknown }> };
  return (payload.data ?? [])
    .filter((model): model is { id: string } => typeof model.id === "string" && model.id.length > 0)
    .map((model) => ({
      id: model.id,
      object: "model" as const,
      ownedBy: "local" as const,
      name: model.id,
      protocols: [protocol],
      capabilities: { text: true as const, tools: true, reasoning: false, streaming: false },
    }));
};
