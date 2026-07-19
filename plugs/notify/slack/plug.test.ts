import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NotifyContribution } from "@gitgecko/notify";
import { createSlackNotifierPlug } from "./plug.js";

type RequestReceipt = { readonly url: string; readonly init: RequestInit };

const load = (options: {
  readonly token?: string;
  readonly responder?: (url: string, init: RequestInit) => Promise<Response>;
} = {}) => {
  const receipts: RequestReceipt[] = [];
  let tokenCalls = 0;
  let contribution: NotifyContribution | undefined;
  createSlackNotifierPlug({
    resolveBotToken: async () => { tokenCalls += 1; return options.token ?? "xoxb-test-token"; },
    fetch: async (url, init) => {
      receipts.push({ url, init });
      return options.responder
        ? options.responder(url, init)
        : new Response(JSON.stringify({ ok: true, channel: "C123456", ts: "1710000000.000100" }), { status: 200 });
    },
  }).setup({ register: (_capability, value) => { contribution = value; } });
  assert.ok(contribution);
  return { contribution, receipts, tokenCalls: () => tokenCalls };
};

const slackTarget = { kind: "slack" as const, channel: "C123456" };
const message = { body: "Review complete" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Slack conversation notifier", () => {
  it("registers one notifier contribution", () => assert.equal(load().contribution.kind, "notifier"));
  it("uses the stable slack target kind", () => assert.equal(load().contribution.targetKind, "slack"));
  it("declares the outbound transport as mutating", () => assert.equal(load().contribution.mutates, true));
  it("does not resolve a token during socket registration", () => assert.equal(load().tokenCalls(), 0));
  it("rejects a non-Slack target before token resolution", async () => {
    const runtime = load();
    const result = await runtime.contribution.post({ kind: "github-pr" }, message);
    assert.equal(result.posted, false); assert.equal(runtime.tokenCalls(), 0);
  });
  it("rejects a missing channel before token resolution", async () => {
    const runtime = load();
    const result = await runtime.contribution.post({ kind: "slack" }, message);
    assert.equal(result.posted, false); assert.equal(runtime.tokenCalls(), 0);
  });
  it("rejects a Slack channel name because transport uses stable IDs", async () => {
    const runtime = load();
    const result = await runtime.contribution.post({ kind: "slack", channel: "#reviews" }, message);
    assert.equal(result.posted, false); assert.equal(runtime.receipts.length, 0);
  });
  it("accepts channel IDs", async () => assert.equal((await load().contribution.post(slackTarget, message)).posted, true));
  it("accepts private-group IDs", async () => assert.equal((await load().contribution.post({ kind: "slack", channel: "G123456" }, message)).posted, true));
  it("accepts direct-message IDs", async () => assert.equal((await load().contribution.post({ kind: "slack", channel: "D123456" }, message)).posted, true));
  it("accepts App Home user IDs", async () => assert.equal((await load().contribution.post({ kind: "slack", channel: "U123456" }, message)).posted, true));
  it("rejects an invalid thread identifier", async () => {
    const runtime = load();
    const result = await runtime.contribution.post({ ...slackTarget, threadId: "thread-name" }, message);
    assert.equal(result.posted, false); assert.equal(runtime.receipts.length, 0);
  });
  it("rejects a missing resolved bot token", async () => {
    const runtime = load({ token: "" });
    const result = await runtime.contribution.post(slackTarget, message);
    assert.equal(result.posted, false); assert.equal(runtime.receipts.length, 0);
  });
  it("rejects an empty message", async () => assert.equal((await load().contribution.post(slackTarget, { body: "" })).posted, false));
  it("rejects a whitespace-only message", async () => assert.equal((await load().contribution.post(slackTarget, { body: "  \n" })).posted, false));
  it("rejects messages beyond Slack's documented transport limit", async () => assert.equal((await load().contribution.post(slackTarget, { body: "x".repeat(40_001) })).posted, false));
  it("posts to Slack's documented endpoint", async () => {
    const runtime = load(); await runtime.contribution.post(slackTarget, message);
    assert.equal(runtime.receipts[0]?.url, "https://slack.com/api/chat.postMessage");
  });
  it("uses a JSON POST request", async () => {
    const runtime = load(); await runtime.contribution.post(slackTarget, message);
    assert.equal(runtime.receipts[0]?.init.method, "POST");
    assert.equal(new Headers(runtime.receipts[0]?.init.headers).get("content-type"), "application/json");
  });
  it("uses the resolved token only in the authorization header", async () => {
    const runtime = load(); await runtime.contribution.post(slackTarget, message);
    assert.equal(new Headers(runtime.receipts[0]?.init.headers).get("authorization"), "Bearer xoxb-test-token");
    assert.doesNotMatch(String(runtime.receipts[0]?.init.body), /xoxb-test-token/u);
  });
  it("preserves accessible top-level text", async () => {
    const runtime = load(); await runtime.contribution.post(slackTarget, message);
    assert.equal(JSON.parse(String(runtime.receipts[0]?.init.body)).text, "Review complete");
  });
  it("does not fabricate a thread field for a root message", async () => {
    const runtime = load(); await runtime.contribution.post(slackTarget, message);
    assert.equal("thread_ts" in JSON.parse(String(runtime.receipts[0]?.init.body)), false);
  });
  it("maps a provider-neutral thread identity to Slack thread_ts", async () => {
    const runtime = load(); await runtime.contribution.post({ ...slackTarget, threadId: "1710000000.000001" }, message);
    assert.equal(JSON.parse(String(runtime.receipts[0]?.init.body)).thread_ts, "1710000000.000001");
  });
  it("suppresses link and media unfurls", async () => {
    const runtime = load(); await runtime.contribution.post(slackTarget, message);
    const body = JSON.parse(String(runtime.receipts[0]?.init.body));
    assert.equal(body.unfurl_links, false); assert.equal(body.unfurl_media, false);
  });
  it("does not invent an undocumented idempotency field", async () => {
    const runtime = load(); await runtime.contribution.post(slackTarget, { body: "Review complete", idempotencyKey: "review-1" });
    assert.equal("idempotencyKey" in JSON.parse(String(runtime.receipts[0]?.init.body)), false);
  });
  it("normalizes a root message into an addressable conversation identity", async () => {
    const result = await load().contribution.post(slackTarget, message);
    assert.deepEqual(result, { posted: true, id: "C123456:1710000000.000100", threadId: "1710000000.000100" });
  });
  it("preserves the parent thread identity on replies", async () => {
    const result = await load().contribution.post({ ...slackTarget, threadId: "1710000000.000001" }, message);
    assert.equal(result.threadId, "1710000000.000001");
  });
  it("does not fabricate a Slack permalink", async () => assert.equal((await load().contribution.post(slackTarget, message)).url, undefined));
  it("sanitizes a Slack API error envelope", async () => {
    const result = await load({ responder: async () => response({ ok: false, error: "invalid_auth" }) }).contribution.post(slackTarget, message);
    assert.deepEqual(result, { posted: false, error: "Slack conversation could not be posted." });
  });
  it("sanitizes HTTP failures", async () => {
    const result = await load({ responder: async () => response({ ok: false, error: "rate_limited" }, 429) }).contribution.post(slackTarget, message);
    assert.deepEqual(result, { posted: false, error: "Slack conversation could not be posted." });
  });
  it("sanitizes fetch failures", async () => {
    const result = await load({ responder: async () => { throw new Error("xoxb-secret"); } }).contribution.post(slackTarget, message);
    assert.deepEqual(result, { posted: false, error: "Slack conversation could not be posted." });
  });
  it("rejects a malformed success body", async () => {
    const result = await load({ responder: async () => new Response("not-json", { status: 200 }) }).contribution.post(slackTarget, message);
    assert.equal(result.posted, false);
  });
  it("rejects a success envelope without a channel", async () => {
    const result = await load({ responder: async () => response({ ok: true, ts: "1710000000.000100" }) }).contribution.post(slackTarget, message);
    assert.equal(result.posted, false);
  });
  it("rejects a success envelope without a message timestamp", async () => {
    const result = await load({ responder: async () => response({ ok: true, channel: "C123456" }) }).contribution.post(slackTarget, message);
    assert.equal(result.posted, false);
  });
});
