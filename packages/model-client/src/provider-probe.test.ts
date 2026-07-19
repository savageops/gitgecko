import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ModelGenerate } from "./model-client.js";
import { probeLocalProvider } from "./provider-probe.js";

const provider = {
  baseUrl: "http://127.0.0.1:1234/v1",
  model: "local-model",
  protocol: "openai-chat-completions" as const,
};

describe("local provider probe", () => {
  it("runs one bounded inference without exposing response content", async () => {
    let calls = 0;
    const generate: ModelGenerate = async (prompt, model, options) => {
      calls += 1;
      assert.equal(prompt, "Reply with exactly OK.");
      assert.equal(model, "local-model");
      assert.equal(options?.maxOutputTokens, 1);
      assert.equal(options?.temperature, 0);
      assert.equal(options?.timeoutMs, 5_000);
      assert.equal(options?.maxRetries, 0);
      assert.ok(options?.signal);
      return {
        text: "OK",
        stopReason: "stop",
        usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
      };
    };

    const result = await probeLocalProvider(provider, { generate });

    assert.equal(calls, 1);
    assert.equal(result.status, "ready");
    assert.equal(result.reachable, true);
    assert.equal("text" in result, false);
    assert.ok(result.latencyMs >= 0);
  });

  it("classifies timeout, authentication, model, and transport failures", async () => {
    const failure = async (error: Error) => probeLocalProvider(provider, {
      generate: async () => { throw error; },
    });
    const timeout = new Error("request timed out");
    timeout.name = "AbortError";

    assert.equal((await failure(timeout)).status, "timeout");
    assert.equal((await failure(new Error("401 unauthorized"))).status, "authentication");
    assert.equal((await failure(new Error("model not found"))).status, "model");
    assert.equal((await failure(new Error("fetch failed"))).status, "unreachable");
  });

  it("rejects oversized or empty provider output as an invalid response", async () => {
    const response = (text: string): ModelGenerate => async () => ({
      text,
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });

    assert.equal((await probeLocalProvider(provider, { generate: response("") })).status, "invalid_response");
    assert.equal((await probeLocalProvider(provider, { generate: response("x".repeat(65_537)) })).status, "invalid_response");
  });

  it("aborts at the configured deadline", async () => {
    const generate: ModelGenerate = async (_prompt, _model, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => {
        const error = new Error("probe timed out");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });

    const startedAt = Date.now();
    const result = await probeLocalProvider(provider, { generate, timeoutMs: 10 });

    assert.equal(result.status, "timeout");
    assert.ok(Date.now() - startedAt < 500);
  });
});
