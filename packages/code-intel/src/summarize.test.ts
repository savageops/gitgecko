/**
 * TDD tests for summarize — Greptile's docstring-embed trick (GP-§8a).
 *
 * Challenges the CAPABILITY: given source + parsed tags, generate a docstring
 * per definition node via an injected LLM function. The docstring replaces
 * raw code as the embedding target.
 *
 * Uses a deterministic fake generateDocstring so tests are reproducible.
 * Per project TDD rule: written FIRST, fail, then code passes. Never weakened.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeSources, type SourceFile } from "./summarize.js";
import type { ParsedFile, Tag } from "./tags.js";

const tag = (over: Partial<Tag> & Pick<Tag, "name" | "category" | "subtype" | "line" | "relPath">): Tag => ({
  column: 0, startByte: 0, endByte: 100, ...over,
});

const file = (relPath: string, language: string, tags: Tag[]): ParsedFile => ({ relPath, language, tags });

// A deterministic fake: returns a summary string from the code
const fakeDocstring = async (code: string, name: string, kind: string): Promise<string> =>
  `${kind} ${name}: ${code.slice(0, 30).replace(/\n/g, " ")}...`;

describe("summarize — docstring generation per node", () => {
  it("generates a docstring for each definition tag", async () => {
    const source: SourceFile[] = [{ filepath: "a.py", source: "def login():\n    return True\n" }];
    const parsed: ParsedFile[] = [file("a.py", "python", [
      tag({ relPath: "a.py", name: "login", category: "def", subtype: "function", line: 1, startByte: 0, endByte: 30 }),
    ])];
    const out = await summarizeSources(source, parsed, fakeDocstring);
    assert.equal(out.summaries.length, 1);
    assert.equal(out.summaries[0]!.name, "login");
    assert.ok(out.summaries[0]!.docstring.includes("login"));
  });

  it("skips reference tags (only defs are summarized)", async () => {
    const source: SourceFile[] = [{ filepath: "a.py", source: "def f():\n    g()\n" }];
    const parsed: ParsedFile[] = [file("a.py", "python", [
      tag({ relPath: "a.py", name: "f", category: "def", subtype: "function", line: 1, startByte: 0, endByte: 10 }),
      tag({ relPath: "a.py", name: "g", category: "ref", subtype: "call", line: 2, startByte: 11, endByte: 14 }),
    ])];
    const out = await summarizeSources(source, parsed, fakeDocstring);
    assert.equal(out.summaries.length, 1, "only def tags, not refs");
    assert.equal(out.summaries[0]!.name, "f");
  });

  it("handles multiple definitions across files", async () => {
    const sources: SourceFile[] = [
      { filepath: "a.py", source: "def add(a, b): return a + b\n" },
      { filepath: "b.js", source: "function multiply(x, y) { return x * y }\n" },
    ];
    const parsed: ParsedFile[] = [
      file("a.py", "python", [tag({ relPath: "a.py", name: "add", category: "def", subtype: "function", line: 1, startByte: 0, endByte: 30 })]),
      file("b.js", "javascript", [tag({ relPath: "b.js", name: "multiply", category: "def", subtype: "function", line: 1, startByte: 0, endByte: 40 })]),
    ];
    const out = await summarizeSources(sources, parsed, fakeDocstring);
    assert.equal(out.summaries.length, 2);
    const names = out.summaries.map((s) => s.name).sort();
    assert.deepEqual(names, ["add", "multiply"]);
  });

  it("carries the kind (function/class/method) from the tag", async () => {
    const source: SourceFile[] = [{ filepath: "a.py", source: "class User:\n    def __init__(self):\n        pass\n" }];
    const parsed: ParsedFile[] = [file("a.py", "python", [
      tag({ relPath: "a.py", name: "User", category: "def", subtype: "class", line: 1, startByte: 0, endByte: 10 }),
      tag({ relPath: "a.py", name: "__init__", category: "def", subtype: "method", line: 2, startByte: 11, endByte: 30 }),
    ])];
    const out = await summarizeSources(source, parsed, fakeDocstring);
    const kinds = out.summaries.map((s) => s.kind).sort();
    assert.deepEqual(kinds, ["class", "method"]);
  });

  it("carries filepath + line for each summary", async () => {
    const source: SourceFile[] = [{ filepath: "src/app.py", source: "def main(): pass\n" }];
    const parsed: ParsedFile[] = [file("src/app.py", "python", [
      tag({ relPath: "src/app.py", name: "main", category: "def", subtype: "function", line: 5, startByte: 0, endByte: 20 }),
    ])];
    const out = await summarizeSources(source, parsed, fakeDocstring);
    assert.equal(out.summaries[0]!.filepath, "src/app.py");
    assert.equal(out.summaries[0]!.line, 5);
  });
});

describe("summarize — robustness", () => {
  it("returns empty summaries for files with no definitions", async () => {
    const source: SourceFile[] = [{ filepath: "a.py", source: "# just a comment\n" }];
    const parsed: ParsedFile[] = [file("a.py", "python", [])];
    const out = await summarizeSources(source, parsed, fakeDocstring);
    assert.equal(out.summaries.length, 0);
  });

  it("handles empty input (no files)", async () => {
    const out = await summarizeSources([], [], fakeDocstring);
    assert.equal(out.summaries.length, 0);
  });

  it("skips parsed files whose source is missing from the source map", async () => {
    const parsed: ParsedFile[] = [file("ghost.py", "python", [
      tag({ relPath: "ghost.py", name: "x", category: "def", subtype: "function", line: 1, startByte: 0, endByte: 10 }),
    ])];
    const out = await summarizeSources([], parsed, fakeDocstring); // no sources provided
    assert.equal(out.summaries.length, 0);
  });

  it("the docstring replaces raw code as the embedding target (GP-§8a contract)", async () => {
    const source: SourceFile[] = [{ filepath: "a.py", source: "def complex_function(x, y, z):\n    result = x * y + z\n    return result\n" }];
    const parsed: ParsedFile[] = [file("a.py", "python", [
      tag({ relPath: "a.py", name: "complex_function", category: "def", subtype: "function", line: 1, startByte: 0, endByte: 80 }),
    ])];
    const out = await summarizeSources(source, parsed, fakeDocstring);
    // The summary carries BOTH code + docstring; the embed capability embeds docstring (not code)
    assert.ok(out.summaries[0]!.code.includes("complex_function"));
    assert.ok(out.summaries[0]!.docstring.length > 0);
    assert.notEqual(out.summaries[0]!.docstring, out.summaries[0]!.code);
  });
});
