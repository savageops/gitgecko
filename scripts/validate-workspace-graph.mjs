#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoots = ["apps", "packages", "plugs"];
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const ignoredDirectories = new Set([".next", ".output", "coverage", "dist", "node_modules", "public"]);

/** Collects workspace manifests without treating generated or installed trees as projects. */
function collectManifests(directory, manifests = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name) || entry.name.startsWith(".next-")) continue;
    const path = join(directory, entry.name);
    if (!entry.isDirectory()) continue;
    const manifestPath = join(path, "package.json");
    if (existsSync(manifestPath)) manifests.push(manifestPath);
    collectManifests(path, manifests);
  }
  return manifests;
}

// A workspace plane (apps/, packages/, plugs/) may be absent in a public clone —
// the private surface is gitignored out, so an entire top-level directory can
// disappear. Skip missing planes rather than crashing on readdirSync(ENOENT).
// (validate-build-artifacts.mjs already does this; this brings parity.)
const manifests = workspaceRoots
  .filter((directory) => existsSync(join(root, directory)))
  .flatMap((directory) => collectManifests(join(root, directory)));
const projects = new Map();
for (const manifestPath of manifests) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest.name) throw new Error(`workspace package has no name: ${relative(root, manifestPath)}`);
  if (projects.has(manifest.name)) throw new Error(`duplicate workspace package name: ${manifest.name}`);
  projects.set(manifest.name, { manifest, manifestPath });
}

const graph = new Map();
for (const [name, project] of projects) {
  const dependencies = new Set();
  for (const field of dependencyFields) {
    for (const dependency of Object.keys(project.manifest[field] ?? {})) {
      if (projects.has(dependency)) dependencies.add(dependency);
    }
  }
  graph.set(name, dependencies);
}

const visited = new Set();
const active = new Set();
const stack = [];

/** Reports the concrete dependency chain so maintainers can move the misplaced owner. */
function visit(name) {
  if (active.has(name)) {
    const start = stack.indexOf(name);
    throw new Error(`workspace dependency cycle: ${[...stack.slice(start), name].join(" -> ")}`);
  }
  if (visited.has(name)) return;
  active.add(name);
  stack.push(name);
  for (const dependency of graph.get(name) ?? []) visit(dependency);
  stack.pop();
  active.delete(name);
  visited.add(name);
}

for (const name of graph.keys()) visit(name);
console.log(`[OK] Workspace dependency graph is acyclic across ${projects.size} projects.`);
