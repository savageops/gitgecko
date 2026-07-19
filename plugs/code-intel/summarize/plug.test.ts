/**
 * TDD tests for the summarize plug (Phase 2.1 — GP-§8a docstring-embed).
 *
 * THE CAPABILITY: the summarize plug takes source files + parsed def tags,
 * generates a natural-language docstring per definition via the model owner's
 * complete fn, and returns docstring-indexed summaries for embedding. This is
 * Greptile's core IP (GP-§8a), now reproducible.
 *
 * Per project TDD rule: tests challenge capability, never degraded to pass.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "@gitgecko/socket";
import { codeIntelOwner, type CodeIntelCapability } from "@gitgecko/code-intel";
import type { SummarizeContribution, SummarizeInput, ParsedFile } from "@gitgecko/code-intel";
import { manifest, setup, createSetup, createSummarizeContribution, buildGenerateDocstring, type ModelComplete } from "./plug.js";

const logger = { info() {}, warn() {}, error() {} };

// A deterministic fake model-complete for testing.
const fakeComplete: ModelComplete = async (prompt: string): Promise<string> => {
  // Extract the kind+name from the prompt to produce a deterministic docstring.
  return `FAKE DOCSTRING for: ${prompt.slice(0, 60)}`;
};

// A minimal parsed file with one def tag.
const fakeParsedFiles: readonly ParsedFile[] = [
  {
    relPath: "src/foo.ts",
    language: "typescript",
    tags: [
      { relPath: "src/foo.ts", category: "def", name: "authenticate", subtype: "function", line: 1, column: 0, startByte: 0, endByte: 100 },
    ],
  },
];

const fakeSourceFiles = [{ filepath: "src/foo.ts", source: "function authenticate(user, pass) { return check(pass); }", language: "typescript" }];

describe("summarize plug — manifest + socket integration", () => {
  it("manifest is valid and declares the summarize capability under code-intel owner", () => {
    assert.equal(manifest.owner, "code-intel");
    assert.ok(manifest.capabilities.includes("summarize"), "manifest must declare 'summarize'");
    assert.equal(manifest.id, "code-intel-summarize");
  });

  it("loads through the code-intel Registry only with an injected model owner", async () => {
    const reg = new Registry<CodeIntelCapability, string, SummarizeContribution>(codeIntelOwner);
    const res = await reg.load(
      { manifest, setup: createSetup(fakeComplete) as never },
      { config: {}, logger },
    );
    assert.ok(res.ok, `plug must load: ${res.ok ? "" : res.error.message}`);
    assert.ok(res.value.contributions.length > 0, "must register at least one contribution");
    assert.equal(res.value.contributions[0]!.capability, "summarize");
    assert.equal(res.value.contributions[0]!.contribution.kind, "summarizer");
  });

  it("refuses activation without an executable model dependency", async () => {
    const reg = new Registry<CodeIntelCapability, string, SummarizeContribution>(codeIntelOwner);
    const res = await reg.load(
      { manifest, setup: setup as never },
      { config: {}, logger },
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error.message, /requires an injected model-owner/);
  });
});

describe("summarize plug — generateDocstring from model-complete (GP-§8a)", () => {
  it("buildGenerateDocstring produces a fn that calls the model-complete", async () => {
    let capturedPrompt = "";
    const capturingComplete: ModelComplete = async (prompt: string) => {
      capturedPrompt = prompt;
      return "Validates a user password.";
    };
    const gen = buildGenerateDocstring(capturingComplete);
    const docstring = await gen("function authenticate(u, p) { ... }", "authenticate", "function");
    assert.equal(docstring, "Validates a user password.");
    assert.match(capturedPrompt, /authenticate/);
    assert.match(capturedPrompt, /function/);
  });

  it("generateDocstring falls back gracefully when the model fails", async () => {
    const failingComplete: ModelComplete = async () => { throw new Error("model down"); };
    const gen = buildGenerateDocstring(failingComplete);
    const docstring = await gen("const x = 1;", "x", "variable");
    // Should fall back to the name, not throw.
    assert.match(docstring, /x/);
  });

  it("generateDocstring trims overly long model output to 500 chars", async () => {
    const verboseComplete: ModelComplete = async () => "x".repeat(1000);
    const gen = buildGenerateDocstring(verboseComplete);
    const docstring = await gen("code", "name", "fn");
    assert.ok(docstring.length <= 500, `docstring must be trimmed to ≤500 chars, got ${docstring.length}`);
  });
});

describe("summarize plug — end-to-end docstring generation (the GP-§8a pipeline)", () => {
  it("createSummarizeContribution produces a summarize fn that generates docstrings per def tag", async () => {
    const contribution = createSummarizeContribution(fakeComplete);
    assert.equal(contribution.kind, "summarizer");
    assert.equal(contribution.id, "docstring-summarizer");

    const input: SummarizeInput = {
      files: fakeSourceFiles,
      parsedFiles: fakeParsedFiles,
      generateDocstring: buildGenerateDocstring(fakeComplete),
    };
    const output = await contribution.summarize(input);
    assert.ok(output.summaries.length > 0, "must produce at least one summary");
    const summary = output.summaries[0]!;
    assert.equal(summary.name, "authenticate");
    assert.equal(summary.kind, "function");
    assert.match(summary.docstring, /FAKE DOCSTRING/);
    assert.ok(summary.code.length > 0, "must carry the raw code");
  });

  it("summarize skips ref tags (only def tags get docstrings)", async () => {
    const parsedWithRef: readonly ParsedFile[] = [
      {
        relPath: "src/foo.ts",
        language: "typescript",
        tags: [
          { relPath: "src/foo.ts", category: "def", name: "authenticate", subtype: "function", line: 1, column: 0, startByte: 0, endByte: 100 },
          { relPath: "src/foo.ts", category: "ref", name: "helper", subtype: "function", line: 5, column: 2, startByte: 101, endByte: 150 },
        ],
      },
    ];
    const contribution = createSummarizeContribution(fakeComplete);
    const output = await contribution.summarize({
      files: fakeSourceFiles,
      parsedFiles: parsedWithRef,
      generateDocstring: buildGenerateDocstring(fakeComplete),
    });
    assert.equal(output.summaries.length, 1, "only the def tag (not the ref) gets a summary");
    assert.equal(output.summaries[0]!.name, "authenticate");
  });

  it("summarize produces no summaries when there are no def tags", async () => {
    const parsedNoDef: readonly ParsedFile[] = [
      { relPath: "src/empty.ts", language: "typescript", tags: [] },
    ];
    const contribution = createSummarizeContribution(fakeComplete);
    const output = await contribution.summarize({
      files: [{ filepath: "src/empty.ts", source: "// no code" }],
      parsedFiles: parsedNoDef,
      generateDocstring: buildGenerateDocstring(fakeComplete),
    });
    assert.equal(output.summaries.length, 0);
  });
});
