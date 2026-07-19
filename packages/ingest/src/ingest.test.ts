/**
 * TDD tests for the ingest owner — event routing (02 §2).
 *
 * Challenges the CAPABILITY: given a webhook event, route it to the right
 * owner + action. All event types: PR opened, slash command, push, cron, API.
 *
 * Per project TDD rule: written FIRST, fail, then code passes. Never weakened.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { routeEvent, type WebhookEvent } from "./ingest.js";

const githubEvent = (eventType: string, payload: Record<string, unknown>): WebhookEvent => ({
  source: "github-webhook",
  eventType,
  payload,
});

describe("routeEvent — pull request events → review", () => {
  it("routes pull_request.opened to review owner", () => {
    const r = routeEvent(githubEvent("pull_request.opened", {
      repository: { full_name: "org/repo" },
      pull_request: { number: 42 },
    }));
    assert.equal(r.owner, "review");
    assert.equal(r.action, "review");
    assert.equal(r.repo, "org/repo");
    assert.equal(r.prNumber, 42);
  });

  it("routes pull_request.synchronize (new commits) to review", () => {
    const r = routeEvent(githubEvent("pull_request.synchronize", { repository: { full_name: "o/r" }, pull_request: { number: 1 } }));
    assert.equal(r.owner, "review");
  });

  it("carries the diff when present in the payload", () => {
    const r = routeEvent(githubEvent("pull_request.opened", { repository: { full_name: "o/r" }, pull_request: { number: 1, diff: "+def f(): pass" } }));
    assert.equal(r.diff, "+def f(): pass");
  });
});

describe("routeEvent — slash commands → review command", () => {
  it("routes /review comment to review owner with the command", () => {
    const r = routeEvent(githubEvent("issue_comment.created", {
      repository: { full_name: "org/repo" },
      comment_body: "/review please",
      pr_number: 7,
    }));
    assert.equal(r.owner, "review");
    assert.equal(r.action, "review");
    assert.equal(r.command, "review");
    assert.equal(r.prNumber, 7);
  });

  it("routes /describe comment to the describe command", () => {
    const r = routeEvent(githubEvent("issue_comment.created", {
      repository: { full_name: "o/r" },
      comment_body: "/describe",
      pr_number: 1,
    }));
    assert.equal(r.command, "describe");
  });

  it("routes /improve, /ask, /resolve", () => {
    for (const cmd of ["improve", "ask", "resolve"]) {
      const r = routeEvent(githubEvent("issue_comment.created", { comment_body: `/${cmd}`, pr_number: 1 }));
      assert.equal(r.command, cmd, `must route /${cmd}`);
    }
  });

  it("does NOT route a comment without a slash command (noop)", () => {
    const r = routeEvent(githubEvent("issue_comment.created", { comment_body: "just a regular comment" }));
    assert.equal(r.owner, "ingest");
    assert.equal(r.action, "noop");
  });
});

describe("routeEvent — push + cron → code-intel reindex", () => {
  it("routes push to code-intel reindex", () => {
    const r = routeEvent(githubEvent("push", { repository: { full_name: "org/repo" } }));
    assert.equal(r.owner, "code-intel");
    assert.equal(r.action, "reindex");
    assert.equal(r.repo, "org/repo");
  });

  it("routes cron.reindex to code-intel reindex", () => {
    const r = routeEvent({ source: "cron", eventType: "cron.reindex", payload: { repo: "org/repo" } });
    assert.equal(r.owner, "code-intel");
    assert.equal(r.action, "reindex");
  });
});

describe("routeEvent — API + CLI events", () => {
  it("routes api.review to review owner", () => {
    const r = routeEvent({ source: "api", eventType: "api.review", payload: { repo: "o/r", diff: "x" } });
    assert.equal(r.owner, "review");
    assert.equal(r.diff, "x");
  });

  it("routes api.search to code-intel retrieve", () => {
    const r = routeEvent({ source: "api", eventType: "api.search", payload: { repo: "o/r" } });
    assert.equal(r.owner, "code-intel");
    assert.equal(r.action, "retrieve");
  });

  it("routes cli.review to review owner", () => {
    const r = routeEvent({ source: "cli", eventType: "cli.review", payload: { repo: "local" } });
    assert.equal(r.owner, "review");
  });
});

describe("routeEvent — robustness", () => {
  it("routes unknown events to ingest noop", () => {
    const r = routeEvent(githubEvent("unknown.event", {}));
    assert.equal(r.owner, "ingest");
    assert.equal(r.action, "noop");
    assert.ok(r.reason.includes("unknown"));
  });

  it("handles missing repository gracefully", () => {
    const r = routeEvent(githubEvent("pull_request.opened", { pull_request: { number: 1 } }));
    assert.equal(r.repo, "unknown");
  });

  it("handles missing pull_request number gracefully", () => {
    const r = routeEvent(githubEvent("pull_request.opened", { repository: { full_name: "o/r" } }));
    assert.equal(r.prNumber, undefined);
  });
});
