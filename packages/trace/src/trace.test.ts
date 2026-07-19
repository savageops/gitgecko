/**
 * TDD tests for the trace owner — the auditability wedge (G8, 05 §7).
 *
 * Challenges the CAPABILITY: record steps → read by runId → export JSON.
 * Multi-step runs, cost aggregation, source tagging.
 *
 * Per project TDD rule: written FIRST, fail, then code passes. Never weakened.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryTraceStore, type TraceRecord } from "./trace.js";

const step = (over: Partial<TraceRecord> & Pick<TraceRecord, "runId" | "stepId" | "command" | "source">): TraceRecord => ({
  ts: new Date().toISOString(),
  ...over,
});

describe("trace store — record + read", () => {
  it("records a step and reads it back by runId", () => {
    const store = new InMemoryTraceStore();
    store.record(step({ runId: "r1", stepId: "s1", command: "review", source: "llm", output: "LGTM" }));
    const trace = store.read("r1");
    assert.equal(trace.runId, "r1");
    assert.equal(trace.steps.length, 1);
    assert.equal(trace.steps[0]!.output, "LGTM");
  });

  it("records multiple steps for one run and reads them all", () => {
    const store = new InMemoryTraceStore();
    store.record(step({ runId: "r1", stepId: "s1", command: "review", source: "deterministic", ruleEvaluations: [{ ruleId: "no-console", line: 5, message: "x", source: "deterministic" }] }));
    store.record(step({ runId: "r1", stepId: "s2", command: "review", source: "llm", output: "review output" }));
    const trace = store.read("r1");
    assert.equal(trace.steps.length, 2);
    assert.equal(trace.steps[0]!.source, "deterministic");
    assert.equal(trace.steps[1]!.source, "llm");
  });

  it("isolates runs (different runIds don't cross-contaminate)", () => {
    const store = new InMemoryTraceStore();
    store.record(step({ runId: "r1", stepId: "s1", command: "review", source: "llm" }));
    store.record(step({ runId: "r2", stepId: "s1", command: "describe", source: "llm" }));
    assert.equal(store.read("r1").steps.length, 1);
    assert.equal(store.read("r2").steps.length, 1);
    assert.equal(store.read("r2").steps[0]!.command, "describe");
  });

  it("returns empty steps for an unknown runId", () => {
    const store = new InMemoryTraceStore();
    const trace = store.read("nonexistent");
    assert.equal(trace.steps.length, 0);
  });
});

describe("trace store — cost aggregation", () => {
  it("aggregates totalCost across steps", () => {
    const store = new InMemoryTraceStore();
    store.record(step({ runId: "r1", stepId: "s1", command: "review", source: "llm", cost: { tokensIn: 100, tokensOut: 50, usd: 0.01 } }));
    store.record(step({ runId: "r1", stepId: "s2", command: "review", source: "llm", cost: { tokensIn: 200, tokensOut: 100, usd: 0.02 } }));
    const trace = store.read("r1");
    assert.ok(trace.totalCost);
    assert.equal(trace.totalCost!.tokensIn, 300);
    assert.equal(trace.totalCost!.tokensOut, 150);
    assert.equal(trace.totalCost!.usd, 0.03);
  });

  it("omits totalCost when no steps have cost", () => {
    const store = new InMemoryTraceStore();
    store.record(step({ runId: "r1", stepId: "s1", command: "review", source: "deterministic" }));
    const trace = store.read("r1");
    assert.equal(trace.totalCost, undefined);
  });
});

describe("trace store — source tagging (the anti-noise contract)", () => {
  it("preserves the source tag (deterministic vs llm) on every step", () => {
    const store = new InMemoryTraceStore();
    store.record(step({ runId: "r1", stepId: "s1", command: "review", source: "deterministic" }));
    store.record(step({ runId: "r1", stepId: "s2", command: "review", source: "llm" }));
    const trace = store.read("r1");
    const sources = trace.steps.map((s) => s.source);
    assert.ok(sources.includes("deterministic"));
    assert.ok(sources.includes("llm"));
  });
});

describe("trace store — export (JSON)", () => {
  it("exportJson produces valid JSON with runId + steps", () => {
    const store = new InMemoryTraceStore();
    store.record(step({ runId: "r1", stepId: "s1", command: "review", source: "llm", output: "ok" }));
    const json = store.exportJson("r1");
    const parsed = JSON.parse(json);
    assert.equal(parsed.runId, "r1");
    assert.equal(parsed.steps.length, 1);
    assert.equal(parsed.steps[0].output, "ok");
  });

  it("exportJson includes totalCost when present", () => {
    const store = new InMemoryTraceStore();
    store.record(step({ runId: "r1", stepId: "s1", command: "review", source: "llm", cost: { tokensIn: 10, tokensOut: 5, usd: 0.001 } }));
    const parsed = JSON.parse(store.exportJson("r1"));
    assert.ok(parsed.totalCost);
    assert.equal(parsed.totalCost.tokensIn, 10);
  });
});

describe("trace store — full provenance (the auditability contract)", () => {
  it("carries model, prompt, retrievedContext, toolCalls, ruleEvaluations", () => {
    const store = new InMemoryTraceStore();
    store.record(step({
      runId: "r1", stepId: "s1", command: "review", source: "llm",
      model: "claude-sonnet-4-5",
      prompt: "Review this PR...",
      retrievedContext: [{ filepath: "src/auth.py", content: "def login(): pass" }],
      toolCalls: [{ tool: "search_code", input: { query: "login" }, result: "found" }],
      ruleEvaluations: [{ ruleId: "no-console", line: 3, message: "Avoid console.log", source: "deterministic" }],
      output: "Found 1 issue.",
      cost: { tokensIn: 500, tokensOut: 200, usd: 0.05 },
    }));
    const trace = store.read("r1");
    const s = trace.steps[0]!;
    assert.equal(s.model, "claude-sonnet-4-5");
    assert.ok(s.prompt!.includes("Review"));
    assert.equal(s.retrievedContext!.length, 1);
    assert.equal(s.toolCalls!.length, 1);
    assert.equal(s.ruleEvaluations!.length, 1);
    assert.equal(s.cost!.usd, 0.05);
  });
});
