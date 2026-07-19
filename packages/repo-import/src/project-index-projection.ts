import type { SqliteDocumentStore } from "@gitgecko/core";

export type ProjectIndexStatus = "pending" | "indexing" | "ready" | "empty" | "failed";

export interface IndexedProjectRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly indexStatus: ProjectIndexStatus;
  readonly indexError?: string;
  readonly indexCommitSha?: string;
}

export interface ProjectSourceRecord {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly filepath: string;
  readonly source: string;
  readonly indexedAt: string;
}

export interface ReplaceProjectIndexInput {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly documents: readonly ProjectSourceRecord[];
  readonly status?: Extract<ProjectIndexStatus, "indexing" | "ready" | "empty">;
  readonly indexCommitSha?: string;
}

/** Key one source document by its complete tenant boundary. */
export const projectSourceRecordKey = (tenantId: string, projectId: string, filepath: string): string =>
  `${encodeURIComponent(tenantId)}:${encodeURIComponent(projectId)}:${encodeURIComponent(filepath)}`;

/** Replace one tenant-owned source projection and project state atomically. */
export const replaceProjectIndexProjection = <TProject extends IndexedProjectRecord = IndexedProjectRecord>(
  store: Pick<SqliteDocumentStore, "get" | "list" | "set" | "delete" | "transaction">,
  input: ReplaceProjectIndexInput,
): TProject => {
  const project = store.get<TProject>("projects", input.projectId);
  if (!project || project.tenantId !== input.tenantId || project.ownerId !== input.ownerId) throw new Error("index projection project does not belong to the tenant");
  if (input.documents.some((document) => document.tenantId !== input.tenantId || document.ownerId !== input.ownerId || document.projectId !== input.projectId)) {
    throw new Error("index projection document does not belong to the tenant project");
  }
  if (new Set(input.documents.map((document) => document.filepath)).size !== input.documents.length) {
    throw new Error("index projection contains duplicate filepaths");
  }
  const prior = store.list<Omit<ProjectSourceRecord, "tenantId"> & { readonly tenantId?: string }>("project-sources")
    .filter((document) => document.projectId === input.projectId
      && (document.tenantId === input.tenantId || (document.tenantId === undefined && document.ownerId === input.ownerId)));
  const { indexError: _indexError, ...projectWithoutError } = project;
  const updated = {
    ...projectWithoutError,
    indexStatus: input.status ?? (input.documents.length === 0 ? "empty" : "ready"),
    ...(input.indexCommitSha && { indexCommitSha: input.indexCommitSha }),
  } as TProject;
  store.transaction(() => {
    for (const document of prior) {
      if (document.tenantId) store.delete("project-sources", projectSourceRecordKey(document.tenantId, document.projectId, document.filepath));
      if (!document.tenantId) store.delete("project-sources", projectSourceRecordKey(document.ownerId, document.projectId, document.filepath));
      // Remove v1 keys while replacing a project so upgrades cannot retain stale duplicates.
      store.delete("project-sources", `${document.projectId}:${document.filepath}`);
    }
    for (const document of input.documents) {
      store.set("project-sources", projectSourceRecordKey(document.tenantId, document.projectId, document.filepath), document);
    }
    store.set("projects", project.id, updated);
  });
  return updated;
};

/** Transition one tenant-owned project after a staged projection is fenced. */
export const transitionProjectIndexProjection = (
  store: Pick<SqliteDocumentStore, "get" | "set">,
  input: { readonly tenantId: string; readonly ownerId: string; readonly projectId: string; readonly status: ProjectIndexStatus; readonly indexCommitSha?: string },
): IndexedProjectRecord => {
  const project = store.get<IndexedProjectRecord>("projects", input.projectId);
  if (!project || project.tenantId !== input.tenantId || project.ownerId !== input.ownerId) throw new Error("index projection project does not belong to the tenant");
  const { indexError: _indexError, ...projectWithoutError } = project;
  const updated = { ...projectWithoutError, indexStatus: input.status, ...(input.indexCommitSha && { indexCommitSha: input.indexCommitSha }) };
  store.set("projects", project.id, updated);
  return updated;
};
