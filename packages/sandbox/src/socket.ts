/**
 * @gitgecko/sandbox/socket — the SandboxSocket contract + isolation model.
 *
 * Implements the `sandbox` owner from 02-architecture-overview §2.
 * Isolated execution for tools, linters, SAST, autofix, TREX-equivalent (GP-§8e).
 *
 * THE SECURITY WEDGE: CodeRabbit's broadly-installed GitHub App with write
 * scope = "1M repos" blast radius (CR-§4.1, Kudelski/Endor Labs). gitgecko
 * sandboxes untrusted PR content + model output BEFORE it touches anything.
 * The sandbox is the isolation layer that makes autonomous remediation safe.
 *
 * The contract: exec(spec) → result. The spec carries the command + constraints
 * (cwd, env, timeout, network policy, fs policy). The backend (in-memory for
 * tests, subprocess for local, e2b/gvisor/firecracker for prod) enforces them.
 */
import type { OwnerSpec } from "@gitgecko/socket";

/** An execution spec — what to run + under what constraints. */
export interface ExecSpec {
  /** The command to execute (e.g. "eslint src/", "python -m pytest", "npm test"). */
  readonly command: string;
  /** Arguments (split for safety — no shell interpolation). */
  readonly args?: readonly string[];
  /** Working directory (relative to the sandbox root). */
  readonly cwd?: string;
  /** Environment variables (deny-by-default — only these are passed). */
  readonly env?: Readonly<Record<string, string>>;
  /** Timeout in ms (the sandbox kills the process if exceeded). */
  readonly timeoutMs?: number;
  /** Maximum retained bytes per output channel while the process is running. */
  readonly maxOutputBytes?: number;
  /** Network policy: "deny" (default, air-gapped) | "allow" (explicit opt-in). */
  readonly network?: "deny" | "allow";
  /** Filesystem paths the command may read. */
  readonly allowReadPaths?: readonly string[];
  /** Filesystem paths the command may write. */
  readonly allowWritePaths?: readonly string[];
}

/** The result of an execution. */
export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True if the process was killed for exceeding timeoutMs. */
  readonly timedOut: boolean;
  /** True when either output channel exceeded maxOutputBytes. */
  readonly outputTruncated?: boolean;
  /** True if the spec was rejected by the isolation policy (before exec). */
  readonly denied: boolean;
  /** Why it was denied (if denied). */
  readonly denyReason?: string;
}

/** Convenience: a successful result. */
export const okResult = (stdout: string, exitCode = 0): ExecResult => ({
  exitCode, stdout, stderr: "", timedOut: false, denied: false,
});

/** Convenience: a denied result. */
export const deniedResult = (reason: string): ExecResult => ({
  exitCode: -1, stdout: "", stderr: "", timedOut: false, denied: true, denyReason: reason,
});

/** Convenience: a timed-out result. */
export const timeoutResult = (partial: string): ExecResult => ({
  exitCode: -1, stdout: partial, stderr: "Process timed out", timedOut: true, denied: false,
});

/** The sandbox backend interface — exec is the only method. */
export interface SandboxBackend {
  readonly id: string;
  readonly exec: (spec: ExecSpec) => Promise<ExecResult>;
  /** Whether this backend enforces true isolation (vs in-memory simulation). */
  readonly isolated: boolean;
}

/** The sandbox owner's capabilities. */
export type SandboxCapability = "exec";

/** Contribution: a sandbox backend plug (in-memory, subprocess, e2b, gvisor, firecracker). */
export interface SandboxContribution {
  readonly kind: "sandbox-backend";
  readonly id: string;
  readonly backend: SandboxBackend;
  readonly mutates?: boolean; // sandbox exec mutates by definition
}

export const sandboxOwner: OwnerSpec<SandboxCapability, string> = {
  name: "sandbox",
  capabilities: ["exec"],
  // EXCLUSIVE: one active sandbox backend at a time (the orchestrator picks one).
  exclusive: () => true,
  kindFor: () => "sandbox-backend",
};

/**
 * The isolation policy — validates an ExecSpec against the sandbox's constraints
 * BEFORE execution. This is the security gate. Returns a deny reason or null.
 *
 * Default policy (deny-by-default, the security wedge):
 *  - network: denied unless spec.network === "allow"
 *  - fs: the command may only touch allowReadPaths/allowWritePaths
 *  - command: blocklisted commands are rejected (rm -rf /, etc.)
 */
export const COMMAND_BLOCKLIST = [
  /\b\x72m(?:\.exe)?\s+(?=[^\r\n]*(?:-[a-z]*r[a-z]*|--recursive)(?:\s|$))[^\r\n]*(?:^|\s)\/(?:\s|$)/i,
  /\brm\s+-rf\s+\/(\s|$)/, // rm -rf /
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\//,
  /\bshutdown\b/,
  /\breboot\b/,
] as const;

export const validateSpec = (spec: ExecSpec, opts: { allowNetwork?: boolean } = {}): string | null => {
  if (spec.maxOutputBytes !== undefined && (!Number.isSafeInteger(spec.maxOutputBytes) || spec.maxOutputBytes <= 0)) {
    return "maxOutputBytes must be a positive safe integer";
  }
  // Command blocklist
  const fullCmd = `${spec.command} ${(spec.args ?? []).join(" ")}`;
  for (const pattern of COMMAND_BLOCKLIST) {
    if (pattern.test(fullCmd)) return `blocked command: matches ${pattern.source}`;
  }
  // Network policy
  if (spec.network === "allow" && !opts.allowNetwork) {
    return "network access denied (sandbox is air-gapped by default)";
  }
  return null; // valid
};
