import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecResult, ExecSpec, SandboxBackend } from "./socket.js";
import { runReviewChecks } from "./review-checks.js";

const passed: ExecResult = { exitCode: 0, stdout: "ok", stderr: "", timedOut: false, denied: false };

function backend(
  handler: (spec: ExecSpec, index: number) => ExecResult | Promise<ExecResult> = () => passed,
  isolated = false,
): { value: SandboxBackend; calls: ExecSpec[] } {
  const calls: ExecSpec[] = [];
  return {
    calls,
    value: {
      id: isolated ? "isolated-fixture" : "trusted-local-fixture",
      isolated,
      exec: async (spec) => {
        calls.push(spec);
        return handler(spec, calls.length - 1);
      },
    },
  };
}

const check = (overrides: Partial<Parameters<typeof runReviewChecks>[0][number]> = {}) => ({
  id: "test",
  label: "Test suite",
  command: "pnpm",
  args: ["test"],
  required: true,
  ...overrides,
});

describe("runReviewChecks", () => {
  it("returns one passing receipt through the sandbox owner", async () => {
    const fixture = backend();
    const result = await runReviewChecks([check()], fixture.value);
    assert.equal(result.receipts[0]?.status, "passed");
  });

  it("preserves request order", async () => {
    const result = await runReviewChecks([
      check({ id: "lint", label: "Lint", args: ["lint"] }),
      check({ id: "test", label: "Test", args: ["test"] }),
    ], backend().value);
    assert.deepEqual(result.receipts.map((receipt) => receipt.id), ["lint", "test"]);
  });

  it("executes checks sequentially", async () => {
    const active: string[] = [];
    const completed: string[] = [];
    const fixture = backend(async (spec) => {
      active.push(spec.args?.[0] ?? "");
      assert.equal(active.length, 1);
      await new Promise((resolve) => setTimeout(resolve, 1));
      completed.push(active.pop() ?? "");
      return passed;
    });
    await runReviewChecks([
      check({ id: "lint", args: ["lint"] }),
      check({ id: "test", args: ["test"] }),
    ], fixture.value);
    assert.deepEqual(completed, ["lint", "test"]);
  });

  it("forwards command and split arguments without a shell string", async () => {
    const fixture = backend();
    await runReviewChecks([check({ command: "npm", args: ["run", "test", "--", "--watch=false"] })], fixture.value);
    assert.equal(fixture.calls[0]?.command, "npm");
    assert.deepEqual(fixture.calls[0]?.args, ["run", "test", "--", "--watch=false"]);
  });

  it("never persists command arguments in public receipts", async () => {
    const fixture = backend(async (spec) => ({
      exitCode: 0,
      stdout: spec.args?.[1] ?? "",
      stderr: "",
      timedOut: false,
      denied: false,
    }));
    const report = await runReviewChecks([check({ args: ["--token", "private-value"] })], fixture.value);
    assert.equal("args" in report.receipts[0]!, false);
    assert.doesNotMatch(JSON.stringify(report), /private-value/u);
    assert.equal(report.receipts[0]?.stdout, "[REDACTED]");
  });

  it("forwards cwd", async () => {
    const fixture = backend();
    await runReviewChecks([check({ cwd: "C:/repo" })], fixture.value);
    assert.equal(fixture.calls[0]?.cwd, "C:/repo");
  });

  it("forwards timeout", async () => {
    const fixture = backend();
    await runReviewChecks([check({ timeoutMs: 12_345 })], fixture.value);
    assert.equal(fixture.calls[0]?.timeoutMs, 12_345);
  });

  it("forwards the evidence byte budget into the execution owner", async () => {
    const fixture = backend();
    await runReviewChecks([check()], fixture.value, { maxOutputBytes: 4096 });
    assert.equal(fixture.calls[0]?.maxOutputBytes, 4096);
  });

  it("forwards an explicit environment to the backend", async () => {
    const fixture = backend();
    await runReviewChecks([check({ env: { CI: "1" } })], fixture.value);
    assert.deepEqual(fixture.calls[0]?.env, { CI: "1" });
  });

  it("never exposes environment values in receipts", async () => {
    const result = await runReviewChecks([check({ env: { TOKEN: "secret" } })], backend().value);
    assert.ok(!JSON.stringify(result).includes("secret"));
  });

  it("redacts environment values echoed to stdout", async () => {
    const fixture = backend(() => ({ ...passed, stdout: "token=secret-value" }));
    const result = await runReviewChecks([check({ env: { TOKEN: "secret-value" } })], fixture.value);
    assert.equal(result.receipts[0]?.stdout, "token=[REDACTED]");
  });

  it("redacts environment values echoed to stderr", async () => {
    const fixture = backend(() => ({ ...passed, stderr: "failed secret-value" }));
    const result = await runReviewChecks([check({ env: { TOKEN: "secret-value" } })], fixture.value);
    assert.equal(result.receipts[0]?.stderr, "failed [REDACTED]");
  });

  it("redacts environment values from thrown backend errors", async () => {
    const fixture = backend(() => { throw new Error("spawn secret-value failed"); });
    const result = await runReviewChecks([check({ env: { TOKEN: "secret-value" } })], fixture.value);
    assert.equal(result.receipts[0]?.detail, "spawn [REDACTED] failed");
  });

  it("can mark a safe environment value as evidence-visible", async () => {
    const fixture = backend(() => ({ ...passed, stdout: "cwd=C:/safe" }));
    const result = await runReviewChecks([check({ env: { HOME: "C:/safe" }, secretEnvKeys: [] })], fixture.value);
    assert.equal(result.receipts[0]?.stdout, "cwd=C:/safe");
  });

  it("records the backend identity", async () => {
    const result = await runReviewChecks([check()], backend().value);
    assert.equal(result.receipts[0]?.backend.id, "trusted-local-fixture");
  });

  it("records that a trusted-local backend is not isolated", async () => {
    const result = await runReviewChecks([check()], backend().value);
    assert.equal(result.receipts[0]?.backend.isolated, false);
  });

  it("records a truly isolated backend without changing its claim", async () => {
    const result = await runReviewChecks([check()], backend(undefined, true).value);
    assert.equal(result.receipts[0]?.backend.isolated, true);
  });

  it("maps a nonzero exit to failed", async () => {
    const fixture = backend(() => ({ ...passed, exitCode: 2, stderr: "failed" }));
    const result = await runReviewChecks([check()], fixture.value);
    assert.equal(result.receipts[0]?.status, "failed");
  });

  it("maps a timeout to timed_out", async () => {
    const fixture = backend(() => ({ ...passed, exitCode: -1, timedOut: true }));
    const result = await runReviewChecks([check()], fixture.value);
    assert.equal(result.receipts[0]?.status, "timed_out");
  });

  it("maps a policy denial to denied", async () => {
    const fixture = backend(() => ({ ...passed, exitCode: -1, denied: true, denyReason: "network denied" }));
    const result = await runReviewChecks([check()], fixture.value);
    assert.equal(result.receipts[0]?.status, "denied");
  });

  it("preserves a denial reason", async () => {
    const fixture = backend(() => ({ ...passed, exitCode: -1, denied: true, denyReason: "network denied" }));
    const result = await runReviewChecks([check()], fixture.value);
    assert.equal(result.receipts[0]?.detail, "network denied");
  });

  it("maps a thrown backend error to errored instead of rejecting the run", async () => {
    const fixture = backend(() => { throw new Error("spawn failed"); });
    const result = await runReviewChecks([check()], fixture.value);
    assert.equal(result.receipts[0]?.status, "errored");
  });

  it("preserves a thrown backend error message", async () => {
    const fixture = backend(() => { throw new Error("spawn failed"); });
    const result = await runReviewChecks([check()], fixture.value);
    assert.equal(result.receipts[0]?.detail, "spawn failed");
  });

  it("normalizes a non-Error throw without leaking object internals", async () => {
    const fixture = backend(() => { throw "unavailable"; });
    const result = await runReviewChecks([check()], fixture.value);
    assert.equal(result.receipts[0]?.detail, "unavailable");
  });

  it("captures stdout", async () => {
    const fixture = backend(() => ({ ...passed, stdout: "47 tests passed" }));
    const result = await runReviewChecks([check()], fixture.value);
    assert.equal(result.receipts[0]?.stdout, "47 tests passed");
  });

  it("captures stderr independently", async () => {
    const fixture = backend(() => ({ ...passed, stderr: "warning" }));
    const result = await runReviewChecks([check()], fixture.value);
    assert.equal(result.receipts[0]?.stderr, "warning");
  });

  it("bounds stdout by UTF-8 bytes", async () => {
    const fixture = backend(() => ({ ...passed, stdout: "a".repeat(20) }));
    const result = await runReviewChecks([check()], fixture.value, { maxOutputBytes: 8 });
    assert.equal(Buffer.byteLength(result.receipts[0]?.stdout ?? ""), 8);
  });

  it("does not split a multibyte UTF-8 character", async () => {
    const fixture = backend(() => ({ ...passed, stdout: "gecko-🦎-tail" }));
    const result = await runReviewChecks([check()], fixture.value, { maxOutputBytes: 10 });
    assert.ok(!(result.receipts[0]?.stdout ?? "").includes("�"));
  });

  it("reports output truncation", async () => {
    const fixture = backend(() => ({ ...passed, stdout: "a".repeat(20) }));
    const result = await runReviewChecks([check()], fixture.value, { maxOutputBytes: 8 });
    assert.equal(result.receipts[0]?.outputTruncated, true);
  });

  it("preserves backend streaming truncation evidence", async () => {
    const fixture = backend(() => ({ ...passed, stdout: "bounded", outputTruncated: true }));
    const result = await runReviewChecks([check()], fixture.value, { maxOutputBytes: 64 });
    assert.equal(result.receipts[0]?.stdout, "bounded");
    assert.equal(result.receipts[0]?.outputTruncated, true);
  });

  it("does not report truncation for bounded output", async () => {
    const result = await runReviewChecks([check()], backend().value, { maxOutputBytes: 8 });
    assert.equal(result.receipts[0]?.outputTruncated, false);
  });

  it("marks all required checks passed when every required check passes", async () => {
    const result = await runReviewChecks([check(), check({ id: "lint" })], backend().value);
    assert.equal(result.allRequiredPassed, true);
  });

  it("marks required checks failed when one required check fails", async () => {
    const fixture = backend((_spec, index) => index === 0 ? passed : { ...passed, exitCode: 1 });
    const result = await runReviewChecks([check(), check({ id: "lint" })], fixture.value);
    assert.equal(result.allRequiredPassed, false);
  });

  it("does not let an optional failed check block required checks", async () => {
    const fixture = backend(() => ({ ...passed, exitCode: 1 }));
    const result = await runReviewChecks([check({ required: false })], fixture.value);
    assert.equal(result.allRequiredPassed, true);
  });

  it("rejects duplicate check ids before execution", async () => {
    const fixture = backend();
    await assert.rejects(() => runReviewChecks([check(), check()], fixture.value), /duplicate check id/i);
    assert.equal(fixture.calls.length, 0);
  });

  it("rejects an empty command before execution", async () => {
    const fixture = backend();
    await assert.rejects(() => runReviewChecks([check({ command: "  " })], fixture.value), /command/i);
    assert.equal(fixture.calls.length, 0);
  });

  it("rejects an empty id before execution", async () => {
    const fixture = backend();
    await assert.rejects(() => runReviewChecks([check({ id: "" })], fixture.value), /id/i);
    assert.equal(fixture.calls.length, 0);
  });

  it("rejects a non-canonical id before execution", async () => {
    const fixture = backend();
    await assert.rejects(() => runReviewChecks([check({ id: "Test Suite" })], fixture.value), /canonical/i);
    assert.equal(fixture.calls.length, 0);
  });

  it("returns an empty successful report when no checks were requested", async () => {
    const result = await runReviewChecks([], backend().value);
    assert.deepEqual(result, { allRequiredPassed: true, receipts: [] });
  });

  it("records deterministic elapsed time without wall-clock dependence", async () => {
    const ticks = [100, 145];
    const result = await runReviewChecks([check()], backend().value, { now: () => ticks.shift() ?? 145 });
    assert.equal(result.receipts[0]?.durationMs, 45);
  });
});
