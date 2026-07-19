/**
 * @gitgecko/trace — per-step execution trace recording (G8, 05 §7).
 *
 * THE AUDITABILITY WEDGE: every review step records a TraceRecord. Users can
 * ask "why did gitgecko say X?" and get the exact model + prompt + context +
 * rule + cost that produced it. CodeRabbit (CR-§9.1 W3) and Greptile (GP-§10
 * wp4) CANNOT answer this — both are opaque.
 *
 * The contract: TraceStore { record(step), read(runId), export(runId) }.
 * The store is in-memory for tests; prod uses a persistent backend.
 */
import type { OwnerSpec } from "@gitgecko/socket";

/** A single trace step — the full provenance of one agent/review action. */
export interface TraceRecord {
  readonly runId: string;
  readonly stepId: string;
  readonly ts: string;
  readonly command: string;
  readonly model?: string;
  readonly prompt?: string;
  readonly retrievedContext?: readonly { readonly filepath: string; readonly content: string }[];
  readonly toolCalls?: readonly { readonly tool: string; readonly input?: unknown; readonly result?: unknown }[];
  readonly ruleEvaluations?: readonly { readonly ruleId: string; readonly line: number; readonly message: string; readonly source: string }[];
  readonly output?: string;
  readonly cost?: { readonly tokensIn: number; readonly tokensOut: number; readonly usd: number };
  readonly source: "deterministic" | "llm";
}

/** A full trace for one run (all steps). */
export interface RunTrace {
  readonly runId: string;
  readonly steps: readonly TraceRecord[];
  readonly totalCost?: { readonly tokensIn: number; readonly tokensOut: number; readonly usd: number };
}

/** The trace owner's capabilities. */
export type TraceCapability = "record";

/** Contribution: a trace store plug (in-memory default, persistent prod). */
export interface TraceContribution {
  readonly kind: "trace-store";
  readonly id: string;
  readonly record: (step: TraceRecord) => void;
  readonly read: (runId: string) => RunTrace;
  readonly exportJson: (runId: string) => string;
  readonly mutates?: boolean;
}

export const traceOwner: OwnerSpec<TraceCapability, string> = {
  name: "trace",
  capabilities: ["record"],
  exclusive: () => true, // one active trace store
  kindFor: () => "trace-store",
};

/**
 * In-memory TraceStore. Records steps keyed by runId; reads aggregate them
 * with total cost. Export produces JSON.
 */
export class InMemoryTraceStore implements TraceContribution {
  readonly kind = "trace-store" as const;
  readonly id = "in-memory-trace";
  private readonly steps = new Map<string, TraceRecord[]>();

  readonly record = (step: TraceRecord): void => {
    const arr = this.steps.get(step.runId) ?? [];
    arr.push(step);
    this.steps.set(step.runId, arr);
  };

  readonly read = (runId: string): RunTrace => {
    const steps = this.steps.get(runId) ?? [];
    const totalCost = steps.reduce(
      (acc, s) => s.cost
        ? { tokensIn: acc.tokensIn + s.cost.tokensIn, tokensOut: acc.tokensOut + s.cost.tokensOut, usd: acc.usd + s.cost.usd }
        : acc,
      { tokensIn: 0, tokensOut: 0, usd: 0 },
    );
    const hasCost = steps.some((s) => s.cost);
    return {
      runId,
      steps,
      ...(hasCost && { totalCost }),
    };
  };

  readonly exportJson = (runId: string): string => JSON.stringify(this.read(runId), null, 2);
}
