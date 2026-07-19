import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadHostedReviewHistory, renderHostedReviewHistory, runHostedReview, type HostedReviewResponse } from "./hosted.js";

const auth = {
  version: 2 as const,
  token: "device-token",
  deviceId: "device-1",
  cloudUrl: "https://cloud.example/",
};

describe("runHostedReview", () => {
  it("uses the device token only at the orchestrator boundary", async () => {
    let captured: RequestInit | undefined;
    const response = await runHostedReview(auth, { diff: "+const value = 1;", title: "Test" }, async (url, init) => {
      assert.equal(String(url), "https://cloud.example/api/reviews/run");
      captured = init;
      return new Response(JSON.stringify({ success: true, output: "reviewed", runId: "run-1" }), { status: 200 });
    });

    assert.equal(response.success, true);
    assert.equal(response.output, "reviewed");
    assert.equal((captured?.headers as Record<string, string>).Authorization, "Bearer device-token");
    assert.match(String(captured?.body), /const value/);
  });

  it("delegates connected pull-request acquisition to the authenticated server owner", async () => {
    let body: unknown;
    await runHostedReview(auth, { projectId: "project-42", pullNumber: 17 }, async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ success: true, output: "reviewed", artifact: { mergeable: false } });
    });

    assert.deepEqual(body, { projectId: "project-42", pullNumber: 17 });
    assert.equal(Object.hasOwn(body as object, "diff"), false);
  });

  it("surfaces typed cloud errors without pretending a review ran", async () => {
    await assert.rejects(
      () => runHostedReview(auth, { diff: "x" }, async () => new Response(JSON.stringify({ error: "quota exhausted" }), { status: 429 })),
      /quota exhausted/,
    );
  });

  it("preserves the orchestrator response fields for JSON mode", async () => {
    const response = await runHostedReview(auth, { diff: "x", command: "describe" }, async () => new Response(JSON.stringify({ success: false, output: "blocked", pathway: { family: "native-loop" } }), { status: 200 }));
    assert.deepEqual(response as HostedReviewResponse, {
      success: false,
      output: "blocked",
      pathway: { family: "native-loop" },
    });
  });
});

describe("hosted review history", () => {
  it("uses the device bearer at the tenant-scoped history boundary", async () => {
    const history = await loadHostedReviewHistory(auth, async (url, init) => {
      assert.equal(String(url), "https://cloud.example/api/reviews");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer device-token");
      return Response.json({
        available: true,
        reviews: [{ runId: "run-1", status: "succeeded", trigger: "github", acceptedAt: "2026-07-14T00:00:00.000Z", projectId: "project-1", commitSha: "1234567890abcdef" }],
      });
    });

    assert.equal(history.reviews[0]?.runId, "run-1");
    assert.match(renderHostedReviewHistory(history), /succeeded\s+run-1 .* project=project-1 commit=1234567890ab/u);
  });

  it("renders an actionable empty state and rejects failed history responses", async () => {
    assert.equal(renderHostedReviewHistory({ available: true, reviews: [] }), "No cloud reviews yet.");
    await assert.rejects(
      () => loadHostedReviewHistory(auth, async () => Response.json({ error: "unauthorized" }, { status: 401 })),
      /unauthorized/u,
    );
  });
});
