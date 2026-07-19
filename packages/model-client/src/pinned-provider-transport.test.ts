import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Dispatcher } from "undici";

import { createPinnedLookup, createPinnedProviderTransport } from "./pinned-provider-transport.js";
import type { ProviderDnsAddress } from "./endpoint-policy.js";

type LookupResult = { readonly address: string; readonly family: number } | readonly { readonly address: string; readonly family: number }[];

const lookup = (
  hostname: string,
  addresses: readonly string[],
  options: { all?: boolean; family?: number } = {},
): Promise<LookupResult> => new Promise((resolve, reject) => {
  const pinned = createPinnedLookup(hostname, addresses) as unknown as (
    name: string,
    options: { all?: boolean; family?: number },
    callback: (error: Error | null, address?: string | readonly { address: string; family: number }[], family?: number) => void,
  ) => void;
  pinned(hostname, options, (error, address, family) => {
    if (error) reject(error);
    else if (typeof address === "string") resolve({ address, family: family! });
    else resolve(address!);
  });
});

const publicAnswers = (hostname: string): readonly ProviderDnsAddress[] => hostname === "one.example.test"
  ? [{ address: "8.8.8.8", family: 4 }]
  : [{ address: "2606:4700:4700::1111", family: 6 }];

interface RequestCapture {
  readonly url: string;
  readonly init: RequestInit & { readonly dispatcher?: Dispatcher };
}

const harness = (responses: readonly Response[], resolver = publicAnswers) => {
  const requests: RequestCapture[] = [];
  const endpoints: Array<{ url: string; addresses: readonly string[] }> = [];
  const closed: number[] = [];
  let responseIndex = 0;
  const transport = createPinnedProviderTransport("one.example.test,two.example.test", {
    resolver: async (hostname) => resolver(hostname),
    fetch: (async (input: string | URL, init?: RequestInit & { dispatcher?: Dispatcher }) => {
      requests.push({ url: new URL(input).href, init: init ?? {} });
      const response = responses[responseIndex++];
      if (!response) throw new Error("unexpected request");
      return response;
    }) as never,
    createDispatcher: (endpoint) => {
      const index = endpoints.push({ url: endpoint.url.href, addresses: endpoint.addresses }) - 1;
      return { close: async () => { closed.push(index); } } as unknown as Dispatcher;
    },
  });
  return { transport, requests, endpoints, closed };
};

describe("pinned provider lookup", () => {
  it("requires at least one validated address", () => {
    assert.throws(() => createPinnedLookup("one.example.test", []), /at least one address/);
  });
  it("rejects malformed validated addresses", () => {
    assert.throws(() => createPinnedLookup("one.example.test", ["not-an-ip"]), /invalid address/);
  });
  it("rejects a hostname change after validation", async () => {
    const pinned = createPinnedLookup("one.example.test", ["8.8.8.8"]) as unknown as Function;
    await assert.rejects(new Promise((resolve, reject) => pinned("two.example.test", {}, (error: Error | null) => error ? reject(error) : resolve(undefined))), /hostname changed/);
  });
  it("returns every approved address for an all-address lookup", async () => {
    assert.deepEqual(await lookup("one.example.test", ["8.8.8.8", "2606:4700:4700::1111"], { all: true }), [
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });
  it("returns only IPv4 when requested", async () => {
    assert.deepEqual(await lookup("one.example.test", ["8.8.8.8", "2606:4700:4700::1111"], { family: 4 }), { address: "8.8.8.8", family: 4 });
  });
  it("returns only IPv6 when requested", async () => {
    assert.deepEqual(await lookup("one.example.test", ["8.8.8.8", "2606:4700:4700::1111"], { family: 6 }), { address: "2606:4700:4700::1111", family: 6 });
  });
  it("fails when the requested family has no approved address", async () => {
    await assert.rejects(lookup("one.example.test", ["8.8.8.8"], { family: 6 }), /no validated address/);
  });
  it("rotates approved addresses instead of escaping the set", async () => {
    const pinned = createPinnedLookup("one.example.test", ["8.8.8.8", "1.1.1.1"]) as unknown as (
      name: string, options: object, callback: (error: Error | null, address: string, family: number) => void,
    ) => void;
    const one = await new Promise<string>((resolve, reject) => pinned("one.example.test", {}, (error, address) => error ? reject(error) : resolve(address)));
    const two = await new Promise<string>((resolve, reject) => pinned("one.example.test", {}, (error, address) => error ? reject(error) : resolve(address)));
    assert.deepEqual([one, two], ["8.8.8.8", "1.1.1.1"]);
  });
});

describe("pinned provider transport", () => {
  for (const limit of [-1, 4, 1.5]) {
    it(`rejects invalid redirect limit ${limit}`, () => {
      assert.throws(() => createPinnedProviderTransport("one.example.test", { maxRedirects: limit }), /redirect limit/);
    });
  }

  it("validates the exact request URL before dispatch", async () => {
    const h = harness([new Response("ok")]);
    await h.transport.fetch("https://one.example.test/v1/messages?x=1");
    assert.deepEqual(h.endpoints, [{ url: "https://one.example.test/v1/messages?x=1", addresses: ["8.8.8.8"] }]);
    await h.transport.close();
  });
  it("forces manual redirect handling", async () => {
    const h = harness([new Response("ok")]);
    await h.transport.fetch("https://one.example.test/v1", { method: "POST" });
    assert.equal(h.requests[0]?.init.redirect, "manual");
    await h.transport.close();
  });
  it("removes a caller-supplied Host header", async () => {
    const h = harness([new Response("ok")]);
    await h.transport.fetch("https://one.example.test/v1", { headers: { host: "internal" } });
    assert.equal(new Headers(h.requests[0]?.init.headers).has("host"), false);
    await h.transport.close();
  });
  it("rejects a private initial resolution before dispatch", async () => {
    const h = harness([new Response("never")], () => [{ address: "127.0.0.1", family: 4 }]);
    await assert.rejects(h.transport.fetch("https://one.example.test/v1"), /forbidden address/);
    assert.equal(h.requests.length, 0);
    await h.transport.close();
  });
  it("redacts resolver failures before dispatch", async () => {
    const h = harness([new Response("never")], () => { throw new Error("secret resolver detail"); });
    await assert.rejects(h.transport.fetch("https://one.example.test/v1"), /^Error: provider hostname could not be resolved$/);
    assert.equal(h.requests.length, 0);
    await h.transport.close();
  });
  it("follows a same-origin 307 after revalidation", async () => {
    const h = harness([new Response(null, { status: 307, headers: { location: "/v2" } }), new Response("ok")]);
    const response = await h.transport.fetch("https://one.example.test/v1", { method: "POST", body: "payload" });
    assert.equal(await response.text(), "ok");
    assert.deepEqual(h.requests.map((request) => request.url), ["https://one.example.test/v1", "https://one.example.test/v2"]);
    assert.equal(h.endpoints.length, 1);
    await h.transport.close();
  });
  it("follows a same-origin 308 after revalidation", async () => {
    const h = harness([new Response(null, { status: 308, headers: { location: "/v2" } }), new Response("ok")]);
    assert.equal((await h.transport.fetch("https://one.example.test/v1", { method: "POST" })).status, 200);
    await h.transport.close();
  });
  for (const status of [301, 302, 303]) {
    it(`rejects method-changing redirect ${status}`, async () => {
      const h = harness([new Response(null, { status, headers: { location: "/v2" } })]);
      await assert.rejects(h.transport.fetch("https://one.example.test/v1", { method: "POST" }), /preserve the request method/);
      await h.transport.close();
    });
  }
  for (const status of [301, 302, 303, 307, 308]) {
    it(`rejects redirect ${status} without a location`, async () => {
      const h = harness([new Response(null, { status })]);
      await assert.rejects(h.transport.fetch("https://one.example.test/v1", { method: "POST" }), /omitted its location/);
      await h.transport.close();
    });
  }
  it("rejects redirects beyond the bounded limit", async () => {
    const h = harness([
      new Response(null, { status: 307, headers: { location: "/2" } }),
      new Response(null, { status: 307, headers: { location: "/3" } }),
      new Response(null, { status: 307, headers: { location: "/4" } }),
      new Response(null, { status: 307, headers: { location: "/5" } }),
    ]);
    await assert.rejects(h.transport.fetch("https://one.example.test/1", { method: "POST" }), /redirect limit exceeded/);
    assert.equal(h.requests.length, 4);
    await h.transport.close();
  });
  it("strips credentials before an allowlisted cross-origin redirect", async () => {
    const h = harness([new Response(null, { status: 307, headers: { location: "https://two.example.test/v2" } }), new Response("ok")]);
    await h.transport.fetch("https://one.example.test/v1", {
      method: "POST",
      headers: { authorization: "Bearer secret", cookie: "session=x", "proxy-authorization": "Basic secret", "x-api-key": "secret", "api-key": "secret", "x-safe": "kept" },
    });
    const redirected = new Headers(h.requests[1]?.init.headers);
    for (const name of ["authorization", "cookie", "proxy-authorization", "x-api-key", "api-key"]) assert.equal(redirected.has(name), false);
    assert.equal(redirected.get("x-safe"), "kept");
    await h.transport.close();
  });
  it("retains credentials across a same-origin redirect", async () => {
    const h = harness([new Response(null, { status: 307, headers: { location: "/v2" } }), new Response("ok")]);
    await h.transport.fetch("https://one.example.test/v1", { method: "POST", headers: { authorization: "Bearer secret" } });
    assert.equal(new Headers(h.requests[1]?.init.headers).get("authorization"), "Bearer secret");
    await h.transport.close();
  });
  it("rejects a cross-origin redirect outside the allowlist", async () => {
    const h = harness([new Response(null, { status: 307, headers: { location: "https://three.example.test/v2" } })]);
    await assert.rejects(h.transport.fetch("https://one.example.test/v1", { method: "POST" }), /operator-allowlisted authority/);
    assert.equal(h.requests.length, 1);
    await h.transport.close();
  });
  it("rejects a cross-origin redirect whose DNS becomes private", async () => {
    const h = harness([new Response(null, { status: 307, headers: { location: "https://two.example.test/v2" } })], (hostname) => hostname === "one.example.test"
      ? [{ address: "8.8.8.8", family: 4 }]
      : [{ address: "169.254.169.254", family: 4 }]);
    await assert.rejects(h.transport.fetch("https://one.example.test/v1", { method: "POST" }), /forbidden address/);
    assert.equal(h.requests.length, 1);
    await h.transport.close();
  });
  it("resolves a relative redirect against the current URL", async () => {
    const h = harness([new Response(null, { status: 307, headers: { location: "../v2" } }), new Response("ok")]);
    await h.transport.fetch("https://one.example.test/api/v1", { method: "POST" });
    assert.equal(h.requests[1]?.url, "https://one.example.test/v2");
    await h.transport.close();
  });
  it("preserves a replayable POST body across 307", async () => {
    const h = harness([new Response(null, { status: 307, headers: { location: "/v2" } }), new Response("ok")]);
    await h.transport.fetch("https://one.example.test/v1", { method: "POST", body: "payload" });
    assert.deepEqual(h.requests.map((request) => request.init.body), ["payload", "payload"]);
    await h.transport.close();
  });
  it("does not attach a body to GET", async () => {
    const h = harness([new Response("ok")]);
    await h.transport.fetch("https://one.example.test/v1", { method: "GET", body: "ignored" });
    assert.equal(h.requests[0]?.init.body, undefined);
    await h.transport.close();
  });
  it("reuses and closes one dispatcher for an unchanged approved address set", async () => {
    const h = harness([new Response(null, { status: 307, headers: { location: "/v2" } }), new Response("ok")]);
    await h.transport.fetch("https://one.example.test/v1", { method: "POST" });
    assert.equal(h.endpoints.length, 1);
    await h.transport.close();
    assert.deepEqual(h.closed, [0]);
  });
  it("creates a new dispatcher when the approved DNS answer set changes", async () => {
    let resolution = 0;
    const h = harness([new Response("one"), new Response("two")], () => [{
      address: resolution++ === 0 ? "8.8.8.8" : "1.1.1.1",
      family: 4,
    }]);
    await h.transport.fetch("https://one.example.test/v1");
    await h.transport.fetch("https://one.example.test/v2");
    assert.deepEqual(h.endpoints.map((endpoint) => endpoint.addresses), [["8.8.8.8"], ["1.1.1.1"]]);
    await h.transport.close();
    assert.deepEqual(h.closed.sort(), [0, 1]);
  });
  it("makes close idempotent", async () => {
    const h = harness([new Response("ok")]);
    await h.transport.fetch("https://one.example.test/v1");
    await h.transport.close();
    await h.transport.close();
    assert.deepEqual(h.closed, [0]);
  });
  it("rejects use after close", async () => {
    const h = harness([]);
    await h.transport.close();
    await assert.rejects(h.transport.fetch("https://one.example.test/v1"), /transport is closed/);
  });
});
