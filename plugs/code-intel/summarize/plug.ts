/**
 * gitgecko code-intel plug — summarize (Greptile's docstring-embed, GP-§8a).
 *
 * THE WEDGE (04 §6): instead of embedding raw code tokens (sparse/symbolic →
 * poor semantic retrieval), generate a natural-language docstring per AST node
 * via the model owner's complete fn, then embed THOSE (dense/semantic →
 * dramatically better retrieval). This is Greptile's founder-described core IP
 * (HN quote, GP-§8a): "parse the AST, recursively generate docstrings for each
 * node, then embed the docstrings."
 *
 * BYOM (G5): the model-complete fn is injected. Production wires it from the
 * model owner's `complete` capability (resolved through the Registry). Tests
 * inject a deterministic fake. The plug is model-agnostic.
 *
 * Phase 2.1 (2026-07-08): the dead empty-loop stub in summarize.ts:45-57 was
 * deleted; this plug makes the summarize capability load-bearing behind the
 * socket. Replaces the false "implemented" claim in 08 OQ4.4.
 */
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import {
  summarize,
  type SummarizeContribution,
  type SummarizeInput,
  type SummarizeOutput,
} from "@gitgecko/code-intel";
import manifestJson from "./plug.manifest.json" with { type: "json" };

// --- Manifest (parsed, not cast) --------------------------------------------
const parsedManifest = parseManifest(manifestJson);
if (!parsedManifest.ok) {
  throw new Error(`summarize manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
}
export const manifest: PlugManifest = parsedManifest.value;

/**
 * A model-complete fn (the BYOM seam). Production resolves this from the model
 * owner's `complete` capability via the Registry (the same ModelComplete the
 * agent uses). The summarize plug wraps it to produce docstrings.
 */
export type ModelComplete = (prompt: string, model?: string) => Promise<string>;

/**
 * Build a generateDocstring fn from a model-complete. Prompts the model to
 * describe what the code does in one concise sentence — the docstring that
 * replaces raw code as the embedding target (GP-§8a).
 *
 * The prompt is deliberately minimal: "Describe what this {kind} {name} does
 * in one sentence." This keeps the docstring short (token-efficient for
 * embedding) and semantic (describes intent, not syntax).
 */
export const buildGenerateDocstring = (
  complete: ModelComplete,
  model?: string,
): ((code: string, name: string, kind: string) => Promise<string>) => {
  return async (code: string, name: string, kind: string): Promise<string> => {
    const prompt = `Describe what this ${kind} "${name}" does — one concise sentence, the intent not the syntax. Code:\n\n${code}`;
    try {
      const docstring = await complete(prompt, model);
      // Trim to a reasonable docstring length (avoid embedding novel-length descriptions).
      return docstring.trim().slice(0, 500);
    } catch {
      // Graceful: if the model fails, fall back to a minimal docstring (the name).
      // The embedding still works; it's just less semantic than a real description.
      return `${kind} ${name}`;
    }
  };
};

/**
 * Build the summarize capability from a model-complete fn. This is the factory
 * the orchestrator calls: it wraps the model's complete fn into a docstring
 * generator and returns the SummarizeContribution that registers the capability.
 */
export const createSummarizeContribution = (
  complete: ModelComplete,
  model?: string,
): SummarizeContribution => {
  const generateDocstring = buildGenerateDocstring(complete, model);
  return {
    kind: "summarizer",
    id: "docstring-summarizer",
    summarize: (input: SummarizeInput): Promise<SummarizeOutput> =>
      summarize({ ...input, generateDocstring }),
    mutates: false,
  };
};

// --- Plug setup (registers the summarize capability) ------------------------
// There is deliberately no default setup. A model-owner completion function
// must be injected at the deployment boundary; otherwise a name-only result
// would create a hollow semantic-indexing capability.
export const createSetup = (complete: ModelComplete, model?: string) => async (api: {
  register: (capability: "summarize", contribution: SummarizeContribution) => void;
}): Promise<void> => {
  api.register("summarize", createSummarizeContribution(complete, model));
};

/** Refuse activation when the model-owner dependency has not been injected. */
export async function setup(): Promise<void> {
  throw new Error("summarize requires an injected model-owner complete contribution; use createSetup(complete)");
}
