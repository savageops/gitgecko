/**
 * @gitgecko/core/ids — branded identifier types.
 *
 * Branding prevents the "pass a repoId where a runId belongs" class of bug
 * at compile time. The brand is nominal — only `brand()` produces a value
 * of a branded type; structurally-identical strings don't satisfy it.
 *
 * Convention: IDs are opaque strings to callers (often ULIDs for time-sortability
 * or slugs for human-readable ones). The brand is the type-system guarantee;
 * the runtime representation is just a string.
 */

declare const brand: unique symbol;
export type Branded<T extends string> = string & { readonly [brand]: T };

/** Constructor for a branded ID. Only this produces a value of a Branded type. */
export const brandId = <T extends string>(value: string): Branded<T> => value as Branded<T>;

// --- Entity IDs (add as the design grows) ---
export type OrgId = Branded<"OrgId">;
export type RepoId = Branded<"RepoId">;
export type RunId = Branded<"RunId">;
export type RuleId = Branded<"RuleId">;
export type ReviewId = Branded<"ReviewId">;
export type PlugId = Branded<"PlugId">;
export type TraceId = Branded<"TraceId">;

// --- Owners (02-architecture-overview.md §2) ---
// The string literal union of owner names. A plug's manifest `owner` field
// MUST be one of these (validated by the registry, 03-plugin-socket-contract §3).
export type OwnerName =
  | "ingest"
  | "repo-import"
  | "code-intel"
  | "review"
  | "rules"
  | "model"
  | "sandbox"
  | "billing"
  | "auth"
  | "notify"
  | "trace"
  | "mcp-gateway";

export const OWNER_NAMES = [
  "ingest", "repo-import", "code-intel", "review", "rules", "model",
  "sandbox", "billing", "auth", "notify", "trace", "mcp-gateway",
] as const satisfies readonly OwnerName[];

export const isOwnerName = (s: string): s is OwnerName =>
  (OWNER_NAMES as readonly string[]).includes(s);
