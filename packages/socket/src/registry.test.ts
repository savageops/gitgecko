/**
 * Smoke test for the socket runtime — also the executable spec of the contract.
 * Run: pnpm --filter @gitgecko/socket test
 *
 * Each test proves one invariant from 03-plugin-socket-contract.md.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Registry, type Contribution, type OwnerSpec } from "./registry.js";
import { MANIFEST_SCHEMA_VERSION } from "./manifest.js";

// --- A toy owner for testing: "echo" with two capabilities -------------------

type EchoCap = "say" | "shout";
type EchoKind = "utterance";
interface EchoContrib extends Contribution {
  readonly kind: EchoKind;
  readonly id: string;
  readonly text: string;
  mutates?: boolean;
}

const echoOwner: OwnerSpec<EchoCap, EchoKind> = {
  name: "echo",
  capabilities: ["say", "shout"],
  kindFor: () => "utterance",
  // both exclusive by default
};

const manifest = (id: string, capabilities: EchoCap[], mutatesTools = false) => ({
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  id,
  name: id,
  owner: "echo",
  version: "0.1.0",
  description: `test plug ${id}`,
  capabilities,
  targets: { providers: [], plans: [], env: [] },
  dependencies: { requires: [], recommends: [] },
  permissions: { network: [], filesystem: [], env: [], mutatesTools },
  entrypoint: "./dist/plug.js",
  hooks: false,
  mcp: false,
});

const logger = { info() {}, warn() {}, error() {} };

describe("socket manifest validation", () => {
  it("accepts a well-formed manifest", async () => {
    const reg = new Registry<EchoCap, EchoKind, EchoContrib>(echoOwner);
    const res = await reg.load(
      {
        manifest: manifest("echo-hello", ["say"]),
        setup: (api) => {
          api.register("say", { kind: "utterance", id: "hello", text: "hi" });
        },
      },
      { config: {}, logger },
    );
    assert.ok(res.ok);
    assert.equal(res.value.contributions.length, 1);
  });

  it("rejects a manifest declaring an unknown capability (phase 2)", async () => {
    const reg = new Registry<EchoCap, EchoKind, EchoContrib>(echoOwner);
    // @ts-expect-error — intentionally wrong capability token
    const res = await reg.load({ manifest: manifest("bad", ["whisper"]) }, { config: {}, logger });
    assert.ok(!res.ok);
    assert.equal(res.error.code, "socket.unknown-capability");
  });

  it("rejects a capability-gated register call not in the manifest (phase 3)", async () => {
    const reg = new Registry<EchoCap, EchoKind, EchoContrib>(echoOwner);
    const res = await reg.load(
      {
        manifest: manifest("sneaky", ["say"]), // only declared "say"
        setup: (api) => {
          // "shout" is a valid EchoCap but NOT declared in this manifest's capabilities;
          // the registry rejects it at runtime (phase 3 capability gate).
          api.register("shout", { kind: "utterance", id: "yell", text: "HEY" });
        },
      },
      { config: {}, logger },
    );
    assert.ok(!res.ok);
    assert.equal(res.error.code, "socket.setup-failed");
  });

  it("rejects a declared capability that setup does not contribute", async () => {
    const reg = new Registry<EchoCap, EchoKind, EchoContrib>(echoOwner);
    const res = await reg.load(
      { manifest: manifest("empty", ["say"]), setup: () => {} },
      { config: {}, logger },
    );
    assert.ok(!res.ok);
    assert.equal(res.error.code, "socket.missing-contribution");
  });
});

describe("socket mutates gate (P-plugin-7)", () => {
  it("throws when mutatesTools:true but no mutating tools registered (empty deny list)", async () => {
    const reg = new Registry<EchoCap, EchoKind, EchoContrib>(echoOwner);
    const res = await reg.load(
      {
        manifest: manifest("empty-mutates", ["say"], true), // mutatesTools true
        setup: (api) => {
          // registers a NON-mutating tool → deny list empty → must throw
          api.register("say", { kind: "utterance", id: "safe", text: "hi", mutates: false });
        },
      },
      { config: {}, logger },
    );
    assert.ok(!res.ok);
    assert.equal(res.error.code, "socket.mutates-deny-empty");
  });

  it("builds the deny list from registered mutating tools", async () => {
    const reg = new Registry<EchoCap, EchoKind, EchoContrib>(echoOwner);
    const res = await reg.load(
      {
        manifest: manifest("mutating", ["say"], true),
        setup: (api) => {
          api.register("say", { kind: "utterance", id: "write-thing", text: "x", mutates: true });
        },
      },
      { config: {}, logger },
    );
    assert.ok(res.ok);
    assert.deepEqual([...res.value.mutatesDenyList], ["write-thing"]);
  });
});

describe("socket exclusive-capability conflict (phase 4)", () => {
  it("rejects a second plug claiming an already-held exclusive capability", async () => {
    const reg = new Registry<EchoCap, EchoKind, EchoContrib>(echoOwner);
    await reg.load(
      {
        manifest: manifest("first", ["say"]),
        setup: (api) => api.register("say", { kind: "utterance", id: "a", text: "a" }),
      },
      { config: {}, logger },
    );
    const res = await reg.load(
      {
        manifest: manifest("second", ["say"]),
        setup: (api) => api.register("say", { kind: "utterance", id: "b", text: "b" }),
      },
      { config: {}, logger },
    );
    assert.ok(!res.ok);
    assert.equal(res.error.code, "socket.capability-conflict");
  });
});

describe("socket permissions-grant validation (phase 2, 03 §3)", () => {
  it("rejects a manifest declaring an empty-string env permission token (mutatesTools)", async () => {
    const reg = new Registry<EchoCap, EchoKind, EchoContrib>(echoOwner);
    const res = await reg.load(
      {
        manifest: {
          ...manifest("bad-env", ["say"], true),
          permissions: { network: [], filesystem: [], env: [""], mutatesTools: true },
        },
        setup: (api) => api.register("say", { kind: "utterance", id: "w", text: "w", mutates: true }),
      },
      { config: {}, logger },
    );
    assert.ok(!res.ok, "empty-string env token must be rejected at validate");
    assert.equal(res.error.code, "socket.permissions-grant-invalid");
  });

  it("rejects a manifest declaring an empty-string env permission token (non-mutating)", async () => {
    const reg = new Registry<EchoCap, EchoKind, EchoContrib>(echoOwner);
    const res = await reg.load(
      {
        manifest: {
          ...manifest("bad-env-2", ["say"]),
          permissions: { network: [], filesystem: [], env: ["  "], mutatesTools: false },
        },
        setup: (api) => api.register("say", { kind: "utterance", id: "s", text: "s" }),
      },
      { config: {}, logger },
    );
    assert.ok(!res.ok, "whitespace-only env token must be rejected at validate");
    assert.equal(res.error.code, "socket.permissions-grant-invalid");
  });

  it("accepts a well-formed permissions block with real env tokens", async () => {
    const reg = new Registry<EchoCap, EchoKind, EchoContrib>(echoOwner);
    const res = await reg.load(
      {
        manifest: {
          ...manifest("good-env", ["say"], true),
          permissions: {
            network: ["api.example.com:443"],
            filesystem: [],
            env: ["REAL_TOKEN"],
            mutatesTools: true,
          },
        },
        setup: (api) => api.register("say", { kind: "utterance", id: "w", text: "w", mutates: true }),
      },
      { config: {}, logger },
    );
    assert.ok(res.ok, `well-formed permissions should pass: ${res.ok ? "" : res.error.message}`);
  });
});

describe("socket dependencies.requires presence (03 §3)", () => {
  it("rejects a plug whose hard dependency is not active (load deps in topo-order)", async () => {
    const reg = new Registry<EchoCap, EchoKind, EchoContrib>(echoOwner);
    let setupCalled = false;
    const res = await reg.load(
      {
        manifest: {
          ...manifest("dependent", ["say"]),
          dependencies: { requires: ["echo-base"], recommends: [] },
        },
        setup: (api) => {
          setupCalled = true;
          api.register("say", { kind: "utterance", id: "d", text: "d" });
        },
      },
      { config: {}, logger },
    );
    assert.ok(!res.ok, "should reject when a required plug is not active");
    assert.equal(res.error.code, "socket.missing-dependency");
    assert.match(res.error.message, /echo-base/);
    assert.equal(setupCalled, false, "dependency admission must happen before setup side effects");
  });

  it("accepts a plug whose hard dependency IS active (loaded first, topo-order)", async () => {
    const reg = new Registry<EchoCap, EchoKind, EchoContrib>(echoOwner);
    // Load the dependency first.
    const base = await reg.load(
      {
        manifest: manifest("echo-base", ["shout"]),
        setup: (api) => api.register("shout", { kind: "utterance", id: "base", text: "base" }),
      },
      { config: {}, logger },
    );
    assert.ok(base.ok, "dependency must load first");
    // Now load the dependent.
    const res = await reg.load(
      {
        manifest: {
          ...manifest("dependent-ok", ["say"]),
          dependencies: { requires: ["echo-base"], recommends: [] },
        },
        setup: (api) => api.register("say", { kind: "utterance", id: "d", text: "d" }),
      },
      { config: {}, logger },
    );
    assert.ok(res.ok, `dependent should load when its dep is active: ${res.ok ? "" : res.error.message}`);
  });

  it("a plug with no requires loads normally (backward-compat)", async () => {
    const reg = new Registry<EchoCap, EchoKind, EchoContrib>(echoOwner);
    const res = await reg.load(
      {
        manifest: manifest("standalone", ["say"]),
        setup: (api) => api.register("say", { kind: "utterance", id: "s", text: "s" }),
      },
      { config: {}, logger },
    );
    assert.ok(res.ok);
  });
});
