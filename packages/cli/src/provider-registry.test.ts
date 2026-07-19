import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NATIVE_PROVIDER_ORDER } from "@gitgecko/review";
import { bundledProviderRegistry } from "./provider-registry.js";

for (const id of NATIVE_PROVIDER_ORDER) {
  describe(`${id} provider conformance`, () => {
    const plug = bundledProviderRegistry.get(id);
    it("is registered", () => assert.ok(plug));
    it("uses the stable provider id", () => assert.equal(plug?.id, id));
    it("targets the review owner", () => assert.equal(plug?.manifest.owner, "review"));
    it("exposes the common probe", () => assert.equal(typeof plug?.probe, "function"));
    it("exposes capability discovery", () => assert.equal(typeof plug?.discoverCapabilities, "function"));
    it("exposes the common constructor", () => assert.equal(typeof plug?.create, "function"));
    it("constructs an agent through the socket", () => assert.equal(typeof plug?.create(id === "pi" ? { baseUrl: "http://127.0.0.1:1234/v1", model: "fixture" } : undefined).run, "function"));
    it("has a unique preference", () => {
      const preferences = bundledProviderRegistry.list().map((candidate) => candidate.preference);
      assert.equal(new Set(preferences).size, NATIVE_PROVIDER_ORDER.length);
    });
  });
}

describe("provider selection policy", () => {
  it("orders Codex, Claude, OpenCode, then Pi", () => assert.deepEqual(bundledProviderRegistry.list().map((plug) => plug.id), NATIVE_PROVIDER_ORDER));
  it("selects Codex first", () => assert.equal(bundledProviderRegistry.select([...NATIVE_PROVIDER_ORDER])?.id, "codex"));
  it("selects Claude without Codex", () => assert.equal(bundledProviderRegistry.select(["pi", "opencode", "claude"])?.id, "claude"));
  it("selects OpenCode without primary providers", () => assert.equal(bundledProviderRegistry.select(["pi", "opencode"])?.id, "opencode"));
  it("selects configured Pi last", () => assert.equal(bundledProviderRegistry.select(["pi"])?.id, "pi"));
  it("returns no provider when none are available", () => assert.equal(bundledProviderRegistry.select([]), undefined));
});
