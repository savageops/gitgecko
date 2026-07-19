import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { captureWorkspaceSnapshot } from "./workspace-observer.js";

describe("workspace mutation observer", () => {
  it("captures tracked, dirty, untracked, and symlink identities without dependency files", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gitgecko-observer-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      writeFileSync(join(cwd, "tracked.ts"), "one\n");
      execFileSync("git", ["add", "tracked.ts"], { cwd });
      writeFileSync(join(cwd, "tracked.ts"), "dirty\n");
      writeFileSync(join(cwd, "untracked.ts"), "new\n");
      symlinkSync("tracked.ts", join(cwd, "link.ts"));
      writeFileSync(join(cwd, ".gitignore"), "node_modules/\n");
      const before = await captureWorkspaceSnapshot(cwd);
      assert.deepEqual(before.files.map((file) => file.path), [".gitignore", "link.ts", "tracked.ts", "untracked.ts"]);
      assert.equal(before.files.find((file) => file.path === "link.ts")?.kind, "symlink");
      writeFileSync(join(cwd, "tracked.ts"), "changed\n");
      const after = await captureWorkspaceSnapshot(cwd);
      assert.notEqual(
        before.files.find((file) => file.path === "tracked.ts")?.sha256,
        after.files.find((file) => file.path === "tracked.ts")?.sha256,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
