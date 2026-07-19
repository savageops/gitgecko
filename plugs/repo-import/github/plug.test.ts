import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { boundGitHubComment, createGitHubAppSource, createGitHubAppJwt, manifest, resolveGitHubAppEnvironment } from "./plug.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

const response = (status: number, body: string) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
});

describe("GitHub App repo-import plug", () => {
  it("resolves canonical GitGecko environment names", () => {
    assert.deepEqual(resolveGitHubAppEnvironment({
      GITGECKO_GITHUB_APP_ID: "123",
      GITGECKO_GITHUB_APP_PRIVATE_KEY: "pem",
      GITGECKO_GITHUB_API_BASE_URL: "https://github.example/api",
    }), { appId: "123", privateKey: "pem", apiBaseUrl: "https://github.example/api" });
  });

  it("declares installation verification, repository catalog, pull-request source, linked requirements, and snapshot capabilities", () => {
    assert.equal(manifest.owner, "repo-import");
    assert.deepEqual(manifest.capabilities, ["installation-verify", "installation-repositories", "pull-request-diff", "pull-request-linked-issues", "repository-snapshot"]);
  });

  it("mints a short-lived RS256 app JWT without exposing the private key", () => {
    const token = createGitHubAppJwt({ appId: "123", privateKey, now: 1_700_000_000_000 });
    const [header, payload, signature] = token.split(".");
    assert.ok(header && payload && signature);
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString("utf8")), { alg: "RS256", typ: "JWT" });
    assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), { iat: 1_699_999_940, exp: 1_700_000_540, iss: "123" });
    assert.equal(token.includes(privateKey), false);
  });

  it("normalizes an escaped PEM value before using it", () => {
    const token = createGitHubAppJwt({ appId: "123", privateKey: privateKey.replace(/\n/g, "\\n"), now: 1_700_000_000_000 });
    assert.equal(token.split(".").length, 3);
  });

  it("verifies repository access through an installation token before linking", async () => {
    const calls: Array<{ url: string; authorization: string | undefined }> = [];
    const source = createGitHubAppSource({
      appId: "123",
      privateKey,
      fetchFn: async (url, init) => {
        calls.push({ url, authorization: init.headers.Authorization });
        if (url.endsWith("/access_tokens")) return response(201, '{"token":"installation-token"}');
        if (url.endsWith("/repositories/456")) return response(200, '{"id":456,"name":"repo","owner":{"login":"acme"},"default_branch":"main"}');
        return response(200, '{"sha":"0123456789abcdef0123456789abcdef01234567"}');
      },
    });

    const repository = await source.verifyRepository({ installationId: "77", repositoryId: "456" });
    assert.deepEqual(repository, { repositoryId: "456", owner: "acme", name: "repo", defaultBranch: "main", headSha: "0123456789abcdef0123456789abcdef01234567" });
    assert.match(calls[0]!.url, /\/app\/installations\/77\/access_tokens$/);
    assert.match(calls[0]!.authorization ?? "", /^Bearer ey/);
    assert.equal(calls[1]!.authorization, "Bearer installation-token");
    assert.match(calls[2]!.url, /\/repos\/acme\/repo\/commits\/main$/);
  });

  it("lists the installation repository catalog without accepting client-owned identities", async () => {
    const source = createGitHubAppSource({
      appId: "123",
      privateKey,
      fetchFn: async (url, init) => {
        if (url.endsWith("/access_tokens")) return response(201, '{"token":"installation-token"}');
        assert.equal(init.headers.Authorization, "Bearer installation-token");
        assert.match(url, /\/installation\/repositories\?per_page=100&page=1$/);
        return response(200, '{"repositories":[{"id":456,"name":"api","owner":{"login":"acme"},"default_branch":"main"},{"id":789,"name":"web","owner":{"login":"acme"},"default_branch":"trunk"}]}');
      },
    });
    assert.deepEqual(await source.listInstallationRepositories({ installationId: "77" }), [
      { repositoryId: "456", owner: "acme", name: "api", defaultBranch: "main" },
      { repositoryId: "789", owner: "acme", name: "web", defaultBranch: "trunk" },
    ]);
  });

  it("rejects a repository response whose identity does not match the requested repository", async () => {
    const source = createGitHubAppSource({
      appId: "123",
      privateKey,
      fetchFn: async (url) => url.endsWith("/access_tokens")
        ? response(201, '{"token":"installation-token"}')
        : response(200, '{"id":999,"name":"repo","owner":{"login":"acme"}}'),
    });
    await assert.rejects(
      source.verifyRepository({ installationId: "77", repositoryId: "456" }),
      /repository identity mismatch/i,
    );
  });

  it("retrieves a pull-request diff only after resolving the installation-scoped repository", async () => {
    const calls: Array<{ url: string; accept: string | undefined }> = [];
    const source = createGitHubAppSource({
      appId: "123",
      privateKey,
      fetchFn: async (url, init) => {
        calls.push({ url, accept: init.headers.Accept });
        if (url.endsWith("/access_tokens")) return response(201, '{"token":"installation-token"}');
        if (url.endsWith("/repositories/456")) return response(200, '{"id":456,"name":"repo","owner":{"login":"acme"}}');
        return response(200, "diff --git a/a.ts b/a.ts\n+added");
      },
    });

    const result = await source.fetchPullRequestDiff({ installationId: "77", repositoryId: "456", pullNumber: 9 });
    assert.equal(result.diff, "diff --git a/a.ts b/a.ts\n+added");
    assert.equal(result.repository.owner, "acme");
    assert.match(calls.at(-1)!.url, /\/repos\/acme\/repo\/pulls\/9$/);
    assert.equal(calls.at(-1)!.accept, "application/vnd.github.v3.diff");
  });

  it("retrieves only GitHub-linked issue requirements through the installation authority", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const source = createGitHubAppSource({
      appId: "123", privateKey,
      fetchFn: async (url, init) => {
        calls.push({ url, method: init.method, ...(init.body ? { body: init.body } : {}) });
        if (url.endsWith("/access_tokens")) return response(201, '{"token":"installation-token"}');
        if (url.endsWith("/repositories/456")) return response(200, '{"id":456,"name":"repo","owner":{"login":"acme"}}');
        return response(200, '{"data":{"repository":{"pullRequest":{"closingIssuesReferences":{"nodes":[{"number":42,"title":"Protect login","bodyText":"- [ ] reject expired token","url":"https://github.com/acme/repo/issues/42"}],"pageInfo":{"hasNextPage":false}}}}}}');
      },
    });
    assert.deepEqual(await source.fetchPullRequestLinkedIssues({ installationId: "77", repositoryId: "456", pullNumber: 9 }), [{ number: 42, title: "Protect login", body: "- [ ] reject expired token", url: "https://github.com/acme/repo/issues/42" }]);
    assert.match(calls.at(-1)?.body ?? "", /closingIssuesReferences/);
  });

  it("posts a pull-request comment through the same installation authority", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const source = createGitHubAppSource({
      appId: "123",
      privateKey,
      fetchFn: async (url, init) => {
        calls.push({ url, method: init.method, ...(init.body ? { body: init.body } : {}) });
        if (url.endsWith("/access_tokens")) return response(201, '{"token":"installation-token"}');
        if (url.endsWith("/repositories/456")) return response(200, '{"id":456,"name":"repo","owner":{"login":"acme"}}');
        if (url.endsWith("/comments?per_page=100")) return response(200, "[]");
        return response(201, '{"id":42,"html_url":"https://github.com/acme/repo/issues/9#issuecomment-42"}');
      },
    });

    const result = await source.postPullRequestComment({ installationId: "77", repositoryId: "456", pullNumber: 9, body: "review body" });
    assert.deepEqual(result, { id: "42", url: "https://github.com/acme/repo/issues/9#issuecomment-42" });
    assert.match(calls.at(-1)!.url, /\/repos\/acme\/repo\/issues\/9\/comments$/);
    assert.equal(calls.at(-1)!.method, "POST");
    assert.equal(calls.at(-1)!.body, JSON.stringify({ body: "review body" }));
  });

  it("posts a bounded batch of changed-line findings through one pull-request review", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const source = createGitHubAppSource({
      appId: "123",
      privateKey,
      fetchFn: async (url, init) => {
        calls.push({ url, method: init.method, ...(init.body ? { body: init.body } : {}) });
        if (url.endsWith("/access_tokens")) return response(201, '{"token":"installation-token"}');
        if (url.endsWith("/repositories/456")) return response(200, '{"id":456,"name":"repo","owner":{"login":"acme"}}');
        return response(200, '{"id":42,"html_url":"https://github.com/acme/repo/pull/9#pullrequestreview-42"}');
      },
    });
    const result = await source.postPullRequestReview({
      installationId: "77",
      repositoryId: "456",
      pullNumber: 9,
      body: "<!-- gitgecko-review -->\nSummary",
      comments: [{ file: "src/app.ts", line: 5, body: "Finding" }],
    });
    assert.deepEqual(result, { id: "42", url: "https://github.com/acme/repo/pull/9#pullrequestreview-42" });
    assert.match(calls.at(-1)!.url, /\/repos\/acme\/repo\/pulls\/9\/reviews$/);
    assert.equal(calls.at(-1)!.method, "POST");
    assert.deepEqual(JSON.parse(calls.at(-1)!.body!), {
      body: "<!-- gitgecko-review -->\nSummary",
      event: "COMMENT",
      comments: [{ path: "src/app.ts", line: 5, side: "RIGHT", body: "Finding" }],
    });
  });

  it("reuses an App-authored review with the same action marker", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createGitHubAppSource({
      appId: "123",
      privateKey,
      fetchFn: async (url, init) => {
        calls.push({ url, method: init.method });
        if (url.endsWith("/access_tokens")) return response(201, '{"token":"installation-token"}');
        if (url.endsWith("/repositories/456")) return response(200, '{"id":456,"name":"repo","owner":{"login":"acme"}}');
        if (url.includes("/pulls/9/reviews?")) return response(200, JSON.stringify([{
          id: 42,
          html_url: "https://github.com/acme/repo/pull/9#pullrequestreview-42",
          body: "<!-- gitgecko-action:review-comment:run-7 -->\nSummary",
          user: { type: "Bot" },
        }]));
        throw new Error("duplicate review must not be posted");
      },
    });

    const result = await source.postPullRequestReview({
      installationId: "77",
      repositoryId: "456",
      pullNumber: 9,
      idempotencyKey: "review-comment:run-7",
      body: "Summary",
      comments: [{ file: "src/app.ts", line: 5, body: "Finding" }],
    });

    assert.deepEqual(result, { id: "42", url: "https://github.com/acme/repo/pull/9#pullrequestreview-42" });
    assert.equal(calls.some((call) => call.method === "POST" && call.url.endsWith("/pulls/9/reviews")), false);
  });

  it("does not trust an action marker authored by a GitHub user", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createGitHubAppSource({
      appId: "123",
      privateKey,
      fetchFn: async (url, init) => {
        calls.push({ url, method: init.method });
        if (url.endsWith("/access_tokens")) return response(201, '{"token":"installation-token"}');
        if (url.endsWith("/repositories/456")) return response(200, '{"id":456,"name":"repo","owner":{"login":"acme"}}');
        if (url.includes("/pulls/9/reviews?")) return response(200, JSON.stringify([{
          id: 41,
          html_url: "https://github.com/acme/repo/pull/9#pullrequestreview-41",
          body: "<!-- gitgecko-action:review-comment:run-7 -->\nSpoof",
          user: { type: "User" },
        }]));
        return response(200, '{"id":42,"html_url":"https://github.com/acme/repo/pull/9#pullrequestreview-42"}');
      },
    });

    const result = await source.postPullRequestReview({
      installationId: "77",
      repositoryId: "456",
      pullNumber: 9,
      idempotencyKey: "review-comment:run-7",
      body: "Summary",
      comments: [{ file: "src/app.ts", line: 5, body: "Finding" }],
    });

    assert.equal(result.id, "42");
    assert.equal(calls.filter((call) => call.method === "POST" && call.url.endsWith("/pulls/9/reviews")).length, 1);
  });

  it("fails closed when review reconciliation returns malformed JSON", async () => {
    const source = createGitHubAppSource({
      appId: "123",
      privateKey,
      fetchFn: async (url) => {
        if (url.endsWith("/access_tokens")) return response(201, '{"token":"installation-token"}');
        if (url.endsWith("/repositories/456")) return response(200, '{"id":456,"name":"repo","owner":{"login":"acme"}}');
        if (url.includes("/pulls/9/reviews?")) return response(200, "not-json");
        throw new Error("review must not be posted after malformed reconciliation data");
      },
    });

    await assert.rejects(source.postPullRequestReview({
      installationId: "77",
      repositoryId: "456",
      pullNumber: 9,
      idempotencyKey: "review-comment:run-7",
      body: "Summary",
      comments: [{ file: "src/app.ts", line: 5, body: "Finding" }],
    }), /reviews response is malformed/);
  });

  it("rejects unsafe inline review locations before minting an installation token", async () => {
    let called = false;
    const source = createGitHubAppSource({ appId: "123", privateKey, fetchFn: async () => { called = true; return response(200, "{}"); } });
    await assert.rejects(
      source.postPullRequestReview({ installationId: "77", repositoryId: "456", pullNumber: 9, body: "summary", comments: [{ file: "../secret", line: 1, body: "finding" }] }),
      /inline review comment location is invalid/i,
    );
    assert.equal(called, false);
  });

  it("resolves only stale App-authored GitGecko finding threads", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const source = createGitHubAppSource({
      appId: "123",
      privateKey,
      fetchFn: async (url, init) => {
        calls.push({ url, method: init.method, ...(init.body ? { body: init.body } : {}) });
        if (url.endsWith("/access_tokens")) return response(201, '{"token":"installation-token"}');
        if (url.endsWith("/repositories/456")) return response(200, '{"id":456,"name":"repo","owner":{"login":"acme"}}');
        if (init.method === "POST" && url.endsWith("/graphql") && init.body?.includes("ResolveSupersededGitGeckoFinding")) {
          return response(200, '{"data":{"resolveReviewThread":{"thread":{"id":"thread-stale","isResolved":true}}}}');
        }
        return response(200, JSON.stringify({ data: {
          viewer: { login: "gitgecko[bot]" },
          repository: { pullRequest: { reviewThreads: { nodes: [
            { id: "thread-stale", isResolved: false, comments: { nodes: [{ body: "<!-- gitgecko-finding:stale -->\\nOld", author: { login: "gitgecko[bot]" } }] } },
            { id: "thread-active", isResolved: false, comments: { nodes: [{ body: "<!-- gitgecko-finding:active -->\\nCurrent", author: { login: "gitgecko[bot]" } }] } },
            { id: "thread-spoof", isResolved: false, comments: { nodes: [{ body: "<!-- gitgecko-finding:spoof -->\\nNot ours", author: { login: "attacker" } }] } },
          ], pageInfo: { hasNextPage: false } } } },
        } }));
      },
    });
    const result = await source.resolveSupersededPullRequestReviewThreads({ installationId: "77", repositoryId: "456", pullNumber: 9, activeFindingFingerprints: ["active"] });
    assert.deepEqual(result, { resolved: 1 });
    const mutation = calls.find((call) => call.body?.includes("ResolveSupersededGitGeckoFinding"));
    assert.ok(mutation);
    assert.deepEqual(JSON.parse(mutation.body!), {
      query: "mutation ResolveSupersededGitGeckoFinding($threadId: ID!) { resolveReviewThread(input: {threadId: $threadId}) { thread { id isResolved } } }",
      variables: { threadId: "thread-stale" },
    });
  });

  it("updates the existing GitGecko comment instead of duplicating it on retry", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createGitHubAppSource({
      appId: "123",
      privateKey,
      fetchFn: async (url, init) => {
        calls.push({ url, method: init.method });
        if (url.endsWith("/access_tokens")) return response(201, '{"token":"installation-token"}');
        if (url.endsWith("/repositories/456")) return response(200, '{"id":456,"name":"repo","owner":{"login":"acme"}}');
        if (url.endsWith("/comments?per_page=100")) return response(200, '[{"id":42,"body":"<!-- gitgecko-review --> old","performed_via_github_app":{"id":123},"html_url":"https://github.com/comment/42"}]');
        return response(200, '{"id":42,"html_url":"https://github.com/comment/42"}');
      },
    });

    await source.postPullRequestComment({ installationId: "77", repositoryId: "456", pullNumber: 9, body: "<!-- gitgecko-review --> new" });
    assert.match(calls.at(-1)!.url, /\/issues\/comments\/42$/);
    assert.equal(calls.at(-1)!.method, "PATCH");
  });

  it("never overwrites a user comment that spoofs the GitGecko marker", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const source = createGitHubAppSource({
      appId: "123",
      privateKey,
      fetchFn: async (url, init) => {
        calls.push({ url, method: init.method });
        if (url.endsWith("/access_tokens")) return response(201, '{"token":"installation-token"}');
        if (url.endsWith("/repositories/456")) return response(200, '{"id":456,"name":"repo","owner":{"login":"acme"}}');
        if (url.endsWith("/comments?per_page=100")) return response(200, '[{"id":7,"body":"<!-- gitgecko-review --> spoofed","performed_via_github_app":null}]');
        return response(201, '{"id":43,"html_url":"https://github.com/comment/43"}');
      },
    });

    await source.postPullRequestComment({ installationId: "77", repositoryId: "456", pullNumber: 9, body: "<!-- gitgecko-review --> real" });
    assert.match(calls.at(-1)!.url, /\/issues\/9\/comments$/);
    assert.equal(calls.at(-1)!.method, "POST");
  });

  it("discovers the App-authored marker beyond the first comment page", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const firstPage = JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id, body: "discussion" })));
    const source = createGitHubAppSource({
      appId: "123",
      privateKey,
      fetchFn: async (url, init) => {
        calls.push({ url, method: init.method });
        if (url.endsWith("/access_tokens")) return response(201, '{"token":"installation-token"}');
        if (url.endsWith("/repositories/456")) return response(200, '{"id":456,"name":"repo","owner":{"login":"acme"}}');
        if (url.endsWith("/comments?per_page=100")) return response(200, firstPage);
        if (url.endsWith("/comments?per_page=100&page=2")) return response(200, '[{"id":142,"body":"<!-- gitgecko-review --> old","performed_via_github_app":{"id":123}}]');
        return response(200, '{"id":142,"html_url":"https://github.com/comment/142"}');
      },
    });

    await source.postPullRequestComment({ installationId: "77", repositoryId: "456", pullNumber: 9, body: "<!-- gitgecko-review --> new" });
    assert.match(calls.at(-1)!.url, /\/issues\/comments\/142$/);
    assert.equal(calls.at(-1)!.method, "PATCH");
  });

  it("bounds large Unicode comments without splitting code points", () => {
    const bounded = boundGitHubComment("<!-- gitgecko-review -->" + "🦎".repeat(20_000));
    assert.ok(Buffer.byteLength(bounded) <= 65_536);
    assert.match(bounded, /Review truncated/);
    assert.equal(bounded.includes("�"), false);
  });

  it("retrieves a bounded repository snapshot through the installation token", async () => {
    const source = createGitHubAppSource({
      appId: "123", privateKey,
      fetchFn: async (url) => {
        if (url.endsWith("/access_tokens")) return response(201, '{"token":"installation-token"}');
        if (url.endsWith("/repositories/456")) return response(200, '{"id":456,"name":"repo","owner":{"login":"acme"},"default_branch":"main"}');
        if (url.includes("/git/trees/main")) return response(200, '{"tree":[{"type":"blob","path":"src/a.ts","sha":"a"},{"type":"tree","path":"src"},{"type":"blob","path":"README.md","sha":"b"}]}');
        if (url.endsWith("/git/blobs/a")) return response(200, '{"encoding":"base64","content":"ZXhwb3J0IGNvbnN0IGE9MTs=","size":17}');
        return response(200, '{"encoding":"base64","content":"IyBoaQ==","size":4}');
      },
    });
    const snapshot = await source.fetchRepositorySnapshot({ installationId: "77", repositoryId: "456", maxFiles: 2 });
    assert.equal(snapshot.ref, "main");
    assert.deepEqual(snapshot.files, [
      { path: "src/a.ts", content: "export const a=1;", size: 17 },
      { path: "README.md", content: "# hi", size: 4 },
    ]);
  });

  it("fails closed when GitHub truncates a recursive repository tree", async () => {
    const source = createGitHubAppSource({ appId: "123", privateKey, fetchFn: async (url) => {
      if (url.endsWith("/access_tokens")) return response(201, '{"token":"installation-token"}');
      if (url.endsWith("/repositories/456")) return response(200, '{"id":456,"name":"repo","owner":{"login":"acme"}}');
      return response(200, '{"truncated":true,"tree":[]}');
    } });
    await assert.rejects(source.fetchRepositorySnapshot({ installationId: "77", repositoryId: "456" }), /tree is truncated/i);
  });

  it("rejects invalid pull numbers before making a network request", async () => {
    let called = false;
    const source = createGitHubAppSource({ appId: "123", privateKey, fetchFn: async () => { called = true; return response(200, "{}"); } });
    await assert.rejects(source.fetchPullRequestDiff({ installationId: "77", repositoryId: "456", pullNumber: 0 }), /positive integer/i);
    assert.equal(called, false);
  });

  it("rejects an unavailable installation without including its bearer credential", async () => {
    const source = createGitHubAppSource({
      appId: "123",
      privateKey,
      fetchFn: async () => response(401, '{"message":"bad installation"}'),
    });
    await assert.rejects(source.verifyRepository({ installationId: "77", repositoryId: "456" }), (error: Error) => {
      assert.match(error.message, /installation token request failed \(401\)/i);
      assert.equal(error.message.includes(privateKey), false);
      return true;
    });
  });

  it("rejects a malformed installation-token response", async () => {
    const source = createGitHubAppSource({ appId: "123", privateKey, fetchFn: async () => response(201, '{"token":42}') });
    await assert.rejects(source.verifyRepository({ installationId: "77", repositoryId: "456" }), /installation token response is malformed/i);
  });

  it("rejects an empty pull-request diff instead of creating an empty review", async () => {
    const source = createGitHubAppSource({
      appId: "123",
      privateKey,
      fetchFn: async (url) => {
        if (url.endsWith("/access_tokens")) return response(201, '{"token":"installation-token"}');
        if (url.endsWith("/repositories/456")) return response(200, '{"id":456,"name":"repo","owner":{"login":"acme"}}');
        return response(200, "");
      },
    });
    await assert.rejects(source.fetchPullRequestDiff({ installationId: "77", repositoryId: "456", pullNumber: 9 }), /empty pull-request diff/i);
  });
});
