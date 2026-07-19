import type { NotifyCapability, NotifyContribution } from "@gitgecko/notify";
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import manifestJson from "./plug.manifest.json" with { type: "json" };

const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const SLACK_MESSAGE_MAX_CHARS = 40_000;
const SLACK_CHANNEL_ID = /^[CDGU][A-Z0-9]{2,}$/u;
const SLACK_THREAD_TS = /^\d{10,}\.\d{6}$/u;

const parsedManifest = parseManifest(manifestJson);
if (!parsedManifest.ok) throw new Error(`Slack notify manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
export const manifest: PlugManifest = parsedManifest.value;

export interface SlackNotifierConfig {
  /** Resolve a connection-owned bot token at the final network boundary; never persist it in the plug. */
  readonly resolveBotToken: () => Promise<string | undefined>;
  /** Test and egress-policy seam; the plug never uses a shell or a user-supplied URL. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/** Check only the documented response fields needed to persist a replyable conversation receipt. */
const isSlackPostResponse = (value: unknown): value is { readonly ok: true; readonly channel: string; readonly ts: string } => {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  return response.ok === true && typeof response.channel === "string" && response.channel.length > 0
    && typeof response.ts === "string" && SLACK_THREAD_TS.test(response.ts);
};

/** Translate the common notify socket into Slack's documented JSON chat.postMessage wire contract. */
export const createSlackNotifierPlug = (config: SlackNotifierConfig) => ({
  manifest,
  setup(api: { register: (capability: NotifyCapability, contribution: NotifyContribution) => void }) {
    api.register("post", {
      kind: "notifier",
      id: "slack-conversation",
      targetKind: "slack",
      mutates: true,
      post: async (target, message) => {
        if (target.kind !== "slack" || !target.channel || !SLACK_CHANNEL_ID.test(target.channel)
          || (target.threadId !== undefined && !SLACK_THREAD_TS.test(target.threadId))
          || message.body.trim().length === 0 || message.body.length > SLACK_MESSAGE_MAX_CHARS) {
          return { posted: false, error: "Slack notification target or message is invalid." };
        }
        const token = await config.resolveBotToken();
        if (!token) return { posted: false, error: "Slack connection is unavailable." };
        try {
          const response = await (config.fetch ?? globalThis.fetch)(SLACK_POST_MESSAGE_URL, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({
              channel: target.channel,
              text: message.body,
              ...(target.threadId ? { thread_ts: target.threadId } : {}),
              unfurl_links: false,
              unfurl_media: false,
            }),
          });
          const payload: unknown = await response.json().catch(() => undefined);
          if (!response.ok || !isSlackPostResponse(payload)) return { posted: false, error: "Slack conversation could not be posted." };
          return {
            posted: true,
            id: `${payload.channel}:${payload.ts}`,
            threadId: target.threadId ?? payload.ts,
          };
        } catch {
          return { posted: false, error: "Slack conversation could not be posted." };
        }
      },
    });
  },
});
