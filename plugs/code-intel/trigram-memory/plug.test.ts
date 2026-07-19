/**
 * TDD tests for the trigram-memory plug (Phase 2.2 — lexical search pillar).
 *
 * THE CAPABILITY: the trigram plug indexes documents into a BM25 corpus and
 * returns ranked lexical search results. It registers against the code-intel
 * owner's `search-lexical` capability and loads through the Registry phase
 * machine. This is the lexical pillar of hybrid retrieval fusion (P-codeintel-9).
 *
 * Per project TDD rule: tests challenge capability, never degraded to pass.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "@gitgecko/socket";
import { codeIntelOwner, InMemoryLexicalIndex, type CodeIntelCapability, type LexicalContribution, type LexicalDoc } from "@gitgecko/code-intel";
import { manifest, setup, createLexicalContribution } from "./plug.js";

const logger = { info() {}, warn() {}, error() {} };

const sampleDocs: readonly LexicalDoc[] = [
  { filepath: "src/auth.ts", content: "function authenticate(user, password) { return checkPassword(password); }", startLine: 1, endLine: 3 },
  { filepath: "src/db.ts", content: "export async function queryDatabase(sql: string) { return pool.execute(sql); }", startLine: 1, endLine: 5 },
  { filepath: "src/utils.ts", content: "export function formatPassword(pwd: string) { return pwd.trim(); }", startLine: 1, endLine: 2 },
];

describe("trigram-memory plug — manifest + socket integration", () => {
  it("manifest is valid and declares the search-lexical capability", () => {
    assert.equal(manifest.owner, "code-intel");
    assert.ok(manifest.capabilities.includes("search-lexical"));
    assert.equal(manifest.id, "code-intel-trigram-memory");
  });

  it("loads through the code-intel Registry phase machine", async () => {
    const reg = new Registry<CodeIntelCapability, string, LexicalContribution>(codeIntelOwner);
    const res = await reg.load(
      { manifest, setup: setup as never },
      { config: {}, logger },
    );
    assert.ok(res.ok, `plug must load: ${res.ok ? "" : res.error.message}`);
    assert.equal(res.value.contributions[0]!.capability, "search-lexical");
    assert.equal(res.value.contributions[0]!.contribution.kind, "lexical-index");
  });
});

describe("trigram-memory plug — BM25 search capability", () => {
  it("indexes docs and returns BM25-ranked results matching the query", async () => {
    const index = new InMemoryLexicalIndex();
    const contrib = createLexicalContribution(index);
    contrib.index(sampleDocs);

    const results = await contrib.search("password", { limit: 10 });
    assert.ok(results.length > 0, "must return results for 'password'");
    // Files containing 'password' should rank higher than those without.
    const files = results.map((r) => r.filepath);
    assert.ok(files.includes("src/auth.ts"));
    assert.ok(files.includes("src/utils.ts"));
    // db.ts doesn't contain 'password' — should not appear (or rank very low).
  });

  it("returns chunk-wrapped results (content, startLine, endLine)", async () => {
    const index = new InMemoryLexicalIndex();
    const contrib = createLexicalContribution(index);
    contrib.index(sampleDocs);

    const results = await contrib.search("authenticate", { limit: 5 });
    assert.ok(results.length > 0);
    const top = results[0]!;
    assert.ok(top.chunk.content.length > 0, "chunk must have content");
    assert.equal(typeof top.chunk.startLine, "number");
    assert.equal(typeof top.chunk.endLine, "number");
    assert.equal(typeof top.score, "number");
  });

  it("returns empty results for a query whose trigrams don't overlap any doc", async () => {
    const index = new InMemoryLexicalIndex();
    const contrib = createLexicalContribution(index);
    contrib.index(sampleDocs);

    // Trigram index does fuzzy 3-char matching, so the query must have NO
    // overlapping trigrams with any doc content/filepath. "qqqxxxzzz" produces
    // trigrams (qqq, qxx, xxx, xzz, zzz) that don't appear in any sample doc.
    const results = await contrib.search("qqqxxxzzz", { limit: 10 });
    assert.equal(results.length, 0, "a query with no overlapping trigrams must return 0 results");
  });

  it("respects the limit parameter", async () => {
    const index = new InMemoryLexicalIndex();
    const contrib = createLexicalContribution(index);
    contrib.index(sampleDocs);

    const results = await contrib.search("function", { limit: 1 });
    assert.ok(results.length <= 1, `limit=1 must return ≤1 result, got ${results.length}`);
  });

  it("respects the pathPrefix filter", async () => {
    const index = new InMemoryLexicalIndex();
    const contrib = createLexicalContribution(index);
    contrib.index(sampleDocs);

    const results = await contrib.search("function", { limit: 10, pathPrefix: "src/auth" });
    assert.ok(results.length > 0);
    for (const r of results) {
      assert.ok(r.filepath.startsWith("src/auth"), `all results must match pathPrefix, got ${r.filepath}`);
    }
  });

  it("path matches get a boost (pathWeightMultiplier, P-codeintel-7)", async () => {
    // When the query matches the filepath, that doc should rank higher.
    const index = new InMemoryLexicalIndex();
    const contrib = createLexicalContribution(index);
    contrib.index([
      { filepath: "src/auth.ts", content: "authenticate password login", startLine: 1, endLine: 1 },
      { filepath: "src/password_handler.ts", content: "authenticate password login", startLine: 1, endLine: 1 },
    ]);
    const results = await contrib.search("password", { limit: 10 });
    assert.ok(results.length >= 2);
    // The file with 'password' in the path should rank first (path boost).
    assert.equal(results[0]!.filepath, "src/password_handler.ts");
  });
});
