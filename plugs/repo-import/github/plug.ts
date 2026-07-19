/**
 * GitHub App source plug for the repo-import owner.
 *
 * This plug owns GitHub App signing, installation-token exchange, and GitHub
 * wire formats. Callers receive only verified repository identity and diffs;
 * no route or consumer handles the private key or upstream bearer token.
 */
import { createPrivateKey, createSign } from "node:crypto";
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import type {
  InstallationRepositoryInput,
  InstallationRepositoriesContribution,
  InstallationVerifierContribution,
  PullRequestDiffContribution,
  PullRequestLinkedIssuesContribution,
  PullRequestDiffInput,
  RepositorySnapshotContribution,
  RepositorySnapshotInput,
  RepoImportCapability,
  RepoImportContribution,
  RepositoryIdentity,
} from "@gitgecko/repo-import";
import manifestJson from "./plug.manifest.json" with { type: "json" };

const parsedManifest = parseManifest(manifestJson);
if (!parsedManifest.ok) {
  throw new Error(`GitHub repo-import manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
}
export const manifest: PlugManifest = parsedManifest.value;

export interface GitHubFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type GitHubFetch = (url: string, init: { readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body?: string }) => Promise<GitHubFetchResponse>;

export interface GitHubAppSourceConfig {
  readonly appId: string;
  readonly privateKey: string;
  readonly apiBaseUrl?: string;
  readonly fetchFn?: GitHubFetch;
  readonly now?: () => number;
}

export interface GitHubAppJwtInput {
  readonly appId: string;
  readonly privateKey: string;
  readonly now?: number;
}

export interface GitHubAppSource {
  readonly listInstallationRepositories: (input: { readonly installationId: string }) => Promise<readonly RepositoryIdentity[]>;
  readonly verifyRepository: (input: InstallationRepositoryInput) => Promise<RepositoryIdentity>;
  readonly fetchPullRequestDiff: (input: PullRequestDiffInput) => Promise<{
    readonly repository: RepositoryIdentity;
    readonly diff: string;
  }>;
  /** Authoritative issue requirements GitHub says this pull request closes. */
  readonly fetchPullRequestLinkedIssues: (input: PullRequestDiffInput) => Promise<readonly {
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly url: string;
  }[]>;
  readonly postPullRequestComment: (input: PullRequestDiffInput & { readonly body: string; readonly idempotencyKey?: string }) => Promise<{ readonly id: string; readonly url: string }>;
  readonly postPullRequestReview: (input: PullRequestDiffInput & {
    readonly body: string;
    readonly idempotencyKey?: string;
    readonly comments: readonly { readonly file: string; readonly line: number; readonly body: string }[];
  }) => Promise<{ readonly id: string; readonly url: string }>;
  readonly resolveSupersededPullRequestReviewThreads: (input: PullRequestDiffInput & {
    readonly activeFindingFingerprints: readonly string[];
  }) => Promise<{ readonly resolved: number }>;
  readonly fetchRepositorySnapshot: (input: RepositorySnapshotInput) => Promise<{
    readonly repository: RepositoryIdentity;
    readonly ref: string;
    readonly files: readonly { readonly path: string; readonly content: string; readonly size: number }[];
  }>;
}

const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_COMMENT_MAX_BYTES = 65_536;
const GITHUB_INLINE_REVIEW_MAX_COMMENTS = 20;
const COMMENT_TRUNCATION_NOTICE = "\n\n_Review truncated. Open the GitGecko trace for the complete output._";

/** Encode one provider mutation identity without allowing marker injection. */
const actionMarker = (idempotencyKey: string | undefined): string | undefined => {
  if (idempotencyKey === undefined) return undefined;
  if (!/^[A-Za-z0-9:_-]{1,200}$/u.test(idempotencyKey)) throw new Error("notification idempotency key is invalid");
  return `<!-- gitgecko-action:${idempotencyKey} -->`;
};

/** Keep provider payloads valid without splitting a Unicode code point. */
export const boundGitHubComment = (body: string): string => {
  if (Buffer.byteLength(body) <= GITHUB_COMMENT_MAX_BYTES) return body;
  const budget = GITHUB_COMMENT_MAX_BYTES - Buffer.byteLength(COMMENT_TRUNCATION_NOTICE);
  let bytes = 0;
  let bounded = "";
  for (const character of body) {
    const size = Buffer.byteLength(character);
    if (bytes + size > budget) break;
    bounded += character;
    bytes += size;
  }
  return bounded + COMMENT_TRUNCATION_NOTICE;
};

const requiredPositiveId = (value: string, label: string): string => {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive decimal identifier`);
  return value;
};

/** Reject paths and locations GitHub cannot safely bind to a changed right-side line. */
const assertInlineReviewComment = (comment: { readonly file: string; readonly line: number; readonly body: string }): void => {
  const parts = comment.file.split("/");
  if (!comment.file || comment.file.startsWith("/") || comment.file.includes("\\") || parts.some((part) => !part || part === "." || part === "..") || !Number.isSafeInteger(comment.line) || comment.line < 1 || !comment.body.trim()) {
    throw new Error("inline review comment location is invalid");
  }
};

const normalizePrivateKey = (value: string): string => value.replace(/\\n/g, "\n");

const base64Json = (value: Readonly<Record<string, string | number>>): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** Create GitHub's required short-lived RS256 App JWT without persisting credentials. */
export const createGitHubAppJwt = ({ appId, privateKey, now = Date.now() }: GitHubAppJwtInput): string => {
  if (!appId.trim()) throw new Error("GitHub App id is required");
  const issuedAt = Math.floor(now / 1000) - 60;
  const unsigned = `${base64Json({ alg: "RS256", typ: "JWT" })}.${base64Json({ iat: issuedAt, exp: issuedAt + 600, iss: appId })}`;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    return `${unsigned}.${signer.sign(createPrivateKey(normalizePrivateKey(privateKey))).toString("base64url")}`;
  } catch {
    throw new Error("GitHub App private key is invalid");
  }
};

const parseObject = (body: string, resource: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`GitHub ${resource} response is malformed`);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Reject GraphQL failures and malformed envelopes before interpreting provider-owned thread state. */
const parseGraphQlData = (body: string, operation: string): Record<string, unknown> => {
  const envelope = parseObject(body, operation);
  if (Array.isArray(envelope.errors) && envelope.errors.length > 0) throw new Error(`GitHub ${operation} request failed`);
  if (!isRecord(envelope.data)) throw new Error(`GitHub ${operation} response is malformed`);
  return envelope.data;
};

const parseRepository = (body: string, repositoryId: string): RepositoryIdentity => {
  const value = parseObject(body, "repository");
  const owner = value.owner;
  const ownerLogin = owner && typeof owner === "object" && !Array.isArray(owner)
    ? (owner as Record<string, unknown>).login
    : undefined;
  const id = value.id === undefined ? "" : String(value.id);
  if (id !== repositoryId) throw new Error("GitHub repository identity mismatch");
  if (typeof value.name !== "string" || !value.name || typeof ownerLogin !== "string" || !ownerLogin) {
    throw new Error("GitHub repository response is malformed");
  }
  return {
    repositoryId,
    owner: ownerLogin,
    name: value.name,
    ...(typeof value.default_branch === "string" && value.default_branch ? { defaultBranch: value.default_branch } : {}),
  };
};

const defaultFetch: GitHubFetch = async (url, init) => fetch(url, init);

const normalizedApiBaseUrl = (value: string | undefined): string => {
  const candidate = value ?? "https://api.github.com";
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("GitHub API base URL must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:") throw new Error("GitHub API base URL must use HTTPS");
  return url.toString().replace(/\/$/, "");
};

/** Build an installation-scoped source runtime with no ambient process state. */
export const createGitHubAppSource = (config: GitHubAppSourceConfig): GitHubAppSource => {
  const apiBaseUrl = normalizedApiBaseUrl(config.apiBaseUrl);
  const fetchFn = config.fetchFn ?? defaultFetch;
  const appId = config.appId.trim();
  if (!appId) throw new Error("GitHub App id is required");
  if (!config.privateKey.trim()) throw new Error("GitHub App private key is required");

  const mintInstallationToken = async (installationId: string): Promise<string> => {
    const id = requiredPositiveId(installationId, "installationId");
    const response = await fetchFn(`${apiBaseUrl}/app/installations/${encodeURIComponent(id)}/access_tokens`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${createGitHubAppJwt({
          appId,
          privateKey: config.privateKey,
          ...(config.now ? { now: config.now() } : {}),
        })}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
    });
    if (!response.ok) throw new Error(`GitHub installation token request failed (${response.status})`);
    const value = parseObject(await response.text(), "installation token");
    if (typeof value.token !== "string" || !value.token) throw new Error("GitHub installation token response is malformed");
    return value.token;
  };

  const resolveRepository = async (repositoryId: string, token: string): Promise<RepositoryIdentity> => {
    const id = requiredPositiveId(repositoryId, "repositoryId");
    const response = await fetchFn(`${apiBaseUrl}/repositories/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
    });
    if (!response.ok) throw new Error(`GitHub repository authorization failed (${response.status})`);
    return parseRepository(await response.text(), id);
  };

  /** Use the App installation token for GraphQL without letting callers handle credentials. */
  const graphQl = async (token: string, query: string, variables: Record<string, unknown>, operation: string): Promise<Record<string, unknown>> => {
    const response = await fetchFn(`${apiBaseUrl}/graphql`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`GitHub ${operation} request failed (${response.status})`);
    return parseGraphQlData(await response.text(), operation);
  };

  const verifyRepository = async (input: InstallationRepositoryInput): Promise<RepositoryIdentity> => {
    const token = await mintInstallationToken(input.installationId);
    const repository = await resolveRepository(input.repositoryId, token);
    const ref = repository.defaultBranch ?? "HEAD";
    const response = await fetchFn(`${apiBaseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/commits/${encodeURIComponent(ref)}`, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
    });
    if (!response.ok) throw new Error(`GitHub repository head request failed (${response.status})`);
    const value = parseObject(await response.text(), "repository head");
    if (typeof value.sha !== "string" || !/^[0-9a-f]{40}$/i.test(value.sha)) {
      throw new Error("GitHub repository head response is malformed");
    }
    return { ...repository, headSha: value.sha };
  };

  return {
    verifyRepository,
    listInstallationRepositories: async (input) => {
      const token = await mintInstallationToken(input.installationId);
      const repositories: RepositoryIdentity[] = [];
      for (let page = 1; page <= 100; page++) {
        const response = await fetchFn(`${apiBaseUrl}/installation/repositories?per_page=100&page=${page}`, {
          method: "GET",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
          },
        });
        if (!response.ok) throw new Error(`GitHub installation repositories request failed (${response.status})`);
        const value = parseObject(await response.text(), "installation repositories");
        if (!Array.isArray(value.repositories)) throw new Error("GitHub installation repositories response is malformed");
        for (const repository of value.repositories) {
          if (!repository || typeof repository !== "object" || Array.isArray(repository)) throw new Error("GitHub installation repository response is malformed");
          const repositoryId = String((repository as Record<string, unknown>).id ?? "");
          repositories.push(parseRepository(JSON.stringify(repository), repositoryId));
        }
        if (value.repositories.length < 100) return repositories;
      }
      throw new Error("GitHub installation repository catalog exceeds the supported pagination limit");
    },
    fetchPullRequestDiff: async (input) => {
      if (!Number.isSafeInteger(input.pullNumber) || input.pullNumber < 1) {
        throw new Error("pullNumber must be a positive integer");
      }
      const token = await mintInstallationToken(input.installationId);
      const repository = await resolveRepository(input.repositoryId, token);
      const response = await fetchFn(
        `${apiBaseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls/${input.pullNumber}`,
        {
          method: "GET",
          headers: {
            Accept: "application/vnd.github.v3.diff",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
          },
        },
      );
      if (!response.ok) throw new Error(`GitHub pull-request diff request failed (${response.status})`);
      const diff = await response.text();
      if (!diff.trim()) throw new Error("GitHub returned an empty pull-request diff");
      return { repository, diff };
    },
    // GitHub's PullRequest.closingIssuesReferences is the authoritative link,
    // not a regex over PR prose or a caller-supplied issue URL.
    fetchPullRequestLinkedIssues: async (input) => {
      if (!Number.isSafeInteger(input.pullNumber) || input.pullNumber < 1) throw new Error("pullNumber must be a positive integer");
      const token = await mintInstallationToken(input.installationId);
      const repository = await resolveRepository(input.repositoryId, token);
      const query = "query GitGeckoLinkedIssues($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { closingIssuesReferences(first: 50) { nodes { number title bodyText url } pageInfo { hasNextPage } } } } }";
      const data = await graphQl(token, query, { owner: repository.owner, name: repository.name, number: input.pullNumber }, "pull-request linked issues");
      const repoValue = data.repository;
      const pullRequest = isRecord(repoValue) ? repoValue.pullRequest : undefined;
      const issues = isRecord(pullRequest) ? pullRequest.closingIssuesReferences : undefined;
      if (!isRecord(issues) || !Array.isArray(issues.nodes) || !isRecord(issues.pageInfo) || typeof issues.pageInfo.hasNextPage !== "boolean") {
        throw new Error("GitHub pull-request linked issues response is malformed");
      }
      if (issues.pageInfo.hasNextPage) throw new Error("GitHub pull-request linked issues exceed the supported pagination limit");
      return issues.nodes.map((issue) => {
        if (!isRecord(issue) || typeof issue.number !== "number" || !Number.isSafeInteger(issue.number) || issue.number < 1 || typeof issue.title !== "string" || typeof issue.bodyText !== "string" || typeof issue.url !== "string" || !issue.url) {
          throw new Error("GitHub pull-request linked issue response is malformed");
        }
        return { number: issue.number, title: issue.title, body: issue.bodyText, url: issue.url };
      });
    },
    postPullRequestComment: async (input) => {
      if (!Number.isSafeInteger(input.pullNumber) || input.pullNumber < 1) throw new Error("pullNumber must be a positive integer");
      if (!input.body.trim()) throw new Error("pull-request comment body is required");
      const token = await mintInstallationToken(input.installationId);
      const repository = await resolveRepository(input.repositoryId, token);
      const marker = actionMarker(input.idempotencyKey);
      const body = marker ? `${marker}\n${input.body}` : input.body;
      const headers = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      };
      const comments: unknown[] = [];
      for (let page = 1; page <= 10; page += 1) {
        const pageSuffix = page === 1 ? "" : `&page=${page}`;
        const commentsResponse = await fetchFn(
          `${apiBaseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/${input.pullNumber}/comments?per_page=100${pageSuffix}`,
          { method: "GET", headers },
        );
        if (!commentsResponse.ok) throw new Error(`GitHub pull-request comments request failed (${commentsResponse.status})`);
        let pageComments: unknown;
        try {
          pageComments = JSON.parse(await commentsResponse.text());
        } catch {
          throw new Error("GitHub pull-request comments response is malformed");
        }
        if (!Array.isArray(pageComments)) throw new Error("GitHub pull-request comments response is malformed");
        comments.push(...pageComments);
        if (pageComments.length < 100) break;
      }
      const existing = comments.find((comment): comment is Record<string, unknown> => (
        Boolean(comment) && typeof comment === "object" && !Array.isArray(comment)
        && typeof (comment as Record<string, unknown>).body === "string"
        && ((comment as Record<string, unknown>).body as string).includes(marker ?? "<!-- gitgecko-review -->")
        && Boolean((comment as Record<string, unknown>).performed_via_github_app)
        && typeof (comment as Record<string, unknown>).performed_via_github_app === "object"
        && String(((comment as Record<string, unknown>).performed_via_github_app as Record<string, unknown>).id ?? "") === appId
        && (typeof (comment as Record<string, unknown>).id === "number" || typeof (comment as Record<string, unknown>).id === "string")
      ));
      const endpoint = existing
        ? `${apiBaseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/comments/${encodeURIComponent(String(existing.id))}`
        : `${apiBaseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/${input.pullNumber}/comments`;
      const response = await fetchFn(
        endpoint,
        {
          method: existing ? "PATCH" : "POST",
          headers,
          body: JSON.stringify({ body: boundGitHubComment(body) }),
        },
      );
      if (!response.ok) throw new Error(`GitHub pull-request comment request failed (${response.status})`);
      const value = parseObject(await response.text(), "pull-request comment");
      if ((typeof value.id !== "number" && typeof value.id !== "string") || typeof value.html_url !== "string" || !value.html_url) {
        throw new Error("GitHub pull-request comment response is malformed");
      }
      return { id: String(value.id), url: value.html_url };
    },
    // GitHub batches line comments into one review, avoiding one request per finding.
    // GitHub REST `Create a review for a pull request` (2026-07-18) requires changed-file path, line, and RIGHT side.
    postPullRequestReview: async (input) => {
      if (!Number.isSafeInteger(input.pullNumber) || input.pullNumber < 1) throw new Error("pullNumber must be a positive integer");
      if (!input.body.trim()) throw new Error("pull-request review body is required");
      if (input.comments.length < 1 || input.comments.length > GITHUB_INLINE_REVIEW_MAX_COMMENTS) {
        throw new Error(`inline review must contain 1-${GITHUB_INLINE_REVIEW_MAX_COMMENTS} comments`);
      }
      input.comments.forEach(assertInlineReviewComment);
      const token = await mintInstallationToken(input.installationId);
      const repository = await resolveRepository(input.repositoryId, token);
      const marker = actionMarker(input.idempotencyKey);
      if (marker) {
        for (let page = 1; page <= 10; page += 1) {
          const response = await fetchFn(
            `${apiBaseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls/${input.pullNumber}/reviews?per_page=100&page=${page}`,
            {
              method: "GET",
              headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
                "X-GitHub-Api-Version": GITHUB_API_VERSION,
              },
            },
          );
          if (!response.ok) throw new Error(`GitHub pull-request reviews request failed (${response.status})`);
          let reviews: unknown;
          try {
            reviews = JSON.parse(await response.text()) as unknown;
          } catch {
            throw new Error("GitHub pull-request reviews response is malformed");
          }
          if (!Array.isArray(reviews)) throw new Error("GitHub pull-request reviews response is malformed");
          const existing = reviews.find((review): review is Record<string, unknown> => {
            if (!isRecord(review) || typeof review.body !== "string" || !review.body.includes(marker)) return false;
            const user = review.user;
            return isRecord(user) && user.type === "Bot"
              && (typeof review.id === "number" || typeof review.id === "string")
              && typeof review.html_url === "string" && Boolean(review.html_url);
          });
          if (existing) return { id: String(existing.id), url: String(existing.html_url) };
          if (reviews.length < 100) break;
        }
      }
      const response = await fetchFn(
        `${apiBaseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls/${input.pullNumber}/reviews`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
          },
          body: JSON.stringify({
            body: boundGitHubComment(marker ? `${marker}\n${input.body}` : input.body),
            event: "COMMENT",
            comments: input.comments.map((comment) => ({
              path: comment.file,
              line: comment.line,
              side: "RIGHT",
              body: boundGitHubComment(comment.body),
            })),
          }),
        },
      );
      if (!response.ok) throw new Error(`GitHub pull-request review request failed (${response.status})`);
      const value = parseObject(await response.text(), "pull-request review");
      if ((typeof value.id !== "number" && typeof value.id !== "string") || typeof value.html_url !== "string" || !value.html_url) {
        throw new Error("GitHub pull-request review response is malformed");
      }
      return { id: String(value.id), url: value.html_url };
    },
    // GitHub GraphQL resolveReviewThread (2026-07-18) resolves review threads,
    // so only markers authored by the current GitHub App viewer may be changed.
    resolveSupersededPullRequestReviewThreads: async (input) => {
      if (!Number.isSafeInteger(input.pullNumber) || input.pullNumber < 1) throw new Error("pullNumber must be a positive integer");
      const active = new Set(input.activeFindingFingerprints.filter((value) => typeof value === "string" && value.trim()));
      const token = await mintInstallationToken(input.installationId);
      const repository = await resolveRepository(input.repositoryId, token);
      const query = "query GitGeckoReviewThreads($owner: String!, $name: String!, $number: Int!) { viewer { login } repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { id isResolved comments(first: 100) { nodes { body author { login } } } } pageInfo { hasNextPage } } } } }";
      const data = await graphQl(token, query, { owner: repository.owner, name: repository.name, number: input.pullNumber }, "pull-request review threads");
      const viewer = data.viewer;
      const repositoryValue = data.repository;
      const pullRequest = isRecord(repositoryValue) ? repositoryValue.pullRequest : undefined;
      const reviewThreads = isRecord(pullRequest) ? pullRequest.reviewThreads : undefined;
      if (!isRecord(viewer) || typeof viewer.login !== "string" || !viewer.login || !isRecord(reviewThreads) || !Array.isArray(reviewThreads.nodes) || !isRecord(reviewThreads.pageInfo) || typeof reviewThreads.pageInfo.hasNextPage !== "boolean") {
        throw new Error("GitHub pull-request review threads response is malformed");
      }
      if (reviewThreads.pageInfo.hasNextPage) throw new Error("GitHub pull-request review threads exceed the supported pagination limit");
      const staleThreadIds: string[] = [];
      for (const thread of reviewThreads.nodes) {
        if (!isRecord(thread) || typeof thread.id !== "string" || !thread.id || thread.isResolved !== false || !isRecord(thread.comments) || !Array.isArray(thread.comments.nodes)) {
          throw new Error("GitHub pull-request review thread response is malformed");
        }
        const isStaleAppFinding = thread.comments.nodes.some((comment) => {
          if (!isRecord(comment) || typeof comment.body !== "string" || !isRecord(comment.author) || comment.author.login !== viewer.login) return false;
          const match = /<!--\s*gitgecko-finding:([^\s>]+)\s*-->/.exec(comment.body);
          return Boolean(match?.[1] && !active.has(match[1]));
        });
        if (isStaleAppFinding) staleThreadIds.push(thread.id);
      }
      const mutation = "mutation ResolveSupersededGitGeckoFinding($threadId: ID!) { resolveReviewThread(input: {threadId: $threadId}) { thread { id isResolved } } }";
      for (const threadId of staleThreadIds) {
        const resolved = await graphQl(token, mutation, { threadId }, "pull-request review thread resolution");
        const mutationResult = resolved.resolveReviewThread;
        const thread = isRecord(mutationResult) ? mutationResult.thread : undefined;
        if (!isRecord(thread) || thread.id !== threadId || thread.isResolved !== true) throw new Error("GitHub pull-request review thread resolution response is malformed");
      }
      return { resolved: staleThreadIds.length };
    },
    fetchRepositorySnapshot: async (input) => {
      const maxFiles = input.maxFiles ?? 2_000;
      const maxBytes = input.maxBytes ?? 20 * 1024 * 1024;
      if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 10_000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 100 * 1024 * 1024) {
        throw new Error("repository snapshot limits are invalid");
      }
      const token = await mintInstallationToken(input.installationId);
      const repository = await resolveRepository(input.repositoryId, token);
      const ref = input.ref ?? repository.defaultBranch ?? "HEAD";
      const tree = await fetchFn(`${apiBaseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { method: "GET", headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": GITHUB_API_VERSION } });
      if (!tree.ok) throw new Error(`GitHub repository tree request failed (${tree.status})`);
      const treePayload = parseObject(await tree.text(), "repository tree");
      if (treePayload.truncated === true) throw new Error("GitHub repository tree is truncated");
      const entries = treePayload.tree;
      if (!Array.isArray(entries)) throw new Error("GitHub repository tree response is malformed");
      const blobs = entries.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry) && entry.type === "blob" && typeof entry.path === "string" && typeof entry.sha === "string").slice(0, maxFiles);
      const files: { path: string; content: string; size: number }[] = [];
      let total = 0;
      for (const blob of blobs) {
        const response = await fetchFn(`${apiBaseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/blobs/${encodeURIComponent(blob.sha as string)}`, { method: "GET", headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": GITHUB_API_VERSION } });
        if (!response.ok) throw new Error(`GitHub repository blob request failed (${response.status})`);
        const value = parseObject(await response.text(), "repository blob");
        if (value.encoding !== "base64" || typeof value.content !== "string" || typeof value.size !== "number") throw new Error("GitHub repository blob response is malformed");
        const content = Buffer.from(value.content.replace(/\n/g, ""), "base64").toString("utf8");
        if (total + Buffer.byteLength(content) > maxBytes) break;
        total += Buffer.byteLength(content); files.push({ path: blob.path as string, content, size: value.size });
      }
      return { repository, ref, files };
    },
  };
};

/** Bind a configured source runtime through the repo-import socket. */
export const createGitHubAppRepoPlug = (config: GitHubAppSourceConfig) => {
  const source = createGitHubAppSource(config);
  return {
    manifest,
    setup(api: { register: (capability: RepoImportCapability, contribution: RepoImportContribution) => void }) {
      const verifier: InstallationVerifierContribution = {
        kind: "installation-verifier",
        id: "github-app-installation-verifier",
        verifyRepository: source.verifyRepository,
        mutates: false,
      };
      const repositoryCatalog: InstallationRepositoriesContribution = {
        kind: "installation-repositories",
        id: "github-app-installation-repositories",
        listInstallationRepositories: source.listInstallationRepositories,
        mutates: false,
      };
      const diffSource: PullRequestDiffContribution = {
        kind: "pull-request-diff",
        id: "github-app-pull-request-diff",
        fetchPullRequestDiff: source.fetchPullRequestDiff,
        mutates: false,
      };
      const linkedIssues: PullRequestLinkedIssuesContribution = {
        kind: "pull-request-linked-issues",
        id: "github-app-pull-request-linked-issues",
        fetchPullRequestLinkedIssues: source.fetchPullRequestLinkedIssues,
        mutates: false,
      };
      const snapshot: RepositorySnapshotContribution = { kind: "repository-snapshot", id: "github-app-repository-snapshot", fetchRepositorySnapshot: source.fetchRepositorySnapshot, mutates: false };
      api.register("installation-verify", verifier);
      api.register("installation-repositories", repositoryCatalog);
      api.register("pull-request-diff", diffSource);
      api.register("pull-request-linked-issues", linkedIssues);
      api.register("repository-snapshot", snapshot);
    },
  };
};

/** Resolve GitGecko GitHub App configuration from the canonical environment names. */
export const resolveGitHubAppEnvironment = (env: NodeJS.ProcessEnv): GitHubAppSourceConfig => {
  const apiBaseUrl = env.GITGECKO_GITHUB_API_BASE_URL?.trim();
  return {
    appId: env.GITGECKO_GITHUB_APP_ID?.trim() ?? "",
    privateKey: env.GITGECKO_GITHUB_APP_PRIVATE_KEY?.trim() ?? "",
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  };
};

/** Default plug entrypoint for static registry activation from deployment env. */
export function setup(api: { register: (capability: RepoImportCapability, contribution: RepoImportContribution) => void }): void {
  createGitHubAppRepoPlug(resolveGitHubAppEnvironment(process.env)).setup(api);
}
