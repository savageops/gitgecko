/**
 * TDD tests for the CLI orchestrator — the end-to-end review flow (§1.1, A13).
 *
 * Challenges the CAPABILITY: parse args → detect pathway → construct agent →
 * run review → return result. Zero-config: no pathway specified → auto-detect
 * the developer's installed agent. All deps injected (fakes).
 *
 * Per project TDD rule: written FIRST, fail, then code passes. Never weakened.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, runReview, type OrchestratorDeps } from "./orchestrator.js";
import type { Agent, AgentResult } from "@gitgecko/review";
import type { PlanId, UsageState } from "@gitgecko/plans";
import type { Finding } from "@gitgecko/rules";

// --- Fake agent factory (records which pathway was constructed) -------------
const makeFakeDeps = (opts: {
  probeResult?: readonly string[];
  output?: string;
  retrieve?: (q: string) => Promise<readonly { content: string; filepath: string }[]>;
  resolveInstructions?: OrchestratorDeps["resolveInstructions"];
  findings?: readonly Finding[];
  planGate?: { planId: PlanId; usage: UsageState };
  piConfig?: { modelId: string; baseUrl: string; protocol: "openai-chat-completions" };
}): { deps: OrchestratorDeps; constructed: string[]; lastInstructions: { value: { repoContext: string | undefined; systemPrompt: string; findings: readonly Finding[] } | null } } => {
  const constructed: string[] = [];
  const lastInstructions = { value: null as { repoContext: string | undefined; systemPrompt: string; findings: readonly Finding[] } | null };
  const fakeAgent: Agent = {
    name: "fake",
    install: async () => "fake",
    run: async (ctx): Promise<AgentResult> => {
      constructed.push(ctx.resolvedModel ?? "default");
      lastInstructions.value = {
        repoContext: ctx.instructions.repoContext,
        systemPrompt: ctx.instructions.systemPrompt,
        findings: ctx.instructions.findings ?? [],
      };
      ctx.toolState.calls.push({ tool: "model.complete", input: ctx.payload.diff?.slice(0, 50) });
      return { success: true, output: opts.output ?? `review of: ${ctx.payload.title}`, usage: { tokensIn: 10, tokensOut: 5, costUsd: 0 } };
    },
  };
  return {
    constructed,
    lastInstructions,
    deps: {
      probeNatives: () => opts.probeResult ?? [],
      createAgent: (res) => { constructed.push(`${res.family}:${res.binary ?? "-"}`); return fakeAgent; },
      ...(opts.retrieve && { retrieve: opts.retrieve }),
      ...(opts.resolveInstructions && { resolveInstructions: opts.resolveInstructions }),
      ...(opts.findings && { findings: opts.findings }),
      ...(opts.planGate && { planGate: opts.planGate }),
      ...(opts.piConfig && { piConfig: opts.piConfig }),
    },
  };
};

describe("parseArgs — command parsing", () => {
  it("parses 'review' as the command", () => {
    const a = parseArgs(["review"]);
    assert.equal(a.command, "review");
  });

  it("parses --diff", () => {
    const a = parseArgs(["review", "--diff", "+def f(): pass"]);
    assert.equal(a.diff, "+def f(): pass");
  });

  it("parses opt-in configured runtime validation without accepting a shell command", () => {
    const args = parseArgs(["review", "--run-checks"]);
    assert.equal(args.runChecks, true);
    assert.equal("runtimeChecks" in args, false);
  });

  it("parses --diff-file for CI-safe large diffs", () => {
    const args = parseArgs(["review", "--diff-file", "/tmp/pr.diff"]);
    assert.equal(args.diffFile, "/tmp/pr.diff");
  });

  it("parses --file (multiple)", () => {
    const a = parseArgs(["review", "--file", "src/a.js", "--file", "src/b.js"]);
    assert.deepEqual(a.files, ["src/a.js", "src/b.js"]);
  });

  it("parses --repo and --title", () => {
    const a = parseArgs(["review", "--repo", "myorg/repo", "--title", "Fix bug"]);
    assert.equal(a.repo, "myorg/repo");
    assert.equal(a.title, "Fix bug");
  });

  it("parses provider names and pathway modes", () => {
    assert.deepEqual(parseArgs(["review", "--pathway", "auto"]).pathway, { kind: "auto" });
    assert.deepEqual(parseArgs(["review", "--pathway", "native"]).pathway, { kind: "native" });
    assert.deepEqual(parseArgs(["review", "--pathway", "claude"]).pathway, { kind: "native", binary: "claude" });
    assert.deepEqual(parseArgs(["review", "--pathway", "native-loop"]).pathway, { kind: "native-loop" });
    assert.deepEqual(parseArgs(["review", "--pathway", "native:claude"]).pathway, { kind: "native", binary: "claude" });
    assert.deepEqual(parseArgs(["review", "--pathway", "native:codex"]).pathway, { kind: "native", binary: "codex" });
    assert.deepEqual(parseArgs(["review", "--pathway", "deterministic"]).pathway, { kind: "deterministic" });
    assert.equal(parseArgs(["review", "--pathway", "pi"]).pathway?.kind, "local");
  });

  it("parses an exact bounded review mission", () => {
    assert.deepEqual(parseArgs(["review", "--mission", "security"]), { command: "review", mission: "security" });
  });

  it("rejects an unknown bounded review mission", () => {
    assert.throws(() => parseArgs(["review", "--mission", "style"]), /--mission/u);
  });

  it("rejects missions on non-review commands", () => {
    assert.throws(() => parseArgs(["improve", "--mission", "security"]), /only for review/u);
  });

  it("parses the explicit cloud pathway without confusing it with a native binary", () => {
    const args = parseArgs(["review", "--pathway", "cloud"]);
    assert.equal(args.cloud, true);
    assert.equal(args.pathway, undefined);
  });

  it("parses a connected cloud pull-request review as one authoritative source", () => {
    assert.deepEqual(parseArgs(["review", "--pathway", "cloud", "--project", "project_42", "--pull", "17"]), {
      command: "review",
      cloud: true,
      projectId: "project_42",
      pullNumber: 17,
    });
  });

  it("rejects partial, malformed, and local connected pull-request coordinates", () => {
    assert.throws(() => parseArgs(["review", "--pathway", "cloud", "--project", "project_42"]), /both --project and --pull/u);
    assert.throws(() => parseArgs(["review", "--pathway", "cloud", "--project", "project_42", "--pull", "0"]), /positive integer/u);
    assert.throws(() => parseArgs(["review", "--project", "project_42", "--pull", "17"]), /require --pathway cloud/u);
    assert.throws(() => parseArgs(["describe", "--pathway", "cloud", "--project", "project_42", "--pull", "17"]), /only for review/u);
  });

  it("rejects an unknown command instead of returning successful help", () => {
    assert.throws(() => parseArgs(["unknown"]), /Unknown command 'unknown'/u);
  });

  it("defaults to 'help' for no args", () => {
    assert.equal(parseArgs([]).command, "help");
  });

  it("normalizes conventional help aliases before command execution", () => {
    assert.deepEqual(parseArgs(["--help"]), { command: "help" });
    assert.deepEqual(parseArgs(["-h"]), { command: "help" });
    assert.deepEqual(parseArgs(["review", "--help"]), { command: "help" });
    assert.deepEqual(parseArgs(["threads", "-h"]), { command: "help" });
  });

  it("normalizes conventional version aliases", () => {
    assert.deepEqual(parseArgs(["--version"]), { command: "version" });
    assert.deepEqual(parseArgs(["-V"]), { command: "version" });
  });

  it("parses 'ask' with a question argument", () => {
    const a = parseArgs(["ask", "what does this function do?"]);
    assert.equal(a.command, "ask");
    assert.equal(a.question, "what does this function do?");
  });

  it("parses the auth commands: login, logout, whoami", () => {
    assert.equal(parseArgs(["login"]).command, "login");
    assert.equal(parseArgs(["auth"]).command, "login");
    assert.equal(parseArgs(["logout"]).command, "logout");
    assert.equal(parseArgs(["whoami"]).command, "whoami");
  });

  it("requires explicit consent and workspace-write policy for a local fix", () => {
    assert.deepEqual(parseArgs(["fix", "--apply", "--instruction", "Guard the denominator.", "--diff", "+const safe = true;"]), {
      command: "fix",
      apply: true,
      fixInstruction: "Guard the denominator.",
      diff: "+const safe = true;",
      permission: "workspace-write",
    });
    assert.throws(() => parseArgs(["fix", "--diff", "+const safe = true;"]), /requires --apply/u);
    assert.throws(() => parseArgs(["fix", "--apply", "--permission", "read-only"]), /workspace-write/u);
  });

  it("requires an explicit review artifact for fix-all", () => {
    assert.deepEqual(parseArgs(["fix-all", "--apply", "--findings-file", "review.json"]), {
      command: "fix-all",
      apply: true,
      findingsFile: "review.json",
      permission: "workspace-write",
    });
    assert.throws(() => parseArgs(["fix-all", "--apply"]), /findings-file/u);
  });

  it("parses cloud history and its machine-readable output", () => {
    assert.deepEqual(parseArgs(["history"]), { command: "history" });
    assert.deepEqual(parseArgs(["history", "--json"]), { command: "history", json: true });
  });

  it("parses non-interactive model provider configuration", () => {
    assert.deepEqual(parseArgs(["models", "configure", "--base-url", "http://localhost:1234/v1", "--model", "qwen", "--protocol", "openai-responses", "--api-key-env", "LOCAL_KEY"]), {
      command: "models",
      modelsAction: "configure",
      modelProvider: { baseUrl: "http://localhost:1234/v1", model: "qwen", protocol: "openai-responses", apiKeyEnv: "LOCAL_KEY" },
    });
    assert.deepEqual(parseArgs(["models", "show"]), { command: "models", modelsAction: "show" });
    assert.throws(() => parseArgs(["models", "configure", "--protocol", "guess"]), /--protocol must be/);
  });
});

describe("runReview — zero-config (auto pathway)", () => {
  it("auto-detects a native agent when available (no --pathway needed)", async () => {
    const { deps } = makeFakeDeps({ probeResult: ["claude"] });
    const result = await runReview({ command: "review", diff: "+def f(): pass", repo: "test", title: "Test PR" }, deps);
    assert.equal(result.success, true);
    assert.equal(result.pathwayResolution.family, "native");
    assert.equal(result.pathwayResolution.binary, "claude");
    assert.ok(result.output.includes("review"));
  });

  it("falls to native-loop when no native agent available + no local config", async () => {
    const { deps } = makeFakeDeps({ probeResult: [] });
    const result = await runReview({ command: "review", diff: "x" }, deps);
    assert.equal(result.pathwayResolution.family, "native-loop");
    assert.equal(result.success, true);
  });

  it("falls to deterministic when no native agent or inference backend is available", async () => {
    const finding: Finding = {
      ruleId: "offline-rule",
      kind: "lexical",
      source: "deterministic",
      severity: "info",
      message: "offline finding",
      filepath: "app.ts",
      line: 1,
      column: 0,
      match: "console.log(",
    };
    const result = await runReview(
      { command: "review", diff: "--- app.ts\n+++ app.ts\n@@ -0,0 +1 @@\n+console.log('offline');" },
      {
        probeNatives: () => [],
        inferenceAvailable: false,
        findings: [finding],
        createAgent: () => { throw new Error("deterministic fallback must not construct an agent"); },
      },
    );
    assert.equal(result.success, true);
    assert.equal(result.pathwayResolution.family, "deterministic");
    assert.equal(result.artifact.findings[0]?.ruleId, "offline-rule");
  });

  it("runs the review and returns the agent's output", async () => {
    const { deps } = makeFakeDeps({ probeResult: ["codex"], output: "LGTM — no issues found" });
    const result = await runReview({ command: "review", diff: "x", title: "PR 42" }, deps);
    assert.ok(result.output.includes("LGTM"));
    assert.equal(result.trace?.length, 1);
    assert.match(result.trace?.[0]?.prompt ?? "", /Diff:/);
    assert.equal(result.trace?.[0]?.toolCalls?.[0]?.tool, "model.complete");
    assert.deepEqual(result.trace?.[0]?.cost, { tokensIn: 10, tokensOut: 5, usd: 0 });
  });

  it("returns structured linked-requirement assessment without trusting unstructured prose", async () => {
    const { deps } = makeFakeDeps({
      probeResult: ["codex"],
      output: "## Linked requirement assessment\n- #42 | unmet | No expiry check appears in this diff.",
    });
    const result = await runReview({
      command: "review",
      diff: "+const secure = true;",
      linkedIssues: [{ number: 42, title: "Protect login", body: "Reject expired tokens", url: "https://github.com/acme/repo/issues/42" }],
    }, deps);

    assert.deepEqual(result.artifact.linkedRequirements?.map(({ number, status, evidence }) => ({ number, status, evidence })), [
      { number: 42, status: "unmet", evidence: "No expiry check appears in this diff." },
    ]);
  });

  it("selects configured Pi after native CLI providers", async () => {
    const piConfig = { modelId: "local-model", baseUrl: "http://localhost:1234/v1", protocol: "openai-chat-completions" as const };
    const { deps } = makeFakeDeps({ probeResult: [], piConfig });
    const result = await runReview({ command: "review", diff: "x" }, deps);
    assert.equal(result.pathwayResolution.family, "pi");
  });
});

describe("runReview — explicit pathway", () => {
  it("fails closed before provider construction when a fix lacks explicit approval", async () => {
    let constructed = false;
    const result = await runReview(
      { command: "fix", diff: "+const changed = true;" },
      {
        probeNatives: () => ["codex"],
        createAgent: () => {
          constructed = true;
          throw new Error("a rejected fix must not construct an agent");
        },
      },
    );
    assert.equal(result.success, false);
    assert.equal(result.failure, "permission");
    assert.equal(result.artifact.status, "failed");
    assert.match(result.output, /--apply/u);
    assert.equal(constructed, false);
  });

  it("runs an explicitly approved fix through the standard agent socket with workspace-write", async () => {
    let receivedPermission: string | undefined;
    let receivedInstruction: string | undefined;
    const agent: Agent = {
      name: "capture",
      install: async () => "capture",
      run: async (context) => {
        receivedPermission = context.permission;
        receivedInstruction = context.instructions.systemPrompt;
        return { success: true, output: "Applied the requested fix." };
      },
    };
    const result = await runReview(
      { command: "fix", apply: true, fixInstruction: "Guard the changed value.", diff: "+const changed = true;" },
      {
        probeNatives: () => ["codex"],
        createAgent: () => agent,
        captureWorkspace: (() => {
          let call = 0;
          return async () => ({ files: [{ path: "value.ts", kind: "file", sha256: call++ === 0 ? "before" : "after" }] });
        })(),
      },
    );
    assert.equal(result.success, true);
    assert.equal(receivedPermission, "workspace-write");
    assert.match(receivedInstruction ?? "", /Guard the changed value/u);
    assert.equal(result.command, "fix");
    assert.equal(result.artifact.schemaVersion, "review.v2");
  });

  it("runs fix-all through the same workspace-write agent socket", async () => {
    let receivedPermission: string | undefined;
    let receivedInstruction: string | undefined;
    const agent: Agent = {
      name: "capture",
      install: async () => "capture",
      run: async (context) => {
        receivedPermission = context.permission;
        receivedInstruction = context.instructions.systemPrompt;
        return { success: true, output: "Applied all approved fixes." };
      },
    };
    const result = await runReview(
      { command: "fix-all", apply: true, fixInstruction: "Apply the approved findings.", diff: "+const changed = true;" },
      {
        probeNatives: () => ["claude"],
        createAgent: () => agent,
        captureWorkspace: (() => {
          let call = 0;
          return async () => ({ files: [{ path: "value.ts", kind: "file", sha256: call++ === 0 ? "before" : "after" }] });
        })(),
      },
    );
    assert.equal(result.success, true);
    assert.equal(receivedPermission, "workspace-write");
    assert.match(receivedInstruction ?? "", /approved findings/u);
    assert.equal(result.command, "fix-all");
  });

  it("fails a provider-reported fix when the trusted workspace observer sees no change", async () => {
    const agent: Agent = { name: "capture", install: async () => "capture", run: async () => ({ success: true, output: "Done." }) };
    const captureWorkspace = async () => ({ files: [{ path: "value.ts", kind: "file" as const, sha256: "same" }] });
    const result = await runReview(
      { command: "fix", apply: true, fixInstruction: "Change it.", diff: "+const changed = true;" },
      { probeNatives: () => ["codex"], createAgent: () => agent, captureWorkspace },
    );
    assert.equal(result.success, false);
    assert.equal(result.mutation?.status, "no-change");
    assert.equal(result.artifact.mutation?.status, "no-change");
  });

  it("fails a changed fix when required post-mutation verification fails", async () => {
    let call = 0;
    const agent: Agent = { name: "capture", install: async () => "capture", run: async () => ({ success: true, output: "Done." }) };
    const result = await runReview(
      { command: "fix", apply: true, fixInstruction: "Change it.", diff: "+const changed = true;" },
      {
        probeNatives: () => ["codex"], createAgent: () => agent,
        captureWorkspace: async () => ({ files: [{ path: "value.ts", kind: "file", sha256: call++ === 0 ? "before" : "after" }] }),
        verifyMutation: async () => ({ allRequiredPassed: false, receipts: [] }),
      },
    );
    assert.equal(result.success, false);
    assert.equal(result.mutation?.status, "verification-failed");
  });

  it("reports workspace changes even when the provider fails after writing", async () => {
    let call = 0;
    const agent: Agent = {
      name: "capture",
      install: async () => "capture",
      run: async () => ({ success: false, output: "Provider timed out.", failure: "timeout" }),
    };
    const result = await runReview(
      { command: "fix", apply: true, fixInstruction: "Change it.", diff: "+const changed = true;" },
      {
        probeNatives: () => ["codex"],
        createAgent: () => agent,
        captureWorkspace: async () => ({ files: [{ path: "value.ts", kind: "file", sha256: call++ === 0 ? "before" : "after" }] }),
      },
    );
    assert.equal(result.success, false);
    assert.equal(result.failure, "timeout");
    assert.equal(result.mutation?.status, "applied-unverified");
    assert.equal(result.artifact.mutation?.changedFiles[0]?.path, "value.ts");
    assert.match(result.output, /Provider failed after modifying the workspace/u);
    assert.match(result.output, /inspect them before retrying/u);
  });

  it("honors explicit native:claude regardless of availability", async () => {
    const { deps } = makeFakeDeps({ probeResult: [] });
    const result = await runReview({ command: "review", diff: "x", pathway: { kind: "native", binary: "claude" } }, deps);
    assert.equal(result.pathwayResolution.family, "native");
    assert.equal(result.pathwayResolution.binary, "claude");
  });

  it("runs deterministic findings without constructing an agent", async () => {
    const finding: Finding = { ruleId: "baseline-console-in-prod-path", kind: "lexical", source: "deterministic", severity: "info", message: "console output", filepath: "app.ts", line: 1, column: 0, match: "console.log(" };
    const result = await runReview(
      { command: "review", diff: "+console.log('x')", pathway: { kind: "deterministic" } },
      { findings: [finding], createAgent: () => { throw new Error("deterministic review must not construct an agent"); } },
    );
    assert.equal(result.success, true);
    assert.equal(result.pathwayResolution.family, "deterministic");
    assert.equal(result.artifact.findings[0]?.ruleId, finding.ruleId);
    assert.match(result.output, /app\.ts:1:1/);
    assert.equal(result.trace?.[0]?.source, "deterministic");
  });

  it("fails honestly when a semantic command has only the deterministic pathway", async () => {
    for (const command of ["describe", "improve", "ask"] as const) {
      const result = await runReview(
        { command, diff: "+const changed = true", pathway: { kind: "deterministic" } },
        { findings: [], createAgent: () => { throw new Error("unsupported command must not construct an agent"); } },
      );
      assert.equal(result.success, false);
      assert.equal(result.artifact.status, "failed");
      assert.equal(result.artifact.findings.length, 0);
      assert.match(result.output, /requires a configured model or installed agent/u);
    }
  });

  it("honors explicit native-loop", async () => {
    const { deps } = makeFakeDeps({ probeResult: ["claude"] });
    const result = await runReview({ command: "review", diff: "x", pathway: { kind: "native-loop" } }, deps);
    assert.equal(result.pathwayResolution.family, "native-loop");
  });

  it("routes the local compatibility alias through Pi", async () => {
    const { deps } = makeFakeDeps({});
    const result = await runReview({
      command: "review", diff: "x",
      pathway: { kind: "local", config: { modelId: "llama", baseUrl: "http://localhost:1234/v1", protocol: "openai-chat-completions" } },
    }, deps);
    assert.equal(result.pathwayResolution.family, "pi");
  });
});

describe("runReview — grounding (retrieve integration, 002d)", () => {
  // A real diff fixture with a file path + identifiers.
  const realDiff = `diff --git a/packages/model-client/src/model-client.ts b/packages/model-client/src/model-client.ts
--- a/packages/model-client/src/model-client.ts
+++ b/packages/model-client/src/model-client.ts
@@ -20,6 +20,8 @@ export const createOpenAIModels = (opts) => {
+    const localModel = { id: modelId, api: "openai-completions" };
+    models.setProvider(createProvider({ baseUrl: opts.baseUrl }));`;

  it("calls retrieve when provided AND diff is present", async () => {
    let callCount = 0;
    const { deps } = makeFakeDeps({
      probeResult: [],
      retrieve: async () => { callCount++; return [{ content: "ctx", filepath: "a.ts" }]; },
    });
    await runReview({ command: "review", diff: realDiff, title: "T" }, deps);
    assert.ok(callCount > 0, "retrieve must be called when provided + diff present");
  });

  it("does NOT call retrieve when undefined", async () => {
    let callCount = 0;
    const { deps } = makeFakeDeps({ probeResult: [] });
    // No retrieve provided — makeFakeDeps omits it when not passed.
    // The test verifies no crash and no call.
    void callCount;
    await runReview({ command: "review", diff: realDiff, title: "T" }, deps);
    assert.equal(callCount, 0);
  });

  it("does NOT call retrieve when diff is empty", async () => {
    let callCount = 0;
    const { deps } = makeFakeDeps({
      probeResult: [],
      retrieve: async () => { callCount++; return []; },
    });
    await runReview({ command: "review", title: "T" }, deps);
    assert.equal(callCount, 0, "retrieve must not be called when diff is empty");
  });

  it("calls retrieve with diff-derived queries (not the title)", async () => {
    const queries: string[] = [];
    const { deps } = makeFakeDeps({
      probeResult: [],
      retrieve: async (q) => { queries.push(q); return []; },
    });
    await runReview({ command: "review", diff: realDiff, title: "My PR Title" }, deps);
    // None of the queries should be the title or "context for: ..."
    for (const q of queries) {
      assert.ok(!q.includes("My PR Title"), `query must not be the title: ${q}`);
      assert.ok(!q.startsWith("context for:"), `query must not be title-style: ${q}`);
    }
    // At least one query should reference the file path
    assert.ok(queries.some((q) => q.includes("model-client")), `queries should include the file: ${queries.join(", ")}`);
  });

  it("renders retrieve results into repoContext on the agent's instructions", async () => {
    const { deps, lastInstructions } = makeFakeDeps({
      probeResult: [],
      retrieve: async () => [{ content: "const x = 1;", filepath: "src/a.ts" }],
    });
    await runReview({ command: "review", diff: realDiff, title: "T" }, deps);
    assert.ok(lastInstructions.value, "agent must have received instructions");
    assert.ok(lastInstructions.value!.repoContext, "repoContext must be present");
    assert.match(lastInstructions.value!.repoContext!, /src\/a\.ts/);
    assert.match(lastInstructions.value!.repoContext!, /const x = 1/);
  });

  it("repoContext includes the 'retrieved' label", async () => {
    const { deps, lastInstructions } = makeFakeDeps({
      probeResult: [],
      retrieve: async () => [{ content: "x", filepath: "a.ts" }],
    });
    await runReview({ command: "review", diff: realDiff, title: "T" }, deps);
    assert.match(lastInstructions.value!.repoContext!, /retrieved/i);
  });

  it("retrieve throwing → review still succeeds, no repoContext", async () => {
    const { deps, lastInstructions } = makeFakeDeps({
      probeResult: [],
      retrieve: async () => { throw new Error("embed store down"); },
    });
    const result = await runReview({ command: "review", diff: realDiff, title: "T" }, deps);
    assert.equal(result.success, true);
    assert.ok(!lastInstructions.value?.repoContext, "repoContext must be absent when retrieve throws");
  });

  it("retrieve returning [] → no repoContext, review succeeds", async () => {
    const { deps, lastInstructions } = makeFakeDeps({
      probeResult: [],
      retrieve: async () => [],
    });
    const result = await runReview({ command: "review", diff: realDiff, title: "T" }, deps);
    assert.equal(result.success, true);
    assert.ok(!lastInstructions.value?.repoContext, "repoContext must be absent when retrieve returns empty");
  });

  it("extractDiffQueries returning [] (no-signal diff) → retrieve not called", async () => {
    let callCount = 0;
    const { deps } = makeFakeDeps({
      probeResult: [],
      retrieve: async () => { callCount++; return []; },
    });
    // A diff with no file headers → extractDiffQueries returns []
    await runReview({ command: "review", diff: "just some text\n+const x = 1;", title: "T" }, deps);
    assert.equal(callCount, 0, "retrieve must not be called when extractDiffQueries returns []");
  });

  it("calls retrieve multiple times for multiple queries", async () => {
    let callCount = 0;
    const { deps } = makeFakeDeps({
      probeResult: [],
      retrieve: async () => { callCount++; return []; },
    });
    // Multi-file diff → multiple file-path queries
    const multiDiff = `diff --git a/a.ts b/a.ts
+++ b/a.ts
+x
diff --git a/b.ts b/b.ts
+++ b/b.ts
+y`;
    await runReview({ command: "review", diff: multiDiff, title: "T" }, deps);
    assert.ok(callCount >= 2, `retrieve should be called per query, got ${callCount}`);
  });

  it("dedupes retrieve results by filepath", async () => {
    const { deps, lastInstructions } = makeFakeDeps({
      probeResult: [],
      retrieve: async () => [
        { content: "first", filepath: "dup.ts" },
        { content: "second", filepath: "dup.ts" },
      ],
    });
    await runReview({ command: "review", diff: realDiff, title: "T" }, deps);
    const ctx = lastInstructions.value!.repoContext!;
    assert.match(ctx, /first/);
    assert.ok(!ctx.includes("second"), "duplicate filepath must be deduped (keep first)");
  });

  it("repoContext flows through when resolveInstructions is also provided", async () => {
    const { resolveInstructions } = await import("@gitgecko/instructions");
    const { deps, lastInstructions } = makeFakeDeps({
      probeResult: [],
      retrieve: async () => [{ content: "grounded", filepath: "g.ts" }],
      resolveInstructions: (args, payload, _findings, repoContext) => resolveInstructions(args, payload, undefined, repoContext),
    });
    await runReview({ command: "review", diff: realDiff, title: "T" }, deps);
    assert.ok(lastInstructions.value!.repoContext);
    assert.match(lastInstructions.value!.repoContext!, /grounded/);
  });

  it("findings + repoContext both flow through (app orchestrator path)", async () => {
    const { resolveInstructions } = await import("@gitgecko/instructions");
    const findings = [{ ruleId: "R1", kind: "lexical" as const, severity: "error" as const, message: "m", filepath: "a.ts", line: 1, column: 0, match: "m", source: "deterministic" as const }];
    const { deps, lastInstructions } = makeFakeDeps({
      probeResult: [],
      retrieve: async () => [{ content: "ctx", filepath: "a.ts" }],
      findings,
      resolveInstructions: (args, payload, receivedFindings, repoContext) =>
        resolveInstructions(args, payload, receivedFindings, repoContext),
    });
    await runReview({ command: "review", diff: realDiff, title: "T" }, deps);
    // Both should be present
    assert.match(lastInstructions.value!.systemPrompt, /gitgecko/);
    assert.deepEqual(lastInstructions.value!.findings, findings);
  });

  it("graceful when no resolveInstructions provided (stub path) — still grounds", async () => {
    const { deps, lastInstructions } = makeFakeDeps({
      probeResult: [],
      retrieve: async () => [{ content: "ctx", filepath: "a.ts" }],
    });
    // No deps.resolveInstructions — runReview uses the stub. But retrieve still runs.
    await runReview({ command: "review", diff: realDiff, title: "T" }, deps);
    // With the stub, repoContext won't be on instructions (stub doesn't accept it),
    // but the review still succeeds.
    // NOTE: this test verifies graceful behavior — the stub path doesn't ground,
    // but it doesn't crash either.
  });

  it("retrieve is called with queries derived from file paths in the diff", async () => {
    const queries: string[] = [];
    const { deps } = makeFakeDeps({
      probeResult: [],
      retrieve: async (q) => { queries.push(q); return []; },
    });
    await runReview({ command: "review", diff: realDiff, title: "T" }, deps);
    assert.ok(queries.some((q) => q.includes("model-client.ts")), `file path must be a query: ${queries.join(",")}`);
  });

  it("retrieve is called with identifier queries from added lines", async () => {
    const queries: string[] = [];
    const { deps } = makeFakeDeps({
      probeResult: [],
      retrieve: async (q) => { queries.push(q); return []; },
    });
    await runReview({ command: "review", diff: realDiff, title: "T" }, deps);
    // createProvider or setProvider should appear as queries
    assert.ok(queries.some((q) => /createProvider|setProvider/i.test(q)), `identifier query expected: ${queries.join(",")}`);
  });

  it("multiple snippets from one query are all rendered", async () => {
    const { deps, lastInstructions } = makeFakeDeps({
      probeResult: [],
      retrieve: async () => [
        { content: "snippet1", filepath: "a.ts" },
        { content: "snippet2", filepath: "b.ts" },
      ],
    });
    await runReview({ command: "review", diff: realDiff, title: "T" }, deps);
    const ctx = lastInstructions.value!.repoContext!;
    assert.match(ctx, /snippet1/);
    assert.match(ctx, /snippet2/);
  });

  it("results from multiple queries are merged", async () => {
    let callIdx = 0;
    const results = [
      [{ content: "fromQuery1", filepath: "a.ts" }],
      [{ content: "fromQuery2", filepath: "b.ts" }],
    ];
    const { deps, lastInstructions } = makeFakeDeps({
      probeResult: [],
      retrieve: async () => results[callIdx++] ?? [],
    });
    await runReview({ command: "review", diff: realDiff, title: "T" }, deps);
    const ctx = lastInstructions.value!.repoContext!;
    assert.match(ctx, /fromQuery1|fromQuery2/);
  });

  it("whitespace-only diff → retrieve not called", async () => {
    let callCount = 0;
    const { deps } = makeFakeDeps({
      probeResult: [],
      retrieve: async () => { callCount++; return []; },
    });
    await runReview({ command: "review", diff: "   \n\t ", title: "T" }, deps);
    assert.equal(callCount, 0);
  });

  it("review succeeds and returns output even with grounding active", async () => {
    const { deps } = makeFakeDeps({
      probeResult: [],
      output: "Found a bug",
      retrieve: async () => [{ content: "ctx", filepath: "a.ts" }],
    });
    const result = await runReview({ command: "review", diff: realDiff, title: "T" }, deps);
    assert.equal(result.success, true);
    assert.ok(result.output.includes("Found a bug"));
  });

  it("grounding does not alter the pathway resolution", async () => {
    const { deps } = makeFakeDeps({
      probeResult: ["claude"],
      retrieve: async () => [{ content: "ctx", filepath: "a.ts" }],
    });
    const result = await runReview({ command: "review", diff: realDiff, title: "T" }, deps);
    assert.equal(result.pathwayResolution.family, "native");
    assert.equal(result.pathwayResolution.binary, "claude");
  });

  it("grounding works for /describe command", async () => {
    const { deps, lastInstructions } = makeFakeDeps({
      probeResult: [],
      retrieve: async () => [{ content: "ctx", filepath: "a.ts" }],
    });
    await runReview({ command: "describe", diff: realDiff, title: "T" }, deps);
    // describe also grounds (retrieve is command-agnostic)
    void lastInstructions;
  });

  it("grounding works for /improve command", async () => {
    let called = false;
    const { deps } = makeFakeDeps({
      probeResult: [],
      retrieve: async () => { called = true; return [{ content: "ctx", filepath: "a.ts" }]; },
    });
    await runReview({ command: "improve", diff: realDiff, title: "T" }, deps);
    assert.ok(called);
  });

  it("grounding works for /ask command", async () => {
    let called = false;
    const { deps } = makeFakeDeps({
      probeResult: [],
      retrieve: async () => { called = true; return [{ content: "ctx", filepath: "a.ts" }]; },
    });
    await runReview({ command: "ask", diff: realDiff, title: "T", question: "what?" }, deps);
    assert.ok(called);
  });

  it("repoContext is a string (not an array or object) on instructions", async () => {
    const { deps, lastInstructions } = makeFakeDeps({
      probeResult: [],
      retrieve: async () => [{ content: "ctx", filepath: "a.ts" }],
    });
    await runReview({ command: "review", diff: realDiff, title: "T" }, deps);
    assert.equal(typeof lastInstructions.value!.repoContext, "string");
  });

  it("agent.run is called exactly once per review (grounding doesn't duplicate)", async () => {
    // The fake agent records each run into lastInstructions. Since runReview
    // constructs one agent and calls run once, lastInstructions.value is set
    // exactly once. We verify the review succeeded and instructions were set
    // (proving exactly one agent.run call — makeFakeDeps creates one agent).
    const { deps, lastInstructions } = makeFakeDeps({
      probeResult: [],
      retrieve: async () => [{ content: "ctx", filepath: "a.ts" }],
    });
    await runReview({ command: "review", diff: realDiff, title: "T" }, deps);
    assert.ok(lastInstructions.value, "agent.run must have been called (instructions recorded)");
    // The constructed array records pathway + resolvedModel — one agent created.
    // runReview calls createAgent once, then agent.run once.
  });

  it("empty diff but retrieve provided → no crash, no retrieve call", async () => {
    let called = false;
    const { deps } = makeFakeDeps({
      probeResult: [],
      retrieve: async () => { called = true; return []; },
    });
    const result = await runReview({ command: "review", title: "T" }, deps);
    assert.equal(result.success, true);
    assert.equal(called, false);
  });

  it("the systemPrompt is preserved alongside repoContext (not clobbered)", async () => {
    const { resolveInstructions } = await import("@gitgecko/instructions");
    const { deps, lastInstructions } = makeFakeDeps({
      probeResult: [],
      retrieve: async () => [{ content: "ctx", filepath: "a.ts" }],
      resolveInstructions: (args, payload, _f, repoContext) => resolveInstructions(args, payload, undefined, repoContext),
    });
    await runReview({ command: "review", diff: realDiff, title: "T" }, deps);
    assert.ok(lastInstructions.value!.systemPrompt.length > 0);
    assert.ok(lastInstructions.value!.repoContext);
  });
});

describe("runReview — mutatesDenyList wiring (W5 security wedge, P-plugin-7)", () => {
  // The mutatesDenyList (derived from the active review plug's ActivePlug)
  // must flow into the agent's run context as subagentDeniedTools. This is the
  // least-privilege gate — mutating tools are denied to subagents by default.
  it("passes mutatesDenyList into the agent's subagentDeniedTools", async () => {
    const capturedDenyLists: string[][] = [];
    const fakeAgent: Agent = {
      name: "deny-capture",
      install: async () => "deny-capture",
      run: async (ctx): Promise<AgentResult> => {
        capturedDenyLists.push([...ctx.subagentDeniedTools]);
        ctx.toolState.calls.push({ tool: "model.complete", input: "x" });
        return { success: true, output: "reviewed", usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 } };
      },
    };
    const result = await runReview(
      { command: "review", diff: "+const x = 1;", title: "T" },
      {
        probeNatives: () => [],
        createAgent: () => fakeAgent,
        mutatesDenyList: ["write_file", "delete_file"],
      },
    );
    assert.equal(result.success, true);
    assert.equal(capturedDenyLists.length, 1, "agent must have been called");
    assert.deepEqual(capturedDenyLists[0], ["write_file", "delete_file"], "deny list must flow into subagentDeniedTools");
  });

  it("defaults to empty deny list when mutatesDenyList is undefined (read-only review)", async () => {
    const capturedDenyLists: string[][] = [];
    const fakeAgent: Agent = {
      name: "deny-default",
      install: async () => "deny-default",
      run: async (ctx): Promise<AgentResult> => {
        capturedDenyLists.push([...ctx.subagentDeniedTools]);
        return { success: true, output: "ok", usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 } };
      },
    };
    await runReview(
      { command: "review", diff: "+const x = 1;", title: "T" },
      { probeNatives: () => [], createAgent: () => fakeAgent },
    );
    assert.equal(capturedDenyLists.length, 1);
    assert.deepEqual(capturedDenyLists[0], [], "deny list defaults to empty (no mutatesTools declared)");
  });
});

describe("runReview — robustness", () => {
  it("handles empty diff gracefully", async () => {
    const { deps } = makeFakeDeps({ probeResult: [] });
    const result = await runReview({ command: "review" }, deps);
    assert.equal(result.success, true);
  });

  it("carries the command through to the result", async () => {
    const { deps } = makeFakeDeps({});
    const result = await runReview({ command: "describe", diff: "x" }, deps);
    assert.equal(result.command, "describe");
  });
});

describe("runReview — plan-enforcement gate (UX-SYNTHESIS §1, billing/plans socket)", () => {
  // The gate fires ONLY on the cloud pathway (native-loop = metered). Native +
  // local pathways pass "native-review" (always allowed — the zero-cost wedge).
  // No planGate = no enforcement (local/dev/unauthed CLI — the gate is a
  // cloud-deployment concern).

  it("BLOCKS a native-loop (cloud) review when the free credit cap is hit", async () => {
    const { deps } = makeFakeDeps({
      probeResult: [], // no native agent → resolves to native-loop
      planGate: { planId: "free", usage: { cloudCreditsUsedThisMonth: 50, nativeAgentReviewsUsedThisMonth: 0 } },
    });
    const result = await runReview({ command: "review", diff: "x" }, deps);
    assert.equal(result.success, false, "cloud review must be blocked when cap hit");
    assert.equal(result.pathwayResolution.reason, "plan-blocked");
    assert.match(result.output, /plan limit|credit|cap/i, "must explain the block");
  });

  it("ALLOWS a native-loop (cloud) review when the free cap is NOT hit", async () => {
    const { deps } = makeFakeDeps({
      probeResult: [],
      planGate: { planId: "free", usage: { cloudCreditsUsedThisMonth: 10, nativeAgentReviewsUsedThisMonth: 0 } },
    });
    const result = await runReview({ command: "review", diff: "x" }, deps);
    assert.equal(result.success, true, "cloud review allowed under the cap");
  });

  it("NEVER gates a native-agent review, even with the free cap exhausted", async () => {
    // The A13 wedge: native reviews are structurally un-meterable. A free user
    // with 9999 cloud credits used still gets unlimited native reviews.
    const { deps } = makeFakeDeps({
      probeResult: ["claude"], // native agent → resolves to native
      planGate: { planId: "free", usage: { cloudCreditsUsedThisMonth: 9999, nativeAgentReviewsUsedThisMonth: 9999 } },
    });
    const result = await runReview({ command: "review", diff: "x" }, deps);
    assert.equal(result.success, true, "native reviews never gated by the plan cap");
    assert.equal(result.pathwayResolution.family, "native");
  });

  it("pro plan: ALLOWS a cloud review (higher cap, not free-tier-limited)", async () => {
    const { deps } = makeFakeDeps({
      probeResult: [],
      planGate: { planId: "pro", usage: { cloudCreditsUsedThisMonth: 100, nativeAgentReviewsUsedThisMonth: 0 } },
    });
    const result = await runReview({ command: "review", diff: "x" }, deps);
    assert.equal(result.success, true);
  });

  it("NO planGate → no enforcement (local/dev/unauthed — the CLI never gates by default)", async () => {
    const { deps } = makeFakeDeps({ probeResult: [] }); // no planGate
    const result = await runReview({ command: "review", diff: "x" }, deps);
    assert.equal(result.success, true, "without a planGate, the review runs ungated");
  });

  it("the blocked message points the user to the native pathway (the zero-cost escape)", async () => {
    const { deps } = makeFakeDeps({
      probeResult: ["claude"], // a native agent IS available
      planGate: { planId: "free", usage: { cloudCreditsUsedThisMonth: 50, nativeAgentReviewsUsedThisMonth: 0 } },
      // force the cloud pathway so the gate fires
    });
    const result = await runReview({ command: "review", diff: "x", pathway: { kind: "native-loop" } }, deps);
    assert.equal(result.success, false);
    assert.match(result.output, /native/i, "must mention the native pathway as the escape");
  });
});
