/**
 * Authenticated cloud review transport for the CLI.
 *
 * The device token authenticates the existing orchestrator review owner; it is
 * never passed to an upstream model provider. Keeping this adapter beside the
 * CLI auth owner makes `gitgecko login` materially useful without creating a second
 * review pipeline or reimplementing provider HTTP.
 */
import type { AuthState } from "./auth.js";

export type HostedReviewCommand = "review" | "describe" | "improve" | "ask";

export interface HostedReviewRequest {
  readonly diff?: string;
  readonly githubUrl?: string;
  readonly title?: string;
  readonly command?: HostedReviewCommand;
  readonly projectId?: string;
  readonly pullNumber?: number;
  readonly commitSha?: string;
}

export interface HostedReviewResponse {
  readonly success: boolean;
  readonly output: string;
  readonly artifact?: { readonly mergeable?: boolean };
  readonly [key: string]: unknown;
}

export interface HostedReviewRun {
  readonly runId: string;
  readonly status: "accepted" | "running" | "succeeded" | "failed" | "cancelled";
  readonly trigger: "api" | "github" | "cli" | "local";
  readonly acceptedAt: string;
  readonly completedAt?: string;
  readonly projectId?: string;
  readonly commitSha?: string;
  readonly error?: string;
}

export interface HostedReviewHistory {
  readonly reviews: readonly HostedReviewRun[];
  readonly available: true;
}

/** Execute one review through the authenticated, durable cloud owner path. */
export const runHostedReview = async (
  auth: AuthState,
  input: HostedReviewRequest,
  request: typeof fetch = fetch,
): Promise<HostedReviewResponse> => {
  const response = await request(`${auth.cloudUrl.replace(/\/$/, "")}/api/reviews/run`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${auth.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof payload.success === "boolean" && typeof payload.output === "string") {
    return payload as HostedReviewResponse;
  }
  const detail = typeof payload.error === "string" ? payload.error : `Cloud review returned HTTP ${response.status}.`;
  throw new Error(detail);
};

/** Read the authenticated account's canonical durable review projection. */
export const loadHostedReviewHistory = async (
  auth: AuthState,
  request: typeof fetch = fetch,
): Promise<HostedReviewHistory> => {
  const response = await request(`${auth.cloudUrl.replace(/\/$/, "")}/api/reviews`, {
    headers: { "Authorization": `Bearer ${auth.token}` },
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.ok && payload.available === true && Array.isArray(payload.reviews)) {
    return payload as unknown as HostedReviewHistory;
  }
  const detail = typeof payload.error === "string" ? payload.error : `Review history returned HTTP ${response.status}.`;
  throw new Error(detail);
};

/** Render history for terminals while preserving JSON as the agent contract. */
export const renderHostedReviewHistory = (history: HostedReviewHistory): string => {
  if (history.reviews.length === 0) return "No cloud reviews yet.";
  return history.reviews.map((review) => {
    const scope = review.projectId ? ` project=${review.projectId}` : "";
    const commit = review.commitSha ? ` commit=${review.commitSha.slice(0, 12)}` : "";
    return `${review.status.padEnd(9)} ${review.runId} ${review.acceptedAt} ${review.trigger}${scope}${commit}`;
  }).join("\n");
};
