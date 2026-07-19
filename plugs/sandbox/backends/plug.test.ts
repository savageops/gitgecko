import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createSubprocessSandbox, InMemorySandbox } from "./plug.js";

describe("trusted-local subprocess sandbox", () => {
  it("executes an absolute binary without a shell", async () => {
    const result = await createSubprocessSandbox().exec({ command: process.execPath, args: ["-e", "process.stdout.write('ok')"] });
    assert.deepEqual({ exitCode: result.exitCode, stdout: result.stdout, denied: result.denied }, { exitCode: 0, stdout: "ok", denied: false });
  });

  it("keeps stdout and stderr independent", async () => {
    const result = await createSubprocessSandbox().exec({ command: process.execPath, args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"] });
    assert.equal(result.stdout, "out");
    assert.equal(result.stderr, "err");
  });

  it("bounds retained stdout and stderr while the process is running", async () => {
    const result = await createSubprocessSandbox().exec({
      command: process.execPath,
      args: ["-e", "process.stdout.write('o'.repeat(1024 * 1024)); process.stderr.write('e'.repeat(1024 * 1024));"],
      maxOutputBytes: 64,
    });
    assert.equal(Buffer.byteLength(result.stdout), 64);
    assert.equal(Buffer.byteLength(result.stderr), 64);
    assert.equal(result.outputTruncated, true);
  });

  it("does not split retained multibyte output at the byte boundary", async () => {
    const result = await createSubprocessSandbox().exec({
      command: process.execPath,
      args: ["-e", "process.stdout.write('gecko-' + String.fromCodePoint(0x1f98e) + '-tail');"],
      maxOutputBytes: 10,
    });
    assert.doesNotMatch(result.stdout, /\uFFFD/u);
    assert.ok(Buffer.byteLength(result.stdout) <= 10);
    assert.equal(result.outputTruncated, true);
  });

  it("preserves a nonzero exit code", async () => {
    const result = await createSubprocessSandbox().exec({ command: process.execPath, args: ["-e", "process.exit(7)"] });
    assert.equal(result.exitCode, 7);
  });

  it("reports a missing executable without throwing", async () => {
    const result = await createSubprocessSandbox().exec({ command: "gitgecko-command-that-does-not-exist" });
    assert.equal(result.exitCode, -1);
    assert.match(result.stderr, /not found|enoent/i);
  });

  it("kills an over-time process", async () => {
    const result = await createSubprocessSandbox().exec({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"], timeoutMs: 30 });
    assert.equal(result.timedOut, true);
  });

  it("kills descendants before they can mutate after timeout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gitgecko-process-tree-"));
    const marker = join(directory, "late-write.txt");
    const ready = join(directory, "child-spawned.txt");
    const childSource = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)}, 'spawned'); setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'late'), 2500);`;
    const parentSource = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: 'ignore' }); setTimeout(() => {}, 10000);`;
    try {
      const resultPromise = createSubprocessSandbox().exec({
        command: process.execPath,
        args: ["-e", parentSource],
        timeoutMs: 1500,
      });
      let childSpawned = false;
      for (let attempt = 0; attempt < 100 && !childSpawned; attempt += 1) {
        try {
          await access(ready);
          childSpawned = true;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      assert.equal(childSpawned, true);
      const result = await resultPromise;
      assert.equal(result.timedOut, true);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await assert.rejects(() => access(marker));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs in the requested working directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "gitgecko-check-"));
    try {
      const result = await createSubprocessSandbox().exec({ command: process.execPath, args: ["-e", "process.stdout.write(process.cwd())"], cwd });
      assert.equal(result.stdout.toLowerCase(), cwd.toLowerCase());
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps launcher environment while excluding unrelated parent secrets", async () => {
    const oldValue = process.env.GECKO_PARENT_SECRET;
    process.env.GECKO_PARENT_SECRET = "must-not-leak";
    try {
      const result = await createSubprocessSandbox().exec({ command: process.execPath, args: ["-e", "process.stdout.write(`${process.env.GECKO_TEST}|${process.env.GECKO_PARENT_SECRET ?? ''}`);"], env: { GECKO_TEST: "bounded" } });
      assert.equal(result.stdout, "bounded|");
    } finally {
      if (oldValue === undefined) delete process.env.GECKO_PARENT_SECRET;
      else process.env.GECKO_PARENT_SECRET = oldValue;
    }
  });

  it("resolves a named executable from the preserved launcher path", async () => {
    const command = process.platform === "win32" ? "where.exe" : "which";
    const result = await createSubprocessSandbox().exec({ command, args: ["node"] });
    assert.equal(result.exitCode, 0);
  });

  it("denies network policy claims it cannot enforce", async () => {
    const result = await createSubprocessSandbox().exec({ command: process.execPath, network: "deny" });
    assert.equal(result.denied, true);
    assert.match(result.denyReason ?? "", /cannot enforce/i);
  });

  it("denies filesystem policy claims it cannot enforce", async () => {
    const result = await createSubprocessSandbox().exec({ command: process.execPath, allowReadPaths: ["."] });
    assert.equal(result.denied, true);
    assert.match(result.denyReason ?? "", /cannot enforce/i);
  });

  it("never represents trusted-local execution as isolated", () => {
    assert.equal(createSubprocessSandbox().isolated, false);
  });
});

describe("in-memory sandbox", () => {
  it("runs a registered deterministic handler", async () => {
    const sandbox = new InMemorySandbox();
    sandbox.register("lint", (args) => ({ exitCode: 0, stdout: args.join(","), stderr: "" }));
    const result = await sandbox.exec({ command: "lint", args: ["src", "test"] });
    assert.equal(result.stdout, "src,test");
  });

  it("returns command-not-found for an unregistered handler", async () => {
    const result = await new InMemorySandbox().exec({ command: "missing" });
    assert.equal(result.exitCode, 127);
  });
});
