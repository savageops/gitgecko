import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configuredLocalModel, discoverLocalModels, listHostedModels, resolveHostedModel } from "./catalog.js";
import { GITGECKO_MODELS, modelForPlan, readGitGeckoProviderConfig } from "./gitgecko-models.js";

describe("hosted provider configuration", () => {
  it("uses the Anthropic default when Compose supplies an empty format", () => {
    const config = readGitGeckoProviderConfig({
      GITGECKO_CLOUD_MODEL_API_KEY: "provider-key",
      GITGECKO_CLOUD_MODEL_BASE_URL: "https://provider.example.test/anthropic",
      GITGECKO_CLOUD_LIGHT_MODEL: "provider-light",
      GITGECKO_CLOUD_HIGH_MODEL: "provider-high",
      GITGECKO_PROVIDER_FORMAT: "   ",
    });
    assert.equal(config?.format, "anthropic");
  });
});

describe("hosted model catalog", () => {
  it("exposes only gitgecko-light to free users and never leaks private routing data", () => {
    const models = listHostedModels("free");
    assert.deepEqual(models.map((model) => model.id), ["gitgecko-light"]);
    assert.doesNotMatch(JSON.stringify(models), /glm|z\.ai/i);
  });

  it("adds gitgecko-high for paid plans", () => {
    assert.deepEqual(listHostedModels("pro").map((model) => model.id), ["gitgecko-light", "gitgecko-high"]);
    assert.deepEqual(listHostedModels("enterprise").map((model) => model.id), ["gitgecko-light", "gitgecko-high"]);
  });

  it("derives public identity from the hosted routing owner and advertises real streaming", () => {
    const [light, high] = listHostedModels("pro");
    assert.equal(light?.id, GITGECKO_MODELS.light.id);
    assert.equal(light?.name, GITGECKO_MODELS.light.name);
    assert.equal(high?.id, GITGECKO_MODELS.high.id);
    assert.equal(high?.name, GITGECKO_MODELS.high.name);
    assert.equal(light?.capabilities.streaming, true);
    assert.equal(high?.capabilities.streaming, true);
  });

  it("maps enterprise to the high hosted model in the public plan helper", () => {
    assert.equal(modelForPlan("enterprise"), "gitgecko-high");
  });

  it("denies an unentitled alias before resolving private provider metadata", () => {
    assert.throws(() => resolveHostedModel("gitgecko-high", "free"), /requires the pro plan/i);
    assert.equal(resolveHostedModel("gitgecko-high", "pro").alias, "gitgecko-high");
  });
});

describe("local model discovery", () => {
  it("publishes an explicitly selected local model without claiming discovery", () => {
    assert.deepEqual(configuredLocalModel("  local-coder  ", "anthropic-messages"), {
      id: "local-coder",
      object: "model",
      ownedBy: "local",
      name: "local-coder",
      protocols: ["anthropic-messages"],
      capabilities: { text: true, tools: true, reasoning: false, streaming: true },
    });
    assert.equal(configuredLocalModel("  "), undefined);
  });

  it("normalizes the standard /models response and preserves selected protocol", async () => {
    const request: typeof fetch = async (input) => {
      assert.equal(String(input), "http://localhost:1234/v1/models");
      return new Response(JSON.stringify({ data: [{ id: "local-a" }, { id: "local-b" }] }), { status: 200 });
    };
    const models = await discoverLocalModels("http://localhost:1234/v1", "openai-responses", request);
    assert.deepEqual(models.map((model) => model.id), ["local-a", "local-b"]);
    assert.deepEqual(models[0]?.protocols, ["openai-responses"]);
  });

  it("surfaces discovery failures instead of inventing a local model", async () => {
    const request: typeof fetch = async () => new Response("no", { status: 404 });
    await assert.rejects(() => discoverLocalModels("http://localhost:1234/v1", undefined, request), /returned 404/);
  });
});
