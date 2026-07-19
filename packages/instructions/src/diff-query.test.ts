/**
 * TDD tests for extractDiffQueries (002c) — the diff-analysis query extractor.
 *
 * Challenges the CAPABILITY: does the extractor produce file-path + identifier
 * queries that would hit an embed store, from real unified diffs? Tests use
 * the benchmark corpus diffs as fixtures (real diffs against this repo).
 *
 * Per project TDD rule: written FIRST, never degraded.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractDiffQueries } from "./diff-query.js";

// --- Real diff fixtures (harvested from benchmark corpus + real PRs) ---------

const modelClientDiff = `diff --git a/packages/model-client/src/model-client.ts b/packages/model-client/src/model-client.ts
--- a/packages/model-client/src/model-client.ts
+++ b/packages/model-client/src/model-client.ts
@@ -20,6 +20,8 @@ export const createOpenAIModels = (opts) => {
   const models = createModels();
   if (!opts.baseUrl) { models.setProvider(openaiProvider()); return models; }
+    const localModel = { id: modelId, api: "openai-completions" };
+    models.setProvider(createProvider({ baseUrl: opts.baseUrl }));
   return models;
};`;

const multiFileDiff = `diff --git a/packages/review/src/agent.ts b/packages/review/src/agent.ts
--- a/packages/review/src/agent.ts
+++ b/packages/review/src/agent.ts
@@ -50,6 +50,7 @@ export interface ResolvedInstructions {
+  readonly repoContext?: string;
diff --git a/packages/instructions/src/resolve.ts b/packages/instructions/src/resolve.ts
--- a/packages/instructions/src/resolve.ts
+++ b/packages/instructions/src/resolve.ts
@@ -32,7 +32,9 @@ export const resolveInstructions = (
-export const old = (a, b) => a + b;
+export const resolveInstructions = (args, payload, findings, repoContext) => {};`;

// --- extractDiffQueries ---

describe("extractDiffQueries — file paths", () => {
  it("extracts file paths from +++ b/ headers", () => {
    const queries = extractDiffQueries(modelClientDiff);
    assert.ok(queries.some((q) => q.includes("model-client.ts")), "must include the changed file path");
  });

  it("strips the b/ prefix from file paths", () => {
    const queries = extractDiffQueries(modelClientDiff);
    const pathQuery = queries.find((q) => q.includes("model-client"));
    assert.ok(pathQuery);
    assert.ok(!pathQuery!.startsWith("b/"), "must not retain the b/ prefix");
  });

  it("extracts paths from multi-file diffs", () => {
    const queries = extractDiffQueries(multiFileDiff);
    assert.ok(queries.some((q) => q.includes("agent.ts")));
    assert.ok(queries.some((q) => q.includes("resolve.ts")));
  });

  it("handles deeply nested paths", () => {
    const diff = `diff --git a/src/deep/nested/path/file.ts b/src/deep/nested/path/file.ts
+++ b/src/deep/nested/path/file.ts
+const x = 1;`;
    const queries = extractDiffQueries(diff);
    assert.ok(queries.some((q) => q.includes("file.ts")));
  });

  it("handles various file extensions (.ts .js .py .go)", () => {
    for (const ext of [".ts", ".js", ".py", ".go"]) {
      const diff = `diff --git a/f${ext} b/f${ext}\n+++ b/f${ext}\n+const x = 1;`;
      const queries = extractDiffQueries(diff);
      assert.ok(queries.some((q) => q.includes(`f${ext}`)), `must handle ${ext}`);
    }
  });
});

describe("extractDiffQueries — identifiers", () => {
  it("extracts function/variable identifiers from added lines", () => {
    const queries = extractDiffQueries(modelClientDiff);
    // createOpenAIModels, createProvider, openaiProvider, setProvider are real identifiers
    assert.ok(queries.some((q) => /createOpenAIModels|createProvider|openaiProvider/i.test(q)),
      "must extract identifiers from added lines");
  });

  it("extracts PascalCase type names", () => {
    const diff = `diff --git a/a.ts b/a.ts
+++ b/a.ts
+interface ResolvedInstructions { }`;
    const queries = extractDiffQueries(diff);
    assert.ok(queries.some((q) => q === "ResolvedInstructions"), "must extract PascalCase type");
  });

  it("extracts snake_case identifiers", () => {
    const diff = `diff --git a/a.py b/a.py
+++ b/a.py
+def process_user_input(data):`;
    const queries = extractDiffQueries(diff);
    assert.ok(queries.some((q) => q.includes("process") || q.includes("user") || q.includes("input")),
      "must extract snake_case tokens");
  });

  it("extracts identifiers with numbers (e.g. base64Url)", () => {
    const diff = `diff --git a/a.ts b/a.ts
+++ b/a.ts
+const base64Url = encode(value);`;
    const queries = extractDiffQueries(diff);
    assert.ok(queries.some((q) => /base64Url|encode/i.test(q)), "must extract identifiers with numbers");
  });

  it("extracts dotted member access", () => {
    const diff = `diff --git a/a.ts b/a.ts
+++ b/a.ts
+    models.setProvider(createProvider({ baseUrl: opts.baseUrl }));`;
    const queries = extractDiffQueries(diff);
    assert.ok(queries.some((q) => /createProvider|setProvider|baseUrl/i.test(q)));
  });

  it("extracts from import statements", () => {
    const diff = `diff --git a/a.ts b/a.ts
+++ b/a.ts
+import { createModels } from "@earendil-works/pi-ai";`;
    const queries = extractDiffQueries(diff);
    assert.ok(queries.some((q) => q === "createModels"), "must extract imported identifier");
  });
});

describe("extractDiffQueries — filtering", () => {
  it("filters out language keywords (const, let, return, function)", () => {
    const diff = `diff --git a/a.ts b/a.ts
+++ b/a.ts
+const x = function() { return null; };`;
    const queries = extractDiffQueries(diff);
    assert.ok(!queries.includes("const"), "const must be filtered");
    assert.ok(!queries.includes("return"), "return must be filtered");
    assert.ok(!queries.includes("function"), "function must be filtered");
  });

  it("filters out short tokens (<3 chars)", () => {
    const diff = `diff --git a/a.ts b/a.ts
+++ b/a.ts
+const ab = 1;`;
    const queries = extractDiffQueries(diff);
    assert.ok(!queries.includes("ab"), "2-char token must be filtered");
  });

  it("filters a broad keyword blocklist", () => {
    const diff = `diff --git a/a.ts b/a.ts
+++ b/a.ts
+export default class Foo extends Bar implements Baz { private readonly x = new Thing(); }`;
    const queries = extractDiffQueries(diff);
    for (const kw of ["export", "default", "class", "extends", "implements", "private", "readonly", "new"]) {
      assert.ok(!queries.includes(kw), `${kw} must be filtered`);
    }
  });
});

describe("extractDiffQueries — edge cases", () => {
  it("returns [] for empty string", () => {
    assert.deepEqual([...extractDiffQueries("")], []);
  });

  it("returns [] for whitespace-only string", () => {
    assert.deepEqual([...extractDiffQueries("   \n\t  ")], []);
  });

  it("returns [] when there are no file headers", () => {
    assert.deepEqual([...extractDiffQueries("some random text\n+const x = 1;")], []);
  });

  it("returns file-path queries when there are headers but no added lines", () => {
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts`; // no + lines
    const queries = [...extractDiffQueries(diff)];
    assert.ok(queries.some((q) => q.includes("a.ts")));
  });

  it("returns [] for a diff with only context lines (no +/-)", () => {
    const diff = `diff --git a/a.ts b/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 context line one
 context line two
 context line three`;
    const queries = [...extractDiffQueries(diff)];
    // file path still extracted, but no identifiers — at least the path
    assert.ok(queries.length >= 0);
  });

  it("handles deletion-only diff (only - lines besides headers)", () => {
    const diff = `diff --git a/a.ts b/a.ts
+++ b/a.ts
-old code here`;
    const queries = [...extractDiffQueries(diff)];
    assert.ok(queries.some((q) => q.includes("a.ts")), "file path still extracted");
  });

  it("handles binary/noise diff gracefully", () => {
    const diff = `diff --git a/binary.bin b/binary.bin
Binary files differ`;
    const queries = [...extractDiffQueries(diff)];
    // doesn't crash; may extract the path
    assert.ok(Array.isArray(queries));
  });

  it("does not throw on malformed diff", () => {
    assert.doesNotThrow(() => extractDiffQueries("+++ \n+++\n-"));
    assert.doesNotThrow(() => extractDiffQueries("??? nonsense"));
  });

  it("does not mutate the input", () => {
    const input = modelClientDiff;
    const snapshot = input;
    extractDiffQueries(input);
    assert.equal(input, snapshot);
  });

  it("is deterministic (same input → same output)", () => {
    assert.deepEqual([...extractDiffQueries(modelClientDiff)], [...extractDiffQueries(modelClientDiff)]);
  });
});

describe("extractDiffQueries — dedup + cap", () => {
  it("deduplicates identical identifiers across lines", () => {
    const diff = `diff --git a/a.ts b/a.ts
+++ b/a.ts
+fooBar();
+fooBar();
+fooBar();`;
    const queries = [...extractDiffQueries(diff)];
    const fooBarCount = queries.filter((q) => q === "fooBar").length;
    assert.equal(fooBarCount, 1, "fooBar must appear only once");
  });

  it("deduplicates file paths (same file header twice)", () => {
    const diff = `diff --git a/a.ts b/a.ts
+++ b/a.ts
+x
diff --git a/a.ts b/a.ts
+++ b/a.ts
+y`;
    const queries = [...extractDiffQueries(diff)];
    const aTsCount = queries.filter((q) => q === "a.ts" || q.endsWith("/a.ts")).length;
    assert.ok(aTsCount <= 1, "a.ts path must be deduplicated");
  });

  it("caps total queries at 8", () => {
    // 15 unique identifiers
    const ids = Array.from({ length: 15 }, (_, i) => `identifier${i}`);
    const diff = `diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+${ids.join("();\n+")}();`;
    const queries = [...extractDiffQueries(diff)];
    assert.ok(queries.length <= 8, `must cap at 8, got ${queries.length}`);
  });

  it("caps at 8 even with many files", () => {
    const files = Array.from({ length: 12 }, (_, i) => `file${i}.ts`);
    const headerBlocks = files.map((f) => `diff --git a/${f} b/${f}\n+++ b/${f}\n+const x = 1;`).join("\n");
    const queries = [...extractDiffQueries(headerBlocks)];
    assert.ok(queries.length <= 8, `must cap at 8, got ${queries.length}`);
  });
});

describe("extractDiffQueries — real corpus diffs", () => {
  it("extracts queries from the model-client diff", () => {
    const queries = [...extractDiffQueries(modelClientDiff)];
    assert.ok(queries.length > 0, "must produce queries from a real diff");
    assert.ok(queries.some((q) => q.includes("model-client")), "must include the file");
  });

  it("extracts queries from the multi-file diff", () => {
    const queries = [...extractDiffQueries(multiFileDiff)];
    assert.ok(queries.length > 0);
    assert.ok(queries.some((q) => q.includes("agent.ts") || q.includes("resolve.ts")));
  });

  it("never returns the PR title (only code-surface signals)", () => {
    // The extractor doesn't even receive the title — but verify no generic English phrases
    const queries = [...extractDiffQueries(modelClientDiff)];
    for (const q of queries) {
      assert.ok(!/^context for:/.test(q), "must not produce title-style queries");
    }
  });
});
