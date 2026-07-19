/**
 * TDD tests for `gitgecko doctor` — the self-diagnostic command.
 *
 * Challenges the CAPABILITY (observable contracts), not implementation:
 *  - node version check (ok below MIN_NODE_MAJOR)
 *  - native-agent detection (the A13 wedge) — multiple, none, preference order
 *  - model-key/endpoint presence (BYOK)
 *  - pathway resolution + the readiness verdict
 *
 * Pure unit tests: the native probe is INJECTED (no real subprocess). Per project
 * TDD rule: written FIRST, challenges capability, never weakened.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRealNativeProbe, runDoctor, renderDoctor, GITGECKO_VERSION, type NativeProbe } from "./doctor.js";

const probeNone: NativeProbe = () => false;
const probeAll: NativeProbe = () => true;
const probeClaudeOnly: NativeProbe = (b) => b === "claude";

describe("doctor — runDoctor", () => {
  it("uses a host-compatible executable probe", () => {
    assert.equal(createRealNativeProbe()(process.execPath), true);
  });

  it("reports the version", () => {
    const r = runDoctor({}, probeNone);
    assert.equal(r.version, GITGECKO_VERSION);
  });

  it("includes a node-version check", () => {
    const r = runDoctor({}, probeNone);
    const nodeCheck = r.checks.find((c) => c.label.startsWith("node "));
    assert.ok(nodeCheck, "must have a node check");
    assert.match(nodeCheck!.label, /node \d+/);
  });

  it("detects multiple installed coding CLIs (the A13 wedge)", () => {
    const r = runDoctor({}, probeAll);
    const cliCheck = r.checks.find((c) => c.label.includes("installed coding CLI"));
    assert.ok(cliCheck, "must have an installed-CLI check");
    assert.match(cliCheck!.label, /claude.*codex.*opencode|codex.*claude/, "must list detected CLIs");
  });

  it("reports when no supported coding CLI is on PATH", () => {
    const r = runDoctor({}, probeNone);
    assert.ok(r.checks.some((c) => c.label.includes("no supported coding CLI found")));
  });

  it("detects ANTHROPIC_API_KEY", () => {
    const r = runDoctor({ ANTHROPIC_API_KEY: "sk-test" }, probeNone);
    assert.ok(r.checks.some((c) => c.label.includes("ANTHROPIC_API_KEY")), "must report the anthropic key");
  });

  it("detects OPENAI_API_KEY", () => {
    const r = runDoctor({ OPENAI_API_KEY: "sk-test" }, probeNone);
    assert.ok(r.checks.some((c) => c.label.includes("OPENAI_API_KEY")), "must report the openai key");
  });

  it("detects GITGECKO_LOCAL_BASE_URL", () => {
    const r = runDoctor({ GITGECKO_LOCAL_BASE_URL: "http://localhost:1234/v1" }, probeNone);
    assert.ok(r.checks.some((c) => c.label.includes("GITGECKO_LOCAL_BASE_URL")), "must report the local endpoint");
  });

  it("detects OPENAI_BASE_URL as a compatible local endpoint", () => {
    const r = runDoctor({ OPENAI_BASE_URL: "http://localhost:1234/v1" }, probeNone);
    assert.ok(r.checks.some((c) => c.label.includes("OPENAI_BASE_URL")));
    assert.match(r.verdict, /Available/i);
  });

  it("recognizes a validated saved provider without requiring environment routing", () => {
    const r = runDoctor({}, probeNone, { baseUrl: "http://localhost:1234/v1", model: "qwen", protocol: "openai-responses" });
    assert.ok(r.checks.some((check) => check.label.includes("saved local endpoint")));
    assert.match(r.verdict, /Available/i);
  });

  it("does NOT report a key that is absent", () => {
    const r = runDoctor({}, probeNone);
    assert.ok(!r.checks.some((c) => c.label.includes("API_KEY")), "absent keys must not appear");
  });
});

describe("doctor — pathway resolution + verdict", () => {
  it("uses the only detected native provider", () => {
    const r = runDoctor({}, probeClaudeOnly);
    assert.deepEqual(r.pathway, { kind: "native", binary: "claude" });
    assert.match(r.verdict, /claude \(installed CLI\)/);
    assert.match(r.verdict, /gitgecko review/i);
    assert.match(r.verdict, /authentication is verified when the CLI starts/i);
  });

  it("resolves the built-in loop when only a direct API key is set", () => {
    const r = runDoctor({ OPENAI_API_KEY: "sk-x" }, probeNone);
    assert.deepEqual(r.pathway, { kind: "native-loop" });
    assert.match(r.verdict, /API-backed model route/);
    assert.match(r.verdict, /gitgecko review/i);
  });

  it("resolves Pi when only a local endpoint is set", () => {
    const r = runDoctor({ GITGECKO_LOCAL_BASE_URL: "http://x" }, probeNone);
    assert.equal(r.pathway!.kind, "pi");
    assert.match(r.verdict, /Available/i);
  });

  it("resolves Pi for a saved local provider", () => {
    const r = runDoctor({}, probeNone, { baseUrl: "http://localhost:1234/v1", model: "qwen", protocol: "openai-responses" });
    assert.deepEqual(r.pathway, { kind: "pi" });
    assert.match(r.verdict, /configured model provider/);
  });

  it("reports the deterministic first-run pathway when no agent, key, or endpoint exists", () => {
    const r = runDoctor({}, probeNone);
    assert.deepEqual(r.pathway, { kind: "deterministic" });
    assert.match(r.verdict, /rule-only review/i);
    assert.match(r.verdict, /gitgecko review/i);
  });

  it("prefers Codex when every native provider is detected", () => {
    const r = runDoctor({}, probeAll);
    assert.deepEqual(r.pathway, { kind: "native", binary: "codex" });
    assert.match(r.verdict, /codex \(installed CLI\)/);
  });

  it("prefers an installed CLI over an API-backed model route when both are available", () => {
    const r = runDoctor({ OPENAI_API_KEY: "sk-x" }, probeAll);
    assert.equal(r.pathway!.kind, "native", "installed CLI should win even with a key set");
    assert.match(r.verdict, /installed CLI/);
  });
});

describe("doctor — renderDoctor", () => {
  it("renders the header with version", () => {
    const out = renderDoctor(runDoctor({}, probeNone));
    assert.match(out, new RegExp(`gitgecko ${GITGECKO_VERSION} — doctor`));
  });

  it("renders each check with a ✓ or ✗ mark", () => {
    const out = renderDoctor(runDoctor({}, probeAll));
    assert.match(out, /✓/);
  });

  it("renders the verdict last, after a blank line", () => {
    const out = renderDoctor(runDoctor({ OPENAI_API_KEY: "x" }, probeNone));
    assert.match(out, /\n\n  → .+/);
    assert.match(out, /gitgecko review/i);
  });
});
