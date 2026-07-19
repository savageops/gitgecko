/**
 * TDD tests for the pathway selector + gitgecko-local config mapping.
 *
 * Challenges the CAPABILITY: resolve a PathwaySpec to a PathwayResolution
 * with the right precedence (auto: native → local → loop) while preserving the
 * canonical model-client protocol selection.
 *
 * Per project TDD rule: written FIRST, fail, then code passes. Never weakened.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAgentForResolution, resolvePathway, buildAgentRegistry, resolveAgent, type LocalEndpointConfig, type PathwaySpec } from "./pathways.js";
import { detectNativeAgents, type BinaryProbe } from "./native-agents.js";
import type { Agent, AgentRunContext, AgentResult } from "./agent.js";

describe("pathway selector — auto mode precedence", () => {
  it("auto prefers native when a binary is available", () => {
    const r = resolvePathway({ kind: "auto" }, ["claude"]);
    assert.equal(r.family, "native");
    assert.equal(r.binary, "claude");
  });

  it("auto selects Pi when no native CLI but a model endpoint is configured", () => {
    const config: LocalEndpointConfig = { modelId: "llama-4", baseUrl: "http://localhost:1234/v1", protocol: "openai-chat-completions" };
    const r = resolvePathway({ kind: "auto" }, [], config);
    assert.equal(r.family, "pi");
    assert.equal(r.localConfig?.modelId, "llama-4");
  });

  it("auto falls to native-loop when no native + no local config", () => {
    const r = resolvePathway({ kind: "auto" }, []);
    assert.equal(r.family, "native-loop");
  });

  it("auto falls to deterministic when no executable inference backend exists", () => {
    const r = resolvePathway({ kind: "auto" }, [], undefined, false);
    assert.deepEqual(r, {
      family: "deterministic",
      reason: "auto: no native agent, local endpoint, or inference provider",
    });
  });

  it("auto native preference order: codex > claude > opencode", () => {
    const r = resolvePathway({ kind: "auto" }, ["codex", "opencode", "claude"]);
    assert.equal(r.binary, "codex");
  });
});

describe("pathway selector — explicit modes", () => {
  it("explicit native:claude uses claude regardless of availability", () => {
    const r = resolvePathway({ kind: "native", binary: "claude" }, []);
    assert.equal(r.family, "native");
    assert.equal(r.binary, "claude");
  });

  it("explicit native (no binary) auto-detects among available", () => {
    const r = resolvePathway({ kind: "native" }, ["opencode"]);
    assert.equal(r.family, "native");
    assert.equal(r.binary, "opencode");
  });

  it("explicit native with no available binary fails closed on the native pathway", () => {
    const r = resolvePathway({ kind: "native" }, []);
    assert.equal(r.family, "native");
  });

  it("the local compatibility alias resolves to Pi with the provided config", () => {
    const config: LocalEndpointConfig = { modelId: "m", baseUrl: "http://x", protocol: "openai-responses" };
    const r = resolvePathway({ kind: "local", config }, []);
    assert.equal(r.family, "pi");
    assert.equal(r.localConfig?.baseUrl, "http://x");
  });

  it("explicit local preserves Anthropic Messages endpoints", () => {
    const config: LocalEndpointConfig = { modelId: "m", baseUrl: "http://x", protocol: "anthropic-messages" };
    assert.equal(resolvePathway({ kind: "local", config }, []).localConfig?.protocol, "anthropic-messages");
  });

  it("explicit native-loop always uses the loop", () => {
    const r = resolvePathway({ kind: "native-loop" }, ["claude"]);
    assert.equal(r.family, "native-loop");
  });

  it("explicit deterministic never selects an inference backend", () => {
    const resolution = resolvePathway({ kind: "deterministic" }, ["claude"]);
    assert.equal(resolution.family, "deterministic");
    assert.equal(resolveAgent({}, resolution), null);
  });
});

describe("canonical agent factory capability truth", () => {
  it("routes PI through the injected coding-agent factory", () => {
    const config: LocalEndpointConfig = { modelId: "m", baseUrl: "http://127.0.0.1:1234/v1", protocol: "openai-chat-completions" };
    let received: LocalEndpointConfig | undefined;
    const pi = makeFakeAgent("pi");
    const agent = createAgentForResolution(
      { family: "pi", localConfig: config },
      { piFactory: (candidate) => { received = candidate; return pi; } },
      () => makeFakeAgent("gitgecko-native"),
    );
    assert.equal(agent, pi);
    assert.equal(received, config);
  });

  it("fails closed when PI is selected without its coding-agent plug", async () => {
    const agent = createAgentForResolution(
      { family: "pi", localConfig: { modelId: "m", baseUrl: "http://127.0.0.1:1234/v1", protocol: "openai-chat-completions" } },
      {},
      (complete) => ({
        ...makeFakeAgent("gitgecko-native"),
        run: async () => {
          try { return { success: true, output: await complete("review") }; }
          catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
        },
      }),
    );
    const result = await agent.run({} as AgentRunContext);
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /PI coding-agent runtime is unavailable/u);
  });

  it("fails when no native, local, or model backend can execute", async () => {
    const agent = createAgentForResolution(
      { family: "native-loop" },
      {},
      (complete) => ({
        name: "test-loop",
        install: async () => "test-loop",
        run: async () => {
          try {
            return { success: true, output: await complete("review") };
          } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
      }),
    );

    const result = await agent.run({} as AgentRunContext);
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /No model configured/);
  });
});

// --- Phase 4.3: integrated detect → resolve → build → run pathway test --------

/**
 * Fake agents for the integrated pathway test. Each records its name when run.
 */
const makeFakeAgent = (name: string): Agent => ({
  name: name as Agent["name"],
  install: async () => `${name} (fake)`,
  run: async (ctx: AgentRunContext): Promise<AgentResult> => {
    ctx.toolState.calls.push({ tool: `${name}.run`, input: null });
    return { success: true, output: `review from ${name}` };
  },
});

const fakePool: Readonly<Record<string, Agent>> = {
  "claude-code": makeFakeAgent("claude-code"),
  codex: makeFakeAgent("codex"),
  opencode: makeFakeAgent("opencode"),
  "gitgecko-native": makeFakeAgent("gitgecko-native"),
  "gitgecko-local": makeFakeAgent("pi"),
};

const makeRunCtx = (): AgentRunContext => ({
  payload: { repo: "r", prNumber: 1, title: "t", diff: "d", files: [] },
  cwd: process.cwd(),
  permission: "read-only",
  persistence: "ephemeral",
  mcpServerUrl: "",
  tmpdir: "/tmp",
  subagentDeniedTools: [],
  instructions: { systemPrompt: "s", rules: [] },
  toolState: { calls: [] },
  apiToken: "",
}) as AgentRunContext;

describe("integrated pathway — detect → resolve → build → run (Phase 4.3)", () => {
  it("detects claude on PATH → resolves native → builds registry → runs claude-code", async () => {
    // 1. DETECT: fake probe reports only claude available.
    const probe: BinaryProbe = (b) => b === "claude";
    const detection = detectNativeAgents(probe);
    assert.equal(detection.preferred, "claude");

    // 2. RESOLVE: auto pathway → native:claude.
    const resolution = resolvePathway({ kind: "auto" }, detection.available);
    assert.equal(resolution.family, "native");
    assert.equal(resolution.binary, "claude");

    // 3. BUILD: populate the AgentRegistry from the pool + resolution.
    const registry = buildAgentRegistry(fakePool, resolution);
    assert.ok(registry["claude-code"], "registry must contain claude-code");
    assert.ok(registry["gitgecko-native"], "registry must always contain the fallback");

    // 4. RUN: resolve the active agent + invoke it.
    const agent = resolveAgent(registry, resolution);
    assert.ok(agent, "must resolve an agent");
    assert.equal(agent!.name, "claude-code");
    const ctx = makeRunCtx();
    const result = await agent!.run(ctx);
    assert.equal(result.success, true);
    assert.match(result.output!, /review from claude-code/);
  });

  it("detects no native → resolves native-loop → builds registry → runs gitgecko-native", async () => {
    const probe: BinaryProbe = () => false;
    const detection = detectNativeAgents(probe);
    assert.equal(detection.preferred, null);

    const resolution = resolvePathway({ kind: "auto" }, detection.available);
    assert.equal(resolution.family, "native-loop");

    const registry = buildAgentRegistry(fakePool, resolution);
    assert.ok(registry["gitgecko-native"], "fallback must be present");
    assert.equal(registry["claude-code"], undefined, "claude-code must NOT be wired for native-loop");

    const agent = resolveAgent(registry, resolution);
    assert.equal(agent?.name, "gitgecko-native");
    const result = await agent!.run(makeRunCtx());
    assert.match(result.output!, /review from gitgecko-native/);
  });

  it("detects codex+opencode (no claude) → preference picks codex", async () => {
    const probe: BinaryProbe = (b) => b === "codex" || b === "opencode";
    const detection = detectNativeAgents(probe);
    assert.equal(detection.preferred, "codex");

    const resolution = resolvePathway({ kind: "auto" }, detection.available);
    assert.equal(resolution.binary, "codex");

    const registry = buildAgentRegistry(fakePool, resolution);
    const agent = resolveAgent(registry, resolution);
    assert.equal(agent?.name, "codex");
  });

  it("explicit local pathway → builds registry with gitgecko-local → runs it", async () => {
    const config: LocalEndpointConfig = { modelId: "m", baseUrl: "http://x", protocol: "openai-chat-completions" };
    const resolution = resolvePathway({ kind: "local", config }, []);
    assert.equal(resolution.family, "pi");

    const registry = buildAgentRegistry(fakePool, resolution);
    assert.ok(registry["gitgecko-local"], "local pathway must wire gitgecko-local");

    const agent = resolveAgent(registry, resolution);
    assert.equal(agent?.name, "pi");
  });

  it("buildAgentRegistry always includes the fallback (native-loop safety net)", () => {
    // Even when resolving native, the fallback is in the registry for graceful degradation.
    const resolution = resolvePathway({ kind: "native", binary: "claude" }, []);
    const registry = buildAgentRegistry(fakePool, resolution);
    assert.ok(registry["gitgecko-native"], "fallback must always be present");
  });
});
