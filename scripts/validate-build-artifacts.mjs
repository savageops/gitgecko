#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");
const workspaceRoots = ["apps", "packages", "plugs"];
const ignoredDirectories = new Set([".next", ".output", "coverage", "node_modules"]);

/** Generated framework and dependency trees never own workspace build policy. */
export function isIgnoredPackageDirectory(name) {
  return ignoredDirectories.has(name) || name.startsWith(".next-");
}

/** Production output must never contain source-runner test programs. */
export function isTestArtifactPath(path) {
  const normalized = path.replaceAll("\\", "/");
  return /(^|\/)__tests__(\/|$)/u.test(normalized)
    || /(^|\/)[^/]+\.(?:test|spec)\.[^/]+$/u.test(normalized);
}

/** Plain TypeScript emit must clear its owned output before compiling. */
export function isNonHermeticTypeScriptBuild(build) {
  if (typeof build !== "string" || !/(?:^|&&)\s*tsc\s+-p\s+/u.test(build)) return false;
  if (/--noEmit(?:\s|$)/u.test(build)) return false;
  return !/(?:^|&&)\s*rimraf\s+dist(?:\s|&&)/u.test(build);
}

/** Conditional ESM exports need a runtime fallback for Node loaders and source runners. */
export function findConditionIncompleteExports(exportsField) {
  if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) return [];
  return Object.entries(exportsField).flatMap(([subpath, target]) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) return [];
    return typeof target.import === "string" && typeof target.default !== "string" ? [subpath] : [];
  });
}

/** Finds package roots without descending into generated or installed trees. */
function collectPackageRoots(directory, packageRoots = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || isIgnoredPackageDirectory(entry.name)) continue;
    const path = join(directory, entry.name);
    if (existsSync(join(path, "package.json"))) packageRoots.push(path);
    collectPackageRoots(path, packageRoots);
  }
  return packageRoots;
}

/** Recursively inventories test-shaped files from one generated directory. */
function collectTestArtifacts(directory, artifacts = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectTestArtifacts(path, artifacts);
    else if (isTestArtifactPath(path)) artifacts.push(path);
  }
  return artifacts;
}

export function validateBuildArtifacts(projectRoot = root) {
  const packageRoots = workspaceRoots.flatMap((directory) => {
    const path = join(projectRoot, directory);
    return existsSync(path) ? collectPackageRoots(path) : [];
  });
  const artifacts = packageRoots.flatMap((packageRoot) => {
    const dist = join(packageRoot, "dist");
    return existsSync(dist) ? collectTestArtifacts(dist) : [];
  });
  const nonHermetic = packageRoots.flatMap((packageRoot) => {
    const manifestPath = join(packageRoot, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return isNonHermeticTypeScriptBuild(manifest.scripts?.build) ? [manifestPath] : [];
  });
  const incompleteExports = packageRoots.flatMap((packageRoot) => {
    const manifestPath = join(packageRoot, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return findConditionIncompleteExports(manifest.exports).map((subpath) => ({ manifestPath, subpath }));
  });
  if (nonHermetic.length > 0) {
    const evidence = nonHermetic.map((path) => relative(projectRoot, path).split(sep).join("/")).join("\n- ");
    throw new Error(`TypeScript emit does not clean its output owner:\n- ${evidence}`);
  }
  if (artifacts.length > 0) {
    const evidence = artifacts.map((path) => relative(projectRoot, path).split(sep).join("/")).join("\n- ");
    throw new Error(`production output contains test artifacts:\n- ${evidence}`);
  }
  if (incompleteExports.length > 0) {
    const evidence = incompleteExports
      .map(({ manifestPath, subpath }) => `${relative(projectRoot, manifestPath).split(sep).join("/")} :: ${subpath}`)
      .join("\n- ");
    throw new Error(`conditional package exports have no default runtime target:\n- ${evidence}`);
  }
  return packageRoots.length;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const packageCount = validateBuildArtifacts();
  console.log(`[OK] Production TypeScript output is hermetic and test-free across ${packageCount} package roots.`);
}
