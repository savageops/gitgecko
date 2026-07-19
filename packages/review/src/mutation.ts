import type { ReviewCheckReport } from "@gitgecko/sandbox";

export interface WorkspaceFileIdentity {
  readonly path: string;
  readonly kind: "file" | "symlink";
  readonly sha256: string;
}

export interface WorkspaceSnapshot {
  readonly files: readonly WorkspaceFileIdentity[];
}

export interface MutationFileChange {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted";
  readonly beforeSha256?: string;
  readonly afterSha256?: string;
}

export type MutationStatus = "no-change" | "applied-unverified" | "applied-verified" | "verification-failed";

export interface MutationReceipt {
  readonly schemaVersion: "mutation.v1";
  readonly status: MutationStatus;
  readonly changedFiles: readonly MutationFileChange[];
  readonly verification?: ReviewCheckReport;
}

/** Derive mutation evidence from trusted workspace snapshots, never provider prose. */
export const createMutationReceipt = (
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  verification?: ReviewCheckReport,
): MutationReceipt => {
  const prior = new Map(before.files.map((file) => [file.path, file]));
  const current = new Map(after.files.map((file) => [file.path, file]));
  const paths = [...new Set([...prior.keys(), ...current.keys()])].sort();
  const changedFiles = paths.flatMap((path): MutationFileChange[] => {
    const left = prior.get(path);
    const right = current.get(path);
    if (!left && right) return [{ path, status: "added", afterSha256: right.sha256 }];
    if (left && !right) return [{ path, status: "deleted", beforeSha256: left.sha256 }];
    if (left && right && (left.sha256 !== right.sha256 || left.kind !== right.kind)) {
      return [{ path, status: "modified", beforeSha256: left.sha256, afterSha256: right.sha256 }];
    }
    return [];
  });
  const status: MutationStatus = changedFiles.length === 0
    ? "no-change"
    : verification === undefined
      ? "applied-unverified"
      : verification.allRequiredPassed
        ? "applied-verified"
        : "verification-failed";
  return {
    schemaVersion: "mutation.v1",
    status,
    changedFiles,
    ...(verification ? { verification } : {}),
  };
};
