/** Provider-neutral function tool declaration. Execution remains the caller's responsibility. */
export interface ModelToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** Provider-neutral tool invocation returned by a model. Execution is caller-owned. */
export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** Normalized roles accepted across the three public text protocols. */
export type ModelRole = "system" | "user" | "assistant" | "tool";

/** A text, tool-call, or tool-result turn preserved across the public protocols. */
export interface ModelMessage {
  readonly role: ModelRole;
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ModelToolCall[];
}

/** Public model request before protocol-specific encoding. */
export interface ModelRequest {
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly stream: boolean;
  readonly tools: readonly ModelToolDefinition[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
}

/** Token accounting returned by an adapter when the provider supplies it. */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

export type ModelStopReason = "stop" | "length" | "tool_use" | "error";

/** Provider-neutral completed response. */
export interface ModelResponse {
  readonly id: string;
  readonly model: string;
  readonly text: string;
  readonly toolCalls?: readonly ModelToolCall[];
  readonly stopReason: ModelStopReason;
  readonly usage?: ModelUsage;
}

/** Events emitted only by adapters that support real upstream streaming. */
export type ModelStreamEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "tool-call"; readonly toolCall: ModelToolCall }
  | { readonly type: "usage"; readonly usage: ModelUsage }
  | { readonly type: "done"; readonly stopReason: ModelStopReason }
  | { readonly type: "error"; readonly message: string };

/** Stable normalized provider failure used before protocol-specific encoding. */
export interface ModelProtocolError {
  readonly code: "invalid_request" | "unsupported_capability" | "model_not_found" | "rate_limit" | "provider_error" | "model_access_denied" | "payment_required";
  readonly message: string;
  readonly retryable: boolean;
}
