import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readWorkingTreeDiff } from "./working-tree-diff.js";

/** Runs Git without a shell so the fixture exercises the same executable boundary as the CLI. */
function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-c", "core.safecrlf=false", ...args], { cwd, encoding: "utf8" });
}

describe("readWorkingTreeDiff", () => {
  it("collects tracked diffs larger than Node's default 1 MiB child-process buffer", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gitgecko-large-diff-"));
    git(cwd, "init", "--quiet");
    git(cwd, "config", "user.email", "test@gitgecko.local");
    git(cwd, "config", "user.name", "GitGecko Test");
    git(cwd, "config", "core.autocrlf", "true");
    writeFileSync(join(cwd, "large.txt"), "baseline\n");
    git(cwd, "add", "large.txt");
    git(cwd, "commit", "--quiet", "-m", "baseline");

    const changed = Array.from({ length: 32_000 }, (_, index) => `changed-${index.toString().padStart(5, "0")}-${"x".repeat(48)}`).join("\n");
    writeFileSync(join(cwd, "large.txt"), `${changed}\n`);

    const diff = readWorkingTreeDiff(cwd);

    assert.ok(Buffer.byteLength(diff, "utf8") > 1_048_576);
    assert.match(diff, /diff --git a\/large\.txt b\/large\.txt/u);
    assert.match(diff, /changed-31999/u);
  });

  it("reports an unsupported non-repository target instead of claiming there are no changes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gitgecko-not-a-repo-"));

    assert.throws(
      () => readWorkingTreeDiff(cwd),
      /Could not read tracked changes: .*not a git repository/iu,
    );
  });
});
