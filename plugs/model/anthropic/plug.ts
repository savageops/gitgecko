/**
 * GitGecko model plug — Anthropic (Claude). REAL implementation.
 *
 * Delegates to @gitgecko/model-client (which wraps @earendil-works/pi-ai —
 * the salvaged pi harness — for ALL provider HTTP/streaming/compat/auth).
 * BYOK (G5): user supplies ANTHROPIC_API_KEY.
 */
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import {
  createAnthropicComplete,
  createAnthropicGenerate,
  createAnthropicStream,
  type ModelCapability,
  type ModelContribution,
} from "@gitgecko/model-client";
import manifestJson from "./plug.manifest.json" with { type: "json" };

const parsedManifest = parseManifest(manifestJson);
if (!parsedManifest.ok) throw new Error(`model/anthropic manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
export const manifest: PlugManifest = parsedManifest.value;

export async function setup(api: {
  register: (capability: ModelCapability, contribution: ModelContribution) => void;
}): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Anthropic model plug requires ANTHROPIC_API_KEY.");
  }
  const complete = createAnthropicComplete({});
  const generate = createAnthropicGenerate({});
  const stream = createAnthropicStream({});

  api.register("complete", {
    kind: "completion-handler",
    id: "anthropic-complete",
    run: async (input: unknown) => {
      const { prompt, model } = input as { prompt: string; model?: string };
      return complete(prompt, model);
    },
    generate,
    mutates: false,
  });
  api.register("stream", {
    kind: "stream-handler",
    id: "anthropic-stream",
    stream,
    mutates: false,
  });
}
