import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isIgnoredPackageDirectory,
  findConditionIncompleteExports,
  isNonHermeticTypeScriptBuild,
  isTestArtifactPath,
} from "./validate-build-artifacts.mjs";

describe("conditional package exports", () => {
  it("rejects an import-only runtime condition", () => {
    assert.deepEqual(findConditionIncompleteExports({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    }), ["."]);
  });

  it("accepts a condition-complete ESM target", () => {
    assert.deepEqual(findConditionIncompleteExports({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js", default: "./dist/index.js" },
    }), []);
  });

  it("accepts string and wildcard targets", () => {
    assert.deepEqual(findConditionIncompleteExports({
      ".": "./dist/index.js",
      "./components/*": "./src/components/*.tsx",
    }), []);
  });
});

describe("production test-artifact classification", () => {
  for (const path of [
    "dist/socket.test.js",
    "dist/socket.spec.js",
    "dist/nested/owner.test.d.ts",
    "dist/nested/owner.spec.js.map",
    "dist/__tests__/owner.js",
    "dist\\__tests__\\owner.js",
  ]) {
    it(`rejects ${path}`, () => {
      assert.equal(isTestArtifactPath(path), true);
    });
  }

  for (const path of [
    "dist/contest.js",
    "dist/test-utils.js",
    "dist/specification.js",
    "dist/owner.js",
    "dist/assets/test-pattern.svg",
    "dist/nested/owner.d.ts",
  ]) {
    it(`accepts ${path}`, () => {
      assert.equal(isTestArtifactPath(path), false);
    });
  }
});

describe("TypeScript build ownership", () => {
  it("rejects direct TypeScript emit into an uncleared owner", () => {
    assert.equal(isNonHermeticTypeScriptBuild("tsc -p tsconfig.json"), true);
  });

  it("rejects TypeScript emit followed by asset copying", () => {
    assert.equal(isNonHermeticTypeScriptBuild("tsc -p tsconfig.json && node copy.mjs"), true);
  });

  it("accepts clean-before-emit TypeScript builds", () => {
    assert.equal(isNonHermeticTypeScriptBuild("rimraf dist && tsc -p tsconfig.build.json"), false);
  });

  it("accepts no-emit aggregate checks", () => {
    assert.equal(isNonHermeticTypeScriptBuild("tsc -p tsconfig.json --noEmit"), false);
  });

  it("does not infer behavior for self-cleaning bundlers", () => {
    assert.equal(isNonHermeticTypeScriptBuild("tsup"), false);
    assert.equal(isNonHermeticTypeScriptBuild("vite build"), false);
  });
});

describe("package-root discovery", () => {
  for (const name of ["node_modules", ".next", ".next-dev", ".next-readiness", ".output", "coverage"]) {
    it(`ignores generated directory ${name}`, () => {
      assert.equal(isIgnoredPackageDirectory(name), true);
    });
  }

  for (const name of ["apps", "packages", "www", "distillery"]) {
    it(`retains source directory ${name}`, () => {
      assert.equal(isIgnoredPackageDirectory(name), false);
    });
  }
});
