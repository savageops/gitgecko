import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatActionRequirements, parseActionReviewEnvelope, parseActionReviewResponse } from "./parse-action-review-response.mjs";

describe("GitHub Action cloud response", () => {
  it("extracts only the successful review output", () => {
    assert.equal(parseActionReviewResponse(JSON.stringify({ success: true, output: "## Finding" })), "## Finding");
  });

  it("rejects semantic, empty, and malformed responses", () => {
    assert.throws(() => parseActionReviewResponse(JSON.stringify({ success: false, error: "quota exhausted" })), /quota exhausted/);
    assert.throws(() => parseActionReviewResponse(JSON.stringify({ success: true, output: "" })), /without review output/);
    assert.throws(() => parseActionReviewResponse("not-json"), /invalid review response/);
  });

  it("renders validated structured requirements instead of reparsing provider prose", () => {
    const output = parseActionReviewResponse(JSON.stringify({
      success: true,
      output: "## Review",
      artifact: {
        mergeable: false,
        linkedRequirements: [{
          number: 42,
          title: "Protect login",
          url: "https://github.com/acme/repo/issues/42",
          status: "unmet",
          evidence: "No expiry check appears in the diff.",
        }],
      },
    }));
    assert.match(output, /## Linked requirements/);
    assert.match(output, /\[#42 Protect login\]\(https:\/\/github\.com\/acme\/repo\/issues\/42\)/);
    assert.match(output, /\*\*unmet\*\*: No expiry check appears/);
  });

  it("uses canonical mergeability as the Action gate", () => {
    assert.equal(parseActionReviewEnvelope(JSON.stringify({ success: true, output: "Review", artifact: { mergeable: false } })).mergeable, false);
    assert.equal(parseActionReviewEnvelope(JSON.stringify({ success: true, output: "Review", artifact: { mergeable: true } })).mergeable, true);
    assert.equal(parseActionReviewEnvelope(JSON.stringify({ success: true, output: "Legacy review" })).mergeable, true);
  });

  it("drops malformed requirement records and unsafe links", () => {
    const formatted = formatActionRequirements({ linkedRequirements: [
      { number: 42, title: "Safe", url: "javascript:alert(1)", status: "satisfied", evidence: "ok" },
      { number: "43", title: "Bad", status: "unmet", evidence: "bad" },
      { number: 44, title: "Bad status", status: "unknown", evidence: "bad" },
    ] });
    assert.match(formatted, /#42 Safe/);
    assert.doesNotMatch(formatted, /javascript:/);
    assert.doesNotMatch(formatted, /#43|#44/);
  });
});
