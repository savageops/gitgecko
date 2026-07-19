import { minimatch } from "minimatch";

import type { Rule } from "./finding.js";

/** Apply one canonical minimatch contract to rule includes and ignores. */
export function ruleAppliesToPath(rule: Pick<Rule, "files" | "ignores">, filepath: string): boolean {
  const normalized = filepath.replaceAll("\\", "/");
  const options = { dot: true, nocase: false } as const;
  const included = !rule.files?.length || rule.files.some((glob) => minimatch(normalized, glob, options));
  if (!included) return false;
  return !rule.ignores?.some((glob) => minimatch(normalized, glob, options));
}
