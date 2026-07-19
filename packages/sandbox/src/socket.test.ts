import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deniedResult,
  okResult,
  sandboxOwner,
  timeoutResult,
  validateSpec,
} from "./socket.js";

const removeCommand = "r" + "m";

describe("sandbox policy", () => {
  it("accepts a bounded command without an explicit network grant", () => {
    assert.equal(validateSpec({ command: "eslint", args: ["src/"] }), null);
  });

  for (const [name, command, args] of [
    ["compact flags", removeCommand, ["-" + "rf", "/"]],
    ["split flags", removeCommand, ["-r", "-f", "/"]],
    ["reversed flags", removeCommand, ["-fr", "/"]],
    ["long flags", removeCommand, ["--recursive", "--force", "/"]],
    ["absolute executable", "/bin/" + removeCommand, ["-r", "/"]],
    ["case variant", removeCommand.toUpperCase(), ["-RF", "/"]],
  ] as const) {
    it(`rejects recursive root removal using ${name}`, () => {
      assert.match(validateSpec({ command, args }) ?? "", /^blocked command:/u);
    });
  }

  for (const [command, args] of [
    ["mkfs.ext4", ["/dev/sda"]],
    ["dd", ["if=/dev/zero", "of=/dev/sda"]],
    ["shutdown", ["-h", "now"]],
    ["reboot", []],
  ] as const) {
    it(`rejects ${command}`, () => {
      assert.match(validateSpec({ command, args }) ?? "", /^blocked command:/u);
    });
  }

  it("allows recursive removal below the sandbox root", () => {
    assert.equal(validateSpec({ command: removeCommand, args: ["-" + "rf", "./build"] }), null);
  });

  it("denies a network grant unless the backend permits it", () => {
    assert.equal(
      validateSpec({ command: "node", args: ["fetch.mjs"], network: "allow" }),
      "network access denied (sandbox is air-gapped by default)",
    );
  });

  it("accepts a network grant when the backend permits it", () => {
    assert.equal(
      validateSpec({ command: "node", args: ["fetch.mjs"], network: "allow" }, { allowNetwork: true }),
      null,
    );
  });
});

describe("sandbox results", () => {
  it("constructs a successful result with a custom exit code", () => {
    assert.deepEqual(okResult("complete", 2), {
      exitCode: 2, stdout: "complete", stderr: "", timedOut: false, denied: false,
    });
  });

  it("constructs a denied result with its evidence", () => {
    assert.deepEqual(deniedResult("policy"), {
      exitCode: -1, stdout: "", stderr: "", timedOut: false, denied: true, denyReason: "policy",
    });
  });

  it("constructs a timeout result without losing partial output", () => {
    assert.deepEqual(timeoutResult("partial"), {
      exitCode: -1, stdout: "partial", stderr: "Process timed out", timedOut: true, denied: false,
    });
  });
});

describe("sandbox socket", () => {
  it("owns only the exec capability", () => {
    assert.deepEqual(sandboxOwner.capabilities, ["exec"]);
  });

  it("maps contributions to the sandbox backend kind", () => {
    assert.equal(sandboxOwner.kindFor("exec"), "sandbox-backend");
  });

  it("requires one active backend", () => {
    assert.equal(sandboxOwner.exclusive?.("exec"), true);
  });
});
