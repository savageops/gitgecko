import type { OrchestratorResult } from "./orchestrator.js";

type PublicDiagnostics = Omit<NonNullable<OrchestratorResult["diagnostics"]>, "stderr">;
export type PublicCliResult = Omit<OrchestratorResult, "diagnostics" | "trace"> & { readonly diagnostics?: PublicDiagnostics };

/** Keep public JSON to the review schema; provider traces contain private prompts, tools, and repository context. */
export const toPublicCliResult = (result: OrchestratorResult): PublicCliResult => {
  const { diagnostics, trace: _trace, ...publicResult } = result;
  if (!diagnostics) return publicResult;

  const { stderr: _stderr, ...publicDiagnostics } = diagnostics;
  return Object.keys(publicDiagnostics).length > 0
    ? { ...publicResult, diagnostics: publicDiagnostics }
    : publicResult;
};
