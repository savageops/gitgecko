#!/usr/bin/env node
/**
 * gitgecko dependency-pin validator.
 *
 * Enforces the AGENTS.md supply-chain rule: exact pins only, no floating
 * versions (^/~/>/< ranges). Also optionally verifies that every exact pin
 * resolves to a real published version on the registry (catches the
 * typescript@5.6.0 / react-query@5.90.0 class of bug — versions that never
 * existed as stable releases and silently break installs).
 *
 * Two modes:
 *   node scripts/validate-pins.mjs           # fast, offline — floating-pin sweep only
 *   node scripts/validate-pins.mjs --online  # slow, network — also checks each exact pin exists
 *
 * The offline mode is the CI per-PR gate (fast, no network dependency).
 * The online mode is the nightly gate (catches registry drift, takes longer).
 *
 * Exit code 0 = clean, 1 = violations found. CI-friendly.
 *
 * Salvaged from the /tmp/validate-pins.mjs one-off written during the
 * second-pass readiness audit (broken-pin sweep), promoted to a real script
 * and split into offline/online modes for the nightly CI gate.
 */
import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { execSync } from "node:child_process";

const ONLINE = process.argv.includes("--online");

// Spec prefixes that are NOT exact registry versions (workspace/file/link/npm
// refs, git URLs, ranges). Everything else must be an exact pin.
const NON_EXACT_PREFIX = ["workspace:", "file:", "link:", "npm:", "git+", "http:", "https:"];
// Range/version-range metacharacters — presence means floating, not exact.
const RANGE_CHARS = ["*", "^", "~", ">", "<", " "];

const files = await Array.fromAsync((async function* () {
  for await (const f of glob("**/package.json")) {
    const normalized = f.replaceAll("\\", "/");
    const segments = normalized.split("/");
    if (segments.includes("node_modules")) continue;
    if (segments.includes(".refs")) continue;
    if (segments.includes("dist")) continue;
    if (segments.some((segment) => segment === ".next" || segment.startsWith(".next-"))) continue;
    yield f;
  }
})());

const floatingViolations = [];
const nonexistentViolations = [];
const actionViolations = [];

for (const file of files) {
  let pkg;
  try {
    pkg = JSON.parse(await readFile(file, "utf8"));
  } catch {
    continue; // malformed JSON — not our concern here
  }
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "overrides"]) {
    const deps = pkg[section];
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== "string") continue;
      if (NON_EXACT_PREFIX.some((p) => spec.startsWith(p))) continue;
      // Check 1 (offline): no floating ranges allowed per AGENTS.md.
      if (RANGE_CHARS.some((c) => spec.includes(c))) {
        floatingViolations.push({ file, section, name, spec });
        continue; // floating specs skip the existence check (meaningless on a range)
      }
      // Check 2 (online, opt-in): exact pin must resolve to a real version.
      if (!ONLINE) continue;
      try {
        const out = execSync(`pnpm view "${name}@${spec}" version`, {
          stdio: ["ignore", "pipe", "ignore"],
        }).toString().trim();
        if (!out) {
          nonexistentViolations.push({ file, section, name, spec, reason: "NO_VERSION_RETURNED" });
        }
      } catch {
        nonexistentViolations.push({ file, section, name, spec, reason: "NOT_FOUND_ON_REGISTRY" });
      }
    }
  }
}

// pnpm owns root overrides in pnpm-workspace.yaml, not package.json.
const workspaceYaml = await readFile("pnpm-workspace.yaml", "utf8");
const workspaceLines = workspaceYaml.split(/\r?\n/);
const overrideStart = workspaceLines.findIndex((line) => line.trim() === "overrides:");
const linesAfterOverrides = overrideStart < 0 ? [] : workspaceLines.slice(overrideStart + 1);
const nextRootKey = linesAfterOverrides.findIndex((line) => line.length > 0 && !/^\s/.test(line));
const overrideLines = nextRootKey < 0 ? linesAfterOverrides : linesAfterOverrides.slice(0, nextRootKey);
for (const line of overrideLines) {
  const match = /^\s{2}([^:#]+):\s*["']?([^"'#\s]+)["']?\s*$/.exec(line);
  if (!match) continue;
  const [, name, spec] = match;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec)) {
    floatingViolations.push({ file: "pnpm-workspace.yaml", section: "overrides", name, spec });
  }
}

// Marketplace action tags are mutable. Local and docker actions are separate trust boundaries.
for await (const file of glob("{action.yml,action.yaml,.github/workflows/*.yml,.github/workflows/*.yaml}")) {
  const source = await readFile(file, "utf8");
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (line.trimStart().startsWith("#")) continue;
    const match = /\buses:\s*([^\s#]+)/.exec(line);
    if (!match) continue;
    const reference = match[1];
    if (reference.startsWith("./") || reference.startsWith("docker://")) continue;
    const revision = reference.slice(reference.lastIndexOf("@") + 1);
    if (!/^[0-9a-f]{40}$/i.test(revision)) {
      actionViolations.push({ file, line: index + 1, reference });
    }
  }
}

let exitCode = 0;
if (floatingViolations.length > 0) {
  console.error(`\n[FAIL] ${floatingViolations.length} floating-pin violation(s) — AGENTS.md requires exact pins:`);
  for (const v of floatingViolations) {
    console.error(`  ${v.file} [${v.section}] ${v.name}: "${v.spec}"`);
  }
  exitCode = 1;
} else {
  console.error(`[OK] No floating-pin violations across ${files.length} package.json files and pnpm-workspace.yaml.`);
}

if (ONLINE) {
  if (nonexistentViolations.length > 0) {
    console.error(`\n[FAIL] ${nonexistentViolations.length} exact pin(s) do not resolve on the registry:`);
    for (const v of nonexistentViolations) {
      console.error(`  ${v.file} [${v.section}] ${v.name}@${v.spec} — ${v.reason}`);
    }
    exitCode = 1;
  } else {
    console.error(`[OK] All exact pins resolve on the registry (online check).`);
  }
}

if (actionViolations.length > 0) {
  console.error(`\n[FAIL] ${actionViolations.length} mutable GitHub Action reference(s):`);
  for (const violation of actionViolations) {
    console.error(`  ${violation.file}:${violation.line} uses: ${violation.reference}`);
  }
  exitCode = 1;
} else {
  console.error("[OK] All external GitHub Action references use full commit SHAs.");
}

process.exit(exitCode);
