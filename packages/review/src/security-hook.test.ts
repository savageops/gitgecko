/**
 * TDD tests for the security-hook module (Phase 4.4 / T5 — W5 security wedge).
 *
 * THE CAPABILITY: the per-dialect mutates-deny formatting. Each native agent
 * expresses denies differently; this module formats the derived deny list per
 * dialect + builds the PreToolUse gate script (pullfrog salvage).
 *
 * Per project TDD rule: tests challenge capability, never degraded to pass.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GIT_WRITE_DENY_CLAUDE,
  GIT_READ_DENY_CLAUDE,
  GIT_WRITE_DENY_OPENCODE,
  GIT_READ_DENY_OPENCODE,
  formatDisallowedTools,
  formatClaudeManagedSettingsDeny,
  buildClaudePretoolGateSource,
  buildClaudeSettings,
} from "./security-hook.js";

const SAMPLE_DENY = ["write_file", "delete_branch", "push_commit"];

describe("security-hook — canonical deny surfaces (pullfrog salvage)", () => {
  it("GIT_WRITE_DENY_CLAUDE denies .git writes (gitignore globs)", () => {
    assert.ok(GIT_WRITE_DENY_CLAUDE.some((d) => d.includes("Edit(.git)")));
    assert.ok(GIT_WRITE_DENY_CLAUDE.some((d) => d.includes("**/.git")));
  });

  it("GIT_READ_DENY_CLAUDE denies .git/config reads per read tool", () => {
    assert.ok(GIT_READ_DENY_CLAUDE.some((d) => d.includes("Read(.git/config)")));
    assert.ok(GIT_READ_DENY_CLAUDE.some((d) => d.includes("Grep(.git/config)")));
    assert.ok(GIT_READ_DENY_CLAUDE.some((d) => d.includes("Glob(.git/config)")));
  });

  it("GIT_WRITE_DENY_OPENCODE denies .git writes (wildcard dialect)", () => {
    assert.equal(GIT_WRITE_DENY_OPENCODE[".git"], "deny");
    assert.equal(GIT_WRITE_DENY_OPENCODE["*/.git"], "deny");
  });

  it("GIT_READ_DENY_OPENCODE denies .git/config read (wildcard dialect)", () => {
    assert.equal(GIT_READ_DENY_OPENCODE[".git/config"], "deny");
  });
});

describe("security-hook — per-dialect formatting", () => {
  it("formatDisallowedTools produces a comma-separated string", () => {
    const result = formatDisallowedTools("claude-code", SAMPLE_DENY);
    assert.equal(result, "write_file,delete_branch,push_commit");
  });

  it("formatDisallowedTools works for all dialects (same flag shape)", () => {
    const claude = formatDisallowedTools("claude-code", SAMPLE_DENY);
    const codex = formatDisallowedTools("codex", SAMPLE_DENY);
    const opencode = formatDisallowedTools("opencode", SAMPLE_DENY);
    assert.equal(claude, codex);
    assert.equal(codex, opencode);
  });

  it("formatClaudeManagedSettingsDeny includes the mutates deny + .git surfaces", () => {
    const settings = formatClaudeManagedSettingsDeny(SAMPLE_DENY);
    assert.ok(Array.isArray(settings.permissions.deny));
    // Mutates deny tools are included with (**).
    assert.ok(settings.permissions.deny.some((d) => d.includes("write_file")));
    // .git write deny surfaces are included.
    assert.ok(settings.permissions.deny.some((d) => d.includes("Edit(.git)")));
  });
});

describe("security-hook — Claude PreToolUse gate script (pullfrog salvage)", () => {
  it("buildClaudePretoolGateSource produces executable JS with the deny set embedded", () => {
    const source = buildClaudePretoolGateSource(SAMPLE_DENY);
    assert.match(source, /SUBAGENT_DENIED_TOOLS/);
    // The deny tools are embedded in the script as JSON.
    assert.match(source, /write_file/);
    assert.match(source, /delete_branch/);
  });

  it("the gate script exits 0 for the main thread (no agent_id)", () => {
    const source = buildClaudePretoolGateSource(SAMPLE_DENY);
    // The script checks agent_id and exits 0 (allow) when empty.
    assert.match(source, /if\s*\(!agentId\)\s*process\.exit\(0\)/);
  });

  it("the gate script exits 2 (block) for denied subagent tools", () => {
    const source = buildClaudePretoolGateSource(SAMPLE_DENY);
    assert.match(source, /process\.exit\(2\)/);
  });

  it("buildClaudeSettings includes both the deny list AND the PreToolUse hook", () => {
    const settings = buildClaudeSettings(SAMPLE_DENY, "/tmp/gate.mjs");
    assert.ok(settings.permissions);
    assert.ok(Array.isArray((settings.permissions as { deny: unknown[] }).deny));
    assert.ok(settings.hooks);
    assert.ok((settings.hooks as { PreToolUse: unknown[] }).PreToolUse);
  });
});
