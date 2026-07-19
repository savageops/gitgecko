/**
 * @gitgecko/model-client — public surface.
 *
 * The cloud-pathway LLM client. Delegates ALL provider HTTP/streaming/compat/
 * auth/retry to @earendil-works/pi-ai (the salvaged pi harness). Replaces the
 * prior homegrown raw-fetch client.
 */
export {
  createProviderComplete,
  createProviderGenerate,
  createProviderStream,
  createAnthropicModels,
  createOpenAIModels,
  createAnthropicComplete,
  createAnthropicGenerate,
  createAnthropicStream,
  createOpenAIComplete,
  createOpenAIGenerate,
  createOpenAIStream,
  createLocalComplete,
  createLocalGenerate,
  createLocalStream,
  createAutoComplete,
  createHostedComplete,
  createHostedGenerate,
  createHostedStream,
  type ModelComplete,
  type ModelGenerate,
  type ModelGenerateOptions,
  type ModelStream,
  type ProviderCompleteOptions,
  type CompleteOptions,
  type AutoCompleteResult,
  type AutoCompleteOptions,
  type LocalProviderOptions,
} from "./model-client.js";
export {
  configuredLocalModel,
  discoverLocalModels,
  listHostedModels,
  normalizeHostedModelAlias,
  resolveHostedModel,
  type HostedModelAlias,
  type GitGeckoModel,
  type ModelCapabilities,
  type ModelProtocol,
} from "./catalog.js";
export {
  withRetry,
  classifyError,
  isTransient,
  type ErrorCategory,
  type RetryOptions,
} from "./errors.js";
export {
  MODEL_CAPABILITIES,
  modelOwner,
  type ModelCapability,
  type ModelContributionKind,
  type ModelContribution,
} from "./owner.js";
export type {
  ModelMessage,
  ModelProtocolError,
  ModelRequest,
  ModelResponse,
  ModelRole,
  ModelStopReason,
  ModelStreamEvent,
  ModelToolCall,
  ModelToolDefinition,
  ModelUsage,
} from "./protocol.js";
export {
  GITGECKO_MODELS,
  MODEL_FOR_PLAN,
  readGitGeckoProviderConfig,
  readHostedProviderEnvironment,
  parseGitGeckoProviderFormat,
  listGitGeckoModels,
  modelForPlan,
  getGitGeckoModelLimits,
  resolveGitGeckoModel,
  type GitGeckoProviderConfig,
} from "./gitgecko-models.js";
export {
  probeLocalProvider,
  type ProviderProbeResult,
  type ProviderProbeStatus,
} from "./provider-probe.js";
export {
  isForbiddenProviderAddress,
  parseProviderEndpoint,
  validateCloudProviderEndpoint,
  type ProviderDnsAddress,
  type ProviderDnsResolver,
  type ProviderTopology,
  type ValidatedCloudProviderEndpoint,
} from "./endpoint-policy.js";
export {
  createPinnedDispatcher,
  createPinnedLookup,
  createPinnedProviderTransport,
  type PinnedProviderTransport,
} from "./pinned-provider-transport.js";
