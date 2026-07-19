/**
 * TDD tests for the mcp-gateway — G7, the open-MCP-server wedge.
 *
 * Challenges the CAPABILITY: register tools from owners, list them, dispatch
 * calls to the right owner capability, handle errors. The transport (stdio/
 * SSE/HTTP) is a thin envelope over this registry; the tool registry + dispatch
 * is the testable core.
 *
 * Per project TDD rule: written FIRST, fail, then code passes. Never weakened.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createToolRegistry, textResult, errorResult, type McpTool } from "./tool.js";

describe("tool registry — registration + listing", () => {
  it("registers a tool and lists it", () => {
    const reg = createToolRegistry();
    const tool: McpTool = {
      name: "search_code",
      description: "Search the codebase",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      handler: async () => textResult("results"),
    };
    reg.register(tool);
    const tools = reg.list();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, "search_code");
  });

  it("registers multiple tools from different owners", () => {
    const reg = createToolRegistry();
    reg.register({ name: "search_code", description: "d", inputSchema: {}, handler: async () => textResult("a") });
    reg.register({ name: "evaluate_rule", description: "d", inputSchema: {}, handler: async () => textResult("b") });
    reg.register({ name: "run_review", description: "d", inputSchema: {}, handler: async () => textResult("c") });
    assert.equal(reg.list().length, 3);
  });

  it("is idempotent: re-registering the same tool name doesn't duplicate", () => {
    const reg = createToolRegistry();
    const tool: McpTool = { name: "x", description: "d", inputSchema: {}, handler: async () => textResult("x") };
    reg.register(tool);
    reg.register(tool);
    assert.equal(reg.list().length, 1);
  });
});

describe("tool registry — dispatch", () => {
  it("calls a registered tool and returns its result", async () => {
    const reg = createToolRegistry();
    reg.register({
      name: "search_code",
      description: "Search",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      handler: async (args) => textResult(`searching for: ${args.query}`),
    });
    const result = await reg.call("search_code", { query: "login function" });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0]!.text, "searching for: login function");
  });

  it("returns an error result for an unknown tool", async () => {
    const reg = createToolRegistry();
    const result = await reg.call("nonexistent", {});
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("unknown tool"));
  });

  it("returns an error result when a tool handler throws", async () => {
    const reg = createToolRegistry();
    reg.register({
      name: "crash",
      description: "d",
      inputSchema: {},
      handler: async () => { throw new Error("kaboom"); },
    });
    const result = await reg.call("crash", {});
    assert.equal(result.isError, true);
    assert.ok(result.content[0]!.text.includes("kaboom"));
  });
});

describe("tool registry — MCP result shape", () => {
  it("textResult produces the correct MCP content shape", () => {
    const r = textResult("hello");
    assert.equal(r.content.length, 1);
    assert.equal(r.content[0]!.type, "text");
    assert.equal(r.content[0]!.text, "hello");
    assert.equal(r.isError, undefined);
  });

  it("errorResult produces the correct MCP error shape", () => {
    const r = errorResult("bad input");
    assert.equal(r.isError, true);
    assert.equal(r.content[0]!.text, "Error: bad input");
  });
});

describe("tool registry — the full G7 inversion (multiple owners expose tools)", () => {
  it("code-intel + rules + review all expose tools into one gateway", () => {
    const reg = createToolRegistry();
    // Simulate three exposer plugs registering their tools.
    reg.register({ name: "search_code", description: "Semantic code search", inputSchema: {}, handler: async () => textResult("code") });
    reg.register({ name: "get_repo_map", description: "Ranked repo map", inputSchema: {}, handler: async () => textResult("map") });
    reg.register({ name: "evaluate_rule", description: "Run a structural rule", inputSchema: {}, handler: async () => textResult("findings") });
    reg.register({ name: "run_review", description: "Review a PR", inputSchema: {}, handler: async () => textResult("review") });

    const names = reg.list().map((t) => t.name).sort();
    assert.ok(names.includes("search_code"));
    assert.ok(names.includes("get_repo_map"));
    assert.ok(names.includes("evaluate_rule"));
    assert.ok(names.includes("run_review"));
    assert.equal(reg.list().length, 4);
  });
});
