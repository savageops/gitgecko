import { Buffer } from "node:buffer";

import { createLocalGenerate, type LocalProviderOptions, type ModelGenerate } from "./model-client.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export type ProviderProbeStatus =
  | "ready"
  | "timeout"
  | "authentication"
  | "model"
  | "unreachable"
  | "invalid_response";

export interface ProviderProbeResult {
  readonly reachable: boolean;
  readonly status: ProviderProbeStatus;
  readonly latencyMs: number;
  readonly error?: string;
}

interface ProviderProbeDependencies {
  readonly generate?: ModelGenerate;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/** Verify actual inference through pi-ai while returning no provider content or credentials. */
export async function probeLocalProvider(
  provider: LocalProviderOptions,
  dependencies: ProviderProbeDependencies = {},
): Promise<ProviderProbeResult> {
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    throw new Error(`provider probe timeout must be between 1 and ${DEFAULT_TIMEOUT_MS}ms`);
  }
  const generate = dependencies.generate ?? createLocalGenerate(provider, { maxAttempts: 1 });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  try {
    const response = await generate("Reply with exactly OK.", provider.model, {
      maxOutputTokens: 1,
      temperature: 0,
      signal: controller.signal,
      timeoutMs,
      maxRetries: 0,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    });
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    const size = Buffer.byteLength(response.text, "utf8");
    if (size === 0 || size > MAX_RESPONSE_BYTES || response.stopReason === "error") {
      return { reachable: false, status: "invalid_response", latencyMs, error: "provider returned an invalid diagnostic response" };
    }
    return { reachable: true, status: "ready", latencyMs };
  } catch (error) {
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    const name = error instanceof Error ? error.name : "";
    if (controller.signal.aborted || name === "AbortError" || message.includes("timed out") || message.includes("timeout")) {
      return { reachable: false, status: "timeout", latencyMs, error: "provider did not respond before the diagnostic deadline" };
    }
    if (/\b(401|403)\b/.test(message) || message.includes("unauthorized") || message.includes("forbidden") || message.includes("api key")) {
      return { reachable: false, status: "authentication", latencyMs, error: "provider rejected the configured credential" };
    }
    if (message.includes("model") && (message.includes("not found") || message.includes("unknown") || message.includes("invalid"))) {
      return { reachable: false, status: "model", latencyMs, error: "provider does not expose the configured model" };
    }
    return { reachable: false, status: "unreachable", latencyMs, error: "provider inference is unreachable" };
  } finally {
    clearTimeout(timeout);
  }
}
