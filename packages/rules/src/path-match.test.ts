import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ruleAppliesToPath } from "./path-match.js";

describe("ruleAppliesToPath", () => {
  it("treats globstar directories as optional for root files", () => {
    assert.equal(ruleAppliesToPath({ files: ["**/*.ts"] }, "app.ts"), true);
    assert.equal(ruleAppliesToPath({ files: ["**/*.ts"] }, "src/app.ts"), true);
  });

  it("normalizes Windows separators before matching", () => {
    assert.equal(ruleAppliesToPath({ files: ["src/**/*.ts"] }, "src\\nested\\app.ts"), true);
  });

  it("applies ignores at root and nested depths", () => {
    const rule = { files: ["**/*.ts"], ignores: ["**/*.test.ts"] };
    assert.equal(ruleAppliesToPath(rule, "app.test.ts"), false);
    assert.equal(ruleAppliesToPath(rule, "src/app.test.ts"), false);
    assert.equal(ruleAppliesToPath(rule, "src/app.ts"), true);
  });

  it("matches every path when includes are absent", () => {
    assert.equal(ruleAppliesToPath({}, ".github/workflows/ci.yml"), true);
  });
});
