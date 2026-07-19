/**
 * Resolve and execute native-agent CLIs without a command shell.
 *
 * Windows npm installs expose `.cmd` and `.ps1` shims. Executing the cmd shim
 * requires shell parsing, so this owner selects a real executable when one is
 * available and otherwise runs the sibling PowerShell shim with `-File`.
 * Arguments and stdin remain separate process inputs on every platform.
 */
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, win32 } from "node:path";

export interface ResolvedNativeCommand {
  readonly executable: string;
  readonly argumentPrefix: readonly string[];
}

export interface NativeCommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly timeout?: number;
  readonly maxBuffer?: number;
  readonly stdio?: "ignore" | "pipe";
}

export type NativeCommandFailure =
  | "not-installed"
  | "auth"
  | "permission"
  | "invalid-arguments"
  | "timeout"
  | "provider"
  | "malformed-output";

export interface NativeCommandResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly failure?: NativeCommandFailure;
  readonly error?: string;
}

export class NativeCommandError extends Error {
  readonly result: NativeCommandResult;

  constructor(binary: string, result: NativeCommandResult) {
    super(result.error ?? `Native agent '${binary}' failed.`);
    this.name = "NativeCommandError";
    this.result = result;
  }
}

interface NativeExecOptions extends NativeCommandOptions {
  readonly encoding: "utf8";
  readonly windowsHide: true;
  readonly shell: false;
}

type NativeExecFile = (
  executable: string,
  args: readonly string[],
  options: NativeExecOptions,
) => string | Buffer | null;

type NativeSpawnFile = (
  executable: string,
  args: readonly string[],
  options: NativeExecOptions,
) => SpawnSyncReturns<string>;

export interface NativeCommandDependencies {
  readonly platform?: NodeJS.Platform;
  readonly findOnPath?: (binary: string) => readonly string[];
  readonly pathExists?: (path: string) => boolean;
  readonly readFile?: (path: string) => string;
  readonly nodeExecutable?: string;
  readonly powershellExecutable?: string;
  readonly execFile?: NativeExecFile;
  readonly spawnFile?: NativeSpawnFile;
}

/** Find every Windows PATH candidate without invoking a command shell. */
const findWindowsCandidates = (binary: string): readonly string[] => {
  try {
    const output = execFileSync("where.exe", [binary], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split(/\r?\n/u)
      .map((candidate) => candidate.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

/**
 * Resolve the JavaScript entrypoint embedded by a standard npm `.cmd` shim.
 *
 * This keeps the native-command boundary shell-free when PowerShell would parse
 * a standalone `-` stdin sentinel as a parameter name. The shim itself is the
 * trusted installed-command owner; the extracted entrypoint must remain below
 * that shim's directory and exist before Node is allowed to execute it.
 * Provenance: `.refs/05-agent-harnesses/t3code-main/packages/shared/src/shell.ts`.
 */
const resolveNpmNodeEntrypoint = (
  shimPath: string,
  pathExists: (path: string) => boolean,
  readFile: (path: string) => string,
): string | undefined => {
  try {
    const match = readFile(shimPath).match(/node_modules[\\/][^\s"'`]+?\.js\b/u);
    if (!match) return undefined;
    const entrypoint = win32.join(win32.dirname(shimPath), match[0]!.replaceAll("/", "\\"));
    return pathExists(entrypoint) ? entrypoint : undefined;
  } catch {
    return undefined;
  }
};

/** Resolve one safe process target for a native-agent CLI. */
export const resolveNativeCommand = (
  binary: string,
  dependencies: NativeCommandDependencies = {},
): ResolvedNativeCommand => {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "win32") {
    return { executable: binary, argumentPrefix: [] };
  }

  const findOnPath = dependencies.findOnPath ?? findWindowsCandidates;
  const pathExists = dependencies.pathExists ?? existsSync;
  const explicitExtension = extname(binary).toLowerCase();
  if (
    (binary.includes("\\") || binary.includes("/"))
    && (explicitExtension === ".exe" || explicitExtension === ".com")
    && pathExists(binary)
  ) {
    return { executable: binary, argumentPrefix: [] };
  }
  const candidates = findOnPath(binary);
  const executable = candidates.find((candidate) => {
    const extension = extname(candidate).toLowerCase();
    return extension === ".exe" || extension === ".com";
  });
  if (executable) return { executable, argumentPrefix: [] };

  const directPowerShell = candidates.find((candidate) => extname(candidate).toLowerCase() === ".ps1");
  const cmdShim = candidates.find((candidate) => extname(candidate).toLowerCase() === ".cmd");
  const npmEntrypoint = cmdShim
    ? resolveNpmNodeEntrypoint(cmdShim, pathExists, dependencies.readFile ?? ((path) => readFileSync(path, "utf8")))
    : undefined;
  if (npmEntrypoint) {
    return {
      executable: dependencies.nodeExecutable ?? process.execPath,
      argumentPrefix: [npmEntrypoint],
    };
  }
  const siblingPowerShell = cmdShim ? `${cmdShim.slice(0, -4)}.ps1` : undefined;
  const powerShellShim = directPowerShell ?? (
    siblingPowerShell && pathExists(siblingPowerShell) ? siblingPowerShell : undefined
  );
  if (powerShellShim) {
    return {
      executable: dependencies.powershellExecutable ?? "powershell.exe",
      argumentPrefix: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        powerShellShim,
      ],
    };
  }

  throw new Error(
    `Native agent '${binary}' was found, but no safe executable or PowerShell shim is available. Reinstall the CLI or configure a real executable.`,
  );
};

/** Classify provider-facing failures without exposing raw process objects. */
export const classifyNativeCommandFailure = (message: string, timedOut: boolean, notInstalled = false): NativeCommandFailure => {
  if (notInstalled) return "not-installed";
  if (timedOut || /timed?\s*out|timeout/iu.test(message)) return "timeout";
  if (/401|unauthori[sz]ed|not authenticated|log\s*in|login/iu.test(message)) return "auth";
  if (/permission denied|forbidden|access denied|not allowed/iu.test(message)) return "permission";
  if (/unknown (?:option|argument)|invalid (?:option|argument)|usage:/iu.test(message)) return "invalid-arguments";
  if (/malformed|invalid json|parse error/iu.test(message)) return "malformed-output";
  return "provider";
};

/** Execute a native CLI and return a complete, non-throwing process envelope. */
export const executeNativeCommandResult = (
  binary: string,
  args: readonly string[],
  options: NativeCommandOptions = {},
  dependencies: NativeCommandDependencies = {},
): NativeCommandResult => {
  let resolved: ResolvedNativeCommand;
  try {
    resolved = resolveNativeCommand(binary, dependencies);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      timedOut: false,
      failure: "not-installed",
      error: message,
    };
  }

  const commandOptions: NativeExecOptions = {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
    stdio: options.stdio ?? "pipe",
  };

  if (dependencies.execFile) {
    try {
      const stdout = dependencies.execFile(resolved.executable, [...resolved.argumentPrefix, ...args], commandOptions);
      return { ok: true, stdout: typeof stdout === "string" ? stdout : "", stderr: "", exitCode: 0, signal: null, timedOut: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, stdout: "", stderr: message, exitCode: null, signal: null, timedOut: false, failure: classifyNativeCommandFailure(message, false), error: message };
    }
  }

  const spawnFile = dependencies.spawnFile ?? ((executable, commandArgs, spawnOptions) => (
    spawnSync(executable, commandArgs, spawnOptions)
  ));
  const result = spawnFile(resolved.executable, [...resolved.argumentPrefix, ...args], commandOptions);
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const errorMessage = result.error?.message;
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  const notInstalled = (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  const ok = !result.error && result.status === 0;
  if (ok) return { ok: true, stdout, stderr, exitCode: result.status, signal: result.signal, timedOut: false };

  const diagnostic = stderr.trim() || errorMessage || `Native agent exited with code ${result.status ?? "unknown"}.`;
  return {
    ok: false,
    stdout,
    stderr,
    exitCode: result.status,
    signal: result.signal,
    timedOut,
    failure: classifyNativeCommandFailure(diagnostic, timedOut, notInstalled),
    error: diagnostic,
  };
};

/** Execute a native-agent CLI with no shell parsing boundary. */
export const executeNativeCommand = (
  binary: string,
  args: readonly string[],
  options: NativeCommandOptions = {},
  dependencies: NativeCommandDependencies = {},
): string => {
  const result = executeNativeCommandResult(binary, args, options, dependencies);
  if (!result.ok) throw new NativeCommandError(binary, result);
  return result.stdout;
};
