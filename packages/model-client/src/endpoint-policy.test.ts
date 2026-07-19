import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isForbiddenProviderAddress,
  parseProviderEndpoint,
  validateCloudProviderEndpoint,
  type ProviderDnsResolver,
} from "./endpoint-policy.js";

describe("provider endpoint syntax policy", () => {
  const rejected = [
    ["rejects malformed URLs", "not-a-url"],
    ["rejects file URLs", "file:///etc/passwd"],
    ["rejects data URLs", "data:text/plain,hello"],
    ["rejects FTP URLs", "ftp://api.example.com/v1"],
    ["rejects cloud HTTP", "http://api.example.com/v1"],
    ["rejects usernames", "https://user@api.example.com/v1"],
    ["rejects passwords", "https://user:secret@api.example.com/v1"],
    ["rejects fragments", "https://api.example.com/v1#internal"],
    ["rejects suffix-confusion hosts", "https://api.example.com.evil.test/v1"],
    ["rejects unapproved alternate ports", "https://api.example.com:8443/v1"],
  ] as const;
  for (const [name, baseUrl] of rejected) {
    it(name, () => assert.throws(() => parseProviderEndpoint({ baseUrl, topology: "cloud", allowedHosts: "api.example.com" })));
  }

  it("accepts one exact case-normalized cloud host", () => {
    assert.equal(parseProviderEndpoint({
      baseUrl: "HTTPS://API.EXAMPLE.COM/v1",
      topology: "cloud",
      allowedHosts: "api.example.com",
    }).hostname, "api.example.com");
  });

  it("accepts an explicitly allowlisted alternate authority", () => {
    assert.equal(parseProviderEndpoint({
      baseUrl: "https://api.example.com:8443/v1",
      topology: "cloud",
      allowedHosts: "api.example.com:8443",
    }).port, "8443");
  });

  it("allows local HTTP loopback endpoints", () => {
    assert.equal(parseProviderEndpoint({ baseUrl: "http://127.0.0.1:1234/v1", topology: "local" }).protocol, "http:");
  });

  it("still rejects non-HTTP schemes in local topology", () => {
    assert.throws(() => parseProviderEndpoint({ baseUrl: "unix:///tmp/model.sock", topology: "local" }));
  });
});

describe("provider address policy", () => {
  const cases = [
    ["rejects IPv4 unspecified", "0.0.0.0", true],
    ["rejects IPv4 loopback", "127.0.0.1", true],
    ["rejects RFC1918 10/8", "10.4.3.2", true],
    ["rejects RFC1918 172.16/12", "172.31.255.254", true],
    ["rejects RFC1918 192.168/16", "192.168.1.5", true],
    ["rejects CGNAT", "100.64.0.1", true],
    ["rejects link-local metadata", "169.254.169.254", true],
    ["rejects benchmark addresses", "198.18.0.1", true],
    ["rejects documentation addresses", "203.0.113.9", true],
    ["rejects multicast", "224.0.0.1", true],
    ["accepts public IPv4", "8.8.8.8", false],
    ["rejects IPv6 unspecified", "::", true],
    ["rejects IPv6 loopback", "::1", true],
    ["rejects IPv4-mapped IPv6", "::ffff:127.0.0.1", true],
    ["rejects IPv6 unique-local", "fd00::1", true],
    ["rejects IPv6 link-local", "fe80::1", true],
    ["rejects IPv6 multicast", "ff02::1", true],
    ["rejects IPv6 documentation", "2001:db8::1", true],
    ["accepts public IPv6", "2606:4700:4700::1111", false],
    ["rejects malformed addresses", "300.1.1.1", true],
  ] as const;
  for (const [name, address, expected] of cases) {
    it(name, () => assert.equal(isForbiddenProviderAddress(address), expected));
  }
});

describe("cloud provider DNS preflight", () => {
  const resolver = (addresses: readonly string[]): ProviderDnsResolver => async () => addresses.map((address) => ({
    address,
    family: address.includes(":") ? 6 as const : 4 as const,
  }));

  it("accepts an allowlisted host whose answers are all public", async () => {
    const result = await validateCloudProviderEndpoint("https://api.example.com/v1", "api.example.com", resolver(["8.8.8.8", "2606:4700:4700::1111"]));
    assert.deepEqual(result.addresses, ["8.8.8.8", "2606:4700:4700::1111"]);
  });

  it("rejects a mixed public and private answer set", async () => {
    await assert.rejects(validateCloudProviderEndpoint("https://api.example.com/v1", "api.example.com", resolver(["8.8.8.8", "10.0.0.2"])));
  });

  it("rejects an empty DNS answer set", async () => {
    await assert.rejects(validateCloudProviderEndpoint("https://api.example.com/v1", "api.example.com", resolver([])));
  });

  it("redacts resolver failure details", async () => {
    const failing: ProviderDnsResolver = async () => { throw new Error("secret resolver internals"); };
    await assert.rejects(
      validateCloudProviderEndpoint("https://api.example.com/v1", "api.example.com", failing),
      (error: Error) => error.message === "provider hostname could not be resolved",
    );
  });

  it("rejects literal private addresses before DNS", async () => {
    let called = false;
    const never: ProviderDnsResolver = async () => { called = true; return []; };
    await assert.rejects(validateCloudProviderEndpoint("https://127.0.0.1/v1", "127.0.0.1", never));
    assert.equal(called, false);
  });
});
