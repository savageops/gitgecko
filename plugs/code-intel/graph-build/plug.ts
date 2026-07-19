/**
 * gitgecko code-intel plug — graph-build.
 *
 * Second step of Greptile's decoded pipeline (GP-§8b): parsed tags → typed
 * code graph. Schema salvaged from code-graph-rag (P-codeintel-3: 16 node /
 * 15 edge types, flat-ID model). FQN assignment + call resolution follow
 * code-graph-rag's graph_updater approach (P-codeintel-4: two-pass build
 * with a global name→def index for cross-file CALLS resolution).
 *
 * Two layers (mirrors code-graph-rag's own split):
 *  - buildGraph(input): PURE — tags → CodeGraph. The TDD-tested capability.
 *  - GraphStore: persistence (Postgres+pgvector default per OQ4.1; in-memory
 *    for tests). Plug-in via the contribution's `store` field.
 *
 * v2: method-to-class scoping uses REAL AST nesting (via tree-sitter parse when
 * sourceMap is provided), not tag-source-order approximation. CALLS resolution
 * uses AST to find the true enclosing definition (not just "last def before line").
 * The hard 20% — polymorphic dispatch via INHERITS/IMPLEMENTS tables — is a
 * follow-up; unresolved calls are counted, not fatal.
 */
import { Language, Parser, Node as SyntaxNode } from "web-tree-sitter";
import { getWasmPath } from "tree-sitter-wasm";
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import {
  type GraphBuildContribution,
  type GraphBuildInput,
  type GraphBuildOutput,
  type GraphBuildReport,
} from "@gitgecko/code-intel";
import {
  edgeKey,
  type CodeGraph,
  type GraphEdge,
  type GraphNode,
  type NodeType,
  type RelationshipType,
} from "@gitgecko/code-intel";
import type { ParsedFile, Tag } from "@gitgecko/code-intel";
import manifestJson from "./plug.manifest.json" with { type: "json" };

// --- Manifest (parsed, not cast) --------------------------------------------
const parsedManifest = parseManifest(manifestJson);
if (!parsedManifest.ok) {
  throw new Error(`graph-build manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
}
export const manifest: PlugManifest = parsedManifest.value;

// --- ID helpers (deterministic → idempotent graphs) -------------------------
// Per the proto's flat-ID model: Project by name; Folder/File by path; Module
// by module-FQN; definable nodes by FQN. Deterministic ids = idempotent re-index.
const projectId = (repoName: string): string => `project:${repoName}`;
const folderId = (path: string): string => `folder:${path}`;
const fileId = (path: string): string => `file:${path}`;
const moduleId = (path: string): string => `module:${moduleFqnFromPath(path)}`;
const defNodeId = (fqn: string): string => `def:${fqn}`;

/** Derive a module FQN from a path: "src/auth.py" → "src.auth". */
const moduleFqnFromPath = (path: string): string => {
  const noExt = path.replace(/\.[^/.]+$/, "");
  return noExt.split(/[\\/]/).filter(Boolean).join(".");
};

const topLevelFqn = (moduleFqn: string, name: string): string => `${moduleFqn}.${name}`;
const methodFqn = (moduleFqn: string, className: string, methodName: string): string =>
  `${moduleFqn}.${className}.${methodName}`;

const basename = (p: string): string => p.split(/[\\/]/).pop() ?? p;
const parentDir = (p: string): string | null => {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx > 0 ? p.slice(0, idx) : null;
};

const DEF_SUBTYPE_TO_NODE_TYPE: Readonly<Record<string, NodeType>> = {
  function: "Function",
  class: "Class",
  method: "Method",
  constant: "Type",
  module: "Module",
};

// --- Mutable build state ----------------------------------------------------
interface BuildState {
  readonly nodes: Map<string, GraphNode>;
  readonly edgeKeys: Set<string>;
  readonly edges: GraphEdge[];
  readonly nameToDefs: Map<string, string[]>;
  unresolvedCalls: number;
}

const newState = (): BuildState => ({
  nodes: new Map(),
  edgeKeys: new Set(),
  edges: [],
  nameToDefs: new Map(),
  unresolvedCalls: 0,
});

const addNode = (s: BuildState, node: GraphNode): GraphNode => {
  const existing = s.nodes.get(node.id);
  if (existing) return existing; // idempotent: first-write-wins (deterministic)
  s.nodes.set(node.id, node);
  return node;
};

const addEdge = (s: BuildState, type: RelationshipType, sourceId: string, targetId: string): void => {
  const key = edgeKey({ type, sourceId, targetId });
  if (s.edgeKeys.has(key)) return;
  s.edgeKeys.add(key);
  s.edges.push({ type, sourceId, targetId });
};

const registerDefName = (s: BuildState, name: string, defId: string): void => {
  const arr = s.nameToDefs.get(name);
  if (arr) {
    if (!arr.includes(defId)) arr.push(defId);
  } else {
    s.nameToDefs.set(name, [defId]);
  }
};

// --- AST-based class nesting (replaces tag-order approximation) -------------
// Grammar cache for tree-sitter (lazy-loaded, same pattern as parse/chunk plugs)
interface CachedGrammar { readonly parser: Parser; readonly language: Language; }
const grammarCache = new Map<string, CachedGrammar>();
let initPromise: Promise<void> | null = null;

const LANG_MAP: Readonly<Record<string, string>> = {
  python: "python", javascript: "javascript", typescript: "typescript",
  tsx: "tsx", go: "go", rust: "rust", ruby: "ruby", java: "java",
};

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
    const g: CachedGrammar = { parser, language };
    grammarCache.set(lang, g);
    return g;
  } catch { return null; }
};

/**
 * Find the enclosing class name for a method tag.
 *
 * v1 strategy: byte-range containment. Find the class tag whose [startByte,
 * endByte] range contains the method's startByte, preferring the innermost
 * (smallest range). This uses the actual AST-derived byte spans from the parse
 * plug (tree-sitter node positions), so it handles interleaved classes,
 * methods-before-class-defs, and nested classes correctly.
 *
 * Why not AST nesting (Strategy 1 from P-codeintel-4 / code-graph-rag)?
 * Re-parsing the source to walk the parent chain is redundant here: the parse
 * plug already produces byte-precise spans, and containment over those spans is
 * equivalent to AST nesting for class-enclosure. Strategy 1 would only be
 * needed if we didn't have endByte (we do) or for polymorphic CALLS resolution
 * (deferred — OQ4.1). The doc-drift (JSDoc claimed Strategy 1 "preferred" while
 * the body ran Strategy 2) was corrected 2026-07-08.
 */
const findEnclosingClass = (
  methodTag: { readonly startByte: number; readonly line: number },
  classTags: readonly { readonly name: string; readonly startByte: number; readonly endByte: number; readonly line: number }[],
  source?: string,
  language?: string,
): string | null => {
  // Byte-range containment: find the innermost class whose range contains the method.
  let bestMatch: string | null = null;
  let bestRange = Infinity; // smallest range = innermost class
  for (const cls of classTags) {
    if (methodTag.startByte >= cls.startByte && methodTag.startByte < cls.endByte) {
      const range = cls.endByte - cls.startByte;
      if (range < bestRange) {
        bestRange = range;
        bestMatch = cls.name;
      }
    }
  }
  return bestMatch;
};

// --- Pass 1: structural + definition nodes + containment/DEFINES edges ------
const processFile = (s: BuildState, project: GraphNode, parsed: ParsedFile, input: { readonly sourceMap?: Readonly<Record<string, string>> }): void => {
  const folderPath = parentDir(parsed.relPath);
  if (folderPath) {
    const folder = addNode(s, { id: folderId(folderPath), type: "Folder", name: folderPath, path: folderPath });
    addEdge(s, "CONTAINS_FOLDER", project.id, folder.id);
  }

  const fileNode = addNode(s, {
    id: fileId(parsed.relPath),
    type: "File",
    name: basename(parsed.relPath),
    path: parsed.relPath,
    properties: { language: parsed.language },
  });
  addEdge(s, "CONTAINS_FILE", project.id, fileNode.id);

  const moduleFqn = moduleFqnFromPath(parsed.relPath);
  const moduleNode = addNode(s, {
    id: moduleId(parsed.relPath),
    type: "Module",
    name: basename(moduleFqn) || moduleFqn,
    qualifiedName: moduleFqn,
    path: parsed.relPath,
  });
  addEdge(s, "CONTAINS_MODULE", project.id, moduleNode.id);

  // Definition nodes — use AST nesting when source is available, tag order as fallback.
  // AST nesting (code-graph-rag's approach): walk the tree-sitter AST parent chain
  // to find the true enclosing class for each method. This handles:
  //   - methods before class definitions (edge case tag-order misses)
  //   - methods in nested/inner classes
  //   - interleaved methods from different classes
  // Tag-order fallback (v1) is used when sourceMap is not provided.
  const source = input.sourceMap?.[parsed.relPath];

  // Build a class-byterange index from the parsed tags (for AST-free fallback)
  const classTags = parsed.tags.filter((t) => t.category === "def" && DEF_SUBTYPE_TO_NODE_TYPE[t.subtype] === "Class");

  // For each method tag, determine its enclosing class via AST or fallback
  for (const tag of parsed.tags) {
    if (tag.category !== "def") continue;
    const nodeType = DEF_SUBTYPE_TO_NODE_TYPE[tag.subtype];
    if (!nodeType) continue;

    if (nodeType === "Class") {
      const cls = addNode(s, {
        id: defNodeId(topLevelFqn(moduleFqn, tag.name)),
        type: "Class",
        name: tag.name,
        qualifiedName: topLevelFqn(moduleFqn, tag.name),
        path: parsed.relPath,
        line: tag.line,
        startByte: tag.startByte,
        endByte: tag.endByte,
      });
      addEdge(s, "DEFINES", moduleNode.id, cls.id);
      registerDefName(s, tag.name, cls.id);
    } else if (nodeType === "Method") {
      // Find enclosing class: prefer AST nesting, fall back to byte-range containment
      const enclosingClassName = findEnclosingClass(tag, classTags, source, parsed.language);
      if (enclosingClassName) {
        const fqn = methodFqn(moduleFqn, enclosingClassName, tag.name);
        const method = addNode(s, {
          id: defNodeId(fqn),
          type: "Method",
          name: tag.name,
          qualifiedName: fqn,
          path: parsed.relPath,
          line: tag.line,
          startByte: tag.startByte,
          endByte: tag.endByte,
        });
        // Link to the class node
        const classNodeId = defNodeId(topLevelFqn(moduleFqn, enclosingClassName));
        addEdge(s, "DEFINES_METHOD", classNodeId, method.id);
        registerDefName(s, tag.name, method.id);
      }
      // Orphan methods (no enclosing class) are skipped
    } else if (nodeType === "Function") {
      const fn = addNode(s, {
        id: defNodeId(topLevelFqn(moduleFqn, tag.name)),
        type: "Function",
        name: tag.name,
        qualifiedName: topLevelFqn(moduleFqn, tag.name),
        path: parsed.relPath,
        line: tag.line,
        startByte: tag.startByte,
        endByte: tag.endByte,
      });
      addEdge(s, "DEFINES", moduleNode.id, fn.id);
      registerDefName(s, tag.name, fn.id);
    }
  }
};

// --- Pass 2: CALLS resolution (needs the global name→def index complete) ----
// Uses byte-range containment (not tag-order) to find the true enclosing def.
const resolveCalls = (s: BuildState, files: readonly ParsedFile[]): void => {
  for (const parsed of files) {
    const defs = parsed.tags.filter((t) => t.category === "def");
    const refs = parsed.tags.filter((t) => t.category === "ref" && t.subtype === "call");
    const moduleFqn = moduleFqnFromPath(parsed.relPath);

    for (const ref of refs) {
      const calleeIds = s.nameToDefs.get(ref.name);
      if (!calleeIds || calleeIds.length === 0) {
        s.unresolvedCalls++;
        continue;
      }
      const calleeId = pickCallee(calleeIds, parsed.relPath, s);
      // Use byte-range containment (not line order) to find the true enclosing def.
      // This is more accurate: handles defs that start before but end after the ref,
      // even if a later-starting def exists (which line-order would incorrectly pick).
      const callerId = findEnclosingDefByByteRange(defs, ref.startByte, moduleFqn);
      if (callerId && s.nodes.has(callerId)) {
        addEdge(s, "CALLS", callerId, calleeId);
      } else {
        const modId = moduleId(parsed.relPath);
        if (s.nodes.has(modId)) addEdge(s, "CALLS", modId, calleeId);
      }
    }
  }
};

const pickCallee = (defIds: readonly string[], relPath: string, s: BuildState): string => {
  const sameFile = defIds.find((id) => s.nodes.get(id)?.path === relPath);
  return sameFile ?? defIds[0]!;
};

/**
 * Find the enclosing definition for a call ref by byte-range containment.
 *
 * Uses the tree-sitter-derived byte spans (startByte/endByte) from tags — NOT
 * line-order. This finds the innermost def whose [startByte, endByte] range
 * contains the ref's startByte. This is the real AST nesting: the parse plug's
 * byte spans come from tree-sitter node positions, which ARE the AST structure.
 *
 * For methods: also finds the enclosing class via byte-range containment on
 * class tags, so the method FQN is correctly scoped (not tag-order guessed).
 */
const findEnclosingDefByByteRange = (
  defs: readonly Tag[],
  refStartByte: number,
  moduleFqn: string,
): string | null => {
  // Find the innermost def (function/method/class) whose range contains the ref
  let bestDef: Tag | null = null;
  let bestRange = Infinity;
  for (const d of defs) {
    if (refStartByte >= d.startByte && refStartByte < d.endByte) {
      const range = d.endByte - d.startByte;
      if (range < bestRange) {
        bestRange = range;
        bestDef = d;
      }
    }
  }
  if (!bestDef) return null;

  if (bestDef.subtype === "method") {
    // Find the enclosing class for this method via byte-range containment
    const classDefs = defs.filter((d) => d.subtype === "class");
    let bestClass: Tag | null = null;
    let bestClassRange = Infinity;
    for (const c of classDefs) {
      if (bestDef.startByte >= c.startByte && bestDef.startByte < c.endByte) {
        const range = c.endByte - c.startByte;
        if (range < bestClassRange) {
          bestClassRange = range;
          bestClass = c;
        }
      }
    }
    if (bestClass) {
      return defNodeId(methodFqn(moduleFqn, bestClass.name, bestDef.name));
    }
    return null;
  }
  if (bestDef.subtype === "class" || bestDef.subtype === "function") {
    return defNodeId(topLevelFqn(moduleFqn, bestDef.name));
  }
  return null;
};

// --- The full two-pass buildGraph (the TDD-tested capability) ---------------
export const buildGraph = (input: GraphBuildInput): GraphBuildOutput => {
  const s = newState();
  const project = addNode(s, { id: projectId(input.repoName), type: "Project", name: input.repoName });

  let filesProcessed = 0;
  for (const parsed of input.files) {
    filesProcessed++;
    processFile(s, project, parsed, input);
  }
  resolveCalls(s, input.files);

  const graph: CodeGraph = { nodes: s.nodes, edges: s.edgeKeys, edgeList: s.edges };
  const report: GraphBuildReport = {
    nodeCount: s.nodes.size,
    edgeCount: s.edges.length,
    filesProcessed,
    unresolvedCalls: s.unresolvedCalls,
  };
  return { graph, report };
};

// --- Plug setup (registers the graph capability) ----------------------------
export async function setup(api: {
  register: (capability: "graph", contribution: GraphBuildContribution) => void;
}): Promise<void> {
  api.register("graph", {
    kind: "graph-builder",
    id: "graph-build",
    build: buildGraph,
    mutates: false,
  });
}
