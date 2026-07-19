import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

import {
  DEFAULT_RETRY_POLICY,
  JobDispatchError,
  jobDispatchOwner,
  type ReviewWorkPayload,
  type IndexWorkPayload,
} from "@gitgecko/job-dispatch";
import { Registry, type Logger } from "@gitgecko/socket";

import {
  createSqliteJobDispatchPlug,
  SqliteJobDispatchStore,
  type SqliteJobDispatchOptions,
} from "./plug.js";
import { manifest } from "./plug.js";

const now = new Date("2026-07-11T00:00:00.000Z");

const payload = (overrides: Partial<ReviewWorkPayload> = {}): ReviewWorkPayload => ({
  tenantId: "organization-1",
  ownerId: "owner-1",
  projectId: "project-1",
  deliveryId: "delivery-1",
  installationId: "installation-1",
  repositoryId: "repository-1",
  pullNumber: 42,
  ...overrides,
});

const indexPayload = (overrides: Partial<IndexWorkPayload> = {}): IndexWorkPayload => ({
  tenantId: "organization-1",
  ownerId: "owner-1",
  projectId: "project-1",
  deliveryId: "delivery-1",
  installationId: "installation-1",
  repositoryId: "repository-1",
  ref: "refs/heads/main",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  ...overrides,
});

const options = (overrides: Partial<SqliteJobDispatchOptions> = {}): SqliteJobDispatchOptions => ({
  databasePath: ":memory:",
  ...overrides,
});

const withStore = <T>(run: (store: SqliteJobDispatchStore) => T, overrides: Partial<SqliteJobDispatchOptions> = {}): T => {
  const store = new SqliteJobDispatchStore(options(overrides));
  try {
    return run(store);
  } finally {
    store.close();
  }
};

const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("SQLite job-dispatch plug", () => {
  it("declares the review plug manifest", () => {
    assert.equal(manifest.id, "job-dispatch-sqlite");
    assert.equal(manifest.owner, "job-dispatch");
    assert.deepEqual(manifest.capabilities, ["review", "index"]);
  });

  it("registers its durable contribution through the socket", async () => {
    const registry = new Registry(jobDispatchOwner);
    const result = await registry.load(createSqliteJobDispatchPlug(options()), {
      config: {},
      logger,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.contributions.length, 2);
    assert.equal(result.value.contributions[0]?.capability, "review");
    assert.equal(result.value.contributions[0]?.contribution.kind, "review-work");
    assert.equal(result.value.contributions[0]?.contribution.mutates, true);
    assert.equal(result.value.contributions[1]?.capability, "index");
    assert.equal(result.value.contributions[1]?.contribution, result.value.contributions[0]?.contribution);
  });

  it("enqueues a typed review item in the queued state", () => {
    withStore((store) => {
      const result = store.enqueueReview({
        idempotencyKey: "delivery-1:review",
        payload: payload(),
        now,
      });

      assert.equal(result.created, true);
      assert.equal(result.item.kind, "review");
      assert.equal(result.item.state, "queued");
      assert.equal(result.item.attempts, 0);
      assert.equal(result.item.maxAttempts, DEFAULT_RETRY_POLICY.maxAttempts);
      assert.deepEqual(result.item.payload, payload());
    });
  });

  it("returns the original item for a repeated idempotency key", () => {
    withStore((store) => {
      const first = store.enqueueReview({ idempotencyKey: "same-key", payload: payload(), now });
      const second = store.enqueueReview({ idempotencyKey: "same-key", payload: payload(), now: new Date(now.getTime() + 5_000) });

      assert.equal(second.created, false);
      assert.equal(second.item.workId, first.item.workId);
      assert.equal(second.item.createdAt, first.item.createdAt);
    });
  });

  it("rejects an idempotency key reused for different work", () => {
    withStore((store) => {
      store.enqueueReview({ idempotencyKey: "same-key", payload: payload(), now });

      assert.throws(
        () => store.enqueueReview({ idempotencyKey: "same-key", payload: payload({ pullNumber: 43 }), now }),
        (error: unknown) => error instanceof JobDispatchError && error.code === "idempotency_conflict",
      );
    });
  });

  it("survives a store reopen with the same database", () => {
    const directory = mkdtempSync(join(tmpdir(), "gitgecko-job-dispatch-"));
    const databasePath = join(directory, "jobs.sqlite");
    try {
      const first = new SqliteJobDispatchStore(options({ databasePath }));
      const created = first.enqueueReview({ idempotencyKey: "persisted", payload: payload(), now });
      first.close();

      const second = new SqliteJobDispatchStore(options({ databasePath }));
      try {
        const found = second.getReview(created.item.workId);
        assert.deepEqual(found, created.item);
      } finally {
        second.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("atomically leases the next available item with an owner and expiry", () => {
    withStore((store) => {
      store.enqueueReview({ idempotencyKey: "lease-me", payload: payload(), now });
      const leased = store.leaseReview({ workerId: "worker-a", leaseDurationMs: 30_000, now });

      assert.ok(leased);
      assert.equal(leased.state, "leased");
      assert.equal(leased.leaseOwner, "worker-a");
      assert.equal(Date.parse(leased.leaseExpiresAt ?? ""), now.getTime() + 30_000);
      assert.equal(leased.attempts, 1);
    });
  });

  it("does not lease work before its retry window", () => {
    withStore((store) => {
      store.enqueueReview({ idempotencyKey: "not-yet", payload: payload(), now });
      const leased = store.leaseReview({ workerId: "worker-a", leaseDurationMs: 30_000, now: new Date(now.getTime() - 1) });

      assert.equal(leased, undefined);
    });
  });

  it("does not hand an active lease to another worker", () => {
    withStore((store) => {
      store.enqueueReview({ idempotencyKey: "one-lease", payload: payload(), now });
      store.leaseReview({ workerId: "worker-a", leaseDurationMs: 30_000, now });

      assert.equal(store.leaseReview({ workerId: "worker-b", leaseDurationMs: 30_000, now }), undefined);
    });
  });

  it("renews a review lease without creating a second attempt", () => {
    withStore((store) => {
      store.enqueueReview({ idempotencyKey: "renew-review", payload: payload(), now });
      const leased = store.leaseReview({ workerId: "worker-a", leaseDurationMs: 10, now });
      assert.ok(leased);

      const renewed = store.renewReview({
        workId: leased.workId,
        workerId: "worker-a",
        leaseDurationMs: 30_000,
        now: new Date(now.getTime() + 5),
      });

      assert.equal(renewed.attempts, 1);
      assert.equal(renewed.leaseOwner, "worker-a");
      assert.equal(renewed.leaseExpiresAt, new Date(now.getTime() + 30_005).toISOString());
      assert.equal(store.leaseReview({ workerId: "worker-b", leaseDurationMs: 30_000, now: new Date(now.getTime() + 11) }), undefined);
    });
  });

  it("fences renewal by the active review lease owner and expiry", () => {
    withStore((store) => {
      store.enqueueReview({ idempotencyKey: "renew-fence", payload: payload(), now });
      const leased = store.leaseReview({ workerId: "worker-a", leaseDurationMs: 10, now });
      assert.ok(leased);

      assert.throws(
        () => store.renewReview({ workId: leased.workId, workerId: "worker-b", leaseDurationMs: 30_000, now: new Date(now.getTime() + 1) }),
        (error: unknown) => error instanceof JobDispatchError && error.code === "lease_conflict",
      );
      assert.throws(
        () => store.renewReview({ workId: leased.workId, workerId: "worker-a", leaseDurationMs: 30_000, now: new Date(now.getTime() + 11) }),
        (error: unknown) => error instanceof JobDispatchError && error.code === "lease_conflict",
      );
    });
  });

  it("completes only when the lease owner presents an unexpired lease", () => {
    withStore((store) => {
      store.enqueueReview({ idempotencyKey: "complete-me", payload: payload(), now });
      const leased = store.leaseReview({ workerId: "worker-a", leaseDurationMs: 30_000, now });
      assert.ok(leased);

      assert.throws(
        () => store.completeReview({ workId: leased.workId, workerId: "worker-b", now }),
        (error: unknown) => error instanceof JobDispatchError && error.code === "lease_conflict",
      );
      const completed = store.completeReview({ workId: leased.workId, workerId: "worker-a", now });

      assert.equal(completed.state, "completed");
      assert.equal(completed.leaseOwner, undefined);
      assert.equal(completed.leaseExpiresAt, undefined);
      assert.equal(completed.completedAt, now.toISOString());
    });
  });

  it("rejects completion after the lease expiry fence", () => {
    withStore((store) => {
      store.enqueueReview({ idempotencyKey: "expired-complete", payload: payload(), now });
      const leased = store.leaseReview({ workerId: "worker-a", leaseDurationMs: 10, now });
      assert.ok(leased);

      assert.throws(
        () => store.completeReview({ workId: leased.workId, workerId: "worker-a", now: new Date(now.getTime() + 11) }),
        (error: unknown) => error instanceof JobDispatchError && error.code === "lease_conflict",
      );
    });
  });

  it("schedules retry with bounded exponential delay", () => {
    withStore((store) => {
      store.enqueueReview({ idempotencyKey: "retry-me", payload: payload(), now });
      const firstLease = store.leaseReview({ workerId: "worker-a", leaseDurationMs: 30_000, now });
      assert.ok(firstLease);
      const firstRetry = store.retryReview({ workId: firstLease.workId, workerId: "worker-a", error: "temporary", now });

      assert.equal(firstRetry.deadLettered, false);
      assert.equal(firstRetry.item.state, "retry_wait");
      assert.equal(firstRetry.retryAt, new Date(now.getTime() + 1_000).toISOString());
      assert.equal(firstRetry.item.lastError, "temporary");
    });
  });

  it("caps exponential retry delay", () => {
    const retryPolicy = { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 1_500 };
    withStore((store) => {
      store.enqueueReview({ idempotencyKey: "cap-retry", payload: payload(), now });
      const firstLease = store.leaseReview({ workerId: "worker-a", leaseDurationMs: 30_000, now });
      assert.ok(firstLease);
      const firstRetry = store.retryReview({ workId: firstLease.workId, workerId: "worker-a", error: "temporary", now });
      assert.equal(firstRetry.retryAt, new Date(now.getTime() + 1_000).toISOString());
      const secondLease = store.leaseReview({ workerId: "worker-a", leaseDurationMs: 30_000, now: new Date(now.getTime() + 1_000) });
      assert.ok(secondLease);
      const secondRetry = store.retryReview({ workId: secondLease.workId, workerId: "worker-a", error: "temporary again", now: new Date(now.getTime() + 1_000) });

      assert.equal(secondRetry.retryAt, new Date(now.getTime() + 2_500).toISOString());
    }, { retryPolicy });
  });

  it("dead-letters work when the maximum attempts are exhausted", () => {
    const retryPolicy = { maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 10_000 };
    withStore((store) => {
      store.enqueueReview({ idempotencyKey: "dead-letter-me", payload: payload(), now });
      const firstLease = store.leaseReview({ workerId: "worker-a", leaseDurationMs: 30_000, now });
      assert.ok(firstLease);
      const firstRetry = store.retryReview({ workId: firstLease.workId, workerId: "worker-a", error: "first failure", now });
      assert.equal(firstRetry.deadLettered, false);
      const secondLease = store.leaseReview({ workerId: "worker-a", leaseDurationMs: 30_000, now: new Date(now.getTime() + 1_000) });
      assert.ok(secondLease);
      const secondRetry = store.retryReview({ workId: secondLease.workId, workerId: "worker-a", error: "terminal failure", now: new Date(now.getTime() + 1_000) });

      assert.equal(secondRetry.deadLettered, true);
      assert.equal(secondRetry.retryAt, undefined);
      assert.equal(secondRetry.item.state, "dead-letter");
      assert.equal(secondRetry.item.deadLetteredAt, new Date(now.getTime() + 1_000).toISOString());
    }, { retryPolicy });
  });

  it("dead-letters an ambiguous provider operation before retry budget is exhausted", () => {
    withStore((store) => {
      store.enqueueReview({ idempotencyKey: "ambiguous-provider", payload: payload(), now });
      const leased = store.leaseReview({ workerId: "worker-a", leaseDurationMs: 30_000, now });
      assert.ok(leased);
      const terminal = store.retryReview({
        workId: leased.workId,
        workerId: "worker-a",
        error: "provider outcome is unresolved",
        terminal: true,
        now,
      });
      assert.equal(terminal.deadLettered, true);
      assert.equal(terminal.retryAt, undefined);
      assert.equal(terminal.item.state, "dead-letter");
      assert.equal(terminal.item.lastError, "provider outcome is unresolved");
    });
  });

  it("recovers a stale lease into the retry state", () => {
    withStore((store) => {
      store.enqueueReview({ idempotencyKey: "recover-me", payload: payload(), now });
      const leased = store.leaseReview({ workerId: "worker-a", leaseDurationMs: 10, now });
      assert.ok(leased);
      const recovered = store.recoverStaleLeases({ now: new Date(now.getTime() + 11) });

      assert.equal(recovered.length, 1);
      assert.equal(recovered[0]?.state, "retry_wait");
      assert.equal(recovered[0]?.leaseOwner, undefined);
      assert.equal(recovered[0]?.lastError, "lease expired");
      assert.equal(recovered[0]?.availableAt, new Date(now.getTime() + 1_011).toISOString());
    });
  });

  it("dead-letters stale work that has no attempts remaining", () => {
    const retryPolicy = { maxAttempts: 1, baseDelayMs: 1_000, maxDelayMs: 10_000 };
    withStore((store) => {
      store.enqueueReview({ idempotencyKey: "stale-terminal", payload: payload(), now });
      const leased = store.leaseReview({ workerId: "worker-a", leaseDurationMs: 10, now });
      assert.ok(leased);
      const recovered = store.recoverStaleLeases({ now: new Date(now.getTime() + 11) });

      assert.equal(recovered[0]?.state, "dead-letter");
      assert.equal(recovered[0]?.deadLetteredAt, new Date(now.getTime() + 11).toISOString());
    }, { retryPolicy });
  });

  it("leases stale work after recovery makes its retry window available", () => {
    withStore((store) => {
      store.enqueueReview({ idempotencyKey: "auto-recover", payload: payload(), now });
      store.leaseReview({ workerId: "worker-a", leaseDurationMs: 10, now });
      store.recoverStaleLeases({ now: new Date(now.getTime() + 11) });

      const next = store.leaseReview({ workerId: "worker-b", leaseDurationMs: 30_000, now: new Date(now.getTime() + 1_011) });

      assert.ok(next);
      assert.equal(next.leaseOwner, "worker-b");
      assert.equal(next.attempts, 2);
    });
  });

  it("rejects malformed review input at the owner boundary", () => {
    withStore((store) => {
      assert.throws(
        () => store.enqueueReview({ idempotencyKey: "bad", payload: payload({ pullNumber: 0 }), now }),
        (error: unknown) => error instanceof JobDispatchError && error.code === "invalid_input",
      );
      assert.throws(
        () => store.enqueueReview({ idempotencyKey: "", payload: payload(), now }),
        (error: unknown) => error instanceof JobDispatchError && error.code === "invalid_input",
      );
    });
  });

  it("returns undefined for an unknown work id", () => {
    withStore((store) => {
      assert.equal(store.getReview("missing-work"), undefined);
    });
  });

  it("reports completion of unknown work as not found", () => {
    withStore((store) => {
      assert.throws(
        () => store.completeReview({ workId: "missing-work", workerId: "worker-a", now }),
        (error: unknown) => error instanceof JobDispatchError && error.code === "not_found",
      );
    });
  });

  it("reports retry of unknown work as not found", () => {
    withStore((store) => {
      assert.throws(
        () => store.retryReview({ workId: "missing-work", workerId: "worker-a", error: "missing", now }),
        (error: unknown) => error instanceof JobDispatchError && error.code === "not_found",
      );
    });
  });

  it("does not complete work twice", () => {
    withStore((store) => {
      store.enqueueReview({ idempotencyKey: "complete-once", payload: payload(), now });
      const leased = store.leaseReview({ workerId: "worker-a", leaseDurationMs: 30_000, now });
      assert.ok(leased);
      store.completeReview({ workId: leased.workId, workerId: "worker-a", now });

      assert.throws(
        () => store.completeReview({ workId: leased.workId, workerId: "worker-a", now }),
        (error: unknown) => error instanceof JobDispatchError && error.code === "invalid_transition",
      );
    });
  });

  it("does not retry completed work", () => {
    withStore((store) => {
      store.enqueueReview({ idempotencyKey: "retry-completed", payload: payload(), now });
      const leased = store.leaseReview({ workerId: "worker-a", leaseDurationMs: 30_000, now });
      assert.ok(leased);
      store.completeReview({ workId: leased.workId, workerId: "worker-a", now });

      assert.throws(
        () => store.retryReview({ workId: leased.workId, workerId: "worker-a", error: "too late", now }),
        (error: unknown) => error instanceof JobDispatchError && error.code === "invalid_transition",
      );
    });
  });

  it("rejects retry from a different lease owner", () => {
    withStore((store) => {
      store.enqueueReview({ idempotencyKey: "retry-owner", payload: payload(), now });
      const leased = store.leaseReview({ workerId: "worker-a", leaseDurationMs: 30_000, now });
      assert.ok(leased);

      assert.throws(
        () => store.retryReview({ workId: leased.workId, workerId: "worker-b", error: "wrong owner", now }),
        (error: unknown) => error instanceof JobDispatchError && error.code === "lease_conflict",
      );
    });
  });

  it("does not recover a lease before its expiry", () => {
    withStore((store) => {
      store.enqueueReview({ idempotencyKey: "live-lease", payload: payload(), now });
      store.leaseReview({ workerId: "worker-a", leaseDurationMs: 30_000, now });

      assert.deepEqual(store.recoverStaleLeases({ now: new Date(now.getTime() + 29_999) }), []);
    });
  });

  it("keeps different idempotency keys as different work", () => {
    withStore((store) => {
      const first = store.enqueueReview({ idempotencyKey: "first-key", payload: payload(), now });
      const second = store.enqueueReview({ idempotencyKey: "second-key", payload: payload(), now });

      assert.notEqual(first.item.workId, second.item.workId);
      assert.equal(second.created, true);
    });
  });

  it("rejects an unbounded retry policy", () => {
    assert.throws(
      () => new SqliteJobDispatchStore(options({ retryPolicy: { maxAttempts: 2, baseDelayMs: 2_000, maxDelayMs: 1_000 } })),
      (error: unknown) => error instanceof JobDispatchError && error.code === "invalid_input",
    );
  });

  it("rejects a zero-duration lease", () => {
    withStore((store) => {
      store.enqueueReview({ idempotencyKey: "zero-lease", payload: payload(), now });

      assert.throws(
        () => store.leaseReview({ workerId: "worker-a", leaseDurationMs: 0, now }),
        (error: unknown) => error instanceof JobDispatchError && error.code === "invalid_input",
      );
    });
  });

  it("enqueues and retrieves typed index work", () => {
    withStore((store) => {
      const result = store.enqueueIndex({ idempotencyKey: "delivery-1:index", payload: indexPayload(), now });

      assert.equal(result.created, true);
      assert.equal(result.item.kind, "index");
      assert.equal(result.item.state, "queued");
      assert.deepEqual(store.getIndex(result.item.workId), result.item);
    });
  });

  it("deduplicates identical index work", () => {
    withStore((store) => {
      const first = store.enqueueIndex({ idempotencyKey: "same-index", payload: indexPayload(), now });
      const second = store.enqueueIndex({ idempotencyKey: "same-index", payload: indexPayload(), now });

      assert.equal(second.created, false);
      assert.equal(second.item.workId, first.item.workId);
    });
  });

  it("rejects conflicting index work for one idempotency key", () => {
    withStore((store) => {
      store.enqueueIndex({ idempotencyKey: "conflicting-index", payload: indexPayload(), now });
      assert.throws(
        () => store.enqueueIndex({ idempotencyKey: "conflicting-index", payload: indexPayload({ commitSha: "different" }), now }),
        (error: unknown) => error instanceof JobDispatchError && error.code === "idempotency_conflict",
      );
    });
  });

  it("keeps review and index idempotency namespaces independent", () => {
    withStore((store) => {
      const review = store.enqueueReview({ idempotencyKey: "shared-delivery", payload: payload(), now });
      const index = store.enqueueIndex({ idempotencyKey: "shared-delivery", payload: indexPayload(), now });

      assert.equal(review.created, true);
      assert.equal(index.created, true);
      assert.notEqual(review.item.workId, index.item.workId);
    });
  });

  it("leases and completes index work with lease fencing", () => {
    withStore((store) => {
      const queued = store.enqueueIndex({ idempotencyKey: "complete-index", payload: indexPayload(), now });
      const leased = store.leaseIndex({ workerId: "indexer-a", leaseDurationMs: 30_000, now });
      assert.ok(leased);
      assert.equal(leased.attempts, 1);
      assert.throws(
        () => store.completeIndex({ workId: queued.item.workId, workerId: "indexer-b", now }),
        (error: unknown) => error instanceof JobDispatchError && error.code === "lease_conflict",
      );
      assert.equal(store.completeIndex({ workId: queued.item.workId, workerId: "indexer-a", now }).state, "completed");
    });
  });

  it("rejects index completion after lease expiry", () => {
    withStore((store) => {
      const queued = store.enqueueIndex({ idempotencyKey: "expired-index", payload: indexPayload(), now });
      store.leaseIndex({ workerId: "indexer-a", leaseDurationMs: 10, now });
      assert.throws(
        () => store.completeIndex({ workId: queued.item.workId, workerId: "indexer-a", now: new Date(now.getTime() + 11) }),
        (error: unknown) => error instanceof JobDispatchError && error.code === "lease_conflict",
      );
    });
  });

  it("renews an active index lease for its current owner", () => {
    withStore((store) => {
      const queued = store.enqueueIndex({ idempotencyKey: "renew-index", payload: indexPayload(), now });
      store.leaseIndex({ workerId: "indexer-a", leaseDurationMs: 10, now });
      const renewedAt = new Date(now.getTime() + 5);
      const renewed = store.renewIndex({ workId: queued.item.workId, workerId: "indexer-a", leaseDurationMs: 30_000, now: renewedAt });
      assert.equal(renewed.leaseExpiresAt, new Date(renewedAt.getTime() + 30_000).toISOString());
      assert.equal(store.completeIndex({ workId: queued.item.workId, workerId: "indexer-a", now: new Date(now.getTime() + 20) }).state, "completed");
    });
  });

  it("rejects renewal by a different worker or after expiry", () => {
    withStore((store) => {
      const queued = store.enqueueIndex({ idempotencyKey: "reject-renew-index", payload: indexPayload(), now });
      store.leaseIndex({ workerId: "indexer-a", leaseDurationMs: 10, now });
      assert.throws(
        () => store.renewIndex({ workId: queued.item.workId, workerId: "indexer-b", leaseDurationMs: 30_000, now }),
        (error: unknown) => error instanceof JobDispatchError && error.code === "lease_conflict",
      );
      assert.throws(
        () => store.renewIndex({ workId: queued.item.workId, workerId: "indexer-a", leaseDurationMs: 30_000, now: new Date(now.getTime() + 11) }),
        (error: unknown) => error instanceof JobDispatchError && error.code === "lease_conflict",
      );
    });
  });

  it("retries index work with the shared bounded backoff", () => {
    withStore((store) => {
      const queued = store.enqueueIndex({ idempotencyKey: "retry-index", payload: indexPayload(), now });
      store.leaseIndex({ workerId: "indexer-a", leaseDurationMs: 30_000, now });
      const retry = store.retryIndex({ workId: queued.item.workId, workerId: "indexer-a", error: "GitHub unavailable", now });

      assert.equal(retry.deadLettered, false);
      assert.equal(retry.retryAt, new Date(now.getTime() + DEFAULT_RETRY_POLICY.baseDelayMs).toISOString());
      assert.equal(retry.item.lastError, "GitHub unavailable");
    });
  });

  it("dead-letters index work at the shared attempt limit", () => {
    withStore((store) => {
      const queued = store.enqueueIndex({ idempotencyKey: "dead-index", payload: indexPayload(), now });
      store.leaseIndex({ workerId: "indexer-a", leaseDurationMs: 30_000, now });
      const terminal = store.retryIndex({ workId: queued.item.workId, workerId: "indexer-a", error: "terminal", now });

      assert.equal(terminal.deadLettered, true);
      assert.equal(terminal.item.state, "dead-letter");
    }, { retryPolicy: { maxAttempts: 1, baseDelayMs: 1_000, maxDelayMs: 10_000 } });
  });

  it("recovers stale index leases without touching active review work", () => {
    withStore((store) => {
      store.enqueueIndex({ idempotencyKey: "stale-index", payload: indexPayload(), now });
      store.enqueueReview({ idempotencyKey: "active-review", payload: payload(), now });
      store.leaseIndex({ workerId: "indexer-a", leaseDurationMs: 10, now });

      const recovered = store.recoverStaleIndexLeases({ now: new Date(now.getTime() + 11) });
      assert.equal(recovered[0]?.state, "retry_wait");
      assert.equal(recovered[0]?.lastError, "lease expired");
      assert.equal(store.getReview(store.leaseReview({ workerId: "reviewer", leaseDurationMs: 30_000, now })!.workId)?.state, "leased");
    });
  });

  it("persists index work across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "gitgecko-index-dispatch-"));
    const databasePath = join(directory, "jobs.sqlite");
    try {
      const first = new SqliteJobDispatchStore(options({ databasePath }));
      const created = first.enqueueIndex({ idempotencyKey: "persisted-index", payload: indexPayload(), now });
      first.close();
      const second = new SqliteJobDispatchStore(options({ databasePath }));
      try {
        assert.deepEqual(second.getIndex(created.item.workId), created.item);
      } finally {
        second.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists authoritative review tenant identity across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "gitgecko-review-tenant-"));
    const databasePath = join(directory, "jobs.sqlite");
    try {
      const first = new SqliteJobDispatchStore(options({ databasePath }));
      const created = first.enqueueReview({ idempotencyKey: "persisted-review-tenant", payload: payload({ tenantId: "organization-durable" }), now });
      first.close();
      const second = new SqliteJobDispatchStore(options({ databasePath }));
      try {
        assert.equal(second.getReview(created.item.workId)?.payload.tenantId, "organization-durable");
      } finally {
        second.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("finds review work through its canonical idempotency identity", () => {
    withStore((store) => {
      const created = store.enqueueReview({ idempotencyKey: "github:delivery-lookup", payload: payload(), now });
      assert.equal(store.findReviewByIdempotencyKey("github:delivery-lookup")?.workId, created.item.workId);
      assert.equal(store.findReviewByIdempotencyKey("github:missing"), undefined);
      assert.throws(
        () => store.findReviewByIdempotencyKey(""),
        (error: unknown) => error instanceof JobDispatchError && error.code === "invalid_input",
      );
    });
  });

  it("treats tenant identity as part of review idempotency", () => {
    withStore((store) => {
      store.enqueueReview({ idempotencyKey: "tenant-scoped-review", payload: payload({ tenantId: "organization-a" }), now });
      assert.throws(
        () => store.enqueueReview({ idempotencyKey: "tenant-scoped-review", payload: payload({ tenantId: "organization-b" }), now }),
        (error: unknown) => error instanceof JobDispatchError && error.code === "idempotency_conflict",
      );
    });
  });

  it("rejects blank, control-character, and oversized review tenant identities", () => {
    withStore((store) => {
      for (const tenantId of ["", "organization\nother", "x".repeat(201)]) {
        assert.throws(
          () => store.enqueueReview({ idempotencyKey: `invalid-tenant-${tenantId.length}`, payload: payload({ tenantId }), now }),
          (error: unknown) => error instanceof JobDispatchError && error.code === "invalid_input",
        );
      }
    });
  });

  it("dead-letters legacy queued review work without inventing tenant authority", () => {
    const directory = mkdtempSync(join(tmpdir(), "gitgecko-review-tenant-migration-"));
    const databasePath = join(directory, "jobs.sqlite");
    try {
      const initialized = new SqliteJobDispatchStore(options({ databasePath }));
      initialized.close();
      const database = new Database(databasePath);
      database.prepare("DELETE FROM gitgecko_schema_migrations WHERE owner = ? AND version = ?").run("job-dispatch", 2);
      database.prepare(`INSERT INTO review_work_items (
        work_id, idempotency_key, payload, state, attempts, max_attempts,
        available_at, created_at, updated_at, lease_owner, lease_expires_at,
        completed_at, dead_lettered_at, last_error
      ) VALUES (?, ?, ?, 'queued', 0, 5, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`).run(
        "legacy-review-work",
        "legacy-review-key",
        JSON.stringify({ ...payload(), tenantId: undefined }),
        now.toISOString(),
        now.toISOString(),
        now.toISOString(),
      );
      database.close();

      const migrated = new SqliteJobDispatchStore(options({ databasePath }));
      try {
        const item = migrated.getReview("legacy-review-work");
        assert.equal(item?.state, "dead-letter");
        assert.equal(item?.payload.tenantId, "legacy:unresolved");
        assert.match(item?.lastError ?? "", /no authoritative tenant/u);
        assert.equal(migrated.leaseReview({ workerId: "worker", leaseDurationMs: 30_000, now }), undefined);
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed index payload and lease input", () => {
    withStore((store) => {
      assert.throws(
        () => store.enqueueIndex({ idempotencyKey: "bad-index", payload: indexPayload({ ref: "" }), now }),
        (error: unknown) => error instanceof JobDispatchError && error.code === "invalid_input",
      );
      assert.throws(
        () => store.leaseIndex({ workerId: "", leaseDurationMs: 1_000, now }),
        (error: unknown) => error instanceof JobDispatchError && error.code === "invalid_input",
      );
    });
  });

  it("treats tenant identity as part of index idempotency", () => {
    withStore((store) => {
      store.enqueueIndex({ idempotencyKey: "tenant-scoped-index", payload: indexPayload({ tenantId: "organization-a" }), now });
      assert.throws(
        () => store.enqueueIndex({ idempotencyKey: "tenant-scoped-index", payload: indexPayload({ tenantId: "organization-b" }), now }),
        (error: unknown) => error instanceof JobDispatchError && error.code === "idempotency_conflict",
      );
    });
  });

  it("rejects blank, control-character, and oversized index tenant identities", () => {
    withStore((store) => {
      for (const tenantId of ["", "organization\nother", "x".repeat(201)]) {
        assert.throws(
          () => store.enqueueIndex({ idempotencyKey: `invalid-index-tenant-${tenantId.length}`, payload: indexPayload({ tenantId }), now }),
          (error: unknown) => error instanceof JobDispatchError && error.code === "invalid_input",
        );
      }
    });
  });

  it("dead-letters legacy queued index work without inventing tenant authority", () => {
    const directory = mkdtempSync(join(tmpdir(), "gitgecko-index-tenant-migration-"));
    const databasePath = join(directory, "jobs.sqlite");
    try {
      const initialized = new SqliteJobDispatchStore(options({ databasePath }));
      initialized.close();
      const database = new Database(databasePath);
      database.prepare("DELETE FROM gitgecko_schema_migrations WHERE owner = ? AND version = ?").run("job-dispatch", 3);
      database.prepare(`INSERT INTO index_work_items (
        work_id, idempotency_key, payload, state, attempts, max_attempts,
        available_at, created_at, updated_at, lease_owner, lease_expires_at,
        completed_at, dead_lettered_at, last_error
      ) VALUES (?, ?, ?, 'queued', 0, 5, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`).run(
        "legacy-index-work",
        "legacy-index-key",
        JSON.stringify({ ...indexPayload(), tenantId: undefined }),
        now.toISOString(),
        now.toISOString(),
        now.toISOString(),
      );
      database.close();

      const migrated = new SqliteJobDispatchStore(options({ databasePath }));
      try {
        const item = migrated.getIndex("legacy-index-work");
        assert.equal(item?.state, "dead-letter");
        assert.equal(item?.payload.tenantId, "legacy:unresolved");
        assert.match(item?.lastError ?? "", /no authoritative tenant/u);
        assert.equal(migrated.leaseIndex({ workerId: "worker", leaseDurationMs: 30_000, now }), undefined);
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("redrives dead-letter review work without changing durable identity", () => {
    withStore((store) => {
      const created = store.enqueueReview({ idempotencyKey: "review-redrive", payload: payload(), now });
      const leased = store.leaseReview({ workerId: "worker-a", leaseDurationMs: 30_000, now });
      assert.ok(leased);
      store.retryReview({ workId: leased.workId, workerId: "worker-a", error: "terminal", terminal: true, now });

      const redriven = store.redriveReview({ workId: created.item.workId, now: new Date(now.getTime() + 1_000) });
      assert.equal(redriven.workId, created.item.workId);
      assert.equal(redriven.idempotencyKey, created.item.idempotencyKey);
      assert.equal(redriven.state, "queued");
      assert.equal(redriven.attempts, 0);
      assert.equal(redriven.deadLetteredAt, undefined);
      assert.equal(redriven.lastError, undefined);
      assert.equal(store.leaseReview({ workerId: "worker-b", leaseDurationMs: 30_000, now: new Date(now.getTime() + 1_000) })?.workId, created.item.workId);
    });
  });

  it("redrives dead-letter index work and rejects non-terminal transitions", () => {
    withStore((store) => {
      const created = store.enqueueIndex({ idempotencyKey: "index-redrive", payload: indexPayload(), now });
      assert.throws(() => store.redriveIndex({ workId: created.item.workId, now }), (error: unknown) => error instanceof JobDispatchError && error.code === "invalid_transition");
      const leased = store.leaseIndex({ workerId: "worker-a", leaseDurationMs: 30_000, now });
      assert.ok(leased);
      store.retryIndex({ workId: leased.workId, workerId: "worker-a", error: "terminal", terminal: true, now });
      const redriven = store.redriveIndex({ workId: leased.workId, now: new Date(now.getTime() + 1_000) });
      assert.equal(redriven.state, "queued");
      assert.equal(redriven.attempts, 0);
      assert.equal(redriven.workId, leased.workId);
      assert.throws(() => store.redriveReview({ workId: "missing", now }), (error: unknown) => error instanceof JobDispatchError && error.code === "not_found");
    });
  });
});
