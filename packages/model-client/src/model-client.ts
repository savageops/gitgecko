/**
 * @gitgecko/model-client — the cloud-pathway LLM client.
 *
 * Salvage-first (goal §2, A15): gitgecko does NOT implement its own LLM HTTP
 * client. This module DELEGATES to pi harness (@earendil-works/pi-ai) for ALL
 * provider HTTP, streaming, the compat matrix, auth, prompt caching, retry,
 * and the 40+ provider catalogs (Anthropic, OpenAI, OpenRouter, Bedrock,
 * Google, Groq, DeepSeek, …). This replaces the prior homegrown raw-fetch
 * client (plugs/model/real-complete.ts), which duplicated a fraction of this.
 *
 * Public seam (unchanged from the old client, so consumers are drop-in):
 *   type ModelComplete = (prompt: string, model?: string) => Promise<string>;
 *
 * Three constructors:
 *  - createProviderComplete(models, opts): the low-level one. Takes a REAL
 *    pi-ai Models runtime + which provider/api/model to dispatch to. Tests
 *    prove real dispatch by passing a fauxProvider-backed Models.
 *  - createAnthropicComplete(opts) / createOpenAIComplete(opts): convenience
 *    wrappers that build a Models with the pi-ai builtin provider at call time.
 *  - createAutoComplete(): env-driven provider priority (anthropic > openai >
 *    local > throw), the single source of truth the orchestrator + plugs use.
 *
 * Pi result shape (types.ts:383): AssistantMessage { content: TextContent[],
 * usage: Usage, stopReason }. We extract text + surface errors (pi-ai resolves
 * error responses rather than throwing — stopReason "error"/"aborted").
 */
import {
  createModels,
  createProvider,
  type Models,
  type Context,
  type AssistantMessage,
  type TextContent,
  type ToolCall,
  type StopReason,
  type ApiKeyAuth,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { withRetry, type RetryOptions } from "./errors.js";
import { resolveHostedModel, type ModelCapabilities, type ModelProtocol } from "./catalog.js";
import { parseGitGeckoProviderFormat, readHostedProviderEnvironment, resolveGitGeckoModel } from "./gitgecko-models.js";
import type { PlanId } from "@gitgecko/plans";
import { resolveDeploymentMode, type DeploymentMode } from "@gitgecko/core/deployment";
import type { ModelMessage, ModelResponse, ModelStopReason, ModelStreamEvent, ModelToolCall, ModelToolDefinition, ModelUsage } from "./protocol.js";

/** The ModelComplete seam — identical to agent-gitgecko-native's ModelComplete. */
export type ModelComplete = (prompt: string, model?: string) => Promise<string>;

/** Typed inference seam used when protocol consumers need accounting metadata. */
export interface ModelGenerateOptions {
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  /** Cancels an in-flight provider request when the public caller disconnects. */
  readonly signal?: AbortSignal;
  /** Provider transport deadline in milliseconds. Intended for bounded diagnostics. */
  readonly timeoutMs?: number;
  /** Provider-native retry count. GitGecko retry policy remains separately owned. */
  readonly maxRetries?: number;
  /** SDK-compatible transport override owned by the cloud egress boundary. */
  readonly fetch?: typeof globalThis.fetch;
  readonly tools?: readonly ModelToolDefinition[];
  readonly messages?: readonly ModelMessage[];
}

export type ModelGenerate = (
  prompt: string,
  model?: string,
  options?: ModelGenerateOptions,
) => Promise<Omit<ModelResponse, "id" | "model">>;

/** Real provider event stream used by protocol adapters that support SSE. */
export type ModelStream = (
  prompt: string,
  model?: string,
  options?: ModelGenerateOptions,
) => AsyncIterable<ModelStreamEvent>;

/** Options for the low-level provider-backed constructor. */
export interface ProviderCompleteOptions {
  /** The pi-ai provider id the Models runtime should route to (e.g. "anthropic"). */
  readonly providerId: string;
  /** The api id stamped on the model (e.g. "anthropic-messages", "openai-responses"). */
  readonly apiId: string;
  /** The default model id to dispatch when the caller omits the model arg. */
  readonly modelId: string;
  /** Override the model's baseUrl (for local/custom OpenAI-compatible endpoints). */
  readonly baseUrl?: string;
  /** SDK-compatible transport override forwarded through the patched pi-ai seam. */
  readonly fetch?: typeof globalThis.fetch;
  /** Carried through completeSimple({ apiKey }) — pi-ai's per-request auth path. */
  readonly apiKey?: string;
  /**
   * Enable extended thinking / reasoning mode. When set, the model declares
   * `reasoning: true` and pi-ai receives `options.reasoning` — which causes it
   * to send `thinking: { type: "enabled", budget_tokens }` on the wire.
   * The review pathway enables this by default (GAP-E): reasoning depth is a
   * load-bearing quality axis for code review, and the backend returns markedly
   * better analysis when thinking is on.
   */
  readonly reasoning?: ThinkingLevel;
  /**
   * The model's context window (max input tokens). Defaults to 128K (GAP-D: a
   * conservative floor). The hosted route overrides this with the env-configured
   * ceiling (GITGECKO_CLOUD_MODEL_CONTEXT_WINDOW) so the request model reflects the
   * real backend capability, not the hardcoded floor.
   */
  readonly contextWindow?: number;
  /** The model's max output tokens. Defaults to 8K. */
  readonly maxTokens?: number;
}

/**
 * Extract text from a pi-ai AssistantMessage — concatenate all text blocks.
 */
const assistantText = (message: AssistantMessage): string =>
  message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");

/** Preserve structured model tool calls for protocol-native encoding. */
const assistantToolCalls = (message: AssistantMessage): readonly ModelToolCall[] =>
  message.content
    .filter((block): block is ToolCall => block.type === "toolCall")
    .map((block) => ({ id: block.id, name: block.name, arguments: block.arguments }));

/** Translate normalized JSON-schema tools into pi-ai's context contract. */
const contextTools = (tools: readonly ModelToolDefinition[] | undefined): Context["tools"] =>
  tools?.map((tool) => ({ name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema })) as Context["tools"];

const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Build the provider conversation without flattening roles into prompt text. */
const providerContext = (prompt: string, opts: ProviderCompleteOptions, options?: ModelGenerateOptions): Context => {
  const source = options?.messages ?? [{ role: "user" as const, content: prompt }];
  const systemPrompt = source.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const messages: Context["messages"] = source.filter((message) => message.role !== "system").map((message) => {
    if (message.role === "assistant") {
      const content = [
        ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
        ...(message.toolCalls?.map((toolCall) => ({ type: "toolCall" as const, id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments })) ?? []),
      ];
      return { role: "assistant", content, api: opts.apiId, provider: opts.providerId, model: opts.modelId, usage: emptyUsage, stopReason: message.toolCalls?.length ? "toolUse" : "stop", timestamp: Date.now() } as Context["messages"][number];
    }
    if (message.role === "tool") return { role: "toolResult", toolCallId: message.toolCallId ?? "unknown", toolName: message.name ?? "tool", content: [{ type: "text", text: message.content }], isError: false, timestamp: Date.now() };
    return { role: "user", content: message.content, timestamp: Date.now() };
  });
  return {
    messages,
    ...(systemPrompt && { systemPrompt }),
    ...(options?.tools?.length && { tools: contextTools(options.tools)! }),
  };
};

/** Normalize pi-ai's stop vocabulary without flattening provider semantics. */
const normalizeStopReason = (reason: StopReason): ModelStopReason =>
  reason === "toolUse" ? "tool_use" : reason === "length" ? "length" : "stop";

/** Preserve provider-reported token accounting at the model-owner boundary. */
const normalizeUsage = (message: AssistantMessage): ModelUsage => ({
  inputTokens: message.usage.input,
  outputTokens: message.usage.output,
  totalTokens: message.usage.totalTokens,
  ...(message.usage.cacheRead > 0 && { cacheReadTokens: message.usage.cacheRead }),
  ...(message.usage.cacheWrite > 0 && { cacheWriteTokens: message.usage.cacheWrite }),
  ...(message.usage.reasoning !== undefined && { reasoningTokens: message.usage.reasoning }),
});

/** Retain the legacy text-only seam as a compatibility adapter, not an owner. */
const completeFromGenerate = (generate: ModelGenerate): ModelComplete =>
  async (prompt, model) => (await generate(prompt, model)).text;

/**
 * Build a ModelComplete against an EXISTING pi-ai Models runtime. This is the
 * testable core: pass a fauxProvider-backed Models and the response traverses
 * real pi-ai completeSimple dispatch. Production callers pass a Models built
 * from createAnthropicModels/createOpenAIModels/createLocalModels below.
 *
 * The dispatch is wrapped in withRetry: transient errors (429, 503, ECONNRESET,
 * timeouts) retry with exponential backoff; permanent errors (401, 400, billing)
 * fail fast. Defaults: 3 attempts, 1s→2s→4s backoff. Override via retryOpts.
 */
export const createProviderGenerate = (
  models: Models,
  opts: ProviderCompleteOptions,
  retryOpts: RetryOptions = {},
): ModelGenerate => {
  return async (prompt: string, model?: string, generateOptions?: ModelGenerateOptions) => {
    const usedModel = model ?? opts.modelId;
    // Build the pi-ai Context. The model is resolved by provider+id inside
    // completeSimple; we stamp api on the request model so dispatch matches.
    // Omit systemPrompt entirely (exactOptionalPropertyTypes forbids undefined).
    const context = providerContext(prompt, opts, generateOptions);
    const requestModel = {
      id: usedModel,
      name: usedModel,
      api: opts.apiId,
      provider: opts.providerId,
      baseUrl: opts.baseUrl ?? "",
      // Enable reasoning on the model when the caller requests it, so pi-ai's
      // thinking-mode branch (anthropic-messages.js:714) activates. Without this,
      // pi-ai sends thinkingEnabled:false regardless of options.reasoning.
      reasoning: opts.reasoning !== undefined,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // GAP-D: use the caller-configured limits (the hosted route passes the
      // env-configured ceiling); fall back to the conservative 128K/8K floor.
      contextWindow: opts.contextWindow ?? 128_000,
      maxTokens: generateOptions?.maxOutputTokens ?? opts.maxTokens ?? 8_192,
    };

    // Build options without `apiKey`/`reasoning` when unset — exactOptionalPropertyTypes.
    const options: Record<string, unknown> = {};
    if (opts.apiKey) options.apiKey = opts.apiKey;
    if (opts.reasoning) options.reasoning = opts.reasoning;
    if (generateOptions?.temperature !== undefined) options.temperature = generateOptions.temperature;
    if (generateOptions?.signal) options.signal = generateOptions.signal;
    if (generateOptions?.timeoutMs !== undefined) options.timeoutMs = generateOptions.timeoutMs;
    if (generateOptions?.maxRetries !== undefined) options.maxRetries = generateOptions.maxRetries;
    if (generateOptions?.fetch ?? opts.fetch) options.fetch = generateOptions?.fetch ?? opts.fetch;

    // The dispatch + error-surface is the retryable unit. pi-ai resolves error
    // responses rather than throwing (faux.ts:451; real HTTP APIs do the same
    // via utils/event-stream). We surface as a throw so withRetry can classify
    // it (transient → retry, permanent → fail fast) and the ModelComplete
    // contract (which the old client upheld via fetch !ok) holds.
    const result = await withRetry(async () => {
      const r = await models.completeSimple(requestModel, context, options);
      if (r.stopReason === "error" || r.stopReason === "aborted") {
        throw new Error(
          r.errorMessage ?? `pi-ai call ended with stopReason "${r.stopReason}"`,
        );
      }
      return r;
    }, retryOpts);

    return {
      text: assistantText(result),
      ...(assistantToolCalls(result).length > 0 && { toolCalls: assistantToolCalls(result) }),
      stopReason: normalizeStopReason(result.stopReason),
      usage: normalizeUsage(result),
    };
  };
};

/**
 * Build a real pi-ai event stream without replaying a completed response.
 *
 * Streaming retries are intentionally left to the provider transport: replaying
 * after a caller has received a delta can duplicate visible text and billable
 * output. The public protocol owner decides how to encode a terminal error.
 */
export const createProviderStream = (
  models: Models,
  opts: ProviderCompleteOptions,
): ModelStream => {
  return async function* streamProvider(
    prompt: string,
    model?: string,
    generateOptions?: ModelGenerateOptions,
  ): AsyncGenerator<ModelStreamEvent> {
    const usedModel = model ?? opts.modelId;
    const context = providerContext(prompt, opts, generateOptions);
    const requestModel = {
      id: usedModel,
      name: usedModel,
      api: opts.apiId,
      provider: opts.providerId,
      baseUrl: opts.baseUrl ?? "",
      reasoning: opts.reasoning !== undefined,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: opts.contextWindow ?? 128_000,
      maxTokens: generateOptions?.maxOutputTokens ?? opts.maxTokens ?? 8_192,
    };
    const options: Record<string, unknown> = {};
    if (opts.apiKey) options.apiKey = opts.apiKey;
    if (opts.reasoning) options.reasoning = opts.reasoning;
    if (generateOptions?.temperature !== undefined) options.temperature = generateOptions.temperature;
    if (generateOptions?.signal) options.signal = generateOptions.signal;
    if (generateOptions?.timeoutMs !== undefined) options.timeoutMs = generateOptions.timeoutMs;
    if (generateOptions?.maxRetries !== undefined) options.maxRetries = generateOptions.maxRetries;
    if (generateOptions?.fetch ?? opts.fetch) options.fetch = generateOptions?.fetch ?? opts.fetch;

    try {
      for await (const event of models.streamSimple(requestModel, context, options as never)) {
        if (event.type === "text_delta") {
          yield { type: "text-delta", text: event.delta };
        } else if (event.type === "toolcall_end") {
          yield { type: "tool-call", toolCall: { id: event.toolCall.id, name: event.toolCall.name, arguments: event.toolCall.arguments } };
        } else if (event.type === "done") {
          yield { type: "usage", usage: normalizeUsage(event.message) };
          yield { type: "done", stopReason: normalizeStopReason(event.reason) };
        } else if (event.type === "error") {
          yield { type: "error", message: event.error.errorMessage ?? "The model provider could not complete this request." };
        }
      }
    } catch (error) {
      yield { type: "error", message: error instanceof Error ? error.message : "The model provider could not complete this request." };
    }
  };
};

/** Build the compatibility text seam from the metadata-preserving provider path. */
export const createProviderComplete = (
  models: Models,
  opts: ProviderCompleteOptions,
  retryOpts: RetryOptions = {},
): ModelComplete => completeFromGenerate(createProviderGenerate(models, opts, retryOpts));

/**
 * Build a pi-ai Models runtime with the Anthropic builtin provider registered.
 * Reads ANTHROPIC_API_KEY from env at call time (pi-ai's envApiKeyAuth).
 */
export const createAnthropicModels = (): Models => {
  const models = createModels();
  models.setProvider(anthropicProvider());
  return models;
};

/**
 * Build a pi-ai Models runtime with the OpenAI builtin provider registered,
 * OR a custom OpenAI-compatible endpoint when baseUrl is provided (LM Studio,
 * Ollama, vLLM, llama.cpp, Azure, OpenRouter, etc.).
 *
 * CRITICAL: local OpenAI-compatible servers (LM Studio, Ollama, vLLM) speak the
 * CHAT COMPLETIONS API (/v1/chat/completions), NOT the Responses API (/v1/responses)
 * that real OpenAI uses. The builtin openaiProvider() stamps models with
 * api:"openai-responses" — which hangs/errors against a local server. So when a
 * custom baseUrl is present, we register a custom provider whose model uses
 * api:"openai-completions" and wire both lazy API implementations here at the
 * canonical model-owner boundary.
 */
export const createOpenAIModels = (opts: { baseUrl?: string; model?: string } = {}): Models => {
  const models = createModels();
  if (!opts.baseUrl) {
    // Real OpenAI — use the builtin provider (Responses API, full catalog).
    models.setProvider(openaiProvider());
    return models;
  }

  // Custom baseUrl → local OpenAI-compatible server. Register a provider with
  // the completions API (what local servers implement) + both lazy impls so
  // dispatch resolves regardless of which api the request model carries.
  const modelId = opts.model ?? process.env.OPENAI_MODEL ?? process.env.GITGECKO_LOCAL_MODEL ?? "local-model";
  const apiKeyAuth: ApiKeyAuth = {
    name: "OpenAI-compatible API key",
    resolve: async ({ credential }) =>
      credential?.key ? { auth: { apiKey: credential.key }, source: "stored credential" } : undefined,
  };
  const localModel = {
    id: modelId,
    name: modelId,
    api: "openai-completions" as const,
    provider: "openai",
    baseUrl: opts.baseUrl,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
  const provider = createProvider({
    id: "openai",
    name: "OpenAI-compatible server",
    baseUrl: opts.baseUrl,
    auth: { apiKey: apiKeyAuth },
    models: [localModel],
    api: {
      "openai-completions": openAICompletionsApi(),
      "openai-responses": openAIResponsesApi(),
    } as Partial<Record<string, ReturnType<typeof openAICompletionsApi>>>,
  });
  models.setProvider(provider);
  return models;
};

/** Constructor options (BYOK from env, overridable). */
export interface CompleteOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly protocol?: Extract<ModelProtocol, "openai-chat-completions" | "openai-responses">;
  /** Enable extended thinking (see ProviderCompleteOptions.reasoning). */
  readonly reasoning?: ThinkingLevel;
  /** Override the model's context window (GAP-D). */
  readonly contextWindow?: number;
  /** Override the model's max output tokens (GAP-D). */
  readonly maxTokens?: number;
  /** SDK-compatible transport override for validated cloud egress. */
  readonly fetch?: typeof globalThis.fetch;
}

/** Default model ids when the caller + env don't specify one. */
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5-20250514";
const DEFAULT_OPENAI_MODEL = "gpt-4o";

/** Environment values are operator input; blank dotenv values are omitted. */
const envValue = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value || undefined;
};

/**
 * Create an Anthropic-backed ModelComplete. BYOK: reads ANTHROPIC_API_KEY from
 * env unless overridden. The default model is claude-sonnet-4-5 unless env or
 * option sets another.
 */
export const createAnthropicGenerate = (opts: CompleteOptions = {}, retryOpts: RetryOptions = {}): ModelGenerate => {
  const models = createAnthropicModels();
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  // Conditionally include apiKey — exactOptionalPropertyTypes forbids undefined,
  // and ProviderCompleteOptions fields are readonly.
  return createProviderGenerate(models, {
    providerId: "anthropic",
    apiId: "anthropic-messages",
    modelId: opts.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
    ...(opts.baseUrl && { baseUrl: opts.baseUrl }),
    ...(apiKey && { apiKey }),
    ...(opts.reasoning && { reasoning: opts.reasoning }),
    ...(opts.contextWindow && { contextWindow: opts.contextWindow }),
    ...(opts.maxTokens && { maxTokens: opts.maxTokens }),
    ...(opts.fetch && { fetch: opts.fetch }),
  }, retryOpts);
};

/** Build an Anthropic-backed real stream using the same provider configuration as generation. */
export const createAnthropicStream = (opts: CompleteOptions = {}): ModelStream => {
  const models = createAnthropicModels();
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  return createProviderStream(models, {
    providerId: "anthropic",
    apiId: "anthropic-messages",
    modelId: opts.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
    ...(opts.baseUrl && { baseUrl: opts.baseUrl }),
    ...(apiKey && { apiKey }),
    ...(opts.reasoning && { reasoning: opts.reasoning }),
    ...(opts.contextWindow && { contextWindow: opts.contextWindow }),
    ...(opts.maxTokens && { maxTokens: opts.maxTokens }),
    ...(opts.fetch && { fetch: opts.fetch }),
  });
};

/** Anthropic compatibility wrapper for existing review callers. */
export const createAnthropicComplete = (opts: CompleteOptions = {}): ModelComplete =>
  completeFromGenerate(createAnthropicGenerate(opts));

/**
 * Create an OpenAI-backed ModelComplete. With no baseUrl → real OpenAI
 * (Responses API). With a baseUrl → local OpenAI-compatible endpoint (LM Studio,
 * Ollama, vLLM) which speaks the Chat Completions API. The API id is chosen
 * accordingly — see createOpenAIModels for why this matters.
 */
export const createOpenAIGenerate = (opts: CompleteOptions = {}, retryOpts: RetryOptions = {}): ModelGenerate => {
  const baseUrl = opts.baseUrl ?? process.env.OPENAI_BASE_URL;
  const models = createOpenAIModels({
    ...(baseUrl && { baseUrl }),
    ...(opts.model && { model: opts.model }),
  });
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
  return createProviderGenerate(models, {
    providerId: "openai",
    // Local endpoints → completions API; real OpenAI → responses API.
    apiId: opts.protocol === "openai-responses" || (!baseUrl && opts.protocol !== "openai-chat-completions")
      ? "openai-responses"
      : "openai-completions",
    modelId: opts.model ?? process.env.OPENAI_MODEL ?? process.env.GITGECKO_LOCAL_MODEL ?? DEFAULT_OPENAI_MODEL,
    ...(baseUrl && { baseUrl }),
    ...(apiKey && { apiKey }),
    ...(opts.fetch && { fetch: opts.fetch }),
  }, retryOpts);
};

/** Build an OpenAI-compatible real stream using the same provider configuration as generation. */
export const createOpenAIStream = (opts: CompleteOptions = {}): ModelStream => {
  const baseUrl = opts.baseUrl ?? process.env.OPENAI_BASE_URL;
  const models = createOpenAIModels({
    ...(baseUrl && { baseUrl }),
    ...(opts.model && { model: opts.model }),
  });
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
  return createProviderStream(models, {
    providerId: "openai",
    apiId: opts.protocol === "openai-responses" || (!baseUrl && opts.protocol !== "openai-chat-completions")
      ? "openai-responses"
      : "openai-completions",
    modelId: opts.model ?? process.env.OPENAI_MODEL ?? process.env.GITGECKO_LOCAL_MODEL ?? DEFAULT_OPENAI_MODEL,
    ...(baseUrl && { baseUrl }),
    ...(apiKey && { apiKey }),
    ...(opts.fetch && { fetch: opts.fetch }),
  });
};

/** OpenAI compatibility wrapper for existing review callers. */
export const createOpenAIComplete = (opts: CompleteOptions = {}): ModelComplete =>
  completeFromGenerate(createOpenAIGenerate(opts));

/** Canonical configuration for a local or operator-owned model endpoint. */
export interface LocalProviderOptions {
  readonly baseUrl: string;
  readonly model?: string;
  readonly apiKey?: string;
  /** SDK-compatible transport override forwarded through the patched pi-ai seam. */
  readonly fetch?: typeof globalThis.fetch;
  readonly protocol?: ModelProtocol;
}

/** Route a local/custom endpoint through the explicitly selected wire protocol. */
export const createLocalGenerate = (opts: LocalProviderOptions, retryOpts: RetryOptions = {}): ModelGenerate => {
  const protocol = opts.protocol ?? "openai-chat-completions";
  // Explicit local routing must never inherit an ambient cloud-provider key.
  // Pi-ai's OpenAI-compatible transport requires a non-empty client key, so
  // keyless servers receive a non-secret compatibility placeholder.
  const apiKey = opts.apiKey ?? envValue("GITGECKO_LOCAL_API_KEY") ?? "local";
  if (protocol === "anthropic-messages") {
    return createAnthropicGenerate({
      baseUrl: opts.baseUrl,
      apiKey,
      ...(opts.model && { model: opts.model }),
      ...(opts.fetch && { fetch: opts.fetch }),
    }, retryOpts);
  }
  return createOpenAIGenerate({
    baseUrl: opts.baseUrl,
    apiKey,
    protocol,
    ...(opts.model && { model: opts.model }),
    ...(opts.fetch && { fetch: opts.fetch }),
  });
};

/** Build a real local-provider stream through the selected compatible wire format. */
export const createLocalStream = (opts: LocalProviderOptions): ModelStream => {
  const protocol = opts.protocol ?? "openai-chat-completions";
  const apiKey = opts.apiKey ?? envValue("GITGECKO_LOCAL_API_KEY") ?? "local";
  if (protocol === "anthropic-messages") {
    return createAnthropicStream({
      baseUrl: opts.baseUrl,
      apiKey,
      ...(opts.model && { model: opts.model }),
      ...(opts.fetch && { fetch: opts.fetch }),
    });
  }
  return createOpenAIStream({
    baseUrl: opts.baseUrl,
    apiKey,
    protocol,
    ...(opts.model && { model: opts.model }),
    ...(opts.fetch && { fetch: opts.fetch }),
  });
};

/** Local-provider compatibility wrapper for existing review callers. */
export const createLocalComplete = (opts: LocalProviderOptions): ModelComplete =>
  completeFromGenerate(createLocalGenerate(opts));

/** The result of provider auto-detection. */
export interface AutoCompleteResult {
  readonly provider: "hosted" | "anthropic" | "openai" | "local";
  readonly capabilities: ModelCapabilities;
  readonly generate: ModelGenerate;
  readonly stream: ModelStream;
  readonly complete: ModelComplete;
}

export interface AutoCompleteOptions {
  readonly planId?: PlanId;
  /** Validated transport for the platform-owned hosted provider route. */
  readonly hostedFetch?: typeof globalThis.fetch;
  /** Explicitly bind provider selection to the running deployment plane. */
  readonly deploymentMode?: DeploymentMode;
  /** Explicit local routing supplied by a trusted caller such as the CLI config owner. */
  readonly localProvider?: {
    readonly baseUrl: string;
    readonly model?: string;
    readonly protocol?: ModelProtocol;
    readonly apiKey?: string;
    readonly fetch?: typeof globalThis.fetch;
  };
}

/** Keep provider selection and compatibility adaptation in one canonical branch. */
const autoCompleteResult = (
  provider: AutoCompleteResult["provider"],
  generate: ModelGenerate,
  stream: ModelStream,
  reasoning: boolean = false,
): AutoCompleteResult => ({
  provider,
  capabilities: { text: true, tools: true, reasoning, streaming: true },
  generate,
  stream,
  complete: completeFromGenerate(generate),
});

/**
 * Resolve the model provider for one deployment plane. Cloud is deliberately
 * hosted-only: operator-local endpoints and BYOK keys are local capabilities,
 * never an implicit fallback for authenticated customer traffic.
 *
 * This is the SINGLE source of truth for provider detection — the orchestrator
 * and the model plugs all go through here, replacing three scattered copies.
 */
export const createAutoComplete = (options: AutoCompleteOptions = {}): AutoCompleteResult => {
  const deploymentMode = options.deploymentMode ?? resolveDeploymentMode(process.env, "GITGECKO_DB_PATH");
  const hostedEnvironment = readHostedProviderEnvironment();
  const hostedKey = hostedEnvironment.apiKey;
  const hostedBaseUrl = hostedEnvironment.baseUrl;
  const hostedLightModel = hostedEnvironment.lightModel;
  const hostedHighModel = hostedEnvironment.highModel;
  const anthropicKey = envValue("ANTHROPIC_API_KEY");
  const openaiKey = envValue("OPENAI_API_KEY");
  const localBaseUrl = options.localProvider?.baseUrl.trim() || envValue("GITGECKO_LOCAL_BASE_URL");
  const openaiBaseUrl = envValue("OPENAI_BASE_URL");

  const hostedValues = [hostedKey, hostedBaseUrl, hostedLightModel, hostedHighModel];
  if (hostedValues.some(Boolean) && !hostedValues.every(Boolean)) {
    throw new Error(
      "Hosted model routing is incomplete. Set GITGECKO_CLOUD_MODEL_API_KEY, GITGECKO_CLOUD_MODEL_BASE_URL, " +
        "GITGECKO_CLOUD_LIGHT_MODEL, and GITGECKO_CLOUD_HIGH_MODEL together.",
    );
  }

  if (deploymentMode === "cloud") {
    if (!(hostedKey && hostedBaseUrl && hostedLightModel && hostedHighModel)) {
      throw new Error(
        "Cloud model routing is not configured. Set the four GITGECKO_CLOUD_MODEL_* provider variables before starting cloud mode.",
      );
    }
    const format = parseGitGeckoProviderFormat(hostedEnvironment.format);
    const hosted = {
      apiKey: hostedKey,
      baseUrl: hostedBaseUrl,
      lightModel: hostedLightModel,
      highModel: hostedHighModel,
      ...(options.planId && { planId: options.planId }),
      format,
      ...(options.hostedFetch ? { fetch: options.hostedFetch } : {}),
    };
    return autoCompleteResult("hosted", createHostedGenerate(hosted), createHostedStream(hosted), true);
  }

  // Explicit local configuration is an operator intent boundary: never let
  // ambient cloud credentials route a local review off-device.
  if (localBaseUrl) {
    const configured = options.localProvider?.protocol ?? envValue("GITGECKO_LOCAL_PROTOCOL");
    const protocol: ModelProtocol = configured === "openai-responses" || configured === "anthropic-messages"
      ? configured
      : "openai-chat-completions";
    const localApiKey = options.localProvider?.apiKey ?? envValue("GITGECKO_LOCAL_API_KEY");
    const localModel = options.localProvider?.model?.trim() || envValue("GITGECKO_LOCAL_MODEL");
    const local = {
      baseUrl: localBaseUrl,
      protocol,
      ...(localApiKey ? { apiKey: localApiKey } : {}),
      ...(localModel ? { model: localModel } : {}),
      ...(options.localProvider?.fetch ? { fetch: options.localProvider.fetch } : {}),
    };
    return autoCompleteResult("local", createLocalGenerate(local), createLocalStream(local));
  }

  if (hostedKey && hostedBaseUrl && hostedLightModel && hostedHighModel) {
    // Read the declared wire format and pass it through the matching provider
    // adapter. Unsupported values fail closed rather than silently changing
    // protocols.
    const format = parseGitGeckoProviderFormat(hostedEnvironment.format);
    const hosted = {
        apiKey: hostedKey,
        baseUrl: hostedBaseUrl,
        lightModel: hostedLightModel,
        highModel: hostedHighModel,
        ...(options.planId && { planId: options.planId }),
        format,
        ...(options.hostedFetch ? { fetch: options.hostedFetch } : {}),
      };
    return autoCompleteResult("hosted", createHostedGenerate(hosted), createHostedStream(hosted), true);
  }
  if (anthropicKey) {
    return autoCompleteResult("anthropic", createAnthropicGenerate({ apiKey: anthropicKey }), createAnthropicStream({ apiKey: anthropicKey }));
  }
  if (openaiKey) {
    const openai = {
        apiKey: openaiKey,
        ...(openaiBaseUrl && { baseUrl: openaiBaseUrl }),
      };
    return autoCompleteResult("openai", createOpenAIGenerate(openai), createOpenAIStream(openai));
  }
  if (openaiBaseUrl) {
    // Local OpenAI-compatible endpoint (LM Studio, Ollama) — no key required.
    const localModel = envValue("GITGECKO_LOCAL_MODEL");
    const local = {
        baseUrl: openaiBaseUrl,
        apiKey: "local",
        ...(localModel ? { model: localModel } : {}),
      };
    return autoCompleteResult("local", createOpenAIGenerate(local), createOpenAIStream(local));
  }

  throw new Error(
    "No model provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GITGECKO_LOCAL_BASE_URL.\n" +
      "Or install claude/codex/opencode for zero-config native agent usage.",
  );
};

/**
 * Build the first-party hosted completion adapter while preserving public aliases.
 *
 * GAP-E (resolved): extended thinking is enabled by default for the hosted route.
 * Empirical verification (2026-07-09) confirmed the configured hosted endpoint
 * accepts `thinking: { type: "enabled" }` and returns materially deeper analysis
 * (visible reasoning chain, multi-step draft refinement) vs. the terse output
 * when thinking is off. Reasoning depth is a load-bearing quality axis for code
 * review (the benchmark's reasoning-depth dimension), so the review pathway
 * opts in. The level defaults to "medium" — a balance of depth and cost — and
 * can be overridden via opts.reasoning or the GITGECKO_THINKING_LEVEL env var.
 *
 * GAP-C (resolved): the hosted adapter dispatches the declared wire format.
 * Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses are
 * explicit adapter paths. Unknown formats fail closed at construction time
 * rather than silently sending a different protocol.
 */
export const createHostedGenerate = (
  opts: {
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly lightModel: string;
    readonly highModel: string;
    readonly planId?: import("@gitgecko/plans").PlanId;
    /** Override the thinking level (default "medium"). Set to undefined to disable. */
    readonly reasoning?: ThinkingLevel;
    /**
     * The wire format the provider speaks (from GITGECKO_PROVIDER_FORMAT, default anthropic).
     * Each supported format dispatches to its corresponding adapter.
     */
    readonly format?: "completions" | "responses" | "anthropic";
    /** Validated cloud egress transport. */
    readonly fetch?: typeof globalThis.fetch;
  },
): ModelGenerate => {
  const format = opts.format ?? "anthropic";
  const planId = opts.planId ?? "free";
  const reasoning: ThinkingLevel | undefined = opts.reasoning ?? "medium";
  return async (prompt, alias = planId === "free" ? "gitgecko-light" : "gitgecko-high", generateOptions) => {
    const model = resolveHostedModel(alias, planId);
    const providerModel = model.alias === "gitgecko-light" ? opts.lightModel : opts.highModel;
    // GAP-D: resolve the env-configured limits for this tier so the request
    // model carries the configured backend ceiling (for example, a 1M context), not the
    // hardcoded 128K floor. This lets the pipeline fit larger review passes
    // in a single call when the backend supports it.
    const tier = model.alias === "gitgecko-light" ? "light" : "high";
    const limits = resolveGitGeckoModel(tier);

    // Dispatch to the adapter matching the declared wire format. The hosted
    // provider may speak anthropic (Messages API), completions (OpenAI Chat
    // Completions), or responses (OpenAI Responses API). Each format routes
    // through the corresponding pi-ai provider + API id.
    if (format === "anthropic") {
      const generate = createAnthropicGenerate({
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        model: providerModel,
        ...(reasoning && { reasoning }),
        contextWindow: limits.contextWindow,
        maxTokens: limits.maxTokens,
        ...(opts.fetch && { fetch: opts.fetch }),
      });
      return generate(prompt, undefined, generateOptions);
    }

    // OpenAI-compatible formats (completions + responses).
    const protocol = format === "responses" ? "openai-responses" : "openai-chat-completions";
    const generate = createOpenAIGenerate({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      model: providerModel,
      protocol,
      contextWindow: limits.contextWindow,
      maxTokens: limits.maxTokens,
      ...(opts.fetch && { fetch: opts.fetch }),
    });
    return generate(prompt, undefined, generateOptions);
  };
};

/** Build a real hosted stream while retaining the canonical public model boundary. */
export const createHostedStream = (
  opts: Parameters<typeof createHostedGenerate>[0],
): ModelStream => {
  const format = opts.format ?? "anthropic";
  const planId = opts.planId ?? "free";
  const reasoning: ThinkingLevel | undefined = opts.reasoning ?? "medium";
  return (prompt, alias = planId === "free" ? "gitgecko-light" : "gitgecko-high", streamOptions) => {
    const model = resolveHostedModel(alias, planId);
    const providerModel = model.alias === "gitgecko-light" ? opts.lightModel : opts.highModel;
    const tier = model.alias === "gitgecko-light" ? "light" : "high";
    const limits = resolveGitGeckoModel(tier);
    if (format === "anthropic") {
      return createAnthropicStream({
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        model: providerModel,
        ...(reasoning && { reasoning }),
        contextWindow: limits.contextWindow,
        maxTokens: limits.maxTokens,
        ...(opts.fetch && { fetch: opts.fetch }),
      })(prompt, undefined, streamOptions);
    }
    const protocol = format === "responses" ? "openai-responses" : "openai-chat-completions";
    return createOpenAIStream({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      model: providerModel,
      protocol,
      contextWindow: limits.contextWindow,
      maxTokens: limits.maxTokens,
      ...(opts.fetch && { fetch: opts.fetch }),
    })(prompt, undefined, streamOptions);
  };
};

/** Hosted-model compatibility wrapper for existing review callers. */
export const createHostedComplete = (
  opts: Parameters<typeof createHostedGenerate>[0],
): ModelComplete => completeFromGenerate(createHostedGenerate(opts));
