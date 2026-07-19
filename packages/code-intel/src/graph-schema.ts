/**
 * @gitgecko/code-intel/graph-schema — the code-knowledge-graph data contract.
 *
 * Salvaged from code-graph-rag's schema.proto (research manifest P-codeintel-3,
 * .refs/02-repo-qa/code-graph-rag-main/codec/schema.proto). 16 node types,
 * 15 relationship types, the flat-ID model (parents hold child-ID lists,
 * explicitly chosen for graph-DB storage — see proto comment).
 *
 * This is the schema the graph-build plug PRODUCES and every downstream
 * consumer (retrieve, the dead-code query, the review agent's "find callers")
 * CONSUMES. Storage-agnostic — a GraphStore impl persists it (Postgres+pgvector
 * by default per OQ4.1, Memgraph opt-in for very-large monorepos).
 */

/** The 16 node types (proto `message Node` oneof payload). */
export type NodeType =
  | "Project"
  | "Package"
  | "Folder"
  | "Module"
  | "Class"
  | "Function"
  | "Method"
  | "File"
  | "ExternalPackage"
  | "ModuleImplementation"
  | "ModuleInterface"
  | "Interface"
  | "Enum"
  | "Type"
  | "Union"
  | "ExternalModule";

/** The 15 relationship types (proto `enum RelationshipType`, minus UNSPECIFIED). */
export type RelationshipType =
  | "CONTAINS_PACKAGE"
  | "CONTAINS_FOLDER"
  | "CONTAINS_FILE"
  | "CONTAINS_MODULE"
  | "DEFINES"
  | "DEFINES_METHOD"
  | "IMPORTS"
  | "INHERITS"
  | "OVERRIDES"
  | "CALLS"
  | "DEPENDS_ON_EXTERNAL"
  | "IMPLEMENTS_MODULE"
  | "IMPLEMENTS"
  | "EXPORTS"
  | "EXPORTS_MODULE";

/**
 * A graph node. `id` is the primary key (the proto's flat-ID model):
 *   - Project / ExternalPackage: keyed by `name`
 *   - Folder / File: keyed by `path`
 *   - everything else: keyed by `qualifiedName` (FQN)
 * `qualifiedName` is the module-relative fully-qualified name, e.g.
 *   "src.auth.login" for a function `login` in module src/auth.
 * Disambiguation: code-graph-rag's FunctionRegistryTrie appends `#<startLine>`
 * when a simple name collides within a module (P-codeintel-4).
 */
export interface GraphNode {
  readonly id: string;
  readonly type: NodeType;
  readonly name: string;
  /** Module-relative FQN for definable nodes (Function/Class/Method/...). */
  readonly qualifiedName?: string;
  /** Source path (File/Folder) or defining file (Function/Class/Method). */
  readonly path?: string;
  /** 1-based line where the node is defined. */
  readonly line?: number;
  /** Byte span (matches the Tag's startByte/endByte for definable nodes). */
  readonly startByte?: number;
  readonly endByte?: number;
  /** Free-form properties (modifiers, annotations, language, etc.). */
  readonly properties?: Readonly<Record<string, string | number | boolean>>;
}

/** A directed relationship: source --[type]--> target, by node id. */
export interface GraphEdge {
  readonly type: RelationshipType;
  readonly sourceId: string;
  readonly targetId: string;
  readonly properties?: Readonly<Record<string, string | number | boolean>>;
}

/** The full graph: nodes + edges, keyed for dedup. */
export interface CodeGraph {
  readonly nodes: ReadonlyMap<string, GraphNode>;
  readonly edges: ReadonlySet<string>; // serialized "type|source|target" for dedup
  readonly edgeList: readonly GraphEdge[];
}

/** A relationship target spec — used in assertions + tests. */
export interface EdgeSpec {
  readonly type: RelationshipType;
  readonly sourceId: string;
  readonly targetId: string;
}

/** Stable serialization of an edge for set-based dedup. */
export const edgeKey = (e: { readonly type: RelationshipType; readonly sourceId: string; readonly targetId: string }): string =>
  `${e.type}|${e.sourceId}|${e.targetId}`;
