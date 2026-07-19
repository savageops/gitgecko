/**
 * @gitgecko/instructions/output-format — the blueprint templates.
 *
 * Salvaged + combined from competitors (nobody has all of these — 001 parent §1):
 *  - pullfrog PR_SUMMARY_FORMAT (modes.ts:20-160): preamble + cross-cutting
 *    sections + nitpicks lane.
 *  - open-code-review severity sections (plan_task_system.md:32-36): explicit
 *    high/medium/low definitions → our error/warning/info/tip.
 *  - pi Good/Bad/Ugly (.pi/prompts/pr.md): a quick-mode structure.
 *
 * Each template is a function returning a string with interpolation points.
 * The templates request severity-tagged sections so the output is parseable
 * AND human-friendly (U6: "blueprints for whatever"; U7: severity levels).
 */
import type { Severity } from "@gitgecko/rules";
import { severityLabel, severityEmoji, SEVERITY_ORDER } from "./severity.js";

/** The command types that have distinct output formats. */
export type ReviewCommand = "review" | "describe" | "improve" | "ask" | "resolve";

/**
 * The output-format instruction for a review command. This is APPENDED to the
 * prompt so the model knows the expected structure. It requests severity-tagged
 * sections (the W3 traceability + U7 severity requirement) and delta-grounds
 * every finding to its diff hunk (the CR-§8 normalization bar — a finding that
 * floats unanchored from the diff is noise).
 */
export const reviewOutputFormat = (): string => `Structure your review with severity-tagged sections. The severity is the action signal; the section is the lane.

- ${severityEmoji("error")} **error** — bugs, security issues, data loss. Blocks merge.
- ${severityEmoji("warning")} **warning** — regressions, missing validation, incorrect behavior. Address before merge.
- ${severityEmoji("info")} **info** — surfaced for awareness. Mergeable as-is.
- ${severityEmoji("hint")} **hint** — non-actionable context worth knowing. No action required.
- ${severityEmoji("tip")} **tip** — what would be better. Optional, actionable.

Every finding cites the diff line/hunk it follows from (CR-§8 — the normalization bar). A finding that cannot be traced to a specific diff hunk is a thumb-sucked finding; drop it.

Format:
\`\`\`
## Summary
(1-2 sentences: what this PR does + your overall assessment)

## 🔴 error
(each finding: the issue, its CONSEQUENCE, the diff hunk it follows from, and the fix. Omit the section if none.)

## 🟡 warning
(each finding: issue + consequence + diff hunk + fix. Omit if none.)

## ℹ️ info
(awareness items. Omit if none.)

## 🔷 hint
(non-actionable context. Omit if none.)

## 💡 tip
(recommendations for what would be better. Omit if none.)
\`\`\`
Only include sections that have findings. A clean PR gets a one-line summary and nothing else — say so explicitly.`;

/** The /describe output format (walkthrough — salvaged from pr-agent + pullfrog). */
export const describeOutputFormat = (): string => `Generate a PR description. Ground the title and summary in the diff; do not add findings or review comments.
\`\`\`
## {Title}
{1-2 sentence summary}

### Walkthrough
- {one bullet per logical change, 5-10 words each}
\`\`\``;

/** The /improve output format (suggestions lane only — no review findings). */
export const improveOutputFormat = (): string => `Provide code improvement suggestions only — no summary, no review findings. Format each as:
\`\`\`
### {suggestion title}
{the improvement + why it is better}
\`\`\`
Backtick-wrap identifiers. Omit praise.`;

/** The /ask output format (Q&A scoped to the diff + context). */
export const askOutputFormat = (): string => `Answer the question using the diff + repo context. Be direct and concise. If the answer is not in the diff or context, say so explicitly — a guess is thumb-sucked.`;

/** The /resolve output format (propose a fix). */
export const resolveOutputFormat = (): string => `Propose a fix for the identified issue. Show the corrected code in a fenced block with a one-line explanation of why the fix works.`;

/** Resolve the output format for a command. */
export const outputFormatFor = (command: string): string => {
  const canonical = command.replace(/^\/+/, "").toLowerCase();
  switch (canonical) {
    case "describe":
      return describeOutputFormat();
    case "improve":
      return improveOutputFormat();
    case "ask":
      return askOutputFormat();
    case "resolve":
      return resolveOutputFormat();
    case "review":
    default:
      return reviewOutputFormat();
  }
};

/**
 * Render findings (from the deterministic evaluator) as a severity-grouped block.
 * This is injected into the prompt as "authoritative findings — do not reword."
 */
export const renderFindings = (findings: readonly { severity: Severity; message: string; ruleId: string }[]): string => {
  if (findings.length === 0) return "";
  const lines: string[] = ["## Deterministic findings (authoritative — do not reword, soften, or omit):"];
  for (const sev of SEVERITY_ORDER) {
    const group = findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    const label = severityLabel(sev);
    const emoji = severityEmoji(sev);
    lines.push(`\n${emoji} ${label}:`);
    for (const f of group) {
      const cite = ` [${f.ruleId}]`;
      lines.push(`- ${f.message}${cite}`);
    }
  }
  return lines.join("\n");
};

/**
 * Render retrieved repo-context snippets as a labeled section for the prompt.
 * (002b — the grounding-section formatter. Mirrors the renderFindings pattern
 * from chain 001: empty input → "", non-empty → an authoritative-labeled block.)
 *
 * The section is marked "retrieved" so the model treats it as authoritative
 * grounding context to base its consequence reasoning on (the W7 open-graph
 * wedge — a review that cites retrieved code proves the retrieval works).
 *
 * The caller (the orchestrator) builds the snippets from the code-intel
 * retrieve capability and renders them here; resolveInstructions then threads
 * the resulting string into ResolvedInstructions.repoContext.
 */
export const renderRepoContext = (snippets: readonly { readonly content: string; readonly filepath: string }[]): string => {
  if (snippets.length === 0) return "";
  const lines: string[] = ["## Repo context (retrieved — ground your reasoning here):"];
  for (const s of snippets) {
    lines.push(`--- ${s.filepath} ---`);
    lines.push(s.content);
  }
  return lines.join("\n");
};
