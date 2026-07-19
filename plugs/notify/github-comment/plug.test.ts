import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NotifyContribution } from "@gitgecko/notify";
import { createGitHubCommentPlug } from "./plug.js";

const loadContribution = (source: {
  readonly postPullRequestComment: (input: { installationId: string; repositoryId: string; pullNumber: number; body: string; idempotencyKey?: string }) => Promise<{ id: string; url: string }>;
  readonly postPullRequestReview?: (input: { installationId: string; repositoryId: string; pullNumber: number; body: string; idempotencyKey?: string; comments: readonly { file: string; line: number; body: string }[] }) => Promise<{ id: string; url: string }>;
  readonly resolveSupersededPullRequestReviewThreads?: (input: { installationId: string; repositoryId: string; pullNumber: number; activeFindingFingerprints: readonly string[] }) => Promise<{ resolved: number }>;
}) => {
  let contribution: NotifyContribution | undefined;
  createGitHubCommentPlug(
    { appId: "test", privateKey: "test" },
    source,
  ).setup({ register: (_capability, value) => { contribution = value; } });
  assert.ok(contribution);
  return contribution;
};

describe("GitHub comment notifier", () => {
  it("posts through the installation-scoped source authority", async () => {
    let received: unknown;
    const notifier = loadContribution({ postPullRequestComment: async (input) => {
      received = input;
      return { id: "42", url: "https://github.com/acme/repo/issues/7#issuecomment-42" };
    } });
    const result = await notifier.post(
      { kind: "github-pr", connectionId: "11", repositoryId: "22", prNumber: 7 },
      { body: "review body" },
    );
    assert.deepEqual(received, { installationId: "11", repositoryId: "22", pullNumber: 7, body: "review body" });
    assert.equal(result.posted, true);
    assert.equal(result.id, "42");
  });

  it("rejects incomplete targets before provider access", async () => {
    let called = false;
    const notifier = loadContribution({ postPullRequestComment: async () => { called = true; return { id: "1", url: "https://example.test" }; } });
    const result = await notifier.post({ kind: "github-pr", prNumber: 7 }, { body: "review body" });
    assert.equal(result.posted, false);
    assert.equal(called, false);
  });

  it("sanitizes provider failures", async () => {
    const notifier = loadContribution({ postPullRequestComment: async () => { throw new Error("credential secret leaked"); } });
    const result = await notifier.post(
      { kind: "github-pr", connectionId: "11", repositoryId: "22", prNumber: 7 },
      { body: "review body" },
    );
    assert.deepEqual(result, { posted: false, error: "GitHub pull-request comment could not be posted." });
  });

  it("publishes changed-file findings through one GitHub review", async () => {
    let received: unknown;
    const notifier = loadContribution({
      postPullRequestComment: async () => { throw new Error("summary fallback should not run"); },
      postPullRequestReview: async (input) => {
        received = input;
        return { id: "99", url: "https://github.com/acme/repo/pull/7#pullrequestreview-99" };
      },
    });
    const result = await notifier.post(
      { kind: "github-pr", connectionId: "11", repositoryId: "22", prNumber: 7 },
      {
        idempotencyKey: "review-comment:run-7",
        body: "<!-- gitgecko-review -->\n## GitGecko review",
        findings: [
          { ruleId: "no-console", file: "src/app.ts", line: 9, message: "Remove debug logging", fingerprint: "finding_a" },
          { ruleId: "model-review", line: 3, message: "Missing file" },
        ],
      },
    );
    assert.deepEqual(received, {
      installationId: "11",
      repositoryId: "22",
      pullNumber: 7,
      idempotencyKey: "review-comment:run-7",
      body: "<!-- gitgecko-review -->\n## GitGecko review",
      comments: [{ file: "src/app.ts", line: 9, body: "<!-- gitgecko-finding:finding_a -->\n**[no-console]** Remove debug logging" }],
    });
    assert.deepEqual(result, { posted: true, id: "99", url: "https://github.com/acme/repo/pull/7#pullrequestreview-99" });
  });

  it("falls back to the summary when the source does not implement inline reviews", async () => {
    let summaryPosts = 0;
    const notifier = loadContribution({ postPullRequestComment: async () => { summaryPosts += 1; return { id: "1", url: "https://example.test" }; } });
    const result = await notifier.post(
      { kind: "github-pr", connectionId: "11", repositoryId: "22", prNumber: 7 },
      { body: "summary", findings: [{ ruleId: "r", file: "a.ts", line: 1, message: "finding" }] },
    );
    assert.equal(result.posted, true);
    assert.equal(summaryPosts, 1);
  });

  it("reconciles only superseded GitHub finding markers after publishing the replacement review", async () => {
    const calls: string[] = [];
    let received: unknown;
    const notifier = loadContribution({
      postPullRequestComment: async () => { throw new Error("summary fallback should not run"); },
      postPullRequestReview: async () => { calls.push("post"); return { id: "99", url: "https://example.test/review/99" }; },
      resolveSupersededPullRequestReviewThreads: async (input) => { calls.push("resolve"); received = input; return { resolved: 1 }; },
    });
    const result = await notifier.post(
      { kind: "github-pr", connectionId: "11", repositoryId: "22", prNumber: 7 },
      { body: "summary", findings: [{ ruleId: "r", file: "a.ts", line: 1, message: "finding", fingerprint: "active-finding" }] },
    );
    assert.deepEqual(calls, ["post", "resolve"]);
    assert.deepEqual(received, { installationId: "11", repositoryId: "22", pullNumber: 7, activeFindingFingerprints: ["active-finding"] });
    assert.equal(result.posted, true);
  });

  it("keeps a published review successful when stale-thread resolution fails visibly", async () => {
    const notifier = loadContribution({
      postPullRequestComment: async () => { throw new Error("summary fallback should not run"); },
      postPullRequestReview: async () => ({ id: "99", url: "https://example.test/review/99" }),
      resolveSupersededPullRequestReviewThreads: async () => { throw new Error("provider failure"); },
    });
    const result = await notifier.post(
      { kind: "github-pr", connectionId: "11", repositoryId: "22", prNumber: 7 },
      { body: "summary", findings: [{ ruleId: "r", file: "a.ts", line: 1, message: "finding" }] },
    );
    assert.deepEqual(result, {
      posted: true,
      id: "99",
      url: "https://example.test/review/99",
      warnings: ["GitHub review was posted, but superseded findings could not be resolved."],
    });
  });

  it("deduplicates and bounds inline findings before the provider boundary", async () => {
    let comments: readonly { file: string; line: number; body: string }[] = [];
    const notifier = loadContribution({
      postPullRequestComment: async () => { throw new Error("summary fallback should not run"); },
      postPullRequestReview: async (input) => {
        comments = input.comments;
        return { id: "99", url: "https://example.test/review/99" };
      },
    });
    const finding = (index: number) => ({ ruleId: "rule", file: "src/app.ts", line: index + 1, message: `Finding ${index}` });
    await notifier.post(
      { kind: "github-pr", connectionId: "11", repositoryId: "22", prNumber: 7 },
      { body: "summary", findings: [finding(0), finding(0), ...Array.from({ length: 24 }, (_, index) => finding(index + 1))] },
    );
    assert.equal(comments.length, 20);
    assert.equal(comments[0]?.line, 1);
    assert.equal(comments[19]?.line, 20);
  });
});
