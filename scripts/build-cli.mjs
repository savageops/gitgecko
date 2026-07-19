/**
 * gitgecko — CLI bundler (publish-time).
 *
 * Produces dist/gitgecko.js: a single minified ESM file that inlines every
 * @gitgecko/* workspace package and resolves external runtime deps (zod,
 * @earendil-works/pi-ai) from the consumer's node_modules at install time.
 * This is the publish shape the plan's Stage 2 mandated and the onboarding
 * contract Stage 6 verifies: `npx gitgecko review` installs the `gitgecko` command,
 * backed by one file that runs under bare node with zero path shenanigans.
 *
 * The alternative — publishing packages/cli/dist with bare `@gitgecko/review`
 * imports — ships a broken artifact (those packages never reach the consumer's
 * node_modules). Bundling is what makes the single-package publish real.
 *
 * Build is a PUBLISH step, not a dev gate (AGENTS.d/60-commands): typecheck +
 * test remain the dev gates; this only runs in CI before npm publish.
 */
import { build } from "esbuild";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
);
const cliPkg = JSON.parse(
  readFileSync(resolve(root, "packages/cli/package.json"), "utf8"),
);
const versionSource = readFileSync(resolve(root, "packages/cli/src/version.ts"), "utf8");
const runtimeVersion = versionSource.match(/GITGECKO_VERSION\s*=\s*"([^"]+)"/u)?.[1];
if (!runtimeVersion || pkg.version !== cliPkg.version || pkg.version !== runtimeVersion) {
  throw new Error(
    `GitGecko version drift: package=${pkg.version}, cli=${cliPkg.version}, runtime=${runtimeVersion ?? "missing"}`,
  );
}
const outdir = resolve(root, "dist");

// Clean prior build so a stale artifact can never ship.
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

/**
 * No plugin needed: pnpm symlinks @gitgecko/* into packages/cli/node_modules,
 * so esbuild follows the symlink → the package's `exports`/`main` → built dist
 * (or src/*.ts via the dev-time `exports` mapping) and inlines it. The CLI's
 * deps are built first by `pnpm -F @gitgecko/cli... build` in CI; in dev, esbuild
 * reads the .ts source directly. Either way, the @gitgecko/* code is INLINED —
 * it never reaches the consumer's node_modules as a separate package, which is
 * exactly what makes the single-package publish shape correct.
 */

/**
 * EXTERNAL: node: built-ins + runtime deps that either use native addons or
 * are genuine npm packages the consumer installs. These resolve from the
 * consumer's node_modules at install time and are declared as `dependencies`
 * in the root package.json so npm pulls them.
 *
 * INLINE: every @gitgecko/* workspace package (the whole point — bundling
 * means the consumer never needs these as separate packages).
 *
 * @ast-grep/napi uses a native .node binding (platform-specific binary) that
 * esbuild cannot inline — it MUST stay external and resolve at runtime. The
 * rules-evaluators plug (W4/W10 deterministic-first) depends on it.
 */
const external = [
  // node: built-ins (esbuild treats "node:*" as a filter string).
  "node:*",
  // real runtime deps the consumer installs via npm at install time.
  "zod",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  // native addon — cannot be bundled, resolves from node_modules at runtime.
  "@ast-grep/napi",
];

await build({
  entryPoints: [resolve(root, "packages/cli/src/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: resolve(outdir, "gitgecko.js"),
  minify: true,
  sourcemap: false,
  // Explicit external list — anything NOT here gets inlined.
  external,
  banner: {
    // Some bundled CommonJS dependencies dynamically require Node built-ins.
    // Give esbuild's ESM compatibility helper a real module-scoped require.
    js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
  logLevel: "info",
});

console.log(
  `\nGitGecko ${pkg.version} -> dist/gitgecko.js (bundled, minified, ESM)`,
);
