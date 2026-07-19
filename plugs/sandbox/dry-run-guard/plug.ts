/**
 * gitgecko sandbox dry-run-guard — the second sandbox plug (INV-2.3 proving plug).
 *
 * THE INVARIANT (INV-2.3): the sandbox owner is EXCLUSIVE — one active backend at
 * a time. This plug proves the interchangeability invariant by being a real,
 * distinct backend that can be loaded INSTEAD OF the subprocess backend, against
 * the same SandboxBackend interface.
 *
 * WHAT THIS PLUG DOES: a policy-only backend that validates ExecSpecs against the
 * isolation policy (command blocklist, network deny, timeout, env constraints)
 * and returns a dry-run result describing what WOULD happen — without actually
 * spawning a process. Useful for:
 *  - CI pre-checks: verify specs would pass the security gate before running
 *  - Security audits: enumerate what a pipeline WOULD execute
 *  - Test environments: validate spec correctness without side effects
 *
 * HOW IT DIFFERS FROM plug-sandbox-backends: the backends plug provides
 * InMemorySandbox (simulated execution with registered handlers) and
 * SubprocessSandbox (real process execution). This plug provides a third mode:
 * policy validation only, no execution at all. All three implement the same
 * SandboxBackend interface — the orchestrator picks one.
 *
 * Salvaged pattern: pr-agent's "dry_run" mode + kodus-ai's policy pre-check.
 */
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import {
  deniedResult,
  okResult,
  validateSpec,
  type ExecResult,
  type ExecSpec,
  type SandboxBackend,
  type SandboxContribution,
} from "@gitgecko/sandbox";
import manifestJson from "./plug.manifest.json" with { type: "json" };

// --- Manifest (parsed, not cast) --------------------------------------------
const parsedManifest = parseManifest(manifestJson);
if (!parsedManifest.ok) {
  throw new Error(`sandbox-dry-run-guard manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
}
export const manifest: PlugManifest = parsedManifest.value;

// --- DryRunGuardSandbox: policy-only backend --------------------------------
//
// The backend validates the spec via validateSpec (the security gate) and returns
// a result describing the outcome. Denied specs return deniedResult with the
// policy reason. Valid specs return okResult with a dry-run marker in stdout,
// indicating the command WOULD be allowed to run — but was not executed.
//
// This backend is NOT isolated (it doesn't execute anything), but it IS safe
// by construction: it only reads the spec and runs the policy check.

export interface DryRunOptions {
  /** When true, include the full command in the dry-run output. Default true. */
  readonly echoCommand?: boolean;
  /** When true, include the env keys (not values) in the dry-run output. Default false. */
  readonly echoEnvKeys?: boolean;
}

export const createDryRunGuard = (opts: DryRunOptions = {}): SandboxBackend => {
  const echoCommand = opts.echoCommand ?? true;
  const echoEnvKeys = opts.echoEnvKeys ?? false;

  return {
    id: "dry-run-guard",
    isolated: false,

    exec: async (spec: ExecSpec): Promise<ExecResult> => {
      // Security gate first — same validateSpec the subprocess backend uses.
      const deny = validateSpec(spec);
      if (deny) return deniedResult(deny);

      // The spec passed the policy check. Return a dry-run result that describes
      // what WOULD run, without actually executing anything.
      const parts: string[] = ["[dry-run] command would be allowed"];
      if (echoCommand) {
        const fullCmd = spec.args && spec.args.length > 0
          ? `${spec.command} ${spec.args.join(" ")}`
          : spec.command;
        parts.push(`[dry-run] command: ${fullCmd}`);
      }
      if (spec.timeoutMs) {
        parts.push(`[dry-run] timeout: ${spec.timeoutMs}ms`);
      }
      if (spec.network === "allow") {
        parts.push("[dry-run] network: allow (opted in)");
      }
      if (echoEnvKeys && spec.env) {
        const keys = Object.keys(spec.env);
        if (keys.length > 0) parts.push(`[dry-run] env keys: ${keys.join(", ")}`);
      }
      if (spec.allowReadPaths && spec.allowReadPaths.length > 0) {
        parts.push(`[dry-run] read paths: ${spec.allowReadPaths.join(", ")}`);
      }
      if (spec.allowWritePaths && spec.allowWritePaths.length > 0) {
        parts.push(`[dry-run] write paths: ${spec.allowWritePaths.join(", ")}`);
      }

      return okResult(parts.join("\n"));
    },
  };
};

// --- Plug setup (registers the exec capability) -----------------------------
export async function setup(api: {
  register: (capability: "exec", contribution: SandboxContribution) => void;
}): Promise<void> {
  api.register("exec", {
    kind: "sandbox-backend",
    id: "dry-run-guard-backend",
    backend: createDryRunGuard(),
    // mutates: false — the dry-run guard does NOT execute anything, so it
    // does not mutate the filesystem or environment. This is the key difference
    // from the subprocess backend (mutates: true).
    mutates: false,
  });
}
