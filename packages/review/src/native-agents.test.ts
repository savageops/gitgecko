/**
 * TDD tests for native-agent detection — the zero-config CLI UX wedge
 * (goal §1.1, A13). Challenges the CAPABILITY: given binaries on PATH,
 * detect them in the right preference order; map to agent ids; handle none.
 *
 * The PATH probe is INJECTED (a fake) so detection is deterministic — no real
 * binaries needed. Per project TDD rule: written FIRST, fail, then code passes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NATIVE_AGENT_PREFERENCE,
  binaryExistsOnPath,
  binaryToAgentId,
  detectNativeAgents,
  type BinaryProbe,
} from "./native-agents.js";

// --- Fake probes ------------------------------------------------------------
const probeOnly = (binaries: string[]): BinaryProbe => {
  const set = new Set(binaries);
  return (b: string) => set.has(b);
};
const probeNone: BinaryProbe = () => false;
const probeAll: BinaryProbe = () => true;

describe("native-agent detection — preference order", () => {
  it("prefers codex when all three are available", () => {
    const d = detectNativeAgents(probeOnly(["claude", "codex", "opencode"]));
    assert.equal(d.preferred, "codex");
    assert.deepEqual([...d.available], ["codex", "claude", "opencode"]);
  });

  it("prefers codex when claude is absent", () => {
    const d = detectNativeAgents(probeOnly(["codex", "opencode"]));
    assert.equal(d.preferred, "codex");
  });

  it("prefers opencode when only opencode is available", () => {
    const d = detectNativeAgents(probeOnly(["opencode"]));
    assert.equal(d.preferred, "opencode");
    assert.deepEqual([...d.available], ["opencode"]);
  });

  it("returns null preferred + empty available when nothing is installed", () => {
    const d = detectNativeAgents(probeNone);
    assert.equal(d.preferred, null);
    assert.equal(d.available.length, 0);
  });
});

describe("native-agent detection — binary → agent id mapping", () => {
  it("maps claude → claude-code", () => {
    assert.equal(binaryToAgentId("claude"), "claude-code");
  });
  it("maps codex → codex", () => {
    assert.equal(binaryToAgentId("codex"), "codex");
  });
  it("maps opencode → opencode", () => {
    assert.equal(binaryToAgentId("opencode"), "opencode");
  });
  it("passes through unknown binaries", () => {
    assert.equal(binaryToAgentId("custom-agent"), "custom-agent");
  });
});

describe("native-agent detection — preference list integrity", () => {
  it("the preference order is codex > claude > opencode", () => {
    assert.deepEqual([...NATIVE_AGENT_PREFERENCE], ["codex", "claude", "opencode"]);
  });

  it("detectNativeAgents returns available agents in preference order (not probe order)", () => {
    // Probe returns true in a different order; output must still be preference-ordered.
    const reverseProbe: BinaryProbe = (b: string) => ["opencode", "codex", "claude"].includes(b);
    const d = detectNativeAgents(reverseProbe);
    assert.deepEqual([...d.available], ["codex", "claude", "opencode"]);
  });
});

describe("native-agent detection — robustness", () => {
  it("handles a probe that finds only one of three", () => {
    const d = detectNativeAgents(probeOnly(["codex"]));
    assert.equal(d.preferred, "codex");
    assert.equal(d.available.length, 1);
  });

  it("handles a probe where all return true (all available)", () => {
    const d = detectNativeAgents(probeAll);
    assert.equal(d.available.length, 3);
    assert.equal(d.preferred, "codex");
  });
});

describe("native-agent detection — real PATH probe", () => {
  it("detects a PATH entry without executing the candidate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gitgecko-native-probe-"));
    const marker = join(directory, "executed.txt");
    const binary = process.platform === "win32" ? "gitgecko-probe.CMD" : "gitgecko-probe";
    const candidate = join(directory, binary);

    try {
      await writeFile(candidate, process.platform === "win32"
        ? `@echo executed>${marker}\r\n`
        : `#!/bin/sh\nprintf executed > ${marker}\n`, { mode: 0o755 });
      const environment = { PATH: directory, PATHEXT: ".EXE;.CMD" };

      assert.equal(binaryExistsOnPath("gitgecko-probe", environment, process.platform), true);
      assert.equal(binaryExistsOnPath("missing-probe", environment, process.platform), false);
      await assert.rejects(() => access(marker));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
