import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileConfigStore, renderModelProviderConfig, resolveModelProvider, toLocalEndpointConfig } from "./config.js";

describe("CLI provider config", () => {
  it("round-trips an environment-backed local provider without persisting its environment value", () => {
    const path = join(mkdtempSync(join(tmpdir(), "gitgecko-config-")), "config.json");
    const store = createFileConfigStore(path);
    store.write({ version: 1, modelProvider: { baseUrl: "http://localhost:1234/v1", model: "qwen", protocol: "openai-responses", apiKeyEnv: "LOCAL_MODEL_KEY" } });
    assert.equal(store.read().modelProvider?.model, "qwen");
    assert.doesNotMatch(readFileSync(path, "utf8"), /secret-value/);
    assert.equal(resolveModelProvider(store.read(), { LOCAL_MODEL_KEY: "secret-value" })?.apiKey, "secret-value");
  });

  it("accepts a user-owned inline local key without displaying it", () => {
    const path = join(mkdtempSync(join(tmpdir(), "gitgecko-config-")), "config.json");
    const store = createFileConfigStore(path);
    store.write({ version: 1, modelProvider: { baseUrl: "https://models.example/v1", model: "local-model", protocol: "openai-chat-completions", apiKey: "stored-secret" } });
    assert.equal(resolveModelProvider(store.read())?.apiKey, "stored-secret");
    assert.doesNotMatch(renderModelProviderConfig(store.read()), /stored-secret/);
  });

  it("rejects ambiguous inline and environment local credentials", () => {
    const path = join(mkdtempSync(join(tmpdir(), "gitgecko-config-")), "config.json");
    const store = createFileConfigStore(path);
    assert.throws(() => store.write({ version: 1, modelProvider: { baseUrl: "https://models.example/v1", model: "local-model", protocol: "openai-chat-completions", apiKey: "stored-secret", apiKeyEnv: "MODEL_KEY" } }));
  });

  it("rejects malformed config instead of silently falling back", () => {
    const path = join(mkdtempSync(join(tmpdir(), "gitgecko-config-")), "config.json");
    const store = createFileConfigStore(path);
    assert.throws(() => store.write({ version: 1, modelProvider: { baseUrl: "not-a-url", model: "qwen", protocol: "openai-chat-completions" } }));
  });

  it("adapts Responses configuration to the local review pathway", () => {
    assert.deepEqual(toLocalEndpointConfig({ baseUrl: "http://localhost:1234/v1", model: "qwen", protocol: "openai-responses" }), {
      baseUrl: "http://localhost:1234/v1", modelId: "qwen", protocol: "openai-responses",
    });
  });

  it("preserves Anthropic Messages for compatible local endpoints", () => {
    assert.equal(toLocalEndpointConfig({
      baseUrl: "http://localhost:1234/v1",
      model: "local-claude",
      protocol: "anthropic-messages",
    }).protocol, "anthropic-messages");
  });

  it("passes the resolved environment secret to Pi without persisting it", () => {
    assert.equal(toLocalEndpointConfig({
      baseUrl: "http://localhost:1234/v1",
      model: "local-model",
      protocol: "openai-chat-completions",
      apiKey: "runtime-only",
    }).apiKey, "runtime-only");
  });

  it("accepts bounded opt-in runtime checks without granting them a configured cwd", () => {
    const path = join(mkdtempSync(join(tmpdir(), "gitgecko-config-")), "config.json");
    const store = createFileConfigStore(path);
    store.write({
      version: 1,
      reviewChecks: [{ id: "unit", label: "Unit tests", command: "pnpm", args: ["test"], timeoutMs: 60_000 }],
    });
    assert.deepEqual(store.read().reviewChecks, [{ id: "unit", label: "Unit tests", command: "pnpm", args: ["test"], timeoutMs: 60_000 }]);
  });

  it("rejects malformed runtime check configuration before a process can start", () => {
    const path = join(mkdtempSync(join(tmpdir(), "gitgecko-config-")), "config.json");
    const store = createFileConfigStore(path);
    assert.throws(() => store.write({ version: 1, reviewChecks: [{ id: "Test suite", label: "Test", command: "pnpm" }] }));
  });
});
