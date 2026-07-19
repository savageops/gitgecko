/**
 * @gitgecko/cli/doctor — the self-diagnostic command (`gitgecko doctor`).
 *
 * THE WEDGE: the "do it better" delta vs every competitor's onboarding. A noob's
 * first command can be `gitgecko doctor` and it tells them exactly what is wired
 * and what to fix — node version, installed CLI detection (the A13 local-path
 * wedge), model-key/endpoint presence, and the pathway that `auto` would resolve.
 * CodeRabbit ships `cr doctor`; pr-agent and the open alternatives ship nothing.
 * GitGecko's doctor is richer: it reports the *pathway* the review would use, not
 * just install health.
 *
 * This is a pure, typed, testable function — not inlined in the bin. The bin
 * delegates here so the command logic is unit-testable without spawning node.
 */
import { productIdentity } from "@gitgecko/core";
import { executeNativeCommand } from "@gitgecko/review/native-command";
import type { ModelProviderConfig } from "./config.js";

/** A single line of the doctor report. */
export interface DoctorCheck {
  readonly ok: boolean;
  readonly label: string;
  readonly detail?: string;
}

/** The result of a doctor run — the checks + the resolved pathway verdict. */
export interface DoctorReport {
  readonly version: string;
  readonly checks: readonly DoctorCheck[];
  /** The pathway `auto` would resolve to, or null if the runtime itself is unusable. */
  readonly pathway: { readonly kind: string; readonly binary?: string } | null;
  /** The one-line readiness verdict + the next action. */
  readonly verdict: string;
}

/** Read the installed GitGecko version (from package.json at build time). */
export { GITGECKO_VERSION } from "./version.js";
import { GITGECKO_VERSION } from "./version.js";

/** The minimum Node major version (matches package.json engines). */
export const MIN_NODE_MAJOR = 22;

/**
 * Probe whether a native coding agent is on PATH. Returns the binaries found.
 * Injected (not hardcoded `execFileSync`) so tests can stub it — no real
 * subprocess spawn in the unit test.
 */
export type NativeProbe = (binary: string) => boolean;

/** The real probe resolves Windows shims without exposing a command shell. */
export const createRealNativeProbe = (): NativeProbe => (binary: string): boolean => {
  try {
    executeNativeCommand(binary, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** The native binaries GitGecko auto-detects (goal §1.1, A13). Preference order. */
const NATIVE_BINARIES = ["codex", "claude", "opencode"] as const;

/**
 * Run the doctor diagnostic. Pure given its inputs — no I/O of its own except
 * the injected `probeNatives`. The bin wires the real probe; tests inject a fake.
 *
 * @param env - the environment (defaults to process.env) — model keys + endpoint.
 * @param probeNatives - the native-agent PATH probe (defaults to the real one).
 */
export const runDoctor = (
  env: NodeJS.ProcessEnv = process.env,
  probeNatives: NativeProbe = createRealNativeProbe(),
  savedProvider?: ModelProviderConfig,
): DoctorReport => {
  const checks: DoctorCheck[] = [];

  // 1. Node version (engines: >=22).
  const nodeMajor = parseInt(process.versions.node.split(".")[0]!, 10);
  const nodeDetail = nodeMajor >= MIN_NODE_MAJOR ? undefined : `(GitGecko needs >= ${MIN_NODE_MAJOR})`;
  checks.push({
    ok: nodeMajor >= MIN_NODE_MAJOR,
    label: `node ${process.versions.node}`,
    ...(nodeDetail !== undefined && { detail: nodeDetail }),
  });

  // 2. Installed coding CLI detection (the local-path wedge — A13).
  const detected = NATIVE_BINARIES.filter(probeNatives);
  if (detected.length > 0) {
    checks.push({ ok: true, label: `installed coding CLI(s): ${detected.join(", ")}` });
  } else {
    checks.push({
      ok: true, // not an error — just informational
      label: "no supported coding CLI found (rule-only review is available; install codex, claude, or opencode for agent review)",
    });
  }

  // 3. Model key / endpoint (Pi owns direct model execution).
  const hasAnthropic = Boolean(env.ANTHROPIC_API_KEY);
  const hasOpenai = Boolean(env.OPENAI_API_KEY);
  const localEndpointName = env.GITGECKO_LOCAL_BASE_URL ? "GITGECKO_LOCAL_BASE_URL" : env.OPENAI_BASE_URL ? "OPENAI_BASE_URL" : undefined;
  const hasLocal = Boolean(localEndpointName || savedProvider);
  if (hasAnthropic) checks.push({ ok: true, label: "model key set (ANTHROPIC_API_KEY)" });
  if (hasOpenai) checks.push({ ok: true, label: "model key set (OPENAI_API_KEY)" });
  if (localEndpointName) checks.push({ ok: true, label: `local endpoint set (${localEndpointName})` });
  if (savedProvider) checks.push({ ok: true, label: `saved local endpoint (${savedProvider.model}, ${savedProvider.protocol})` });

  // 4. Resolve the pathway + verdict.
  let pathway: DoctorReport["pathway"] = null;
  let verdict: string;
  if (detected.length > 0) {
    const first = detected[0] as string;
    pathway = { kind: "native", binary: first };
    verdict = `pathway (auto): ${first} (installed CLI). Run "${productIdentity.cliCommand} review"; its authentication is verified when the CLI starts.`;
  } else if (hasLocal) {
    pathway = { kind: "pi" };
    verdict = `pathway (auto): pi (configured model provider). Available: run "${productIdentity.cliCommand} review"; endpoint authentication is verified when it starts.`;
  } else if (hasAnthropic || hasOpenai) {
    pathway = { kind: "native-loop" };
    verdict = `pathway (auto): API-backed model route. Run "${productIdentity.cliCommand} review"; provider authentication is verified when it starts.`;
  } else {
    pathway = { kind: "deterministic" };
    verdict = `pathway (auto): rule-only review. Run "${productIdentity.cliCommand} review"; install a coding CLI or configure a model route for agent review.`;
  }

  return { version: GITGECKO_VERSION, checks, pathway, verdict };
};

/** Render a DoctorReport as the human-readable console output. */
export const renderDoctor = (report: DoctorReport): string => {
  const lines = [`${productIdentity.cliCommand} ${report.version} — doctor`, ""];
  for (const c of report.checks) {
    const mark = c.ok ? "✓" : "✗";
    lines.push(`  ${mark} ${c.label}${c.detail ? ` ${c.detail}` : ""}`);
  }
  lines.push("", `  → ${report.verdict}`);
  return lines.join("\n");
};
