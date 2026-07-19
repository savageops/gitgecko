import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCliProgressReporter } from "./progress.js";

describe("CLI progress reporter", () => {
  it("writes lifecycle progress to the injected stderr sink", () => {
    const output: string[] = [];
    const reporter = createCliProgressReporter({
      write: (text) => output.push(text),
      setInterval: () => ({ unref() {} }) as ReturnType<typeof setInterval>,
      clearInterval: () => undefined,
    });
    reporter.report({ phase: "starting", provider: "codex", message: "Starting Codex App Server", at: "2026-07-17T00:00:00.000Z" });
    reporter.stop();
    assert.deepEqual(output, ["[GitGecko] Starting Codex App Server\n"]);
  });

  it("emits a bounded elapsed-time heartbeat", () => {
    const output: string[] = [];
    let heartbeat: (() => void) | undefined;
    let now = 0;
    const reporter = createCliProgressReporter({
      write: (text) => output.push(text),
      now: () => now,
      setInterval: (callback) => {
        heartbeat = callback;
        return { unref() {} } as ReturnType<typeof setInterval>;
      },
      clearInterval: () => undefined,
    });
    reporter.report({ phase: "thinking", provider: "codex", message: "Codex is reviewing the repository", at: "2026-07-17T00:00:00.000Z" });
    now = 16_000;
    heartbeat?.();
    reporter.stop();
    assert.equal(output.at(-1), "[GitGecko] Codex is reviewing the repository (16s elapsed)\n");
  });

  it("stops all output after teardown", () => {
    const output: string[] = [];
    let heartbeat: (() => void) | undefined;
    const reporter = createCliProgressReporter({
      write: (text) => output.push(text),
      setInterval: (callback) => {
        heartbeat = callback;
        return { unref() {} } as ReturnType<typeof setInterval>;
      },
      clearInterval: () => undefined,
    });
    reporter.stop();
    reporter.report({ phase: "completed", provider: "codex", message: "Review completed", at: "2026-07-17T00:00:00.000Z" });
    heartbeat?.();
    assert.deepEqual(output, []);
  });

  it("updates one terminal line and closes it on teardown", () => {
    const output: string[] = [];
    const reporter = createCliProgressReporter({
      isTTY: true,
      write: (text) => output.push(text),
      setInterval: () => ({ unref() {} }) as ReturnType<typeof setInterval>,
      clearInterval: () => undefined,
    });
    reporter.report({ phase: "starting", provider: "codex", message: "Starting Codex", at: "2026-07-17T00:00:00.000Z" });
    reporter.report({ phase: "thinking", provider: "codex", message: "Thinking", at: "2026-07-17T00:00:01.000Z" });
    reporter.stop();
    assert.equal(output[0], "\r[GitGecko] Starting Codex");
    assert.match(output[1] ?? "", /^\r\[GitGecko\] Thinking +$/);
    assert.equal(output.at(-1), "\n");
  });
});
