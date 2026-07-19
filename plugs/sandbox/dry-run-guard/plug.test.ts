/**
 * TDD tests for the dry-run-guard sandbox plug — proves the policy-only backend
 * validates specs correctly and returns dry-run results without executing.
 *
 * Per project TDD rule: tests challenge capability (the backend must validate
 * the security gate AND produce meaningful dry-run output), never degraded to
 * pass. Per the ≥30 meaningful test floor: these prove the plug's intended
 * entrypoint (createDryRunGuard + the registered backend contribution).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createDryRunGuard,
  setup,
  manifest,
  type DryRunOptions,
} from "./plug.js";
import type { ExecSpec, SandboxContribution } from "@gitgecko/sandbox";

const spec = (overrides: Partial<ExecSpec> = {}): ExecSpec => ({
  command: "echo",
  args: ["hello"],
  ...overrides,
});

describe("dry-run-guard — policy validation (the security gate)", () => {
  it("denies rm -rf / (command blocklist)", async () => {
    const backend = createDryRunGuard();
    const result = await backend.exec(spec({ command: "rm", args: ["-rf", "/"] }));
    assert.ok(result.denied, "rm -rf / must be denied");
    assert.ok(result.denyReason?.includes("blocked command"), `deny reason should name the blocklist: ${result.denyReason}`);
    assert.equal(result.exitCode, -1);
  });

  it("denies mkfs (command blocklist)", async () => {
    const backend = createDryRunGuard();
    const result = await backend.exec(spec({ command: "mkfs", args: ["/dev/sda1"] }));
    assert.ok(result.denied, "mkfs must be denied");
  });

  it("denies dd to /dev/ (command blocklist)", async () => {
    const backend = createDryRunGuard();
    const result = await backend.exec(spec({ command: "dd", args: ["if=/dev/zero", "of=/dev/sda"] }));
    assert.ok(result.denied, "dd to /dev/ must be denied");
  });

  it("denies shutdown and reboot (command blocklist)", async () => {
    const backend = createDryRunGuard();
    const s = await backend.exec(spec({ command: "shutdown" }));
    assert.ok(s.denied, "shutdown must be denied");
    const r = await backend.exec(spec({ command: "reboot" }));
    assert.ok(r.denied, "reboot must be denied");
  });

  it("allows a safe command (not in the blocklist)", async () => {
    const backend = createDryRunGuard();
    const result = await backend.exec(spec({ command: "echo", args: ["hello"] }));
    assert.ok(!result.denied, "echo hello must not be denied");
    assert.equal(result.exitCode, 0);
  });
});

describe("dry-run-guard — dry-run output (no real execution)", () => {
  it("returns a dry-run marker indicating the command would be allowed", async () => {
    const backend = createDryRunGuard();
    const result = await backend.exec(spec());
    assert.ok(result.stdout.includes("[dry-run]"), "output must contain the dry-run marker");
    assert.ok(result.stdout.includes("would be allowed"), "output must say the command would be allowed");
  });

  it("echoes the full command in the dry-run output", async () => {
    const backend = createDryRunGuard();
    const result = await backend.exec(spec({ command: "npm", args: ["test", "--verbose"] }));
    assert.ok(result.stdout.includes("npm test --verbose"), "dry-run output should include the full command");
  });

  it("includes the timeout in the dry-run output when set", async () => {
    const backend = createDryRunGuard();
    const result = await backend.exec(spec({ timeoutMs: 5000 }));
    assert.ok(result.stdout.includes("timeout: 5000ms"), "dry-run output should include the timeout");
  });

  it("denies network: allow when the backend is not configured to permit it", async () => {
    const backend = createDryRunGuard();
    const result = await backend.exec(spec({ network: "allow" }));
    assert.ok(result.denied, "network: allow must be denied by the air-gapped default");
    assert.ok(result.denyReason?.includes("network"), "deny reason should mention network");
  });

  it("includes read/write paths in the dry-run output when set", async () => {
    const backend = createDryRunGuard();
    const result = await backend.exec(spec({
      allowReadPaths: ["src/"],
      allowWritePaths: ["dist/"],
    }));
    assert.ok(result.stdout.includes("read paths: src/"), "dry-run output should include read paths");
    assert.ok(result.stdout.includes("write paths: dist/"), "dry-run output should include write paths");
  });

  it("suppresses the command echo when echoCommand is false", async () => {
    const backend = createDryRunGuard({ echoCommand: false } as DryRunOptions);
    const result = await backend.exec(spec({ command: "secret-cmd", args: ["arg"] }));
    assert.ok(!result.stdout.includes("secret-cmd"), "command should NOT be echoed when echoCommand is false");
  });

  it("includes env keys (not values) when echoEnvKeys is true", async () => {
    const backend = createDryRunGuard({ echoEnvKeys: true } as DryRunOptions);
    const result = await backend.exec(spec({ env: { SECRET_TOKEN: "hidden-value", API_KEY: "also-hidden" } }));
    assert.ok(result.stdout.includes("SECRET_TOKEN"), "env key names should be echoed");
    assert.ok(result.stdout.includes("API_KEY"), "env key names should be echoed");
    assert.ok(!result.stdout.includes("hidden-value"), "env VALUES must never be echoed");
  });
});

describe("dry-run-guard — backend identity", () => {
  it("has id 'dry-run-guard'", () => {
    const backend = createDryRunGuard();
    assert.equal(backend.id, "dry-run-guard");
  });

  it("is not isolated (does not execute anything)", () => {
    const backend = createDryRunGuard();
    assert.equal(backend.isolated, false);
  });
});

describe("dry-run-guard — plug setup registers a contribution", () => {
  it("registers a sandbox-backend contribution through setup()", async () => {
    const contributions: SandboxContribution[] = [];
    await setup({ register: (_cap, c) => contributions.push(c) });
    assert.equal(contributions.length, 1, "setup registers exactly one backend contribution");
    assert.equal(contributions[0]!.id, "dry-run-guard-backend");
    assert.equal(contributions[0]!.backend.id, "dry-run-guard");
    assert.equal(contributions[0]!.mutates, false, "dry-run guard does not mutate (no execution)");
  });

  it("the registered backend is callable and produces dry-run results", async () => {
    const contributions: SandboxContribution[] = [];
    await setup({ register: (_cap, c) => contributions.push(c) });
    const backend = contributions[0]!.backend;
    const result = await backend.exec(spec({ command: "ls", args: ["-la"] }));
    assert.ok(result.stdout.includes("[dry-run]"), "registered backend produces dry-run output");
    assert.equal(result.exitCode, 0);
  });

  it("the registered backend denies blocklisted commands", async () => {
    const contributions: SandboxContribution[] = [];
    await setup({ register: (_cap, c) => contributions.push(c) });
    const backend = contributions[0]!.backend;
    const result = await backend.exec(spec({ command: "rm", args: ["-rf", "/"] }));
    assert.ok(result.denied, "registered backend must deny rm -rf /");
  });

  it("the manifest declares the sandbox owner and exec capability", () => {
    assert.equal(manifest.owner, "sandbox");
    assert.ok(manifest.capabilities.includes("exec"));
    assert.equal(manifest.id, "sandbox-dry-run-guard");
  });
});
