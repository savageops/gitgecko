/**
 * GitGecko model plug — OpenAI (GPT). REAL implementation.
 *
 * Delegates to @gitgecko/model-client (which wraps @earendil-works/pi-ai —
 * the salvaged pi harness — for ALL provider HTTP/streaming/compat/auth).
 * Supports a custom baseUrl for local OpenAI-compatible endpoints (LM Studio,
 * Ollama) via OPENAI_BASE_URL. BYOK (G5): user supplies OPENAI_API_KEY.
 */
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import {
  createOpenAIComplete,
  createOpenAIGenerate,
  createOpenAIStream,
  type ModelCapability,
  type ModelContribution,
} from "@gitgecko/model-client";
import manifestJson from "./plug.manifest.json" with { type: "json" };

const parsedManifest = parseManifest(manifestJson);
if (!parsedManifest.ok) throw new Error(`model/openai manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
export const manifest: PlugManifest = parsedManifest.value;

export async function setup(api: {
  register: (capability: ModelCapability, contribution: ModelContribution) => void;
}): Promise<void> {
  if (!process.env.OPENAI_API_KEY && !process.env.OPENAI_BASE_URL) {
    throw new Error("OpenAI model plug requires OPENAI_API_KEY or a configured OpenAI-compatible base URL.");
  }
  const complete = createOpenAIComplete({});
  const generate = createOpenAIGenerate({});
  const stream = createOpenAIStream({});

  api.register("complete", {
    kind: "completion-handler",
    id: "openai-complete",
    run: async (input: unknown) => {
      const { prompt, model } = input as { prompt: string; model?: string };
      return complete(prompt, model);
    },
    generate,
    mutates: false,
  });
  api.register("stream", {
    kind: "stream-handler",
    id: "openai-stream",
    stream,
    mutates: false,
  });
}
