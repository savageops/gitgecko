import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createReviewCheckEnvironment, runBundledReviewChecks } from "./sandbox-registry.js";

describe("review check environment", () => {
  it("preserves executable discovery", () => {
    assert.deepEqual(createReviewCheckEnvironment({ PATH: "bin", PATHEXT: ".EXE" }), { PATH: "bin", PATHEXT: ".EXE" });
  });

  it("preserves Windows Path casing", () => {
    assert.deepEqual(createReviewCheckEnvironment({ Path: "bin" }), { Path: "bin" });
  });

  it("preserves home context used by package managers", () => {
    assert.deepEqual(createReviewCheckEnvironment({ HOME: "/home/gecko", USERPROFILE: "C:/Users/gecko" }), { HOME: "/home/gecko", USERPROFILE: "C:/Users/gecko" });
  });

  it("drops provider and repository credentials", () => {
    const env = createReviewCheckEnvironment({ PATH: "bin", GITHUB_TOKEN: "secret", ANTHROPIC_API_KEY: "secret" });
    assert.deepEqual(env, { PATH: "bin" });
  });
});

describe("bundled review check path", () => {
  it("runs through the registered trusted-local sandbox backend", async () => {
    const report = await runBundledReviewChecks([{ id: "smoke", label: "Smoke", command: process.execPath, args: ["-e", "process.stdout.write('ok')"] }], process.cwd());
    assert.equal(report.receipts[0]?.stdout, "ok");
    assert.deepEqual(report.receipts[0]?.backend, { id: "subprocess", isolated: false });
  });

  it("forces execution into the reviewed directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "gitgecko-review-check-"));
    try {
      const report = await runBundledReviewChecks([{ id: "cwd", label: "Working directory", command: process.execPath, args: ["-e", "process.stdout.write(process.cwd())"] }], cwd);
      assert.equal(report.receipts[0]?.stdout.toLowerCase(), cwd.toLowerCase());
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns a blocking receipt for a failed required check", async () => {
    const report = await runBundledReviewChecks([{ id: "test", label: "Tests", command: process.execPath, args: ["-e", "process.exit(2)"], required: true }], process.cwd());
    assert.equal(report.allRequiredPassed, false);
    assert.equal(report.receipts[0]?.status, "failed");
  });

  it("retains advisory failure without blocking required checks", async () => {
    const report = await runBundledReviewChecks([{ id: "audit", label: "Audit", command: process.execPath, args: ["-e", "process.exit(2)"], required: false }], process.cwd());
    assert.equal(report.allRequiredPassed, true);
    assert.equal(report.receipts[0]?.status, "failed");
  });
});
