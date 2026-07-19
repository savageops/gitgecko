/**
 * @gitgecko/code-intel/graph-build — the graph-build capability contract.
 *
 * The second step of Greptile's decoded pipeline (GP-§8b): parsed files
 * (def/ref tags from tree-sitter-parse) → a typed code graph. Implements
 * code-graph-rag's schema (P-codeintel-3) + the FQN-trie approach (P-codeintel-4).
 *
 * Split into two layers (mirroring code-graph-rag's own split):
 *  - buildGraph(input): PURE function — tags → CodeGraph. No I/O, fully testable.
 *  - GraphStore: the persistence backend (Postgres+pgvector default per OQ4.1,
 *    Memgraph opt-in). Behind an interface so the build logic is storage-agnostic.
 *
 * The TDD loop targets buildGraph — deterministic, observable, no DB needed.
 */
import type { ParsedFile } from "./tags.js";
import type { CodeGraph, GraphNode, RelationshipType } from "./graph-schema.js";

/** Input: the repo name + all parsed files (the tree-sitter-parse output). */
export interface GraphBuildInput {
  readonly repoName: string;
  readonly files: readonly ParsedFile[];
  /** Optional: source code per file path, for AST-based nesting (removes tag-order approximation). */
  readonly sourceMap?: Readonly<Record<string, string>>;
}

/** Output: the built graph (nodes + edges) + a build report. */
export interface GraphBuildOutput {
  readonly graph: CodeGraph;
  readonly report: GraphBuildReport;
}

export interface GraphBuildReport {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly filesProcessed: number;
  /** Calls that could not be resolved to a known definition (logged, not fatal). */
  readonly unresolvedCalls: number;
}

/**
 * Storage backend interface. The default impl is Postgres+pgvector (OQ4.1);
 * an in-memory impl exists for tests. buildGraph produces a CodeGraph that
 * a GraphStore persists via MERGE (idempotent re-indexing).
 */
export interface GraphStore {
  /** Upsert nodes + edges (MERGE semantics — re-indexing is safe). */
  merge(graph: CodeGraph): Promise<void>;
  /** Fetch a node by id (for the retrieve/dead-code consumers). */
  get(id: string): Promise<GraphNode | undefined>;
  /** Traverse edges of a given type from a source (the retrieve expansion primitive). */
  traverse(sourceId: string, type: RelationshipType, depth?: number): Promise<readonly GraphNode[]>;
  /** Clear the graph for a repo (full re-index path). */
  clear(repoName: string): Promise<void>;
}

/** The contribution shape the graph-build plug registers (graph capability). */
export interface GraphBuildContribution {
  readonly kind: "graph-builder";
  readonly id: string;
  /** The pure build function — tags → CodeGraph. The capability under test. */
  readonly build: (input: GraphBuildInput) => GraphBuildOutput;
  /** Optional: a default GraphStore the plug provides (Postgres impl plugs in). */
  readonly store?: GraphStore;
  readonly mutates?: boolean;
}
