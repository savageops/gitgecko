import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Chunk } from "./chunk.js";
import {
  REPOSITORY_CONTEXT_MAX_LIMIT,
  resolveRepositoryContextScope,
  retrieveRepositoryContext,
  validateRepositoryContextGroup,
  type AuthorizedRepositoryProject,
  type RepositoryContextGroup,
  type RepositoryContextScope,
} from "./repository-context.js";
import type { RetrieveContribution, RetrieveOutput, RetrieveResult } from "./retrieve.js";

const NOW = "2026-07-18T00:00:00.000Z";
const project = (id: string, ownerId = "owner-a", indexStatus: AuthorizedRepositoryProject["indexStatus"] = "ready", tenantId = "tenant-a"): AuthorizedRepositoryProject => ({ id, ownerId, tenantId, indexStatus });
const group = (overrides: Partial<RepositoryContextGroup> = {}): RepositoryContextGroup => ({
  schemaVersion: "repository-context.v1",
  id: "platform",
  ownerId: "owner-a",
  tenantId: "tenant-a",
  name: "Platform",
  projectIds: ["api", "web"],
  revision: 1,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});
type ResolveOverrides = Partial<Omit<Parameters<typeof resolveRepositoryContextScope>[0], "groupId">> & { readonly groupId?: string | undefined };
const resolve = (overrides: ResolveOverrides = {}): RepositoryContextScope => {
  const groupId = overrides.groupId === undefined && Object.prototype.hasOwnProperty.call(overrides, "groupId") ? undefined : (overrides.groupId ?? "platform");
  return resolveRepositoryContextScope({
    ownerId: overrides.ownerId ?? "owner-a",
    tenantId: overrides.tenantId ?? "tenant-a",
    anchorProjectId: overrides.anchorProjectId ?? "api",
    projects: overrides.projects ?? [project("api"), project("web")],
    groups: overrides.groups ?? [group()],
    ...(groupId === undefined ? {} : { groupId }),
  });
};
const chunk = (content: string): Chunk => ({ content, startLine: 0, endLine: 0 });
const result = (filepath: string, content = filepath, score = 1): RetrieveResult => ({ chunk: chunk(content), filepath, source: "lexical", score });
const retriever = (responses: Readonly<Record<string, readonly RetrieveResult[]>>, calls: { prefix?: string; limit?: number; query?: string }[] = []): RetrieveContribution => ({
  kind: "retriever",
  id: "test",
  retrieve: async (input): Promise<RetrieveOutput> => {
    calls.push({ ...(input.pathPrefix === undefined ? {} : { prefix: input.pathPrefix }), ...(input.limit === undefined ? {} : { limit: input.limit }), query: input.query });
    return { results: responses[input.pathPrefix ?? ""] ?? [], sources: { embeddings: 0, lexical: 0, graph: 0 } };
  },
});
const retrieve = (scope: RepositoryContextScope, contribution: RetrieveContribution, overrides: Partial<Parameters<typeof retrieveRepositoryContext>[0]> = {}) => retrieveRepositoryContext({
  scope,
  query: "authentication",
  retrieval: contribution,
  pathPrefixForProject: (projectId) => `owner-a/${projectId}/`,
  ...overrides,
});

describe("repository context group validation", () => {
  it("accepts a canonical two-project group", () => assert.equal(validateRepositoryContextGroup(group()).id, "platform"));
  it("accepts the twenty-project boundary", () => assert.equal(validateRepositoryContextGroup(group({ projectIds: Array.from({ length: 20 }, (_, index) => `p${index}`) })).projectIds.length, 20));
  it("rejects an unsupported schema version", () => assert.throws(() => validateRepositoryContextGroup(group({ schemaVersion: "v2" as "repository-context.v1" })), /schema version/));
  it("rejects fewer than two projects", () => assert.throws(() => validateRepositoryContextGroup(group({ projectIds: ["api"] })), /2-20/));
  it("rejects more than twenty projects", () => assert.throws(() => validateRepositoryContextGroup(group({ projectIds: Array.from({ length: 21 }, (_, index) => `p${index}`) })), /2-20/));
  it("rejects duplicate projects", () => assert.throws(() => validateRepositoryContextGroup(group({ projectIds: ["api", "api"] })), /distinct/));
  it("rejects a noncanonical group id", () => assert.throws(() => validateRepositoryContextGroup(group({ id: "Platform Group" })), /group id/));
  it("accepts an opaque provider-qualified owner id", () => assert.equal(validateRepositoryContextGroup(group({ ownerId: "GitHub|User:42" })).ownerId, "GitHub|User:42"));
  it("rejects a blank owner id", () => assert.throws(() => validateRepositoryContextGroup(group({ ownerId: " " })), /owner id/));
  it("rejects a blank tenant id", () => assert.throws(() => validateRepositoryContextGroup(group({ tenantId: " " })), /tenant id/));
  it("rejects control characters in an owner id", () => assert.throws(() => validateRepositoryContextGroup(group({ ownerId: "owner\nother" })), /owner id/));
  it("rejects a noncanonical project id", () => assert.throws(() => validateRepositoryContextGroup(group({ projectIds: ["api", "Web App"] })), /project id/));
  it("rejects a blank name", () => assert.throws(() => validateRepositoryContextGroup(group({ name: "" })), /name/));
  it("rejects surrounding whitespace in a name", () => assert.throws(() => validateRepositoryContextGroup(group({ name: " Platform" })), /name/));
  it("rejects repeated whitespace in a name", () => assert.throws(() => validateRepositoryContextGroup(group({ name: "Core  Platform" })), /name/));
  it("rejects an overlong name", () => assert.throws(() => validateRepositoryContextGroup(group({ name: "x".repeat(81) })), /name/));
  it("rejects a nonpositive revision", () => assert.throws(() => validateRepositoryContextGroup(group({ revision: 0 })), /revision/));
  it("rejects a fractional revision", () => assert.throws(() => validateRepositoryContextGroup(group({ revision: 1.5 })), /revision/));
  it("rejects malformed timestamps", () => assert.throws(() => validateRepositoryContextGroup(group({ createdAt: "today" })), /createdAt/));
  it("rejects updatedAt before createdAt", () => assert.throws(() => validateRepositoryContextGroup(group({ createdAt: "2026-07-19T00:00:00.000Z" })), /precede/));
});

describe("repository context scope resolution", () => {
  it("resolves a project-only scope without a group", () => assert.deepEqual(resolve({ groupId: undefined, groups: [] }), { kind: "project", anchorProjectId: "api", members: [{ projectId: "api", role: "anchor", indexStatus: "ready" }] }));
  it("resolves a group from any member", () => assert.equal(resolve({ anchorProjectId: "web" }).anchorProjectId, "web"));
  it("orders the anchor first regardless of stored order", () => assert.deepEqual(resolve({ anchorProjectId: "web" }).members.map(({ projectId }) => projectId), ["web", "api"]));
  it("preserves group identity and revision", () => assert.deepEqual({ id: resolve().groupId, revision: resolve().groupRevision }, { id: "platform", revision: 1 }));
  it("rejects an unknown anchor", () => assert.throws(() => resolve({ anchorProjectId: "missing" }), /anchor project is not authorized/));
  it("rejects a foreign project in authorized state", () => assert.throws(() => resolve({ projects: [project("api"), project("web", "owner-b")] }), /owner/));
  it("rejects a foreign-tenant project in authorized state", () => assert.throws(() => resolve({ projects: [project("api"), project("web", "owner-a", "ready", "tenant-b")] }), /tenant/));
  it("resolves an opaque provider-qualified request owner", () => assert.equal(resolve({ ownerId: "GitHub|User:42", projects: [project("api", "GitHub|User:42"), project("web", "GitHub|User:42")], groups: [group({ ownerId: "GitHub|User:42" })] }).kind, "group"));
  it("rejects duplicate authorized project ids", () => assert.throws(() => resolve({ projects: [project("api"), project("api")] }), /distinct/));
  it("rejects an invalid persisted project index state", () => assert.throws(() => resolve({ projects: [project("api", "owner-a", "stale" as AuthorizedRepositoryProject["indexStatus"]), project("web")] }), /index status/));
  it("rejects an unknown group", () => assert.throws(() => resolve({ groupId: "missing" }), /group is not authorized/));
  it("rejects a foreign-owner group", () => assert.throws(() => resolve({ groups: [group({ ownerId: "owner-b" })] }), /group is not authorized/));
  it("rejects a foreign-tenant group", () => assert.throws(() => resolve({ groups: [group({ tenantId: "tenant-b" })] }), /group is not authorized/));
  it("rejects an anchor outside the group", () => assert.throws(() => resolve({ projects: [project("api"), project("web"), project("docs")], groups: [group({ projectIds: ["web", "docs"] })] }), /anchor project must belong/));
  it("rejects a group member absent from authorized projects", () => assert.throws(() => resolve({ projects: [project("api")] }), /not authorized: web/));
  it("rejects duplicate group ids", () => assert.throws(() => resolve({ groups: [group(), group()] }), /distinct ids/));
  it("preserves member index states", () => assert.equal(resolve({ projects: [project("api"), project("web", "owner-a", "indexing")] }).members[1]?.indexStatus, "indexing"));
});

describe("repository context retrieval", () => {
  it("calls retrieval once per ready member", async () => {
    const calls: { prefix?: string }[] = [];
    await retrieve(resolve(), retriever({}, calls));
    assert.deepEqual(calls.map(({ prefix }) => prefix), ["owner-a/api/", "owner-a/web/"]);
  });
  it("passes the same bounded query and limit to every member", async () => {
    const calls: { query?: string; limit?: number }[] = [];
    await retrieve(resolve(), retriever({}, calls), { query: "  auth  ", limit: 7 });
    assert.deepEqual(calls, [{ prefix: "owner-a/api/", query: "auth", limit: 7 }, { prefix: "owner-a/web/", query: "auth", limit: 7 }]);
  });
  it("forwards project-specific retrieval sources to the fusion owner", async () => {
    const lexical = { search: async () => [] };
    const calls: { lexical: unknown | undefined; prefix: string | undefined }[] = [];
    const contribution: RetrieveContribution = {
      kind: "retriever",
      id: "sources",
      retrieve: async (input) => {
        calls.push({ lexical: input.lexical, prefix: input.pathPrefix });
        return { results: [], sources: { embeddings: 0, lexical: 0, graph: 0 } };
      },
    };
    await retrieve(resolve(), contribution, { retrievalSourcesForProject: () => ({ lexical }) });
    assert.deepEqual(calls, [
      { lexical, prefix: "owner-a/api/" },
      { lexical, prefix: "owner-a/web/" },
    ]);
  });
  it("returns project provenance and strips storage prefixes", async () => {
    const output = await retrieve(resolve(), retriever({ "owner-a/api/": [result("owner-a/api/src/auth.ts")] }));
    assert.deepEqual(output.results.map(({ projectId, role, filepath }) => ({ projectId, role, filepath })), [{ projectId: "api", role: "anchor", filepath: "src/auth.ts" }]);
  });
  it("round-robins anchor first across repositories", async () => {
    const output = await retrieve(resolve(), retriever({
      "owner-a/api/": [result("owner-a/api/a1.ts"), result("owner-a/api/a2.ts")],
      "owner-a/web/": [result("owner-a/web/w1.ts"), result("owner-a/web/w2.ts")],
    }));
    assert.deepEqual(output.results.map(({ projectId, filepath }) => `${projectId}:${filepath}`), ["api:a1.ts", "web:w1.ts", "api:a2.ts", "web:w2.ts"]);
  });
  it("enforces one global result limit", async () => {
    const output = await retrieve(resolve(), retriever({ "owner-a/api/": [result("owner-a/api/a1"), result("owner-a/api/a2")], "owner-a/web/": [result("owner-a/web/w1"), result("owner-a/web/w2")] }), { limit: 3 });
    assert.deepEqual(output.results.map(({ filepath }) => filepath), ["a1", "w1", "a2"]);
  });
  it("prevents a large repository from monopolizing results", async () => {
    const output = await retrieve(resolve(), retriever({ "owner-a/api/": Array.from({ length: 10 }, (_, index) => result(`owner-a/api/a${index}`)), "owner-a/web/": [result("owner-a/web/w0")] }), { limit: 2 });
    assert.deepEqual(output.results.map(({ projectId }) => projectId), ["api", "web"]);
  });
  it("preserves anchor results under truncation", async () => {
    const output = await retrieve(resolve(), retriever({ "owner-a/api/": [result("owner-a/api/a")], "owner-a/web/": [result("owner-a/web/w")] }), { limit: 1 });
    assert.equal(output.results[0]?.projectId, "api");
  });
  it("skips empty projects explicitly", async () => {
    const output = await retrieve(resolve({ projects: [project("api"), project("web", "owner-a", "empty")] }), retriever({}));
    assert.deepEqual(output.receipt.skippedProjects, [{ projectId: "web", reason: "empty" }]);
  });
  it("skips pending projects explicitly", async () => {
    const output = await retrieve(resolve({ projects: [project("api"), project("web", "owner-a", "pending")] }), retriever({}));
    assert.deepEqual(output.receipt.skippedProjects, [{ projectId: "web", reason: "pending" }]);
  });
  it("skips indexing projects explicitly", async () => {
    const output = await retrieve(resolve({ projects: [project("api"), project("web", "owner-a", "indexing")] }), retriever({}));
    assert.deepEqual(output.receipt.skippedProjects, [{ projectId: "web", reason: "indexing" }]);
  });
  it("skips failed projects explicitly", async () => {
    const output = await retrieve(resolve({ projects: [project("api"), project("web", "owner-a", "failed")] }), retriever({}));
    assert.deepEqual(output.receipt.skippedProjects, [{ projectId: "web", reason: "failed" }]);
  });
  it("does not call prefix or retriever for skipped members", async () => {
    let prefixes = 0;
    const calls: { prefix?: string }[] = [];
    await retrieve(resolve({ projects: [project("api", "owner-a", "pending"), project("web", "owner-a", "failed")] }), retriever({}, calls), { pathPrefixForProject: () => { prefixes += 1; return "unused/"; } });
    assert.deepEqual({ prefixes, calls: calls.length }, { prefixes: 0, calls: 0 });
  });
  it("records included projects and result count", async () => {
    const output = await retrieve(resolve(), retriever({ "owner-a/api/": [result("owner-a/api/a")], "owner-a/web/": [result("owner-a/web/w")] }));
    assert.deepEqual({ included: output.receipt.includedProjectIds, count: output.receipt.resultCount }, { included: ["api", "web"], count: 2 });
  });
  it("records group scope and revision without owner data", async () => {
    const receipt = (await retrieve(resolve(), retriever({}))).receipt;
    assert.deepEqual(receipt, { scope: "group", anchorProjectId: "api", groupId: "platform", groupRevision: 1, includedProjectIds: ["api", "web"], skippedProjects: [], resultCount: 0 });
    assert.equal("ownerId" in receipt, false);
  });
  it("records a project-only receipt without group fields", async () => {
    const receipt = (await retrieve(resolve({ groupId: undefined, groups: [] }), retriever({}))).receipt;
    assert.deepEqual(receipt, { scope: "project", anchorProjectId: "api", includedProjectIds: ["api"], skippedProjects: [], resultCount: 0 });
  });
  it("rejects an empty query before retrieval", async () => assert.rejects(retrieve(resolve(), retriever({}), { query: "  " }), /query/));
  it("rejects an overlong query", async () => assert.rejects(retrieve(resolve(), retriever({}), { query: "x".repeat(4_001) }), /query/));
  it("rejects a zero limit", async () => assert.rejects(retrieve(resolve(), retriever({}), { limit: 0 }), /limit/));
  it("rejects a limit above the maximum", async () => assert.rejects(retrieve(resolve(), retriever({}), { limit: REPOSITORY_CONTEXT_MAX_LIMIT + 1 }), /limit/));
  it("rejects a fractional limit", async () => assert.rejects(retrieve(resolve(), retriever({}), { limit: 1.5 }), /limit/));
  it("rejects duplicate scope members before retrieval", async () => assert.rejects(retrieve({ ...resolve(), members: [resolve().members[0]!, resolve().members[0]!] }, retriever({})), /distinct/));
  it("rejects a scope whose anchor is not first", async () => assert.rejects(retrieve({ ...resolve(), members: [...resolve().members].reverse() }, retriever({})), /anchor first/));
  it("rejects an unknown runtime scope kind", async () => assert.rejects(retrieve({ ...resolve(), kind: "workspace" as RepositoryContextScope["kind"] }, retriever({})), /scope kind/));
  it("rejects a group scope with fewer than two members", async () => assert.rejects(retrieve({ ...resolve(), members: [resolve().members[0]!] }, retriever({})), /group scope must contain 2-20/));
  it("rejects a noncanonical runtime anchor id", async () => assert.rejects(retrieve({ ...resolve(), anchorProjectId: "API" }, retriever({})), /anchor project id/));
  it("rejects unsafe storage prefixes", async () => assert.rejects(retrieve(resolve({ groupId: undefined, groups: [] }), retriever({}), { pathPrefixForProject: () => "../tenant/" }), /safe directory prefix/));
  it("rejects shared storage prefixes across distinct projects", async () => assert.rejects(retrieve(resolve(), retriever({}), { pathPrefixForProject: () => "owner-a/shared/" }), /distinct storage prefix/));
  it("rejects results outside the authorized prefix", async () => assert.rejects(retrieve(resolve({ groupId: undefined, groups: [] }), retriever({ "owner-a/api/": [result("owner-b/api/secret.ts")] })), /outside/));
  it("rejects traversal in returned filepaths", async () => assert.rejects(retrieve(resolve({ groupId: undefined, groups: [] }), retriever({ "owner-a/api/": [result("owner-a/api/src/../secret.ts")] })), /unsafe/));
  it("propagates retrieval failure instead of reporting a skip", async () => {
    const contribution: RetrieveContribution = { kind: "retriever", id: "broken", retrieve: async () => { throw new Error("backend unavailable"); } };
    await assert.rejects(retrieve(resolve(), contribution), /backend unavailable/);
  });
});
