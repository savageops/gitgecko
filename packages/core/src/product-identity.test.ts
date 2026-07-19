import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { productIdentity, resolveProductCloudUrl, resolveProductRepositoryUrl } from "./product-identity.js";

describe("product identity", () => {
  it("owns the canonical GitGecko public surface", () => {
    assert.equal(productIdentity.name, "GitGecko");
    assert.equal(productIdentity.shortName, "GitGecko");
    assert.equal(productIdentity.domain, "gitgecko.com");
    assert.equal(productIdentity.siteUrl, "https://gitgecko.com");
    assert.equal(productIdentity.cloudUrl, "https://app.gitgecko.com");
    assert.equal(productIdentity.packageName, "gitgecko");
    assert.equal(productIdentity.cliCommand, "gitgecko");
    assert.equal(productIdentity.installCommand, "npm i -g gitgecko");
    assert.equal(productIdentity.reviewCommand, "gitgecko review");
  });

  it("owns one canonical identity without legacy product aliases", () => {
    assert.equal(productIdentity.authDirectory, "gitgecko");
    assert.deepEqual(productIdentity.env, {
      cloudUrl: "GITGECKO_CLOUD_URL",
      repositoryUrl: "GITGECKO_REPOSITORY_URL",
    });
    assert.equal("legacy" in productIdentity, false);
  });

  it("resolves the canonical cloud URL from its single owner", () => {
    assert.equal(resolveProductCloudUrl({}), "https://app.gitgecko.com");
    assert.equal(resolveProductCloudUrl({ GITGECKO_CLOUD_URL: "https://cloud.example" }), "https://cloud.example");
  });

  it("resolves a configured HTTPS repository without accepting malformed values", () => {
    assert.equal(resolveProductRepositoryUrl({ GITGECKO_REPOSITORY_URL: "https://github.example/team/review.git" }), "https://github.example/team/review");
    assert.equal(resolveProductRepositoryUrl({ NEXT_PUBLIC_GITGECKO_REPOSITORY_URL: "https://github.example/team/review" }), "https://github.example/team/review");
    assert.equal(resolveProductRepositoryUrl({ GITGECKO_REPOSITORY_URL: "javascript:alert(1)" }), productIdentity.repositoryUrl);
  });
});
