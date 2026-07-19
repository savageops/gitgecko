/**
 * TDD tests for the meta-tools mcp-gateway plug — proves each operational tool
 * produces correct output and the plug registers correctly against the socket.
 *
 * Per project TDD rule: tests challenge capability (each tool must produce real
 * output through its handler), never degraded to pass.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createMetaToolsExposer,
  setup,
  manifest,
  type MetaToolsDeps,
} from "./plug.js";
import type { ToolExposerContribution, ToolRegistry, McpTool } from "@gitgecko/mcp-gateway";

// --- Test helpers -----------------------------------------------------------

/** A minimal ToolRegistry that collects registered tools for inspection. */
const makeTestRegistry = (): { registry: ToolRegistry; tools: McpTool[] } => {
  const tools: McpTool[] = [];
  return {
    tools,
    registry: {
      register: (tool: McpTool) => tools.push(tool),
      list: () => tools,
      call: async () => { throw new Error("not used in these tests"); },
    },
  };
};

describe("meta-tools — list_plugs tool", () => {
  it("formats active plugs grouped by owner", async () => {
    const { registry, tools } = makeTestRegistry();
    const exposer = createMetaToolsExposer({
      listPlugs: async () => [
        { owner: "rules", plugId: "rules-evaluators", capabilities: ["evaluate"] },
        { owner: "rules", plugId: "rules-baseline-pack", capabilities: ["evaluate"] },
        { owner: "model", plugId: "model-anthropic", capabilities: ["complete"] },
      ],
    } as MetaToolsDeps);
    exposer.expose(registry);

    const tool = tools.find((t) => t.name === "list_plugs");
    assert.ok(tool, "list_plugs tool must be registered");
    const result = await tool!.handler({});
    assert.ok(result.content[0]!.text.includes("## rules"), "output groups by owner");
    assert.ok(result.content[0]!.text.includes("rules-evaluators"), "output includes plug ids");
    assert.ok(result.content[0]!.text.includes("rules-baseline-pack"), "output includes all plugs");
    assert.ok(result.content[0]!.text.includes("evaluate"), "output includes capabilities");
    assert.ok(!result.isError, "list_plugs returns a success result");
  });

  it("returns 'No active plugs' when the inventory is empty", async () => {
    const { registry, tools } = makeTestRegistry();
    const exposer = createMetaToolsExposer({ listPlugs: async () => [] } as MetaToolsDeps);
    exposer.expose(registry);
    const tool = tools.find((t) => t.name === "list_plugs")!;
    const result = await tool.handler({});
    assert.equal(result.content[0]!.text, "No active plugs.");
  });
});

describe("meta-tools — health_check tool", () => {
  it("returns ok status with detail", async () => {
    const { registry, tools } = makeTestRegistry();
    const exposer = createMetaToolsExposer({
      healthCheck: async () => ({ status: "ok", detail: "all owners live" }),
    } as MetaToolsDeps);
    exposer.expose(registry);

    const tool = tools.find((t) => t.name === "health_check")!;
    const result = await tool.handler({});
    assert.ok(result.content[0]!.text.includes("ok"), "health_check reports ok");
    assert.ok(result.content[0]!.text.includes("all owners live"), "health_check includes detail");
    assert.ok(!result.isError, "ok status is not an error");
  });

  it("returns an error result for degraded status", async () => {
    const { registry, tools } = makeTestRegistry();
    const exposer = createMetaToolsExposer({
      healthCheck: async () => ({ status: "degraded", detail: "model owner down" }),
    } as MetaToolsDeps);
    exposer.expose(registry);

    const tool = tools.find((t) => t.name === "health_check")!;
    const result = await tool.handler({});
    assert.ok(result.isError, "degraded status is an error result");
    assert.ok(result.content[0]!.text.includes("degraded"), "error includes status");
    assert.ok(result.content[0]!.text.includes("model owner down"), "error includes detail");
  });

  it("returns an error result for down status", async () => {
    const { registry, tools } = makeTestRegistry();
    const exposer = createMetaToolsExposer({
      healthCheck: async () => ({ status: "down" }),
    } as MetaToolsDeps);
    exposer.expose(registry);

    const tool = tools.find((t) => t.name === "health_check")!;
    const result = await tool.handler({});
    assert.ok(result.isError, "down status is an error result");
  });
});

describe("meta-tools — describe_models tool", () => {
  it("lists the model catalog with ids, names, and descriptions", async () => {
    const { registry, tools } = makeTestRegistry();
    const exposer = createMetaToolsExposer({
      describeModels: async () => [
        { id: "gitgecko-light", name: "GitGecko Light", description: "Fast model for reviews." },
        { id: "gitgecko-high", name: "GitGecko High", description: "High-capability model." },
      ],
    } as MetaToolsDeps);
    exposer.expose(registry);

    const tool = tools.find((t) => t.name === "describe_models")!;
    const result = await tool.handler({});
    assert.ok(result.content[0]!.text.includes("gitgecko-light"), "output includes model id");
    assert.ok(result.content[0]!.text.includes("GitGecko Light"), "output includes model name");
    assert.ok(result.content[0]!.text.includes("gitgecko-high"), "output includes both models");
    assert.ok(!result.isError, "describe_models returns a success result");
  });

  it("returns 'No models configured' when the catalog is empty", async () => {
    const { registry, tools } = makeTestRegistry();
    const exposer = createMetaToolsExposer({ describeModels: async () => [] } as MetaToolsDeps);
    exposer.expose(registry);
    const tool = tools.find((t) => t.name === "describe_models")!;
    const result = await tool.handler({});
    assert.equal(result.content[0]!.text, "No models configured.");
  });
});

describe("meta-tools — exposer registration behavior", () => {
  it("registers exactly 3 tools when all deps are wired", () => {
    const { registry, tools } = makeTestRegistry();
    const exposer = createMetaToolsExposer({
      listPlugs: async () => [],
      healthCheck: async () => ({ status: "ok" }),
      describeModels: async () => [],
    } as MetaToolsDeps);
    exposer.expose(registry);
    assert.equal(tools.length, 3, "all three tools registered");
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["describe_models", "health_check", "list_plugs"]);
  });

  it("registers only the tools with wired deps (partial wiring)", () => {
    const { registry, tools } = makeTestRegistry();
    const exposer = createMetaToolsExposer({
      healthCheck: async () => ({ status: "ok" }),
    } as MetaToolsDeps);
    exposer.expose(registry);
    assert.equal(tools.length, 1, "only health_check registered");
    assert.equal(tools[0]!.name, "health_check");
  });

  it("registers zero tools when no deps are wired (inert)", () => {
    const { registry, tools } = makeTestRegistry();
    const exposer = createMetaToolsExposer({} as MetaToolsDeps);
    exposer.expose(registry);
    assert.equal(tools.length, 0, "no tools registered when no deps wired");
  });

  it("every tool has a non-empty description and a valid JSON Schema input", () => {
    const { registry, tools } = makeTestRegistry();
    const exposer = createMetaToolsExposer({
      listPlugs: async () => [],
      healthCheck: async () => ({ status: "ok" }),
      describeModels: async () => [],
    } as MetaToolsDeps);
    exposer.expose(registry);
    for (const tool of tools) {
      assert.ok(tool.description.length > 20, `tool ${tool.name} must have a meaningful description`);
      assert.equal(tool.inputSchema.type, "object", `tool ${tool.name} must have an object inputSchema`);
      assert.ok(!tool.mutates, `tool ${tool.name} must not mutate (read-only meta tools)`);
    }
  });
});

describe("meta-tools — plug setup registers a contribution", () => {
  it("registers a tool-exposer contribution through setup()", async () => {
    const contributions: ToolExposerContribution[] = [];
    await setup({ register: (_cap, c) => contributions.push(c) });
    assert.equal(contributions.length, 1, "setup registers exactly one contribution");
    assert.equal(contributions[0]!.id, "mcp-meta-tools");
    assert.equal(contributions[0]!.kind, "tool-exposer");
    assert.equal(contributions[0]!.mutates, false);
  });

  it("the manifest declares the mcp-gateway owner and expose capability", () => {
    assert.equal(manifest.owner, "mcp-gateway");
    assert.ok(manifest.capabilities.includes("expose"));
    assert.equal(manifest.id, "mcp-gateway-meta-tools");
    assert.equal(manifest.mcp, true, "meta-tools plug declares mcp: true");
  });
});
