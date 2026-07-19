/**
 * Repository rule discovery for review instructions.
 *
 * Harvested behavior: CodeRabbit automatically discovers common agent guideline
 * files and applies them by directory scope; its root `.coderabbit.yaml` can add
 * path instructions. GitGecko keeps that behavior local, bounded, and read-only.
 * Sources: https://docs.coderabbit.ai/knowledge-base/code-guidelines and
 * https://docs.coderabbit.ai/configuration/path-instructions.
 */
import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ruleAppliesToPath } from "@gitgecko/rules";
import { parse } from "yaml";

const MAX_DISCOVERED_FILES = 256;
const MAX_RULE_FILE_BYTES = 24 * 1024;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", ".next", ".cache", "coverage"]);
const SCOPED_RULE_FILENAMES = new Set(["AGENT.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules", ".windsurfrules"]);
const excludeGeneratedPath = (fileName: string): boolean =>
  normalizePath(fileName).split("/").some((segment) => SKIPPED_DIRECTORIES.has(segment));

export interface RepositoryRule {
  readonly path: string;
  readonly scope: string;
  readonly instruction: string;
  readonly source: "guideline" | "path-instruction";
}

export interface RepositoryRules {
  readonly root: string;
  readonly rules: readonly RepositoryRule[];
  readonly diagnostics: readonly string[];
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizePath = (path: string): string => {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized === "." ? "" : normalized;
};

/** Resolve the nearest repository boundary without shelling out to Git. */
const findRepositoryRoot = (cwd: string): string => {
  let directory = resolve(cwd);
  while (true) {
    if (existsSync(join(directory, ".git"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return resolve(cwd);
    directory = parent;
  }
};

/** Extract only paths actually present in the diff; no changed path means root scope only. */
const changedPaths = (diff: string): readonly string[] => {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+++ ")) continue;
    const path = normalizePath(line.slice(4).trim().replace(/^b\//, ""));
    if (path && path !== "/dev/null") paths.add(path);
  }
  return [...paths];
};

/** Return root-to-leaf directory scopes for changed files. */
const changedScopes = (paths: readonly string[]): readonly string[] => {
  const scopes = new Set<string>([""]);
  for (const path of paths) {
    const segments = normalizePath(dirname(path)).split("/").filter((segment) => segment !== ".");
    for (let depth = 1; depth <= segments.length; depth += 1) scopes.add(segments.slice(0, depth).join("/"));
  }
  return [...scopes].sort((left, right) => left.length - right.length || left.localeCompare(right));
};

/** Discover only rule locations relevant to changed paths plus configured patterns. */
const discoverRuleFiles = (root: string, paths: readonly string[], configuredPatterns: readonly string[]): readonly string[] => {
  const candidates = new Set<string>();
  for (const scope of changedScopes(paths)) {
    for (const filename of SCOPED_RULE_FILENAMES) candidates.add(normalizePath(join(scope, filename)));
    for (const directory of [".cursor/rules", ".clinerules", ".rules"]) {
      const pattern = normalizePath(join(scope, directory, "**/*"));
      for (const path of globSync(pattern, { cwd: root, withFileTypes: false, exclude: excludeGeneratedPath })) {
        candidates.add(normalizePath(path));
      }
    }
  }
  candidates.add(".github/copilot-instructions.md");
  for (const pattern of configuredPatterns) {
    for (const path of globSync(normalizePath(pattern), { cwd: root, withFileTypes: false, exclude: excludeGeneratedPath })) {
      candidates.add(normalizePath(path));
    }
  }
  return [...candidates]
    .filter((path) => existsSync(join(root, path)))
    .slice(0, MAX_DISCOVERED_FILES);
};

const appliesToChangedPath = (scope: string, paths: readonly string[]): boolean =>
  scope.length === 0 || paths.some((path) => path === scope || path.startsWith(`${scope}/`));

const configuredGuidelinePatterns = (config: unknown): readonly string[] => {
  if (!isRecord(config) || !isRecord(config.knowledge_base) || !isRecord(config.knowledge_base.code_guidelines)) return [];
  const patterns = config.knowledge_base.code_guidelines.filePatterns;
  return Array.isArray(patterns) ? patterns.filter((pattern): pattern is string => typeof pattern === "string") : [];
};

const configuredPathInstructions = (config: unknown): readonly { path: string; instructions: string }[] => {
  if (!isRecord(config) || !isRecord(config.reviews) || !Array.isArray(config.reviews.path_instructions)) return [];
  return config.reviews.path_instructions.flatMap((entry) =>
    isRecord(entry) && typeof entry.path === "string" && typeof entry.instructions === "string"
      ? [{ path: entry.path, instructions: entry.instructions }]
      : [],
  );
};

/**
 * Discover repository-owned review rules that apply to the supplied diff.
 * Broader directories load before deeper ones; exact path instructions load last.
 */
export const discoverRepositoryRules = (cwd: string, diff: string): RepositoryRules => {
  const root = findRepositoryRoot(cwd);
  const changed = changedPaths(diff);
  const diagnostics: string[] = [];
  const configPath = join(root, ".coderabbit.yaml");
  let config: unknown;
  if (existsSync(configPath)) {
    try {
      config = parse(readFileSync(configPath, "utf8"), { maxAliasCount: 0 });
    } catch {
      diagnostics.push("Ignored malformed .coderabbit.yaml.");
    }
  }
  const configuredPatterns = configuredGuidelinePatterns(config);
  const candidates = discoverRuleFiles(root, changed, configuredPatterns).flatMap((path) => {
    const absolute = join(root, path);
    const directoryScope = normalizePath(dirname(path));
    const basename = path.split("/").at(-1) ?? "";
    const isKnownScopedRule = SCOPED_RULE_FILENAMES.has(basename);
    const isRuleDirectory = /(^|\/)(?:\.cursor\/rules|\.clinerules|\.rules)\//u.test(path);
    const isCopilotInstruction = path === ".github/copilot-instructions.md";
    const matchesConfiguredPattern = configuredPatterns.length > 0 && ruleAppliesToPath({ files: configuredPatterns }, path);
    const ruleDirectoryScope = path.match(/^(.*?)(?:\/)?(?:\.cursor\/rules|\.clinerules|\.rules)\//u)?.[1];
    const scope = isRuleDirectory ? normalizePath(ruleDirectoryScope ?? "") : directoryScope;
    const applies = isCopilotInstruction || matchesConfiguredPattern || appliesToChangedPath(scope, changed);
    return (isKnownScopedRule || isRuleDirectory || isCopilotInstruction || matchesConfiguredPattern) && applies
      ? [{ absolute, path, scope }]
      : [];
  }).sort((left, right) => left.scope.length - right.scope.length || left.path.localeCompare(right.path));
  const rules: RepositoryRule[] = [];
  for (const candidate of candidates) {
    let size: number;
    try {
      size = statSync(candidate.absolute).size;
    } catch {
      continue;
    }
    if (size > MAX_RULE_FILE_BYTES) {
      diagnostics.push(`Ignored oversized repository rule file: ${candidate.path}`);
      continue;
    }
    const instruction = readFileSync(candidate.absolute, "utf8").trim();
    if (instruction.length > 0) rules.push({ path: candidate.path, scope: candidate.scope, instruction, source: "guideline" });
  }
  for (const instruction of configuredPathInstructions(config)) {
    if (!changed.some((path) => ruleAppliesToPath({ files: [instruction.path] }, path))) continue;
    rules.push({ path: ".coderabbit.yaml", scope: instruction.path, instruction: instruction.instructions, source: "path-instruction" });
  }
  return { root, rules, diagnostics };
};

/** Render discovered rules with source and scope so providers can reason about precedence. */
export const renderRepositoryRules = (rules: readonly RepositoryRule[]): readonly string[] =>
  rules.map((rule) => `[repository:${rule.path}${rule.source === "path-instruction" ? ` (${rule.scope})` : ""}] ${rule.instruction}`);
