import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";

if (process.platform === "win32") throw new Error("native-probe.mjs currently targets POSIX provider invocation");
const NPX = "npx";
const SPEC = process.env.GITGECKO_SPEC ?? "gitgecko@latest";
const root = mkdtempSync(join(tmpdir(), "gitgecko-deep-native-"));
const repo = join(root, "repo");
const home = join(root, "home");
const cache = join(root, "npm-cache");
const bin = join(root, "bin");
const logPath = join(root, "codex-calls.ndjson");
for (const path of [repo, home, cache, bin]) mkdirSync(path, { recursive: true });

const fakeCodex = `#!/usr/bin/env node
const fs = require('node:fs');
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => stdin += chunk);
process.stdin.on('end', () => {
  const mode = process.env.FAKE_CODEX_MODE || 'normal';
  fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({
    mode,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    stdinLength: stdin.length,
    stdinPrefix: stdin.slice(0, 500),
    model: process.env.CODEX_MODEL || null,
  }) + '\\n');

  if (mode === 'timeout') return setTimeout(() => {}, 10_000);
  if (mode === 'auth-fail') {
    console.log(JSON.stringify({ type: 'error', message: '401 Unauthorized: synthetic Codex login failure' }));
    return;
  }
  if (mode === 'exit-early') {
    process.stderr.write('synthetic early provider exit');
    process.exit(13);
  }
  if (mode === 'mutate') fs.writeFileSync('native-mutated-by-fake-codex.txt', 'mutation occurred despite requested permission');

  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-codex-thread' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  if (mode === 'malformed-lines') {
    console.log('this is not JSON');
    console.log('{also:not-json}');
  }
  if (mode !== 'empty-output') {
    const text = mode === 'structured-error'
      ? '# Summary\\nSynthetic native review.\\n## Error\\n- Native provider reported a blocker.'
      : '# Summary\\nSynthetic native review.\\n## Warning\\n- Native provider warning.';
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
  }
  console.log(JSON.stringify({ type: 'turn.completed' }));
});
`;
writeFileSync(join(bin, "codex"), fakeCodex);
chmodSync(join(bin, "codex"), 0o755);
for (const name of ["claude", "opencode"]) {
  writeFileSync(join(bin, name), "#!/usr/bin/env sh\nexit 127\n");
  chmodSync(join(bin, name), 0o755);
}

const baseEnv = {
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

const run = (args, extraEnv = {}) => new Promise((resolvePromise) => {
  const started = process.hrtime.bigint();
  const child = spawn(NPX, ["--yes", SPEC, ...args], {
    cwd: repo,
    env: { ...baseEnv, ...extraEnv },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", (error) => resolvePromise({ code: -1, stdout, stderr, error: error.message, durationMs: 0 }));
  child.once("exit", (code, signal) => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    resolvePromise({ code: code ?? -1, signal, stdout, stderr, durationMs: Math.round(durationMs * 100) / 100 });
  });
});
const git = async (...args) => {
  const result = await new Promise((resolvePromise) => {
    const child = spawn("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code) => resolvePromise({ code, stderr }));
  });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
};
const parse = (result) => { try { return JSON.parse(result.stdout); } catch { return undefined; } };

await git("init", "-q");
await git("config", "user.name", "GitGecko Deep Bench");
await git("config", "user.email", "deep-bench@gitgecko.invalid");
writeFileSync(join(repo, "app.ts"), "export const before = false;\n");
await git("add", "app.ts");
await git("commit", "-qm", "baseline");
writeFileSync(join(repo, "app.ts"), "export const after = true;\n");

await run(["version"]);
const doctor = await run(["doctor"]);
const auto = await run(["review", "--json"], { FAKE_CODEX_MODE: "normal" });
const explicit = await run(["review", "--pathway", "codex", "--json"], { FAKE_CODEX_MODE: "normal" });
const workspaceWrite = await run(["review", "--pathway", "codex", "--permission", "workspace-write", "--json"], { FAKE_CODEX_MODE: "normal" });
const unrestricted = await run(["review", "--pathway", "codex", "--permission", "unrestricted", "--json"], { FAKE_CODEX_MODE: "normal" });
const agentMode = await run(["review", "--pathway", "codex", "--agent"], { FAKE_CODEX_MODE: "normal" });
const emptyOutput = await run(["review", "--pathway", "codex", "--json"], { FAKE_CODEX_MODE: "empty-output" });
const malformedLines = await run(["review", "--pathway", "codex", "--json"], { FAKE_CODEX_MODE: "malformed-lines" });
const structuredError = await run(["review", "--pathway", "codex", "--json"], { FAKE_CODEX_MODE: "structured-error" });
const authFail = await run(["review", "--pathway", "codex", "--json"], { FAKE_CODEX_MODE: "auth-fail" });
const earlyExit = await run(["review", "--pathway", "codex", "--json"], { FAKE_CODEX_MODE: "exit-early" });
const timeout = await run(["review", "--pathway", "codex", "--json"], { FAKE_CODEX_MODE: "timeout", CODEX_TIMEOUT_MS: "250" });
const mutate = await run(["review", "--pathway", "codex", "--json"], { FAKE_CODEX_MODE: "mutate" });
const mutationMarker = join(repo, "native-mutated-by-fake-codex.txt");

const calls = existsSync(logPath)
  ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
  : [];
const summarize = (result) => {
  const value = parse(result);
  return {
    exit: result.code,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    parsed: Boolean(value),
    success: value?.success,
    failure: value?.failure,
    output: value?.output,
    pathway: value?.pathwayResolution,
    mergeable: value?.artifact?.mergeable,
    findings: value?.artifact?.findings,
    diagnostics: value?.diagnostics,
  };
};

const summary = {
  environment: { platform: process.platform, node: process.version, spec: SPEC, root, fakeBin: bin },
  doctor: { exit: doctor.code, stdout: doctor.stdout, stderr: doctor.stderr },
  auto: summarize(auto),
  explicit: summarize(explicit),
  workspaceWrite: summarize(workspaceWrite),
  unrestricted: summarize(unrestricted),
  agentMode: { exit: agentMode.code, stdout: agentMode.stdout, stderr: agentMode.stderr },
  emptyOutput: summarize(emptyOutput),
  malformedLines: summarize(malformedLines),
  structuredError: summarize(structuredError),
  authFailure: summarize(authFail),
  earlyExit: summarize(earlyExit),
  timeout: summarize(timeout),
  readOnlyMutationProbe: {
    result: summarize(mutate),
    markerExists: existsSync(mutationMarker),
    markerContent: existsSync(mutationMarker) ? readFileSync(mutationMarker, "utf8") : undefined,
  },
  providerCalls: calls,
  permissionArguments: calls.filter((call) => call.mode === "normal").map((call) => ({ argv: call.argv, cwd: call.cwd, stdinLength: call.stdinLength })),
};

console.log(JSON.stringify(summary, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  const line = `## GitGecko installed-agent probe\n\n- Auto selected: **${summary.auto.pathway?.binary ?? summary.auto.pathway?.family ?? "unknown"}**.\n- Empty provider output success: **${summary.emptyOutput.success}**, mergeable: **${summary.emptyOutput.mergeable}**.\n- Malformed additive stdout tolerated: **${summary.malformedLines.success}**.\n- Timeout classified as: **${summary.timeout.failure ?? "unknown"}**.\n- Fake provider mutated under read-only request: **${summary.readOnlyMutationProbe.markerExists}**.\n`;
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, line, { flag: "a" });
}
