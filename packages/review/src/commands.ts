/**
 * @gitgecko/review/commands — the slash-command taxonomy + mutates gate.
 *
 * The command taxonomy mirrors CodeRabbit's (CR-§1.2) + pr-agent's command2class
 * (P-plugin-11, .refs/01-pr-review/pr-agent-main/pr_agent/agent/pr_agent.py).
 * Each command maps to a handler; aliases (review_pr → review) are extra keys.
 *
 * The mutates gate (P-plugin-7): tools declared mutates:true are denied to
 * subagents. The deny list is DERIVED from the registered tool set (never
 * hand-maintained), and the gate THROWS if the list is empty while the plug
 * declares mutatesTools — the silent-disable trap from pullfrog.
 */

/** Canonical command names (CR-§1.2). Handlers register for these + aliases. */
export const REVIEW_COMMANDS = [
  "describe",
  "review",
  "improve",
  "ask",
  "fix",
  "fix-all",
  "resolve",
  "learn",
  "pause",
  "resume",
] as const;

export type ReviewCommand = (typeof REVIEW_COMMANDS)[number];

/** Command aliases (pr-agent's command2class pattern, P-plugin-11). */
export const COMMAND_ALIASES: Readonly<Record<string, string>> = {
  review_pr: "review",
  describe_pr: "describe",
  improve_code: "improve",
  fix_all: "fix",
  ask_question: "ask",
  ask_line: "ask",
  auto_review: "review",
  answer: "review",
};

/** Resolve a raw command string (e.g. "/review_pr") to its canonical name. */
export const resolveCommand = (raw: string): string => {
  const stripped = raw.startsWith("/") ? raw.slice(1) : raw;
  const canonical = COMMAND_ALIASES[stripped] ?? stripped;
  return canonical;
};

/** Whether a string is a known review command (after alias resolution). */
export const isReviewCommand = (raw: string): boolean =>
  (REVIEW_COMMANDS as readonly string[]).includes(resolveCommand(raw));

// --- The mutates gate (P-plugin-7) ------------------------------------------

/**
 * Derive the subagent deny list from a tool set. Tools with mutates:true are
 * denied. THROWS if the set is empty while `expectMutating` is true — the
 * "gate silently disabled" trap (P-plugin-7 invariant, pullfrog battle-lesson).
 */
export const deriveMutatesDenyList = (
  tools: readonly { readonly name: string; readonly mutates?: boolean }[],
  expectMutating: boolean,
): readonly string[] => {
  const deny = tools.filter((t) => t.mutates).map((t) => t.name);
  if (expectMutating && deny.length === 0) {
    throw new Error(
      "mutates gate: plug declares mutatesTools but no mutating tools registered — " +
        "deny list would be empty (gate silently disabled). See P-plugin-7.",
    );
  }
  return deny;
};

/** Check whether a tool call should be denied to a subagent (the gate decision). */
export const shouldDenyTool = (
  toolName: string,
  denyList: readonly string[],
): boolean => denyList.includes(toolName);
