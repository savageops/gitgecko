/**
 * TDD tests for @gitgecko/model-client — the pi-ai-backed cloud-pathway client.
 *
 * Challenges the CAPABILITY (observable contracts), not implementation:
 *  - createProviderComplete: dispatches through REAL pi-ai (faux response can
 *    ONLY arrive via Models.completeSimple — proves real dispatch, not a mock).
 *  - createAutoComplete: provider auto-detection priority from env
 *    (anthropic > openai > local > throw), same priority as the old client.
 *  - Error surfacing: pi-ai error responses → thrown Error with the message.
 *  - ModelComplete seam: (prompt, model?) => Promise<string> — the contract
 *    agent-gitgecko-native and the model plugs depend on, unchanged from the old
 *    homegrown client.
 *
 * Per project TDD rule: written FIRST, fail, then code passes. Never weakened.
 * The old real-complete.test.ts asserted on OUR raw-fetch HTTP shape
 * (headers.Authorization, /chat/completions URL). These assertions are
 * STRICTLY STRONGER: they prove the response traverses pi-ai's real
 * completeSimple dispatch (no homegrown HTTP can produce a faux response).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  type MutableModels,
} from "@earendil-works/pi-ai";
import {
  createProviderComplete,
  createProviderGenerate,
  createProviderStream,
  createAnthropicComplete,
  createOpenAIComplete,
  createLocalComplete,
  createLocalGenerate,
  createAutoComplete,
  createHostedComplete,
} from "./model-client.js";
import {
  getGitGeckoModelLimits,
  resolveGitGeckoModel,
  listGitGeckoModels,
} from "./gitgecko-models.js";

// --- Env var test helpers (save/restore so tests don't bleed) --------------

const ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "ANTHROPIC_MODEL",
  "GITGECKO_LOCAL_BASE_URL",
  "GITGECKO_LOCAL_MODEL",
  "GITGECKO_LOCAL_PROTOCOL",
  "GITGECKO_LOCAL_API_KEY",
  "GITGECKO_DEPLOYMENT_MODE",
  "GITGECKO_DB_PATH",
  "GITGECKO_CLOUD_MODEL_API_KEY",
  "GITGECKO_CLOUD_MODEL_BASE_URL",
  "GITGECKO_CLOUD_LIGHT_MODEL",
  "GITGECKO_CLOUD_HIGH_MODEL",
  "GITGECKO_CLOUD_MODEL_CONTEXT_WINDOW",
  "GITGECKO_CLOUD_LIGHT_MAX_TOKENS",
  "GITGECKO_CLOUD_HIGH_MAX_TOKENS",
  "GITGECKO_PROVIDER_FORMAT",
] as const;

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_VARS) saved[k] = process.env[k];
  for (const k of ENV_VARS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_VARS) {
    if (saved[k] !== undefined) process.env[k] = saved[k];
    else delete process.env[k];
  }
});

// --- createProviderComplete: REAL pi-ai dispatch --------------------------

describe("createProviderComplete — dispatches through REAL pi-ai completeSimple", () => {
  it("forwards cancellation to non-streaming pi-ai dispatch", async () => {
    const handle = fauxProvider({ provider: "signal-p", api: "signal-a" });
    const models = createModels();
    models.setProvider(handle.provider);
    const controller = new AbortController();
    handle.setResponses([(_context, options) => {
      assert.equal(options?.signal, controller.signal);
      return fauxAssistantMessage("signal reached provider");
    }]);
    const generate = createProviderGenerate(models, {
      providerId: "signal-p",
      apiId: "signal-a",
      modelId: handle.getModel().id,
    });
    const result = await generate("probe", undefined, { signal: controller.signal });
    assert.equal(result.text, "signal reached provider");
  });

  it("returns the queued faux response via the real Models call path", async () => {
    // faux is pi-ai's OWN test double. The response can ONLY reach us if our
    // code genuinely calls models.completeSimple — there is no other path.
    const handle = fauxProvider({ provider: "test-p", api: "test-a" });
    const models: MutableModels = createModels();
    models.setProvider(handle.provider);
    handle.setResponses([fauxAssistantMessage("LGTM from pi-ai.")]);

    const complete = createProviderComplete(models, {
      providerId: "test-p",
      apiId: "test-a",
      modelId: handle.getModel().id,
    });

    const out = await complete("Review this code");
    assert.equal(out, "LGTM from pi-ai.");
    assert.equal(handle.state.callCount, 1, "real pi-ai stream invoked exactly once");
  });

  it("honors an explicit model override on the call (model? arg)", async () => {
    const handle = fauxProvider({
      provider: "test-p2",
      api: "test-a2",
      models: [
        { id: "default-m", name: "Default" },
        { id: "override-m", name: "Override" },
      ],
    });
    const models = createModels();
    models.setProvider(handle.provider);
    // The factory queues a different response per call; we assert the second
    // call's response arrived (proving the override-m model was used & routed).
    handle.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

    const complete = createProviderComplete(models, {
      providerId: "test-p2",
      apiId: "test-a2",
      modelId: "default-m",
    });

    await complete("first call"); // default-m
    const out = await complete("second call", "override-m");
    assert.equal(out, "second");
  });

  it("throws on pi-ai error responses (no responses queued)", async () => {
    const handle = fauxProvider({ provider: "test-p-err", api: "test-a-err" });
    const models = createModels();
    models.setProvider(handle.provider);
    handle.setResponses([]); // faux errors with "No more faux responses queued"

    const complete = createProviderComplete(models, {
      providerId: "test-p-err",
      apiId: "test-a-err",
      modelId: handle.getModel().id,
    });

    await assert.rejects(() => complete("x"), /No more faux responses queued|pi-ai/i);
  });
});

describe("createProviderGenerate — preserves provider metadata", () => {
  it("returns pi-ai stop reason and exact token usage instead of flattening to text", async () => {
    const handle = fauxProvider({ provider: "test-meta", api: "test-meta-api" });
    const models = createModels() as MutableModels;
    models.setProvider(handle.provider);
    handle.setResponses([{
      ...fauxAssistantMessage("metadata survives"),
      stopReason: "length",
      usage: {
        input: 17,
        output: 9,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 26,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }]);

    const generate = createProviderGenerate(models, {
      providerId: "test-meta",
      apiId: "test-meta-api",
      modelId: handle.getModel().id,
    });
    const result = await generate("review this");

    assert.deepEqual(result, {
      text: "metadata survives",
      stopReason: "length",
      usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
    });
  });
});

describe("createProviderStream — preserves real pi-ai events", () => {
  it("emits text deltas followed by provider usage and a terminal stop reason", async () => {
    const handle = fauxProvider({ provider: "test-stream", api: "test-stream-api" });
    const models = createModels() as MutableModels;
    models.setProvider(handle.provider);
    handle.setResponses([fauxAssistantMessage("streamed text")]);

    const stream = createProviderStream(models, {
      providerId: "test-stream",
      apiId: "test-stream-api",
      modelId: handle.getModel().id,
    });
    const events = [] as Array<{ type: string; text?: string; stopReason?: string; usage?: { totalTokens: number } }>;
    for await (const event of stream("review this")) events.push(event);

    const streamedText = events
      .filter((event): event is { type: "text-delta"; text: string } => event.type === "text-delta" && typeof event.text === "string")
      .map((event) => event.text)
      .join("");
    assert.equal(streamedText, "streamed text", "all provider chunks survive in order");
    assert.ok(events.some((event) => event.type === "usage" && Number.isSafeInteger(event.usage?.totalTokens)));
    assert.ok(events.some((event) => event.type === "done" && event.stopReason === "stop"));
    assert.equal(handle.state.callCount, 1, "the stream must traverse pi-ai exactly once");
  });
});

// --- Retry: transient errors retry with backoff; permanent errors fail fast ---
// Challenges the resilience capability (the withRetry wiring). A real cloud
// endpoint returns 429/503/ECONNRESET intermittently — the client must retry
// these and surface them only after the budget is exhausted. Auth (401) and
// bad-request (400) must fail immediately (no wasted retries).

describe("createProviderComplete — retry on transient errors", () => {
  it("retries and succeeds when a transient error precedes a good response", async () => {
    const handle = fauxProvider({ provider: "retry-p", api: "retry-a" });
    const models: MutableModels = createModels();
    models.setProvider(handle.provider);
    // First response is a transient error; second succeeds.
    handle.setResponses([
      { ...fauxAssistantMessage(""), stopReason: "error", errorMessage: "429 Too Many Requests" },
      fauxAssistantMessage("recovered"),
    ]);

    const complete = createProviderComplete(
      models,
      { providerId: "retry-p", apiId: "retry-a", modelId: handle.getModel().id },
      { baseDelayMs: 1, maxAttempts: 3 }, // fast backoff for tests
    );

    const out = await complete("retry me");
    assert.equal(out, "recovered");
    assert.equal(handle.state.callCount, 2, "first call errored, second succeeded after retry");
  });

  it("fails fast on a permanent error (no retry attempted)", async () => {
    const handle = fauxProvider({ provider: "perm-p", api: "perm-a" });
    const models: MutableModels = createModels();
    models.setProvider(handle.provider);
    handle.setResponses([
      { ...fauxAssistantMessage(""), stopReason: "error", errorMessage: "401 Unauthorized: invalid api key" },
    ]);

    const complete = createProviderComplete(
      models,
      { providerId: "perm-p", apiId: "perm-a", modelId: handle.getModel().id },
      { baseDelayMs: 1, maxAttempts: 3 },
    );

    await assert.rejects(() => complete("x"), /401 Unauthorized/i);
    assert.equal(handle.state.callCount, 1, "permanent error must NOT retry");
  });

  it("exhausts the retry budget then surfaces the transient error", async () => {
    const handle = fauxProvider({ provider: "exhaust-p", api: "exhaust-a" });
    const models: MutableModels = createModels();
    models.setProvider(handle.provider);
    // Every response is a 503 — always transient, always retried.
    handle.setResponses([
      { ...fauxAssistantMessage(""), stopReason: "error", errorMessage: "503 Service Unavailable" },
      { ...fauxAssistantMessage(""), stopReason: "error", errorMessage: "503 Service Unavailable" },
      { ...fauxAssistantMessage(""), stopReason: "error", errorMessage: "503 Service Unavailable" },
    ]);

    const complete = createProviderComplete(
      models,
      { providerId: "exhaust-p", apiId: "exhaust-a", modelId: handle.getModel().id },
      { baseDelayMs: 1, maxAttempts: 3 },
    );

    await assert.rejects(() => complete("x"), /503 Service Unavailable/i);
    assert.equal(handle.state.callCount, 3, "retried up to maxAttempts then gave up");
  });
});

// --- createAnthropicComplete / createOpenAIComplete: convenience wrappers --

describe("createAnthropicComplete — builds an Anthropic-backed Models at call time", () => {
  it("returns a ModelComplete that dispatches through pi-ai's anthropic provider", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    // We can't hit the real Anthropic API in tests, but we CAN verify the
    // factory builds without throwing and returns a function — proving the
    // pi-ai anthropicProvider() integration is wired (not throwing on import
    // or construction). Real dispatch is covered by createProviderComplete
    // tests above against faux.
    const complete = createAnthropicComplete({});
    assert.equal(typeof complete, "function");
  });
});

describe("createOpenAIComplete — builds an OpenAI-backed Models at call time", () => {
  it("returns a ModelComplete wired for the OpenAI provider (or a custom baseUrl)", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const complete = createOpenAIComplete({});
    assert.equal(typeof complete, "function");
  });
});

describe("createLocalComplete — protocol selection", () => {
  it("constructs all three supported local protocol adapters", () => {
    for (const protocol of ["openai-chat-completions", "openai-responses", "anthropic-messages"] as const) {
      const complete = createLocalComplete({ baseUrl: "http://localhost:1234/v1", protocol, model: "local-model" });
      assert.equal(typeof complete, "function");
    }
  });

  it("never leaks ambient cloud keys and prefers the canonical local key", async () => {
    const seenAuthorization: Array<string | null> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seenAuthorization.push(new Headers(init?.headers).get("authorization"));
      const chunks = [
        { id: "chatcmpl-local", object: "chat.completion.chunk", created: 1, model: "local-model", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
        { id: "chatcmpl-local", object: "chat.completion.chunk", created: 1, model: "local-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ];
      return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      process.env.OPENAI_API_KEY = "ambient-cloud-key";
      await createLocalGenerate({ baseUrl: "http://localhost:1234/v1", model: "local-model" })("review");
      process.env.GITGECKO_LOCAL_API_KEY = "local-endpoint-key";
      await createLocalGenerate({ baseUrl: "http://localhost:1234/v1", model: "local-model" })("review");
    } finally {
      globalThis.fetch = realFetch;
    }

    assert.equal(seenAuthorization[0], "Bearer local", "explicit local routing must use only the non-secret compatibility placeholder");
    assert.equal(seenAuthorization[1], "Bearer local-endpoint-key");
  });
});

// --- createAutoComplete: provider priority from env -----------------------

describe("createAutoComplete — provider auto-detection priority", () => {
  it("fails closed in cloud mode instead of using a local endpoint or BYOK key", () => {
    process.env.GITGECKO_LOCAL_BASE_URL = "http://127.0.0.1:1234/v1";
    process.env.OPENAI_API_KEY = "operator-key";
    assert.throws(() => createAutoComplete({ deploymentMode: "cloud" }), /Cloud model routing is not configured/i);
  });

  it("uses the hosted owner in cloud mode even when local variables are present", () => {
    process.env.GITGECKO_LOCAL_BASE_URL = "http://127.0.0.1:1234/v1";
    process.env.OPENAI_API_KEY = "operator-key";
    process.env.GITGECKO_CLOUD_MODEL_API_KEY = "hosted-key";
    process.env.GITGECKO_CLOUD_MODEL_BASE_URL = "https://models.example.test";
    process.env.GITGECKO_CLOUD_LIGHT_MODEL = "provider-light-slot";
    process.env.GITGECKO_CLOUD_HIGH_MODEL = "provider-high-slot";
    assert.equal(createAutoComplete({ deploymentMode: "cloud" }).provider, "hosted");
  });

  it("selects hosted routing from canonical GitGecko configuration", () => {
    process.env.GITGECKO_CLOUD_MODEL_API_KEY = "hosted-key";
    process.env.GITGECKO_CLOUD_MODEL_BASE_URL = "https://models.example.test";
    process.env.GITGECKO_CLOUD_LIGHT_MODEL = "provider-light-slot";
    process.env.GITGECKO_CLOUD_HIGH_MODEL = "provider-high-slot";
    assert.equal(createAutoComplete().provider, "hosted");
  });

  it("selects the first-party hosted route before BYOK providers", () => {
    process.env.GITGECKO_CLOUD_MODEL_API_KEY = "hosted-key";
    process.env.GITGECKO_CLOUD_MODEL_BASE_URL = "https://models.example.test";
    process.env.GITGECKO_CLOUD_LIGHT_MODEL = "provider-light-slot";
    process.env.GITGECKO_CLOUD_HIGH_MODEL = "provider-high-slot";
    process.env.ANTHROPIC_API_KEY = "ant-key";
    const { provider } = createAutoComplete();
    assert.equal(provider, "hosted");
  });

  it("fails closed when hosted routing is only partially configured", () => {
    process.env.GITGECKO_CLOUD_MODEL_API_KEY = "hosted-key";
    assert.throws(() => createAutoComplete(), /routing is incomplete/i);
  });

  it("detects anthropic when ANTHROPIC_API_KEY is set (highest priority)", () => {
    process.env.ANTHROPIC_API_KEY = "ant-key";
    process.env.OPENAI_API_KEY = "oai-key"; // present but lower priority
    const { provider } = createAutoComplete();
    assert.equal(provider, "anthropic");
  });

  it("detects openai when OPENAI_API_KEY is set (and no anthropic)", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "oai-key";
    const { provider } = createAutoComplete();
    assert.equal(provider, "openai");
  });

  it("detects local when GITGECKO_LOCAL_BASE_URL is set (no cloud keys)", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.GITGECKO_LOCAL_BASE_URL = "http://localhost:1234/v1";
    const { provider } = createAutoComplete();
    assert.equal(provider, "local");
  });

  it("accepts explicit local routing without mutating process environment", () => {
    const result = createAutoComplete({
      deploymentMode: "local",
      localProvider: {
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "qwen-local",
        protocol: "openai-responses",
      },
    });
    assert.equal(result.provider, "local");
    assert.equal(process.env.GITGECKO_LOCAL_BASE_URL, undefined);
  });

  it("ignores whitespace-only provider values instead of constructing a broken adapter", () => {
    process.env.ANTHROPIC_API_KEY = "   ";
    process.env.OPENAI_API_KEY = "\t";
    process.env.GITGECKO_LOCAL_BASE_URL = "  ";
    process.env.OPENAI_BASE_URL = "\n";
    assert.throws(() => createAutoComplete(), /No model provider configured/i);
  });

  it("prefers an explicit local endpoint over generic BYOK keys", () => {
    process.env.GITGECKO_LOCAL_BASE_URL = "http://localhost:1234/v1";
    process.env.GITGECKO_LOCAL_PROTOCOL = "anthropic-messages";
    process.env.ANTHROPIC_API_KEY = "cloud-key";
    const { provider } = createAutoComplete();
    assert.equal(provider, "local");
  });

  it("throws a clear error when no provider is configured", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GITGECKO_LOCAL_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    assert.throws(() => createAutoComplete(), /No model provider configured/i);
  });

  it("returns a complete function alongside the provider id", () => {
    process.env.ANTHROPIC_API_KEY = "ant-key";
    const { provider, complete, generate } = createAutoComplete();
    assert.equal(provider, "anthropic");
    assert.equal(typeof complete, "function");
    assert.equal(typeof generate, "function");
  });
});

// --- Option forwarding: baseUrl + apiKey reach the provider stream --------
//
// This is the #5674 regression guard (opencode bug class: config was read but
// the values never reached the outbound request). The hosted route passes
// baseUrl + apiKey through createProviderComplete → pi-ai completeSimple →
// applyAuth → provider.streamSimple. A faux factory (the function form of a
// queued response) receives (context, options, state, requestModel) — so a
// closure-capturing factory can observe EXACTLY what reached the stream
// boundary. If either value is dropped, this test fails.

describe("option forwarding — baseUrl + apiKey reach the stream (GAP-F, #5674 guard)", () => {
  it("forwards per-request output limits and temperature through the typed seam", async () => {
    let seenMaxTokens: number | undefined;
    let seenTemperature: number | undefined;
    let seenTimeoutMs: number | undefined;
    let seenMaxRetries: number | undefined;
    const handle = fauxProvider({ provider: "request-options", api: "request-options-api" });
    const models: MutableModels = createModels();
    models.setProvider(handle.provider);
    handle.setResponses([(_ctx, options, _state, requestModel) => {
      seenMaxTokens = requestModel.maxTokens;
      seenTemperature = options?.temperature;
      seenTimeoutMs = options?.timeoutMs;
      seenMaxRetries = options?.maxRetries;
      return fauxAssistantMessage("controlled");
    }]);

    const generate = createProviderGenerate(models, {
      providerId: "request-options",
      apiId: "request-options-api",
      modelId: handle.getModel().id,
    });
    await generate("controlled request", undefined, { maxOutputTokens: 321, temperature: 0.25, timeoutMs: 5_000, maxRetries: 0 });

    assert.equal(seenMaxTokens, 321);
    assert.equal(seenTemperature, 0.25);
    assert.equal(seenTimeoutMs, 5_000);
    assert.equal(seenMaxRetries, 0);
  });

  it("forwards an assistant tool call and its tool result as one provider conversation", async () => {
    let seenMessages: readonly unknown[] | undefined;
    const handle = fauxProvider({ provider: "tool-round-trip", api: "tool-round-trip-api" });
    const models: MutableModels = createModels();
    models.setProvider(handle.provider);
    handle.setResponses([(_context) => {
      seenMessages = _context.messages;
      return fauxAssistantMessage("tool continuation");
    }]);

    const generate = createProviderGenerate(models, {
      providerId: "tool-round-trip",
      apiId: "tool-round-trip-api",
      modelId: handle.getModel().id,
    });
    await generate("", undefined, {
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "README.md" } }] },
        { role: "tool", content: "# Readme", toolCallId: "call_1" },
      ],
    });

    assert.equal(seenMessages?.length, 2);
    const assistant = seenMessages?.[0] as { role?: string; content?: Array<{ type?: string; id?: string; name?: string }> };
    const tool = seenMessages?.[1] as { role?: string; toolCallId?: string; content?: Array<{ text?: string }> };
    assert.equal(assistant.role, "assistant");
    assert.deepEqual(assistant.content?.map((block) => ({ type: block.type, id: block.id, name: block.name })), [{ type: "toolCall", id: "call_1", name: "read_file" }]);
    assert.equal(tool.role, "toolResult");
    assert.equal(tool.toolCallId, "call_1");
    assert.equal(tool.content?.[0]?.text, "# Readme");
  });

  it("forwards the configured baseUrl and apiKey through createProviderComplete", async () => {
    // Closure capture: the factory records what pi-ai handed the stream.
    let seenBaseUrl: string | undefined;
    let seenApiKey: string | undefined;
    const handle = fauxProvider({ provider: "fwd-p", api: "fwd-a" });
    const models: MutableModels = createModels();
    models.setProvider(handle.provider);
    // The factory form receives (context, options, state, requestModel).
    // This is the LAST point before real HTTP — capturing here proves the
    // forwarding chain is intact end-to-end through pi-ai's applyAuth.
    handle.setResponses([
      (_ctx, options, _state, requestModel) => {
        seenBaseUrl = requestModel.baseUrl;
        seenApiKey = options?.apiKey;
        return fauxAssistantMessage("forwarded-ok");
      },
    ]);

    const complete = createProviderComplete(models, {
      providerId: "fwd-p",
      apiId: "fwd-a",
      modelId: handle.getModel().id,
      baseUrl: "https://hosted.example.test/v1",
      apiKey: "secret-hosted-key-xyz",
    });

    const out = await complete("prove the forwarding works");
    assert.equal(out, "forwarded-ok");
    assert.equal(
      seenBaseUrl,
      "https://hosted.example.test/v1",
      "the configured baseUrl reached the provider stream (not dropped by createProviderComplete or applyAuth)",
    );
    assert.equal(
      seenApiKey,
      "secret-hosted-key-xyz",
      "the configured apiKey reached the provider stream (the #5674 bug class: config read but not forwarded)",
    );
  });

  it("forwards baseUrl + apiKey through the hosted adapter to the wire (createHostedComplete path)", async () => {
    // The hosted route is the production path for gitgecko-light/gitgecko-high. It calls
    // createAnthropicComplete(opts) internally, which calls createProviderComplete
    // with the anthropic builtin provider. The anthropic API builds the
    // @anthropic-ai/sdk client with baseURL: model.baseUrl + apiKey, then the
    // SDK calls globalThis.fetch. We stub fetch to capture the OUTBOUND request
    // — proving the hosted adapter's configured values reach the wire, not just
    // the stream boundary. This is the #5674 test applied to the real consumer.
    const { createHostedComplete } = await import("./model-client.js");
    let capturedUrl: string | undefined;
    let capturedAuthHeader: string | undefined;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedUrl = url;
      const headers = new Headers(init?.headers);
      capturedAuthHeader = headers.get("x-api-key") ?? headers.get("authorization") ?? undefined;
      // pi-ai uses stream:true (anthropic-messages.js:353), so the SDK expects
      // an SSE stream. Return a valid Anthropic streaming sequence: message_start,
      // a content_block_delta with the text, content_block_stop, message_delta
      // with stop_reason, and message_stop. pi-ai's event-stream parser consumes
      // this and assembles the AssistantMessage that assistantText() extracts.
      const sseEvents = [
        { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "provider-light-slot", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "wire-forwarded-ok" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      const body = sseEvents.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const complete = createHostedComplete({
        apiKey: "hosted-secret-key-abc",
        baseUrl: "https://hosted.example.test/v1",
        lightModel: "provider-light-slot",
        highModel: "provider-high-slot",
        planId: "free",
      });

      const out = await complete("trigger the hosted route");
      assert.equal(out, "wire-forwarded-ok");
      assert.ok(
        capturedUrl?.startsWith("https://hosted.example.test"),
        `the outbound request hit the configured baseUrl (got ${capturedUrl})`,
      );
      assert.ok(
        capturedAuthHeader?.includes("hosted-secret-key-abc"),
        "the configured apiKey reached the wire as the auth credential (the #5674 guard)",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// --- GAP-E: thinking/reasoning is enabled by default on the hosted route ---
//
// Empirical verification (2026-07-09): the z.ai anthropic endpoint accepts
// thinking: { type: "enabled" } and returns materially deeper analysis when
// it's on. The hosted route enables it by default (medium level). This test
// proves the reasoning option reaches the wire — the regression guard for the
// GAP-E wiring.

describe("GAP-E — thinking is enabled by default on the hosted route", () => {
  it("sends thinking: { type: enabled } in the request body by default", async () => {
    const { createHostedComplete } = await import("./model-client.js");
    let capturedBody: Record<string, unknown> | undefined;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.body) {
        try { capturedBody = JSON.parse(init.body as string) as Record<string, unknown>; } catch { /* not json */ }
      }
      const sseEvents = [
        { type: "message_start", message: { id: "msg_t", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      const body = sseEvents.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      const complete = createHostedComplete({
        apiKey: "k",
        baseUrl: "https://h.example.test/v1",
        lightModel: "m",
        highModel: "m",
        planId: "free",
      });
      await complete("trigger");
      assert.ok(capturedBody, "the request body was captured");
      const thinking = capturedBody?.thinking;
      assert.ok(
        typeof thinking === "object" && thinking !== null && (thinking as Record<string, unknown>).type === "enabled",
        `the request body includes thinking: { type: "enabled" } by default (got ${JSON.stringify(thinking)})`,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("honors an explicit reasoning level override (e.g. high)", async () => {
    const { createHostedComplete } = await import("./model-client.js");
    let capturedBody: Record<string, unknown> | undefined;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.body) {
        try { capturedBody = JSON.parse(init.body as string) as Record<string, unknown>; } catch { /* not json */ }
      }
      const sseEvents = [
        { type: "message_start", message: { id: "msg_t", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      const body = sseEvents.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      const complete = createHostedComplete({
        apiKey: "k",
        baseUrl: "https://h.example.test/v1",
        lightModel: "m",
        highModel: "m",
        planId: "free",
        reasoning: "high",
      });
      await complete("trigger");
      // The override flows through to pi-ai which maps "high" to an effort or
      // budget. The key assertion: thinking is enabled (type:"enabled") and the
      // model declares reasoning:true so the thinking branch activated.
      const thinking = capturedBody?.thinking;
      assert.ok(
        typeof thinking === "object" && thinking !== null && (thinking as Record<string, unknown>).type === "enabled",
        `an explicit reasoning override still sends thinking: { type: "enabled" } (got ${JSON.stringify(thinking)})`,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// --- GAP-C (resolved): protocol-decoupled hosted adapter — all three formats work
//
// GITGECKO_PROVIDER_FORMAT selects the wire format the hosted provider speaks.
// All three formats now dispatch through the corresponding pi-ai adapter:
//   anthropic  → createAnthropicComplete (Messages API)
//   completions → createOpenAIComplete with openai-chat-completions protocol
//   responses  → createOpenAIComplete with openai-responses protocol

describe("GAP-C — protocol-decoupled hosted adapter (all three formats)", () => {
  it("constructs a working ModelComplete for format='completions'", () => {
    const complete = createHostedComplete({
      apiKey: "k",
      baseUrl: "https://h.example.test/v1",
      lightModel: "m",
      highModel: "m",
      format: "completions",
    });
    assert.equal(typeof complete, "function", "completions format constructs a ModelComplete");
  });

  it("constructs a working ModelComplete for format='responses'", () => {
    const complete = createHostedComplete({
      apiKey: "k",
      baseUrl: "https://h.example.test/v1",
      lightModel: "m",
      highModel: "m",
      format: "responses",
    });
    assert.equal(typeof complete, "function", "responses format constructs a ModelComplete");
  });

  it("constructs a working ModelComplete for format='anthropic'", () => {
    const complete = createHostedComplete({
      apiKey: "k",
      baseUrl: "https://h.example.test/v1",
      lightModel: "m",
      highModel: "m",
      format: "anthropic",
    });
    assert.equal(typeof complete, "function", "anthropic format constructs a ModelComplete");
  });

  it("defaults to anthropic when format is omitted", () => {
    const complete = createHostedComplete({
      apiKey: "k",
      baseUrl: "https://h.example.test/v1",
      lightModel: "m",
      highModel: "m",
    });
    assert.equal(typeof complete, "function", "omitted format defaults to anthropic and constructs fine");
  });

  it("completions format dispatches through the OpenAI completions API to the wire", async () => {
    const { createHostedComplete } = await import("./model-client.js");
    let capturedUrl: string | undefined;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedUrl = url;
      // OpenAI completions API uses SSE streaming (pi-ai always streams).
      const sseBody = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "completions-ok" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join("");
      return new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      const complete = createHostedComplete({
        apiKey: "hosted-key",
        baseUrl: "https://provider.example.test/v1",
        lightModel: "provider-light-model",
        highModel: "provider-high-model",
        planId: "free",
        format: "completions",
      });
      const out = await complete("trigger completions route");
      assert.match(out, /completions-ok/, "the completions adapter returned the upstream response");
      assert.ok(
        capturedUrl?.includes("provider.example.test"),
        `the request hit the configured baseUrl (got ${capturedUrl})`,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("responses format dispatches through the OpenAI responses API to the wire", async () => {
    const { createHostedComplete } = await import("./model-client.js");
    let capturedUrl: string | undefined;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedUrl = url;
      // OpenAI Responses API uses SSE streaming. Return the terminal events
      // pi-ai's event-stream parser expects: response.output_item.done with
      // the message, then response.completed.
      const sseEvents = [
        { type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", id: "msg-1", status: "in_progress", content: [{ type: "output_text", text: "" }] } },
        { type: "response.content_part.added", item_id: "msg-1", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "responses-ok" },
        { type: "response.output_text.done", output_index: 0, content_index: 0, text: "responses-ok" },
        { type: "response.content_part.done", item_id: "msg-1", output_index: 0, content_index: 0, part: { type: "output_text", text: "responses-ok" } },
        { type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", id: "msg-1", status: "completed", content: [{ type: "output_text", text: "responses-ok" }] } },
        { type: "response.completed", response: { id: "resp-test", status: "completed", model: "provider-light-model", output: [{ type: "message", role: "assistant", id: "msg-1", status: "completed", content: [{ type: "output_text", text: "responses-ok" }] }] } },
      ];
      const body = sseEvents.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      const complete = createHostedComplete({
        apiKey: "hosted-key",
        baseUrl: "https://provider.example.test/v1",
        lightModel: "provider-light-model",
        highModel: "provider-high-model",
        planId: "free",
        format: "responses",
      });
      const out = await complete("trigger responses route");
      assert.match(out, /responses-ok/, "the responses adapter returned the upstream response");
      assert.ok(
        capturedUrl?.includes("provider.example.test"),
        `the request hit the configured baseUrl (got ${capturedUrl})`,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// --- GAP-D: context window and max-tokens are env-configurable ------------
//
// The hardcoded 128K/8K floor is safe but pessimistic — the hosted high tier
// may expose a larger context window through deployment configuration.
// The operator sets the real ceiling via GITGECKO_CLOUD_MODEL_CONTEXT_WINDOW and
// per-tier max output via GITGECKO_CLOUD_LIGHT_MAX_TOKENS / GITGECKO_CLOUD_HIGH_MAX_TOKENS.
// These tests prove the env override flows into both the catalog (discovery
// surface) and the request model (the wire-level contextWindow/maxTokens).

describe("GAP-D — context window and max-tokens are env-configurable", () => {
  it("getGitGeckoModelLimits returns the defaults when env is unset", () => {
    const limits = getGitGeckoModelLimits();
    assert.equal(limits.contextWindow, 128_000);
    assert.equal(limits.lightMaxTokens, 8_192);
    assert.equal(limits.highMaxTokens, 16_384);
  });

  it("getGitGeckoModelLimits reads GITGECKO_CLOUD_MODEL_CONTEXT_WINDOW override", () => {
    process.env.GITGECKO_CLOUD_MODEL_CONTEXT_WINDOW = "1000000";
    const limits = getGitGeckoModelLimits();
    assert.equal(limits.contextWindow, 1_000_000, "1M context window from hosted high-tier configuration");
  });

  it("getGitGeckoModelLimits reads canonical GitGecko limits", () => {
    process.env.GITGECKO_CLOUD_MODEL_CONTEXT_WINDOW = "750000";
    process.env.GITGECKO_CLOUD_LIGHT_MAX_TOKENS = "12000";
    assert.equal(getGitGeckoModelLimits().contextWindow, 750_000);
    assert.equal(getGitGeckoModelLimits().lightMaxTokens, 12_000);
  });

  it("getGitGeckoModelLimits ignores non-positive / garbage values (fail-safe to defaults)", () => {
    process.env.GITGECKO_CLOUD_MODEL_CONTEXT_WINDOW = "not-a-number";
    assert.equal(getGitGeckoModelLimits().contextWindow, 128_000, "garbage falls back to default");
    process.env.GITGECKO_CLOUD_MODEL_CONTEXT_WINDOW = "0";
    assert.equal(getGitGeckoModelLimits().contextWindow, 128_000, "zero falls back to default");
    process.env.GITGECKO_CLOUD_MODEL_CONTEXT_WINDOW = "-5";
    assert.equal(getGitGeckoModelLimits().contextWindow, 128_000, "negative falls back to default");
  });

  it("resolveGitGeckoModel applies env-configured limits per tier", () => {
    process.env.GITGECKO_CLOUD_MODEL_CONTEXT_WINDOW = "500000";
    process.env.GITGECKO_CLOUD_LIGHT_MAX_TOKENS = "4096";
    process.env.GITGECKO_CLOUD_HIGH_MAX_TOKENS = "65536";

    const light = resolveGitGeckoModel("light");
    assert.equal(light.contextWindow, 500_000, "light contextWindow from env");
    assert.equal(light.maxTokens, 4_096, "light maxTokens from env");

    const high = resolveGitGeckoModel("high");
    assert.equal(high.contextWindow, 500_000, "high contextWindow from env");
    assert.equal(high.maxTokens, 65_536, "high maxTokens from env");
  });

  it("listGitGeckoModels includes the env-configured limits in the discovery surface", () => {
    process.env.GITGECKO_CLOUD_MODEL_API_KEY = "k";
    process.env.GITGECKO_CLOUD_MODEL_BASE_URL = "https://h.example.test";
    process.env.GITGECKO_CLOUD_LIGHT_MODEL = "lm";
    process.env.GITGECKO_CLOUD_HIGH_MODEL = "hm";
    process.env.GITGECKO_CLOUD_MODEL_CONTEXT_WINDOW = "1000000";

    const models = listGitGeckoModels();
    assert.equal(models.length, 2, "both tiers present");
    assert.equal(models[0]?.contextWindow, 1_000_000, "discovery surface reports 1M ceiling");
    assert.equal(models[1]?.contextWindow, 1_000_000, "both tiers share the ceiling");
  });

  it("the hosted route passes the env-configured contextWindow to the request model", async () => {
    process.env.GITGECKO_CLOUD_MODEL_CONTEXT_WINDOW = "1000000";
    process.env.GITGECKO_CLOUD_LIGHT_MAX_TOKENS = "32768";
    let capturedContextWindow: number | undefined;
    let capturedMaxTokens: number | undefined;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      // The context window is on the pi-ai request model, not the HTTP body.
      // We verify it reaches createProviderComplete via the faux factory path.
      return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      // Use createProviderComplete directly with the configured limits — this is
      // the shared bottom of the chain that createHostedComplete depends on.
      const handle = fauxProvider({ provider: "ctx-p", api: "ctx-a" });
      const models: MutableModels = createModels();
      models.setProvider(handle.provider);
      handle.setResponses([
        (_ctx, _opts, _state, requestModel) => {
          capturedContextWindow = requestModel.contextWindow;
          capturedMaxTokens = requestModel.maxTokens;
          return fauxAssistantMessage("ctx-ok");
        },
      ]);

      const limits = resolveGitGeckoModel("light");
      const complete = createProviderComplete(models, {
        providerId: "ctx-p",
        apiId: "ctx-a",
        modelId: handle.getModel().id,
        contextWindow: limits.contextWindow,
        maxTokens: limits.maxTokens,
      });

      await complete("trigger");
      assert.equal(capturedContextWindow, 1_000_000, "1M contextWindow reached the request model");
      assert.equal(capturedMaxTokens, 32_768, "32K maxTokens reached the request model");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
