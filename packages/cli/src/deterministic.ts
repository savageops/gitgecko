/**
 * Evaluate the local CLI diff through the same deterministic rule plugs used
 * by the hosted orchestrator. This keeps local reviews honest without making
 * the CLI invent a second rule language or parser.
 */
import { parseUnifiedDiff } from "@gitgecko/review";
import type { Finding } from "@gitgecko/rules";
import { BASELINE_RULES } from "@gitgecko/plug-rules-baseline-pack";
import { evaluateRules } from "@gitgecko/plug-rules-evaluators";

/** Return authoritative deterministic findings mapped back to diff line numbers. */
export const evaluateCliDiff = async (diff: string): Promise<readonly Finding[]> => {
  if (!diff.trim()) return [];
  const findings: Finding[] = [];
  for (const file of parseUnifiedDiff(diff).filter((candidate) => candidate.addedSource.length > 0)) {
    const language = file.path.endsWith(".ts") || file.path.endsWith(".js")
      ? "typescript"
      : file.path.endsWith(".py")
        ? "python"
        : undefined;
    const result = await evaluateRules({
      filepath: file.path,
      source: file.addedSource,
      ...(language && { language }),
      rules: BASELINE_RULES,
    });
    findings.push(...result.findings.map((finding) => ({
      ...finding,
      line: file.addedLines[finding.line - 1]?.line ?? finding.line,
    })));
  }
  return findings;
};
