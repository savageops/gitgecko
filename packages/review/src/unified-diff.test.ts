import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff } from "./unified-diff.js";

describe("unified diff file inventory", () => {
  it("preserves modified and added files with their added source", () => {
    const files = parseUnifiedDiff([
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "+created",
    ].join("\n"));

    assert.deepEqual(files.map(({ path, status, addedSource }) => ({ path, status, addedSource })), [
      { path: "src/a.ts", status: "modified", addedSource: "new" },
      { path: "src/new.ts", status: "added", addedSource: "created" },
    ]);
  });

  it("preserves deleted files without requiring an addition", () => {
    const files = parseUnifiedDiff([
      "diff --git a/src/old.ts b/src/old.ts",
      "deleted file mode 100644",
      "--- a/src/old.ts",
      "+++ /dev/null",
      "-gone",
    ].join("\n"));

    assert.equal(files.length, 1);
    assert.equal(files[0]?.path, "src/old.ts");
    assert.equal(files[0]?.status, "deleted");
  });

  it("preserves rename provenance", () => {
    const files = parseUnifiedDiff([
      "diff --git a/src/before.ts b/src/after.ts",
      "similarity index 100%",
      "rename from src/before.ts",
      "rename to src/after.ts",
    ].join("\n"));

    assert.equal(files[0]?.path, "src/after.ts");
    assert.equal(files[0]?.previousPath, "src/before.ts");
    assert.equal(files[0]?.status, "renamed");
  });

  it("preserves binary changes", () => {
    const files = parseUnifiedDiff([
      "diff --git a/assets/logo.png b/assets/logo.png",
      "Binary files a/assets/logo.png and b/assets/logo.png differ",
    ].join("\n"));

    assert.equal(files[0]?.path, "assets/logo.png");
    assert.equal(files[0]?.binary, true);
  });

  it("supports a header-only unified diff", () => {
    const files = parseUnifiedDiff([
      "--- a/readme.md",
      "+++ b/readme.md",
      "+hello",
    ].join("\n"));

    assert.equal(files[0]?.path, "readme.md");
    assert.equal(files[0]?.addedSource, "hello");
  });

  it("preserves destination line numbers across multiple hunks", () => {
    const files = parseUnifiedDiff([
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -4,2 +10,3 @@",
      " context",
      "+first",
      "+second",
      "@@ -40 +100,2 @@",
      "+third",
    ].join("\n"));

    assert.deepEqual(files[0]?.addedLines, [
      { line: 11, source: "first" },
      { line: 12, source: "second" },
      { line: 100, source: "third" },
    ]);
  });
});
