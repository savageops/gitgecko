/**
 * @gitgecko/repo-import — clone/mirror repos + HEAD freshness (02 §2).
 *
 * Salvages pr-agent's _GIT_PROVIDERS pattern (P-plugin-5, .refs/01-pr-review/
 * pr-agent-main/pr_agent/git_providers/__init__.py): string→class registry,
 * factory by provider id. gitgecko adapts: RepoImportSocket { import, sync }.
 *
 * Multi-VCS: github, gitlab, bitbucket, azure-devops, local-git (plugs).
 * The repo handle: list files, read file, get diff between refs. This is
 * what the indexing pipeline (parse → graph → chunk → embed) consumes.
 */
import type { Contribution, OwnerSpec } from "@gitgecko/socket";

/** VCS provider id (which git host). */
export type VcsProvider = "github" | "gitlab" | "bitbucket" | "azure-devops" | "local";

/** A repo to import. */
export interface RepoSpec {
  readonly provider: VcsProvider;
  readonly owner: string;
  readonly name: string;
  readonly branch?: string;
  /** For private repos: an installation/installation token. */
  readonly token?: string;
}

/** A file in a repo. */
export interface RepoFile {
  readonly path: string;
  readonly content: string;
  readonly size: number;
}

/** A changed file in a diff. */
export interface DiffEntry {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted";
  readonly additions: number;
  readonly deletions: number;
  readonly patch?: string;
}

/** An installation-scoped repository identity resolved by a VCS source plug. */
export interface RepositoryIdentity {
  readonly repositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch?: string;
  /** Immutable default-branch head resolved by an installation-authorized source. */
  readonly headSha?: string;
}

/** Proves that the active installation can access the requested repository. */
export interface InstallationRepositoryInput {
  readonly installationId: string;
  readonly repositoryId: string;
}

export interface InstallationRepositoriesInput {
  readonly installationId: string;
}

/** A pull request is addressed through the already-authorized repository. */
export interface PullRequestDiffInput extends InstallationRepositoryInput {
  readonly pullNumber: number;
}

/** A bounded installation-scoped source snapshot for the batch indexer. */
export interface RepositorySnapshotInput extends InstallationRepositoryInput {
  readonly ref?: string;
  readonly maxFiles?: number;
  readonly maxBytes?: number;
}

/** Installation-authority capability for a repository provider plug. */
export interface InstallationVerifierContribution extends Contribution {
  readonly kind: "installation-verifier";
  readonly id: string;
  readonly verifyRepository: (input: InstallationRepositoryInput) => Promise<RepositoryIdentity>;
}

export interface InstallationRepositoriesContribution extends Contribution {
  readonly kind: "installation-repositories";
  readonly id: string;
  readonly listInstallationRepositories: (input: InstallationRepositoriesInput) => Promise<readonly RepositoryIdentity[]>;
}

/** Pull-request source capability for a repository provider plug. */
export interface PullRequestDiffContribution extends Contribution {
  readonly kind: "pull-request-diff";
  readonly id: string;
  readonly fetchPullRequestDiff: (input: PullRequestDiffInput) => Promise<{
    readonly repository: RepositoryIdentity;
    readonly diff: string;
  }>;
}
export interface PullRequestLinkedIssuesContribution extends Contribution {
  readonly kind: "pull-request-linked-issues";
  readonly id: string;
  readonly fetchPullRequestLinkedIssues: (input: PullRequestDiffInput) => Promise<readonly { readonly number: number; readonly title: string; readonly body: string; readonly url: string }[]>;
}

export interface RepositorySnapshotContribution extends Contribution {
  readonly kind: "repository-snapshot";
  readonly id: string;
  readonly fetchRepositorySnapshot: (input: RepositorySnapshotInput) => Promise<{
    readonly repository: RepositoryIdentity;
    readonly ref: string;
    readonly files: readonly RepoFile[];
  }>;
}

/** A handle to an imported repo — the read surface the indexer consumes. */
export interface RepoHandle {
  readonly spec: RepoSpec;
  readonly headSha: string;
  readonly branch: string;
  /** List all files (optionally filtered by glob). */
  readonly listFiles: (glob?: string) => readonly RepoFile[];
  /** Read a single file. */
  readonly readFile: (path: string) => RepoFile | null;
  /** Get the diff between two refs (e.g. base...head). */
  readonly getDiff: (base: string, head: string) => readonly DiffEntry[];
}

/** The repo-import owner's capabilities. */
export type RepoImportCapability = "import" | "installation-verify" | "installation-repositories" | "pull-request-diff" | "pull-request-linked-issues" | "repository-snapshot";

/** Contribution: a VCS provider plug (github, gitlab, etc.). */
export interface RepoImporterContribution extends Contribution {
  readonly kind: "repo-importer";
  readonly id: string;
  readonly provider: VcsProvider;
  /** Import (clone/mirror) a repo → handle. */
  readonly importRepo: (spec: RepoSpec) => Promise<RepoHandle>;
  /** Sync (pull/fetch) an already-imported repo → fresh handle. */
  readonly syncRepo: (handle: RepoHandle) => Promise<RepoHandle>;
  readonly mutates?: boolean;
}

/** A typed provider contribution. Source-only plugs need not claim clone/sync. */
export type RepoImportContribution = RepoImporterContribution | InstallationVerifierContribution | InstallationRepositoriesContribution | PullRequestDiffContribution | PullRequestLinkedIssuesContribution | RepositorySnapshotContribution;

export const repoImportOwner: OwnerSpec<RepoImportCapability, string> = {
  name: "repo-import",
  capabilities: ["import", "installation-verify", "installation-repositories", "pull-request-diff", "pull-request-linked-issues", "repository-snapshot"],
  // NON-exclusive: multiple VCS providers coexist (github + gitlab + local).
  exclusive: () => false,
  kindFor: (capability) => {
    if (capability === "import") return "repo-importer";
    if (capability === "installation-verify") return "installation-verifier";
    if (capability === "installation-repositories") return "installation-repositories";
    if (capability === "pull-request-diff") return "pull-request-diff";
    return capability === "pull-request-linked-issues" ? "pull-request-linked-issues" : "repository-snapshot";
  },
};

// --- In-memory repo (for tests) ---------------------------------------------

/**
 * An in-memory repo handle — holds a file map. Tests construct it directly;
 * production uses the real VCS provider plugs (octokit, gitlab4j, etc.).
 */
export class InMemoryRepoHandle implements RepoHandle {
  readonly spec: RepoSpec;
  readonly headSha: string;
  readonly branch: string;
  private readonly files: Map<string, RepoFile>;

  constructor(spec: RepoSpec, files: readonly RepoFile[], headSha = "abc123", branch?: string) {
    this.spec = spec;
    this.headSha = headSha;
    this.branch = branch ?? spec.branch ?? "main";
    this.files = new Map(files.map((f) => [f.path, f]));
  }

  listFiles(glob?: string): readonly RepoFile[] {
    const all = [...this.files.values()];
    if (!glob) return all;
    // Simple glob: convert src/** to a prefix check
    const prefix = glob.replace(/\/\*\*$/, "/");
    if (prefix !== glob) return all.filter((f) => f.path.startsWith(prefix));
    return all.filter((f) => f.path === glob);
  }

  readFile(path: string): RepoFile | null {
    return this.files.get(path) ?? null;
  }

  getDiff(base: string, head: string): readonly DiffEntry[] {
    void base; void head;
    return []; // v1: in-memory diff is empty (no git history)
  }
}

/** Convenience: build a repo spec for GitHub. */
export const githubRepo = (owner: string, name: string, branch?: string): RepoSpec => ({
  provider: "github",
  owner,
  name,
  ...(branch && { branch }),
});
