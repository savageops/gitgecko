import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RETRY_POLICY,
  JobDispatchError,
  jobDispatchOwner,
} from "./index.js";

describe("job-dispatch owner", () => {
  it("declares review and index capabilities through one contribution kind", () => {
    assert.deepEqual(jobDispatchOwner.capabilities, ["review", "index"]);
    assert.equal(jobDispatchOwner.kindFor("review"), "review-work");
    assert.equal(jobDispatchOwner.kindFor("index"), "review-work");
  });

  it("keeps the retry policy bounded", () => {
    assert.equal(DEFAULT_RETRY_POLICY.maxAttempts, 5);
    assert.equal(DEFAULT_RETRY_POLICY.baseDelayMs, 1_000);
    assert.equal(DEFAULT_RETRY_POLICY.maxDelayMs, 60_000);
    assert.ok(DEFAULT_RETRY_POLICY.baseDelayMs < DEFAULT_RETRY_POLICY.maxDelayMs);
  });

  it("exposes typed domain errors", () => {
    const error = new JobDispatchError("invalid_input", "bad review input");

    assert.equal(error.name, "JobDispatchError");
    assert.equal(error.code, "invalid_input");
    assert.equal(error.message, "bad review input");
  });
});
