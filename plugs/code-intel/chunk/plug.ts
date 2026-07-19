/**
 * gitgecko code-intel plug — chunk (smart-collapse).
 *
 * Salvaged from continue's smart-collapse chunker (research manifest P-codeintel-8,
 * .refs/02-repo-qa/continue-main/core/indexing/chunk/code.ts). Faithful port:
 *  - getSmartCollapsedChunks: recursive AST walk
 *  - collapsedNodeConstructors: class/function/method collapse with body → "{ ... }"
 *  - constructFunctionDefinitionChunk: class-context injection (method chunks
 *    carry the owning class header for retrieval-quality context)
 *  - collapseChildren: progressive shrinking of class bodies to fit budget
 *
 * Third step of Greptile's pipeline — the units the embeddings pillar embeds.
 * Better than naive line-splitting because chunks respect symbol boundaries
 * AND retain ownership context (class header on methods).
 *
 * v1 token estimate: chars/4 heuristic (continue uses a real tokenizer; the
 * algorithm SHAPE — yield-whole-if-under-budget, else collapse, else minimal —
 * is what's under test. Exact token counts are tunable later.)
 */
import { Language, Node as SyntaxNode, Parser } from "web-tree-sitter";
import { getWasmPath } from "tree-sitter-wasm";
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import type { Chunk, ChunkContribution, ChunkInput, ChunkOutput } from "@gitgecko/code-intel";
import manifestJson from "./plug.manifest.json" with { type: "json" };

// --- Manifest (parsed, not cast) --------------------------------------------
const parsedManifest = parseManifest(manifestJson);
if (!parsedManifest.ok) {
  throw new Error(`chunk manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
}
export const manifest: PlugManifest = parsedManifest.value;

const DEFAULT_MAX_CHUNK_SIZE = 500;

// --- v1 token estimate (chars/4) --------------------------------------------
// Continue uses countTokensAsync (a real tokenizer). For v1 we approximate;
// the algorithm's structure is what's under test, not exact token math.
const estimateTokens = (text: string): number => Math.ceil(text.trim().length / 4);

// --- Language detection (mirrors the parse plug's map) ----------------------
const EXT_TO_LANG: Readonly<Record<string, string>> = {
  py: "python", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "tsx", go: "go", rs: "rust", rb: "ruby", java: "java", kt: "kotlin",
  swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "c_sharp", php: "php",
  scala: "scala", lua: "lua", dart: "dart", elixir: "elixir", ex: "elixir", exs: "elixir",
  sh: "bash", bash: "bash", zsh: "bash",
};

const inferLanguage = (relPath: string, override?: string): string | null => {
  if (override) return override;
  const base = relPath.split("/").pop() ?? relPath;
  if (base.toLowerCase() === "dockerfile") return "dockerfile";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  return EXT_TO_LANG[base.slice(dot + 1)] ?? null;
};

// --- Lazy grammar cache (same pattern as parse plug, proven) ----------------
interface CachedGrammar {
  readonly parser: Parser;
  readonly language: Language;
}
const grammarCache = new Map<string, CachedGrammar>();
let initPromise: Promise<void> | null = null;

const ensureInit = async (): Promise<void> => {
  if (!initPromise) initPromise = Parser.init();
  return initPromise;
};

const getGrammar = async (lang: string): Promise<CachedGrammar | null> => {
  const cached = grammarCache.get(lang);
  if (cached) return cached;
  try {
    await ensureInit();
    const language = await Language.load(getWasmPath(lang as never));
    const parser = new Parser();
    parser.setLanguage(language);
    const grammar: CachedGrammar = { parser, language };
    grammarCache.set(lang, grammar);
    return grammar;
  } catch {
    return null; // unsupported language → graceful, empty chunks
  }
};

// --- Continue's collapsedReplacement + node-type maps (verbatim) ------------
const collapsedReplacement = (node: SyntaxNode): string =>
  node.type === "statement_block" ? "{ ... }" : "...";

const firstChild = (node: SyntaxNode, grammarName: string | string[]): SyntaxNode | null => {
  if (Array.isArray(grammarName)) {
    return node.children.find((child: SyntaxNode) => grammarName.includes(child.type)) ?? null;
  }
  return node.children.find((child: SyntaxNode) => child.type === grammarName) ?? null;
};

const FUNCTION_BLOCK_NODE_TYPES = ["block", "statement_block"];
const FUNCTION_DECLARATION_NODE_TYPES = [
  "method_definition",
  "function_definition",
  "function_item",
  "function_declaration",
  "method_declaration",
];

/**
 * Collapse children of a class body to fit the budget. Verbatim port of
 * continue's collapseChildren (progressive shrinking from the end).
 */
const collapseChildren = (
  node: SyntaxNode,
  code: string,
  blockTypes: string[],
  collapseTypes: string[],
  collapseBlockTypes: string[],
  maxChunkSize: number,
): string => {
  let working = code.slice(0, node.endIndex);
  const block = firstChild(node, blockTypes);
  const collapsedChildren: string[] = [];

  if (block) {
    const childrenToCollapse = block.children.filter((child: SyntaxNode) => collapseTypes.includes(child.type));
    for (const child of childrenToCollapse.reverse()) {
      const grandChild = firstChild(child, collapseBlockTypes);
      if (grandChild) {
        const start = grandChild.startIndex;
        const end = grandChild.endIndex;
        const collapsedChild = code.slice(child.startIndex, start) + collapsedReplacement(grandChild);
        working = working.slice(0, start) + collapsedReplacement(grandChild) + working.slice(end);
        collapsedChildren.unshift(collapsedChild);
      }
    }
  }
  working = working.slice(node.startIndex);

  let removedChild = false;
  while (estimateTokens(working.trim()) > maxChunkSize && collapsedChildren.length > 0) {
    removedChild = true;
    const childCode = collapsedChildren.pop()!;
    const index = working.lastIndexOf(childCode);
    if (index > 0) {
      working = working.slice(0, index) + working.slice(index + childCode.length);
    }
  }

  if (removedChild) {
    // Remove extra blank lines (verbatim from continue)
    let lines = working.split("\n");
    let firstWhiteSpaceInGroup = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]!.trim() === "") {
        if (firstWhiteSpaceInGroup < 0) firstWhiteSpaceInGroup = i;
      } else {
        if (firstWhiteSpaceInGroup - i > 1) {
          lines = [...lines.slice(0, i + 1), ...lines.slice(firstWhiteSpaceInGroup + 1)];
        }
        firstWhiteSpaceInGroup = -1;
      }
    }
    working = lines.join("\n");
  }
  return working;
};

const constructClassDefinitionChunk = (node: SyntaxNode, code: string, maxChunkSize: number): string =>
  collapseChildren(
    node,
    code,
    ["block", "class_body", "declaration_list"],
    FUNCTION_DECLARATION_NODE_TYPES,
    FUNCTION_BLOCK_NODE_TYPES,
    maxChunkSize,
  );

/**
 * THE KEY FEATURE (verbatim port): class-context injection. A method chunk
 * gets the owning class header prepended so the chunk retains ownership
 * context — critical for embeddings retrieval quality (continue's insight).
 */
const constructFunctionDefinitionChunk = (node: SyntaxNode, code: string, maxChunkSize: number): string => {
  const bodyNode = node.children[node.children.length - 1]!;
  const collapsedBody = bodyNode ? collapsedReplacement(bodyNode) : "...";
  const signature = bodyNode ? code.slice(node.startIndex, bodyNode.startIndex) : code.slice(node.startIndex);
  const funcText = signature + collapsedBody;

  const isInClass =
    node.parent &&
    ["block", "declaration_list"].includes(node.parent.type) &&
    node.parent.parent &&
    ["class_definition", "impl_item"].includes(node.parent.parent.type);

  if (isInClass) {
    const classNode = node.parent!.parent!;
    const classBlock = node.parent!;
    const classHeader = code.slice(classNode.startIndex, classBlock.startIndex);
    const indent = " ".repeat(node.startPosition.column);
    const combined = `${classHeader}...\n\n${indent}${funcText}`;

    if (estimateTokens(combined) <= maxChunkSize) return combined;
    if (estimateTokens(funcText) <= maxChunkSize) return funcText;
    const firstLine = signature.split("\n")[0] ?? "";
    const minimal = `${firstLine} ${collapsedBody}`;
    if (estimateTokens(minimal) <= maxChunkSize) return minimal;
    return collapsedBody;
  }

  if (estimateTokens(funcText) <= maxChunkSize) return funcText;
  const firstLine = signature.split("\n")[0] ?? "";
  const minimal = `${firstLine} ${collapsedBody}`;
  if (estimateTokens(minimal) <= maxChunkSize) return minimal;
  return collapsedBody;
};

const collapsedNodeConstructors: Readonly<Record<string, (node: SyntaxNode, code: string, max: number) => string>> = {
  // Classes / structs
  class_definition: constructClassDefinitionChunk,
  class_declaration: constructClassDefinitionChunk,
  impl_item: constructClassDefinitionChunk,
  // Functions
  function_definition: constructFunctionDefinitionChunk,
  function_declaration: constructFunctionDefinitionChunk,
  function_item: constructFunctionDefinitionChunk,
  // Methods
  method_declaration: constructFunctionDefinitionChunk,
};

// --- The smart-collapse recursion (verbatim port of getSmartCollapsedChunks) -
const maybeYieldChunk = (
  node: SyntaxNode,
  maxChunkSize: number,
  root: boolean,
): Chunk | null => {
  if (root || node.type in collapsedNodeConstructors) {
    if (estimateTokens(node.text) < maxChunkSize) {
      return {
        content: node.text,
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
      };
    }
  }
  return null;
};

function* getSmartCollapsedChunks(node: SyntaxNode, code: string, maxChunkSize: number, root = true): Generator<Chunk> {
  const chunk = maybeYieldChunk(node, maxChunkSize, root);
  if (chunk) {
    yield chunk;
    return;
  }
  // If a collapsed form is defined, use it (and STILL recurse — children appear in full elsewhere)
  if (node.type in collapsedNodeConstructors) {
    yield {
      content: collapsedNodeConstructors[node.type]!(node, code, maxChunkSize),
      startLine: node.startPosition.row,
      endLine: node.endPosition.row,
    };
  }
  for (const child of node.children) {
    yield* getSmartCollapsedChunks(child, code, maxChunkSize, false);
  }
}

// --- The exported chunk capability ------------------------------------------
export const chunk = async (input: ChunkInput): Promise<ChunkOutput> => {
  const langName = inferLanguage(input.relPath, input.language);
  if (!langName) return { relPath: input.relPath, language: "unknown", chunks: [] };

  if (input.source.trim().length === 0) {
    return { relPath: input.relPath, language: langName, chunks: [] };
  }

  const grammar = await getGrammar(langName);
  if (!grammar) return { relPath: input.relPath, language: langName, chunks: [] };

  const tree = grammar.parser.parse(input.source);
  if (!tree) return { relPath: input.relPath, language: langName, chunks: [] };

  const maxChunkSize = input.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
  const chunks = [...getSmartCollapsedChunks(tree.rootNode, input.source, maxChunkSize)];
  tree.delete();
  return { relPath: input.relPath, language: langName, chunks };
};

// --- Plug setup (registers the chunk capability) ----------------------------
export async function setup(api: {
  register: (capability: "chunk", contribution: ChunkContribution) => void;
}): Promise<void> {
  api.register("chunk", {
    kind: "chunker",
    id: "smart-collapse-chunker",
    chunk,
    mutates: false,
  });
}
