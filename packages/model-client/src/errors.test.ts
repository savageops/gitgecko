/**
 * TDD tests for the error classification + retry module.
 *
 * Challenges the CAPABILITY: classifyError must categorize errors correctly
 * (transient/billing/timeout/permanent) so withRetry retries the right set.
 * Per project rule: tests challenge the code, never weaken to pass.
 *
 * The 5xx/429 substring matching is the riskiest surface — these tests pin
 * the exact boundary (a model id containing "503" must NOT classify transient).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyError, isTransient, withRetry, type ErrorCategory } from "./errors.js";

describe("classifyError — category boundary", () => {
  // --- transient (should retry) ---
  const transientCases: ReadonlyArray<[string, string]> = [
    ["429 rate limit", "Too Many Requests: 429"],
    ["rate limit phrase", "rate limit exceeded"],
    ["overloaded", "The server is overloaded"],
    ["ECONNRESET", "request failed: ECONNRESET"],
    ["ETIMEDOUT", "ETIMEDOUT"],
    ["fetch failed", "fetch failed"],
    ["socket hang up", "socket hang up"],
    ["503 exact", "503 Service Unavailable"],
    ["502 bad gateway", "502 Bad Gateway"],
    ["internal server error phrase", "internal server error"],
    ["service unavailable phrase", "service unavailable"],
  ];
  for (const [label, msg] of transientCases) {
    it(`classifies "${label}" as transient`, () => {
      assert.equal(classifyError(new Error(msg)), "transient" as ErrorCategory);
    });
  }

  // --- timeout (should retry — isTransient returns true for timeout) ---
  it("classifies AbortError name as timeout", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    assert.equal(classifyError(e), "timeout");
  });
  it("classifies 'timed out' message as timeout", () => {
    assert.equal(classifyError(new Error("request timed out after 30000ms")), "timeout");
  });

  // --- billing (must NOT retry — isTransient false) ---
  const billingCases: ReadonlyArray<[string, string]> = [
    ["402 payment required", "402 Payment Required"],
    ["insufficient_quota", "insufficient_quota for this project"],
    ["billing", "billing hard limit reached"],
  ];
  for (const [label, msg] of billingCases) {
    it(`classifies "${label}" as billing (not transient)`, () => {
      assert.equal(classifyError(new Error(msg)), "billing");
    });
  }

  // --- permanent (must NOT retry — fail fast) ---
  const permanentCases: ReadonlyArray<[string, string]> = [
    ["401 unauthorized", "401 Unauthorized: invalid api key"],
    ["400 bad request", "400 Bad Request: malformed prompt"],
    ["model not found", "model not found: gpt-99"],
    ["empty/falsy", ""],
  ];
  for (const [label, msg] of permanentCases) {
    it(`classifies "${label}" as permanent`, () => {
      assert.equal(classifyError(new Error(msg)), "permanent");
    });
  }

  // --- THE CRITICAL BOUNDARY: false-positive substring traps ---
  // These MUST be permanent, NOT transient, even though they contain digit
  // sequences that look like status codes. This pins the regex tightening.
  it("does NOT misclassify a model id containing '503' as transient", () => {
    // A permanent error (model not found) whose message happens to contain "503"
    assert.equal(
      classifyError(new Error("model not found: claude-3-503-sonnet")),
      "permanent",
      "model id containing 503 must not trigger 5xx transient classification",
    );
  });

  it("does NOT misclassify '429' in an unrelated context as transient", () => {
    // "expected 429 tokens" is a permanent bad-request, not a rate limit
    assert.equal(
      classifyError(new Error("400 Bad Request: expected 429 tokens, got 500")),
      "permanent",
      "'429' appearing as a token count must not trigger rate-limit transient",
    );
  });

  it("does NOT misclassify a port number like '5000' as a 5xx", () => {
    assert.equal(
      classifyError(new Error("connection refused on port 5000")),
      "permanent",
      "port 5000 must not match the 5xx regex",
    );
  });
});

describe("isTransient — retry decision", () => {
  it("returns true for transient and timeout categories", () => {
    assert.equal(isTransient(new Error("429 rate limit")), true);
    assert.equal(isTransient(new Error("ETIMEDOUT")), true);
    assert.equal(isTransient(new Error("request timed out")), true);
  });

  it("returns false for billing and permanent categories", () => {
    assert.equal(isTransient(new Error("402 Payment Required")), false);
    assert.equal(isTransient(new Error("401 Unauthorized")), false);
    assert.equal(isTransient(new Error("model not found")), false);
  });
});

describe("withRetry — retry behavior (capability pinning)", () => {
  it("retries a transient failure then succeeds", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 2) throw new Error("503 Service Unavailable");
      return "ok";
    }, { baseDelayMs: 1 });
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  });

  it("does NOT retry when shouldRetry returns false (proves the predicate is consulted)", async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry(async () => {
        calls++;
        throw new Error("503");
      }, { baseDelayMs: 1, shouldRetry: () => false }),
      /503/,
    );
    assert.equal(calls, 1, "shouldRetry: false must prevent ALL retries");
  });

  it("fails fast on a permanent error (isTransient returns false)", async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry(async () => {
        calls++;
        throw new Error("401 Unauthorized");
      }, { baseDelayMs: 1 }),
      /401/,
    );
    assert.equal(calls, 1, "permanent error must not retry");
  });

  it("exhausts maxAttempts on persistent transient errors", async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry(async () => {
        calls++;
        throw new Error("429 rate limit");
      }, { maxAttempts: 3, baseDelayMs: 1 }),
      /429/,
    );
    assert.equal(calls, 3);
  });

  it("invokes onRetry before each retry with the error + attempt number", async () => {
    const retries: Array<{ attempt: number; msg: string }> = [];
    await assert.rejects(
      () => withRetry(async () => {
        throw new Error("503");
      }, {
        maxAttempts: 3,
        baseDelayMs: 1,
        onRetry: (e, attempt) => retries.push({ attempt, msg: (e as Error).message }),
      }),
      /503/,
    );
    // 3 attempts → 2 retries (after attempt 1 and 2)
    assert.equal(retries.length, 2);
    const first = retries[0];
    const second = retries[1];
    assert.ok(first, "first retry callback must fire");
    assert.ok(second, "second retry callback must fire");
    assert.equal(first.attempt, 1);
    assert.equal(second.attempt, 2);
    assert.equal(first.msg, "503");
  });

  it("returns the value on first success (no retry, no delay)", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return "first-try";
    }, { baseDelayMs: 1 });
    assert.equal(result, "first-try");
    assert.equal(calls, 1);
  });
});
