import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMutationReceipt, type WorkspaceSnapshot } from "./mutation.js";

const snapshot = (...files: readonly [string, string][]): WorkspaceSnapshot => ({
  files: files.map(([path, sha256]) => ({ path, sha256, kind: "file" as const })),
});

describe("mutation receipt", () => {
  it("rejects provider success without an observed change", () => {
    const receipt = createMutationReceipt(snapshot(["a.ts", "one"]), snapshot(["a.ts", "one"]));
    assert.equal(receipt.status, "no-change");
    assert.deepEqual(receipt.changedFiles, []);
  });

  it("records added, modified, and deleted files deterministically", () => {
    const receipt = createMutationReceipt(
      snapshot(["a.ts", "one"], ["gone.ts", "old"]),
      snapshot(["a.ts", "two"], ["new.ts", "new"]),
    );
    assert.equal(receipt.status, "applied-unverified");
    assert.deepEqual(receipt.changedFiles.map(({ path, status }) => ({ path, status })), [
      { path: "a.ts", status: "modified" },
      { path: "gone.ts", status: "deleted" },
      { path: "new.ts", status: "added" },
    ]);
  });

  it("distinguishes passed and failed post-mutation verification", () => {
    const before = snapshot(["a.ts", "one"]);
    const after = snapshot(["a.ts", "two"]);
    assert.equal(createMutationReceipt(before, after, { allRequiredPassed: true, receipts: [] }).status, "applied-verified");
    assert.equal(createMutationReceipt(before, after, { allRequiredPassed: false, receipts: [] }).status, "verification-failed");
  });
});
