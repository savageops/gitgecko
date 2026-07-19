/**
 * TDD tests for search-lexical — trigram/BM25 lexical search (P-codeintel-7).
 *
 * Challenges the CAPABILITY: index documents → search by query → BM25-ranked
 * results, with path filtering + path boost.
 *
 * Per project TDD rule: written FIRST, fail, then code passes. Never weakened.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryLexicalIndex } from "./search-lexical.js";

describe("search-lexical — index + search", () => {
  it("indexes a document and finds it by a matching query", () => {
    const idx = new InMemoryLexicalIndex();
    idx.index([{ filepath: "src/auth.py", content: "def login(user, password): return check(password)", startLine: 0, endLine: 0 }]);
    const results = idx.search("login");
    assert.ok(results.length > 0);
    assert.equal(results[0]!.filepath, "src/auth.py");
  });

  it("returns no results for a query that doesn't match any document", () => {
    const idx = new InMemoryLexicalIndex();
    idx.index([{ filepath: "a.py", content: "def foo(): pass", startLine: 0, endLine: 0 }]);
    assert.equal(idx.search("zzzznomatch").length, 0);
  });

  it("returns no results when the index is empty", () => {
    const idx = new InMemoryLexicalIndex();
    assert.equal(idx.search("anything").length, 0);
  });
});

describe("search-lexical — BM25 ranking", () => {
  it("ranks documents with higher match density higher (BM25 length normalization)", () => {
    const idx = new InMemoryLexicalIndex();
    idx.index([
      { filepath: "sparse.py", content: "function lots of unrelated padding text here just to make it long and dilute the login keyword", startLine: 0, endLine: 0 },
      { filepath: "dense.py", content: "login login login", startLine: 0, endLine: 0 }, // high match density
    ]);
    const results = idx.search("login");
    assert.ok(results.length >= 1);
    // BM25 prefers dense matches: "dense.py" has 3x "login" in a short doc
    assert.equal(results[0]!.filepath, "dense.py");
  });

  it("scores are descending (best first)", () => {
    const idx = new InMemoryLexicalIndex();
    idx.index([
      { filepath: "a.py", content: "console.log login check", startLine: 0, endLine: 0 },
      { filepath: "b.py", content: "login", startLine: 0, endLine: 0 },
      { filepath: "c.py", content: "totally unrelated", startLine: 0, endLine: 0 },
    ]);
    const results = idx.search("login");
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1]!.score >= results[i]!.score, "scores must be descending");
    }
  });
});

describe("search-lexical — path filtering + boost", () => {
  it("filters by path prefix", () => {
    const idx = new InMemoryLexicalIndex();
    idx.index([
      { filepath: "src/auth/login.py", content: "def login(): pass", startLine: 0, endLine: 0 },
      { filepath: "test/login_test.py", content: "def login(): pass", startLine: 0, endLine: 0 },
    ]);
    const results = idx.search("login", { pathPrefix: "src/" });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.filepath, "src/auth/login.py");
  });

  it("boosts path matches (filepath containing query substring gets higher score)", () => {
    const idx = new InMemoryLexicalIndex();
    idx.index([
      { filepath: "login.py", content: "def authenticate(): pass", startLine: 0, endLine: 0 }, // path matches "login"
      { filepath: "other.py", content: "def authenticate(): pass", startLine: 0, endLine: 0 }, // same content, no path match
    ]);
    // Query "login" — both docs have "authenticate" content but only login.py matches via filepath
    const results = idx.search("login");
    assert.ok(results.length >= 1);
    // The one with "login" in the path must be found (path boost makes it match)
    assert.ok(results.some((r) => r.filepath === "login.py"), "login.py must be in results (path boost)");
    // login.py should have a higher score than other.py (if both appear)
    const loginResult = results.find((r) => r.filepath === "login.py");
    const otherResult = results.find((r) => r.filepath === "other.py");
    if (loginResult && otherResult) {
      assert.ok(loginResult.score > otherResult.score, "path-boosted doc must rank higher");
    }
  });
});

describe("search-lexical — multi-document indexing", () => {
  it("indexes multiple documents and searches across them", () => {
    const idx = new InMemoryLexicalIndex();
    idx.index([
      { filepath: "src/a.py", content: "def add(a, b): return a + b", startLine: 0, endLine: 0 },
      { filepath: "src/b.py", content: "def multiply(x, y): return x * y", startLine: 0, endLine: 0 },
      { filepath: "src/c.py", content: "class Calculator: pass", startLine: 0, endLine: 0 },
    ]);
    assert.ok(idx.search("add").some((r) => r.filepath === "src/a.py"));
    assert.ok(idx.search("multiply").some((r) => r.filepath === "src/b.py"));
    assert.ok(idx.search("Calculator").some((r) => r.filepath === "src/c.py"));
  });

  it("respects the limit parameter", () => {
    const idx = new InMemoryLexicalIndex();
    idx.index(Array.from({ length: 10 }, (_, i) => ({
      filepath: `f${i}.py`, content: `def login_${i}(): pass`, startLine: 0, endLine: 0,
    })));
    const results = idx.search("login", { limit: 3 });
    assert.equal(results.length, 3);
  });
});

describe("search-lexical — clear", () => {
  it("clear empties the index", () => {
    const idx = new InMemoryLexicalIndex();
    idx.index([{ filepath: "a.py", content: "hello world", startLine: 0, endLine: 0 }]);
    idx.clear();
    assert.equal(idx.search("hello").length, 0);
  });
});
