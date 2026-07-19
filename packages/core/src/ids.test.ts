/**
 * Tests for @gitgecko/core/ids — branded identifier types + owner name validation.
 *
 * Challenges the CAPABILITY: brandId produces branded values, OWNER_NAMES is the
 * complete set, isOwnerName validates correctly. Per project TDD rule.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  brandId,
  OWNER_NAMES,
  isOwnerName,
  type OrgId,
  type RepoId,
  type RunId,
  type OwnerName,
} from "./ids.js";

describe("brandId — branded ID constructor", () => {
  it("produces a value that satisfies the branded type", () => {
    const id: RunId = brandId<"RunId">("run_abc123");
    assert.equal(id, "run_abc123");
    assert.equal(typeof id, "string");
  });

  it("preserves the underlying string value", () => {
    const id = brandId<OrgId>("org_xyz");
    assert.equal(id, "org_xyz");
  });

  it("accepts any string (no format validation at the type level)", () => {
    const id = brandId<"RepoId">("");
    assert.equal(id, "");
  });

  it("different branded types are assignable only via brandId", () => {
    const runId = brandId<"RunId">("run_1");
    const repoId = brandId<"RepoId">("repo_1");
    // At runtime these are both strings; the brand prevents cross-assignment
    // at compile time. We verify runtime equality is string-based.
    assert.equal(typeof runId, "string");
    assert.equal(typeof repoId, "string");
    assert.notEqual(runId, repoId);
  });
});

describe("OWNER_NAMES — the complete owner catalog", () => {
  it("contains all 12 owners from 02-architecture-overview §2", () => {
    assert.equal(OWNER_NAMES.length, 12);
  });

  it("includes the seven socket owners (the plug/socket architecture)", () => {
    const expected = ["billing", "code-intel", "model", "review", "rules", "sandbox", "mcp-gateway"];
    for (const owner of expected) {
      assert.ok(
        (OWNER_NAMES as readonly string[]).includes(owner),
        `owner "${owner}" must be in OWNER_NAMES`,
      );
    }
  });

  it("includes the support owners (ingest, repo-import, auth, notify, trace)", () => {
    const expected = ["ingest", "repo-import", "auth", "notify", "trace"];
    for (const owner of expected) {
      assert.ok(
        (OWNER_NAMES as readonly string[]).includes(owner),
        `owner "${owner}" must be in OWNER_NAMES`,
      );
    }
  });

  it("has no duplicates", () => {
    const seen = new Set<string>();
    for (const name of OWNER_NAMES) {
      assert.ok(!seen.has(name), `duplicate owner name: ${name}`);
      seen.add(name);
    }
  });

  it("is sorted in declaration order (not alphabetical — matches the design doc)", () => {
    // The design doc (02 §2) lists owners in architectural order, not alpha.
    // This test pins the order so a re-sort doesn't silently change it.
    assert.equal(OWNER_NAMES[0], "ingest");
    assert.equal(OWNER_NAMES[1], "repo-import");
    assert.equal(OWNER_NAMES[2], "code-intel");
    assert.equal(OWNER_NAMES[3], "review");
  });
});

describe("isOwnerName — runtime owner validation", () => {
  it("returns true for every name in OWNER_NAMES", () => {
    for (const name of OWNER_NAMES) {
      assert.ok(isOwnerName(name), `"${name}" should be a valid OwnerName`);
    }
  });

  it("returns false for unknown strings", () => {
    assert.equal(isOwnerName("unknown"), false);
    assert.equal(isOwnerName(""), false);
    assert.equal(isOwnerName("CodeRabbit"), false);
    assert.equal(isOwnerName("billing "), false); // trailing space
  });

  it("returns false for non-string types (type guard correctness)", () => {
    assert.equal(isOwnerName(42 as unknown as string), false);
    assert.equal(isOwnerName(null as unknown as string), false);
    assert.equal(isOwnerName(undefined as unknown as string), false);
    assert.equal(isOwnerName({} as unknown as string), false);
  });

  it("narrowing works: after isOwnerName(s), s is OwnerName", () => {
    const input: string = "billing";
    if (isOwnerName(input)) {
      // TypeScript narrows input to OwnerName here.
      const _assigned: OwnerName = input;
      assert.equal(_assigned, "billing");
    } else {
      assert.fail("billing should be a valid OwnerName");
    }
  });
});
