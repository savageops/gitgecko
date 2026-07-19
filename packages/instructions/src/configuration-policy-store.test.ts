import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDocumentStore } from "@gitgecko/core";
import {
  INSTRUCTION_POLICY_CURRENT_NAMESPACE,
  INSTRUCTION_POLICY_REVISION_NAMESPACE,
  InstructionPolicyStore,
  InstructionPolicyConflict,
  validateInstructionPolicyDocument,
} from "./configuration-policy-store.js";

const rule = (id: string, instruction = id) => ({ id, enabled: true as const, instruction });
const clock = () => new Date("2026-07-18T12:00:00.000Z");

const fixture = (run: (policy: InstructionPolicyStore, documents: SqliteDocumentStore, path: string) => void): void => {
  const directory = mkdtempSync(join(tmpdir(), "gitgecko-policy-"));
  const path = join(directory, "control.db");
  const documents = new SqliteDocumentStore(path);
  try {
    run(new InstructionPolicyStore(documents, clock), documents, path);
  } finally {
    documents.close();
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("instruction policy document validation", () => {
  const valid = () => ({
    schemaVersion: "instruction-policy.v1" as const,
    tenantId: "org-1",
    scope: "organization" as const,
    revision: 1,
    rules: [rule("secure")],
    createdAt: clock().toISOString(),
    createdBy: "user-1",
  });

  it("accepts an organization document", () => assert.equal(validateInstructionPolicyDocument(valid()).scope, "organization"));
  it("accepts a repository document", () => assert.equal(validateInstructionPolicyDocument({ ...valid(), scope: "repository", projectId: "repo-1", inheritOrganization: true }).scope, "repository"));
  it("rejects a non-object", () => assert.throws(() => validateInstructionPolicyDocument(null), /must be an object/));
  it("rejects an unknown schema", () => assert.throws(() => validateInstructionPolicyDocument({ ...valid(), schemaVersion: "v2" }), /unsupported/));
  it("rejects an empty tenant", () => assert.throws(() => validateInstructionPolicyDocument({ ...valid(), tenantId: "" }), /tenant id/));
  it("rejects an invalid scope", () => assert.throws(() => validateInstructionPolicyDocument({ ...valid(), scope: "account" }), /scope/));
  it("rejects a zero revision", () => assert.throws(() => validateInstructionPolicyDocument({ ...valid(), revision: 0 }), /revision/));
  it("rejects a fractional revision", () => assert.throws(() => validateInstructionPolicyDocument({ ...valid(), revision: 1.5 }), /revision/));
  it("rejects missing rules", () => assert.throws(() => validateInstructionPolicyDocument({ ...valid(), rules: undefined }), /rules/));
  it("rejects malformed rules through the canonical resolver", () => assert.throws(() => validateInstructionPolicyDocument({ ...valid(), rules: [rule("Bad ID")] }), /rule id/));
  it("rejects a repository without project identity", () => assert.throws(() => validateInstructionPolicyDocument({ ...valid(), scope: "repository", inheritOrganization: true }), /project id/));
  it("rejects a repository without inheritance intent", () => assert.throws(() => validateInstructionPolicyDocument({ ...valid(), scope: "repository", projectId: "repo-1" }), /inheritance flag/));
  it("rejects organization project identity", () => assert.throws(() => validateInstructionPolicyDocument({ ...valid(), projectId: "repo-1" }), /cannot include a project/));
  it("rejects organization inheritance intent", () => assert.throws(() => validateInstructionPolicyDocument({ ...valid(), inheritOrganization: true }), /inheritance flag/));
  it("rejects an invalid creation time", () => assert.throws(() => validateInstructionPolicyDocument({ ...valid(), createdAt: "later" }), /creation time/));
  it("rejects an empty actor", () => assert.throws(() => validateInstructionPolicyDocument({ ...valid(), createdBy: "" }), /actor id/));
  it("accepts rollback provenance", () => assert.equal(validateInstructionPolicyDocument({ ...valid(), restoredFromRevision: 1 }).restoredFromRevision, 1));
  it("rejects invalid rollback provenance", () => assert.throws(() => validateInstructionPolicyDocument({ ...valid(), restoredFromRevision: 0 }), /restored revision/));
});

describe("durable instruction policy store", () => {
  it("returns undefined before the first write", () => fixture((policy) => assert.equal(policy.get("org-1", "organization"), undefined)));
  it("creates revision one only from expected revision zero", () => fixture((policy) => {
    assert.equal(policy.put({ tenantId: "org-1", scope: "organization", rules: [rule("a")], expectedRevision: 0, actorId: "user-1" }).revision, 1);
  }));
  it("persists actor and creation time", () => fixture((policy) => {
    const result = policy.put({ tenantId: "org-1", scope: "organization", rules: [], expectedRevision: 0, actorId: "user-1" });
    assert.equal(result.createdBy, "user-1"); assert.equal(result.createdAt, clock().toISOString());
  }));
  it("increments revisions", () => fixture((policy) => {
    policy.put({ tenantId: "org-1", scope: "organization", rules: [rule("a")], expectedRevision: 0, actorId: "user-1" });
    assert.equal(policy.put({ tenantId: "org-1", scope: "organization", rules: [rule("b")], expectedRevision: 1, actorId: "user-1" }).revision, 2);
  }));
  it("rejects stale optimistic writes", () => fixture((policy) => {
    policy.put({ tenantId: "org-1", scope: "organization", rules: [], expectedRevision: 0, actorId: "user-1" });
    assert.throws(() => policy.put({ tenantId: "org-1", scope: "organization", rules: [], expectedRevision: 0, actorId: "user-2" }), /revision conflict/);
  }));
  it("keeps stale writes out of history", () => fixture((policy) => {
    policy.put({ tenantId: "org-1", scope: "organization", rules: [], expectedRevision: 0, actorId: "user-1" });
    assert.throws(() => policy.put({ tenantId: "org-1", scope: "organization", rules: [], expectedRevision: 0, actorId: "user-2" }));
    assert.equal(policy.history("org-1", "organization").length, 1);
  }));
  it("stores repository inheritance intent", () => fixture((policy) => {
    assert.equal(policy.put({ tenantId: "org-1", scope: "repository", projectId: "repo-1", rules: [], inheritOrganization: false, expectedRevision: 0, actorId: "user-1" }).inheritOrganization, false);
  }));
  it("rejects repository writes without inheritance intent", () => fixture((policy) => {
    assert.throws(() => policy.put({ tenantId: "org-1", scope: "repository", projectId: "repo-1", rules: [], expectedRevision: 0, actorId: "user-1" }), /inheritance flag/);
  }));
  it("isolates tenants", () => fixture((policy) => {
    policy.put({ tenantId: "org-1", scope: "organization", rules: [rule("one")], expectedRevision: 0, actorId: "user-1" });
    policy.put({ tenantId: "org-2", scope: "organization", rules: [rule("two")], expectedRevision: 0, actorId: "user-2" });
    assert.equal(policy.get("org-1", "organization")?.rules[0]?.id, "one");
  }));
  it("isolates repositories", () => fixture((policy) => {
    policy.put({ tenantId: "org-1", scope: "repository", projectId: "repo-1", rules: [rule("one")], inheritOrganization: true, expectedRevision: 0, actorId: "user-1" });
    assert.equal(policy.get("org-1", "repository", "repo-2"), undefined);
  }));
  it("lists immutable history newest first", () => fixture((policy) => {
    policy.put({ tenantId: "org-1", scope: "organization", rules: [rule("one")], expectedRevision: 0, actorId: "user-1" });
    policy.put({ tenantId: "org-1", scope: "organization", rules: [rule("two")], expectedRevision: 1, actorId: "user-1" });
    assert.deepEqual(policy.history("org-1", "organization").map((entry) => entry.revision), [2, 1]);
  }));
  it("survives a second database connection", () => fixture((policy, _documents, path) => {
    policy.put({ tenantId: "org-1", scope: "organization", rules: [rule("durable")], expectedRevision: 0, actorId: "user-1" });
    const reopened = new SqliteDocumentStore(path);
    try { assert.equal(new InstructionPolicyStore(reopened).get("org-1", "organization")?.rules[0]?.id, "durable"); } finally { reopened.close(); }
  }));
  it("fails closed on corrupt current state", () => fixture((policy, documents) => {
    documents.set(`${INSTRUCTION_POLICY_CURRENT_NAMESPACE}:v1:org-1`, "organization", { schemaVersion: "broken" });
    assert.throws(() => policy.get("org-1", "organization"), /unsupported/);
  }));
  it("does not let another tenant's corrupt history poison a read", () => fixture((policy, documents) => {
    policy.put({ tenantId: "org-1", scope: "organization", rules: [], expectedRevision: 0, actorId: "user-1" });
    documents.set(`${INSTRUCTION_POLICY_REVISION_NAMESPACE}:v1:org-2`, "organization:000000000001", { tenantId: "org-2", scope: "organization", schemaVersion: "broken" });
    assert.equal(policy.history("org-1", "organization").length, 1);
  }));
  it("fails closed on corrupt selected history", () => fixture((policy, documents) => {
    documents.set(`${INSTRUCTION_POLICY_REVISION_NAMESPACE}:v1:org-1`, "organization:000000000001", { tenantId: "org-1", scope: "organization", schemaVersion: "broken" });
    assert.throws(() => policy.history("org-1", "organization"), /unsupported/);
  }));
  it("resolves organization and repository layers", () => fixture((policy) => {
    policy.put({ tenantId: "org-1", scope: "organization", rules: [rule("org")], expectedRevision: 0, actorId: "user-1" });
    policy.put({ tenantId: "org-1", scope: "repository", projectId: "repo-1", rules: [rule("repo")], inheritOrganization: true, expectedRevision: 0, actorId: "user-1" });
    const input = policy.resolve("org-1", "repo-1");
    assert.equal(input.organization?.revision, "1"); assert.equal(input.repository?.revision, "1");
  }));
  it("resolves organization defaults without a repository override", () => fixture((policy) => {
    policy.put({ tenantId: "org-1", scope: "organization", rules: [rule("org")], expectedRevision: 0, actorId: "user-1" });
    assert.equal(policy.resolve("org-1", "repo-1").organization?.rules[0]?.id, "org");
  }));
  it("rolls back by appending a new revision", () => fixture((policy) => {
    policy.put({ tenantId: "org-1", scope: "organization", rules: [rule("one")], expectedRevision: 0, actorId: "user-1" });
    policy.put({ tenantId: "org-1", scope: "organization", rules: [rule("two")], expectedRevision: 1, actorId: "user-1" });
    const restored = policy.rollback({ tenantId: "org-1", scope: "organization", targetRevision: 1, expectedRevision: 2, actorId: "user-2" });
    assert.equal(restored.revision, 3); assert.equal(restored.rules[0]?.id, "one"); assert.equal(restored.restoredFromRevision, 1);
  }));
  it("rejects rollback to a missing revision", () => fixture((policy) => {
    assert.throws(() => policy.rollback({ tenantId: "org-1", scope: "organization", targetRevision: 1, expectedRevision: 0, actorId: "user-1" }), /not found/);
  }));
  it("rejects rollback with a stale current revision", () => fixture((policy) => {
    policy.put({ tenantId: "org-1", scope: "organization", rules: [], expectedRevision: 0, actorId: "user-1" });
    assert.throws(() => policy.rollback({ tenantId: "org-1", scope: "organization", targetRevision: 1, expectedRevision: 0, actorId: "user-1" }), /revision conflict/);
  }));
  it("returns a typed revision conflict for transport mapping", () => fixture((policy) => {
    policy.put({ tenantId: "org-1", scope: "organization", rules: [], expectedRevision: 0, actorId: "user-1" });
    assert.throws(
      () => policy.put({ tenantId: "org-1", scope: "organization", rules: [], expectedRevision: 0, actorId: "user-2" }),
      (error) => error instanceof InstructionPolicyConflict && error.currentRevision === 1 && error.expectedRevision === 0,
    );
  }));
  it("preserves repository inheritance through rollback", () => fixture((policy) => {
    policy.put({ tenantId: "org-1", scope: "repository", projectId: "repo-1", rules: [rule("one")], inheritOrganization: false, expectedRevision: 0, actorId: "user-1" });
    policy.put({ tenantId: "org-1", scope: "repository", projectId: "repo-1", rules: [rule("two")], inheritOrganization: true, expectedRevision: 1, actorId: "user-1" });
    assert.equal(policy.rollback({ tenantId: "org-1", scope: "repository", projectId: "repo-1", targetRevision: 1, expectedRevision: 2, actorId: "user-2" }).inheritOrganization, false);
  }));
});
