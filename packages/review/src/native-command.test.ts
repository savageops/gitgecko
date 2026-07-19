import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  executeNativeCommand,
  executeNativeCommandResult,
  resolveNativeCommand,
  type NativeCommandDependencies,
} from "./native-command.js";

const windowsDependencies = (
  candidates: readonly string[],
  existing: readonly string[] = [],
): NativeCommandDependencies => ({
  platform: "win32",
  findOnPath: () => candidates,
  pathExists: (path) => existing.includes(path),
  powershellExecutable: "powershell.exe",
});

describe("native command resolution", () => {
  it("executes an explicit Windows executable without treating it as a where pattern", () => {
    let searched = false;
    const result = resolveNativeCommand("C:\\Program Files\\nodejs\\node.exe", {
      platform: "win32",
      pathExists: () => true,
      findOnPath: () => { searched = true; return []; },
    });
    assert.equal(result.executable, "C:\\Program Files\\nodejs\\node.exe");
    assert.equal(searched, false);
  });

  it("uses a Windows executable directly without a shell", () => {
    const resolved = resolveNativeCommand("codex", windowsDependencies([
      "C:\\tools\\codex.cmd",
      "C:\\tools\\codex.exe",
    ]));

    assert.deepEqual(resolved, {
      executable: "C:\\tools\\codex.exe",
      argumentPrefix: [],
    });
  });

  it("runs an npm PowerShell shim when only a cmd shim is discoverable", () => {
    const resolved = resolveNativeCommand(
      "claude",
      windowsDependencies(
        ["C:\\npm\\claude.cmd"],
        ["C:\\npm\\claude.ps1"],
      ),
    );

    assert.deepEqual(resolved, {
      executable: "powershell.exe",
      argumentPrefix: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\npm\\claude.ps1",
      ],
    });
  });

  it("runs an npm Node entry directly before falling back to its PowerShell shim", () => {
    const shimPath = "C:\\npm\\codex.cmd";
    const entryPath = "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
    const resolved = resolveNativeCommand("codex", {
      ...windowsDependencies([shimPath], [shimPath, entryPath, "C:\\npm\\codex.ps1"]),
      nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
      readFile: () => `@echo off\n\"%_prog%\" \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*`,
    });

    assert.deepEqual(resolved, {
      executable: "C:\\Program Files\\nodejs\\node.exe",
      argumentPrefix: [entryPath],
    });
  });

  it("rejects a cmd-only resolution instead of silently enabling shell parsing", () => {
    assert.throws(
      () => resolveNativeCommand("opencode", windowsDependencies(["C:\\npm\\opencode.cmd"])),
      /safe executable or PowerShell shim/i,
    );
  });

  it("uses PATH lookup directly on non-Windows platforms", () => {
    const resolved = resolveNativeCommand("codex", {
      platform: "linux",
      findOnPath: () => [],
      pathExists: () => false,
      powershellExecutable: "powershell.exe",
    });

    assert.deepEqual(resolved, { executable: "codex", argumentPrefix: [] });
  });
});

describe("native command execution", () => {
  it("preserves arguments and stdin as separate process inputs", () => {
    const calls: Array<{
      executable: string;
      args: readonly string[];
      input?: string;
      shell?: boolean;
    }> = [];
    const output = executeNativeCommand(
      "claude",
      ["-p", "literal & untrusted"],
      { input: "review body; still stdin" },
      {
        ...windowsDependencies(["C:\\npm\\claude.cmd"], ["C:\\npm\\claude.ps1"]),
        execFile: (executable, args, options) => {
          calls.push({
            executable,
            args,
            ...(options.input !== undefined && { input: options.input }),
            ...(options.shell !== undefined && { shell: options.shell }),
          });
          return "reviewed";
        },
      },
    );

    assert.equal(output, "reviewed");
    assert.deepEqual(calls[0]?.args.slice(-2), ["-p", "literal & untrusted"]);
    assert.equal(calls[0]?.input, "review body; still stdin");
    assert.notEqual(calls[0]?.shell, true);
  });

  it("returns an empty string when stdio is intentionally ignored", () => {
    const output = executeNativeCommand(
      "codex",
      ["--version"],
      { stdio: "ignore" },
      {
        ...windowsDependencies(["C:\\tools\\codex.exe"]),
        execFile: () => null,
      },
    );

    assert.equal(output, "");
  });

  it("captures stdout and stderr without inheriting either stream", () => {
    const result = executeNativeCommandResult(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err')"]);
    assert.equal(result.ok, true);
    assert.equal(result.stdout, "out");
    assert.equal(result.stderr, "err");
  });

  it("returns a typed non-zero result instead of throwing", () => {
    const result = executeNativeCommandResult(process.execPath, ["-e", "process.stderr.write('denied'); process.exit(7)"]);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 7);
    assert.equal(result.stderr, "denied");
    assert.equal(result.failure, "provider");
  });

  it("classifies a missing executable", () => {
    const result = executeNativeCommandResult("gitgecko-definitely-missing-binary", []);
    assert.equal(result.ok, false);
    assert.equal(result.failure, "not-installed");
  });

  const classifiedFailures: readonly [string, string, string][] = [
    ["auth", "401 unauthorized", "auth"],
    ["login", "please login first", "auth"],
    ["forbidden", "permission denied", "permission"],
    ["arguments", "unknown option --wat", "invalid-arguments"],
    ["usage", "Usage: provider run", "invalid-arguments"],
    ["timeout", "operation timed out", "timeout"],
    ["parse", "malformed JSON response", "malformed-output"],
  ];
  for (const [name, stderr, failure] of classifiedFailures) {
    it(`classifies ${name} failures`, () => {
      const result = executeNativeCommandResult(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(stderr)}); process.exit(1)`]);
      assert.equal(result.failure, failure);
    });
  }

  it("does not include stderr in the legacy stdout return", () => {
    const output = executeNativeCommand(process.execPath, ["-e", "process.stdout.write('json'); process.stderr.write('progress')"]);
    assert.equal(output, "json");
  });

  it("throws a concise error for a non-zero legacy call", () => {
    assert.throws(
      () => executeNativeCommand(process.execPath, ["-e", "process.stderr.write('bad credentials'); process.exit(1)"]),
      /bad credentials/u,
    );
  });
});
