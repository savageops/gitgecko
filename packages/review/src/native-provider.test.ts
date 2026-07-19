import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Agent } from "./agent.js";
import {
  NATIVE_PROVIDER_ORDER,
  createAgentFromProviderRegistry,
  createNativeAgentProviderRegistry,
  type NativeAgentProviderId,
  type NativeAgentProviderPlug,
} from "./native-provider.js";

const agent = (name: string): Agent => ({
  name,
  install: async () => name,
  run: async () => ({ success: true, output: name }),
});

const plug = (
  id: NativeAgentProviderId,
  preference: number,
  owner = "review",
  create: NativeAgentProviderPlug["create"] = () => agent(id),
): NativeAgentProviderPlug => ({
  id,
  preference,
  manifest: {
    schemaVersion: "1.0.0",
    id: `agent-${id}`,
    name: id,
    owner,
    version: "1.0.0",
    description: `${id} provider`,
    capabilities: ["agent-backend"],
    targets: { providers: [id], plans: [], env: [] },
    dependencies: { requires: [], recommends: [] },
    permissions: { network: [], filesystem: [], env: [], mutatesTools: false },
    entrypoint: "./plug.js",
    hooks: false,
    mcp: false,
  },
  probe: () => ({ installed: true }),
  discoverCapabilities: async () => ({
    schemaVersion: "native-agent-runtime.v1",
    provider: id,
    providerVersion: "1",
    schemaHash: "hash",
    capabilities: { cwd: true, permissions: ["read-only"], ephemeral: true, threads: false, resume: false, cancellation: true, activity: true, usage: false, schemaDiscovery: false },
  }),
  create,
});

describe("native provider registry", () => {
  it("declares the canonical automatic provider order", () => {
    assert.deepEqual(NATIVE_PROVIDER_ORDER, ["codex", "claude", "opencode", "pi"]);
  });

  it("starts empty", () => {
    assert.deepEqual(createNativeAgentProviderRegistry().list(), []);
  });

  it("registers and retrieves a provider by stable ID", () => {
    const registry = createNativeAgentProviderRegistry();
    const codex = plug("codex", 0);
    registry.register(codex);
    assert.equal(registry.get("codex"), codex);
  });

  it("returns undefined for an unregistered provider", () => {
    assert.equal(createNativeAgentProviderRegistry().get("pi"), undefined);
  });

  it("sorts providers by preference independent of registration order", () => {
    const registry = createNativeAgentProviderRegistry([plug("pi", 3), plug("claude", 1), plug("codex", 0), plug("opencode", 2)]);
    assert.deepEqual(registry.list().map(({ id }) => id), NATIVE_PROVIDER_ORDER);
  });

  it("does not mutate the caller's initial provider array", () => {
    const initial = [plug("pi", 3), plug("codex", 0)];
    createNativeAgentProviderRegistry(initial).list();
    assert.deepEqual(initial.map(({ id }) => id), ["pi", "codex"]);
  });

  it("rejects a duplicate provider ID from initial registration", () => {
    assert.throws(() => createNativeAgentProviderRegistry([plug("codex", 0), plug("codex", 4)]), /already registered/u);
  });

  it("rejects a duplicate provider ID added later", () => {
    const registry = createNativeAgentProviderRegistry([plug("claude", 1)]);
    assert.throws(() => registry.register(plug("claude", 9)), /already registered/u);
  });

  it("rejects providers assigned to a non-review owner", () => {
    assert.throws(() => createNativeAgentProviderRegistry([plug("codex", 0, "billing")]), /must target the review owner/u);
  });

  it("does not retain a provider after owner validation fails", () => {
    const registry = createNativeAgentProviderRegistry();
    assert.throws(() => registry.register(plug("pi", 3, "model")));
    assert.equal(registry.get("pi"), undefined);
  });

  it("selects the lowest-preference available provider", () => {
    const registry = createNativeAgentProviderRegistry([plug("opencode", 2), plug("claude", 1), plug("codex", 0)]);
    assert.equal(registry.select(["opencode", "claude"])?.id, "claude");
  });

  it("ignores available IDs that are not registered", () => {
    const registry = createNativeAgentProviderRegistry([plug("claude", 1)]);
    assert.equal(registry.select(["codex", "claude"])?.id, "claude");
  });

  it("returns undefined rather than falling back outside the available set", () => {
    const registry = createNativeAgentProviderRegistry([plug("codex", 0), plug("claude", 1)]);
    assert.equal(registry.select(["pi"]), undefined);
  });

  it("constructs only the explicitly requested provider", () => {
    const calls: string[] = [];
    const registry = createNativeAgentProviderRegistry([
      plug("codex", 0, "review", () => { calls.push("codex"); return agent("codex"); }),
      plug("claude", 1, "review", () => { calls.push("claude"); return agent("claude"); }),
    ]);
    assert.equal(createAgentFromProviderRegistry(registry, "claude").name, "claude");
    assert.deepEqual(calls, ["claude"]);
  });

  it("passes provider config through unchanged", () => {
    const config = { cwd: "C:\\repo", model: "provider-model", options: { additive: true } } as const;
    let received: unknown;
    const registry = createNativeAgentProviderRegistry([plug("codex", 0, "review", (value) => { received = value; return agent("codex"); })]);
    createAgentFromProviderRegistry(registry, "codex", config);
    assert.equal(received, config);
  });

  it("fails closed when the requested provider is unavailable", () => {
    const registry = createNativeAgentProviderRegistry([plug("claude", 1)]);
    assert.throws(() => createAgentFromProviderRegistry(registry, "codex"), /'codex' is unavailable/u);
  });

  it("does not fallback when the requested provider factory throws", () => {
    let fallbackCalls = 0;
    const registry = createNativeAgentProviderRegistry([
      plug("codex", 0, "review", () => { throw new Error("codex failed"); }),
      plug("claude", 1, "review", () => { fallbackCalls += 1; return agent("claude"); }),
    ]);
    assert.throws(() => createAgentFromProviderRegistry(registry, "codex"), /codex failed/u);
    assert.equal(fallbackCalls, 0);
  });
});
