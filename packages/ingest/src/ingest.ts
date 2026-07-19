/**
 * @gitgecko/ingest — webhook event routing (02 §2).
 *
 * The entry point for the request lifecycle. Receives events (GitHub webhooks,
 * API calls, crons, slash-commands) and routes them to the right owner.
 *
 * Salvage: pr-agent's webhook event model (P-plugin-5, CR-§4.1 events:
 * pull_request, issue_comment, check_run, push). CodeRabbit's webhook events
 * (CR-§4.1): pull_request, issue_comment, pull_request_review_comment, check_run.
 *
 * The contract: receive(event) → Route { owner, action, payload }.
 */
import type { OwnerSpec } from "@gitgecko/socket";

/** The source of an event. */
export type EventSource = "github-webhook" | "gitlab-webhook" | "api" | "cron" | "cli" | "slash-command";

/** The type of event (maps to webhook action types). */
export type EventType =
  | "pull_request.opened" | "pull_request.synchronize" | "pull_request.reopened"
  | "issue_comment.created"
  | "push"
  | "check_run.completed"
  | "cron.reindex"
  | "api.review" | "api.search"
  | "cli.review"
  | "unknown";

/** A raw incoming event (before routing). */
export interface WebhookEvent {
  readonly source: EventSource;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Where an event should be routed (which owner + what action). */
export interface Route {
  readonly owner: string;
  readonly action: string;
  readonly repo?: string;
  readonly prNumber?: number;
  readonly diff?: string;
  readonly command?: string; // for slash-commands
  readonly reason: string;
}

/** The ingest owner's capabilities. */
export type IngestCapability = "receive";

export interface IngestContribution {
  readonly kind: "event-router";
  readonly id: string;
  readonly source: EventSource;
  readonly parseAndRoute: (event: WebhookEvent) => Route;
  readonly mutates?: boolean;
}

export const ingestOwner: OwnerSpec<IngestCapability, string> = {
  name: "ingest",
  capabilities: ["receive"],
  exclusive: () => false, // multiple routers coexist (github + gitlab + cron)
  kindFor: () => "event-router",
};

// --- The router (02 §3 step 1-2: receive → route to the right owner) --------

/**
 * Route a webhook event to the right owner + action.
 *
 * Routing rules (02 §3):
 *  - pull_request.opened/synchronize/reopened → review owner, "review"
 *  - issue_comment with "/review" etc. → review owner, the slash-command
 *  - push → code-intel owner, "reindex"
 *  - cron.reindex → code-intel owner, "reindex"
 *  - api.review → review owner, "review"
 *  - unknown → ingest (no-op)
 */
export const routeEvent = (event: WebhookEvent): Route => {
  const action = event.eventType;

  // Pull request events → review
  if (action.startsWith("pull_request.")) {
    const pr = event.payload.pull_request ?? event.payload.merge_request;
    const repo = event.payload.repository as { full_name?: string } | undefined;
    const prNum = typeof (pr as { number?: number } | undefined)?.number === "number"
      ? (pr as { number: number }).number : undefined;
    const prDiff = typeof (pr as { diff?: string } | undefined)?.diff === "string"
      ? (pr as { diff: string }).diff : undefined;
    return {
      owner: "review",
      action: "review",
      repo: repo?.full_name ?? "unknown",
      ...(prNum !== undefined && { prNumber: prNum }),
      ...(prDiff !== undefined && { diff: prDiff }),
      reason: `${action} → review`,
    };
  }

  // Issue/PR comment with slash command → review owner + the command
  if (action === "issue_comment.created") {
    const body = String(event.payload.comment_body ?? event.payload.body ?? "");
    const slashMatch = body.match(/^\/(review|describe|improve|ask|resolve)\b/);
    if (slashMatch) {
      const repo = event.payload.repository as { full_name?: string } | undefined;
      const prNum = typeof event.payload.pr_number === "number" ? event.payload.pr_number as number : undefined;
      return {
        owner: "review",
        action: slashMatch[1]!,
        repo: repo?.full_name ?? "unknown",
        ...(prNum !== undefined && { prNumber: prNum }),
        command: slashMatch[1]!,
        reason: `slash-command /${slashMatch[1]} → review`,
      };
    }
    return { owner: "ingest", action: "noop", reason: "comment without slash command" };
  }

  // Push → reindex
  if (action === "push") {
    const repo = event.payload.repository as { full_name?: string } | undefined;
    return { owner: "code-intel", action: "reindex", repo: repo?.full_name ?? "unknown", reason: "push → reindex" };
  }

  // Cron reindex
  if (action === "cron.reindex") {
    return { owner: "code-intel", action: "reindex", repo: String(event.payload.repo ?? "all"), reason: "cron → reindex" };
  }

  // API review
  if (action === "api.review" || action === "cli.review") {
    return {
      owner: "review",
      action: "review",
      repo: String(event.payload.repo ?? "local"),
      ...(event.payload.diff !== undefined && { diff: String(event.payload.diff) }),
      reason: `${action} → review`,
    };
  }

  // API search
  if (action === "api.search") {
    return { owner: "code-intel", action: "retrieve", repo: String(event.payload.repo ?? "local"), reason: "api.search → code-intel retrieve" };
  }

  // Unknown
  return { owner: "ingest", action: "noop", reason: `unknown event: ${action}` };
};
