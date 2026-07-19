import type { Finding } from "@gitgecko/rules";
import type { LinkedReviewRequirement, ReviewRuntimeCheckReport } from "./agent.js";
import { parseUnifiedDiff, type ReviewFileChange } from "./unified-diff.js";
import type { MutationReceipt } from "./mutation.js";

export type ReviewFindingSeverity = "error" | "warning" | "info" | "hint" | "tip";
export type ReviewFindingSource = "deterministic" | "llm";
export type ReviewFindingDisposition = "open" | "accepted" | "dismissed" | "fixed";

export interface ReviewFinding {
  readonly severity: ReviewFindingSeverity;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
}

export interface ReviewFindingV2 extends ReviewFinding {
  readonly fingerprint: string;
  readonly source: ReviewFindingSource;
  readonly category: string;
  readonly disposition: ReviewFindingDisposition;
  readonly ruleId?: string;
  readonly evidence?: string;
}

/** One explicit assessment of an issue linked by the authoritative review source. */
export interface LinkedRequirementAssessment extends LinkedReviewRequirement {
  readonly status: "satisfied" | "unmet" | "unverified";
  readonly evidence: string;
}

export interface ReviewArtifactV1 {
  readonly schemaVersion: "review.v1";
  readonly runId: string;
  readonly status: "succeeded" | "failed";
  readonly title: string;
  readonly summary: string;
  readonly mergeable: boolean;
  readonly blastRadius: "low" | "medium" | "high";
  readonly findings: readonly ReviewFinding[];
  readonly files: readonly string[];
  readonly pathway: { readonly family: string; readonly binary?: string };
}

export interface ReviewContextReceipt {
  readonly scope: "project" | "group";
  readonly anchorProjectId: string;
  readonly includedProjectIds: readonly string[];
  readonly skippedProjects: readonly { readonly projectId: string; readonly reason: "empty" | "pending" | "indexing" | "failed" }[];
  readonly resultCount: number;
  readonly groupId?: string;
  readonly groupRevision?: number;
}

export interface ReviewArtifactV2 {
  readonly schemaVersion: "review.v2";
  readonly runId: string;
  readonly status: "succeeded" | "failed";
  readonly title: string;
  readonly summary: string;
  readonly mergeable: boolean;
  readonly blastRadius: "low" | "medium" | "high";
  readonly findings: readonly ReviewFindingV2[];
  readonly files: readonly ReviewFileChange[];
  readonly pathway: { readonly family: string; readonly binary?: string };
  readonly rawOutput: string;
  /** Present only when the review source supplied linked requirements. */
  readonly linkedRequirements?: readonly LinkedRequirementAssessment[];
  /** Present only when the caller explicitly ran configured runtime checks. */
  readonly runtimeChecks?: ReviewRuntimeCheckReport;
  /** Exact server-resolved repository context used for this review. */
  readonly repositoryContext?: ReviewContextReceipt;
  /** Trusted before/after workspace evidence for approved mutation commands. */
  readonly mutation?: MutationReceipt;
}

export interface ReviewArtifactInput {
  readonly runId: string;
  readonly title: string;
  readonly output: string;
  readonly success: boolean;
  readonly diff?: string;
  readonly files?: readonly string[];
  readonly deterministicFindings?: readonly Finding[];
  readonly linkedIssues?: readonly LinkedReviewRequirement[];
  readonly runtimeChecks?: ReviewRuntimeCheckReport;
  readonly pathway: { readonly family: string; readonly binary?: string };
  readonly mutation?: MutationReceipt;
}

/** Map a Markdown finding heading to the public severity contract. */
const headingSeverity = (line: string): ReviewFindingSeverity | undefined => {
  const normalized = line.toLowerCase();
  if (normalized.includes("error") || normalized.includes("blocker")) return "error";
  if (normalized.includes("warning")) return "warning";
  if (normalized.includes("info")) return "info";
  if (normalized.includes("hint")) return "hint";
  if (normalized.includes("tip")) return "tip";
  return undefined;
};

/** Produce a stable, dependency-free fingerprint for finding deduplication. */
const findingFingerprint = (parts: readonly unknown[]): string => {
  const value = parts.map((part) => String(part ?? "")).join("\u001f");
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `finding_${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

/** Parse only model-authored Markdown findings; deterministic findings bypass this seam. */
const parseModelOutput = (output: string): { summary?: string; findings: ReviewFindingV2[] } => {
  const findings: ReviewFindingV2[] = [];
  let severity: ReviewFindingSeverity | undefined;
  let summary: string | undefined;
  let inSummary = false;
  let proseFindingCaptured = false;

  const appendFinding = (findingSeverity: ReviewFindingSeverity, message: string): void => {
    if (message.length <= 3) return;
    findings.push({
      fingerprint: findingFingerprint(["llm", findingSeverity, message]),
      source: "llm",
      severity: findingSeverity,
      category: "model-review",
      message,
      disposition: "open",
      evidence: "Model review output",
    });
  };

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^#+\s*summary\b/i.test(line)) {
      inSummary = true;
      severity = undefined;
      continue;
    }
    if (/^#+\s+/.test(line)) {
      inSummary = false;
      severity = headingSeverity(line);
      proseFindingCaptured = false;
      continue;
    }
    if (inSummary && line && !summary) summary = line;
    if (severity && /^[-*]\s+/.test(line)) {
      const message = line.replace(/^[-*]\s+/, "").trim();
      appendFinding(severity, message);
      continue;
    }
    if (severity && !proseFindingCaptured && /^\*\*[^*].*\*\*/u.test(line)) {
      const close = line.indexOf("**", 2);
      const message = close > 2 ? line.slice(2, close).trim() : "";
      if (!/^(?:fix|evidence|impact|remediation)\s*:/iu.test(message)) {
        appendFinding(severity, message);
        proseFindingCaptured = true;
      }
    }
  }

  return { ...(summary ? { summary } : {}), findings };
};

/** Parse a bounded provider declaration and preserve absence as an honest unverified result. */
const assessLinkedRequirements = (
  output: string,
  linkedIssues: readonly LinkedReviewRequirement[],
): readonly LinkedRequirementAssessment[] => {
  const parsed = new Map<number, { readonly status: LinkedRequirementAssessment["status"]; readonly evidence: string }>();
  let inAssessment = false;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^#+\s*linked requirement assessment\b/i.test(line)) {
      inAssessment = true;
      continue;
    }
    if (/^#+\s+/.test(line)) {
      inAssessment = false;
      continue;
    }
    if (!inAssessment) continue;
    const match = /^[-*]\s*#(\d+)\s*\|\s*(satisfied|unmet|unverified)\s*\|\s*(.+)$/i.exec(line);
    if (!match) continue;
    const number = Number(match[1]);
    const status = match[2]!.toLowerCase() as LinkedRequirementAssessment["status"];
    const evidence = match[3]!.trim();
    if (Number.isSafeInteger(number) && evidence && !parsed.has(number)) parsed.set(number, { status, evidence });
  }
  return linkedIssues.map((issue) => {
    const assessment = parsed.get(issue.number);
    return {
      ...issue,
      status: assessment?.status ?? "unverified",
      evidence: assessment?.evidence ?? "No structured assessment returned by the review provider.",
    };
  });
};

/** Preserve authoritative deterministic findings as structured artifact records. */
const mapDeterministicFinding = (finding: Finding): ReviewFindingV2 | undefined => {
  if (finding.severity === "off") return undefined;
  return {
    fingerprint: findingFingerprint([
      finding.source,
      finding.ruleId,
      finding.filepath,
      finding.line,
      finding.column,
      finding.message,
    ]),
    source: finding.source,
    severity: finding.severity,
    category: finding.kind,
    ruleId: finding.ruleId,
    message: finding.message,
    file: finding.filepath,
    line: finding.line,
    disposition: "open",
    evidence: finding.match,
  };
};

/** Build the canonical structured review artifact without reconstructing known facts from prose. */
export const createReviewArtifactV2 = (input: ReviewArtifactInput): ReviewArtifactV2 => {
  const parsed = parseModelOutput(input.output);
  const deterministic = (input.deterministicFindings ?? [])
    .map(mapDeterministicFinding)
    .filter((finding): finding is ReviewFindingV2 => finding !== undefined);
  const findings = [...deterministic, ...parsed.findings];
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.filter((finding) => finding.severity === "warning").length;
  const blastRadius = errors >= 3 || warnings >= 5 ? "high" : errors > 0 || warnings >= 2 ? "medium" : "low";
  const parsedFiles = input.diff ? parseUnifiedDiff(input.diff) : [];
  const files = parsedFiles.length > 0
    ? parsedFiles
    : (input.files ?? []).map((path): ReviewFileChange => ({
        path,
        status: "modified",
        binary: false,
        addedSource: "",
        addedLines: [],
      }));
  const linkedRequirements = input.linkedIssues && input.linkedIssues.length > 0
    ? assessLinkedRequirements(input.output, input.linkedIssues)
    : undefined;
  const requirementsSatisfied = linkedRequirements?.every((requirement) => requirement.status === "satisfied") ?? true;

  return {
    schemaVersion: "review.v2",
    runId: input.runId,
    status: input.success ? "succeeded" : "failed",
    title: input.title,
    summary: parsed.summary ?? (input.success ? "Review complete." : "Review failed."),
    mergeable: input.success
      && errors === 0
      && requirementsSatisfied
      && (input.runtimeChecks?.allRequiredPassed ?? true),
    blastRadius,
    findings,
    files,
    pathway: input.pathway,
    rawOutput: input.output,
    ...(linkedRequirements ? { linkedRequirements } : {}),
    ...(input.runtimeChecks ? { runtimeChecks: input.runtimeChecks } : {}),
    ...(input.mutation ? { mutation: input.mutation } : {}),
  };
};

/** Adapt the canonical artifact for legacy consumers until their migration is complete. */
export const toReviewArtifactV1 = (artifact: ReviewArtifactV2): ReviewArtifactV1 => ({
  schemaVersion: "review.v1",
  runId: artifact.runId,
  status: artifact.status,
  title: artifact.title,
  summary: artifact.summary,
  mergeable: artifact.mergeable,
  blastRadius: artifact.blastRadius,
  findings: artifact.findings.map((finding) => ({
    severity: finding.severity,
    message: finding.message,
    ...(finding.file ? { file: finding.file } : {}),
    ...(finding.line !== undefined ? { line: finding.line } : {}),
  })),
  files: artifact.files.map((file) => file.path),
  pathway: artifact.pathway,
});

/** Build the legacy artifact through the canonical v2 owner rather than parallel parsing. */
export const createReviewArtifact = (input: ReviewArtifactInput): ReviewArtifactV1 =>
  toReviewArtifactV1(createReviewArtifactV2(input));
