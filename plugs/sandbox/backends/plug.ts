/**
 * gitgecko sandbox plug — backends (in-memory + subprocess).
 *
 * Two interchangeable SandboxBackend impls behind the same interface (02 §2):
 *  - InMemorySandbox: simulated execution (for tests — no real process). Commands
 *    are registered with handlers; unregistered → exitCode 127. isolated: false.
 *  - SubprocessSandbox: trusted-local child_process.spawn with timeout and a
 *    constrained environment. It is not an isolation boundary.
 *
 * Production swaps in e2b/gvisor/firecracker behind the SAME SandboxBackend
 * interface — the socket contract is uniform (INV-2.3).
 *
 * Both backends validate specs via validateSpec BEFORE execution (the security
 * gate — CR-§4.1 blast-radius wedge). Blocklisted commands are denied.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import {
  deniedResult,
  timeoutResult,
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
  throw new Error(`sandbox-backends manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
}
export const manifest: PlugManifest = parsedManifest.value;

// --- InMemorySandbox: simulated execution (for tests) -----------------------
type InMemoryHandler = (args: readonly string[], env: Readonly<Record<string, string>>) => {
  exitCode: number; stdout: string; stderr: string;
};

export class InMemorySandbox implements SandboxBackend {
  readonly id = "in-memory";
  readonly isolated = false;
  private readonly handlers = new Map<string, InMemoryHandler>();

  register(command: string, handler: InMemoryHandler): void {
    this.handlers.set(command, handler);
  }

  async exec(spec: ExecSpec): Promise<ExecResult> {
    // Security gate first
    const deny = validateSpec(spec);
    if (deny) return deniedResult(deny);

    const handler = this.handlers.get(spec.command);
    if (!handler) {
      return {
        exitCode: 127,
        stdout: "",
        stderr: `${spec.command}: command not found (not registered in InMemorySandbox)`,
        timedOut: false,
        denied: false,
      };
    }
    const result = handler(spec.args ?? [], spec.env ?? {});
    return { ...result, timedOut: false, denied: false };
  }
}

// --- SubprocessSandbox: real process execution (local dev) ------------------
/** Keep launcher-critical variables without inheriting the user's complete environment. */
const executionEnvironment = (overrides: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv => {
  const names = process.platform === "win32"
    ? ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"]
    : ["PATH", "TMPDIR", "TMP", "TEMP"];
  const base = Object.fromEntries(
    names.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]),
  );
  return { ...base, ...overrides };
};

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;

/** Retain only a bounded UTF-8 prefix while preserving decoder state across chunks. */
const boundedOutput = (maxBytes: number) => {
  const decoder = new TextDecoder();
  let bytes = 0;
  let value = "";
  let truncated = false;
  return {
    append(data: Buffer): void {
      const available = Math.max(0, maxBytes - bytes);
      const retained = data.subarray(0, available);
      bytes += retained.length;
      if (retained.length > 0) value += decoder.decode(retained, { stream: true });
      if (retained.length < data.length) truncated = true;
    },
    finish(): { value: string; truncated: boolean } {
      // When the cap split a code point, discard the decoder's incomplete tail.
      if (!truncated) value += decoder.decode();
      return { value, truncated };
    },
  };
};

/** Terminate descendants as well as the direct check process. */
const killProcessTree = (child: ChildProcess): void => {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      // taskkill is the fast path. The parent-chain sweep then catches a
      // descendant that was created just after taskkill's tree snapshot.
      spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const processTreeScript = [
        `$root = ${child.pid};`,
        "for ($pass = 0; $pass -lt 3; $pass++) {",
        "  $queue = [System.Collections.Generic.Queue[int]]::new();",
        "  $seen = [System.Collections.Generic.HashSet[int]]::new();",
        "  $queue.Enqueue($root);",
        "  while ($queue.Count -gt 0) {",
        "    $current = $queue.Dequeue();",
        "    if (-not $seen.Add($current)) { continue; }",
        "    try { Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $current) | ForEach-Object { $queue.Enqueue([int]$_.ProcessId) } } catch {}",
        "  }",
        "  $seen | Where-Object { $_ -ne $root } | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue };",
        "  Stop-Process -Id $root -Force -ErrorAction SilentlyContinue;",
        "  Start-Sleep -Milliseconds 20;",
        "}",
      ].join(" ");
      spawnSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        processTreeScript,
      ], { stdio: "ignore", windowsHide: true });
      child.kill("SIGKILL");
      return;
    } else {
      process.kill(-child.pid, "SIGKILL");
      return;
    }
  } catch {
    // Fall through to the direct child when the platform tree primitive is unavailable.
  }
  child.kill("SIGKILL");
};

export const createSubprocessSandbox = (opts: { allowNetwork?: boolean } = {}): SandboxBackend => ({
  id: "subprocess",
  isolated: false,

  exec: (spec: ExecSpec): Promise<ExecResult> => {
    return new Promise((resolve) => {
      // Security gate first
      const deny = validateSpec(spec, opts);
      if (deny) { resolve(deniedResult(deny)); return; }
      if (spec.network !== undefined || spec.allowReadPaths !== undefined || spec.allowWritePaths !== undefined) {
        resolve(deniedResult("subprocess backend cannot enforce network or filesystem isolation; use an isolated backend"));
        return;
      }

      const timeoutMs = spec.timeoutMs ?? 30_000;
      const maxOutputBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      let timedOut = false;
      const stdout = boundedOutput(maxOutputBytes);
      const stderr = boundedOutput(maxOutputBytes);

      const child = spawn(spec.command, spec.args ?? [], {
        cwd: spec.cwd,
        env: executionEnvironment(spec.env),
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeoutMs);

      child.stdout?.on("data", (data: Buffer) => { stdout.append(data); });
      child.stderr?.on("data", (data: Buffer) => { stderr.append(data); });

      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        const stdoutResult = stdout.finish();
        const stderrResult = stderr.finish();
        if (timedOut) {
          resolve({
            ...timeoutResult(stdoutResult.value),
            outputTruncated: stdoutResult.truncated || stderrResult.truncated,
          });
        } else {
          resolve({
            exitCode: code ?? 0,
            stdout: stdoutResult.value,
            stderr: stderrResult.value,
            timedOut: false,
            denied: false,
            outputTruncated: stdoutResult.truncated || stderrResult.truncated,
          });
        }
      });

      child.on("error", (err: Error) => {
        clearTimeout(timer);
        const stdoutResult = stdout.finish();
        const stderrResult = stderr.finish();
        resolve({
          exitCode: -1,
          stdout: stdoutResult.value,
          stderr: stderrResult.value || err.message,
          timedOut: false,
          denied: false,
          outputTruncated: stdoutResult.truncated || stderrResult.truncated,
        });
      });
    });
  },
});

// --- Plug setup (registers the exec capability) -----------------------------
// Default: subprocess backend (for local dev). InMemorySandbox is used directly
// by tests (not via the registry — it needs registered handlers).
export async function setup(api: {
  register: (capability: "exec", contribution: SandboxContribution) => void;
}): Promise<void> {
  api.register("exec", {
    kind: "sandbox-backend",
    id: "subprocess-sandbox",
    backend: createSubprocessSandbox(),
    mutates: true, // sandbox exec mutates by definition
  });
}

// Re-export InMemorySandbox for test convenience.
export { InMemorySandbox as createInMemorySandbox };
