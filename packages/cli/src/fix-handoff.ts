/** Parse one public review artifact into the bounded instruction for a fix-all agent turn. */
export const buildFixAllHandoff = (input: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("--findings-file must contain valid JSON from a GitGecko review.");
  }
  if (!isRecord(parsed)) throw new Error("--findings-file must contain a review.v2 artifact or public GitGecko result.");
  const artifact = isRecord(parsed.artifact) ? parsed.artifact : parsed;
  if (artifact.schemaVersion !== "review.v2") throw new Error("--findings-file must contain a review.v2 artifact.");
  if (!Array.isArray(artifact.findings)) throw new Error("review.v2 artifact has no findings array.");

  const findings = artifact.findings
    .filter((finding): finding is OpenFinding => isRecord(finding) && isOpenFinding(finding))
    .slice(0, 25);
  if (findings.length === 0) throw new Error("--findings-file contains no open findings to fix.");

  const lines = findings.map((finding) => {
    const location = typeof finding.file === "string"
      ? ` (${finding.file}${typeof finding.line === "number" ? `:${finding.line}` : ""})`
      : "";
    const severity = typeof finding.severity === "string" ? `[${finding.severity}] ` : "";
    return `- ${severity}${finding.message.trim()}${location}`;
  });
  const cap = Array.isArray(artifact.findings) && artifact.findings.length > findings.length
    ? "\nOnly the first 25 open findings are included; run another handoff for the remainder."
    : "";
  const runId = typeof artifact.runId === "string" ? ` from ${artifact.runId}` : "";
  return `Apply the approved open findings${runId} in this workspace. Fix every safely actionable item below. Preserve unrelated edits. Do not claim a fix for an item you cannot verify; explain any skipped item. Run a focused verification when the workspace permits it.\n\nApproved findings:\n${lines.join("\n")}${cap}`;
};

/** Narrow untrusted JSON before any handoff field is read. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type OpenFinding = Record<string, unknown> & { readonly message: string };

/** Admit only actionable findings whose message can safely enter an agent instruction. */
const isOpenFinding = (finding: Record<string, unknown>): finding is OpenFinding =>
  finding.disposition === "open" && typeof finding.message === "string" && finding.message.trim().length > 0;
