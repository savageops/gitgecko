/**
 * @gitgecko/instructions/command-tasks — the per-command task prompts.
 *
 * The single source of truth for the /describe /review /improve /ask /resolve
 * command taxonomy (CR-§1.2 compatible). Previously these five prompts were
 * hardcoded in `plugs/review/commands/plug.ts:39-52`, bypassing the corpus
 * entirely — a drift risk, since two agents editing in different places could
 * diverge. Moving them here means all model-facing prose flows from one place.
 *
 * Each prompt is the task framing (what the agent must do). The persona, rules,
 * output format, and findings come from resolveInstructions; this is the verb.
 * Written in the gitgecko dialect (AGENTS.d/01-dialect): declarative mechanism,
 * negative space, no filler.
 */

/** The commands that have a distinct task prompt. Mirrors ReviewCommand. */
export type CommandTask = "describe" | "review" | "improve" | "ask" | "resolve" | "fix" | "fix-all";

/** Normalize a raw command string (strip slashes, lowercase) to canonical form. */
const canonicalCommand = (command: string): string => command.replace(/^\/+/, "").toLowerCase();

/**
 * The per-command task prompt (the verb). Appended to the diff by the caller.
 *
 * For /review, the rules are threaded in by the caller (the plug composes them)
 * because the rules come from `input.instructions.rules`, which the instructions
 * package does not own at call time — the orchestrator resolves them.
 *
 * @param command - the command name (with or without leading slash)
 * @returns the task prompt string, ending ready for the diff to be appended
 */
export const commandTask = (command: string): string => {
  const canonical = canonicalCommand(command);
  switch (canonical) {
    case "describe":
      return `Generate a PR description: title, summary, and walkthrough. Ground every claim in the diff.`;
    case "review":
      return `Review this PR. Find real defects by reasoning about the consequence, not the symptom. Suggest improvements only where they leave the code more sound.`;
    case "improve":
      return `Suggest code improvements for this PR — the suggestions lane only. No review findings.`;
    case "ask":
      return `Answer the question using the diff + repo context. If the answer is not in the diff or context, say so explicitly.`;
    case "resolve":
      return `Propose a fix for the issue in this PR. Show the corrected code and why it works.`;
    case "fix":
      return `Apply the approved fix in the current workspace. Change only what is necessary for the supplied issue, preserve unrelated edits, then verify the changed behavior and report exactly what changed.`;
    case "fix-all":
      return `Apply every safely actionable approved finding in the current workspace. Preserve unrelated edits, report skipped findings explicitly, and verify the resulting changes before claiming completion.`;
    default:
      return `Process command /${canonical}.`;
  }
};
