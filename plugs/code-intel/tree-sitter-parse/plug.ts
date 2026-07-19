/**
 * gitgecko code-intel plug — tree-sitter-parse.
 *
 * The universal parsing substrate (research manifest P-codeintel-13).
 * Parses source → AST via web-tree-sitter (Node+WASM binding), then runs
 * salvaged aider SCM tag queries (P-codeintel-2) to emit def/ref tags.
 *
 * Every downstream code-intel plug (graph-build, chunk, repo-map) consumes
 * the ParsedFile this produces. This is step 1 of Greptile's pipeline
 * (GP-§8a), available off-the-shelf.
 *
 * Bindings: web-tree-sitter (Node 22+/browser, WASM) + tree-sitter-wasm
 * (prebuilt grammars). Grammars + SCM queries are lazy-loaded + cached.
 */
import { Language, Parser, Query, type QueryCapture } from "web-tree-sitter";
import { getWasmPath } from "tree-sitter-wasm";
import { readFileSync } from "node:fs";
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import { parseCaptureName, type ParsedFile, type Tag } from "@gitgecko/code-intel";
import manifestJson from "./plug.manifest.json" with { type: "json" };

// --- Manifest (parsed, not cast — fail-fast on malformed) --------------------
const parsedManifest = parseManifest(manifestJson);
if (!parsedManifest.ok) {
  throw new Error(`tree-sitter-parse manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
}
export const manifest: PlugManifest = parsedManifest.value;

// --- Extension → language map (the common subset; extend as needed) ---------
const EXT_TO_LANG: Readonly<Record<string, string>> = {
  py: "python",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "tsx",
  go: "go",
  rs: "rust",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "c_sharp",
  php: "php",
  scala: "scala",
  lua: "lua",
  dart: "dart",
  elixir: "elixir",
  ex: "elixir",
  erl: "erlang",
  clj: "clojure",
  cljs: "clojure",
  edn: "clojure",
  exs: "elixir",
  fs: "fsharp",
  fsx: "fsharp",
  ml: "ocaml",
  mli: "ocaml",
  nim: "nim",
  pl: "perl",
  pm: "perl",
  r: "r",
  R: "r",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yaml: "yaml",
  yml: "yaml",
  json: "json",
  toml: "toml",
  html: "html",
  css: "css",
  scss: "scss",
  dockerfile: "dockerfile",
  graphql: "graphql",
  proto: "proto",
  sql: "sql",
  vim: "vim",
  zig: "zig",
  d: "d",
};

const inferLanguage = (relPath: string, override?: string): string | null => {
  if (override) return override;
  const base = relPath.split("/").pop() ?? relPath;
  // Dockerfile + Makefile special cases (no extension)
  if (base.toLowerCase() === "dockerfile") return "dockerfile";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  return EXT_TO_LANG[base.slice(dot + 1)] ?? null;
};

// --- Lazy grammar + SCM cache (avoid paying WASM cost until parse is called) -
// Cache holds BOTH the parser and its Language — web-tree-sitter 0.26 has no
// parser.getLanguage(), so we must retain the Language to build Queries.
interface CachedGrammar {
  readonly parser: Parser;
  readonly language: Language;
}
const grammarCache = new Map<string, CachedGrammar>();
const scmCache = new Map<string, string>();
let initPromise: Promise<void> | null = null;

const ensureInit = async (): Promise<void> => {
  if (!initPromise) {
    initPromise = Parser.init();
  }
  return initPromise;
};

const getGrammar = async (lang: string): Promise<CachedGrammar> => {
  const cached = grammarCache.get(lang);
  if (cached) return cached;
  await ensureInit();
  // getWasmPath is typed to keyof QueryMap (a strict union of supported langs);
  // our `lang` is a dynamic string from extension inference. The runtime try/catch
  // below handles languages not in the grammar set, so the cast is safe here.
  const language = await Language.load(getWasmPath(lang as never));
  const parser = new Parser();
  parser.setLanguage(language);
  const grammar: CachedGrammar = { parser, language };
  grammarCache.set(lang, grammar);
  return grammar;
};

/**
 * Load the SCM tag query for a language. Uses the SALVAGED aider SCM
 * (P-codeintel-2) bundled in ./queries/<lang>-tags.scm. If not present,
 * returns null (language parses but no tags extracted — graceful).
 */
const moduleUrl = import.meta.url; // a real file:// URL — valid base for new URL()
const getScm = (lang: string): string | null => {
  const cached = scmCache.get(lang);
  if (cached !== undefined) return cached.length > 0 ? cached : null;
  try {
    const scm = readFileSync(new URL(`./queries/${lang}-tags.scm`, moduleUrl), "utf8");
    if (scm.length > 0) {
      scmCache.set(lang, scm);
      return scm;
    }
  } catch {
    // fall through
  }
  scmCache.set(lang, ""); // sentinel: no SCM for this lang
  return null;
};

// --- The parse capability ----------------------------------------------------

export interface ParseInput {
  readonly source: string;
  readonly relPath: string;
  readonly language?: string;
}

/**
 * Parse source code into a ParsedFile (def/ref tags + byte spans).
 * Returns empty tags for unsupported languages or files with no symbols.
 * Never throws on user input — the capability contract is "always return".
 */
export const parse = async (input: ParseInput): Promise<ParsedFile> => {
  const langName = inferLanguage(input.relPath, input.language);
  if (!langName) {
    return { relPath: input.relPath, language: "unknown", tags: [] };
  }

  let grammar: { readonly parser: Parser; readonly language: Language };
  try {
    grammar = await getGrammar(langName);
  } catch (e) {
    process.stderr.write(`[tree-sitter-parse] getGrammar failed for ${langName}: ${(e as Error).message}\n`);
    return { relPath: input.relPath, language: langName, tags: [] };
  }

  const tree = grammar.parser.parse(input.source);
  if (!tree) {
    process.stderr.write(`[tree-sitter-parse] parse returned null tree for ${langName}\n`);
    return { relPath: input.relPath, language: langName, tags: [] };
  }

  const scm = getScm(langName);
  if (!scm) {
    process.stderr.write(`[tree-sitter-parse] no SCM for ${langName}\n`);
    return { relPath: input.relPath, language: langName, tags: [] };
  }

  let captures: QueryCapture[];
  try {
    const query = new Query(grammar.language, scm);
    captures = query.captures(tree.rootNode);
    query.delete();
  } catch (e) {
    process.stderr.write(`[tree-sitter-parse] query failed for ${langName}: ${(e as Error).message}\n`);
    return { relPath: input.relPath, language: langName, tags: [] };
  }

  const tags = capturesToTags(captures, input.relPath);
  tree.delete();
  return { relPath: input.relPath, language: langName, tags };
};

/**
 * Convert raw SCM captures into the Tag data contract.
 *
 * Aider's algorithm (P-codeintel-1, repomap.py get_tags_raw): each
 * `name.definition.<subtype>` / `name.reference.<subtype>` capture becomes a
 * Tag. The capture's NODE carries the byte span + position; the node TEXT is
 * the symbol name. We filter to name.* captures only (SCM may emit @doc etc).
 *
 * Multiple captures of the same node (e.g. @definition.function wrapping
 * @name.definition.function) would double-count; we dedupe by node id +
 * capture name.
 */
const capturesToTags = (captures: QueryCapture[], relPath: string): Tag[] => {
  const seen = new Set<number>(); // node.id dedupe
  const tags: Tag[] = [];
  for (const cap of captures) {
    const parsed = parseCaptureName(cap.name);
    if (!parsed) continue; // skip non-name.* captures (@doc, etc.)
    if (seen.has(cap.node.id)) continue;
    seen.add(cap.node.id);
    const pos = cap.node.startPosition;
    tags.push({
      relPath,
      line: pos.row + 1, // 1-based, matching aider + the tests
      column: pos.column,
      name: cap.node.text,
      category: parsed.category,
      subtype: parsed.subtype,
      startByte: cap.node.startIndex,
      endByte: cap.node.endIndex,
    });
  }
  return tags;
};

// --- Plug setup (registers the parse capability with the code-intel owner) ---

export async function setup(api: {
  register: (
    capability: "parse",
    contribution: {
      readonly kind: "parser";
      readonly id: string;
      readonly languages: readonly string[];
      readonly parse: (input: ParseInput) => Promise<ParsedFile>;
      readonly mutates?: boolean;
    },
  ) => void;
}): Promise<void> {
  api.register("parse", {
    kind: "parser",
    id: "tree-sitter-parse",
    languages: Object.values(EXT_TO_LANG),
    parse,
    mutates: false,
  });
}
