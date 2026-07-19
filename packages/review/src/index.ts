/**
 * @gitgecko/review — the CodeRabbit-competing agent loop owner.
 *
 * Implements the `review` owner (02-architecture-overview §2, design doc 05).
 * Agent adapter (P-plugin-3), command taxonomy (CR-§1.2 / P-plugin-11),
 * mutates gate (P-plugin-7), trace recording (G8). Consumes code-intel
 * retrieve to ground reviews in repo context.
 *
 * Zero-config native-agent detection (goal §1.1, A13): detect claude/codex/
 * opencode on PATH; use the developer's existing login. No keys needed.
 */
export * from "./agent.js";
export * from "./commands.js";
// native-detection.ts (pure, no Node imports) — safe for the client bundle.
// native-agents.ts (uses node:child_process) is a server-only subpath export.
export * from "./native-detection.js";
export * from "./native-threads.js";
export * from "./native-provider.js";
export * from "./pathways.js";
export * from "./pathway-setup.js";
export * from "./pathway-store.js";
export * from "./gitgecko-local.js";
export * from "./security-hook.js";
export * from "./prompt.js";
export * from "./artifact.js";
export * from "./unified-diff.js";
export * from "./missions.js";
export * from "./mutation.js";
