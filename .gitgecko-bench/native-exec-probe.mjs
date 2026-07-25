import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const SPEC = process.env.GITGECKO_SPEC ?? "gitgecko@latest";
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), "gitgecko-native-exec-"));
const repo = join(root, "repo");
const home = join(root, "home");
const cache = join(root, "npm-cache");
const bin = join(root, "bin");
const logPath = join(root, "codex.ndjson");
for (const path of [repo, home, cache, bin]) mkdirSync(path, { recursive: true });
copyFileSync(join(sourceDirectory, "fake-codex.mjs"), join(bin, "codex"));
chmodSync(join(bin, "codex"), 0o755);
for (const name of ["claude", "opencode"]) {
  writeFileSync(join(bin, name), "#!/usr/bin/env sh\nexit 127\n");
  chmodSync(join(bin, name), 0o755);
}

const environment = {
  ...process.env,
  HOME: home,
  PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  FAKE_CODEX_LOG: logPath,
  npm_config_cache: cache,
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
  GITGECKO_LOCAL_BASE_URL: "",
};
const spawnCapture = (command, args, extraEnvironment = {}) => new Promise((resolvePromise) => {
  const started = process.hrtime.bigint();
  const child = spawn(command, args, {
    cwd: repo,
    env: { ...environment, ...extraEnvironment },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", (error) => resolvePromise({ code: -1, stdout, stderr, error: error.message, durationMs: 0 }));
  child.once("exit", (code, signal) => resolvePromise({
    code: code ?? -1,
    signal,
    stdout,
    stderr,
    durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100,
  }));
});
const git = async (...args) => {
  const result = await spawnCapture("git", args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
};
const gitgecko = (args, mode = "normal", extraEnvironment = {}) => spawnCapture(
  "npx",
  ["--yes", SPEC, ...args],
  { FAKE_CODEX_MODE: mode, ...extraEnvironment },
);
const parse = (result) => {
  try { return JSON.parse(result.stdout); } catch { return undefined; }
};
const summarize = (result) => {
  const value = parse(result);
  return {
    exit: result.code,
    durationMs: result.durationMs,
    parsed: Boolean(value),
    success: value?.success,
    failure: value?.failure,
    output: value?.output ?? result.stdout,
    stderr: result.stderr,
    pathway: value?.pathwayResolution,
    mergeable: value?.artifact?.mergeable,
    findings: value?.artifact?.findings,
    diagnostics: value?.diagnostics,
  };
};

await git("init", "-q");
await git("config", "user.name", "GitGecko Native Followup");
await git("config", "user.email", "native-followup@gitgecko.invalid");
writeFileSync(join(repo, "app.ts"), "export const before = false;\n");
await git("add", "app.ts");
await git("commit", "-qm", "baseline");
writeFileSync(join(repo, "app.ts"), "export const after = true;\n");

await gitgecko(["version"]);
const doctor = await gitgecko(["doctor"]);
const auto = await gitgecko(["review", "--json"]);
const explicit = await gitgecko(["review", "--pathway", "codex", "--json"]);
const workspaceWrite = await gitgecko(["review", "--pathway", "codex", "--permission", "workspace-write", "--json"]);
const unrestricted = await gitgecko(["review", "--pathway", "codex", "--permission", "unrestricted", "--json"]);
const structuredError = await gitgecko(["review", "--pathway", "codex", "--json"], "structured-error");
const emptyOutput = await gitgecko(["review", "--pathway", "codex", "--json"], "empty-output");
const malformedLines = await gitgecko(["review", "--pathway", "codex", "--json"], "malformed-lines");
const authFailure = await gitgecko(["review", "--pathway", "codex", "--json"], "auth-fail");
const earlyExit = await gitgecko(["review", "--pathway", "codex", "--json"], "exit-early");
const timeout = await gitgecko(["review", "--pathway", "codex", "--json"], "timeout", { CODEX_TIMEOUT_MS: "250" });
const agentMode = await gitgecko(["review", "--pathway", "codex", "--agent"]);
const mutate = await gitgecko(["review", "--pathway", "codex", "--json"], "mutate");
const mutationMarker = join(repo, "native-mutated-by-fake-codex.txt");

const providerCalls = existsSync(logPath)
  ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
  : [];
const execInvocations = providerCalls
  .filter((call) => call.phase === "invoke" && call.argv?.[0] === "exec")
  .map((call) => ({ mode: call.mode, argv: call.argv, cwd: call.cwd }));

const summary = {
  environment: { platform: process.platform, node: process.version, spec: SPEC, root },
  doctor: { exit: doctor.code, stdout: doctor.stdout, stderr: doctor.stderr },
  auto: summarize(auto),
  explicit: summarize(explicit),
  workspaceWrite: summarize(workspaceWrite),
  unrestricted: summarize(unrestricted),
  structuredError: summarize(structuredError),
  emptyOutput: summarize(emptyOutput),
  malformedLines: summarize(malformedLines),
  authFailure: summarize(authFailure),
  earlyExit: summarize(earlyExit),
  timeout: summarize(timeout),
  agentMode: { exit: agentMode.code, stdout: agentMode.stdout, stderr: agentMode.stderr },
  readOnlyMutationProbe: {
    result: summarize(mutate),
    markerExists: existsSync(mutationMarker),
    markerContent: existsSync(mutationMarker) ? readFileSync(mutationMarker, "utf8") : undefined,
  },
  execInvocations,
  providerCalls,
};
console.log(JSON.stringify(summary, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `## GitGecko Codex exec follow-up\n\n- Auto review success: **${summary.auto.success}**.\n- Structured error mergeable: **${summary.structuredError.mergeable}**.\n- Empty output success/mergeable: **${summary.emptyOutput.success}/${summary.emptyOutput.mergeable}**.\n- Auth failure classification: **${summary.authFailure.failure}**.\n- Timeout classification: **${summary.timeout.failure}**.\n- Provider mutation despite requested read-only: **${summary.readOnlyMutationProbe.markerExists}**.\n`, { flag: "a" });
}
