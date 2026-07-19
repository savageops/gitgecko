/**
 * @gitgecko/code-intel/graph-temporal — temporal knowledge graph (the differentiator).
 *
 * Salvaged from graphiti (.refs/02-repo-qa/graphiti-main/): every edge carries
 * `valid_from` + `expired_at` timestamps, enabling "what was the graph at time T?"
 * queries. Neither CodeRabbit (no graph, CR-§9.1 W7) nor Greptile (point-in-time
 * snapshot, GP-§10 wp7) has this — it's a structurally-differentiated capability.
 *
 * The contract: record graph versions over time → query the graph "as of" a
 * timestamp → see what changed, when, and why.
 */
import type { CodeGraph, GraphEdge, GraphNode } from "./graph-schema.js";

/** A temporal edge — carries validity timestamps (graphiti's expired_at model). */
export interface TemporalEdge extends GraphEdge {
  readonly validFrom: string; // ISO timestamp when the edge was created
  readonly expiredAt?: string; // ISO timestamp when the edge became invalid (graphiti's expired_at)
}

/** A recorded graph version (a snapshot at a point in time). */
export interface GraphVersion {
  readonly timestamp: string;
  readonly commitSha: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly TemporalEdge[];
}

/** A change between two graph versions. */
export interface GraphDelta {
  readonly fromTimestamp: string;
  readonly toTimestamp: string;
  readonly addedNodes: readonly GraphNode[];
  readonly removedNodes: readonly GraphNode[];
  readonly addedEdges: readonly TemporalEdge[];
  readonly expiredEdges: readonly TemporalEdge[];
}

/**
 * The temporal graph store. Records graph versions over time; queries return
 * the graph "as of" a timestamp, or the delta between two timestamps.
 */
export class TemporalGraphStore {
  private readonly versions: GraphVersion[] = [];

  /** Record a new graph version (a snapshot at this commit). */
  record(timestamp: string, commitSha: string, graph: CodeGraph): void {
    // Expire edges from the previous version that don't exist in the new one
    const prev = this.versions[this.versions.length - 1];
    const newEdgeKeys = new Set(graph.edgeList.map((e) => `${e.type}|${e.sourceId}|${e.targetId}`));

    const temporalEdges: TemporalEdge[] = graph.edgeList.map((e) => ({
      ...e,
      validFrom: timestamp,
    }));

    // Carry forward surviving edges from previous versions (still valid)
    const survivingEdges: TemporalEdge[] = [];
    if (prev) {
      for (const edge of prev.edges) {
        const key = `${edge.type}|${edge.sourceId}|${edge.targetId}`;
        if (newEdgeKeys.has(key) && !edge.expiredAt) {
          survivingEdges.push(edge); // still valid — keep its original validFrom
        } else if (!edge.expiredAt) {
          // This edge no longer exists in the new graph → expire it
          survivingEdges.push({ ...edge, expiredAt: timestamp });
        }
      }
    }

    const allEdges = [...survivingEdges, ...temporalEdges.filter((e) => {
      // Only add edges that are genuinely new (not surviving from before)
      const key = `${e.type}|${e.sourceId}|${e.targetId}`;
      return !survivingEdges.some((s) => `${s.type}|${s.sourceId}|${s.targetId}` === key && !s.expiredAt);
    })];

    const allNodes = [...graph.nodes.values()];
    this.versions.push({ timestamp, commitSha, nodes: allNodes, edges: allEdges });
  }

  /** Get the graph as of a given timestamp (all edges valid at that time). */
  asOf(timestamp: string): { nodes: readonly GraphNode[]; edges: readonly TemporalEdge[] } {
    // Find the version at or before the timestamp
    let version: GraphVersion | undefined;
    for (const v of this.versions) {
      if (v.timestamp <= timestamp) version = v;
      else break;
    }
    if (!version) return { nodes: [], edges: [] };

    // Filter edges: validFrom <= timestamp AND (no expiredAt OR expiredAt > timestamp)
    const activeEdges = version.edges.filter(
      (e) => e.validFrom <= timestamp && (!e.expiredAt || e.expiredAt > timestamp),
    );
    return { nodes: version.nodes, edges: activeEdges };
  }

  /** Get the delta between two timestamps (what changed). */
  delta(fromTimestamp: string, toTimestamp: string): GraphDelta {
    const fromGraph = this.asOf(fromTimestamp);
    const toGraph = this.asOf(toTimestamp);

    const fromNodeIds = new Set(fromGraph.nodes.map((n) => n.id));
    const toNodeIds = new Set(toGraph.nodes.map((n) => n.id));
    const fromEdgeKeys = new Set(fromGraph.edges.map((e) => `${e.type}|${e.sourceId}|${e.targetId}`));
    const toEdgeKeys = new Set(toGraph.edges.map((e) => `${e.type}|${e.sourceId}|${e.targetId}`));

    return {
      fromTimestamp,
      toTimestamp,
      addedNodes: toGraph.nodes.filter((n) => !fromNodeIds.has(n.id)),
      removedNodes: fromGraph.nodes.filter((n) => !toNodeIds.has(n.id)),
      addedEdges: toGraph.edges.filter((e) => !fromEdgeKeys.has(`${e.type}|${e.sourceId}|${e.targetId}`)),
      expiredEdges: fromGraph.edges.filter((e) => !toEdgeKeys.has(`${e.type}|${e.sourceId}|${e.targetId}`)),
    };
  }

  /** Get all recorded versions. */
  listVersions(): readonly GraphVersion[] {
    return this.versions;
  }
}
