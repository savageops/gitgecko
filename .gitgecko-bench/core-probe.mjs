import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const SPEC = process.env.GITGECKO_SPEC ?? "gitgecko@latest";
const root = mkdtempSync(join(tmpdir(), "gitgecko-deep-core-"));
const home = join(root, "home");
const cache = join(root, "npm-cache");
const repo = join(root, "repo");
mkdirSync(home, { recursive: true });
mkdirSync(cache, { recursive: true });
mkdirSync(repo, { recursive: true });

const baseEnv = {
  ...process.env,
  HOME: home,
  npm_config_cache: cache,
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
  GITGECKO_LOCAL_BASE_URL: "",
  GITGECKO_NO_BROWSER: "1",
};

const runProcess = (command, args, options = {}) => {
  const started = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repo,
    env: { ...baseEnv, ...(options.env ?? {}) },
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024,
    windowsHide: true,
  });
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    command: [command, ...args].join(" "),
    code: result.status ?? (result.error ? -1 : 0),
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message,
    durationMs: Math.round(durationMs * 100) / 100,
  };
};

const git = (...args) => runProcess("git", args, { cwd: repo });
const gg = (args, options = {}) => runProcess(NPX, ["--yes", SPEC, ...args], options);
const json = (run, label) => {
  try {
    return JSON.parse(run.stdout);
  } catch (error) {
    throw new Error(`${label}: invalid JSON (exit ${run.code})\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}\n${error.message}`);
  }
};
const findingIds = (value) => value?.artifact?.findings?.map((finding) => finding.ruleId).filter(Boolean) ?? [];
const findingSummary = (value) => value?.artifact?.findings?.map((finding) => ({
  id: finding.ruleId,
  source: finding.source,
  severity: finding.severity,
  file: finding.file,
  line: finding.line,
  evidence: finding.evidence,
})) ?? [];

// Establish one ordinary repository. Explicit --file probes deliberately include untracked files.
git("init", "-q");
git("config", "user.name", "GitGecko Deep Bench");
git("config", "user.email", "deep-bench@gitgecko.invalid");
writeFileSync(join(repo, "tracked.ts"), "export const baseline = true;\n");
writeFileSync(join(repo, "rename-me.ts"), "export const beforeRename = true;\n");
writeFileSync(join(repo, "delete-me.ts"), "export const beforeDelete = true;\n");
git("add", ".");
git("commit", "-qm", "baseline");

const versionRun = gg(["version"]);
const doctorRun = gg(["doctor"]);

const safeFixture = String.raw`// This file contains documentation and examples, not executable dangerous behavior.
export const securityGuide = String.raw\`
Do not call eval(userInput).
Never set rejectUnauthorized: false.
Avoid assigning target.innerHTML = userInput.
Avoid query(\`SELECT * FROM users WHERE id = \${id}\`).
Remove debugger before release.
Do not commit apiKey = "DOCUMENTATION_0123456789ABCDEF".
\`;

export const words = {
  evalExample: "eval(userInput)",
  tlsExample: "rejectUnauthorized: false",
  htmlExample: ".innerHTML =",
  sqlExample: "query(\`SELECT \${id}\`)",
  debuggerExample: "debugger",
  secretExample: "apiKey = \\\"DOCUMENTATION_0123456789ABCDEF\\\"",
};

/*
  eval(userInput)
  rejectUnauthorized: false
  target.innerHTML = userInput
  query(\`SELECT * FROM t WHERE id = \${id}\`)
  debugger
  apiKey = "COMMENT_ONLY_0123456789ABCDEF"
*/
`;
writeFileSync(join(repo, "safe-examples.ts"), safeFixture);
const safeRun = gg(["review", "--pathway", "deterministic", "--file", "safe-examples.ts", "--json"]);
const safeResult = json(safeRun, "safe examples");

const unsafeFixture = `export function execute(value: string): unknown {\n  return eval(value);\n}\nexport const dynamic = new Function("return process.env");\nexport const apiKey = "UNSAFE_0123456789ABCDEF";\nexport const tls = { rejectUnauthorized: false };\nexport function render(target: HTMLElement, value: string): void {\n  target.innerHTML = value;\n}\nexport function lookup(db: { query(sql: string): unknown }, id: string): unknown {\n  return db.query(\`SELECT * FROM users WHERE id = \${id}\`);\n}\nexport function debug(value: unknown): void {\n  debugger;\n  console.log(value);\n}\n`;
writeFileSync(join(repo, "unsafe.ts"), unsafeFixture);
const unsafeRun = gg(["review", "--pathway", "deterministic", "--mission", "security", "--file", "unsafe.ts", "--json"]);
const unsafeResult = json(unsafeRun, "unsafe fixture");
const expectedUnsafeRules = [
  "baseline-no-eval",
  "baseline-no-new-function",
  "baseline-hardcoded-secret",
  "baseline-disabled-tls",
  "baseline-dangerous-innerhtml",
  "baseline-sql-string-concat",
  "baseline-debugger-statement",
  "baseline-console-in-prod-path",
];
const unsafeIds = new Set(findingIds(unsafeResult));

const bypassFixture = `export function indirectEval(input: string): unknown {\n  return (0, eval)(input);\n}\nexport const functionCtor = Function("return process.env");\nexport function disableTls(agent: { options: { rejectUnauthorized: boolean } }): void {\n  agent.options.rejectUnauthorized = false;\n}\nexport function render(target: HTMLElement, input: string): void {\n  target.outerHTML = input;\n  target.insertAdjacentHTML("beforeend", input);\n}\nexport function lookup(db: { query(sql: string): unknown }, id: string): unknown {\n  return db.query("SELECT * FROM users WHERE id=" + id);\n}\nexport const apiKey = "abc.def/ghi+jklmnopqrstuvwxyz";\n`;
writeFileSync(join(repo, "bypass-shapes.ts"), bypassFixture);
const bypassRun = gg(["review", "--pathway", "deterministic", "--file", "bypass-shapes.ts", "--json"]);
const bypassResult = json(bypassRun, "bypass shapes");

writeFileSync(join(repo, "console.test.ts"), "export function testLog(value: unknown): void { console.log(value); }\nexport const stillBad = eval(\"1+1\");\n");
const testFileRun = gg(["review", "--pathway", "deterministic", "--file", "console.test.ts", "--json"]);
const testFileResult = json(testFileRun, "test-file ignores");

// Unknown options are intentionally probed because typo handling is a material automation boundary.
writeFileSync(join(repo, "tracked.ts"), "export const changed = eval(\"1+1\");\n");
const unknownFlagRun = gg(["review", "--pathway", "deterministic", "--definitely-not-a-real-flag", "--json"]);
let unknownFlagResult;
try { unknownFlagResult = JSON.parse(unknownFlagRun.stdout); } catch { unknownFlagResult = undefined; }
const missingFileValueRun = gg(["review", "--pathway", "deterministic", "--file", "--json"]);
const missingDiffFileValueRun = gg(["review", "--pathway", "deterministic", "--diff-file", "--json"]);

// A path outside --cwd and a symlink escape show the actual scope enforced by --file.
const outside = join(root, "outside-secret.ts");
writeFileSync(outside, "export const OUTSIDE_SECRET_MARKER_9f87c2 = eval(\"2+2\");\n");
const outsideRun = gg(["review", "--pathway", "deterministic", "--file", outside, "--json"]);
const outsideResult = json(outsideRun, "outside absolute file");
let symlinkProbe;
try {
  const link = join(repo, "inside-link.ts");
  symlinkSync(outside, link);
  const run = gg(["review", "--pathway", "deterministic", "--file", "inside-link.ts", "--json"]);
  symlinkProbe = { run, result: json(run, "symlink escape"), target: lstatSync(link).isSymbolicLink() };
} catch (error) {
  symlinkProbe = { error: error.message };
}

// Path and encoding edge cases.
writeFileSync(join(repo, "space ünicode.ts"), "export const unicodePath = eval(\"3+3\");\r\n");
const unicodePathRun = gg(["review", "--pathway", "deterministic", "--file", "space ünicode.ts", "--json"]);
const unicodePathResult = json(unicodePathRun, "unicode path");
writeFileSync(join(repo, "binary.dat"), Buffer.from([0, 1, 2, 101, 118, 97, 108, 40, 120, 41, 255, 10]));
const binaryRun = gg(["review", "--pathway", "deterministic", "--file", "binary.dat", "--json"]);
const binaryResult = json(binaryRun, "binary file");

// Unified-diff parser shapes: modified + renamed + deleted in one implicit working-tree review.
git("mv", "rename-me.ts", "renamed.ts");
git("rm", "-q", "delete-me.ts");
writeFileSync(join(repo, "renamed.ts"), "export const afterRename = eval(\"4+4\");\n");
const diffShapeRun = gg(["review", "--pathway", "deterministic", "--json"]);
const diffShapeResult = json(diffShapeRun, "diff shapes");

const malformedDiffRun = gg(["review", "--pathway", "deterministic", "--diff", "this is not a unified diff\\neval(userInput)", "--json"]);
const malformedDiffResult = json(malformedDiffRun, "malformed diff");

const summary = {
  environment: {
    platform: process.platform,
    node: process.version,
    spec: SPEC,
    root,
  },
  startup: {
    version: { code: versionRun.code, stdout: versionRun.stdout.trim(), stderr: versionRun.stderr.trim(), durationMs: versionRun.durationMs },
    doctor: { code: doctorRun.code, stdout: doctorRun.stdout.trim(), stderr: doctorRun.stderr.trim(), durationMs: doctorRun.durationMs },
  },
  ruleQuality: {
    safeExamples: {
      exit: safeRun.code,
      mergeable: safeResult.artifact?.mergeable,
      findingCount: safeResult.artifact?.findings?.length,
      findings: findingSummary(safeResult),
      note: "Every finding in this fixture is a lexical false positive because every token occurs only in comments or string literals.",
    },
    unsafeExamples: {
      exit: unsafeRun.code,
      mergeable: unsafeResult.artifact?.mergeable,
      expectedRules: expectedUnsafeRules,
      foundRules: [...unsafeIds],
      missingRules: expectedUnsafeRules.filter((id) => !unsafeIds.has(id)),
      findings: findingSummary(unsafeResult),
    },
    bypassShapes: {
      exit: bypassRun.code,
      mergeable: bypassResult.artifact?.mergeable,
      findings: findingSummary(bypassResult),
      note: "These are dangerous alternate spellings intended to expose baseline recall limits.",
    },
    testFileIgnore: {
      exit: testFileRun.code,
      findings: findingSummary(testFileResult),
    },
  },
  argumentHandling: {
    unknownFlag: {
      exit: unknownFlagRun.code,
      parsedJson: Boolean(unknownFlagResult),
      success: unknownFlagResult?.success,
      mergeable: unknownFlagResult?.artifact?.mergeable,
      findings: findingIds(unknownFlagResult),
      stderr: unknownFlagRun.stderr.trim(),
      note: "A successful review here means the unknown flag was silently ignored.",
    },
    missingFileValue: {
      exit: missingFileValueRun.code,
      stdout: missingFileValueRun.stdout.trim(),
      stderr: missingFileValueRun.stderr.trim(),
    },
    missingDiffFileValue: {
      exit: missingDiffFileValueRun.code,
      stdout: missingDiffFileValueRun.stdout.trim(),
      stderr: missingDiffFileValueRun.stderr.trim(),
    },
  },
  fileScope: {
    outsideAbsolute: {
      exit: outsideRun.code,
      success: outsideResult.success,
      files: outsideResult.artifact?.files,
      findings: findingSummary(outsideResult),
    },
    symlinkEscape: symlinkProbe?.result ? {
      exit: symlinkProbe.run.code,
      targetIsSymlink: symlinkProbe.target,
      files: symlinkProbe.result.artifact?.files,
      findings: findingSummary(symlinkProbe.result),
    } : symlinkProbe,
    unicodePath: {
      exit: unicodePathRun.code,
      files: unicodePathResult.artifact?.files,
      findings: findingSummary(unicodePathResult),
    },
    binaryAsUtf8: {
      exit: binaryRun.code,
      files: binaryResult.artifact?.files,
      findings: findingSummary(binaryResult),
    },
  },
  diffParsing: {
    implicitMixedChanges: {
      exit: diffShapeRun.code,
      files: diffShapeResult.artifact?.files,
      findings: findingSummary(diffShapeResult),
    },
    malformedDiff: {
      exit: malformedDiffRun.code,
      success: malformedDiffResult.success,
      mergeable: malformedDiffResult.artifact?.mergeable,
      files: malformedDiffResult.artifact?.files,
      findings: findingSummary(malformedDiffResult),
      output: malformedDiffResult.output,
    },
  },
};

console.log(JSON.stringify(summary, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  const line = `## GitGecko deep core probe\n\n- Safe lexical examples produced **${summary.ruleQuality.safeExamples.findingCount ?? 0}** findings.\n- Unsafe baseline missed **${summary.ruleQuality.unsafeExamples.missingRules.length}** expected rules.\n- Alternate dangerous spellings produced **${summary.ruleQuality.bypassShapes.findings.length}** findings.\n- Unknown flag parsed and continued: **${summary.argumentHandling.unknownFlag.parsedJson ? "yes" : "no"}**.\n- Absolute outside file accepted: **${summary.fileScope.outsideAbsolute.success ? "yes" : "no"}**.\n`;
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, line, { flag: "a" });
}
