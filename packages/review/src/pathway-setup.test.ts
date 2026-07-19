import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { modelProviderConfigSchema, pathwaySetupSchema } from "./pathway-setup.js";

const base = { id: "pathway_local_1", enabled: true, isDefault: true, owner: { scope: "account" as const } };

describe("pathway setup schema", () => {
  it("accepts product-hosted selection without customer credentials", () => {
    const setup = pathwaySetupSchema.parse({ ...base, kind: "hosted", topology: "cloud" });
    assert.equal(setup.kind, "hosted");
  });

  it("restricts native agents to the local topology", () => {
    assert.throws(() => pathwaySetupSchema.parse({ ...base, kind: "native", topology: "cloud", binary: "codex" }));
    assert.equal(pathwaySetupSchema.parse({ ...base, kind: "native", topology: "local", binary: "codex" }).kind, "native");
  });

  it("accepts local OpenAI-compatible metadata with an environment secret reference", () => {
    const setup = pathwaySetupSchema.parse({
      ...base,
      kind: "local",
      topology: "local",
      provider: { baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", protocol: "openai-responses" },
      credential: { kind: "environment", name: "LOCAL_MODEL_KEY" },
    });
    assert.equal(setup.kind, "local");
  });

  it("requires project identity for project-scoped setup", () => {
    assert.throws(() => pathwaySetupSchema.parse({ ...base, owner: { scope: "project" }, kind: "hosted", topology: "cloud" }));
  });

  it("rejects browser-style environment credentials in cloud topology", () => {
    assert.throws(() => pathwaySetupSchema.parse({
      ...base,
      kind: "local",
      topology: "cloud",
      provider: { baseUrl: "https://models.example/v1", model: "model", protocol: "openai-chat-completions" },
      credential: { kind: "environment", name: "MODEL_KEY" },
    }));
  });

  it("represents stored cloud credentials only as redacted status", () => {
    const setup = pathwaySetupSchema.parse({
      ...base,
      kind: "local",
      topology: "cloud",
      provider: { baseUrl: "https://models.example/v1", model: "model", protocol: "anthropic-messages" },
      credential: { kind: "stored", configured: true },
    });
    assert.equal(setup.kind, "local");
    if (setup.kind !== "local") assert.fail("expected local pathway setup");
    assert.deepEqual(setup.credential, { kind: "stored", configured: true });
  });

  it("rejects unknown fields, malformed URLs, and unsupported protocols", () => {
    assert.throws(() => modelProviderConfigSchema.parse({ baseUrl: "not-a-url", model: "m", protocol: "openai", extra: true }));
  });
});
