import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectActivitySchema, pushProjectActivityId } from "./project-activity.js";

describe("project activity contract", () => {
  it("accepts both completed owner variants", () => {
    const review = projectActivitySchema.parse({
      id: "review:run-1",
      kind: "review",
      tenantId: "organization-1",
      ownerId: "owner-1",
      projectId: "project-1",
      occurredAt: "2026-07-16T00:00:00.000Z",
      runId: "run-1",
      title: "Review",
      errorCount: 0,
      warningCount: 0,
      infoCount: 1,
      mergeable: true,
      blastRadius: "low",
      findings: [],
    });
    const push = projectActivitySchema.parse({
      id: "push:delivery-1",
      kind: "push",
      tenantId: "organization-1",
      ownerId: "owner-1",
      projectId: "project-1",
      occurredAt: "2026-07-16T00:01:00.000Z",
      deliveryId: "delivery-1",
      commitSha: "abc123",
      ref: "refs/heads/main",
      filesIndexed: 3,
    });
    assert.equal(review.kind, "review");
    assert.equal(push.kind, "push");
  });

  it("rejects incomplete and cross-variant field mixtures", () => {
    assert.equal(projectActivitySchema.safeParse({ kind: "push" }).success, false);
    assert.equal(projectActivitySchema.safeParse({
      id: "push:d1",
      kind: "push",
      tenantId: "organization-1",
      ownerId: "owner-1",
      projectId: "project-1",
      occurredAt: "not-a-date",
      deliveryId: "d1",
      runId: "run-1",
      commitSha: "abc",
      ref: "main",
      filesIndexed: -1,
    }).success, false);
  });

  it("derives replay-stable push identity from the delivery", () => {
    assert.equal(pushProjectActivityId("delivery-1"), "push:delivery-1");
    assert.equal(pushProjectActivityId("delivery-1"), pushProjectActivityId("delivery-1"));
  });
});
