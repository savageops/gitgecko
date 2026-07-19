import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadAvailableModels, renderModels } from "./models.js";

describe("gitgecko models", () => {
  it("uses the saved device token for the cloud catalog", async () => {
    const request: typeof fetch = async (input, init) => {
      assert.equal(String(input), "https://cloud.example/models");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer token-1");
      return new Response(JSON.stringify({ data: [{ id: "gitgecko-light", owned_by: "gitgecko", protocols: ["anthropic-messages"] }] }));
    };
    const models = await loadAvailableModels({ version: 2, token: "token-1", deviceId: "dev-1", cloudUrl: "https://cloud.example" }, {}, request);
    assert.equal(models[0]?.id, "gitgecko-light");
    assert.equal(models[0]?.ownedBy, "gitgecko");
  });

  it("prefers local discovery without requiring login", async () => {
    const request: typeof fetch = async (input) => {
      assert.equal(String(input), "http://localhost:1234/v1/models");
      return new Response(JSON.stringify({ data: [{ id: "local-model" }] }));
    };
    const models = await loadAvailableModels(undefined, { GITGECKO_LOCAL_BASE_URL: "http://localhost:1234/v1" }, request);
    assert.match(renderModels(models), /^local-model\tlocal\topenai-chat-completions$/);
  });

  it("uses the saved provider as the discovery authority", async () => {
    const request: typeof fetch = async (input) => {
      assert.equal(String(input), "http://configured.test/v1/models");
      return new Response(JSON.stringify({ data: [{ id: "saved-model" }] }));
    };
    const models = await loadAvailableModels(undefined, {}, request, {
      baseUrl: "http://configured.test/v1", model: "saved-model", protocol: "openai-responses",
    });
    assert.match(renderModels(models), /^saved-model\tlocal\topenai-responses$/);
  });

  it("uses the OpenAI-compatible base URL and keeps an explicit model when discovery is unavailable", async () => {
    const request: typeof fetch = async (input) => {
      assert.equal(String(input), "http://localhost:1234/v1/models");
      return new Response("offline", { status: 503 });
    };
    const models = await loadAvailableModels(undefined, {
      GITGECKO_LOCAL_BASE_URL: "   ",
      OPENAI_BASE_URL: "http://localhost:1234/v1",
      GITGECKO_LOCAL_MODEL: "local-configured",
      GITGECKO_LOCAL_PROTOCOL: "anthropic-messages",
    }, request);
    assert.deepEqual(models.map((model) => ({ id: model.id, protocols: model.protocols })), [
      { id: "local-configured", protocols: ["anthropic-messages"] },
    ]);
  });

  it("turns a revoked cloud token into an actionable relink message", async () => {
    const request: typeof fetch = async () => new Response(null, { status: 401 });
    await assert.rejects(
      () => loadAvailableModels({ version: 2, token: "revoked", deviceId: "dev-1", cloudUrl: "https://cloud.example" }, {}, request),
      /run `gitgecko login`/i,
    );
  });

  it("turns a local fetch failure into an actionable routing message", async () => {
    const request: typeof fetch = async () => { throw new Error("fetch failed"); };
    await assert.rejects(
      () => loadAvailableModels(undefined, { GITGECKO_LOCAL_BASE_URL: "http://localhost:1234/v1" }, request),
      /localhost:1234.*models show.*models clear/iu,
    );
  });

  it("turns a cloud fetch failure into an actionable connectivity message", async () => {
    const request: typeof fetch = async () => { throw new Error("fetch failed"); };
    await assert.rejects(
      () => loadAvailableModels(undefined, { GITGECKO_CLOUD_URL: "https://cloud.example" }, request),
      /Model catalog request failed.*gitgecko doctor/iu,
    );
  });
});
