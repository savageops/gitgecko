/**
 * gitgecko mcp-gateway plug — tool exposers (G7, the inversion).
 *
 * Bridges the proven owner capabilities into MCP tools any external agent can
 * consume. The inverse of CodeRabbit's MCP-client posture (CR-§3) and Greptile's
 * closed/hosted MCP (GP-§3, OQ-GP2).
 *
 * Family A (code-intel tools — pure differentiation, Greptile exposes NONE per OQ-GP2):
 *  - search_code: natural-language query → hybrid retrieval → ranked chunks
 *  - evaluate_rule: run a one-off structural rule (ast-grep, P-codeintel-11)
 *
 * Family B (review-artifact tools — mirrored for interoperability):
 *  - run_review: trigger a /review on a PR diff
 *
 * Each exposer takes the owner's capability functions (injected at runtime —
 * the orchestrator wires the real retrieve/evaluate/review) and registers MCP
 * tools that delegate to them. Tests inject fakes; production wires the real
 * active plugs from their registries.
 */
import { parseManifest, type PlugManifest } from "@gitgecko/socket";
import type { McpRequestContext, ToolExposerContribution, ToolRegistry, McpTool, McpToolResult } from "@gitgecko/mcp-gateway";
import { errorResult, textResult } from "@gitgecko/mcp-gateway";
import type { Rule } from "@gitgecko/rules";
import manifestJson from "./plug.manifest.json" with { type: "json" };

// --- Manifest (parsed, not cast) --------------------------------------------
const parsedManifest = parseManifest(manifestJson);
if (!parsedManifest.ok) {
  throw new Error(`mcp-exposers manifest invalid: ${JSON.stringify(parsedManifest.error.issues)}`);
}
export const manifest: PlugManifest = parsedManifest.value;

// --- The capability functions (injected — production wires real plugs) -------
/** Retrieve function from the code-intel retrieve capability. */
export type RetrieveFn = (
  context: McpRequestContext,
  query: string,
  opts: { projectId: string; limit?: number; pathPrefix?: string },
) =>
  Promise<readonly { content: string; filepath: string }[]>;

/** Evaluate-rules function from the rules evaluate capability. Uses the real
 *  Rule contract (not unknown[]) so the actual evaluateRules fn is assignable. */
export type EvaluateRulesFn = (input: { filepath: string; source: string; rules: readonly Rule[] }) =>
  Promise<{ findings: readonly { ruleId: string; message: string; line: number; match: string }[] }>;

/** Review function from the review command capability. */
export type ReviewFn = (
  context: McpRequestContext,
  input: { command: string; payload: { projectId: string; title: string; diff: string; commitSha?: string } },
) =>
  Promise<{ output: string; success: boolean }>;

// --- Tool builders (each creates an McpTool from a capability function) ------

const searchCodeTool = (retrieve: RetrieveFn): McpTool => ({
  name: "search_code",
  description: "Search the codebase using natural language. Returns ranked code chunks relevant to the query.",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "Owned gitgecko project id to search" },
      query: { type: "string", description: "Natural-language search query" },
      limit: { type: "number", description: "Max results (default 10)", default: 10 },
      pathPrefix: { type: "string", description: "Optional repository-relative path prefix" },
    },
    required: ["projectId", "query"],
  },
  handler: async (args, context): Promise<McpToolResult> => {
    const query = String(args.query ?? "");
    const projectId = String(args.projectId ?? "");
    const limit = typeof args.limit === "number" ? args.limit : 10;
    const pathPrefix = typeof args.pathPrefix === "string" && args.pathPrefix.length > 0 ? args.pathPrefix : undefined;
    const results = await retrieve(context ?? {}, query, { projectId, limit, ...(pathPrefix && { pathPrefix }) });
    const text = results.length === 0
      ? "No results found."
      : results.map((r, i) => `--- ${r.filepath} (rank ${i + 1}) ---\n${r.content}`).join("\n\n");
    return textResult(text);
  },
});

const evaluateRuleTool = (evaluateRules: EvaluateRulesFn): McpTool => ({
  name: "evaluate_rule",
  description: "Run a structural (ast-grep) or lexical (regex) rule against source code. Returns deterministic findings.",
  inputSchema: {
    type: "object",
    properties: {
      filepath: { type: "string", description: "File path (for language detection + glob matching)" },
      source: { type: "string", description: "Source code to evaluate" },
      rules: { type: "array", description: "Rules to evaluate", items: { type: "object" } },
    },
    required: ["filepath", "source", "rules"],
  },
  handler: async (args): Promise<McpToolResult> => {
    const filepath = String(args.filepath ?? "");
    const source = String(args.source ?? "");
    const rules = Array.isArray(args.rules) ? args.rules : [];
    const out = await evaluateRules({ filepath, source, rules });
    const text = out.findings.length === 0
      ? "No findings."
      : out.findings.map((f) => `[${f.ruleId}] line ${f.line}: ${f.message}\n  match: ${f.match}`).join("\n");
    return textResult(text);
  },
});

const runReviewTool = (review: ReviewFn): McpTool => ({
  name: "run_review",
  description: "Review a diff against an owned gitgecko project with tenant-scoped repository grounding.",
  mutates: true,
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "Owned gitgecko project id used for grounding" },
      title: { type: "string" },
      diff: { type: "string", description: "The PR diff" },
      commitSha: { type: "string", description: "Optional commit SHA for history projection" },
    },
    required: ["projectId", "title", "diff"],
  },
  handler: async (args, context): Promise<McpToolResult> => {
    const result = await review(context ?? {}, {
      command: "review",
      payload: {
        projectId: String(args.projectId ?? ""),
        title: String(args.title ?? ""),
        diff: String(args.diff ?? ""),
        ...(typeof args.commitSha === "string" && args.commitSha.length > 0 ? { commitSha: args.commitSha } : {}),
      },
    });
    return result.success
      ? textResult(result.output || "(no output)")
      : errorResult(result.output || "Review failed without provider output.");
  },
});

// --- The exposer (registers all tools into the gateway) ---------------------

export interface ExposerDeps {
  readonly retrieve?: RetrieveFn;
  readonly evaluateRules?: EvaluateRulesFn;
  readonly review?: ReviewFn;
}

/** Create the exposer with injected capability functions. */
export const createExposer = (deps: ExposerDeps) => ({
  expose: (registry: ToolRegistry): void => {
    if (deps.retrieve) registry.register(searchCodeTool(deps.retrieve));
    if (deps.evaluateRules) registry.register(evaluateRuleTool(deps.evaluateRules));
    if (deps.review) registry.register(runReviewTool(deps.review));
    // Capability-truth guard (P-plugin): when ZERO deps are wired the exposer is
    // fully inert — it registers no tools. That inert state MUST be observable,
    // not silent: a silent zero-tool registration is the same class of bug as
    // the removed "stream-stub that delegated to complete" (a capability
    // advertised but doing nothing, with no signal). The default setup() calls
    // createExposer({}) with empty deps; the orchestrator is meant to inject
    // real retrieve/evaluate/review. Until it does, this warning makes the gap
    // visible. Partial deps (some capabilities wired) is a legitimate deployment
    // shape and does NOT warn.
    const wiredCount = [deps.retrieve, deps.evaluateRules, deps.review].filter(Boolean).length;
    if (wiredCount === 0) {
      console.error(
        "[mcp-exposers] WARNING: expose() called with no capabilities wired — zero MCP tools registered. " +
          "The orchestrator must inject retrieve/evaluateRules/review for the G7 inversion to be live. " +
          "The `expose` capability is currently inert.",
      );
    }
  },
});

/** Build the dependency-injected plug module consumed by the owner Registry. */
export const createExposerPlug = (deps: ExposerDeps) => ({
  // This plug is deployment-shaped: rules/search are read-only, while review
  // persists and meters. Derive the manifest gate from the active contribution.
  manifest: {
    ...manifest,
    permissions: { ...manifest.permissions, mutatesTools: Boolean(deps.review) },
  },
  setup: async (api: {
    register: (capability: "expose", contribution: ToolExposerContribution) => void;
  }): Promise<void> => {
    const exposer = createExposer(deps);
    api.register("expose", {
      kind: "tool-exposer",
      id: "mcp-exposers",
      expose: exposer.expose,
      // A wired review persists runs and consumes quota; the aggregate exposer
      // must not advertise the contribution as read-only in that deployment.
      mutates: Boolean(deps.review),
    });
  },
});

// --- Plug setup (registers the expose capability) ---------------------------
// Production builds a dependency-injected module with createExposerPlug() and
// loads it through the owner Registry. The empty setup remains a compatibility
// boundary for static plug discovery and is observably inert.
export async function setup(api: {
  register: (capability: "expose", contribution: ToolExposerContribution) => void;
}): Promise<void> {
  await createExposerPlug({}).setup(api);
}
