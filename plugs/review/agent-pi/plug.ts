/**
 * PI coding-agent peer runtime.
 *
 * Lifecycle and tool allowlisting are adapted from P-agent-runtime-1:
 * `.refs/03-agent-runtime/open-polsia-main/src/runtime/pi.ts` (MIT).
 * GitGecko keeps normalized conversation ownership; PI owns one SDK turn and
 * repository tools. This is distinct from the text-only model transport lane.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import { buildReviewPrompt, type Agent, type AgentBackendContribution, type AgentRunContext, type AgentResult, type LocalEndpointConfig, type NativeAgentFailure, type NativeAgentProviderPlug, type NativeAgentRuntimeProfile, type NativeAgentProviderConfig } from "@gitgecko/review";
import { hashProviderSchema, writeProviderProfile } from "@gitgecko/review/native-provider-runtime";
import type { CreateAgentSessionOptions, EditOperations, SessionManager, WriteOperations } from "@earendil-works/pi-coding-agent";
import manifestJson from "./plug.manifest.json" with { type: "json" };

const parsedManifest = parseManifest(manifestJson);
if (!parsedManifest.ok) throw new Error(`agent-pi manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
export const manifest: PlugManifest = parsedManifest.value;

export type PiToolName = "read" | "grep" | "find" | "ls" | "edit" | "write" | "bash";
export interface PiUsage { readonly input: number; readonly output: number; readonly cost: number }
export interface PiSessionEvent {
  readonly type?: string;
  readonly assistantMessageEvent?: { readonly type?: string; readonly delta?: string };
  readonly messages?: readonly PiTerminalMessage[];
}
export interface PiTerminalMessage {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly stopReason?: unknown;
  readonly errorMessage?: unknown;
}
export interface PiSession {
  readonly id: string;
  subscribe(listener: (event: PiSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  usage(): PiUsage | undefined;
}
export interface PiSessionOptions {
  readonly cwd: string;
  readonly systemPrompt: string;
  readonly tools: readonly PiToolName[];
  readonly config: LocalEndpointConfig;
  readonly sessionId: string;
  readonly conversation: NonNullable<AgentRunContext["conversation"]>;
}
export type PiSessionFactory = (options: PiSessionOptions) => Promise<PiSession>;

const READ_TOOLS = ["read", "grep", "find", "ls"] as const;
const WRITE_TOOLS = [...READ_TOOLS, "edit", "write"] as const;
const ALL_TOOLS = [...WRITE_TOOLS, "bash"] as const;
type PiSdkMessage = Parameters<SessionManager["appendMessage"]>[0];

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

const pathInside = (root: string, candidate: string): boolean => {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..\\") && !fromRoot.startsWith("../") && fromRoot !== ".." && !isAbsolute(fromRoot));
};

/** Resolve the nearest existing ancestor so symlinked directories cannot escape the repository root. */
const nearestExistingRealPath = async (candidate: string): Promise<string> => {
  let current = candidate;
  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
};

/** Fail before mutation unless both lexical and symlink-resolved paths remain under cwd. */
export const assertPiMutationPath = async (cwd: string, candidate: string): Promise<string> => {
  const lexicalRoot = resolve(cwd);
  const requested = resolve(candidate);
  if (!pathInside(lexicalRoot, requested)) throw new Error(`PI workspace-write denied path outside repository: ${candidate}`);
  const [canonicalRoot, canonicalAncestor] = await Promise.all([
    realpath(lexicalRoot),
    nearestExistingRealPath(requested),
  ]);
  if (!pathInside(canonicalRoot, canonicalAncestor)) throw new Error(`PI workspace-write denied symlink escape: ${candidate}`);
  return requested;
};

export interface PiMutationOperations {
  readonly edit: EditOperations;
  readonly write: WriteOperations;
}

/** Bind PI's pluggable mutation operations to one canonical repository root. */
export const createPiMutationOperations = (cwd: string): PiMutationOperations => ({
  edit: {
    readFile: async (path) => readFile(await assertPiMutationPath(cwd, path)),
    writeFile: async (path, content) => writeFile(await assertPiMutationPath(cwd, path), content, "utf8"),
    access: async (path) => access(await assertPiMutationPath(cwd, path), constants.R_OK | constants.W_OK),
  },
  write: {
    mkdir: async (path) => { await mkdir(await assertPiMutationPath(cwd, path), { recursive: true }); },
    writeFile: async (path, content) => writeFile(await assertPiMutationPath(cwd, path), content, "utf8"),
  },
});

/** Rehydrate GitGecko-owned turns into a fresh in-memory PI session. */
export const seedPiConversation = (
  sessionManager: Pick<SessionManager, "appendMessage">,
  conversation: NonNullable<AgentRunContext["conversation"]>,
  model: Pick<LocalEndpointConfig, "modelId" | "protocol">,
): void => {
  for (const turn of conversation) {
    const timestamp = Number.isFinite(Date.parse(turn.at)) ? Date.parse(turn.at) : Date.now();
    const message: PiSdkMessage = turn.role === "user"
      ? { role: "user", content: turn.text, timestamp }
      : {
          role: "assistant",
          content: [{ type: "text", text: turn.text }],
          api: protocolApi(model.protocol),
          provider: "gitgecko-local",
          model: model.modelId,
          usage: emptyUsage,
          stopReason: "stop",
          timestamp,
        };
    sessionManager.appendMessage(message);
  }
};

/** Derive the SDK allowlist from the owner policy, then apply owner-provided denials. */
export const resolvePiTools = (ctx: Pick<AgentRunContext, "permission" | "subagentDeniedTools">): readonly PiToolName[] => {
  const source = ctx.permission === "unrestricted" ? ALL_TOOLS : ctx.permission === "workspace-write" ? WRITE_TOOLS : READ_TOOLS;
  const denied = new Set((ctx.subagentDeniedTools ?? []).map((tool) => tool.toLowerCase()));
  return source.filter((tool) => !denied.has(tool));
};

const protocolApi = (protocol: LocalEndpointConfig["protocol"]): "openai-completions" | "openai-responses" | "anthropic-messages" =>
  protocol === "openai-responses" ? "openai-responses" : protocol === "anthropic-messages" ? "anthropic-messages" : "openai-completions";

/** Create a real PI SDK session while suppressing ambient extensions, skills, and context files. */
export const createRealPiSession: PiSessionFactory = async (options) => {
  const { AuthStorage, DefaultResourceLoader, ModelRegistry, SessionManager, createAgentSession, createEditToolDefinition, createWriteToolDefinition } = await import("@earendil-works/pi-coding-agent");
  const provider = "gitgecko-local";
  const authStorage = AuthStorage.inMemory({ [provider]: { type: "api_key", key: options.config.apiKey ?? "local" } });
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const model = {
    id: options.config.modelId,
    name: options.config.modelId,
    api: protocolApi(options.config.protocol),
    provider,
    baseUrl: options.config.baseUrl,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
  const agentDir = join(homedir(), ".gitgecko", "pi");
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    systemPrompt: options.systemPrompt,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  const sessionManager = SessionManager.inMemory(options.cwd, { id: options.sessionId });
  seedPiConversation(sessionManager, options.conversation, options.config);
  const mutationOperations = createPiMutationOperations(options.cwd);
  // The SDK's heterogeneous ToolDefinition array is invariant in each tool's
  // argument schema; erase those schemas only at its exported registration boundary.
  const customTools = [
    ...(options.tools.includes("edit") ? [createEditToolDefinition(options.cwd, { operations: mutationOperations.edit })] : []),
    ...(options.tools.includes("write") ? [createWriteToolDefinition(options.cwd, { operations: mutationOperations.write })] : []),
  ] as unknown as NonNullable<CreateAgentSessionOptions["customTools"]>;
  const { session } = await createAgentSession({
    cwd: options.cwd,
    model,
    authStorage,
    modelRegistry,
    sessionManager,
    resourceLoader,
    tools: [...options.tools],
    customTools,
  });
  return {
    id: sessionManager.getSessionId(),
    subscribe: (listener) => session.subscribe(listener),
    prompt: (text) => session.prompt(text, { expandPromptTemplates: false, source: "rpc" }),
    abort: () => session.abort(),
    dispose: () => session.dispose(),
    usage: () => {
      const stats = session.getSessionStats();
      return { input: stats.tokens.input, output: stats.tokens.output, cost: stats.cost };
    },
  };
};

const classifyPiFailure = (error: unknown, aborted: boolean): NativeAgentFailure => {
  if (aborted) return "cancelled";
  const message = error instanceof Error ? error.message : String(error);
  if (/401|403|api key|auth|unauthorized/iu.test(message)) return "auth";
  if (/permission|denied|forbidden/iu.test(message)) return "permission";
  if (/model|provider|endpoint|network|fetch/iu.test(message)) return "provider";
  return "provider";
};

/** Read terminal PI messages so non-streaming and evolved provider envelopes still return a truthful result. */
const readPiTerminalMessage = (event: PiSessionEvent): { readonly text: string; readonly error?: string } | undefined => {
  if (event.type !== "agent_end" || !event.messages) return undefined;
  const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
  if (!assistant) return undefined;
  const text = typeof assistant.content === "string"
    ? assistant.content
    : Array.isArray(assistant.content)
      ? assistant.content.map((block) => {
        if (!block || typeof block !== "object") return "";
        const value = (block as Readonly<Record<string, unknown>>).text;
        return typeof value === "string" ? value : "";
      }).join("")
      : "";
  const error = typeof assistant.errorMessage === "string" && assistant.errorMessage.trim()
    ? assistant.errorMessage
    : assistant.stopReason === "error" ? "PI provider ended the turn with an error" : undefined;
  return { text, ...(error ? { error } : {}) };
};

/** Construct the PI peer Agent through an injectable SDK lifecycle boundary. */
export const createPiAgent = (config: LocalEndpointConfig, createSession: PiSessionFactory = createRealPiSession): Agent => ({
  name: "pi",
  install: async () => `pi coding-agent: ${config.modelId} @ ${new URL(config.baseUrl).origin}`,
  run: async (ctx): Promise<AgentResult> => {
    if (ctx.signal?.aborted) return { success: false, error: "PI turn cancelled before start", failure: "cancelled" };
    ctx.onActivity?.({ phase: "starting", provider: "pi", message: "Starting Pi", at: new Date().toISOString() });
    const sessionId = ctx.providerThreadId ?? `pi_${randomUUID()}`;
    let session: PiSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let output = "";
    let terminalError: string | undefined;
    let aborted = false;
    const abort = () => {
      aborted = true;
      if (session) void session.abort();
    };
    try {
      session = await createSession({
        cwd: ctx.cwd,
        systemPrompt: ctx.instructions.persona ? `${ctx.instructions.persona}\n\n${ctx.instructions.systemPrompt}` : ctx.instructions.systemPrompt,
        tools: resolvePiTools(ctx),
        config,
        sessionId,
        conversation: ctx.conversation ?? [],
      });
      unsubscribe = session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          if (!output) ctx.onActivity?.({ phase: "thinking", provider: "pi", message: "Pi is reviewing the repository", at: new Date().toISOString() });
          output += event.assistantMessageEvent.delta ?? "";
        }
        const terminal = readPiTerminalMessage(event);
        if (!terminal) return;
        if (!output && terminal.text) output = terminal.text;
        terminalError = terminal.error;
      });
      ctx.signal?.addEventListener("abort", abort, { once: true });
      await session.prompt(buildReviewPrompt(ctx));
      if (aborted) return { success: false, error: "PI turn cancelled", failure: "cancelled", providerThreadId: session.id };
      if (terminalError) return { success: false, error: terminalError, failure: classifyPiFailure(new Error(terminalError), false), providerThreadId: session.id };
      if (!output.trim()) return { success: false, error: "PI returned no assistant text", failure: "malformed-output", providerThreadId: session.id };
      const reported = session.usage();
      ctx.toolState.calls.push({ tool: "pi.session", input: { model: config.modelId, tools: resolvePiTools(ctx) }, result: output.slice(0, 200) });
      ctx.onToolUse?.({ tool: "pi.session", input: { model: config.modelId } });
      ctx.onActivity?.({ phase: "completed", provider: "pi", message: "Pi review completed", at: new Date().toISOString() });
      return {
        success: true,
        output,
        ...(ctx.persistence === "thread" ? { providerThreadId: session.id } : {}),
        ...(reported ? { usage: { tokensIn: reported.input, tokensOut: reported.output, costUsd: reported.cost } } : {}),
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), failure: classifyPiFailure(error, aborted), ...(session && { providerThreadId: session.id }) };
    } finally {
      ctx.signal?.removeEventListener("abort", abort);
      unsubscribe?.();
      session?.dispose();
    }
  },
});

type PiProtocol = NonNullable<LocalEndpointConfig["protocol"]>;

const PI_PROTOCOLS = new Set<PiProtocol>([
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
]);

/** Parse only the endpoint values owned by the PI backend contribution. */
export const readPiConfig = (config: object): LocalEndpointConfig | undefined => {
  const source = config as Readonly<Record<string, unknown>>;
  const baseUrl = source.baseUrl;
  const modelId = source.modelId;
  const protocol = source.protocol;
  if (typeof baseUrl !== "string" || typeof modelId !== "string" || typeof protocol !== "string") return undefined;
  if (!baseUrl.trim() || !modelId.trim() || !PI_PROTOCOLS.has(protocol as PiProtocol)) return undefined;
  try {
    new URL(baseUrl);
  } catch {
    return undefined;
  }
  return {
    baseUrl,
    modelId,
    protocol: protocol as PiProtocol,
    ...(typeof source.apiKey === "string" && source.apiKey ? { apiKey: source.apiKey } : {}),
  };
};

const unavailablePiAgent: Agent = {
  name: "pi",
  install: async () => "pi coding-agent: endpoint not configured",
  run: async () => ({ success: false, error: "PI requires baseUrl, modelId, and protocol configuration", failure: "invalid-arguments" }),
};

/** Register PI beside the native CLI backends while keeping endpoint selection request-scoped. */
export async function setup(api: {
  register: (capability: "agent-backend", contribution: AgentBackendContribution) => void;
  readonly ctx: { readonly config: Readonly<Record<string, unknown>> };
}): Promise<void> {
  const configured = readPiConfig(api.ctx.config);
  api.register("agent-backend", {
    kind: "agent-backend",
    id: "pi-agent",
    agent: configured ? createPiAgent(configured) : unavailablePiAgent,
    create: (config) => {
      const parsed = readPiConfig(config);
      return parsed ? createPiAgent(parsed) : unavailablePiAgent;
    },
    mutates: false,
  });
}

const providerConfigToPi = (config?: NativeAgentProviderConfig): LocalEndpointConfig => {
  if (!(config?.baseUrl && config.model)) throw new Error("Pi requires baseUrl and model configuration.");
  return { baseUrl: config.baseUrl, modelId: config.model, protocol: config.protocol === "anthropic-messages" ? "anthropic-messages" : config.protocol === "openai-responses" ? "openai-responses" : "openai-chat-completions", ...(config.apiKey ? { apiKey: config.apiKey } : {}) };
};

export const createNativeAgentProviderPlug = (): NativeAgentProviderPlug => ({
  id: "pi", manifest, preference: 3,
  probe: () => ({ installed: true, executable: "@earendil-works/pi-coding-agent", version: "0.80.3" }),
  // Pi capability shape follows the selected endpoint/model, but credentials
  // are intentionally excluded from the cache key and are never persisted.
  profileKey: (config) => ({ baseUrl: config?.baseUrl ?? null, model: config?.model ?? null, protocol: config?.protocol ?? null }),
  discoverCapabilities: async (config): Promise<NativeAgentRuntimeProfile> => {
    const rawSchema = { sdk: "@earendil-works/pi-coding-agent", protocol: config?.protocol ?? "openai-chat-completions", model: config?.model ?? null, baseUrlConfigured: Boolean(config?.baseUrl) };
    const profile: NativeAgentRuntimeProfile = { schemaVersion: "native-agent-runtime.v1", provider: "pi", providerVersion: "0.80.3", executable: "@earendil-works/pi-coding-agent", schemaHash: hashProviderSchema(rawSchema), rawSchema, capabilities: { cwd: true, permissions: ["read-only", "workspace-write", "unrestricted"], ephemeral: true, threads: true, resume: true, cancellation: true, activity: true, usage: true, schemaDiscovery: false } };
    writeProviderProfile(profile); return profile;
  },
  create: (config) => createPiAgent(providerConfigToPi(config)),
});
export const providerPlug = createNativeAgentProviderPlug();

export const createAgent = createPiAgent;
