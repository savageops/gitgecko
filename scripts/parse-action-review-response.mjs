#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const REQUIREMENT_STATUS = new Set(["satisfied", "unmet", "unverified"]);

/** Keep provider- and issue-controlled text bounded and single-line in a PR comment. */
const commentText = (value, fallback) => {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, 1_000) : fallback;
};

/** Render only validated review.v2 requirement records; never reparse model prose. */
export function formatActionRequirements(artifact) {
  const requirements = artifact?.linkedRequirements;
  if (!Array.isArray(requirements) || requirements.length === 0) return "";
  const lines = [];
  for (const value of requirements.slice(0, 50)) {
    if (!value || typeof value !== "object" || !Number.isSafeInteger(value.number) || !REQUIREMENT_STATUS.has(value.status)) continue;
    const title = commentText(value.title, "Linked requirement");
    const evidence = commentText(value.evidence, "No evidence returned.");
    const href = typeof value.url === "string" && /^https:\/\/github\.com\//u.test(value.url) ? value.url : undefined;
    const label = href ? `[#${value.number} ${title}](${href})` : `#${value.number} ${title}`;
    const marker = value.status === "satisfied" ? "[x]" : "[ ]";
    lines.push(`- ${marker} ${label} - **${value.status}**: ${evidence}`);
  }
  return lines.length > 0 ? `## Linked requirements\n\n${lines.join("\n")}` : "";
}

/** Validate the cloud envelope once for both comment output and merge gating. */
export function parseActionReviewEnvelope(source) {
  let payload;
  try {
    payload = JSON.parse(source);
  } catch {
    throw new Error("GitGecko cloud returned an invalid review response.");
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("GitGecko cloud returned an invalid review response.");
  }
  if (payload.success !== true) {
    const detail = typeof payload.error === "string" && payload.error.trim()
      ? payload.error.trim()
      : typeof payload.output === "string" && payload.output.trim()
        ? payload.output.trim()
        : "GitGecko cloud review failed.";
    throw new Error(detail);
  }
  if (typeof payload.output !== "string" || !payload.output.trim()) {
    throw new Error("GitGecko cloud review completed without review output.");
  }
  const requirements = formatActionRequirements(payload.artifact);
  return {
    output: requirements ? `${payload.output.trim()}\n\n${requirements}` : payload.output,
    mergeable: payload.artifact?.mergeable !== false,
  };
}

/** Convert the cloud review transport envelope into comment-safe user output. */
export function parseActionReviewResponse(source) {
  return parseActionReviewEnvelope(source).output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let source = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { source += chunk; });
  process.stdin.on("end", () => {
    try {
      const result = parseActionReviewEnvelope(source);
      process.stdout.write(result.output);
      if (!result.mergeable) process.exitCode = 1;
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : "GitGecko cloud review failed."}\n`);
      process.exitCode = 1;
    }
  });
}
