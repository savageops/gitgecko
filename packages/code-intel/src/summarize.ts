/**
 * @gitgecko/code-intel/summarize — Greptile's docstring-embed trick (GP-§8a).
 *
 * Instead of embedding raw code tokens (sparse/symbolic → poor semantic retrieval),
 * generate a natural-language docstring per AST node via LLM, then embed THOSE
 * (dense/semantic → dramatically better retrieval). This is Greptile's core IP.
 *
 * Pipeline: parsed definitions → LLM generates a docstring per node → return
 * docstring-indexed summaries (which the embed capability embeds instead of raw code).
 *
 * The LLM call is injected (generateDocstring) so tests use a deterministic fake
 * and production wires the model owner's complete fn (BYOM, G5). Phase 2.1 (2026-07-08):
 * the dead empty-loop stub was deleted; the capability is now wired behind a real plug.
 */
import type { Contribution } from "@gitgecko/socket";
import type { ParsedFile } from "./tags.js";

/** A summary of one definition node (for embedding instead of raw code). */
export interface NodeSummary {
  readonly name: string;
  readonly kind: string; // function, class, method
  readonly filepath: string;
  readonly line: number;
  /** The raw code of the node (for reference). */
  readonly code: string;
  /** The LLM-generated docstring (what gets embedded). */
  readonly docstring: string;
}

/** A source file with its raw code (needed to extract node bodies for docstring gen). */
export interface SourceFile {
  readonly filepath: string;
  readonly source: string;
  readonly language?: string;
}

/**
 * Input to the summarize capability: source files + parsed def tags + the
 * model-owner-injected docstring generator. The generateDocstring fn is the
 * BYOM seam — production wires it to the model owner's complete fn (G5).
 */
export interface SummarizeInput {
  readonly files: readonly SourceFile[];
  readonly parsedFiles: readonly ParsedFile[];
  readonly generateDocstring: (code: string, name: string, kind: string) => Promise<string>;
}

/** Output: node summaries (one per definition tag). */
export interface SummarizeOutput {
  readonly summaries: readonly NodeSummary[];
}

/** The contribution shape the summarize plug registers (summarize capability). */
export interface SummarizeContribution extends Contribution {
  readonly kind: "summarizer";
  readonly id: string;
  readonly summarize: (input: SummarizeInput) => Promise<SummarizeOutput>;
  readonly mutates?: boolean;
}

/**
 * The summarize capability: walk parsed definitions → generate docstrings via
 * the model-owner-injected generateDocstring fn. Only def tags are summarized
 * (refs don't define anything). The docstring replaces raw code as the embedding
 * target (GP-§8a — Greptile's core IP, now reproducible).
 *
 * Phase 2.1 (2026-07-08): the dead empty-loop stub was deleted and this function
 * now delegates to the real summarizeSources implementation.
 */
export const summarize = async (input: SummarizeInput): Promise<SummarizeOutput> => {
  return summarizeSources(input.files, input.parsedFiles, input.generateDocstring);
};

/**
 * The core implementation: extract code per def tag → call generateDocstring →
 * build NodeSummary[]. Used by the summarize capability above.
 */
export const summarizeSources = async (
  files: readonly SourceFile[],
  parsedFiles: readonly ParsedFile[],
  generateDocstring: (code: string, name: string, kind: string) => Promise<string>,
): Promise<SummarizeOutput> => {
  const sourceMap = new Map(files.map((f) => [f.filepath, f.source]));
  const summaries: NodeSummary[] = [];

  for (const parsed of parsedFiles) {
    const source = sourceMap.get(parsed.relPath);
    if (!source) continue;

    for (const tag of parsed.tags) {
      if (tag.category !== "def") continue;

      // Extract the code for this definition (from startByte to ~500 chars or node end)
      const codeStart = tag.startByte;
      const codeEnd = Math.min(tag.endByte, codeStart + 500);
      const code = source.slice(codeStart, codeEnd);

      const docstring = await generateDocstring(code, tag.name, tag.subtype);
      summaries.push({
        name: tag.name,
        kind: tag.subtype,
        filepath: parsed.relPath,
        line: tag.line,
        code,
        docstring,
      });
    }
  }

  return { summaries };
};
