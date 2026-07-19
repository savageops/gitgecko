/**
 * @gitgecko/review/gitgecko-local — review semantics for the local-model pathway.
 *
 * Salvage-first (goal §2, A15): gitgecko does NOT implement its own LLM
 * client. The gitgecko-local pathway DELEGATES to pi harness (@earendil-works/pi-ai,
 * the library harvested to .refs/05-agent-harnesses/). Pi already solves
 * "connect to any OpenAI-compatible endpoint" — LM Studio, Ollama, vLLM,
 * llama.cpp, and 40+ cloud providers (Anthropic, OpenAI, OpenRouter, Bedrock,
 * Google, Groq, DeepSeek, …) including codex/claude-code subscription OAuth —
 * with a 30-field compatibility matrix (OpenAICompletionsCompat,
 * .refs/.../pi-harness-main/packages/ai/src/types.ts:471) and a real
 * Models/Provider runtime (models.ts).
 *
 * Transport ownership lives exclusively in @gitgecko/model-client. This module
 * assembles review-specific system/user turns and maps the normalized model
 * response into AgentResult. It does not construct providers, models, auth, or
 * protocol adapters.
 *
 * STATUS (2026-07-16): Wired into production. The canonical agent factory
 * (createAgentForResolution in pathways.ts) constructs an gitgecko-local Agent via
 * createGitGeckoLocalAgent when the pathway resolves to "local" with a
 * LocalEndpointConfig. The canonical model client supplies protocol fidelity,
 * retry, streaming capability, and provider-reported token counts.
 */
import { createLocalGenerate, type ModelGenerate, type ModelMessage } from "@gitgecko/model-client";
import type { LocalEndpointConfig } from "./pathways.js";
import type { Agent, AgentRunContext, AgentResult } from "./agent.js";
import { randomUUID } from "node:crypto";

/**
 * Create the gitgecko-local Agent adapter. The adapter:
 *  1. Builds protocol-neutral system and user messages from review state.
 *  2. Calls the canonical model-client local generator.
 *  3. Maps normalized usage into AgentUsage.
 *  4. Records the model call into toolState BY REFERENCE (P-plugin-3 invariant).
 *
 * Implements the Agent adapter (P-plugin-3): name + install + run.
 */
export const createGitGeckoLocalAgent = (
  config: LocalEndpointConfig,
  modelGenerate?: ModelGenerate,
): Agent => {
  const generate = modelGenerate ?? createLocalGenerate({
    baseUrl: config.baseUrl,
    model: config.modelId,
    ...(config.protocol && { protocol: config.protocol }),
    ...(config.apiKey && { apiKey: config.apiKey }),
  });

  return {
    name: "pi",
    install: async () => `pi: ${config.modelId} @ ${config.baseUrl}`,
    run: async (ctx: AgentRunContext): Promise<AgentResult> => {
      try {
        const rulesText =
          ctx.instructions.rules.length > 0
            ? `\n\n## Rules (authoritative — obey each):\n${ctx.instructions.rules.map((r) => `- ${r}`).join("\n")}`
            : "";
        // NOTE: the other backends (agent-gitgecko-native, agent-codex) use
        // renderFindings() from @gitgecko/instructions for severity-grouped
        // output. gitgecko-local inlines this because the review package cannot
        // import @gitgecko/instructions (circular dep: instructions → review
        // for ResolvedInstructions types). The inline version is functionally
        // equivalent (authoritative findings list); it just lacks severity
        // emoji grouping. A future refactor could extract renderFindings into a
        // shared types-free utility module to break the cycle.
        const findingsText =
          ctx.instructions.findings && ctx.instructions.findings.length > 0
            ? `\n\n## Deterministic findings (authoritative — do not reword, soften, or omit):\n${ctx.instructions.findings
                .map((f) => `- ${f.message} [${f.ruleId}]`)
                .join("\n")}\n`
            : "";
        const outputFormatText = ctx.instructions.outputFormat
          ? `\n\n${ctx.instructions.outputFormat}`
          : "";
        const repoContextText = ctx.instructions.repoContext
          ? `\n\n${ctx.instructions.repoContext}`
          : "";
        const userPrompt = `PR #${ctx.payload.prNumber}: ${ctx.payload.title}

Diff:
${ctx.payload.diff}
${rulesText}${findingsText}${repoContextText}${outputFormatText}`;

        // The system prompt = persona (if present) + the base systemPrompt.
        // gitgecko-local already separates system/user roles (the only backend that does).
        const fullSystem = ctx.instructions.persona
          ? `${ctx.instructions.persona}\n\n${ctx.instructions.systemPrompt}`
          : ctx.instructions.systemPrompt;

        const conversationMessages: readonly ModelMessage[] = (ctx.conversation ?? []).map((turn) => ({
          role: turn.role,
          content: turn.text,
        }));
        const messages: readonly ModelMessage[] = [
          { role: "system", content: fullSystem },
          ...conversationMessages,
          { role: "user", content: userPrompt },
        ];
        const result = await generate(userPrompt, config.modelId, { messages });
        const output = result.text;

        ctx.toolState.calls.push({
          tool: "model.generate",
          input: { model: config.modelId, prompt: userPrompt.slice(0, 200) },
          result: output.slice(0, 200),
        });
        ctx.onToolUse?.({ tool: "model.generate", input: userPrompt });

        return {
          success: true,
          output,
          ...(ctx.persistence === "thread" ? { providerThreadId: ctx.providerThreadId ?? `pi_${randomUUID()}` } : {}),
          ...(result.usage && {
            usage: {
              tokensIn: result.usage.inputTokens,
              tokensOut: result.usage.outputTokens,
              costUsd: 0,
            },
          }),
        };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    },
  };
};
