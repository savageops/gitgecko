import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  applyProviderSchemaDefaults,
  hashProviderSchema,
  profileMatchesRuntime,
  providerProfilePath,
  readProviderProfile,
  writeProviderProfile,
} from "./native-provider-runtime.js";
import type { NativeAgentRuntimeProfile } from "./native-provider.js";

const profile = (overrides: Partial<NativeAgentRuntimeProfile> = {}): NativeAgentRuntimeProfile => ({
  schemaVersion: "native-agent-runtime.v1",
  provider: "codex",
  providerVersion: "1.2.3",
  executable: "C:\\bin\\codex.exe",
  schemaHash: "abc",
  capabilities: { cwd: true, permissions: ["read-only", "workspace-write", "unrestricted"], ephemeral: true, threads: true, resume: true, cancellation: true, activity: true, usage: true, schemaDiscovery: true },
  ...overrides,
});

describe("provider schema hashing", () => {
  const equivalent: readonly [unknown, unknown][] = [
    [{ a: 1, b: 2 }, { b: 2, a: 1 }],
    [{ nested: { a: 1, b: 2 } }, { nested: { b: 2, a: 1 } }],
    [{ list: [{ a: 1, b: 2 }] }, { list: [{ b: 2, a: 1 }] }],
    [null, null], [undefined, undefined], ["x", "x"], [1, 1], [true, true], [[], []], [{}, {}],
  ];
  equivalent.forEach(([left, right], index) => it(`is canonical for equivalent schema ${index + 1}`, () => assert.equal(hashProviderSchema(left), hashProviderSchema(right))));
  it("changes for an additive field", () => assert.notEqual(hashProviderSchema({ a: 1 }), hashProviderSchema({ a: 1, b: 2 })));
  it("changes for a declared default", () => assert.notEqual(hashProviderSchema({ type: "string" }), hashProviderSchema({ type: "string", default: "x" })));
  it("preserves array order", () => assert.notEqual(hashProviderSchema([1, 2]), hashProviderSchema([2, 1])));
});

describe("provider-declared defaults", () => {
  it("applies declared defaults", () => assert.deepEqual(applyProviderSchemaDefaults({ properties: { mode: { default: "safe" } } }), { mode: "safe" }));
  it("prefers mapped values to defaults", () => assert.deepEqual(applyProviderSchemaDefaults({ properties: { mode: { default: "safe" } } }, {}, { mode: "mapped" }), { mode: "mapped" }));
  it("prefers user values to mappings", () => assert.deepEqual(applyProviderSchemaDefaults({}, { mode: "user" }, { mode: "mapped" }), { mode: "user" }));
  it("accepts additive properties", () => assert.deepEqual(applyProviderSchemaDefaults({ properties: { future: { type: "string" } } }, { existing: true }), { existing: true }));
  it("fills nullable required fields", () => assert.deepEqual(applyProviderSchemaDefaults({ required: ["optional"], properties: { optional: { type: ["string", "null"] } } }), { optional: null }));
  it("fills null-only required fields", () => assert.deepEqual(applyProviderSchemaDefaults({ required: ["optional"], properties: { optional: { type: "null" } } }), { optional: null }));
  it("retains false user values", () => assert.deepEqual(applyProviderSchemaDefaults({ properties: { enabled: { default: true } } }, { enabled: false }), { enabled: false }));
  it("retains zero user values", () => assert.deepEqual(applyProviderSchemaDefaults({ properties: { count: { default: 1 } } }, { count: 0 }), { count: 0 }));
  it("retains empty-string user values", () => assert.deepEqual(applyProviderSchemaDefaults({ properties: { value: { default: "x" } } }, { value: "" }), { value: "" }));
  it("fails closed for unknown required semantics", () => assert.throws(() => applyProviderSchemaDefaults({ required: ["future"], properties: { future: { type: "object" } } }), /no safe default/));
  it("fails closed when a required property is undeclared", () => assert.throws(() => applyProviderSchemaDefaults({ required: ["future"] }), /future/));
});

describe("atomic provider profile cache", () => {
  it("round-trips a validated profile", () => {
    const root = mkdtempSync(join(tmpdir(), "gitgecko-profile-"));
    try { writeProviderProfile(profile(), root); assert.deepEqual(readProviderProfile("codex", root), profile()); } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("uses one provider-specific file", () => assert.match(providerProfilePath("claude", "C:\\cache"), /claude\.json$/));
  it("returns absent for a missing profile", () => assert.equal(readProviderProfile("pi", join(tmpdir(), `missing-${Date.now()}`)), undefined));
  it("rejects corrupt JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "gitgecko-profile-"));
    try { writeFileSync(providerProfilePath("codex", root), "{"); assert.equal(readProviderProfile("codex", root), undefined); } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("rejects a provider mismatch", () => {
    const root = mkdtempSync(join(tmpdir(), "gitgecko-profile-"));
    try { writeProviderProfile(profile({ provider: "claude" }), root); writeFileSync(providerProfilePath("codex", root), readFileSync(providerProfilePath("claude", root))); assert.equal(readProviderProfile("codex", root), undefined); } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("invalidates on provider version", () => assert.equal(profileMatchesRuntime(profile(), "2.0.0", profile().executable), false));
  it("invalidates on executable identity", () => assert.equal(profileMatchesRuntime(profile(), "1.2.3", "D:\\codex.exe"), false));
  it("invalidates on schema hash", () => assert.equal(profileMatchesRuntime(profile(), "1.2.3", profile().executable, "changed"), false));
  it("invalidates on configuration-sensitive profile key", () => assert.equal(profileMatchesRuntime(profile({ configurationHash: "a" }), "1.2.3", profile().executable, "abc", "b"), false));
  it("matches an unchanged configuration-sensitive profile key", () => assert.equal(profileMatchesRuntime(profile({ configurationHash: "a" }), "1.2.3", profile().executable, "abc", "a"), true));
  it("matches the same runtime", () => assert.equal(profileMatchesRuntime(profile(), "1.2.3", profile().executable, "abc"), true));
  it("does not match an absent profile", () => assert.equal(profileMatchesRuntime(undefined, "1.2.3"), false));
});
