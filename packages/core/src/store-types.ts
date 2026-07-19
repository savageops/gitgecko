/** Types needed by persistence.ts — extracted to avoid circular deps. */

export interface EmbedRow {
  readonly uuid: string;
  readonly path: string;
  readonly cacheKey: string;
  readonly vector: readonly number[];
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface EmbedSearchResult {
  readonly chunk: { readonly content: string; readonly startLine: number; readonly endLine: number };
  readonly path: string;
  readonly score: number;
}

export interface EmbedTag {
  readonly repo: string;
  readonly branch: string;
  readonly embeddingId: string;
}

export interface EmbedStore {
  upsert(tag: EmbedTag, rows: readonly EmbedRow[]): Promise<void>;
  retrieve(tag: EmbedTag, vector: readonly number[], opts: { limit: number; pathPrefix?: string }): Promise<readonly EmbedSearchResult[]>;
  clear(tag: EmbedTag): Promise<void>;
  count(tag: EmbedTag): Promise<number>;
}

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

export interface RunTrace {
  readonly runId: string;
  readonly steps: readonly TraceRecord[];
  readonly totalCost?: { readonly tokensIn: number; readonly tokensOut: number; readonly usd: number };
}

export interface TraceContribution {
  readonly kind: "trace-store";
  readonly id: string;
  readonly record: (step: TraceRecord) => void;
  readonly read: (runId: string) => RunTrace;
  readonly exportJson: (runId: string) => string;
  readonly mutates?: boolean;
}
