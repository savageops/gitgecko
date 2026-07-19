export type ReviewFileStatus = "added" | "modified" | "deleted" | "renamed";

/** A file-level change preserved from a unified diff, including non-text changes. */
export interface ReviewFileChange {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: ReviewFileStatus;
  readonly binary: boolean;
  readonly addedSource: string;
  readonly addedLines: readonly { readonly line: number; readonly source: string }[];
}

interface MutableFileChange {
  path: string;
  previousPath?: string;
  status: ReviewFileStatus;
  binary: boolean;
  additions: Array<{ line: number; source: string }>;
  nextNewLine: number;
}

/** Normalize Git's a/ and b/ prefixes without changing repository-relative paths. */
const normalizeDiffPath = (value: string): string => {
  const trimmed = value.trim().replace(/^"|"$/g, "");
  return trimmed === "/dev/null" ? trimmed : trimmed.replace(/^[ab]\//, "");
};

/** Parse every file represented by a unified diff, even when no added text exists. */
export const parseUnifiedDiff = (diff: string): readonly ReviewFileChange[] => {
  const files: ReviewFileChange[] = [];
  let current: MutableFileChange | undefined;

  const flush = (): void => {
    if (!current || !current.path || current.path === "/dev/null") return;
    const previousPath = current.previousPath && current.previousPath !== "/dev/null"
      ? current.previousPath
      : undefined;
    files.push({
      path: current.path,
      ...(previousPath && previousPath !== current.path ? { previousPath } : {}),
      status: current.status,
      binary: current.binary,
      addedSource: current.additions.map((addition) => addition.source).join("\n"),
      addedLines: current.additions,
    });
  };

  for (const line of diff.split(/\r?\n/)) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      flush();
      const previousPath = normalizeDiffPath(header[1]!);
      const path = normalizeDiffPath(header[2]!);
      current = {
        path,
        previousPath,
        status: previousPath === path ? "modified" : "renamed",
        binary: false,
        additions: [],
        nextNewLine: 1,
      };
      continue;
    }

    if (line.startsWith("--- ")) {
      if (!current) {
        current = {
          path: "",
          status: "modified",
          binary: false,
          additions: [],
          nextNewLine: 1,
        };
      }
      current.previousPath = normalizeDiffPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (!current) {
        current = {
          path: "",
          status: "modified",
          binary: false,
          additions: [],
          nextNewLine: 1,
        };
      }
      const path = normalizeDiffPath(line.slice(4));
      if (path === "/dev/null") {
        current.status = "deleted";
        current.path = current.previousPath ?? "";
      } else {
        current.path = path;
        current.status = current.previousPath === "/dev/null"
          ? "added"
          : current.previousPath && current.previousPath !== path
            ? "renamed"
            : current.status;
      }
      continue;
    }
    if (!current) continue;

    const hunk = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
    if (hunk) {
      current.nextNewLine = Number(hunk[1]);
      continue;
    }

    if (line.startsWith("new file mode ")) current.status = "added";
    else if (line.startsWith("deleted file mode ")) current.status = "deleted";
    else if (line.startsWith("rename from ")) {
      current.previousPath = normalizeDiffPath(line.slice("rename from ".length));
      current.status = "renamed";
    } else if (line.startsWith("rename to ")) {
      current.path = normalizeDiffPath(line.slice("rename to ".length));
      current.status = "renamed";
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      current.binary = true;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      current.additions.push({ line: current.nextNewLine, source: line.slice(1) });
      current.nextNewLine += 1;
    } else if (line.startsWith(" ")) {
      current.nextNewLine += 1;
    }
  }

  flush();
  return files;
};
