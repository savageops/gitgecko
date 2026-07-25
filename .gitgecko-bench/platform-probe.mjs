import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const SPEC = process.env.GITGECKO_SPEC ?? "gitgecko@latest";
const root = mkdtempSync(join(tmpdir(), "gitgecko-platform-"));
const repo = join(root, "repo with spaces ünicode");
const home = join(root, "home");
const cache = join(root, "npm-cache");
for (const path of [repo, home, cache]) mkdirSync(path, { recursive: true });
const env = {
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
const run = (command, args, cwd = repo) => {
  const started = process.hrtime.bigint();
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return {
    code: result.status ?? (result.error ? -1 : 0),
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message,
    durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100,
  };
};
const gg = (args) => run(NPX, ["--yes", SPEC, ...args]);
const git = (...args) => {
  const result = run("git", args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
};
const parse = (result) => { try { return JSON.parse(result.stdout); } catch { return undefined; } };

const coldVersion = gg(["version"]);
const doctor = gg(["doctor"]);
git("init", "-q");
git("config", "user.name", "GitGecko Platform Bench");
git("config", "user.email", "platform@gitgecko.invalid");
writeFileSync(join(repo, "tracked.ts"), "export const baseline = true;\n");
git("add", "tracked.ts");
git("commit", "-qm", "baseline");
writeFileSync(join(repo, "tracked.ts"), "export const changed = eval(\"1+1\");\r\n");
writeFileSync(join(repo, "space ünicode.ts"), "export const apiKey = \"PLATFORM_0123456789ABCDEF\";\r\n");
writeFileSync(join(repo, "binary.ts"), Buffer.from([0, 101, 118, 97, 108, 40, 49, 41, 10, 255]));

const implicit = gg(["review", "--pathway", "deterministic", "--json"]);
const relative = gg(["review", "--pathway", "deterministic", "--file", "space ünicode.ts", "--json"]);
const absolutePath = resolve(repo, "space ünicode.ts");
const absolute = gg(["review", "--pathway", "deterministic", "--file", absolutePath, "--json"]);
const binary = gg(["review", "--pathway", "deterministic", "--file", "binary.ts", "--json"]);
const agent = gg(["review", "--pathway", "deterministic", "--agent"]);
const warmDurations = [];
for (let index = 0; index < 5; index += 1) warmDurations.push(gg(["review", "--pathway", "deterministic", "--json"]).durationMs);

const summarize = (result) => {
  const value = parse(result);
  return {
    exit: result.code,
    durationMs: result.durationMs,
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderr: result.stderr,
    error: result.error,
    parsed: Boolean(value),
    success: value?.success,
    mergeable: value?.artifact?.mergeable,
    files: value?.artifact?.files,
    findings: value?.artifact?.findings?.map((finding) => ({ ruleId: finding.ruleId, severity: finding.severity, file: finding.file, line: finding.line })),
  };
};
const summary = {
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    spec: SPEC,
    root,
    repo,
    absolutePath,
  },
  coldVersion: { exit: coldVersion.code, stdout: coldVersion.stdout.trim(), stderr: coldVersion.stderr.trim(), durationMs: coldVersion.durationMs },
  doctor: { exit: doctor.code, stdout: doctor.stdout.trim(), stderr: doctor.stderr.trim(), durationMs: doctor.durationMs },
  implicit: summarize(implicit),
  relativeUnicodePath: summarize(relative),
  absoluteUnicodePath: summarize(absolute),
  binaryUtf8Path: summarize(binary),
  agentMode: { exit: agent.code, stdout: agent.stdout, stderr: agent.stderr },
  warmReviewDurationsMs: warmDurations,
};
console.log(JSON.stringify(summary, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  const sorted = [...warmDurations].sort((a, b) => a - b);
  const line = `## ${process.platform}/${process.arch} GitGecko probe\n\n- Version: **${coldVersion.stdout.trim()}**.\n- Cold invocation: **${coldVersion.durationMs} ms**.\n- Warm review p50: **${sorted[Math.floor(sorted.length / 2)]} ms**.\n- Relative Unicode path parsed: **${summary.relativeUnicodePath.parsed}**.\n- Absolute Unicode path parsed: **${summary.absoluteUnicodePath.parsed}**.\n`;
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, line, { flag: "a" });
}
