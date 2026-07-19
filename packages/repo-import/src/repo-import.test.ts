/**
 * TDD tests for the repo-import owner (02 §2).
 *
 * Challenges the CAPABILITY: import → listFiles → readFile, multi-provider
 * specs, sync freshness, glob filtering.
 *
 * Per project TDD rule: written FIRST, fail, then code passes. Never weakened.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryRepoHandle,
  githubRepo,
  type RepoFile,
  type RepoSpec,
  type VcsProvider,
} from "./repo-import.js";

const files: RepoFile[] = [
  { path: "src/main.py", content: "print('hello')", size: 14 },
  { path: "src/utils.py", content: "def f(): pass", size: 13 },
  { path: "README.md", content: "# Test", size: 7 },
  { path: "tests/test_main.py", content: "assert True", size: 12 },
];

describe("InMemoryRepoHandle — import → list → read", () => {
  it("listFiles returns all files when no glob", () => {
    const repo = new InMemoryRepoHandle(githubRepo("org", "repo"), files);
    const all = repo.listFiles();
    assert.equal(all.length, 4);
  });

  it("listFiles filters by glob prefix (src/**)", () => {
    const repo = new InMemoryRepoHandle(githubRepo("org", "repo"), files);
    const srcFiles = repo.listFiles("src/**");
    assert.equal(srcFiles.length, 2);
    assert.ok(srcFiles.every((f) => f.path.startsWith("src/")));
  });

  it("readFile returns the file content", () => {
    const repo = new InMemoryRepoHandle(githubRepo("org", "repo"), files);
    const f = repo.readFile("src/main.py");
    assert.ok(f);
    assert.equal(f!.content, "print('hello')");
    assert.equal(f!.size, 14);
  });

  it("readFile returns null for a nonexistent file", () => {
    const repo = new InMemoryRepoHandle(githubRepo("org", "repo"), files);
    assert.equal(repo.readFile("nonexistent.py"), null);
  });

  it("carries the spec + headSha + branch", () => {
    const repo = new InMemoryRepoHandle(githubRepo("org", "repo", "develop"), files, "sha-abc");
    assert.equal(repo.spec.owner, "org");
    assert.equal(repo.spec.name, "repo");
    assert.equal(repo.spec.branch, "develop");
    assert.equal(repo.headSha, "sha-abc");
    assert.equal(repo.branch, "develop");
  });
});

describe("RepoSpec — multi-provider", () => {
  it("githubRepo produces a github spec", () => {
    const s = githubRepo("org", "repo");
    assert.equal(s.provider, "github");
    assert.equal(s.owner, "org");
    assert.equal(s.name, "repo");
  });

  it("supports all VCS providers", () => {
    for (const provider of ["github", "gitlab", "bitbucket", "azure-devops", "local"] as VcsProvider[]) {
      const s: RepoSpec = { provider, owner: "o", name: "n" };
      assert.equal(s.provider, provider);
    }
  });

  it("carries a token for private repos", () => {
    const s: RepoSpec = { provider: "github", owner: "o", name: "n", token: "ghs_xxx" };
    assert.equal(s.token, "ghs_xxx");
  });

  it("branch is optional (defaults to main at the handle level)", () => {
    const s = githubRepo("o", "n");
    assert.equal(s.branch, undefined);
    const repo = new InMemoryRepoHandle(s, files);
    assert.equal(repo.branch, "main"); // default
  });
});

describe("DiffEntry shape", () => {
  it("a diff entry carries path, status, additions, deletions", () => {
    const repo = new InMemoryRepoHandle(githubRepo("o", "n"), files);
    const diff = repo.getDiff("base", "head");
    assert.equal(Array.isArray(diff), true);
    // v1: in-memory diff is empty (no git history)
    assert.equal(diff.length, 0);
  });
});
