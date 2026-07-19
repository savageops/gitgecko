import assert from "node:assert/strict";
import { it } from "node:test";

import { runCodexExec } from "./exec.js";

it("returns cancellation before resolving or launching Codex", async () => {
  const controller = new AbortController();
  controller.abort();
  const activity: unknown[] = [];

  const result = await runCodexExec({
    cwd: process.cwd(),
    permission: "read-only",
    prompt: "must not launch",
    signal: controller.signal,
    onActivity: (event) => activity.push(event),
  });

  assert.deepEqual(result, {
    success: false,
    failure: "cancelled",
    error: "Codex review was cancelled.",
  });
  assert.deepEqual(activity, []);
});
