import type { NotifyCapability, NotifyContribution } from "@gitgecko/notify";
import { createGitHubAppSource, type GitHubAppSource, type GitHubAppSourceConfig } from "@gitgecko/plug-repo-import-github";
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import manifestJson from "./plug.manifest.json" with { type: "json" };

const GITHUB_INLINE_REVIEW_MAX_COMMENTS = 20;

const parsedManifest = parseManifest(manifestJson);
if (!parsedManifest.ok) throw new Error(`GitHub notify manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
export const manifest: PlugManifest = parsedManifest.value;

/** Bind GitHub's comment wire format behind the provider-neutral notify socket. */
export const createGitHubCommentPlug = (
  config: GitHubAppSourceConfig,
  source: Pick<GitHubAppSource, "postPullRequestComment"> & Partial<Pick<GitHubAppSource, "postPullRequestReview" | "resolveSupersededPullRequestReviewThreads">> = createGitHubAppSource(config),
) => {
  return {
    manifest,
    setup(api: { register: (capability: NotifyCapability, contribution: NotifyContribution) => void }) {
      api.register("post", {
        kind: "notifier",
        id: "github-pull-request-comment",
        targetKind: "github-pr",
        mutates: true,
        post: async (target, message) => {
          if (target.kind !== "github-pr" || !target.connectionId || !target.repositoryId || !target.prNumber) {
            return { posted: false, error: "GitHub notification target is incomplete." };
          }
          try {
            const inlineFindings = message.findings?.flatMap((finding) => {
              const line = finding.line;
              return finding.file && typeof line === "number" && Number.isSafeInteger(line) && line > 0
                ? [{
                    file: finding.file,
                    line,
                    fingerprint: finding.fingerprint ?? `${finding.ruleId}:${finding.file}:${line}`,
                    body: `<!-- gitgecko-finding:${finding.fingerprint ?? `${finding.ruleId}:${finding.file}:${line}`} -->\n**[${finding.ruleId}]** ${finding.message}`,
                  }]
                : [];
            }) ?? [];
            const uniqueInlineFindings = [...new Map(
              inlineFindings.map((finding) => [`${finding.file}:${finding.line}:${finding.body}`, finding]),
            ).values()].slice(0, GITHUB_INLINE_REVIEW_MAX_COMMENTS);
            if (uniqueInlineFindings.length > 0 && source.postPullRequestReview) {
              const result = await source.postPullRequestReview({
                installationId: target.connectionId,
                repositoryId: target.repositoryId,
                pullNumber: target.prNumber,
                ...(message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : {}),
                body: message.body,
                comments: uniqueInlineFindings.map(({ file, line, body }) => ({ file, line, body })),
              });
              if (!source.resolveSupersededPullRequestReviewThreads) return { posted: true, id: result.id, url: result.url };
              try {
                await source.resolveSupersededPullRequestReviewThreads({
                  installationId: target.connectionId,
                  repositoryId: target.repositoryId,
                  pullNumber: target.prNumber,
                  activeFindingFingerprints: uniqueInlineFindings.map((finding) => finding.fingerprint),
                });
                return { posted: true, id: result.id, url: result.url };
              } catch {
                // The review is already durable; avoid replaying it only because cleanup failed.
                return { posted: true, id: result.id, url: result.url, warnings: ["GitHub review was posted, but superseded findings could not be resolved."] };
              }
            }
            const result = await source.postPullRequestComment({
              installationId: target.connectionId,
              repositoryId: target.repositoryId,
              pullNumber: target.prNumber,
              ...(message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : {}),
              body: message.body,
            });
            return { posted: true, id: result.id, url: result.url };
          } catch {
            return { posted: false, error: "GitHub pull-request comment could not be posted." };
          }
        },
      });
    },
  };
};
