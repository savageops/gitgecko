/**
 * Tests for @gitgecko/core/result — the typed Result<T, E> discriminated union.
 *
 * Challenges the CAPABILITY: every function (ok, err, gitGeckoError, tryAsync) through
 * its intended entrypoint. Per project TDD rule: tests challenge capability, never
 * degraded to pass.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ok,
  err,
  gitGeckoError,
  tryAsync,
  type Result,
  type GitGeckoError,
} from "./result.js";

describe("ok — success constructor", () => {
  it("produces a Result with ok: true and the value", () => {
    const r = ok(42);
    assert.equal(r.ok, true);
    assert.equal(r.value, 42);
  });

  it("preserves object identity (no cloning)", () => {
    const obj = { a: 1, b: [2, 3] };
    const r = ok(obj);
    if (r.ok) assert.equal(r.value, obj);
  });

  it("accepts null and undefined as values", () => {
    const r1 = ok(null);
    if (r1.ok) assert.equal(r1.value, null);
    const r2 = ok(undefined);
    if (r2.ok) assert.equal(r2.value, undefined);
  });

  it("narrows to Result<T, never> (no error field accessible)", () => {
    const r = ok("hello");
    // After ok: true narrowing, the error field is never. We verify the ok
    // branch carries value and the discriminated union narrows correctly.
    if (r.ok) {
      assert.equal(r.value, "hello");
      // The ok branch type is { ok: true; value: string } — accessing .error
      // is a type error. We verify the runtime shape matches (no error key).
      assert.ok(!("error" in r), "ok branch should not carry an error key");
    }
  });
});

describe("err — error constructor", () => {
  it("produces a Result with ok: false and the error", () => {
    const e: GitGeckoError = { code: "test.fail", message: "it failed" };
    const r = err(e);
    assert.equal(r.ok, false);
    assert.equal(r.error, e);
  });

  it("accepts a custom error type", () => {
    const r = err({ kind: "custom", detail: "x" } as unknown);
    assert.equal(r.ok, false);
    assert.deepEqual(r.error, { kind: "custom", detail: "x" });
  });
});

describe("gitGeckoError — canonical error envelope", () => {
  it("constructs a minimal error with code and message", () => {
    const e = gitGeckoError("billing.quota-exceeded", "You have used all your reviews");
    assert.equal(e.code, "billing.quota-exceeded");
    assert.equal(e.message, "You have used all your reviews");
    assert.equal(e.cause, undefined);
    assert.equal(e.retryable, undefined);
  });

  it("includes cause when provided", () => {
    const cause = new Error("underlying");
    const e = gitGeckoError("fetch.fail", "upstream down", { cause });
    assert.equal(e.cause, cause);
  });

  it("includes retryable when provided", () => {
    const e = gitGeckoError("fetch.timeout", "timed out", { retryable: true });
    assert.equal(e.retryable, true);
  });

  it("omits cause and retryable when not provided (not undefined)", () => {
    const e = gitGeckoError("simple", "msg");
    assert.ok(!("cause" in e), "cause should be absent, not undefined");
    assert.ok(!("retryable" in e), "retryable should be absent, not undefined");
  });

  it("includes both cause and retryable when both provided", () => {
    const e = gitGeckoError("x", "y", { cause: "z", retryable: false });
    assert.equal(e.cause, "z");
    assert.equal(e.retryable, false);
  });
});

describe("tryAsync — wrap throwing fn in a Result", () => {
  it("returns ok(value) when the fn resolves", async () => {
    const r = await tryAsync(
      async () => 42,
      () => gitGeckoError("never", "should not fire"),
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, 42);
  });

  it("returns err(onThrow(error)) when the fn rejects", async () => {
    const r = await tryAsync(
      async () => { throw new Error("boom"); },
      (e) => gitGeckoError("wrapped", (e as Error).message),
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "wrapped");
      assert.equal(r.error.message, "boom");
    }
  });

  it("passes the thrown value to onThrow (not just Error instances)", async () => {
    const r = await tryAsync(
      async () => { throw "string error"; },
      (e) => gitGeckoError("cast", String(e)),
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.message, "string error");
  });

  it("preserves the cause in the error when onThrow sets it", async () => {
    const original = new Error("dns failure");
    const r = await tryAsync(
      async () => { throw original; },
      (e) => gitGeckoError("net.fail", "network error", { cause: e }),
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.cause, original);
  });
});

describe("Result discriminated union — narrowing works correctly", () => {
  it("a function returning Result can be narrowed with if (r.ok)", async () => {
    const fn = (shouldFail: boolean): Result<string> =>
      shouldFail
        ? err(gitGeckoError("test", "fail"))
        : ok("success");

    const success = fn(false);
    if (success.ok) {
      assert.equal(success.value, "success");
    } else {
      assert.fail("should be ok");
    }

    const failure = fn(true);
    if (!failure.ok) {
      assert.equal(failure.error.code, "test");
    } else {
      assert.fail("should be err");
    }
  });
});
