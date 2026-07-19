/**
 * @gitgecko/notify — the notification contract (02 §2).
 *
 * Closes the review loop: takes review output → posts it to the right target
 * (GitHub PR comment, GitLab MR comment, Slack, fix-with-agent handoff).
 *
 * Salvages pr-agent's GitProvider.publish_* methods (P-plugin-5):
 *   publish_comment, publish_persistent_comment, publish_description,
 *   publish_code_suggestions, create_review.
 *
 * Targets (plugs under the notify owner — non-exclusive, many coexist):
 *  - github-comment: post a comment on a GitHub PR (octokit)
 *  - gitlab-comment: post on a GitLab MR
 *  - slack: post to a Slack channel (CR-§1.3)
 *  - fix-with-agent: deep-link handoff to Claude Code/Cursor/Devin (GP-§5)
 */
import type { OwnerSpec } from "@gitgecko/socket";
import { productIdentity } from "@gitgecko/core/product-identity";

/** Where to post the notification. */
export type TargetKind = "github-pr" | "gitlab-mr" | "slack" | "fix-with-agent";

/** A notification target (the VCS/chat destination). */
export interface NotifyTarget {
  readonly kind: TargetKind;
  /** Provider connection selected by the orchestration owner (for example an App installation). */
  readonly connectionId?: string;
  /** Provider repository identity; never a caller-supplied credential. */
  readonly repositoryId?: string;
  readonly repo?: string;
  readonly prNumber?: number;
  /** Provider conversation/channel identity; Slack plugs require a stable channel ID. */
  readonly channel?: string;
  /** Provider conversation parent identity; a reply preserves this across transport plugs. */
  readonly threadId?: string;
  readonly agent?: string; // for fix-with-agent: "claude-code" | "cursor" | "devin"
}

/** A notification message (the payload to post). */
export interface NotifyMessage {
  readonly body: string;
  /** Stable mutation identity used by provider plugs to reconcile retries. */
  readonly idempotencyKey?: string;
  readonly title?: string;
  /** Findings with a changed-file location can be published as provider-native inline comments. */
  readonly findings?: readonly {
    readonly ruleId: string;
    readonly file?: string;
    readonly line?: number;
    readonly message: string;
    readonly fingerprint?: string;
  }[];
  readonly suggestions?: readonly { readonly file: string; readonly line: number; readonly suggestion: string }[];
}

/** The result of a notification post. */
export interface NotifyResult {
  readonly posted: boolean;
  readonly url?: string;
  readonly id?: string;
  /** Stable provider thread/conversation identity for a later synchronized reply. */
  readonly threadId?: string;
  readonly error?: string;
  /** A completed mutation can report a non-fatal provider reconciliation gap. */
  readonly warnings?: readonly string[];
}

/** The notify owner's capabilities. */
export type NotifyCapability = "post";

/** Contribution: a notification target plug (github, gitlab, slack, fix-with-agent). */
export interface NotifyContribution {
  readonly kind: "notifier";
  readonly id: string;
  readonly targetKind: TargetKind;
  readonly post: (target: NotifyTarget, message: NotifyMessage) => Promise<NotifyResult>;
  readonly mutates?: boolean;
}

export const notifyOwner: OwnerSpec<NotifyCapability, string> = {
  name: "notify",
  capabilities: ["post"],
  // NON-exclusive: multiple notifiers coexist (github + slack + fix-with-agent).
  exclusive: () => false,
  kindFor: () => "notifier",
};

/**
 * Format a review result into a NotifyMessage body (markdown).
 * Salvage insight: pr-agent formats findings as markdown bullets with line links.
 */
export const formatReviewAsComment = (review: {
  output: string;
  command: string;
  pathway?: string;
  findings?: readonly { readonly ruleId?: string; readonly file?: string; readonly line?: number; readonly message: string; readonly fingerprint?: string }[];
  idempotencyKey?: string;
}): NotifyMessage => {
  const findings = review.findings?.flatMap((finding) => {
    const line = finding.line;
    return finding.file && typeof line === "number" && Number.isSafeInteger(line) && line > 0
      ? [{
          ruleId: finding.ruleId ?? "review-finding",
          file: finding.file,
          line,
          message: finding.message,
          ...(finding.fingerprint ? { fingerprint: finding.fingerprint } : {}),
        }]
      : [];
  });
  return {
    ...(review.idempotencyKey ? { idempotencyKey: review.idempotencyKey } : {}),
    title: `${productIdentity.shortName} /${review.command}`,
    body: `<!-- gitgecko-review -->\n## ${productIdentity.shortName} ${review.command}\n\n${review.output}\n${
    review.pathway ? `\n_Pathway: ${review.pathway}_` : ""
    }`,
    ...(findings && findings.length > 0 ? { findings } : {}),
  };
};

/**
 * Format deterministic findings into a structured comment (the anti-noise UX).
 * Each finding shows its rule id + line + message — the auditability wedge.
 */
export const formatFindings = (findings: readonly { ruleId: string; line: number; message: string; filepath?: string; source?: string }[]): string => {
  if (findings.length === 0) return "No findings.";
  return findings.map((f) =>
    `- **[${f.ruleId}]** ${f.filepath ? `${f.filepath}#` : ""}L${f.line} — ${f.message}${f.source ? ` _(source: ${f.source})_` : ""}`,
  ).join("\n");
};
