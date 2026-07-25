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
const path = require('node:path');
const readline = require('node:readline');
const args = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE || 'normal';
const log = (entry) => fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({
  at: new Date().toISOString(),
  mode,
  argv: args,
  cwd: process.cwd(),
  ...entry,
}) + '\\n');

log({ phase: 'invoke' });
if (args[0] === '--version') {
  console.log('codex-cli 0.144.1');
  process.exit(0);
}

if (args[0] === 'app-server' && args[1] === 'generate-json-schema') {
  const outIndex = args.indexOf('--out');
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
  if (!out) {
    process.stderr.write('missing --out');
    process.exit(2);
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'codex_app_server_protocol.schemas.json'), JSON.stringify({
    schemaVersion: 'fake-codex-app-server.v1',
    methods: ['initialize', 'thread/start', 'thread/resume', 'turn/start', 'turn/interrupt'],
  }));
  log({ phase: 'schema-generated', out });
  process.exit(0);
}

if (args.length === 1 && args[0] === 'app-server') {
  const rl = readline.createInterface({ input: process.stdin });
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  const threadId = 'fake-codex-thread';
  const turnId = 'fake-codex-turn';
  rl.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); }
    catch {
      log({ phase: 'invalid-request', line });
      return;
    }
    log({ phase: 'rpc', message });
    if (message.method === 'initialize') {
      send({ id: message.id, result: { userAgent: 'fake-codex/0.144.1' } });
      return;
    }
    if (message.method === 'initialized') return;
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      send({ id: message.id, result: { thread: { id: threadId } } });
      return;
    }
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
      if (mode === 'exit-early') {
        process.stderr.write('synthetic early provider exit');
        process.exit(13);
      }
      if (mode === 'malformed-lines') {
        process.stdout.write('this is not JSON\\n');
        return;
      }
      if (mode === 'auth-fail') {
        send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'failed', error: { message: '401 Unauthorized: synthetic Codex login failure' } } } });
        return;
      }
      if (mode === 'timeout') return;
      if (mode === 'mutate') {
        fs.writeFileSync('native-mutated-by-fake-codex.txt', 'mutation occurred despite requested permission');
      }
      if (mode !== 'empty-output') {
        const text = mode === 'structured-error'
          ? '# Summary\\nSynthetic native review.\\n## Error\\n- Native provider reported a blocker.'
          : '# Summary\\nSynthetic native review.\\n## Warning\\n- Native provider warning.';
        send({ method: 'item/completed', params: { item: { type: 'agentMessage', text } } });
      }
      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
      return;
    }
    if (message.method === 'turn/interrupt') {
      if (typeof message.id === 'number') send({ id: message.id, result: {} });
      process.exit(0);
    }
  });
  return;
}

process.stderr.write('unsupported fake Codex invocation: ' + args.join(' '));
process.exit(2);
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
const rpcCalls = calls.filter((call) => call.phase === "rpc");
const turnStarts = rpcCalls.filter((call) => call.message?.method === "turn/start").map((call) => ({ mode: call.mode, params: call.message.params }));
const threadStarts = rpcCalls.filter((call) => call.message?.method === "thread/start").map((call) => ({ mode: call.mode, params: call.message.params }));

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
  threadStarts,
  turnStarts,
};

console.log(JSON.stringify(summary, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  const line = `## GitGecko installed-agent probe v2\n\n- Auto selected: **${summary.auto.pathway?.binary ?? summary.auto.pathway?.family ?? "unknown"}**.\n- Empty provider output success: **${summary.emptyOutput.success}**, mergeable: **${summary.emptyOutput.mergeable}**.\n- Malformed stdout classified as: **${summary.malformedLines.failure ?? "unknown"}**.\n- Timeout classified as: **${summary.timeout.failure ?? "unknown"}**.\n- Fake provider mutated under read-only request: **${summary.readOnlyMutationProbe.markerExists}**.\n`;
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, line, { flag: "a" });
}
