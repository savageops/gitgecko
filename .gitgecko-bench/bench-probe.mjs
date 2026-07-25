import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

if (process.platform !== "linux") throw new Error("bench-probe.mjs is Linux-specific");
const SPEC = process.env.GITGECKO_SPEC ?? "gitgecko@latest";
const root = mkdtempSync(join(tmpdir(), "gitgecko-deep-bench-"));
const home = join(root, "home");
const cache = join(root, "npm-cache");
const repo = join(root, "repo");
for (const path of [home, cache, repo]) mkdirSync(path, { recursive: true });

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

const runSync = (command, args, options = {}) => {
  const started = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repo,
    env: { ...baseEnv, ...(options.env ?? {}) },
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
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
const npx = (args, options = {}) => runSync("npx", ["--yes", SPEC, ...args], options);
const git = (...args) => {
  const result = runSync("git", args, { cwd: repo });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
};
const percentile = (values, p) => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
};
const stats = (values) => ({
  samples: values.length,
  minMs: Math.min(...values),
  p50Ms: percentile(values, 50),
  p95Ms: percentile(values, 95),
  maxMs: Math.max(...values),
  meanMs: Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100,
});
const parseTimeV = (text) => {
  const value = (label) => {
    const match = text.match(new RegExp(`${label}:\\s*(.+)`));
    return match?.[1]?.trim();
  };
  return {
    userSeconds: Number(value("User time \\(seconds\\)")),
    systemSeconds: Number(value("System time \\(seconds\\)")),
    elapsed: value("Elapsed \\(wall clock\\) time \\(h:mm:ss or m:ss\\)"),
    maxRssKb: Number(value("Maximum resident set size \\(kbytes\\)")),
    majorFaults: Number(value("Major \\(requiring I/O\\) page faults")),
    minorFaults: Number(value("Minor \\(reclaiming a frame\\) page faults")),
    voluntaryContextSwitches: Number(value("Voluntary context switches")),
    involuntaryContextSwitches: Number(value("Involuntary context switches")),
  };
};
const timedNpx = (name, args, options = {}) => {
  const metricsPath = join(root, `${name}.time.txt`);
  const outputPath = join(root, `${name}.stdout`);
  const errorPath = join(root, `${name}.stderr`);
  const shell = `set +e; /usr/bin/time -v -o ${JSON.stringify(metricsPath)} npx --yes ${SPEC} ${args.map((arg) => JSON.stringify(arg)).join(" ")} > ${JSON.stringify(outputPath)} 2> ${JSON.stringify(errorPath)}; printf '%s' $?`;
  const wrapper = runSync("bash", ["-lc", shell], { cwd: options.cwd ?? repo, env: options.env, maxBuffer: 4 * 1024 * 1024 });
  const code = Number(wrapper.stdout.trim());
  const stdoutBytes = statSync(outputPath).size;
  const stderrBytes = statSync(errorPath).size;
  const metrics = parseTimeV(readFileSync(metricsPath, "utf8"));
  return {
    code,
    stdoutBytes,
    stderrBytes,
    stderr: readFileSync(errorPath, "utf8").slice(0, 2_000),
    metrics,
    outputPath,
  };
};

// Ordinary small repository used for warm-path measurements.
git("init", "-q");
git("config", "user.name", "GitGecko Deep Bench");
git("config", "user.email", "deep-bench@gitgecko.invalid");
writeFileSync(join(repo, "app.ts"), "export const safe = true;\n");
git("add", "app.ts");
git("commit", "-qm", "baseline");
writeFileSync(join(repo, "app.ts"), "export const unsafe = eval(\"1+1\");\n");

const metadata = runSync("npm", ["view", "gitgecko", "name", "version", "dist-tags", "versions", "engines", "dependencies", "dist.unpackedSize", "dist.fileCount", "dist.integrity", "dist.tarball", "time", "--json"], { cwd: root });
let parsedMetadata;
try { parsedMetadata = JSON.parse(metadata.stdout); } catch { parsedMetadata = { parseError: true, stdout: metadata.stdout }; }

const pack = runSync("npm", ["pack", SPEC, "--json"], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
let packInfo;
try { packInfo = JSON.parse(pack.stdout)?.[0]; } catch { packInfo = { raw: pack.stdout }; }
let tarEntries = [];
let packedBytes;
if (packInfo?.filename) {
  const tarball = join(root, packInfo.filename);
  packedBytes = statSync(tarball).size;
  const listing = runSync("tar", ["-tzf", tarball], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  tarEntries = listing.stdout.trim().split(/\r?\n/).filter(Boolean);
}

const installRoot = join(root, "installed");
mkdirSync(installRoot, { recursive: true });
const install = runSync("npm", ["install", "--prefix", installRoot, SPEC, "--ignore-scripts=false", "--no-package-lock"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const installSize = runSync("du", ["-sk", installRoot], { cwd: root });
const installedKb = Number(installSize.stdout.trim().split(/\s+/)[0]);

// Cold means an isolated npm cache and HOME on every invocation.
const coldVersion = [];
for (let index = 0; index < 4; index += 1) {
  const coldHome = join(root, `cold-home-${index}`);
  const coldCache = join(root, `cold-cache-${index}`);
  mkdirSync(coldHome, { recursive: true });
  mkdirSync(coldCache, { recursive: true });
  coldVersion.push(npx(["version"], { env: { HOME: coldHome, npm_config_cache: coldCache } }));
}

// Warm the ordinary cache, then measure low-variance command paths.
npx(["version"]);
const warmVersion = [];
const warmDoctor = [];
const warmReview = [];
for (let index = 0; index < 20; index += 1) warmVersion.push(npx(["version"]).durationMs);
for (let index = 0; index < 10; index += 1) warmDoctor.push(npx(["doctor"]).durationMs);
for (let index = 0; index < 20; index += 1) warmReview.push(npx(["review", "--pathway", "deterministic", "--json"]).durationMs);

// Findings scale: output volume grows independently from input bytes.
const findingScales = [];
for (const count of [1, 10, 100, 1_000, 5_000, 10_000]) {
  const path = join(repo, `findings-${count}.ts`);
  const lines = Array.from({ length: count }, (_, index) => `export const finding_${index} = eval(\"${index}\");`).join("\n") + "\n";
  writeFileSync(path, lines);
  const probe = timedNpx(`findings-${count}`, ["review", "--pathway", "deterministic", "--file", basename(path), "--json"]);
  let parsed;
  try { parsed = JSON.parse(readFileSync(probe.outputPath, "utf8")); } catch { parsed = undefined; }
  findingScales.push({
    count,
    inputBytes: Buffer.byteLength(lines),
    ...probe,
    parsed: Boolean(parsed),
    findingCount: parsed?.artifact?.findings?.length,
    mergeable: parsed?.artifact?.mergeable,
  });
}

// Input-byte scale with a single finding at the tail. JSON output retains addedSource.
const byteScales = [];
for (const sizeMb of [1, 5, 15, 32]) {
  const path = join(repo, `bytes-${sizeMb}mb.ts`);
  const targetBytes = sizeMb * 1024 * 1024;
  const prefix = "// filler filler filler filler filler filler filler filler filler filler\n";
  const repetitions = Math.ceil((targetBytes - 64) / Buffer.byteLength(prefix));
  const source = prefix.repeat(repetitions).slice(0, targetBytes - 50) + "\nexport const tail = eval(\"1+1\");\n";
  writeFileSync(path, source);
  const jsonProbe = timedNpx(`bytes-${sizeMb}mb-json`, ["review", "--pathway", "deterministic", "--file", basename(path), "--json"]);
  const agentProbe = timedNpx(`bytes-${sizeMb}mb-agent`, ["review", "--pathway", "deterministic", "--file", basename(path), "--agent"]);
  byteScales.push({
    sizeMb,
    inputBytes: Buffer.byteLength(source),
    json: jsonProbe,
    agent: agentProbe,
    jsonOutputAmplification: Math.round((jsonProbe.stdoutBytes / Buffer.byteLength(source)) * 1000) / 1000,
  });
}

// The implicit git-diff path advertises a 64 MiB bound. Challenge it with a 70 MiB single-line text change.
const largeDiffRepo = join(root, "large-diff-repo");
mkdirSync(largeDiffRepo, { recursive: true });
runSync("git", ["init", "-q"], { cwd: largeDiffRepo });
runSync("git", ["config", "user.name", "GitGecko Deep Bench"], { cwd: largeDiffRepo });
runSync("git", ["config", "user.email", "deep-bench@gitgecko.invalid"], { cwd: largeDiffRepo });
writeFileSync(join(largeDiffRepo, "huge.txt"), "baseline\n");
runSync("git", ["add", "huge.txt"], { cwd: largeDiffRepo });
runSync("git", ["commit", "-qm", "baseline"], { cwd: largeDiffRepo });
writeFileSync(join(largeDiffRepo, "huge.txt"), `${"a".repeat(70 * 1024 * 1024)}\n`);
const implicit70Mb = npx(["review", "--pathway", "deterministic", "--json"], { cwd: largeDiffRepo, maxBuffer: 16 * 1024 * 1024 });
let implicit70MbJson;
try { implicit70MbJson = JSON.parse(implicit70Mb.stdout); } catch { implicit70MbJson = undefined; }

// Parallel warm reviews expose cache contention and process-level scaling.
const parallelStarted = process.hrtime.bigint();
const parallel = await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise((resolvePromise) => {
  const child = spawn("npx", ["--yes", SPEC, "review", "--pathway", "deterministic", "--json"], {
    cwd: repo,
    env: baseEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdoutBytes = 0, stderr = "";
  child.stdout.on("data", (chunk) => { stdoutBytes += chunk.length; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("exit", (code, signal) => resolvePromise({ index, code, signal, stdoutBytes, stderr }));
})));
const parallelWallMs = Number(process.hrtime.bigint() - parallelStarted) / 1e6;

const summary = {
  environment: { platform: process.platform, node: process.version, spec: SPEC, root },
  registry: {
    npmViewExit: metadata.code,
    metadata: parsedMetadata,
    packExit: pack.code,
    packInfo,
    packedBytes,
    tarEntryCount: tarEntries.length,
    tarEntries,
    installExit: install.code,
    installStderr: install.stderr.slice(0, 4_000),
    installedKb,
  },
  startup: {
    coldVersion: coldVersion.map((result) => ({ code: result.code, durationMs: result.durationMs, stdout: result.stdout.trim(), stderr: result.stderr.trim() })),
    coldVersionStats: stats(coldVersion.map((result) => result.durationMs)),
    warmVersion: stats(warmVersion),
    warmDoctor: stats(warmDoctor),
    warmSmallReview: stats(warmReview),
  },
  findingScales,
  byteScales,
  implicit70Mb: {
    exit: implicit70Mb.code,
    durationMs: implicit70Mb.durationMs,
    parsedJson: Boolean(implicit70MbJson),
    result: implicit70MbJson,
    stdout: implicit70Mb.stdout.slice(0, 4_000),
    stderr: implicit70Mb.stderr.slice(0, 4_000),
    processError: implicit70Mb.error,
  },
  parallel8: {
    wallMs: Math.round(parallelWallMs * 100) / 100,
    results: parallel,
  },
};

console.log(JSON.stringify(summary, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  const largestFindings = findingScales.at(-1);
  const largestBytes = byteScales.at(-1);
  const line = `## GitGecko scale/performance probe\n\n- Cold version p50: **${summary.startup.coldVersionStats.p50Ms} ms**.\n- Warm version p50: **${summary.startup.warmVersion.p50Ms} ms**.\n- Warm small review p50: **${summary.startup.warmSmallReview.p50Ms} ms**.\n- ${largestFindings.count.toLocaleString()} findings: **${largestFindings.metrics.maxRssKb.toLocaleString()} KiB RSS**, **${largestFindings.stdoutBytes.toLocaleString()} output bytes**.\n- ${largestBytes.sizeMb} MiB file JSON: **${largestBytes.json.metrics.maxRssKb.toLocaleString()} KiB RSS**, output amplification **${largestBytes.jsonOutputAmplification}x**.\n- Eight parallel reviews wall time: **${summary.parallel8.wallMs} ms**.\n- 70 MiB implicit diff rejected: **${summary.implicit70Mb.exit !== 0}**.\n`;
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, line, { flag: "a" });
}
