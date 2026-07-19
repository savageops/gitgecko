import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requireReviewInput, reviewExitCode } from "./review-input.js";

describe("requireReviewInput", () => {
  it("preserves a supplied review diff", () => {
    assert.equal(requireReviewInput("review", "@@\n+change"), "@@\n+change");
  });

  it("rejects an empty review instead of invoking an agent", () => {
    assert.throws(
      () => requireReviewInput("review", "  \n"),
      /No tracked changes found\. Pass --file for new files, or provide --diff or --diff-file\./u,
    );
  });

  it("does not gate non-review commands", () => {
    assert.equal(requireReviewInput("doctor", undefined), undefined);
  });

  it("returns a blocking exit code for a completed non-mergeable review", () => {
    assert.equal(reviewExitCode("review", true, false), 1);
    assert.equal(reviewExitCode("review", true, true), 0);
    assert.equal(reviewExitCode("describe", true, false), 0);
  });
});
