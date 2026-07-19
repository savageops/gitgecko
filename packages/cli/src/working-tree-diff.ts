import { spawnSync } from "node:child_process";

const WORKING_TREE_DIFF_MAX_BYTES = 64 * 1024 * 1024;

/** Collects staged and unstaged tracked changes without leaking Git diagnostics into CLI output. */
export function readWorkingTreeDiff(cwd: string = process.cwd()): string {
  const result = spawnSync(
    "git",
    ["-c", "core.safecrlf=false", "diff", "HEAD", "--no-ext-diff", "--unified=40", "--"],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: WORKING_TREE_DIFF_MAX_BYTES,
      windowsHide: true,
    },
  );

  if (result.error) {
    const error = result.error as NodeJS.ErrnoException;
    if (error.code === "ENOBUFS") {
      throw new Error(
        `Tracked changes exceed ${WORKING_TREE_DIFF_MAX_BYTES / 1024 / 1024} MB. Narrow the review with --file or provide a bounded --diff-file.`,
      );
    }
    throw new Error(`Could not run Git: ${error.message}`);
  }

  if (result.status !== 0) {
    const diagnostic = result.stderr.trim().split(/\r?\n/u).find(Boolean) ?? `git exited with status ${result.status ?? "unknown"}`;
    throw new Error(`Could not read tracked changes: ${diagnostic}`);
  }

  return result.stdout;
}
