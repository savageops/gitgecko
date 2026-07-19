import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { githubRepositoryName, normalizeGitHubRepository } from "./github-repository.js";

describe("normalizeGitHubRepository", () => {
  it("normalizes HTTPS and shorthand remotes", () => {
    assert.deepEqual(normalizeGitHubRepository("https://github.com/acme/service.git"), {
      owner: "acme",
      name: "service",
      url: "https://github.com/acme/service",
    });
    assert.equal(githubRepositoryName("github.com/acme/service/"), "acme/service");
  });

  it("normalizes SSH remotes", () => {
    assert.equal(normalizeGitHubRepository("git@github.com:acme/service.git")?.url, "https://github.com/acme/service");
    assert.equal(normalizeGitHubRepository("ssh://git@github.com/acme/service")?.name, "service");
  });

  it("rejects non-GitHub remotes and unsafe paths", () => {
    assert.equal(normalizeGitHubRepository("https://gitlab.com/acme/service"), undefined);
    assert.equal(normalizeGitHubRepository("https://github.com/acme/service/issues"), undefined);
    assert.equal(normalizeGitHubRepository("https://github.com/acme/service?token=secret"), undefined);
  });
});
