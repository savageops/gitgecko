/**
 * TDD tests for SQLite persistence — verifies data survives across store instances.
 *
 * The key capability under test: data written to one store instance is readable
 * from a NEW instance pointed at the same file. This proves persistence (data
 * survives process restart).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SqliteDocumentStore, SqliteEmbedStore, SqliteTraceStore } from "./persistence.js";
import type { EmbedTag, TraceRecord } from "./store-types.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DB_PATH = join(tmpdir(), `gitgecko-test-${Date.now()}.db`);
const cleanup = () => { try { unlinkSync(DB_PATH); } catch { /* ok */ } };

describe("SqliteEmbedStore — persistence", () => {
  it("stores rows and retrieves them in the SAME instance", async () => {
    const store = new SqliteEmbedStore(":memory:");
    const tag: EmbedTag = { repo: "r", branch: "main", embeddingId: "test" };
    await store.upsert(tag, [
      { uuid: "u1", path: "a.py", cacheKey: "0-0", vector: [1, 0, 0], content: "def f(): pass", startLine: 0, endLine: 0 },
    ]);
    assert.equal(await store.count(tag), 1);
    store.close();
  });

  it("data persists across instances (survives restart)", async () => {
    cleanup();
    const tag: EmbedTag = { repo: "r2", branch: "main", embeddingId: "test" };

    // Write with instance 1
    const store1 = new SqliteEmbedStore(DB_PATH);
    await store1.upsert(tag, [
      { uuid: "persist-1", path: "b.py", cacheKey: "0-0", vector: [0, 1, 0], content: "def g(): pass", startLine: 0, endLine: 0 },
    ]);
    assert.equal(await store1.count(tag), 1);
    store1.close();

    // Read with instance 2 (new process pointing at same file)
    const store2 = new SqliteEmbedStore(DB_PATH);
    assert.equal(await store2.count(tag), 1, "data must survive restart");
    const results = await store2.retrieve(tag, [0, 1, 0], { limit: 5 });
    assert.ok(results.length > 0, "retrieve must find the persisted row");
    assert.equal(results[0]!.path, "b.py");
    store2.close();
    cleanup();
  });

  it("retrieves nearest by cosine distance", async () => {
    const store = new SqliteEmbedStore(":memory:");
    const tag: EmbedTag = { repo: "r", branch: "main", embeddingId: "test" };
    await store.upsert(tag, [
      { uuid: "a", path: "a.py", cacheKey: "0", vector: [1, 0, 0], content: "a", startLine: 0, endLine: 0 },
      { uuid: "b", path: "b.py", cacheKey: "0", vector: [0, 1, 0], content: "b", startLine: 0, endLine: 0 },
      { uuid: "c", path: "c.py", cacheKey: "0", vector: [0.9, 0.1, 0], content: "c", startLine: 0, endLine: 0 },
    ]);
    // Query vector [1,0,0] → nearest should be "a" (identical)
    const results = await store.retrieve(tag, [1, 0, 0], { limit: 1 });
    assert.equal(results[0]!.path, "a.py");
    store.close();
  });

  it("clears rows for a tag", async () => {
    const store = new SqliteEmbedStore(":memory:");
    const tag: EmbedTag = { repo: "r", branch: "main", embeddingId: "test" };
    await store.upsert(tag, [{ uuid: "x", path: "x", cacheKey: "0", vector: [1], content: "x", startLine: 0, endLine: 0 }]);
    await store.clear(tag);
    assert.equal(await store.count(tag), 0);
    store.close();
  });
});

describe("SqliteTraceStore — persistence", () => {
  it("records and reads steps", () => {
    const store = new SqliteTraceStore(":memory:");
    store.record({
      runId: "r1", stepId: "s1", ts: "2026-01-01T00:00:00Z", command: "review", output: "LGTM", source: "llm",
    });
    const trace = store.read("r1");
    assert.equal(trace.steps.length, 1);
    assert.equal(trace.steps[0]!.output, "LGTM");
    store.close();
  });

  it("data persists across instances", () => {
    cleanup();
    const store1 = new SqliteTraceStore(DB_PATH);
    store1.record({
      runId: "persist", stepId: "s1", ts: "2026-01-01T00:00:00Z", command: "review", output: "persisted", source: "llm",
    });
    store1.close();

    const store2 = new SqliteTraceStore(DB_PATH);
    const trace = store2.read("persist");
    assert.equal(trace.steps.length, 1, "trace data must survive restart");
    assert.equal(trace.steps[0]!.output, "persisted");
    store2.close();
    cleanup();
  });

  it("exportJson produces valid JSON", () => {
    const store = new SqliteTraceStore(":memory:");
    store.record({ runId: "r1", stepId: "s1", ts: "2026-01-01T00:00:00Z", command: "review", output: "ok", source: "llm" });
    const json = JSON.parse(store.exportJson("r1"));
    assert.equal(json.runId, "r1");
    assert.equal(json.steps.length, 1);
    store.close();
  });
});

describe("SqliteDocumentStore — control-plane persistence", () => {
  it("preserves namespaced documents across store instances", () => {
    cleanup();
    const first = new SqliteDocumentStore(DB_PATH);
    first.set("projects", "project-1", { id: "project-1", ownerId: "user-1" });
    first.close();

    const second = new SqliteDocumentStore(DB_PATH);
    assert.deepEqual(second.get("projects", "project-1"), { id: "project-1", ownerId: "user-1" });
    assert.deepEqual(second.list("projects"), [{ id: "project-1", ownerId: "user-1" }]);
    assert.equal(second.delete("projects", "project-1"), true);
    assert.equal(second.get("projects", "project-1"), undefined);
    second.close();
    cleanup();
  });

  it("commits grouped document mutations atomically", () => {
    const store = new SqliteDocumentStore(":memory:");
    store.transaction(() => {
      store.set("usage", "user-1", { credits: 1 });
      store.set("reservations", "request-1", { status: "reserved" });
    });
    assert.deepEqual(store.get("usage", "user-1"), { credits: 1 });
    assert.deepEqual(store.get("reservations", "request-1"), { status: "reserved" });
    store.close();
  });

  it("rolls back every grouped mutation when the operation throws", () => {
    const store = new SqliteDocumentStore(":memory:");
    assert.throws(() => store.transaction(() => {
      store.set("usage", "user-1", { credits: 1 });
      throw new Error("abort");
    }));
    assert.equal(store.get("usage", "user-1"), undefined);
    store.close();
  });
});
