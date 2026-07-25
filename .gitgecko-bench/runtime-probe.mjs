import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const SPEC = process.env.GITGECKO_SPEC ?? "gitgecko@latest";
const root = mkdtempSync(join(tmpdir(), "gitgecko-deep-runtime-"));
const repo = join(root, "repo");
const home = join(root, "home");
const cache = join(root, "npm-cache");
const configPath = join(home, "gitgecko", "config.json");
for (const path of [repo, home, cache, join(home, "gitgecko")]) mkdirSync(path, { recursive: true });

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
};

const spawnCapture = (command, args, options = {}) => new Promise((resolvePromise) => {
  const started = process.hrtime.bigint();
  const child = spawn(command, args, {
    cwd: options.cwd ?? repo,
    env: { ...baseEnv, ...(options.env ?? {}) },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", (error) => resolvePromise({ code: -1, stdout, stderr, error: error.message, durationMs: 0 }));
  child.once("exit", (code, signal) => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    resolvePromise({ code: code ?? -1, signal, stdout, stderr, durationMs: Math.round(durationMs * 100) / 100 });
  });
});
const gg = (args, options = {}) => spawnCapture(NPX, ["--yes", SPEC, ...args], options);
const git = async (...args) => {
  const result = await spawnCapture("git", args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
};
const parseJson = (result, label) => {
  try { return JSON.parse(result.stdout); }
  catch (error) { throw new Error(`${label}: invalid JSON\nstdout=${result.stdout}\nstderr=${result.stderr}\n${error.message}`); }
};
const writeConfig = (reviewChecks, extra = {}) => {
  writeFileSync(configPath, `${JSON.stringify({ version: 1, reviewChecks, ...extra }, null, 2)}\n`);
};
const receiptSummary = (value) => value?.artifact?.runtimeChecks?.receipts?.map((receipt) => ({
  id: receipt.id,
  required: receipt.required,
  status: receipt.status,
  exitCode: receipt.exitCode,
  durationMs: receipt.durationMs,
  stdout: receipt.stdout,
  stderr: receipt.stderr,
  outputTruncated: receipt.outputTruncated,
  detail: receipt.detail,
  backend: receipt.backend,
})) ?? [];

await git("init", "-q");
await git("config", "user.name", "GitGecko Deep Bench");
await git("config", "user.email", "deep-bench@gitgecko.invalid");
writeFileSync(join(repo, "warning.ts"), "export const safe = true;\n");
await git("add", "warning.ts");
await git("commit", "-qm", "baseline");
writeFileSync(join(repo, "warning.ts"), "export const apiKey = \"WARNING_ONLY_0123456789ABCDEF\";\n");
await gg(["version"]);

rmSync(configPath, { force: true });
const missingConfigRun = await gg(["review", "--pathway", "deterministic", "--run-checks", "--json"]);
const missingConfigResult = parseJson(missingConfigRun, "missing config");

const inheritedSecret = "INHERITED_RUNTIME_SECRET_c9dd8422e3d7";
const argvSecret = "ARGV_RUNTIME_SECRET_4bf0fd42b91a";
const processTreeMarker = join(root, "timeout-grandchild-marker");
const shellMarker = join(root, "shell-interpolation-marker");
const longUnicode = "🦎".repeat(10_000);
const checks = [
  {
    id: "required-pass",
    label: "Required pass",
    command: process.execPath,
    args: ["-e", "process.stdout.write('PASS')"],
    timeoutMs: 10_000,
  },
  {
    id: "optional-fail",
    label: "Optional failure",
    command: process.execPath,
    args: ["-e", "process.stderr.write('OPTIONAL_FAIL');process.exit(7)"],
    timeoutMs: 10_000,
    required: false,
  },
  {
    id: "optional-timeout",
    label: "Optional timeout",
    command: process.execPath,
    args: ["-e", "setTimeout(()=>{},5000)"],
    timeoutMs: 200,
    required: false,
  },
  {
    id: "large-unicode-output",
    label: "Large Unicode output",
    command: process.execPath,
    args: ["-e", `process.stdout.write(${JSON.stringify(longUnicode)})`],
    timeoutMs: 10_000,
  },
  {
    id: "inherited-secret",
    label: "Inherited environment secret",
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.env.BENCH_SECRET || 'missing')"],
    timeoutMs: 10_000,
  },
  {
    id: "argv-secret",
    label: "Long argv secret",
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.argv[1])", argvSecret],
    timeoutMs: 10_000,
  },
  {
    id: "cwd-proof",
    label: "Working directory proof",
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.cwd())"],
    timeoutMs: 10_000,
  },
  {
    id: "literal-shell-token",
    label: "No shell interpolation",
    command: "echo",
    args: [`$(touch ${shellMarker})`],
    timeoutMs: 10_000,
    required: false,
  },
];
writeConfig(checks);
const mixedRun = await gg(
  ["review", "--pathway", "deterministic", "--run-checks", "--json"],
  { env: { BENCH_SECRET: inheritedSecret } },
);
const mixedResult = parseJson(mixedRun, "mixed runtime checks");
const mixedReceipts = receiptSummary(mixedResult);
const inheritedReceipt = mixedReceipts.find((receipt) => receipt.id === "inherited-secret");
const argvReceipt = mixedReceipts.find((receipt) => receipt.id === "argv-secret");
const unicodeReceipt = mixedReceipts.find((receipt) => receipt.id === "large-unicode-output");

writeConfig([{
  id: "required-fail",
  label: "Required failure",
  command: process.execPath,
  args: ["-e", "process.stderr.write('REQUIRED_FAIL');process.exit(9)"],
  timeoutMs: 10_000,
}]);
const requiredFailRun = await gg(["review", "--pathway", "deterministic", "--run-checks", "--json"]);
const requiredFailResult = parseJson(requiredFailRun, "required failure");

writeConfig([{
  id: "required-timeout",
  label: "Required timeout",
  command: process.execPath,
  args: ["-e", "setTimeout(()=>{},5000)"],
  timeoutMs: 200,
}]);
const requiredTimeoutRun = await gg(["review", "--pathway", "deterministic", "--run-checks", "--json"]);
const requiredTimeoutResult = parseJson(requiredTimeoutRun, "required timeout");

// A timed-out process spawns an unref'd descendant. Check whether the backend kills the process tree.
const childCode = `const {writeFileSync}=require('node:fs');setTimeout(()=>writeFileSync(${JSON.stringify(processTreeMarker)},'survived'),800)`;
const parentCode = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore'}).unref();setTimeout(()=>{},5000)`;
writeConfig([{
  id: "tree-timeout",
  label: "Timeout process tree",
  command: process.execPath,
  args: ["-e", parentCode],
  timeoutMs: 200,
  required: false,
}]);
const treeTimeoutRun = await gg(["review", "--pathway", "deterministic", "--run-checks", "--json"]);
const treeTimeoutResult = parseJson(treeTimeoutRun, "process tree timeout");
await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
const descendantSurvived = existsSync(processTreeMarker);

// Duplicate ids must reject the whole batch before the first command runs.
const duplicateSideEffect = join(root, "duplicate-side-effect");
writeConfig([
  {
    id: "duplicate",
    label: "Would create marker",
    command: process.execPath,
    args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(duplicateSideEffect)},'ran')`],
    timeoutMs: 10_000,
  },
  {
    id: "duplicate",
    label: "Duplicate id",
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    timeoutMs: 10_000,
  },
]);
const duplicateRun = await gg(["review", "--pathway", "deterministic", "--run-checks", "--json"]);
let duplicateResult;
try { duplicateResult = JSON.parse(duplicateRun.stdout); } catch { duplicateResult = undefined; }
const duplicateExecutedPartially = existsSync(duplicateSideEffect);

// Strict config schema should reject unknown fields through the machine-readable error path.
writeFileSync(configPath, JSON.stringify({
  version: 1,
  reviewChecks: [{ id: "valid", label: "Valid", command: process.execPath }],
  unexpectedField: true,
}));
const invalidConfigRun = await gg(["review", "--pathway", "deterministic", "--run-checks", "--json"]);
let invalidConfigResult;
try { invalidConfigResult = JSON.parse(invalidConfigRun.stdout); } catch { invalidConfigResult = undefined; }

const summary = {
  environment: { platform: process.platform, node: process.version, spec: SPEC, root, repo },
  missingConfig: {
    exit: missingConfigRun.code,
    result: missingConfigResult,
    stderr: missingConfigRun.stderr,
  },
  mixedChecks: {
    exit: mixedRun.code,
    success: mixedResult.success,
    mergeable: mixedResult.artifact?.mergeable,
    allRequiredPassed: mixedResult.artifact?.runtimeChecks?.allRequiredPassed,
    receipts: mixedReceipts,
    inheritedEnvironmentSecretLeaked: inheritedReceipt?.stdout.includes(inheritedSecret) ?? false,
    inheritedEnvironmentSecretRedacted: inheritedReceipt?.stdout.includes("[REDACTED]") ?? false,
    longArgSecretLeaked: argvReceipt?.stdout.includes(argvSecret) ?? false,
    longArgSecretRedacted: argvReceipt?.stdout.includes("[REDACTED]") ?? false,
    unicodeOutputBytes: Buffer.byteLength(unicodeReceipt?.stdout ?? "", "utf8"),
    unicodeOutputValidRoundTrip: Buffer.from(unicodeReceipt?.stdout ?? "", "utf8").toString("utf8") === (unicodeReceipt?.stdout ?? ""),
    shellInterpolationCreatedMarker: existsSync(shellMarker),
  },
  requiredFailure: {
    exit: requiredFailRun.code,
    success: requiredFailResult.success,
    mergeable: requiredFailResult.artifact?.mergeable,
    allRequiredPassed: requiredFailResult.artifact?.runtimeChecks?.allRequiredPassed,
    receipts: receiptSummary(requiredFailResult),
  },
  requiredTimeout: {
    exit: requiredTimeoutRun.code,
    success: requiredTimeoutResult.success,
    mergeable: requiredTimeoutResult.artifact?.mergeable,
    allRequiredPassed: requiredTimeoutResult.artifact?.runtimeChecks?.allRequiredPassed,
    receipts: receiptSummary(requiredTimeoutResult),
  },
  processTreeTimeout: {
    exit: treeTimeoutRun.code,
    mergeable: treeTimeoutResult.artifact?.mergeable,
    receipts: receiptSummary(treeTimeoutResult),
    descendantSurvived,
    marker: processTreeMarker,
  },
  duplicateIds: {
    exit: duplicateRun.code,
    result: duplicateResult,
    stdout: duplicateRun.stdout,
    stderr: duplicateRun.stderr,
    partialExecutionOccurred: duplicateExecutedPartially,
  },
  invalidConfig: {
    exit: invalidConfigRun.code,
    result: invalidConfigResult,
    stdout: invalidConfigRun.stdout,
    stderr: invalidConfigRun.stderr,
  },
};

console.log(JSON.stringify(summary, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  const line = `## GitGecko runtime-check probe\n\n- Inherited environment secret leaked: **${summary.mixedChecks.inheritedEnvironmentSecretLeaked}**.\n- Long argv secret redacted: **${summary.mixedChecks.longArgSecretRedacted}**.\n- Output bounded to **${summary.mixedChecks.unicodeOutputBytes} bytes**.\n- Shell interpolation executed: **${summary.mixedChecks.shellInterpolationCreatedMarker}**.\n- Timed-out descendant survived: **${summary.processTreeTimeout.descendantSurvived}**.\n- Duplicate-id batch partially executed: **${summary.duplicateIds.partialExecutionOccurred}**.\n`;
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, line, { flag: "a" });
}
