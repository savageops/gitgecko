/**
 * @gitgecko/review/prompt — shared review-prompt builder (audit 4.1 refactor).
 *
 * Extracts the ~15-line prompt-building block that was duplicated verbatim across
 * all 4 native-agent plugs (gitgecko-native, codex, claude-code, opencode). Each plug
 * was independently maintaining the same persona→rules→findings→context→diff
 * assembly. This helper kills the duplication and keeps all backends in lockstep.
 *
 * The helper imports renderFindings from @gitgecko/instructions — but to avoid
 * a circular dep (instructions → review for ResolvedInstructions types), we
 * accept the rendered findings string as an optional pre-rendered field on the
 * context. The plugs that already call renderFindings pass it through; the
 * helper just needs the instructions object.
 */
import type { AgentRunContext } from "./agent.js";
import { renderReviewMission } from "./missions.js";

/**
 * Build the full review prompt from the agent run context.
 * Returns the assembled prompt string (persona + system + rules + findings +
 * repoContext + diff + outputFormat).
 *
 * Used by: agent-codex, agent-claude-code, agent-opencode, agent-gitgecko-native.
 */
export const buildReviewPrompt = (ctx: AgentRunContext): string => {
  const personaText = ctx.instructions.persona ? `${ctx.instructions.persona}\n\n` : "";
  const rulesText = ctx.instructions.rules.length > 0
    ? `\n\n## Rules (authoritative — obey each):\n${ctx.instructions.rules.map((r) => `- ${r}`).join("\n")}`
    : "";
  const findingsText = ctx.instructions.findings && ctx.instructions.findings.length > 0
    ? `\n\n## Deterministic findings (authoritative — do not reword, soften, or omit):\n${ctx.instructions.findings.map((f) => `- ${f.message} [${f.ruleId}]`).join("\n")}\n`
    : "";
  const outputFormatText = ctx.instructions.outputFormat
    ? `\n\n${ctx.instructions.outputFormat}`
    : "";
  const repoContextText = ctx.instructions.repoContext
    ? `\n\n${ctx.instructions.repoContext}`
    : "";
  const linkedIssuesText = ctx.payload.linkedIssues?.length
    ? `\n\n## Linked requirements\nAssess each requirement against the changed code. Report unmet or unverified requirements as findings; do not claim a requirement is satisfied without evidence in this diff. End with \`## Linked requirement assessment\` and one line per requirement: \`- #<issue> | satisfied|unmet|unverified | <diff evidence>\`.\n${ctx.payload.linkedIssues.map((issue) => `- #${issue.number} ${issue.title}: ${issue.body}`).join("\n")}`
    : "";
  const runtimeChecksText = ctx.payload.runtimeChecks?.receipts.length
    ? `\n\n## Runtime validation\nConfigured checks were run in the reviewed workspace. Treat failed required checks as merge blockers and use their bounded evidence when it bears on this diff.\n${ctx.payload.runtimeChecks.receipts.map((receipt) => `- ${receipt.required ? "required" : "optional"} ${receipt.id}: ${receipt.status} (exit ${receipt.exitCode}, ${receipt.durationMs}ms)${receipt.stderr ? ` — ${receipt.stderr}` : receipt.stdout ? ` — ${receipt.stdout}` : ""}`).join("\n")}`
    : "";
  const missionText = renderReviewMission(ctx.payload.mission);

  return `${personaText}${ctx.instructions.systemPrompt}${rulesText}${findingsText}${repoContextText}

PR #${ctx.payload.prNumber}: ${ctx.payload.title}

Diff:
${ctx.payload.diff}${linkedIssuesText}${runtimeChecksText}${missionText}
${outputFormatText}`;
};
