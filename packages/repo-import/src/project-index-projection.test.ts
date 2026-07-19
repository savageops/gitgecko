import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SqliteDocumentStore } from "@gitgecko/core";
import { projectSourceRecordKey, replaceProjectIndexProjection } from "./project-index-projection.js";

describe("project index projection owner", () => {
  it("keys source documents by tenant as well as project and path", () => {
    assert.notEqual(projectSourceRecordKey("org-1", "p1", "src/a.ts"), projectSourceRecordKey("org-2", "p1", "src/a.ts"));
  });

  it("atomically replaces prior files, clears errors, and records the commit", () => {
    const store = new SqliteDocumentStore();
    store.set("projects", "p1", { id: "p1", tenantId: "org-1", ownerId: "u1", indexStatus: "pending", indexError: "old" });
    store.set("project-sources", "p1:old.ts", { ownerId: "u1", projectId: "p1", filepath: "old.ts", source: "old", indexedAt: "a" });
    const project = replaceProjectIndexProjection(store, { tenantId: "org-1", ownerId: "u1", projectId: "p1", indexCommitSha: "abc", documents: [{ tenantId: "org-1", ownerId: "u1", projectId: "p1", filepath: "new.ts", source: "new", indexedAt: "b" }] });
    assert.equal(project.indexStatus, "ready");
    assert.equal(project.indexError, undefined);
    assert.equal(project.indexCommitSha, "abc");
    assert.equal(store.get("project-sources", "p1:old.ts"), undefined, "the legacy unscoped key is removed during replacement");
    assert.ok(store.get("project-sources", projectSourceRecordKey("org-1", "p1", "new.ts")));
  });

  it("projects an empty snapshot and rejects cross-tenant documents", () => {
    const store = new SqliteDocumentStore();
    store.set("projects", "p1", { id: "p1", tenantId: "org-1", ownerId: "u1", indexStatus: "pending" });
    assert.equal(replaceProjectIndexProjection(store, { tenantId: "org-1", ownerId: "u1", projectId: "p1", documents: [] }).indexStatus, "empty");
    assert.throws(() => replaceProjectIndexProjection(store, { tenantId: "org-1", ownerId: "u1", projectId: "p1", documents: [{ tenantId: "org-2", ownerId: "u1", projectId: "p1", filepath: "x", source: "x", indexedAt: "a" }] }), /does not belong/);
    assert.throws(() => replaceProjectIndexProjection(store, { tenantId: "org-2", ownerId: "u1", projectId: "p1", documents: [] }), /does not belong/);
  });
});
