/**
 * Tenant-scoped multi-repository retrieval.
 *
 * Product mechanics were harvested from
 * `.docs/research/rips/greptile/23-product-cross-repo-context.md`; this owner
 * keeps only the transferable grouping and review-context consequence.
 */
import type { RetrieveContribution, RetrieveInput, RetrieveResult } from "./retrieve.js";

export const REPOSITORY_CONTEXT_MIN_PROJECTS = 2;
export const REPOSITORY_CONTEXT_MAX_PROJECTS = 20;
export const REPOSITORY_CONTEXT_DEFAULT_LIMIT = 10;
export const REPOSITORY_CONTEXT_MAX_LIMIT = 100;

export type RepositoryIndexStatus = "ready" | "empty" | "pending" | "indexing" | "failed";

export interface RepositoryContextGroup {
  readonly schemaVersion: "repository-context.v1";
  readonly id: string;
  readonly ownerId: string;
  readonly tenantId: string;
  readonly name: string;
  readonly projectIds: readonly string[];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AuthorizedRepositoryProject {
  readonly id: string;
  readonly ownerId: string;
  readonly tenantId: string;
  readonly indexStatus: RepositoryIndexStatus;
}

export interface RepositoryContextMember {
  readonly projectId: string;
  readonly role: "anchor" | "related";
  readonly indexStatus: RepositoryIndexStatus;
}

export interface RepositoryContextScope {
  readonly kind: "project" | "group";
  readonly anchorProjectId: string;
  readonly members: readonly RepositoryContextMember[];
  readonly groupId?: string;
  readonly groupRevision?: number;
}

export interface ScopedRetrieveResult extends RetrieveResult {
  readonly projectId: string;
  readonly role: "anchor" | "related";
}

export interface RepositoryContextReceipt {
  readonly scope: "project" | "group";
  readonly anchorProjectId: string;
  readonly includedProjectIds: readonly string[];
  readonly skippedProjects: readonly {
    readonly projectId: string;
    readonly reason: "empty" | "pending" | "indexing" | "failed";
  }[];
  readonly resultCount: number;
  readonly groupId?: string;
  readonly groupRevision?: number;
}

export interface ResolveRepositoryContextInput {
  readonly ownerId: string;
  readonly tenantId: string;
  readonly anchorProjectId: string;
  readonly projects: readonly AuthorizedRepositoryProject[];
  readonly groups: readonly RepositoryContextGroup[];
  readonly groupId?: string;
}

export interface RetrieveRepositoryContextInput {
  readonly scope: RepositoryContextScope;
  readonly query: string;
  readonly retrieval: RetrieveContribution;
  readonly pathPrefixForProject: (projectId: string) => string;
  readonly retrievalSourcesForProject?: (projectId: string) => Pick<RetrieveInput, "embeddings" | "lexical" | "graph">;
  readonly limit?: number;
}

export interface RetrieveRepositoryContextOutput {
  readonly results: readonly ScopedRetrieveResult[];
  readonly receipt: RepositoryContextReceipt;
}

const CANONICAL_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const INDEX_STATUSES: ReadonlySet<RepositoryIndexStatus> = new Set(["ready", "empty", "pending", "indexing", "failed"]);

const requireCanonicalId = (value: string, field: string): void => {
  if (!CANONICAL_ID.test(value)) throw new Error(`${field} must be a canonical lowercase identifier`);
};

const requireOwnerId = (value: string, field: string): void => {
  if (value.length < 1 || value.length > 200 || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} must be bounded opaque text`);
  }
};

const requireCanonicalName = (value: string): void => {
  if (value.length < 1 || value.length > 80 || value !== value.trim() || /\s{2,}|[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("repository context group name must be canonical text between 1 and 80 characters");
  }
};

const requireTimestamp = (value: string, field: string): void => {
  if (!ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`${field} must be an ISO UTC timestamp`);
};

/** Validate the durable group contract before state or retrieval code consumes it. */
export const validateRepositoryContextGroup = (group: RepositoryContextGroup): RepositoryContextGroup => {
  if (group.schemaVersion !== "repository-context.v1") throw new Error("unsupported repository context schema version");
  requireCanonicalId(group.id, "group id");
  requireOwnerId(group.ownerId, "owner id");
  requireOwnerId(group.tenantId, "tenant id");
  requireCanonicalName(group.name);
  if (!Number.isSafeInteger(group.revision) || group.revision < 1) throw new Error("group revision must be a positive integer");
  requireTimestamp(group.createdAt, "createdAt");
  requireTimestamp(group.updatedAt, "updatedAt");
  if (Date.parse(group.updatedAt) < Date.parse(group.createdAt)) throw new Error("updatedAt cannot precede createdAt");
  if (group.projectIds.length < REPOSITORY_CONTEXT_MIN_PROJECTS || group.projectIds.length > REPOSITORY_CONTEXT_MAX_PROJECTS) {
    throw new Error(`repository context groups require ${REPOSITORY_CONTEXT_MIN_PROJECTS}-${REPOSITORY_CONTEXT_MAX_PROJECTS} projects`);
  }
  const projectIds = new Set<string>();
  for (const projectId of group.projectIds) {
    requireCanonicalId(projectId, "project id");
    if (projectIds.has(projectId)) throw new Error("repository context group projects must be distinct");
    projectIds.add(projectId);
  }
  return group;
};

/** Resolve a project or group scope exclusively from server-authorized owner state. */
export const resolveRepositoryContextScope = (input: ResolveRepositoryContextInput): RepositoryContextScope => {
  requireOwnerId(input.ownerId, "owner id");
  requireOwnerId(input.tenantId, "tenant id");
  requireCanonicalId(input.anchorProjectId, "anchor project id");

  const projects = new Map<string, AuthorizedRepositoryProject>();
  for (const project of input.projects) {
    requireCanonicalId(project.id, "project id");
    requireOwnerId(project.ownerId, "project owner id");
    requireOwnerId(project.tenantId, "project tenant id");
    if (!INDEX_STATUSES.has(project.indexStatus)) throw new Error("authorized project has an invalid index status");
    if (projects.has(project.id)) throw new Error("authorized projects must be distinct");
    if (project.ownerId !== input.ownerId) throw new Error("authorized project owner does not match request owner");
    if (project.tenantId !== input.tenantId) throw new Error("authorized project tenant does not match request tenant");
    projects.set(project.id, project);
  }
  const anchor = projects.get(input.anchorProjectId);
  if (!anchor) throw new Error("anchor project is not authorized");

  if (!input.groupId) {
    return {
      kind: "project",
      anchorProjectId: anchor.id,
      members: [{ projectId: anchor.id, role: "anchor", indexStatus: anchor.indexStatus }],
    };
  }

  requireCanonicalId(input.groupId, "group id");
  const groups = new Map<string, RepositoryContextGroup>();
  for (const candidate of input.groups) {
    const group = validateRepositoryContextGroup(candidate);
    if (groups.has(group.id)) throw new Error("repository context groups must have distinct ids");
    groups.set(group.id, group);
  }
  const group = groups.get(input.groupId);
  if (!group || group.ownerId !== input.ownerId || group.tenantId !== input.tenantId) throw new Error("repository context group is not authorized");
  if (!group.projectIds.includes(anchor.id)) throw new Error("anchor project must belong to the repository context group");

  const orderedIds = [anchor.id, ...group.projectIds.filter((projectId) => projectId !== anchor.id)];
  const members = orderedIds.map((projectId, index): RepositoryContextMember => {
    const project = projects.get(projectId);
    if (!project) throw new Error(`repository context project is not authorized: ${projectId}`);
    return { projectId, role: index === 0 ? "anchor" : "related", indexStatus: project.indexStatus };
  });
  return {
    kind: "group",
    anchorProjectId: anchor.id,
    groupId: group.id,
    groupRevision: group.revision,
    members,
  };
};

const validateStoragePrefix = (prefix: string): void => {
  if (!prefix || prefix.length > 512 || prefix.includes("\\") || prefix.startsWith("/") || /^[A-Za-z]:\//.test(prefix)) {
    throw new Error("project retrieval prefix must be a bounded relative directory");
  }
  const segments = prefix.split("/");
  if (segments.at(-1) !== "" || segments.slice(0, -1).some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("project retrieval prefix must be a safe directory prefix");
  }
};

const publicFilepath = (filepath: string, prefix: string): string => {
  if (!filepath.startsWith(prefix)) throw new Error("retriever returned a result outside the authorized project prefix");
  const relative = filepath.slice(prefix.length);
  if (!relative || relative.startsWith("/") || relative.includes("\\") || relative.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("retriever returned an unsafe repository-relative filepath");
  }
  return relative;
};

/** Retrieve each ready repository once, then merge fairly without comparing source-specific scores. */
export const retrieveRepositoryContext = async (input: RetrieveRepositoryContextInput): Promise<RetrieveRepositoryContextOutput> => {
  const query = input.query.trim();
  if (!query || query.length > 4_000) throw new Error("repository context query must contain 1-4000 characters");
  const limit = input.limit ?? REPOSITORY_CONTEXT_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > REPOSITORY_CONTEXT_MAX_LIMIT) {
    throw new Error(`repository context limit must be an integer from 1-${REPOSITORY_CONTEXT_MAX_LIMIT}`);
  }
  if (input.scope.members.length < 1 || input.scope.members.length > REPOSITORY_CONTEXT_MAX_PROJECTS) {
    throw new Error(`repository context scope must contain 1-${REPOSITORY_CONTEXT_MAX_PROJECTS} members`);
  }
  if (input.scope.kind !== "project" && input.scope.kind !== "group") throw new Error("invalid repository context scope kind");
  requireCanonicalId(input.scope.anchorProjectId, "anchor project id");
  if (input.scope.kind === "project" && (input.scope.groupId !== undefined || input.scope.groupRevision !== undefined || input.scope.members.length !== 1)) {
    throw new Error("project repository context scope cannot carry group state");
  }
  if (input.scope.kind === "group" && (input.scope.groupId === undefined || input.scope.groupRevision === undefined)) {
    throw new Error("group repository context scope requires group identity and revision");
  }
  if (input.scope.kind === "group" && input.scope.members.length < REPOSITORY_CONTEXT_MIN_PROJECTS) {
    throw new Error(`repository context group scope must contain ${REPOSITORY_CONTEXT_MIN_PROJECTS}-${REPOSITORY_CONTEXT_MAX_PROJECTS} members`);
  }
  if (input.scope.groupId !== undefined) requireCanonicalId(input.scope.groupId, "scope group id");
  if (input.scope.groupRevision !== undefined && (!Number.isSafeInteger(input.scope.groupRevision) || input.scope.groupRevision < 1)) {
    throw new Error("scope group revision must be a positive integer");
  }
  if (input.scope.members[0]?.projectId !== input.scope.anchorProjectId || input.scope.members[0]?.role !== "anchor") {
    throw new Error("repository context scope must place the anchor first");
  }

  const seen = new Set<string>();
  for (const [index, member] of input.scope.members.entries()) {
    requireCanonicalId(member.projectId, "scope project id");
    if (seen.has(member.projectId)) throw new Error("repository context scope members must be distinct");
    seen.add(member.projectId);
    if ((index === 0 && member.role !== "anchor") || (index > 0 && member.role !== "related")) {
      throw new Error("repository context scope must have exactly one first-position anchor");
    }
    if (!INDEX_STATUSES.has(member.indexStatus)) throw new Error("repository context member has an invalid index status");
  }

  const ready: { member: RepositoryContextMember; prefix: string }[] = [];
  const storagePrefixes = new Set<string>();
  const skippedProjects: RepositoryContextReceipt["skippedProjects"][number][] = [];
  for (const member of input.scope.members) {
    if (member.indexStatus !== "ready") {
      skippedProjects.push({ projectId: member.projectId, reason: member.indexStatus });
      continue;
    }
    const prefix = input.pathPrefixForProject(member.projectId);
    validateStoragePrefix(prefix);
    if (storagePrefixes.has(prefix)) throw new Error("repository context projects must use a distinct storage prefix");
    storagePrefixes.add(prefix);
    ready.push({ member, prefix });
  }

  const buckets = await Promise.all(ready.map(async ({ member, prefix }) => {
    const sources = input.retrievalSourcesForProject?.(member.projectId) ?? {};
    const output = await input.retrieval.retrieve({ query, limit, pathPrefix: prefix, ...sources });
    return output.results.map((result): ScopedRetrieveResult => ({
      ...result,
      filepath: publicFilepath(result.filepath, prefix),
      projectId: member.projectId,
      role: member.role,
    }));
  }));

  const results: ScopedRetrieveResult[] = [];
  for (let rank = 0; results.length < limit; rank += 1) {
    let appended = false;
    for (const bucket of buckets) {
      const result = bucket[rank];
      if (!result) continue;
      results.push(result);
      appended = true;
      if (results.length === limit) break;
    }
    if (!appended) break;
  }

  const receipt: RepositoryContextReceipt = {
    scope: input.scope.kind,
    anchorProjectId: input.scope.anchorProjectId,
    includedProjectIds: ready.map(({ member }) => member.projectId),
    skippedProjects,
    resultCount: results.length,
    ...(input.scope.groupId === undefined ? {} : { groupId: input.scope.groupId }),
    ...(input.scope.groupRevision === undefined ? {} : { groupRevision: input.scope.groupRevision }),
  };
  return { results, receipt };
};
