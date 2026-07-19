import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { WorkspaceFileIdentity, WorkspaceSnapshot } from "@gitgecko/review";

const FALLBACK_IGNORES = new Set([".git", "node_modules"]);

/** Enumerate Git-owned and untracked customer files without traversing dependency stores. */
const listWorkspaceFiles = (cwd: string): readonly string[] => {
  try {
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    }).split("\0").filter(Boolean);
  } catch {
    const files: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && FALLBACK_IGNORES.has(entry.name)) continue;
        const absolute = resolve(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else files.push(relative(cwd, absolute).replace(/\\/gu, "/"));
      }
    };
    visit(cwd);
    return files;
  }
};

/** Capture immutable file identities so dirty baselines and no-op providers remain distinguishable. */
export const captureWorkspaceSnapshot = async (cwd: string): Promise<WorkspaceSnapshot> => {
  const files = listWorkspaceFiles(cwd).flatMap((path): WorkspaceFileIdentity[] => {
    const absolute = resolve(cwd, path);
    let stat;
    try { stat = lstatSync(absolute); } catch { return []; }
    if (!stat.isFile() && !stat.isSymbolicLink()) return [];
    const kind = stat.isSymbolicLink() ? "symlink" as const : "file" as const;
    const bytes = kind === "symlink" ? Buffer.from(readlinkSync(absolute), "utf8") : readFileSync(absolute);
    return [{ path, kind, sha256: createHash("sha256").update(bytes).digest("hex") }];
  });
  return { files: files.sort((left, right) => left.path.localeCompare(right.path)) };
};
